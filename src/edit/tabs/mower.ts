// Mower tab: setup checklist, position source, warning, calibration, map overlay and its processing.

import { readSource, calibrationError } from '../../mower.ts';
import { setupChecklist } from '../../mower-setup.ts';
import { colorList, removeColorPatch, MAX_COLORS } from '../../mower-image.ts';
import { closePicker, openColorPicker, alignPicker, cancelAlign, markFront } from '../tools/map-tools.ts';
import { entOption, esc, fmt, sliderHtml } from '../html.ts';
import { defineTab } from './tab.ts';
import type { ActHandler, FieldHandler } from './tab.ts';
import type { EditMode } from '../../edit-mode.ts';
import type { ImageResult, MowerLive } from '../../card/mower-controller.ts';
import type { LayoutMower, MapColorKind, MowerCalibrationPoint, MowerImageConfig, MowerOverlay } from '../../types/layout.ts';

type Slider = (f: string, label: string, min: number, max: number, step: number, v: unknown, unit?: string) => string;
type Datalist = (id: string, list: string[]) => string;

// ---------- mower ----------
export function mower(ed: EditMode): LayoutMower {
  return ed.layout.mower || {};
}

export function setMower(ed: EditMode, patch: Partial<LayoutMower>) {
  const cur: LayoutMower = ed.layout.mower || { entity: '', source: 'gps', x_attr: 'x', y_attr: 'y', floor_id: ed.floors[0].id, calibration: [], overlay: null };
  ed.commit({ ...ed.layout, mower: { ...cur, ...patch } });
  ed.render();
}

export function setOverlay(ed: EditMode, patch: Partial<MowerOverlay>, rerender = true) {
  const m = mower(ed);
  const cur: MowerOverlay = m.overlay || { entity: '', x: 0, y: 0, rotation: 0, width: 20, opacity: 0.6, refresh: 10 };
  const overlay = { ...cur, ...patch };
  ed.card._commit({ ...ed.layout, mower: { ...m, overlay } });
  if (rerender) ed.render();
}

// live values in the Mower tab (shown), without re-rendering the panel
export function mowerLive(ed: EditMode) {
  const el = ed.panel.querySelector('.mower-live');
  if (el) el.innerHTML = mowerLiveHtml(ed) + mapInfoHtml(ed);
  const cl = ed.panel.querySelector<HTMLDetailsElement>('.mower-setup');
  if (cl) {
    ed._setupOpen = cl.open;
    const html = setupHtml(ed, true);
    if (html !== ed._setupLast) { ed._setupLast = html; cl.outerHTML = html; }
  }
}

// Did the last position reading / icon detection put the mower on the plan?
export function mowerFound(ed: EditMode): boolean {
  const m = mower(ed), live = ed.card._mowerLive;
  if (!live || !live.floorId) return false;
  if (m.source !== 'image') return true;
  const r = ed.card._imageResult;
  return !!(r && !r.error && !r.missing);
}

// Setup checklist at the top of the Mower tab; each row scrolls to its control.
export function setupHtml(ed: EditMode, keepOpen: boolean): string {
  const m = mower(ed), on = ed.card.mowerAuto(m);
  const auto = on ? { ...on, mismatch: !!ed.card._autoMismatch } : null;
  const { rows, complete } = setupChecklist(m, ed.hass.states, mowerFound(ed), auto);
  const open = !complete || (keepOpen && ed._setupOpen);
  const li = rows.map((r) => `<li><button class="link setup-row ${r.ok ? 'ok' : r.optional ? 'opt' : 'todo'}" data-act="setup-go" data-target="${esc(r.target)}">
      <span class="mark">${r.ok ? '✓' : r.optional ? '–' : '✗'}</span> ${esc(r.label)}${r.optional && !r.ok ? ' <span class="dim">optional</span>' : ''}</button></li>`).join('');
  return `<details class="mower-setup${complete ? ' complete' : ''}" ${open ? 'open' : ''}><summary>${complete ? '✓ Setup complete' : 'Setup'}</summary>
      <ul class="plain setup">${li}</ul></details>`;
}

// "Stripes: 45° (NE–SW) · Mowed: 37 %" from the processed map, or ''.
export function mapInfoHtml(ed: EditMode): string {
  const mi = ed.card.mapInfo();
  const parts: string[] = [];
  if (mi.stripes) parts.push(`Stripes: ${esc(mi.stripes)}`);
  if (mi.mowed) parts.push(`Mowed: ${esc(mi.mowed)}${mi.mowedSource ? ` (${esc(mi.mowedSource)})` : ''}`);
  return parts.length ? `<br><span class="map-info">${parts.join(' · ')}</span>` : '';
}

export function mowerLiveHtml(ed: EditMode): string {
  const m = mower(ed);
  const st = m.entity && ed.hass.states[m.entity];
  if (!m.entity) return m.source === 'image' ? 'Pick the mower entity: its marker follows the icon found on the map image.' : 'Pick the entity that reports the mower position.';
  if (!st) return `Entity <b>${esc(m.entity)}</b> not found.`;
  if (m.source === 'image') return mowerImageHtml(ed);
  const r = readSource(st, m);
  if (!r) return m.source === 'xy'
    ? `No numeric <b>${esc(m.x_attr || 'x')}</b> / <b>${esc(m.y_attr || 'y')}</b> attributes on ${esc(m.entity)}.`
    : `No latitude/longitude on ${esc(m.entity)} (state: ${esc(st.state)}).`;
  const live = ed.card._mowerLive;
  const raw = (r.raw ?? []).map((v: number) => (m.source === 'xy' ? fmt(v) : v.toFixed(6))).join(', ');
  const plan = live && live.floorId ? `on plan (${fmt(live.x)}, ${fmt(live.y)})` : 'not on the plan yet: add a calibration point';
  const ms = ed.card.mowerStatus();
  return `${ms && ms.kind === 'dock' ? `<span class="mower-status">${esc(ed.card.mowerStatusText())}</span><br>` : ''}Reading ${raw}<br>${plan}`;
}

export function mowerImageHtml(ed: EditMode): string {
  const m = mower(ed);
  const ic: MowerImageConfig = m.image || {};
  if (!m.overlay || !m.overlay.entity) return 'Add the map overlay below and align it with the plan: that alignment is the calibration.';
  const hd = ed.card.mowerHeading();
  const SOURCES: Record<string, string> = { picture: 'mower picture', icon: 'icon', movement: 'movement', dock: 'dock' };
  const head = hd ? `<br>Heading ${hd.deg}° (${SOURCES[hd.source] || hd.source})` : '';
  if (!colorList(ic).length && !ed.card.mowerAuto(m)) return 'Pick the mower icon colour on the map (below).';
  return mowerImageFound(ed) + head;
}

export function mowerImageFound(ed: EditMode): string {
  const r = ed.card._imageResult;
  const live = ed.card._mowerLive;
  if (r && r.error) return `<span style="color: var(--error-color, #db4437)">${esc(r.error)}</span>`;
  const st = ed.card.mowerStatus();
  const line = st ? `<span class="mower-status">${esc(ed.card.mowerStatusText())}</span>` : '';
  const at = live && live.floorId ? ` at ${fmt(live.x)}, ${fmt(live.y)}` : '';
  if (st && st.kind === 'dock') return line + at;
  if (ed.card.mowerAuto(mower(ed))) return line + (st && (st.kind === 'tracked' || st.kind === 'last') ? at : '');
  if (line && st && st.kind !== 'searching') return `${line}<br>${mowerColourFound(ed, r, live)}`;
  return mowerColourFound(ed, r, live);
}

export function mowerColourFound(ed: EditMode, r: ImageResult | null | undefined, live: MowerLive | null | undefined): string {
  if (r && r.missing) return 'Mower icon not found' + (live && live.floorId ? ` (last seen at ${fmt(live.x)}, ${fmt(live.y)})` : '') + '.';
  if (r && live && live.floorId) return `Found at ${fmt(live.x)}, ${fmt(live.y)} (${r.count} px${r.match ? `, picture match ${r.match.toFixed(2)}` : ''})`;
  return 'Looking for the mower icon…';
}

export function mowerTab(ed: EditMode): string {
  const m = mower(ed);
  const states = ed.hass.states;
  const ids = Object.keys(states).sort();
  const posIds = ids.filter((id) => /^(device_tracker|sensor|lawn_mower|vacuum)\./.test(id));
  const picIds = ids.filter((id) => /^(image|camera)\./.test(id));
  const errIds = ids.filter((id) => /^(binary_sensor|sensor)\./.test(id));
  const datalist: Datalist = (id, list) => `<datalist id="${id}">${list.map((x) => entOption(ed, x)).join('')}</datalist>`;
  const floorOpts = ed.floors.map((f) => `<option value="${esc(f.id)}" ${f.id === ed.card._mowerFloor() ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  const cal: MowerCalibrationPoint[] = m.calibration || [];
  const err = calibrationError(cal, m.source === 'xy' ? 'xy' : 'gps');
  const fitName = ['', 'shift only', 'shift, rotate, scale', 'affine (least squares)'][Math.min(cal.length, 3)];
  ed._setupLast = setupHtml(ed, false);
  let out = `${ed._setupLast}<div class="sub">Position</div>
      <label>Entity <input list="fp-pos-ents" data-field="mower-entity" value="${esc(m.entity || '')}" placeholder="device_tracker.mower_position"></label>
      ${datalist('fp-pos-ents', posIds)}
      <label>Source <select data-field="mower-source">
        <option value="gps" ${m.source !== 'xy' && m.source !== 'image' ? 'selected' : ''}>GPS (latitude / longitude)</option>
        <option value="xy" ${m.source === 'xy' ? 'selected' : ''}>Map x / y attributes</option>
        <option value="image" ${m.source === 'image' ? 'selected' : ''}>Live map image (mower found on the map)</option></select></label>
      ${m.source === 'xy' ? `<div class="row"><label>x attribute <input data-field="mower-xattr" value="${esc(m.x_attr || 'x')}"></label>
        <label>y attribute <input data-field="mower-yattr" value="${esc(m.y_attr || 'y')}"></label></div>` : ''}
      <label>Floor <select data-field="mower-floor">${floorOpts}</select></label>
      <div class="sub">Warning</div>
      <label>Error entity (optional) <input list="fp-err-ents" data-field="mower-error-entity" value="${esc(m.error_entity || '')}" placeholder="binary_sensor.mower_error"></label>
      ${datalist('fp-err-ents', errIds)}
      <label>OK values (optional, comma-separated) <input data-field="mower-ok-values" value="${esc(Array.isArray(m.ok_values) ? m.ok_values.join(', ') : m.ok_values || '')}" placeholder="rain delay, waiting"></label>
      <p class="hint">Numbers: 0 = OK, anything else is an error code. Text: ok, none, normal, working, mowing, charging, docked, idle, returning, paused, standby… are OK; add your own above.</p>
      <label>Stuck after (minutes, 0 = off) <input type="number" min="0" max="120" step="1" data-field="mower-stuck-min" value="${m.stuck_minutes === undefined ? 5 : Number(m.stuck_minutes) || 0}"></label>
      <p class="hint mower-live">${mowerLiveHtml(ed)}${mapInfoHtml(ed)}</p>`;
  if (!m.entity) return out;

  if (m.source !== 'image') out += calibrationHtml(ed, m, cal, err, fitName);
  out += overlayHtml(ed, m, picIds, datalist);
  if (m.source === 'image') out += mowerImageSection(ed, m);
  else out += autoSection(ed, m);
  out += '<div class="row"><button data-act="mower-remove" class="danger">Remove mower</button></div>';
  return out;
}

// Colour chips (swatch, rgb, × removes) of one category: 'icon' or bg / mowed / nomow.
export function chipsHtml(ed: EditMode, cols: number[][], kind: string): string {
  if (!cols.length) return '';
  return `<div class="chips colors">${cols.map((c, i) => `<span class="cchip" title="rgb(${c.join(', ')})"><span class="swatch" style="background:rgb(${c.join(',')})"></span>${c.join(', ')}
      <button class="link" data-act="color-del" data-kind="${kind}" data-i="${i}" title="Remove this colour" aria-label="Remove">×</button></span>`).join('')}
      ${cols.length < MAX_COLORS ? `<span class="dim">${cols.length}/${MAX_COLORS}: pick again to add a shade</span>` : ''}</div>`;
}

// Auto mode: the live map compared with the static map, the mower found by its picture.
export function autoSection(ed: EditMode, m: LayoutMower): string {
  const det = ed.card.mowerAuto(m, true);
  if (!det) return '';
  const imgs = Object.keys(ed.hass.states).filter((e) => e.startsWith('image.')).sort();
  const on = !!ed.card.mowerAuto(m);
  let out = '<div class="sub">Automatic</div>';
  if (on && ed.card._autoMismatch) out += `<p class="hint auto-state" style="color: var(--error-color, #db4437)">Static map doesn't match the live map: ${colorList(m.image).length ? 'the colour picks are used' : 'no detection'} until it does.</p>`;
  out += `<p class="hint auto-state">${on ? `<b>Auto (static map${det.picture ? ' + mower picture' : ''})</b>: live map ${esc(det.live)}, static map ${esc(det.static)}${det.picture ? `, mower picture ${esc(det.picture)}` : ''}.`
    : det.static ? 'Auto mode is off: the colour picks below are used.' : 'No static map found: pick the colours below, or set the static map.'}</p>`;
  out += `<label>Static map <input list="fp-img-ents" data-field="mower-static" value="${esc(m.static_entity ?? '')}" placeholder="${esc(m.static_entity === undefined && det.static ? `auto: ${det.static}` : 'image.mower_map')}"></label>`;
  out += `<label>Mower picture <input list="fp-img-ents" data-field="mower-picture" value="${esc(m.picture_entity ?? '')}" placeholder="${esc(m.picture_entity === undefined && det.picture ? `auto: ${det.picture}` : 'image.mower_mower_image')}"></label>`;
  out += `<datalist id="fp-img-ents">${imgs.map((x) => entOption(ed, x)).join('')}</datalist>`;
  if (det.static) out += `<label class="check"><input type="checkbox" data-field="mower-auto-off" ${m.auto === false ? 'checked' : ''}> Use colour picks instead</label>`;
  return out;
}

export function mowerImageSection(ed: EditMode, m: LayoutMower): string {
  const ic: MowerImageConfig = m.image || {};
  const o = m.overlay;
  let out = autoSection(ed, m);
  if (ed.card.mowerAuto(m)) return out + markFrontHtml(ed, m);
  out += '<div class="sub">Mower icon on the map</div>';
  out += `<label>Image entity <input list="fp-pic-ents" data-field="mower-img-entity" value="${esc(ic.entity || '')}" placeholder="${esc((o && o.entity) || 'same as the overlay')}"></label>`;
  if (ed.colorPick === true) {
    out += `<section class="box"><p>Click the mower icon on the map overlay. Esc cancels.</p>
        <div class="row"><button data-act="img-pick-cancel">Cancel</button></div></section>`;
  }
  const icols = colorList(ic);
  out += `<div class="row"><button data-act="img-pick" class="${icols.length || ed.colorPick ? '' : 'primary'}" ${ed.colorPick || !(o && o.entity) || icols.length >= MAX_COLORS ? 'disabled' : ''}>Pick mower colour</button></div>`;
  out += chipsHtml(ed, icols, 'icon');
  if (icols.length) {
    const tol = ic.tolerance ?? 40;
    out += sliderHtml('mower-img-tolerance', 'Colour tolerance', 0, 255, 1, tol);
  }
  out += markFrontHtml(ed, m);
  out += `<p class="hint">Align the map overlay with the plan first: the alignment maps image pixels to the plan, so no
      calibration points are needed. Then pick the colour of the mower icon on the map.</p>`;
  return out;
}

// "Mark front": click the icon's front tip once; the offset corrects the icon heading.
export function markFrontHtml(ed: EditMode, m: LayoutMower): string {
  const ic: MowerImageConfig = m.image || {};
  const can = !!ed.card._imageBlob && ed.card._iconHeadRaw !== undefined && ed.card._iconHeadRaw !== null;
  const off = Number(ic.front_offset) || 0;
  return `<div class="row"><button data-act="mark-front" ${can ? '' : 'disabled'} title="Click the front tip of the mower icon in the map picture">Mark front</button>
      ${off ? `<span class="dim">offset ${Math.round(off)}°</span> <button class="link" data-act="front-clear">Clear</button>` : ''}</div>`;
}

export function calibrationHtml(ed: EditMode, m: LayoutMower, cal: MowerCalibrationPoint[], err: number, fitName: string): string {
  let out = `<div class="sub">Calibration (${cal.length} point${cal.length === 1 ? '' : 's'}${cal.length ? ': ' + fitName : ''})</div>`;
  if (ed.calibrating) {
    out += `<section class="box"><p>Click on the plan where the mower is right now.</p>
        <div class="row"><button data-act="cal-cancel">Cancel</button></div></section>`;
  }
  out += '<ul class="plain">' + cal.map((c, i) => `<li>${i + 1}. (${c.src.map((v) => (m.source === 'xy' ? fmt(v) : v.toFixed(6))).join(', ')}) → (${fmt(c.plan[0])}, ${fmt(c.plan[1])})
      <button class="link" data-act="cal-del" data-i="${i}">Remove</button></li>`).join('') + '</ul>';
  if (cal.length >= 3) out += `<p class="dim">Fit error ${fmt(err)} m</p>`;
  out += `<div class="row"><button data-act="cal-add" class="${ed.calibrating ? '' : 'primary'}" ${ed.calibrating ? 'disabled' : ''}>Add point</button></div>
      <p class="hint">"Add point" takes the current reading, then you click where the mower really is. One point aligns
      a GPS track north-up, two fix rotation and scale, three or more also correct skew. Spread points far apart.</p>`;
  return out;
}

export function overlayHtml(ed: EditMode, m: LayoutMower, picIds: string[], datalist: Datalist): string {
  let out = '';
  const o = m.overlay;
  out += `<div class="sub">Map overlay</div>
      <label>Image or camera entity <input list="fp-pic-ents" data-field="ov-entity" value="${esc((o && o.entity) || '')}" placeholder="image.mower_map"></label>
      ${datalist('fp-pic-ents', picIds)}`;
  if (o && o.entity) {
    const slider: Slider = (f, label, min, max, step, v, unit = '') => sliderHtml(`ov-${f}`, label, min, max, step, v, unit);
    out += slider('x', 'x', -100, 100, 0.05, o.x ?? 0, 'm')
      + slider('y', 'y', -100, 100, 0.05, o.y ?? 0, 'm')
      + slider('rotation', 'Rotation', -180, 180, 0.5, o.rotation ?? 0, '°')
      + slider('width', 'Width', 1, 200, 0.1, o.width ?? 20, 'm')
      + slider('opacity', 'Opacity', 0, 1, 0.05, o.opacity ?? 0.6)
      + slider('height_offset', 'Height offset', -0.5, 0.5, 0.01, o.height_offset ?? 0, 'm')
      + (o.entity.startsWith('camera.') ? slider('refresh', 'Refresh every', 1, 120, 1, o.refresh ?? 10, 's') : '');
    out += `<label class="check"><input type="checkbox" data-field="ov-edit-only" ${o.edit_only ? 'checked' : ''}> Show the map only in edit mode</label>`;
    out += mapProcessingHtml(ed, m, o, slider);
    const a = ed.aligning;
    if (a) {
      const n = a.pairs.length + 1;
      out += `<section class="box align-box"><p>${a.pending ? `Point ${n}: now click the same spot on the model.` : `Point ${n}: click a spot on the map image${ed.picker ? ' (in the picture over the plan)' : ''}.`}
          ${a.pairs.length >= 2 ? ` Aligned to ${a.pairs.length} points.` : ' Two points align it, more refine it.'} Esc cancels.</p>
          <div class="row">${!a.pending && !ed.picker ? '<button data-act="align-image">Pick image point</button>' : ''}<button data-act="ov-align-done" class="primary">Done</button><button data-act="ov-align-cancel">Cancel</button></div></section>`;
    }
    out += `<div class="row"><button data-act="ov-align" ${a ? 'disabled' : ''}>Align by points</button>
        <button data-act="ov-move" class="${ed.overlayMove ? 'primary' : ''}">${ed.overlayMove ? 'Drag the map on the plan…' : 'Move with mouse'}</button>
        <button data-act="ov-remove">Remove overlay</button></div>
        <p class="hint">The map lies on the model's surface under its centre; adjust with the height offset.</p>`;
  }
  return out;
}

// Map picture processing: picked colours (background transparent, mowed stripes, shaded no-mow),
// the mower icon hidden, clipped to a zone.
export function mapProcessingHtml(ed: EditMode, m: LayoutMower, o: MowerOverlay, slider: Slider): string {
  let out = '<div class="sub">Map picture</div>';
  if (ed.card.mowerAuto(m)) {
    return out + '<p class="hint">Automatic: compared with the static map, unchanged parts are transparent, mowed stripes light, no-mow areas shaded.</p>';
  }
  if (ed.colorPick && ed.colorPick !== true) {
    const NAMES: Record<MapColorKind, string> = { bg: 'background', mowed: 'mowed stripe', nomow: 'no-mow area' };
    out += `<section class="box"><p>Click the ${NAMES[ed.colorPick]} colour on the map overlay. Esc cancels.</p>
        <div class="row"><button data-act="map-pick-cancel">Cancel</button></div></section>`;
  }
  const kinds: [MapColorKind, string, string][] = [['bg', 'Pick background colour', 'Background: transparent'], ['mowed', 'Pick mowed colour', 'Mowed stripes: light'], ['nomow', 'Pick no-mow colour', 'No-mow areas: shaded']];
  for (const [k, label, what] of kinds) {
    const cols = colorList(o, k);
    out += `<div class="row"><button data-act="map-pick" data-kind="${k}" ${ed.colorPick || cols.length >= MAX_COLORS ? 'disabled' : ''}>${label}</button>${cols.length ? ` <span class="dim">${what}</span>` : ''}</div>`;
    out += chipsHtml(ed, cols, k);
    if (cols.length) out += slider(`${k}_tolerance`, 'Tolerance', 0, 128, 1, o[`${k}_tolerance`] ?? 30);
  }
  if (m.source === 'image') {
    out += `<label class="check"><input type="checkbox" data-field="ov-hide-icon" ${o.hide_icon !== false ? 'checked' : ''}> Hide mower icon on the map</label>`;
  }
  const zones = ed.card._zones || [];
  const auto = ed.card.mapZone({ ...o, zone: 'auto' });
  const zsel = o.zone || 'auto';
  out += `<label>Clip to zone <select data-field="ov-zone">
      <option value="auto" ${zsel === 'auto' ? 'selected' : ''}>Automatic (${esc(auto ? auto.id : 'none at the map centre')})</option>
      <option value="none" ${zsel === 'none' ? 'selected' : ''}>None</option>
      ${zones.map((z) => `<option value="${esc(z.id)}" ${zsel === z.id ? 'selected' : ''}>${esc(z.id)}</option>`).join('')}</select></label>`;
  out += `<p class="hint">Pick colours by clicking them on the map. Without a background colour the picture is drawn as it is.
      The zone clip applies once a colour is picked or the icon is hidden.</p>`;
  return out;
}

function toMowerFloor(ed: EditMode) {
  if (ed.card._floor !== ed.card._mowerFloor()) ed.card._setFloor(ed.card._mowerFloor());
}

// The colour pick buttons end the calibration click, the move tool and aligning first.
function pickColor(ed: EditMode, kind: 'icon' | MapColorKind) {
  ed.calibrating = null;
  ed.overlayMove = false;
  ed.aligning = null;
  openColorPicker(ed, kind);
}

const acts: Record<string, ActHandler> = {
  'cal-add': (ed) => {
    const m = mower(ed);
    const r = m.entity ? readSource(ed.hass.states[m.entity], m) : null; // no entity: no reading, as before
    if (!r) { ed.message = { text: 'No position reading from the mower entity right now.', error: true }; return 'render'; }
    ed.calibrating = { src: r.raw }; // readSource: [u, v] or [lat, lon]
    ed.overlayMove = false;
    toMowerFloor(ed);
    return 'render';
  },
  'cal-cancel': (ed) => { ed.calibrating = null; return 'render'; },
  'img-pick': (ed) => { pickColor(ed, 'icon'); },
  'img-pick-cancel': (ed) => { ed.colorPick = false; return 'render'; },
  'map-pick-cancel': (ed) => { ed.colorPick = false; return 'render'; },
  'map-pick': (ed, btn) => { pickColor(ed, btn.dataset.kind as MapColorKind); }, // data-kind from mapProcessingHtml
  'align-image': (ed) => { alignPicker(ed); },
  'mark-front': (ed) => { markFront(ed); },
  'front-clear': (ed) => { const ic: MowerImageConfig = mower(ed).image || {}; ed.card._headSt = null; setMower(ed, { image: { ...ic, front_offset: 0 } }); },
  'color-del': (ed, btn) => {
    const k = btn.dataset.kind, i = Number(btn.dataset.i);
    if (k === 'icon') { const ic: MowerImageConfig = mower(ed).image || {}; setMower(ed, { image: { ...ic, ...removeColorPatch(ic, null, i) } }); } else setOverlay(ed, removeColorPatch(mower(ed).overlay || {}, (k ?? null) as MapColorKind | null, i));
    if (ed.picker) ed.picker.refresh();
  },
  'cal-del': (ed, btn) => { setMower(ed, { calibration: (mower(ed).calibration || []).filter((_, i) => i !== Number(btn.dataset.i)) }); },
  'ov-move': (ed) => { closePicker(ed); ed.overlayMove = !ed.overlayMove; ed.calibrating = null; ed.colorPick = false; ed.aligning = null; return 'render'; },
  'ov-remove': (ed) => { closePicker(ed); ed.overlayMove = false; ed.aligning = null; setMower(ed, { overlay: null }); },
  'ov-align': (ed) => {
    const o: MowerOverlay = mower(ed).overlay || {};
    // the starting alignment: Cancel / Esc put it back, Done keeps the fit
    ed.aligning = { pairs: [], pending: null, start: { x: o.x ?? 0, y: o.y ?? 0, rotation: o.rotation ?? 0, width: o.width ?? 20 } };
    ed.overlayMove = false;
    ed.calibrating = null;
    ed.colorPick = false;
    toMowerFloor(ed);
    ed._syncStageClasses();
    ed.render();
    alignPicker(ed);
  },
  'ov-align-done': (ed) => {
    const done = ed.aligning && ed.aligning.pairs.length >= 2;
    closePicker(ed);
    ed.aligning = null;
    if (done) { setOverlay(ed, { aligned: true }); ed._syncStageClasses(); return; }
    return 'render';
  },
  'ov-align-cancel': (ed) => { cancelAlign(ed); return 'render'; },
  'setup-go': (ed, btn) => {
    const t = btn.dataset.target ? ed.panel.querySelector<HTMLElement>(btn.dataset.target) : null;
    if (!t) return;
    const box = t.closest('label') || t;
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    box.classList.remove('setup-flash');
    void box.offsetWidth;
    box.classList.add('setup-flash');
    setTimeout(() => box.classList.remove('setup-flash'), 1600);
    if (t.matches('input, select')) t.focus({ preventScroll: true });
  },
  'mower-remove': (ed) => { ed.calibrating = null; ed.colorPick = false; ed.overlayMove = false; ed.aligning = null; ed.commit({ ...ed.layout, mower: null }); ed.render(); },
};

const fields: Record<string, FieldHandler> = {
  'mower-entity': (ed, el) => { setMower(ed, { entity: el.value.trim() }); },
  // readings of the other kind cannot be mixed into the same calibration
  'mower-source': (ed, el) => { setMower(ed, { source: el.value, calibration: [] }); },
  'mower-img-entity': (ed, el) => {
    const ic: MowerImageConfig = { ...mower(ed).image };
    const v = el.value.trim();
    if (v) ic.entity = v;
    else delete ic.entity;
    setMower(ed, { image: ic });
  },
  'mower-img-tolerance': (ed, el) => {
    setMower(ed, { image: { ...mower(ed).image, tolerance: Math.max(0, Math.min(255, Number(el.value) || 0)) } });
  },
  'mower-xattr': (ed, el) => { setMower(ed, { x_attr: el.value.trim() || 'x' }); },
  'mower-yattr': (ed, el) => { setMower(ed, { y_attr: el.value.trim() || 'y' }); },
  'mower-floor': (ed, el) => {
    ed.card._setFloor(el.value);
    setMower(ed, { floor_id: el.value });
  },
  'mower-error-entity': (ed, el) => { setMower(ed, { error_entity: el.value.trim() }); },
  // empty: automatic again; "none": no entity
  'mower-static': (ed, el) => { const v = el.value.trim(); setMower(ed, { static_entity: v === '' ? undefined : v === 'none' ? '' : v }); },
  'mower-picture': (ed, el) => { const v = el.value.trim(); setMower(ed, { picture_entity: v === '' ? undefined : v === 'none' ? '' : v }); },
  'mower-auto-off': (ed, el) => { setMower(ed, { auto: el.checked ? false : undefined }); },
  'mower-ok-values': (ed, el) => {
    const v = el.value.split(',').map((x) => x.trim()).filter(Boolean);
    setMower(ed, { ok_values: v.length ? v : undefined });
  },
  'mower-stuck-min': (ed, el) => { setMower(ed, { stuck_minutes: Math.max(0, Math.min(120, Math.round(Number(el.value) || 0))) }); },
  'ov-edit-only': (ed, el) => { setOverlay(ed, { edit_only: el.checked }); },
  'ov-hide-icon': (ed, el) => { setOverlay(ed, { hide_icon: el.checked }); },
  'ov-zone': (ed, el) => { setOverlay(ed, { zone: el.value === 'auto' ? null : el.value }); },
  'ov-entity': (ed, el) => {
    const v = el.value.trim();
    if (!v) setMower(ed, { overlay: null });
    else {
      // first time: centre the map on the current view
      const t = ed.view.controls!.target; // the controls exist while the card is shown
      const first = !mower(ed).overlay;
      setOverlay(ed, first ? { entity: v, x: Math.round(t.x * 10) / 10, y: Math.round(-t.z * 10) / 10 } : { entity: v });
    }
  },
};

const inputs: Record<string, FieldHandler> = {
  'mower-img-tolerance': () => {}, // saved on change
};

// overlay sliders (ov-<key> ranges) move the map live, without re-rendering the panel under the pointer
const ranges: Record<string, FieldHandler> = {
  'ov-': (ed, el) => {
    const key = String(el.dataset.field).slice(3); // dispatched by its data-field prefix
    const v = Number(el.value);
    setOverlay(ed, { [key]: v }, false);
  },
};

export const mowerTabDef = defineTab({ id: 'mower', html: mowerTab, live: mowerLive, acts, fields, inputs, ranges });

