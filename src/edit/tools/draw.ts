// Drawing a room: click corners (snapped to the grid and to existing corners), finish, cancel.

import * as E from '../../editor.ts';
import { refreshOverlay } from './handles.ts';
import type { EditMode } from '../../edit-mode.ts';
import type { SnapResult } from '../../editor.ts';
import type { LayoutRoom, PlanPoint } from '../../types/layout.ts';

// ---------- drawing ----------
export function startDrawing(ed: EditMode, areaId: string) {
  const area = ed.hass.areas && ed.hass.areas[areaId];
  // the floor shown on its own (or the view's only floor), else the area's floor, else the active floor
  const st = ed.card._viewState;
  const single = ed.card._floorOnly || (st && !st.allFloors && st.floors.length === 1 ? st.floors[0] : null);
  let floorId = single && ed.floors.some((f) => f.id === single) ? single : null;
  if (!floorId) floorId = area && area.floor_id && ed.floors.some((f) => f.id === area.floor_id) ? area.floor_id : ed.activeFloor();
  if (floorId !== ed.card._floor) ed.card._setFloor(floorId);
  if (ed.card._mode !== 'top') ed.card._setMode('top');
  ed.selectedRoom = null;
  ed.selectedMarker = null;
  ed.card._applyMarkerSelection(null);
  ed.drawing = { areaId, floorId, points: [], cursor: null };
  ed.tab = 'rooms';
  ed._syncStageClasses();
  refreshOverlay(ed);
  ed.render();
}

export function snapDraw(ed: EditMode, p: PlanPoint): SnapResult {
  const d = ed.drawing!; // only called while drawing
  const vertices = [
    ...E.floorVertices(ed.layout.rooms, (r) => ed.floorOf(r), d.floorId),
    ...d.points,
  ];
  return E.snapPoint(p, { vertices, radius: ed.snapRadius() });
}

export function addDrawPoint(ed: EditMode, p: PlanPoint) {
  const d = ed.drawing!; // planClick: only while drawing
  const s = snapDraw(ed, p).point;
  const first = d.points[0];
  if (d.points.length >= 3 && Math.hypot(s[0] - first[0], s[1] - first[1]) <= ed.snapRadius()) {
    finishDrawing(ed);
    return;
  }
  d.points.push(s);
  refreshOverlay(ed);
  ed.render();
}

export function finishDrawing(ed: EditMode) {
  const d = ed.drawing;
  if (!d) return;
  const polygon = E.cleanPolygon(d.points);
  if (polygon.length < 3) return;
  const area = ed.hass.areas && ed.hass.areas[d.areaId];
  const room: LayoutRoom = { id: E.newRoomId(ed.layout), area_id: d.areaId, polygon, doors: [], outdoor: false };
  // only store the floor when it differs from the area's, so HA floor changes follow through
  if (!area || area.floor_id !== d.floorId) room.floor_id = d.floorId;
  ed.drawing = null;
  ed._syncStageClasses();
  ed.selectedRoom = room.id;
  ed.commit(E.upsertRoom(ed.layout, room));
}

export function cancelDrawing(ed: EditMode) {

  ed.drawing = null;
  ed._syncStageClasses();
  refreshOverlay(ed);
  ed.render();
}
