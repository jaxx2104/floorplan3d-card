// Rooms tab: HA areas per floor with their drawn / model rooms, the selected room, floors without a model.

import * as E from '../../editor.js';
import { areaName } from '../../registry.js';
import { esc, fmt } from '../html.js';
import { startDrawing, finishDrawing, cancelDrawing } from '../tools/draw.js';
import { startPicking, cancelPicking, usePickedOutline } from '../tools/pick-outline.js';
import { refreshOverlay } from '../tools/handles.js';

export function sortedAreas(ed) {
  const areas = Object.values(ed.hass.areas || {});
  return areas.sort((a, b) => a.name.localeCompare(b.name));
}

export function roomsTab(ed) {
  const d = ed.drawing;
  if (d) {
    return `<section class="box">
        <h3>Drawing: ${esc(areaName(ed.hass, d.areaId))}</h3>
        <p class="hint">Click the corners on the plan. Points snap to 5 cm and to existing corners, so shared walls line up.
        Click the first point or press Enter to finish, Backspace removes the last point, Esc cancels.</p>
        <p>${d.points.length} point${d.points.length === 1 ? '' : 's'}</p>
        <div class="row"><button data-act="finish" ${d.points.length < 3 ? 'disabled' : ''} class="primary">Finish</button>
        <button data-act="undo-point" ${d.points.length ? '' : 'disabled'}>Undo point</button>
        <button data-act="cancel-draw">Cancel</button></div></section>`;
  }
  const pk = ed.picking;
  if (pk) {
    return `<section class="box">
        <h3>Pick: ${esc(areaName(ed.hass, pk.areaId))}</h3>
        ${pk.busy ? '<p class="hint">Tracing…</p>' : pk.poly
  ? `<p>${pk.poly.length} corners</p><div class="row"><button data-act="pick-use" class="primary">Use this outline</button>
        <button data-act="pick-draw">Draw instead</button></div>`
  : "<p class=\"hint\">Click on this room's floor in the model.</p>"}
        <div class="row"><button data-act="pick-cancel">Cancel</button></div></section>`;
  }
  const sel = ed.room(ed.selectedRoom);
  const rooms = ed.layout.rooms || [];
  const areas = sortedAreas(ed);
  let out = '';
  if (sel) {
    const areaOpts = areas.map((a) => `<option value="${esc(a.area_id)}" ${a.area_id === sel.area_id ? 'selected' : ''}>${esc(a.name)}</option>`);
    if (sel.area_id && !areas.some((a) => a.area_id === sel.area_id)) areaOpts.unshift(`<option selected value="${esc(sel.area_id)}">${esc(sel.area_id)} (missing)</option>`);
    const fid = ed.floorOf(sel);
    const floorOpts = ed.floors.map((f) => `<option value="${esc(f.id)}" ${f.id === fid ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
    const doors = (sel.doors || []).map((p, i) => `<li>Door ${i + 1} <span class="dim">(${fmt(p[0])}, ${fmt(p[1])})</span> <button class="link" data-act="del-door" data-i="${i}">Remove</button></li>`).join('');
    out += `<section class="box">
        <h3>${esc(areaName(ed.hass, sel.area_id))}</h3>
        <label>Area <select data-field="room-area">${areaOpts.join('')}</select></label>
        <label>Floor <select data-field="room-floor">${floorOpts}</select></label>
        <label class="check"><input type="checkbox" data-field="room-outdoor" ${sel.outdoor ? 'checked' : ''}> Outdoor (no walls)</label>
        <div class="sub">Doors</div>
        <ul class="plain">${doors || '<li class="dim">No doors</li>'}</ul>
        <button data-act="door-mode" class="${ed.doorMode ? 'primary' : ''}">${ed.doorMode ? 'Click a wall on the plan…' : 'Add door'}</button>
        <p class="hint">Drag corners to reshape. Drag an edge midpoint to add a corner, right-click a corner to delete it.</p>
        <div class="row">
          <button data-act="delete-room" class="danger">${ed.confirmDelete ? 'Really delete?' : 'Delete room'}</button>
          <button data-act="deselect">Done</button>
        </div></section>`;
  }

  const yamlLabels = ed.card._config && ed.card._config.room_labels;
  const rl = yamlLabels || ed.layout.room_labels || 'size';
  out += `<label class="room-labels">Room labels <select data-field="room-labels" ${yamlLabels ? 'disabled title="Set in the card YAML (room_labels)"' : ''}>
      ${[['size', 'Name and size'], ['name', 'Name only'], ['none', 'None']].map(([v, t]) => `<option value="${v}" ${v === rl ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      ${yamlLabels ? '<p class="hint">Set in the card YAML (room_labels), which wins over this setting.</p>' : ''}`;
  const byFloor = new Map(ed.floors.map((f) => [f.id, []]));
  byFloor.set('', []);
  for (const a of areas) (byFloor.get(a.floor_id) || byFloor.get('')).push(a);
  for (const [fid, list] of byFloor) {
    if (!list.length) continue;
    const fname = fid ? ed.floors.find((f) => f.id === fid).name : 'No floor';
    out += `<div class="sub">${esc(fname)}</div><ul class="list">`;
    for (const a of list) {
      const mr = (ed.card._modelRooms || []).find((x) => x.area_id === a.area_id);
      if (mr) {
        out += `<li><span class="name">${esc(a.name)}</span><span class="pill ok">model</span>
            <button data-act="tab" data-id="model">Model</button></li>`;
        continue;
      }
      const r = rooms.find((x) => x.area_id === a.area_id);
      out += `<li class="${r && r.id === ed.selectedRoom ? 'sel' : ''}"><span class="name">${esc(a.name)}</span>
          <span class="pill ${r ? 'ok' : 'missing'}">${r ? 'drawn' : 'missing'}</span>
          ${r ? `<button data-act="select-room" data-id="${esc(r.id)}">Select</button>` : `${ed.view.model ? `<button data-act="pick" data-id="${esc(a.area_id)}">Pick</button>` : ''}<button data-act="draw" data-id="${esc(a.area_id)}">Draw</button>`}</li>`;
    }
    out += '</ul>';
  }
  const orphans = rooms.filter((r) => !(ed.hass.areas || {})[r.area_id]);
  if (orphans.length) {
    out += '<div class="sub">Rooms without an HA area</div><ul class="list">';
    for (const r of orphans) out += `<li><span class="name">${esc(r.area_id || r.id)}</span><button data-act="select-room" data-id="${esc(r.id)}">Select</button></li>`;
    out += '</ul>';
  }
  if (!areas.length) out += '<p class="hint">No areas in Home Assistant yet. Create areas under Settings → Areas.</p>';

  // floor heights come from the model when there is one; the table is for model-less layouts
  if (ed.view.model) return out;
  const stored = new Set((ed.layout.floors || []).map((f) => f.id));
  const haFloors = new Set(Object.keys(ed.hass.floors || {}));
  out += `<details class="advanced" ${ed._advancedOpen ? 'open' : ''}><summary>Advanced (no model)</summary>
      <div class="sub">Floors</div><table class="floors"><tr><th></th><th>Elevation m</th><th>Height m</th><th></th></tr>`;
  for (const f of ed.floors) {
    out += `<tr><td>${esc(f.name)}</td>
        <td><input type="number" step="0.05" data-field="floor-elevation" data-id="${esc(f.id)}" value="${fmt(f.elevation)}"></td>
        <td><input type="number" step="0.05" min="0.5" data-field="floor-height" data-id="${esc(f.id)}" value="${fmt(f.height)}"></td>
        <td>${!haFloors.has(f.id) && stored.has(f.id) ? `<button class="link" data-act="del-floor" data-id="${esc(f.id)}">Remove</button>` : ''}</td></tr>`;
  }
  out += `</table><p class="hint">Floors come from Home Assistant (Settings → Areas → Floors). Add one here only for a level HA doesn't have.</p>
      <button data-act="add-floor">Add floor</button></details>`;
  return out;
}

const selected = (ed) => ed.room(ed.selectedRoom);

const acts = {
  draw: (ed, btn) => { startDrawing(ed, btn.dataset.id); },
  pick: (ed, btn) => { startPicking(ed, btn.dataset.id); },
  'pick-cancel': (ed) => { cancelPicking(ed); },
  'pick-use': (ed) => { usePickedOutline(ed); },
  'pick-draw': (ed) => { const a = ed.picking && ed.picking.areaId; ed.picking = null; if (a) startDrawing(ed, a); },
  finish: (ed) => { finishDrawing(ed); },
  'undo-point': (ed) => { ed.drawing.points.pop(); refreshOverlay(ed); return 'render'; },
  'cancel-draw': (ed) => { cancelDrawing(ed); },
  'select-room': (ed, btn) => {
    const id = btn.dataset.id;
    const r = ed.room(id);
    const fid = r && ed.floorOf(r);
    if (fid && ed.card._floor !== fid) ed.card._setFloor(fid);
    ed.selectRoom(id);
  },
  deselect: (ed) => { ed.selectRoom(null); },
  'door-mode': (ed) => { ed.doorMode = !ed.doorMode; ed._syncStageClasses(); return 'render'; },
  'del-door': (ed, btn) => {
    const sel = selected(ed);
    if (sel) ed.commit(E.upsertRoom(ed.layout, E.removeDoor(sel, Number(btn.dataset.i))));
  },
  'delete-room': (ed) => {
    const sel = selected(ed);
    if (!ed.confirmDelete) { ed.confirmDelete = true; return 'render'; }
    ed.confirmDelete = false;
    ed.selectedRoom = null;
    ed.commit(E.deleteRoom(ed.layout, sel.id));
  },
  'add-floor': (ed) => {
    const top = ed.floors[ed.floors.length - 1];
    const fid = E.newFloorId(ed.layout, ed.floors);
    ed.commit(E.upsertFloor(ed.layout, { id: fid, name: 'Floor ' + (ed.floors.length + 1), elevation: top ? top.elevation + 3 : 0, height: 2.7 }));
  },
  'del-floor': (ed, btn) => { ed.commit(E.deleteFloor(ed.layout, btn.dataset.id)); },
};

function floorField(ed, el) {
  const f = el.dataset.field;
  const v = Number(el.value);
  if (!Number.isFinite(v)) return;
  const floor = ed.floors.find((x) => x.id === el.dataset.id);
  const stored = (ed.layout.floors || []).some((x) => x.id === floor.id);
  const patch = { id: floor.id, [f === 'floor-elevation' ? 'elevation' : 'height']: v };
  if (!stored) Object.assign(patch, { name: floor.name });
  ed.commit(E.upsertFloor(ed.layout, patch));
}

const fields = {
  'room-area': (ed, el) => {
    const sel = selected(ed);
    if (sel) ed.commit(E.upsertRoom(ed.layout, { ...sel, area_id: el.value }));
  },
  'room-outdoor': (ed, el) => {
    const sel = selected(ed);
    if (sel) ed.commit(E.upsertRoom(ed.layout, { ...sel, outdoor: el.checked }));
  },
  'room-labels': (ed, el) => {
    const l = { ...ed.layout };
    if (el.value === 'size') delete l.room_labels; else l.room_labels = el.value;
    ed.commit(l);
  },
  'room-floor': (ed, el) => {
    const sel = selected(ed);
    if (!sel) return;
    const area = ed.hass.areas && ed.hass.areas[sel.area_id];
    const next = { ...sel, floor_id: el.value };
    if (area && area.floor_id === el.value) delete next.floor_id;
    ed.card._setFloor(el.value);
    ed.commit(E.upsertRoom(ed.layout, next));
  },
  'floor-elevation': floorField,
  'floor-height': floorField,
};

export const roomsTabDef = { id: 'rooms', html: roomsTab, acts, fields };
