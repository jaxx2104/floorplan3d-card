// Window drags started on the plan: room corners and midpoints, markers (magnetic on a model, Alt: free),
// the map overlay (move tool). Orbit controls are off while one runs.

import * as E from "../../editor.ts";
import { snapPin, attachOffset, floorAtHeight } from "../../objects/logic.ts";
import { mapPoint, planPoint, CLICK_SLOP_PX } from "../router.ts";
import { setOverlay } from "../tabs/mower.ts";
import { refreshOverlay } from "./handles.ts";
import { onModel } from "../tabs/devices.ts";
import type { Drag, EditMode, MarkerDrag } from "../../edit-mode.ts";
import type { ManifestEntry } from "../../types/manifest.ts";
import type { Object3D } from "three";

/** A model part under the pointer (view.surfaceAt(...).owner). */
type HitOwner = ManifestEntry<Object3D>;

// ---------- drags (corners, midpoints, markers) ----------
export function startWindowDrag(ed: EditMode, drag: Drag) {
  ed.drag = drag;
  ed.view.setControlsEnabled(false);
  window.addEventListener("pointermove", ed._onWinMove);
  window.addEventListener("pointerup", ed._onWinUp);
  window.addEventListener("pointercancel", ed._onWinUp);
}

export function endWindowDrag(ed: EditMode) {
  const d = ed.drag;
  if (d && d.raf) {
    cancelAnimationFrame(d.raf);
    d.raf = 0;
  }
  if (d && d.kind === "marker" && d.attach !== undefined && ed.view)
    ed.view.highlightModelNode(null);
  if (d && d.kind === "marker" && ed.view) ed.view.setSurfacePreview(null);
  window.removeEventListener("pointermove", ed._onWinMove);
  window.removeEventListener("pointerup", ed._onWinUp);
  window.removeEventListener("pointercancel", ed._onWinUp);
  if (ed.view) ed.view.setControlsEnabled(true);
  ed.drag = null;
}

export function vertexDown(
  ed: EditMode,
  e: PointerEvent,
  roomId: string,
  index: number,
) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  startWindowDrag(ed, {
    kind: "vertex",
    roomId,
    index,
    edge: -1,
    start: [e.clientX, e.clientY],
    moved: false,
  }); // edge: unused for a corner
}

export function midDown(
  ed: EditMode,
  e: PointerEvent,
  roomId: string,
  edge: number,
) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  startWindowDrag(ed, {
    kind: "mid",
    roomId,
    edge,
    index: -1,
    start: [e.clientX, e.clientY],
    moved: false,
  }); // index: set on the first move
}

export function markerDown(ed: EditMode, m: { id: string }, e: PointerEvent) {
  if (e.button !== 0) return;
  e.stopPropagation();
  if (
    ed.drawing ||
    ed.doorMode ||
    ed.calibrating ||
    ed.colorPick ||
    ed.aligning
  )
    return;
  if (m.id === ed.card._mowerMarkerId) {
    ed.selectMarker(m.id); // positioned live, nothing to drag
    return;
  }
  const pos = ed.card._positions && ed.card._positions.get(m.id);
  ed.selectMarker(m.id);
  if (!pos) return;
  startWindowDrag(ed, {
    kind: "marker",
    id: m.id,
    pos: { ...pos },
    start: [e.clientX, e.clientY],
    moved: false,
  });
}

export function dragMove(ed: EditMode, e: PointerEvent) {
  const d = ed.drag;
  if (!d) return;
  if (
    !d.moved &&
    Math.hypot(e.clientX - d.start[0], e.clientY - d.start[1]) < CLICK_SLOP_PX
  )
    return;
  d.moved = true;
  if (d.kind === "overlay") {
    const p = mapPoint(ed, e);
    if (!p) return;
    const r = (v: number) => Math.round(v * 100) / 100;
    setOverlay(
      ed,
      {
        x: r(d.origin[0] + p[0] - d.plan[0]),
        y: r(d.origin[1] + p[1] - d.plan[1]),
      },
      false,
    );
    return;
  }
  if (d.kind === "marker") {
    d.last = { clientX: e.clientX, clientY: e.clientY };
    if (!e.altKey && ed.view.model) {
      // magnetic: raycast at most once per frame, on the latest pointer position
      if (!d.raf)
        d.raf = requestAnimationFrame(() => {
          d.raf = 0;
          magnet(ed, d);
        }); // d: narrowed to a marker drag above
      return;
    }
    if (d.raf) {
      cancelAnimationFrame(d.raf);
      d.raf = 0;
    }
    setDragTarget(ed, d, null);
    ed.view.setSurfacePreview(null); // Alt: free drag, no preview
    freeMarker(ed, d, e);
    return;
  }
  const found = ed.room(d.roomId);
  if (!found) return;
  let room = found;
  if (d.kind === "mid") {
    // first move of a midpoint handle inserts the corner, then it is a normal corner drag
    const a = room.polygon[d.edge],
      b = room.polygon[(d.edge + 1) % room.polygon.length];
    d.base = E.insertVertex(room, d.edge, [
      (a[0] + b[0]) / 2,
      (a[1] + b[1]) / 2,
    ]);
    d.kind = "vertex";
    d.index = d.edge + 1;
  }
  room = d.base || room;
  const fid = ed.floorOf(room);
  const p = planPoint(ed, e, fid);
  if (!p) return;
  const roomId = room.id;
  const otherRooms = ed.layout.rooms.filter((r) => r.id !== roomId);
  const others = E.floorVertices(otherRooms, (r) => ed.floorOf(r), fid).concat(
    room.polygon.filter((_, i) => i !== d.index),
  );
  const s = E.snapPoint(p, { vertices: others, radius: ed.snapRadius() }).point;
  d.preview = E.moveVertex(room, d.index, s);
  refreshOverlay(ed, d.preview);
}

// Free drag (Alt, no model, nothing under the cursor): the plan point at the current height.
export function freeMarker(ed: EditMode, d: MarkerDrag, e: PointerEvent) {
  d.snapped = false;
  const p = planPoint(ed, e, d.pos.floorId, d.pos.z);
  if (!p) return;
  d.pos.x = p[0];
  d.pos.y = p[1];
  ed.view.moveMarker(d.id, p[0], p[1], d.pos.z, d.pos.floorId);
}

// Magnetic drag: stick to the model surface under the pointer (5 cm off it); over a model object
// highlight it, the drop attaches. Floor = the HA floor of the hit's level (else the current one).
export function magnet(ed: EditMode, d: MarkerDrag) {
  if (ed.drag !== d || !d.last) return;
  const hit = ed.view.surfaceAt(d.last.clientX, d.last.clientY);
  if (!hit) {
    // empty sky: keep the last snapped spot (a far plane hit would fling the marker away)
    setDragTarget(ed, d, null);
    ed.view.setSurfacePreview(null);
    return;
  }
  const owner = hit.owner;
  const level = owner
    ? owner.kind === "level"
      ? owner.id
      : owner.level
    : null;
  const lf = (ed.card._levels && ed.card._levels.levelFloor) || {};
  // the HA floor bound to the hit's level, else the floor the hit stands on, else the current one
  const bound = level ? lf[level] : null;
  const floorId: string =
    (bound && ed.floors.some((f) => f.id === bound) ? bound : null) ||
    floorAtHeight(
      ed.floors.map((f) => ({
        id: f.id,
        elevation: ed.view.floorElevation(f.id),
      })),
      hit.point.y,
    ) ||
    d.pos.floorId;
  const pin = snapPin(hit, ed.view.floorElevation(floorId), floorId);
  d.pos = { ...d.pos, x: pin.x, y: pin.y, z: pin.z, floorId };
  d.snapped = true;
  const layer = ed.card._objects;
  const obj =
    owner && owner.kind === "object" && layer && layer.objectAt(owner.id)
      ? owner
      : null;
  setDragTarget(ed, d, obj);
  // preview: a ring on the surface, its face tinted, "Attach: <object>" over a model object
  const target = obj && layer && layer.objectAt(obj.id); // layer: set whenever obj is
  const label = obj
    ? "Attach: " +
      (target && target.obj ? ed.card.objectLabel(target.obj) : obj.id)
    : null;
  ed.view.setSurfacePreview({
    point: hit.point,
    normal: hit.normal,
    tri: hit.tri,
    label,
  });
  ed.view.moveMarker(d.id, pin.x, pin.y, pin.z, floorId);
}

export function setDragTarget(
  ed: EditMode,
  d: MarkerDrag,
  owner: HitOwner | null,
) {
  const id = owner ? owner.id : null;
  if ((d.attach || null) === id) return;
  d.attach = id;
  ed.view.highlightModelNode(owner ? owner.node : null);
}

export function dragEnd(ed: EditMode) {
  const d = ed.drag;
  if (d && d.kind === "marker" && d.raf) {
    // the last move is still waiting for its frame
    cancelAnimationFrame(d.raf);
    d.raf = 0;
    magnet(ed, d);
  }
  endWindowDrag(ed);
  if (!d || !d.moved) {
    if (d && d.kind !== "marker") refreshOverlay(ed);
    return;
  }
  if (d.kind === "overlay") {
    ed.render();
  } else if (d.kind === "marker") {
    const at = { x: d.pos.x, y: d.pos.y, z: d.pos.z, floor_id: d.pos.floorId };
    const attach = d.attach;
    const anchor =
      attach && ed.card._objects && ed.card._objects.anchorOf(attach);
    if (attach && anchor) {
      const offset = attachOffset(
        anchor,
        d.pos,
        ed.view.floorElevation(d.pos.floorId),
      );
      ed.commit(E.attachPin(ed.layout, d.id, attach, offset, at));
    } else {
      ed.commit(
        E.setPin(
          ed.layout,
          d.id,
          { ...at, on_model: onModel(ed, d.id) },
          { grid: !d.snapped },
        ),
      );
    }
  } else if (d.preview) {
    ed.commit(E.upsertRoom(ed.layout, d.preview));
  } else {
    refreshOverlay(ed);
  }
}
