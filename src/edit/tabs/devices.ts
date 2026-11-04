// Devices tab: the selected marker, stick to surfaces, badges, unplaced and hidden devices.

import * as E from '../../editor.ts';
import { buildMarkers, areaName } from '../../registry.ts';
import { surfaceKind, surfaceSearch, stickSurface, nearestDistance, needsStick, worldOf, planOf } from '../../surface.ts';
import { logoBox, esc, fmt } from '../html.ts';
import { defineTab } from './tab.ts';
import type { ActHandler, FieldHandler } from './tab.ts';
import type { EditMode, StickMove } from '../../edit-mode.ts';
import type { Layout, LayoutPin } from '../../types/layout.ts';

/** A device / entity marker (registry.js buildMarkers), as far as this tab reads it. */
export interface MarkerInfo {
  id: string;
  entityId: string;
  name: string;
  areaId?: string | null;
  domain: string;
  deviceClass?: string | null;
  [key: string]: unknown;
}

export function allMarkers(ed: EditMode): MarkerInfo[] {
  return buildMarkers(ed.hass, { ...ed.layout, hidden: [] }, { group_by: ed.card._config.group_by });
}

// Badge toggles (layout.badges); keys set in the card YAML `badges:` win and are shown disabled.
export function badgesHtml(ed: EditMode): string {
  const o = ed.card.badgeOpts(), yaml = ((ed.card._config && ed.card._config.badges) || {}) as Record<string, unknown>; // YAML: read per key below
  const row = (k: string, label: string) => {
    const fixed = typeof yaml[k] === 'boolean';
    return `<label class="check"><input type="checkbox" data-field="badge" data-key="${k}" ${o[k] ? 'checked' : ''} ${fixed ? 'disabled' : ''}> ${label}${fixed ? ' <span class="dim">(card YAML)</span>' : ''}</label>`;
  };
  const th = ed.layout.tap_hints || 'near';
  const opt = (v: string, l: string) => `<option value="${v}"${th === v ? ' selected' : ''}>${l}</option>`;
  return `<div class="sub">Badges</div>${row('integration', 'Show integration logos')}${row('status', 'Show status')}${row('battery', 'Show low battery')}
      <label class="tap-hints">Tap hints <select data-field="tap-hints">${opt('always', 'Always')}${opt('near', 'Near pointer')}${opt('off', 'Off')}</select></label>
      <p class="hint">Dots on tappable model objects: filled when a tap works, hollow grey when it is offline or a controller is off.</p>`;
}

export function devicesTab(ed: EditMode): string {
  const all = allMarkers(ed);
  const byId = new Map(all.map((m) => [m.id, m]));
  const hidden = ed.layout.hidden || [];
  let out = '';
  const m = ed.selectedMarker && byId.get(ed.selectedMarker);
  if (m) {
    const pos = ed.card._positions && ed.card._positions.get(m.id);
    const pin = (ed.layout.pins || {})[m.id];
    const pinned = !!pin;
    const attached = pin && pin.attach;
    const target = attached ? ed.card._objects && ed.card._objects.objectAt(attached) : null;
    if (m.id === ed.card._mowerMarkerId) {
      return out + `<section class="box"><h3>${esc(m.name)}</h3><p class="dim">${esc(m.entityId)}</p>
          <p>Follows the live mower position. Set it up in the Mower tab.</p>
          <div class="row"><button data-act="deselect-marker">Done</button></div></section>`;
    }
    out += `<section class="box"><h3>${esc(m.name)}</h3>
        <p class="dim">${esc(m.entityId)}${m.areaId ? ' · ' + esc(areaName(ed.hass, m.areaId)) : ''}</p>
        <p>${attached ? `Attached to ${esc(target ? ed.card.objectLabel(target.obj) : attached)}${target ? '' : ' (not in the model)'}` : pinned ? 'Pinned' : 'Auto placed'}</p>
        ${pos ? `<label>Height above floor (m) <input type="number" step="0.05" min="0" data-field="marker-z" value="${fmt(pos.z)}"></label>` : ''}
        <div class="row">
          ${attached ? '<button data-act="detach">Detach</button>' : ''}
          ${pinned ? '<button data-act="unpin">Return to auto placement</button>' : ''}
          <button data-act="hide">Hide</button>
          <button data-act="deselect-marker">Done</button>
        </div></section>`;
  }
  out += `<p class="hint">Drag any marker on the plan to pin it there${ed.view.model ? ' (it sticks to the model surface; drop on a model object to attach it, hold Alt for a free drag)' : ''}. Click a marker to select it.</p>`;
  if (ed.view.model) {
    const st = ed.stick;
    if (st) {
      const n = st.moves.length;
      out += `<section class="box stick"><p>${n ? `${n} marker${n === 1 ? '' : 's'} will move onto the nearest surface.` : 'Every pinned marker already sits on a surface.'}</p>
          <div class="row">${n ? '<button data-act="stick-apply" class="primary">Apply</button>' : ''}<button data-act="stick-cancel">${n ? 'Cancel' : 'OK'}</button></div></section>`;
    } else {
      out += '<div class="row"><button data-act="stick-all" title="Pinned markers floating more than 15 cm from the model move onto the nearest wall, ceiling or floor">Stick all to surfaces</button></div>';
    }
  }

  out += badgesHtml(ed);
  const unplaced = all.filter((x) => !hidden.includes(x.id) && !hidden.includes(x.entityId) && !(ed.card._positions || new Map()).has(x.id));
  out += `<div class="sub">Devices without a room (${unplaced.length})</div>`;
  if (unplaced.length) {
    out += '<ul class="list">';
    for (const x of unplaced) {
      out += `<li>${logoBox(ed, x.entityId)}<span class="name">${esc(x.name)}<span class="dim"> · ${x.areaId ? esc(areaName(ed.hass, x.areaId)) : 'no area'}</span></span>
          <button data-act="place" data-id="${esc(x.id)}">Place</button></li>`;
    }
    out += '</ul>';
  } else out += '<p class="dim">Every device is on the plan.</p>';

  out += `<div class="sub">Hidden (${hidden.length})</div>`;
  if (hidden.length) {
    out += '<ul class="list">';
    for (const id of hidden) {
      const x = byId.get(id) || all.find((y) => y.entityId === id);
      out += `<li>${logoBox(ed, x && x.entityId)}<span class="name">${esc(x ? x.name : id)}</span><button data-act="unhide" data-id="${esc(id)}">Unhide</button></li>`;
    }
    out += '</ul>';
  } else out += '<p class="dim">Nothing hidden.</p>';
  return out;
}

// "Stick all to surfaces": free pins more than 15 cm from every model surface (8 horizontal rays,
// up and down) move onto the surface their device type sticks to, else the nearest one (stickSurface).
export function stickMoves(ed: EditMode): StickMove[] {
  const vw = ed.view, out: StickMove[] = [];
  if (!vw.model) return out;
  const byId = new Map(allMarkers(ed).map((m) => [m.id, m])); // hidden ones included
  for (const [id, pin] of Object.entries(ed.layout.pins || {})) {
    const m = byId.get(id);
    if (!m || !pin || pin.attach || id === ed.card._mowerMarkerId) continue; // device gone: leave its pin alone
    const floor = ed.floors.find((f) => f.id === pin.floor_id) || ed.floors[0];
    const elev = vw.floorElevation(floor.id);
    const z = pin.z ?? 1.2;
    const world = worldOf({ x: pin.x, y: pin.y, z }, elev);
    const hits = surfaceSearch('all', z, floor.height).flatMap((g: { dirs: unknown; max: number }) => vw.surfaceRays(world, g.dirs, g.max));
    if (!needsStick(pin, nearestDistance(hits))) continue;
    const s = stickSurface(surfaceKind(m.domain, m.deviceClass), hits);
    if (s) out.push({ id, from: pin, pin: { ...planOf(s.point, elev), floor_id: floor.id, on_model: true } });
  }
  return out;
}

// A pin placed while a model is loaded sits on the model and follows its alignment.
export function onModel(ed: EditMode, id: string): boolean {
  const pin = (ed.layout.pins || {})[id];
  return !!ed.view.model || !!(pin && pin.on_model);
}

// the marker buttons show only with a marker selected
const selectedId = (ed: EditMode): string => ed.selectedMarker!;

const acts: Record<string, ActHandler> = {
  unpin: (ed) => { ed.commit(E.clearPin(ed.layout, selectedId(ed))); },
  'stick-all': (ed) => { ed.stick = { moves: stickMoves(ed) }; return 'render'; },
  'stick-cancel': (ed) => { ed.stick = null; return 'render'; },
  'stick-apply': (ed) => { // the previewed moves; a pin changed since then is left alone
    const moves = ed.stick ? ed.stick.moves : [];
    ed.stick = null;
    let layout = ed.layout;
    for (const mv of moves) if ((layout.pins || {})[mv.id] === mv.from) layout = E.setPin(layout, mv.id, mv.pin, { grid: false });
    if (layout === ed.layout) return 'render';
    ed.commit(layout);
  },
  detach: (ed) => { // keep where it is now, as a normal pin on the model
    const id = selectedId(ed);
    const pos = ed.card._positions && ed.card._positions.get(id);
    const pin: LayoutPin | undefined = (ed.layout.pins || {})[id];
    const at = pos ? { x: pos.x, y: pos.y, z: pos.z, floor_id: pos.floorId } : pin;
    if (at) ed.commit(E.setPin(ed.layout, id, { ...at, on_model: true }, { grid: false }));
  },
  hide: (ed) => {
    const mid = selectedId(ed);
    ed.selectMarker(null);
    ed.commit(E.hide(ed.layout, mid));
  },
  'deselect-marker': (ed) => { ed.selectMarker(null); },
  unhide: (ed, btn) => { ed.commit(E.unhide(ed.layout, btn.dataset.id || '')); },
  place: (ed, btn) => {
    const id = btn.dataset.id || '';
    const fid = ed.activeFloor();
    const t = ed.view.controls!.target; // the controls exist while the card is shown
    ed.selectedMarker = id;
    ed.commit(E.setPin(ed.layout, id, { x: t.x, y: -t.z, z: 1.2, floor_id: fid, on_model: onModel(ed, id) }));
  },
};

const fields: Record<string, FieldHandler> = {
  'tap-hints': (ed, el) => {
    const l: Layout = { ...ed.layout };
    if (el.value === 'near') delete l.tap_hints; else l.tap_hints = el.value;
    ed.commit(l);
  },
  'marker-z': (ed, el) => {
    const v = Number(el.value);
    const id = selectedId(ed);
    const pos = ed.card._positions!.get(id); // the height input shows only for a drawn marker
    if (!Number.isFinite(v) || !pos) return;
    const pin: LayoutPin | undefined = (ed.layout.pins || {})[id];
    if (pin && pin.attach && Array.isArray(pin.offset)) {
      // attached: raise / lower the offset; object missing: keep the attach, only the fallback height changes
      const o = pin.offset;
      const off = pos.attached ? [o[0], o[1] + v - pos.z, o[2]] : o;
      ed.commit(E.attachPin(ed.layout, id, pin.attach, off, { x: pin.x, y: pin.y, z: pos.attached ? Number(pin.z) + v - pos.z : v, floor_id: pin.floor_id }));
      return;
    }
    ed.commit(E.setPin(ed.layout, id, { x: pos.x, y: pos.y, z: v, floor_id: pos.floorId, on_model: onModel(ed, id) }, { grid: !pin }));
  },
  badge: (ed, el) => {
    ed.commit({ ...ed.layout, badges: { ...ed.layout.badges, [String(el.dataset.key)]: el.checked } });
    ed.render();
  },
};

export const devicesTabDef = defineTab({ id: 'devices', html: devicesTab, acts, fields });

