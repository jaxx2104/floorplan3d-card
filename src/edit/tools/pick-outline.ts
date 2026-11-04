// "Pick" a room outline from the model: the floor piece under a click is traced (cached per piece and height).

import * as E from '../../editor.ts';
import { areaName } from '../../registry.ts';
import { outlineLoops, pickLoop, rasterGrid, outlineFromGrid } from '../../outline.ts';
import { refreshOverlay } from './handles.ts';
import type { Mesh } from 'three';
import type { EditMode, OutlineEntry } from '../../edit-mode.ts';
import type { LayoutRoom, PlanPoint } from '../../types/layout.ts';

const DENSE_TRIS = 150000;

// ---------- pick a room's outline from the model ----------
export function startPicking(ed: EditMode, areaId: string) {
  ed.selectedRoom = null;
  ed.selectedMarker = null;
  ed.card._applyMarkerSelection(null);
  ed.picking = { areaId, busy: false, poly: null };
  ed.tab = 'rooms';
  ed.message = null;
  refreshOverlay(ed);
  ed.render();
}

export function cancelPicking(ed: EditMode) {
  ed.picking = null;
  refreshOverlay(ed);
  ed.render();
}

export function pickRoom(ed: EditMode, e: PointerEvent) {
  const pk = ed.picking;
  if (!pk) return; // the 'pick-room' route: set
  if (pk.busy) return;
  const owner = ed.view.pickModel(e.clientX, e.clientY);
  if (!owner) {
    ed.message = { text: "Click on a room's floor", warn: true };
    ed.render();
    return;
  }
  if (owner.kind === 'room' || owner.kind === 'zone') {
    const cur = ed.layout.model || {};
    ed.picking = null;
    ed.message = { text: `Linked ${owner.label || owner.id} to ${areaName(ed.hass, pk.areaId)}` };
    ed.setModelProps({ rooms: { ...cur.rooms, [owner.id]: { ...(cur.rooms || {})[owner.id], area: pk.areaId } } });
    refreshOverlay(ed);
    return;
  }
  if (owner.hit.up === false) {
    ed.message = { text: "Click on a room's floor", warn: true };
    ed.render();
    return;
  }
  pk.busy = true;
  pk.poly = null;
  ed.message = { text: 'Tracing…' };
  ed.render();
  const mesh: Mesh = owner.hit.object, hit: number[] = owner.hit.point;
  setTimeout(() => {
    if (ed.picking !== pk) return;
    pk.busy = false;
    try {
      const r = ed._traceOutline(mesh, hit);
      pk.poly = r.poly;
      pk.floorId = ed.activeFloor();
      ed.message = r.note ? { text: r.note, warn: true } : null;
    } catch (err) {
      ed.message = { text: `Could not trace this floor: ${(err as Error).message}`, error: true };
    }
    refreshOverlay(ed);
    ed.render();
  }, 0);
}

// all loops (or the raster grid for dense meshes) are cached per floor piece and height; each click then
// only picks a loop. Fallback: the mesh's bounding rectangle.
export function traceOutline(ed: EditMode, mesh: Mesh, hit: number[]): { poly: PlanPoint[]; note?: string } {
  const model = ed.view.model;
  // loops are in card world: a new model or a new alignment invalidates them
  const placed = JSON.stringify(ed.card._modelAlign());
  if (ed._outlineModel !== model || ed._outlineAlign !== placed) {
    ed._outlineCache.clear();
    ed._outlineModel = model;
    ed._outlineAlign = placed;
  }
  const b = Math.round(hit[1] / 0.05);
  const key = (n: number) => mesh.uuid + ':' + n;
  let entry: OutlineEntry | null | undefined = null;
  for (const n of [b, b - 1, b + 1]) { entry = ed._outlineCache.get(key(n)); if (entry) break; }
  if (!entry) {
    const tris = ed.view.meshTriangles(mesh);
    entry = tris.length / 9 > DENSE_TRIS ? { grid: rasterGrid(tris, hit[1]) } : { loops: outlineLoops(tris, hit[1]) };
    ed._outlineCache.set(key(b), entry);
  }
  const poly = entry.grid ? outlineFromGrid(entry.grid, hit) : entry.loops ? pickLoop(entry.loops, [hit[0], -hit[2]]) : null;
  return poly ? { poly } : { poly: ed.view.meshPlanRect(mesh), note: "Used the floor piece's bounding rectangle — reshape it if needed" };
}

export function usePickedOutline(ed: EditMode) {
  const pk = ed.picking;
  if (!pk || !pk.poly) return;
  const room: LayoutRoom = { id:
 E.newRoomId(ed.layout), area_id: pk.areaId, polygon: pk.poly, doors: [], outdoor: false, floor_id: pk.floorId || ed.activeFloor() };
  ed.picking = null;
  ed.selectedRoom = room.id;
  ed.commit(E.upsertRoom(ed.layout, room));
}
