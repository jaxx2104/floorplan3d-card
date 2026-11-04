// Overlay of the edit tools on the plan: the selected room, the picked outline, the drawing, and their
// drag handles (one element per key, reused across refreshes).

import * as E from '../../editor.ts';
import { vertexDown, midDown } from './drag.ts';
import type { EditMode } from '../../edit-mode.ts';
import type { LayoutRoom, PlanPoint } from '../../types/layout.ts';

interface OverlayLine { points: PlanPoint[]; closed: boolean; floorId: string; color: number }
interface OverlayFill { points: PlanPoint[]; floorId: string; color: number; opacity: number }
interface OverlayHandle { element: HTMLDivElement; x: number; y: number; floorId: string }

// ---------- overlay ----------
export function handleEl(ed: EditMode, key: string, cls: string): HTMLDivElement {
  let el = ed._handles.get(key);
  if (!el) {
    el = document.createElement('div');
    ed._handles.set(key, el);
  }
  el.className = 'fp-handle ' + cls;
  return el;
}

export function refreshOverlay(ed: EditMode, preview?: LayoutRoom) {
  if (!ed.view) return;
  ed._syncStageClasses();
  const color = ed.card._built.theme ? ed.card._built.theme.primary : 0x03a9f4;
  const lines: OverlayLine[] = [], fills: OverlayFill[] = [], handles: OverlayHandle[] = [];
  const used = new Set<string>();
  const handle = (key: string, cls: string, x: number, y: number, floorId: string, setup?: (e: PointerEvent, el: HTMLDivElement) => void) => {
    const el = handleEl(ed, key, cls);
    used.add(key);
    el.onpointerdown = setup ? (e) => setup(e, el) : null;
    el.oncontextmenu = null;
    handles.push({ element: el, x, y, floorId });
    return el;
  };

  const room = preview || ed.room(ed.selectedRoom);
  if (room && room.polygon) {
    const fid = ed.floorOf(room);
    fills.push({ points: room.polygon, floorId: fid, color, opacity: 0.16 });
    lines.push({ points: room.polygon, closed: true, floorId: fid, color });
    room.polygon.forEach(([x, y], i) => {
      const el = handle('v' + i, 'vertex', x, y, fid, (e) => vertexDown(ed, e, room.id, i));
      el.title = 'Drag to move, right-click to delete';
      el.oncontextmenu = (e) => {
        e.preventDefault();
        const r = ed.room(room.id);
        if (r) ed.commit(E.upsertRoom(ed.layout, E.removeVertex(r, i)));
      };
    });
    if (!ed.drag) {
      room.polygon.forEach((a, i) => {
        const b = room.polygon[(i + 1) % room.polygon.length];
        const el = handle('m' + i, 'mid', (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, fid, (e) => midDown(ed, e, room.id, i));

        el.title = 'Drag to add a corner';
      });
    }
    (room.doors || []).forEach(([x, y], i) => handle('d' + i, 'door', x, y, fid));
  }

  const pk = ed.picking;
  if (pk && pk.poly) {
    const fid = pk.floorId || ed.activeFloor();
    fills.push({ points: pk.poly, floorId: fid, color, opacity: 0.25 });
    lines.push({ points: pk.poly, closed: true, floorId: fid, color });
  }

  const d = ed.drawing;
  if (d) {
    const pts = d.cursor ? [...d.points, d.cursor.point] : d.points;
    lines.push({ points: pts, closed: false, floorId: d.floorId, color });
    d.points.forEach(([x, y], i) => handle('p' + i, i === 0 && d.points.length >= 3 ? 'draw first' : 'draw', x, y, d.floorId));
    if (d.cursor) handle('cursor', 'cursor ' + d.cursor.kind, d.cursor.point[0], d.cursor.point[1], d.floorId);
  }

  for (const k of [...ed._handles.keys()]) if (!used.has(k)) ed._handles.delete(k);
  ed.view.setOverlay({ lines, fills, handles });
}
