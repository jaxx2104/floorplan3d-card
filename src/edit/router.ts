// Pointer and key routing on the plan in edit mode: which armed tool gets a click or a key.

import * as E from '../editor.ts';
import { pointInPolygon, signedArea } from '../placement.ts';
import { cancelPicking, pickRoom } from './tools/pick-outline.ts';
import { snapDraw, addDrawPoint, finishDrawing, cancelDrawing } from './tools/draw.ts';
import { mower, setMower } from './tabs/mower.ts';
import { cancelAlign, alignClick, pickMowerColor, pickMapColor } from './tools/map-tools.ts';
import { refreshOverlay } from './tools/handles.ts';
import { startWindowDrag } from './tools/drag.ts';
import { cancelPivot, setPivot } from './tools/pivot.ts';
import { pickView, closeMenu } from './tools/view-menu.ts';
import type { EditMode } from '../edit-mode.ts';
import type { PlanPoint } from '../types/layout.ts';

export type ClickRoute = 'pivot' | 'align' | 'color' | 'calibrate' | 'pick-room' | 'objects' | 'views' | 'model' | 'plan';
export type KeyRoute =
  | { kind: 'menu' | 'pivot' | 'pick' | 'draw-finish' | 'draw-cancel' | 'draw-undo' }
  | { kind: 'esc'; step: 'colorPick' | 'aligning' | 'doorMode' | 'selectedRoom' | 'selectedMarker' | null };
type PointerPos = { clientX: number; clientY: number };

export const CLICK_SLOP_PX = 5;

// ---------- plan pointer events (from the card's canvas listeners) ----------
export function canvasDown(ed: EditMode, e: PointerEvent) {
  ed._down = e.button === 0 ? [e.clientX, e.clientY] : null;
}

export function canvasMove(ed: EditMode, e: PointerEvent) {
  if (!ed.drawing) return;
  const p = planPoint(ed, e, ed.drawing.floorId);
  if (!p) return;
  ed.drawing.cursor = snapDraw(ed, p);
  refreshOverlay(ed);
}

export function canvasUp(ed: EditMode, e: PointerEvent) {
  const d = ed._down;
  ed._down = null;
  if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) >= CLICK_SLOP_PX) return;
  click(ed, e);
}

// Plan point under the pointer at the map overlay's height (it lies on the lawn, not on the HA floor).
export function mapPoint(ed: EditMode, e: PointerPos): PlanPoint | null {
  const pl = ed.view.mapPlane;
  const h = pl ? pl.position.y : ed.view.floorElevation(ed.card._mowerFloor());
  return ed.view.planPoint(e.clientX, e.clientY, h);
}

export function planPoint(ed: EditMode, e: PointerPos, floorId: string, z = 0): PlanPoint | null {
  return ed.view.planPoint(e.clientX, e.clientY, ed.view.floorElevation(floorId) + z);
}

// Which tool a click on the plan goes to; the order is the precedence (the first armed tool wins).
// 'plan': drawing adds a point, the door tool adds a door, else the smallest room under it is selected.
export function clickRoute(ed: EditMode): ClickRoute {
  if (ed.pivoting) return 'pivot';
  if (ed.aligning) return 'align';
  if (ed.colorPick) return 'color';
  if (ed.calibrating) return 'calibrate';
  if (ed.picking && !ed.drawing) return 'pick-room';
  if (ed.tab === 'objects' && ed.view.model && !ed.drawing) return 'objects'; // object taps: the card's gesture
  if (ed.tab === 'views' && ed.view.model && !ed.drawing) return 'views';
  if (ed.tab === 'model' && ed.view.model && !ed.drawing) return 'model';
  return 'plan';
}

export function click(ed: EditMode, e: PointerEvent) {
  switch (clickRoute(ed)) {
    case 'pivot': setPivot(ed, e); return;
    case 'align': alignClick(ed, e); return;
    case 'color': {
      // the clicked map pixel: the ray hits the overlay plane, its uv is the image position
      const hit = ed.view.mapHit(e.clientX, e.clientY);
      if (!hit) { ed.message = { text: 'Click on the map image.', error: true }; ed.render(); return; }
      const kind = ed.colorPick;
      ed.colorPick = false;
      ed._syncStageClasses();
      if (kind === true) pickMowerColor(ed, hit.u, 1 - hit.v);
      else if (kind) pickMapColor(ed, kind, hit.u, 1 - hit.v); // the 'color' route: colorPick is set
      return;
    }
    case 'calibrate': {
      const p = planPoint(ed, e, ed.card._mowerFloor());
      if (!p) return;
      const plan = E.snapPoint(p, { radius: 0 }).point;
      const { src } = ed.calibrating!; // the 'calibrate' route: set
      ed.calibrating = null;
      setMower(ed, { calibration: [...(mower(ed).calibration || []), { src, plan }] });
      return;
    }
    case 'pick-room': pickRoom(ed, e); return;
    case 'objects': return;
    case 'views': pickView(ed, e); return;
    case 'model': {
      const owner = ed.view.pickModel(e.clientX, e.clientY);
      ed.modelPick = owner ? (owner.kind === 'untagged' ? { kind: 'untagged', path: owner.path } : { kind: owner.kind, id: owner.id }) : null;
      ed.view.highlightModelNode(owner ? owner.node : null);
      ed.render();
      const row = ed.panel.querySelector('tr.sel');
      if (row) row.scrollIntoView({ block: 'nearest' });
      return;
    }
    default: planClick(ed, e);
  }
}

function planClick(ed: EditMode, e: PointerEvent) {
  const fid = ed.drawing ? ed.drawing.floorId : ed.activeFloor();
  const p = planPoint(ed, e, fid);
  if (!p) return;
  if (ed.drawing) {
    addDrawPoint(ed, p);
    return;
  }
  const sel = ed.room(ed.selectedRoom);
  if (ed.doorMode && sel) {
    const next = E.addDoor(sel, p, Math.max(0.6, ed.snapRadius()));
    if (next !== sel) {
      ed.doorMode = false;
      ed.commit(E.upsertRoom(ed.layout, next));
    }
    return;
  }
  // pick the smallest room under the click, so a room wins over the garden around it
  const hits = (ed.layout.rooms || [])
    .filter((r) => ed.floorOf(r) === fid && r.polygon && pointInPolygon(p, r.polygon))
    .sort((a, b) => Math.abs(signedArea(a.polygon)) - Math.abs(signedArea(b.polygon)));
  ed.selectRoom(hits.length ? hits[0].id : null);
}

// What a key does, in precedence order. null: ignored (typing in a field, or a key the armed tool
// doesn't use). 'esc' carries the step of the Esc cascade (null: nothing to undo; still re-rendered).
export function keyRoute(ed: EditMode, key: string, target: { tagName?: string } | null | undefined): KeyRoute | null {
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(String(target.tagName))) return null;
  if (ed.menu && key === 'Escape') return { kind: 'menu' };
  if (ed.pivoting) return key === 'Escape' ? { kind: 'pivot' } : null;
  if (ed.picking && !ed.drawing) return key === 'Escape' ? { kind: 'pick' } : null;
  if (ed.drawing) {
    if (key === 'Enter') return { kind: 'draw-finish' };
    if (key === 'Escape') return { kind: 'draw-cancel' };
    if (key === 'Backspace') return { kind: 'draw-undo' };
    return null;
  }
  if (key !== 'Escape') return null;
  const step: 'colorPick' | 'aligning' | 'doorMode' | 'selectedRoom' | 'selectedMarker' | null = ed.colorPick ? 'colorPick' : ed.aligning ? 'aligning' : ed.doorMode ? 'doorMode'
    : ed.selectedRoom ? 'selectedRoom' : ed.selectedMarker ? 'selectedMarker' : null;
  return { kind: 'esc', step };
}

export function onKeyDown(ed: EditMode, e: KeyboardEvent) {
  const r = keyRoute(ed, e.key, e.composedPath()[0] as Element | undefined);
  if (!r) return;
  switch (r.kind) {
    case 'menu': closeMenu(ed); break;
    case 'pivot': cancelPivot(ed); break;
    case 'pick': cancelPicking(ed); break;
    case 'draw-finish': finishDrawing(ed); break;
    case 'draw-cancel': cancelDrawing(ed); break;
    case 'draw-undo':
      ed.drawing!.points.pop(); // keyRoute: only while drawing
      refreshOverlay(ed);
      ed.render();
      break;
    default: { // the Esc cascade: undo one thing (no preventDefault)
      const step = r.kind === 'esc' ? r.step : null;
      if (step === 'colorPick') ed.colorPick = false;
      else if (step === 'aligning') cancelAlign(ed);
      else if (step === 'doorMode') ed.doorMode = false;
      else if (step === 'selectedRoom') ed.selectedRoom = null;
      else if (step === 'selectedMarker') ed.selectMarker(null);
      ed._syncStageClasses();
      refreshOverlay(ed);
      ed.render();
      return;
    }
  }
  e.preventDefault();
}

export function syncStageClasses(ed: EditMode) {
  ed.card._stage.classList.toggle('drawing', !!ed.drawing || !!ed.picking || ed.doorMode || !!ed.calibrating || !!ed.colorPick || !!ed.aligning || !!ed.pivoting);
  ed.view.setPivotMarker(!!ed.card._editing && ed.tab === 'views');
  ed.card._stage.classList.toggle('moving', ed.overlayMove);
  const picking = !!ed.card._editing && (ed.tab === 'model' || ed.tab === 'views') && !!ed.view.model;
  ed.card._stage.classList.toggle('picking', picking);
  ed.card._stage.classList.toggle('picking-views', picking && ed.tab === 'views');
}

// Overlay move tool: grab the pointer before OrbitControls sees it (capture phase on the stage).
export function canvasDownCapture(ed: EditMode, e: PointerEvent) {

  const o = mower(ed).overlay;
  if (!ed.overlayMove || !o || e.button !== 0) return;
  e.stopPropagation();
  const fid = ed.card._mowerFloor();
  const start = mapPoint(ed, e);
  if (!start) return;
  startWindowDrag(ed, { kind: 'overlay', start: [e.clientX, e.clientY], plan: start, origin: [o.x || 0, o.y || 0], floorId: fid, moved: false });
}
