// Rooms tab: HA areas per floor with their drawn / model rooms, the selected room, floors without a model.

import * as E from '../../editor.ts';
import { areaName } from '../../registry.ts';
import { html, nothing } from 'lit/html.js';
import { classMap } from 'lit/directives/class-map.js';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';
import { act, field, fmt, options } from '../html.ts';
import { switchTab } from '../panel.ts';
import { startDrawing, finishDrawing, cancelDrawing } from '../tools/draw.ts';
import { startPicking, cancelPicking, usePickedOutline } from '../tools/pick-outline.ts';
import { refreshOverlay } from '../tools/handles.ts';
import type { TemplateResult } from 'lit/html.js';
import type { TabDef } from './tab.ts';
import type { View } from '../html.ts';
import type { EditMode } from '../../edit-mode.ts';
import type { HassArea } from '../../types/ha.ts';
import type { Layout, LayoutFloor, LayoutRoom } from '../../types/layout.ts';

export function sortedAreas(ed: EditMode): HassArea[] {
  const areas = Object.values(ed.hass.areas || {});
  return areas.sort((a, b) => a.name.localeCompare(b.name));
}

export function roomsTab(ed: EditMode): View {
  const d = ed.drawing;
  if (d) {
    return html`<section class="box">
        <h3>Drawing: ${areaName(ed.hass, d.areaId)}</h3>
        <p class="hint">Click the corners on the plan. Points snap to 5 cm and to existing corners, so shared walls line up.
        Click the first point or press Enter to finish, Backspace removes the last point, Esc cancels.</p>
        <p>${d.points.length} point${d.points.length === 1 ? '' : 's'}</p>
        <div class="row"><button ?disabled=${d.points.length < 3} class="primary" @click=${act(ed, () => finishDrawing(ed))}>Finish</button>
        <button ?disabled=${!d.points.length} @click=${act(ed, () => undoPoint(ed))}>Undo point</button>
        <button @click=${act(ed, () => cancelDrawing(ed))}>Cancel</button></div></section>`;
  }
  const pk = ed.picking;
  if (pk) {
    return html`<section class="box">
        <h3>Pick: ${areaName(ed.hass, pk.areaId)}</h3>
        ${pk.busy ? html`<p class="hint">Tracing…</p>` : pk.poly
    ? html`<p>${pk.poly.length} corners</p><div class="row"><button class="primary" @click=${act(ed, () => usePickedOutline(ed))}>Use this outline</button>
        <button @click=${act(ed, () => pickDraw(ed))}>Draw instead</button></div>`
    : html`<p class="hint">Click on this room's floor in the model.</p>`}
        <div class="row"><button @click=${act(ed, () => cancelPicking(ed))}>Cancel</button></div></section>`;
  }
  const rooms = ed.layout.rooms || [];
  const areas = sortedAreas(ed);
  const yamlLabels = ed.card._config && ed.card._config.room_labels;
  const rl = String(yamlLabels || ed.layout.room_labels || 'size');
  const byFloor = new Map<string, HassArea[]>(ed.floors.map((f) => [f.id, []]));
  const noFloor: HassArea[] = [];
  byFloor.set('', noFloor);
  for (const a of areas) ((a.floor_id && byFloor.get(a.floor_id)) || noFloor).push(a);
  const areaRow = (a: HassArea) => {
    const mr = (ed.card._modelRooms || []).find((x) => x.area_id === a.area_id);
    if (mr) {
      return html`<li><span class="name">${a.name}</span><span class="pill ok">model</span>
            <button @click=${act(ed, () => switchTab(ed, 'model'))}>Model</button></li>`;
    }
    const r = rooms.find((x) => x.area_id === a.area_id);
    return html`<li class=${classMap({ sel: !!r && r.id === ed.selectedRoom })}><span class="name">${a.name}</span>
          <span class="pill ${r ? 'ok' : 'missing'}">${r ? 'drawn' : 'missing'}</span>
          ${r ? html`<button @click=${act(ed, () => selectRoom(ed, r.id))}>Select</button>`
    : html`${ed.view.model ? html`<button @click=${act(ed, () => startPicking(ed, a.area_id))}>Pick</button>` : nothing}<button @click=${act(ed, () => startDrawing(ed, a.area_id))}>Draw</button>`}</li>`;
  };
  const floorLists = [...byFloor].filter(([, list]) => list.length).map(([fid, list]) => html`
      <div class="sub">${fid ? ed.floors.find((f) => f.id === fid)!.name : 'No floor'}</div>
      <ul class="list">${repeat(list, (a) => a.area_id, areaRow)}</ul>`); // the keys are ed.floors' ids
  const orphans = rooms.filter((r) => !r.area_id || !(ed.hass.areas || {})[r.area_id]);
  return html`${selectedRoomView(ed, areas)}
      <label class="room-labels">Room labels <select name="room-labels" ?disabled=${!!yamlLabels} title=${yamlLabels ? 'Set in the card YAML (room_labels)' : nothing}
        .value=${live(rl)} @change=${(e: Event) => setRoomLabels(ed, field(e).value)}>
        ${options([['size', 'Name and size'], ['name', 'Name only'], ['none', 'None']], rl)}</select></label>
      ${yamlLabels ? html`<p class="hint">Set in the card YAML (room_labels), which wins over this setting.</p>` : nothing}
      ${floorLists}
      ${orphans.length ? html`<div class="sub">Rooms without an HA area</div><ul class="list">${repeat(orphans, (r) => r.id, (r) => html`
        <li><span class="name">${r.area_id || r.id}</span><button @click=${act(ed, () => selectRoom(ed, r.id))}>Select</button></li>`)}</ul>` : nothing}
      ${areas.length ? nothing : html`<p class="hint">No areas in Home Assistant yet. Create areas under Settings → Areas.</p>`}
      ${ed.view.model ? nothing : floorsView(ed)}`; // floor heights come from the model when there is one
}

function selectedRoomView(ed: EditMode, areas: HassArea[]): View {
  const sel = ed.room(ed.selectedRoom);
  if (!sel) return nothing;
  const areaOpts: [string, string][] = areas.map((a) => [a.area_id, a.name]);
  if (sel.area_id && !areas.some((a) => a.area_id === sel.area_id)) areaOpts.unshift([sel.area_id, `${sel.area_id} (missing)`]);
  const fid = ed.floorOf(sel);
  return html`<section class="box">
        <h3>${areaName(ed.hass, sel.area_id)}</h3>
        <label>Area <select name="room-area" .value=${live(sel.area_id || '')} @change=${(e: Event) => setRoomArea(ed, field(e).value)}>${options(areaOpts, sel.area_id)}</select></label>
        <label>Floor <select name="room-floor" .value=${live(fid)} @change=${(e: Event) => setRoomFloor(ed, field(e).value)}>${options(ed.floors.map((f) => [f.id, f.name]), fid)}</select></label>
        <label class="check"><input type="checkbox" name="room-outdoor" .checked=${live(!!sel.outdoor)} @change=${(e: Event) => setRoomOutdoor(ed, field(e).checked)}> Outdoor (no walls)</label>
        <div class="sub">Doors</div>
        <ul class="plain">${(sel.doors || []).length ? (sel.doors || []).map((p, i) => html`<li>Door ${i + 1} <span class="dim">(${fmt(p[0])}, ${fmt(p[1])})</span>
          <button class="link" @click=${act(ed, () => delDoor(ed, i))}>Remove</button></li>`) : html`<li class="dim">No doors</li>`}</ul>
        <button class=${classMap({ primary: ed.doorMode })} @click=${act(ed, () => { ed.doorMode = !ed.doorMode; })}>${ed.doorMode ? 'Click a wall on the plan…' : 'Add door'}</button>
        <p class="hint">Drag corners to reshape. Drag an edge midpoint to add a corner, right-click a corner to delete it.</p>
        <div class="row">
          <button class="danger" @click=${act(ed, () => deleteRoom(ed))}>${ed.confirmDelete ? 'Really delete?' : 'Delete room'}</button>
          <button @click=${act(ed, () => ed.selectRoom(null))}>Done</button>
        </div></section>`;
}

// Advanced: the floors table for model-less layouts
function floorsView(ed: EditMode): TemplateResult {
  const stored = new Set((ed.layout.floors || []).map((f) => f.id));
  const haFloors = new Set(Object.keys(ed.hass.floors || {}));
  return html`<details class="advanced" ?open=${ed._advancedOpen} @toggle=${(e: Event) => { ed._advancedOpen = (e.target as HTMLDetailsElement).open; }}><summary>Advanced (no model)</summary>
      <div class="sub">Floors</div><table class="floors"><tr><th></th><th>Elevation m</th><th>Height m</th><th></th></tr>
      ${repeat(ed.floors, (f) => f.id, (f) => html`<tr><td>${f.name}</td>
        <td><input type="number" step="0.05" name="floor-elevation" data-id=${f.id} .value=${fmt(f.elevation)} @change=${(e: Event) => setFloorProp(ed, f.id, 'elevation', field(e).value)}></td>
        <td><input type="number" step="0.05" min="0.5" name="floor-height" data-id=${f.id} .value=${fmt(f.height)} @change=${(e: Event) => setFloorProp(ed, f.id, 'height', field(e).value)}></td>
        <td>${!haFloors.has(f.id) && stored.has(f.id) ? html`<button class="link" @click=${act(ed, () => ed.commit(E.deleteFloor(ed.layout, f.id)))}>Remove</button>` : nothing}</td></tr>`)}
      </table><p class="hint">Floors come from Home Assistant (Settings → Areas → Floors). Add one here only for a level HA doesn't have.</p>
      <button @click=${act(ed, () => addFloor(ed))}>Add floor</button></details>`;
}

const selected = (ed: EditMode) => ed.room(ed.selectedRoom);

// ---------- handlers ----------
export function undoPoint(ed: EditMode) {
  if (ed.drawing) ed.drawing.points.pop();
  refreshOverlay(ed);
}

export function pickDraw(ed: EditMode) {
  const a = ed.picking && ed.picking.areaId;
  ed.picking = null;
  if (a) startDrawing(ed, a);
}

export function selectRoom(ed: EditMode, id: string) {
  const r = ed.room(id);
  const fid = r && ed.floorOf(r);
  if (fid && ed.card._floor !== fid) ed.card._setFloor(fid);
  ed.selectRoom(id);
}

export function delDoor(ed: EditMode, i: number) {
  const sel = selected(ed);
  if (sel) ed.commit(E.upsertRoom(ed.layout, E.removeDoor(sel, i)));
}

export function deleteRoom(ed: EditMode) {
  const sel = selected(ed);
  if (!sel) return; // the room went away (rebuild) while the button was shown
  if (!ed.confirmDelete) { ed.confirmDelete = true; return; }
  ed.confirmDelete = false;
  ed.selectedRoom = null;
  ed.commit(E.deleteRoom(ed.layout, sel.id));
}

export function addFloor(ed: EditMode) {
  const top = ed.floors[ed.floors.length - 1];
  const fid = E.newFloorId(ed.layout, ed.floors);
  ed.commit(E.upsertFloor(ed.layout, { id: fid, name: 'Floor ' + (ed.floors.length + 1), elevation: top ? top.elevation + 3 : 0, height: 2.7 }));
}

export function setFloorProp(ed: EditMode, id: string, key: 'elevation' | 'height', value: string) {
  const v = Number(value);
  if (!Number.isFinite(v)) return;
  const floor = ed.floors.find((x) => x.id === id);
  if (!floor) return; // rows are rendered from ed.floors
  const stored = (ed.layout.floors || []).some((x) => x.id === floor.id);
  const patch: LayoutFloor = { id: floor.id, [key]: v };
  if (!stored) Object.assign(patch, { name: floor.name });
  ed.commit(E.upsertFloor(ed.layout, patch));
}

export function setRoomArea(ed: EditMode, areaId: string) {
  const sel = selected(ed);
  if (sel) ed.commit(E.upsertRoom(ed.layout, { ...sel, area_id: areaId }));
}

export function setRoomOutdoor(ed: EditMode, outdoor: boolean) {
  const sel = selected(ed);
  if (sel) ed.commit(E.upsertRoom(ed.layout, { ...sel, outdoor }));
}

export function setRoomLabels(ed: EditMode, v: string) {
  const l: Layout = { ...ed.layout };
  if (v === 'size') delete l.room_labels; else l.room_labels = v;
  ed.commit(l);
}

export function setRoomFloor(ed: EditMode, fid: string) {
  const sel = selected(ed);
  if (!sel) return;
  const area = ed.hass.areas && sel.area_id ? ed.hass.areas[sel.area_id] : undefined;
  const next: LayoutRoom = { ...sel, floor_id: fid };
  if (area && area.floor_id === fid) delete next.floor_id;
  ed.card._setFloor(fid);
  ed.commit(E.upsertRoom(ed.layout, next));
}

export const roomsTabDef: TabDef = { id: 'rooms', label: 'Rooms', view: roomsTab };
