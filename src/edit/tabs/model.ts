// Model tab: upload / remove, alignment, levels -> HA floors and rooms -> HA areas.

import * as E from '../../editor.ts';
import { levelsFromFloorMap } from '../../bindings.ts';
import { legacyShowRules } from '../../views.ts';
import { esc, sliderHtml, copyText } from '../html.ts';
import { defineTab } from './tab.ts';
import type { ActHandler, FieldHandler } from './tab.ts';
import type { EditMode } from '../../edit-mode.ts';
import type { Align } from '../../bindings.ts';
import type { Layout, LayoutModel } from '../../types/layout.ts';

// ---------- model ----------
export function onModelLoaded(ed: EditMode, changed = true) {
  if (!changed) return; // same model re-placed (alignment, opacity): the panel is already current
  if (ed._freshModel) { // a newly uploaded model: everything in it counts as seen
    ed._freshModel = false;
    snapshotKnown(ed);
    return;
  }
  if (ed.tab === 'model') ed.render();
}

// Remember which levels/rooms the user has been shown, so the regeneration notice only reports changes.
export function snapshotKnown(ed: EditMode) {
  const man = ed.card.modelBindings();
  if (!man) return;
  ed.setModelProps({ known: { levels: man.manifest.levels.map((l) => l.id), rooms: man.manifest.rooms.map((r) => r.id) } });
}

export function setModelProps(ed: EditMode, patch: Partial<LayoutModel>, rerender = true) {
  const cur: LayoutModel = ed.layout.model || {};
  const model: LayoutModel = { ...cur, ...patch };
  let layout: Layout = { ...ed.layout, model };
  // alignment change of an uploaded model (YAML alignment overrides win): pins on the model follow it
  if (!ed.card._config.model && ('position' in patch || 'rotation' in patch || 'scale' in patch)) {
    const align = (m: LayoutModel): Align => ({ position: m.position || [0, 0, 0], rotation: m.rotation || 0, scale: m.scale || 1 });
    // first alignment change with a model loaded: v0.2.x pins on floors bound to a model level follow it from now on
    if (ed.view.model && !cur.pins_migrated) {
      const mb = ed.card.modelBindings();
      const bound = mb ? Object.values(mb.levels || {}).map((a) => a && a.floor).filter((f): f is string => !!f) : [];
      layout = E.migrateLegacyPins(layout, bound);
    }
    layout = E.realignPins(layout, align(cur), align(layout.model || model)); // migrateLegacyPins keeps the model
  }
  ed.card._commit(layout);
  if (rerender) ed.render();
}

export function modelApi(ed: EditMode): string {
  return `/api/floorplan3d/model/${encodeURIComponent(String(ed.card._config.layout_key))}`;
}

export async function uploadModel(ed: EditMode, file: File) {
  if (!/\.glb$/i.test(file.name)) {
    ed.message = { text: 'Choose a .glb file (binary glTF). Export one with tools/export-glb.js.', error: true };
    ed.render();
    return;
  }
  ed.uploading = file.name;
  ed.message = null;
  ed.render();
  try {
    const body = new FormData();
    body.append('file', file, file.name);
    const r = await ed.hass.fetchWithAuth(modelApi(ed), { method: 'POST', body });
    const j: { message?: string; name?: string; size?: number; version?: string } = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || 'Upload failed (HTTP ' + r.status + ')');
    const cur = ed.layout.model || { position: [0, 0, 0], rotation: 0, scale: 1, opacity: 1 };
    ed._freshModel = true;
    ed.message = { text: `Uploaded ${j.name} (${(Number(j.size) / 1048576).toFixed(1)} MB).` };
    ed.commit({ ...ed.layout, model: { ...cur, version: j.version, name: j.name, size: j.size, uploaded: new Date().toISOString() } });
  } catch (err) {
    ed._freshModel = false;
    ed.message = { text: (err as Error).message, error: true };
  } finally {
    ed.uploading = null;
    ed.render();
  }
}

export async function removeModel(ed: EditMode) {
  try {
    const r = await ed.hass.fetchWithAuth(modelApi(ed), { method: 'DELETE' });
    if (!r.ok && r.status !== 404) throw new Error('Delete failed (HTTP ' + r.status + ')');
    ed.confirmModelDelete = false;
    ed.commit({ ...ed.layout, model: null });
  } catch (err) {
    ed.message = { text: (err as Error).message, error: true };
  }
  ed.render();
}

export function modelTab(ed: EditMode): string {
  const c = ed.card._config;
  if (c.model) {
    return `<p class="note warn">This card shows <b>${esc(c.model)}</b> from its YAML (<code>model:</code>).
        Remove <code>model</code> and the <code>model_*</code> options from the card YAML to upload and align the model here.</p>`
      + modelBindingsHtml(ed);
  }
  if (ed.card._store.backend !== 'shared') {
    return `<p class="note warn">Uploading a model needs the Floorplan 3D integration (Settings → Devices &amp; services → Add integration).
        Without it, put a .glb in /config/www and set <code>model: /local/house.glb</code> in the card YAML.</p>`;
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(c.layout_key))) {
    return `<p class="note warn">layout_key "${esc(c.layout_key)}" can only contain letters, digits, - and _ for model uploads.</p>`;
  }
  const m = ed.layout.model;
  let out = `<p class="hint">A 3D model of the house (.glb) shown under the plan. Parts tagged as levels, rooms and zones
      (<code>fp</code> tags, see <a href="https://github.com/istals/floorplan3d-card/blob/main/docs/model-builder-guide.md" target="_blank" rel="noopener">docs/model-builder-guide.md</a>)
      are shown per floor and become rooms; a tagged model shows whole levels (lower floors stay, upper ones are hidden); only an untagged model is cut at the top of the selected storey. It is stored in Home Assistant and only shown to logged-in users.</p>
      <div class="row"><label class="button ${ed.uploading ? 'disabled' : 'primary'}">${ed.uploading ? 'Uploading ' + esc(ed.uploading) + '…' : (m ? 'Replace model' : 'Upload .glb')}
      <input type="file" accept=".glb,model/gltf-binary" data-field="model-file" hidden ${ed.uploading ? 'disabled' : ''}></label></div>`;
  if (!m) return out;

  const floorInfo = modelBindingsHtml(ed);
  const [x, y, z] = m.position || [0, 0, 0];
  const slider = (f: string, label: string, min: number, max: number, step: number, v: unknown, unit = '') => sliderHtml(`md-${f}`, label, min, max, step, v, unit);
  out += `<section class="box"><h3>${esc(m.name || 'house.glb')}</h3>
      <p class="dim">${m.size ? (m.size / 1048576).toFixed(1) + ' MB' : ''}${m.uploaded ? ' · ' + esc(new Date(m.uploaded).toLocaleString()) : ''}</p>
      </section>${floorInfo}
      <div class="row"><button data-act="model-fit">Frame model</button></div>
      <div class="sub">Alignment</div>`
    + slider('x', 'East', -50, 50, 0.05, x, 'm')
    + slider('y', 'North', -50, 50, 0.05, y, 'm')
    + slider('z', 'Up', -5, 5, 0.05, z, 'm')
    + slider('rotation', 'Rotation', -180, 180, 0.5, m.rotation || 0, '°')
    + slider('opacity', 'Opacity', 0.1, 1, 0.05, m.opacity ?? 1)
    + `<label>Scale <input type="number" step="any" min="0.0001" data-field="md-scale" value="${m.scale || 1}"></label>
      <p class="hint">Scale 0.01 for a model made in centimetres, 0.001 for millimetres.</p>
      <div class="row"><button data-act="model-delete" class="danger">${ed.confirmModelDelete ? 'Really remove?' : 'Remove model'}</button></div>`;
  return out;
}

// Levels -> HA floors, rooms/zones -> HA areas, plus what changed since the last upload.
export function modelBindingsHtml(ed: EditMode): string {
  const mb = ed.card.modelBindings();
  if (!mb) return '<p class="dim">Loading model…</p>';
  const { manifest, levels, rooms, diff, notice } = mb;
  if (!(ed.layout.model && ed.layout.model.known) && !ed._snapPending) { // first look at this model: nothing is "new" yet
    ed._snapPending = true;
    Promise.resolve().then(() => { ed._snapPending = false; if (!(ed.layout.model && ed.layout.model.known)) snapshotKnown(ed); });
  }
  const s = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const objCount = manifest.objects.length;
  let out = `<div class="sub">In the model</div><p class="hint">${s(manifest.levels.length, 'level')},
      ${s(manifest.rooms.filter((r) => r.kind === 'room').length, 'room')}, ${s(manifest.rooms.filter((r) => r.kind === 'zone').length, 'zone')},
      ${s(objCount, 'object')}${objCount ? ' (object controls come in a later version)' : ''}. Click a part of the model to find it here.</p>`;
  const rf = ed.view.renderFrom;
  out += `<p class="dim" data-info="render-recipe">Render recipe: ${rf ? `from model (${s(rf.keys, 'key')})` : 'default'}</p>`;
  const ms = ed.view.mergeStats;
  if (ms && ms.before) {
    const a = ms.after, b = ms.before;
    out += ms.enabled && a.meshes !== b.meshes
      ? `<p class="dim" data-info="merge-stats">Draw calls: ${b.calls} → ${a.calls} (meshes ${b.meshes} → ${a.meshes})</p>`
      : `<p class="dim" data-info="merge-stats">Draw calls: ${b.calls} (${b.meshes} meshes${ms.enabled ? '' : ', merging off'})</p>`;
  }
  if (manifest.errors.length || manifest.warnings.length) {
    out += `<details class="report" ${ed._reportOpen ? 'open' : ''}><summary>${manifest.errors.length} error(s), ${manifest.warnings.length} warning(s)</summary>
        <button class="link" data-act="md-copy-report">Copy to clipboard</button><ul class="plain">`
      + manifest.errors.map((e) => `<li class="bad">${esc(e)}</li>`).join('')
      + manifest.warnings.map((w) => `<li class="dim">${esc(w)}</li>`).join('') + '</ul></details>';
  }
  const added = notice.levels.added.length + notice.rooms.added.length;
  const missing = notice.levels.missing.length + notice.rooms.missing.length;
  if (added || missing) {
    out += `<p class="note warn">Since the last setup: ${added} new part(s) (assigned automatically below, marked auto)
        and ${missing} part(s) no longer in the model. <button class="link" data-act="md-ack">OK</button></p>`;
  }
  const sel = (k: string[], id: string) => (ed.modelPick && ed.modelPick.kind !== 'untagged' && ed.modelPick.id === id && k.includes(ed.modelPick.kind) ? 'sel' : '');

  if (manifest.levels.length) {
    // which HA floor a level belongs to (devices, linked floors, elevations); what each view shows is set in Views
    const opts = (v: string, a: { floor?: string | null; auto?: boolean }) => [
      ['auto', a.auto ? `auto (${a.floor ? (ed.floors.find((f) => f.id === a.floor) || { name: undefined }).name || a.floor : 'no floor'})` : 'auto'],
      ...ed.floors.map((f) => [`floor:${f.id}`, f.name]),
      ['none', 'no floor'],
    ].map(([val, label]) => `<option value="${esc(val)}" ${val === v ? 'selected' : ''}>${esc(label)}</option>`).join('');
    out += '<div class="sub">Levels: belongs to HA floor</div><table class="floors">' + manifest.levels.map((l) => {
      const a = levels[l.id];
      const v = a.auto ? 'auto' : a.floor ? `floor:${a.floor}` : 'none';
      return `<tr data-pick="level:${esc(l.id)}" class="${sel(['level'], l.id)}"><td title="${esc(l.role)}">${esc(l.label)}</td>
          <td><select data-field="md-level" data-id="${esc(l.id)}">${opts(v, a)}</select></td>
          <td class="dim">${a.stale ? '<span class="bad">floor deleted</span>' : a.auto ? 'auto' : ''}</td></tr>`;
    }).join('') + '</table>';
  }

  if (manifest.rooms.length) {
    const areas = Object.values(ed.hass.areas || {}).sort((a, b) => a.name.localeCompare(b.name));
    const opts = (v: string | null | undefined, auto: boolean | undefined) => `<option value="auto" ${auto ? 'selected' : ''}>auto${auto && v ? ' (' + esc((ed.hass.areas[v] || { name: undefined }).name || v) + ')' : ''}</option>`
      + `<option value="" ${!auto && !v ? 'selected' : ''}>— no area —</option>`
      + areas.map((a) => `<option value="${esc(a.area_id)}" ${!auto && a.area_id === v ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
    out += '<div class="sub">Rooms and zones</div><table class="floors">' + manifest.rooms.map((r) => {
      const a = rooms[r.id];
      const lvl = r.level ? levels[r.level] : undefined;
      const note = a.stale ? '<span class="bad">area deleted</span>' : !lvl || !lvl.floor
        ? 'level not on a floor' : r.outlineFallback ? 'no outline' : a.auto ? 'auto' : '';
      return `<tr data-pick="${r.kind}:${esc(r.id)}" class="${sel(['room', 'zone'], r.id)}"><td title="${esc(r.kind)} in ${esc(r.level || '?')}">${esc(r.label)}</td>
          <td><select data-field="md-room" data-id="${esc(r.id)}">${opts(a.area, a.auto)}</select></td><td class="dim">${note}</td></tr>`;
    }).join('') + '</table>'
      + '<p class="hint">Rooms from the model replace rooms drawn for the same area. <a href="/config/areas/dashboard" target="_top">Create areas in Home Assistant</a>.</p>';
  }

  const gone = [...diff.levels.missing.map((id) => ['levels', id]), ...diff.rooms.missing.map((id) => ['rooms', id])] as [string, string][];
  if (gone.length) {
    out += '<div class="sub">No longer in the model</div><ul class="plain">' + gone.map(([k, id]) =>
      `<li><code>${esc(id)}</code> <button class="link" data-act="md-forget" data-kind="${k}" data-id="${esc(id)}">Forget</button></li>`).join('') + '</ul>';
  }
  if (ed.modelPick && ed.modelPick.kind === 'untagged') {
    out += `<p class="note warn">“${esc(ed.modelPick.path)}” is not tagged in the model, so it can't be assigned.
        Ask the model builder to tag it (docs/model-builder-guide.md).</p>`;
  }
  return out;
}

const acts: Record<string, ActHandler> = {
  'md-ack': (ed) => { snapshotKnown(ed); },
  'md-copy-report': (ed) => {
    const mb = ed.card.modelBindings();
    if (!mb) return;
    const { errors, warnings } = mb.manifest;
    const text = [...errors.map((t) => `Error: ${t}`), ...warnings.map((t) => `Warning: ${t}`)].join('\n');
    copyText(text).then((ok) => {
      ed.message = ok ? { text: `Copied ${errors.length + warnings.length} line(s).` }
        : { text: 'Copy is blocked here; select the lines and copy them by hand.', error: true };
      ed.render();
    });
  },
  'md-forget': (ed, btn) => {
    const m: LayoutModel = ed.layout.model || {};
    const k = btn.dataset.kind === 'rooms' ? 'rooms' : 'levels'; // data-kind: levels | rooms
    const next: Record<string, unknown> = { ...m[k] };
    delete next[btn.dataset.id || ''];
    ed.setModelProps({ [k]: next });
  },
  'model-fit': (ed) => { ed.view.fit({ model: true }); },
  'model-delete': (ed) => {
    if (!ed.confirmModelDelete) { ed.confirmModelDelete = true; return 'render'; }
    removeModel(ed);
  },
};

const fields: Record<string, FieldHandler> = {
  'model-file': (ed, el) => {
    const file = el.files && el.files[0];
    el.value = '';
    if (file) uploadModel(ed, file);
  },
  'md-level': (ed, el) => {
    const v = el.value;
    const m: LayoutModel = ed.layout.model || {};
    const levels = { ...m.levels };
    const id = el.dataset.id || '';
    if (v === 'auto') delete levels[id]; // back to automatic
    else if (v.startsWith('floor:')) levels[id] = { floor: v.slice(6) };
    else if (v === 'none') levels[id] = { floor: null };
    else return;
    // a legacy show mode on this level becomes view rules before the binding drops it
    const c = ed.card._config;
    const saved = { ...(c.model ? levelsFromFloorMap(c.model_floors) : {}), ...m.levels };
    const mb = ed.card._mb;
    const views = mb ? legacyShowRules(ed.layout.views, ed.card._views, id, saved, mb.manifest.levels) : ed.layout.views;
    ed.commit({ ...ed.layout, model: { ...m, levels }, ...(views !== ed.layout.views ? { views } : {}) });
    ed.render();
  },
  'md-room': (ed, el) => {
    const m: LayoutModel = ed.layout.model || {};
    const rooms = { ...m.rooms };
    const id = el.dataset.id || '';
    if (el.value === 'auto') delete rooms[id];
    else rooms[id] = { area: el.value || null };
    ed.setModelProps({ rooms });
  },
  'md-scale': (ed, el) => {
    const v = Number(el.value);
    if (Number.isFinite(v) && v > 0) ed.setModelProps({ scale: v }, false);
  },
};

// alignment sliders (md-<key> ranges) move the model live, without re-rendering the panel
const ranges: Record<string, FieldHandler> = {
  'md-': (ed, el) => {
    const key = String(el.dataset.field).slice(3); // dispatched by its data-field prefix
    const v = Number(el.value);
    const m = ed.layout.model;
    if (!m) return;
    if (key === 'x' || key === 'y' || key === 'z') {
      const pos: [number, number, number] = [...(m.position || [0, 0, 0])];
      pos['xyz'.indexOf(key)] = v;
      ed.setModelProps({ position: pos }, false);
    } else ed.setModelProps({ [key]: v }, false);
  },
};

export const modelTabDef = defineTab({ id: 'model', html: modelTab, acts, fields, ranges });

