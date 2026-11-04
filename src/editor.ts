// Pure edit operations on the layout. Every function returns new objects (the card compares
// layout identity to decide what to rebuild) and never mutates its input.

import { snap } from './placement.ts';
import { normalise } from './storage.ts';
import { layoutTags } from './objects/logic.ts';
import { transformPoint, inverseTransformPoint, type Align } from './bindings.ts';
import type { Layout, LayoutFloor, NormalisedLayout, LayoutObject, LayoutPin, LayoutRoom, LayoutTag, PlanPoint, Vec3 } from './types/layout.ts';

export type SnapKind = 'vertex' | 'align' | 'grid';
export interface SnapResult { point: PlanPoint; kind: SnapKind }
export interface Edge { index: number; point: PlanPoint; t: number; dist: number }
/** A pin as handed to setPin / attachPin (z missing: NaN, as before). */
export interface PinInput { x: number; y: number; z?: number; floor_id?: string; on_model?: boolean }
/** A parsed import: normalise() guarantees the lists. */
export type ParsedLayout = NormalisedLayout;

export const GRID = 0.05;
export const SNAP_RADIUS = 0.25;

const round = (v: number): number => Math.round(v * 1000) / 1000;

// Snap a plan point: to an existing vertex within radius, else align x / y with a nearby
// vertex (straight walls), else to the grid.
export function snapPoint(p: PlanPoint, { vertices = [], radius = SNAP_RADIUS, grid = GRID }: { vertices?: PlanPoint[]; radius?: number; grid?: number } = {}): SnapResult {
  let best: PlanPoint | null = null, bestD = radius;
  for (const v of vertices) {
    const d = Math.hypot(v[0] - p[0], v[1] - p[1]);
    if (d <= bestD) { best = v; bestD = d; }
  }
  if (best) return { point: [best[0], best[1]], kind: 'vertex' };
  let x = round(snap(p[0], grid)), y = round(snap(p[1], grid));
  let ax = radius, ay = radius, aligned = false;
  for (const v of vertices) {
    const dx = Math.abs(v[0] - p[0]), dy = Math.abs(v[1] - p[1]);
    if (dx < ax) { ax = dx; x = v[0]; aligned = true; }
    if (dy < ay) { ay = dy; y = v[1]; aligned = true; }
  }
  return { point: [x, y], kind: aligned ? 'align' : 'grid' };
}

// All room vertices on one floor, for snapping. `skip` = {roomId, index} to leave out.
export function floorVertices(rooms: LayoutRoom[], floorIdOf: (r: LayoutRoom) => string, floorId: string, skip?: { roomId: string; index: number }): PlanPoint[] {
  const out: PlanPoint[] = [];
  for (const r of rooms) {
    if (floorIdOf(r) !== floorId || !r.polygon) continue;
    r.polygon.forEach((v, i) => {
      if (!skip || skip.roomId !== r.id || skip.index !== i) out.push(v);
    });
  }
  return out;
}

export function nearestEdge(poly: PlanPoint[], p: PlanPoint): Edge | null {
  let best: Edge | null = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    const q: PlanPoint = [a[0] + dx * t, a[1] + dy * t];
    const dist = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!best || dist < best.dist) best = { index: i, point: q, t, dist };
  }
  return best;
}

// ---------- rooms ----------
export function newRoomId(layout: Layout): string {
  const ids = new Set((layout.rooms || []).map((r) => r.id));
  let n = 1;
  while (ids.has('r' + n)) n++;
  return 'r' + n;
}

export function upsertRoom(layout: Layout, room: LayoutRoom): Layout {
  const rooms = layout.rooms || [];
  const i = rooms.findIndex((r) => r.id === room.id);
  return { ...layout, rooms: i === -1 ? [...rooms, room] : rooms.map((r, j) => (j === i ? room : r)) };
}

export function deleteRoom(layout: Layout, id: string): Layout {
  return { ...layout, rooms: (layout.rooms || []).filter((r) => r.id !== id) };
}

export function moveVertex(room: LayoutRoom, i: number, p: PlanPoint): LayoutRoom {
  return { ...room, polygon: room.polygon.map((v, j) => (j === i ? [p[0], p[1]] : v)) };
}

export function insertVertex(room: LayoutRoom, edgeIndex: number, p: PlanPoint): LayoutRoom {
  const polygon: PlanPoint[] = [...room.polygon];
  polygon.splice(edgeIndex + 1, 0, [p[0], p[1]]);
  return { ...room, polygon };
}

export function removeVertex(room: LayoutRoom, i: number): LayoutRoom {
  if (room.polygon.length <= 3) return room;
  return { ...room, polygon: room.polygon.filter((_, j) => j !== i) };
}

// Door on the nearest edge, if the click is within maxDist of it.
export function addDoor(room: LayoutRoom, p: PlanPoint, maxDist = 0.6): LayoutRoom {
  const e = nearestEdge(room.polygon, p);
  if (!e || e.dist > maxDist) return room;
  const door: PlanPoint = [round(snap(e.point[0], GRID)), round(snap(e.point[1], GRID))];
  // snapping can pull the door off a diagonal wall, keep the exact projection then
  // non-null: the polygon has an edge (e above)
  const d: PlanPoint = nearestEdge(room.polygon, door)!.dist < 0.02 ? door : [round(e.point[0]), round(e.point[1])];
  return { ...room, doors: [...(room.doors || []), d] };
}

export function removeDoor(room: LayoutRoom, i: number): LayoutRoom {
  return { ...room, doors: (room.doors || []).filter((_, j) => j !== i) };
}

// Drop consecutive duplicates and a closing point equal to the first.
export function cleanPolygon(points: PlanPoint[]): PlanPoint[] {
  const out: PlanPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-6) out.push([p[0], p[1]]);
  }
  if (out.length > 1) {
    const [f, l] = [out[0], out[out.length - 1]];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-6) out.pop();
  }
  return out;
}

// ---------- devices ----------
// grid: false keeps the exact position (mm), e.g. a marker stuck to a model surface.
export function setPin(layout: Layout, id: string, pin: PinInput, { grid = true }: { grid?: boolean } = {}): Layout {
  const g = (v: number) => round(grid ? snap(v, GRID) : v);
  const p: LayoutPin = { x: g(pin.x), y: g(pin.y), z: round(Number(pin.z)), floor_id: pin.floor_id };
  if (pin.on_model) p.on_model = true; // placed on the model: follows its alignment (realignPins)
  return { ...layout, pins: { ...layout.pins, [id]: p } };
}

// Attach a marker to a model object: it follows the object's anchor + offset (world metres).
// `at` (plan position at drop time) is kept as the fallback while the object is not there.
export function attachPin(layout: Layout, id: string, objectId: string, offset: Vec3, at?: PinInput | null): Layout {
  const prev: Partial<LayoutPin> = (layout.pins || {})[id] || {};
  const src: Partial<PinInput> = at || prev;
  const p: LayoutPin = { x: round(src.x ?? 0), y: round(src.y ?? 0), z: round(src.z ?? 1.2), floor_id: src.floor_id ?? prev.floor_id,
    on_model: true, attach: objectId, offset: [round(offset[0]), round(offset[1]), round(offset[2])] };
  return { ...layout, pins: { ...layout.pins, [id]: p } };
}

// The model was moved / rotated / scaled from oldAlign to newAlign: pins placed on the model
// keep their spot on it (p' = T_new(T_old^-1(p)), height scales with the model). Other pins stay.
export function realignPins(layout: Layout, oldAlign?: Align, newAlign?: Align): Layout {
  const pins = layout.pins || {};
  const os = (oldAlign && oldAlign.scale) || 1, ns = (newAlign && newAlign.scale) || 1;
  let changed = false;
  const out: Record<string, LayoutPin> = {};
  for (const [id, p] of Object.entries(pins)) {
    // attached pins follow their object; only their fallback position (object missing) is realigned
    if (!p || !p.on_model) { out[id] = p; continue; }
    const [ix, iy] = inverseTransformPoint([p.x, p.y], oldAlign);
    const [x, y] = transformPoint([ix, iy], newAlign);
    const z = Number(p.z) * (ns / os); // a pin without z: NaN, as before
    // micrometre precision: slider ticks realign step by step, mm rounding would accumulate drift
    const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
    const q = { ...p, x: r6(x), y: r6(y), z: r6(z) };
    if (q.x !== p.x || q.y !== p.y || q.z !== p.z) changed = true;
    out[id] = q;
  }
  return changed ? { ...layout, pins: out } : layout;
}

export function clearPin(layout: Layout, id: string): Layout {
  const pins = { ...layout.pins };
  delete pins[id];
  return { ...layout, pins };
}

export function hide(layout: Layout, id: string): Layout {
  const hidden = layout.hidden || [];
  return hidden.includes(id) ? layout : { ...layout, hidden: [...hidden, id] };
}

export function unhide(layout: Layout, id: string): Layout {
  return { ...layout, hidden: (layout.hidden || []).filter((h) => h !== id) };
}

// ---------- floors ----------
// Stored floor entries are overrides for HA floors or standalone floors.
export function upsertFloor(layout: Layout, floor: LayoutFloor): Layout {
  const floors = layout.floors || [];
  const i = floors.findIndex((f) => f.id === floor.id);
  const merged = i === -1 ? floor : { ...floors[i], ...floor };
  return { ...layout, floors: i === -1 ? [...floors, merged] : floors.map((f, j) => (j === i ? merged : f)) };
}

export function deleteFloor(layout: Layout, id: string): Layout {
  return { ...layout, floors: (layout.floors || []).filter((f) => f.id !== id) };
}

export function newFloorId(layout: Layout, floors: { id: string }[]): string {
  const ids = new Set([...(layout.floors || []), ...floors].map((f) => f.id));
  let n = 1;
  while (ids.has('floor_' + n)) n++;
  return 'floor_' + n;
}

// ---------- import ----------
const isPoint = (p: unknown): p is PlanPoint => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

export function parseImport(text: string): ParsedLayout {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('Not valid JSON: ' + (e as Error).message, { cause: e });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a layout object');
  const version = (data as { version?: unknown }).version;
  if (version !== undefined && version !== 1) throw new Error('Unsupported layout version ' + String(version));
  const l: ParsedLayout = normalise(data);
  // the file's rooms are unchecked JSON until validated here
  (l.rooms as unknown[]).forEach((r0, i) => {
    const r = r0 as LayoutRoom | null;
    if (!r || typeof r !== 'object') throw new Error(`Room ${i + 1} is not an object`);
    if (!Array.isArray(r.polygon) || r.polygon.length < 3 || !r.polygon.every(isPoint)) {
      throw new Error(`Room ${r.id || i + 1}: polygon needs at least 3 [x, y] points`);
    }
    if (r.doors !== undefined && (!Array.isArray(r.doors) || !r.doors.every(isPoint))) {
      throw new Error(`Room ${r.id || i + 1}: doors must be [x, y] points`);
    }
  });
  const ids = new Set<string>();
  l.rooms = l.rooms.map((r) => {
    let id = r.id || 'r';
    while (ids.has(id)) id += '_';
    ids.add(id);
    return { ...r, id };
  });
  for (const f of l.floors as (LayoutFloor | null)[]) if (!f || !f.id) throw new Error('Every floor needs an id');
  return l;
}

// Fit an imported layout to this Home Assistant: floor ids HA doesn't have are mapped bottom-up
// onto unused HA floors (rooms, pins and floor overrides follow); floors left over stay as
// layout floors. haFloors: [{id, elevation}] from HA only.
// Returns { layout, floorMap: {imported: haId}, unknownAreas: [...] }.
export interface FitResult { layout: ParsedLayout; floorMap: Record<string, string>; unknownAreas: string[] }

export function fitImport(layout: ParsedLayout, haFloors: { id: string; elevation: number }[], haAreaIds: string[]): FitResult {
  const ha = new Set(haFloors.map((f) => f.id));
  const imported = layout.floors || [];
  const used = new Set(imported.filter((f) => ha.has(f.id)).map((f) => f.id));
  for (const r of layout.rooms) if (r.floor_id && ha.has(r.floor_id)) used.add(r.floor_id);
  const free = haFloors.filter((f) => !used.has(f.id)).sort((a, b) => a.elevation - b.elevation);
  const foreign = imported.filter((f) => !ha.has(f.id)).sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
  const floorMap: Record<string, string> = {};
  foreign.forEach((f, i) => { if (free[i]) floorMap[f.id] = free[i].id; });
  const mapId = (id: string): string => floorMap[id] || id;
  const floors = imported.map((f) => (floorMap[f.id] ? { ...f, id: floorMap[f.id], name: undefined } : f))
    .map((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as LayoutFloor);
  const rooms = layout.rooms.map((r) => (r.floor_id && floorMap[r.floor_id] ? { ...r, floor_id: mapId(r.floor_id) } : r));
  const pins = Object.fromEntries(Object.entries(layout.pins || {}).map(([k, p]) => [k, p.floor_id && floorMap[p.floor_id] ? { ...p, floor_id: mapId(p.floor_id) } : p]));
  const areas = new Set(haAreaIds);
  const unknownAreas = [...new Set(layout.rooms.map((r) => r.area_id).filter((a): a is string => !!a && !areas.has(a)))];
  const out: ParsedLayout = { ...layout, floors, rooms, pins };
  // views link HA floors too
  if (layout.views && typeof layout.views === 'object') {
    out.views = Object.fromEntries(Object.entries(layout.views).map(([id, v]) => [id,
      v && Array.isArray(v.floors) && v.floors.some((f) => floorMap[f]) ? { ...v, floors: v.floors.map(mapId) } : v]));
  }
  return { layout: out, floorMap, unknownAreas };
}

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// Parts a plan export may leave out are kept from the current layout: the uploaded model, the
// mower setup, the view settings (rules, cameras, sections, order), the model object bindings and
// group controllers (they belong to the kept model). raw: the parsed file as is.
export function mergeImport<T extends Layout>(imported: T, raw: Record<string, unknown>, current: Layout | null | undefined): T {
  const l: T = { ...imported };
  const cur: Partial<Layout> = current || {};
  for (const k of ['objects', 'tags'] as const) {
    if (plainObject(raw[k]) || (k === 'tags' && plainObject(raw.groups))) continue; // old files: groups became tags (normalise)
    const kept = cur[k];
    if (plainObject(kept)) (l as Record<string, unknown>)[k] = kept; // the same key's type on both sides

    else delete l[k];
  }
  if (!('model' in raw)) l.model = cur.model || null;
  if (!('mower' in raw) || raw.mower === null) l.mower = cur.mower || null;
  if (!('views' in raw)) l.views = cur.views;
  if (!('view_order' in raw)) l.view_order = cur.view_order;
  for (const k of ['views', 'view_order'] as const) if (l[k] === undefined) delete l[k];
  return l;
}

// v0.2.x pins (no on_model) on floors bound to a model level start following the model, once:
// on the first alignment change (layout.model.pins_migrated). boundFloors: HA floor ids.
export function migrateLegacyPins(layout: Layout, boundFloors: string[] | null | undefined): Layout {
  const m = layout.model || {};
  if (m.pins_migrated) return layout;
  const bound = new Set(boundFloors || []);
  const pins = Object.fromEntries(Object.entries(layout.pins || {}).map(([id, p]) => [id,
    p && !p.on_model && p.floor_id !== undefined && bound.has(p.floor_id) ? { ...p, on_model: true } : p]));
  return { ...layout, pins, model: { ...m, pins_migrated: true } };
}

// layout.objects[id] = { entity?, hidden? }: merge a patch. `entity: undefined` removes the key
// (back to automatic binding); `hidden: false` drops the flag. An entry with nothing left is removed.
export function setObject(layout: Layout, id: string, patch: Partial<LayoutObject>): Layout {
  const cur: LayoutObject = { ...(layout.objects || {})[id] };
  for (const [k, raw] of Object.entries(patch)) {
    const v = k === 'label' && typeof raw === 'string' ? raw.trim() : raw;
    if (v === undefined || (k === 'hidden' && !v) || (k === 'label' && !v)) delete cur[k]; // no label: the model's
    else cur[k] = v;
  }
  const objects = { ...layout.objects };
  if (Object.keys(cur).length) objects[id] = cur;
  else delete objects[id];
  return { ...layout, objects };
}

// layout.objects[id].ui[<which>_action] (which: tap | hold | double_tap): set, or null removes it
// (back to the model / type default). An empty ui is dropped, an empty entry too.
export function setObjectUi(layout: Layout, id: string, which: string, action: unknown): Layout {
  const cur = ((layout.objects || {})[id] || {}).ui || {};
  const ui: Record<string, unknown> = { ...cur };
  const key = which === 'popup' ? 'popup' : `${which}_action`; // popup: the row list (['toggle'] = only on / off)
  if (action) ui[key] = action;
  else delete ui[key];
  return setObject(layout, id, { ui: Object.keys(ui).length ? ui : undefined });
}

// layout.tags[name] = { entity, label, wash }: the optional controller of a tag (every object carrying the tag
// is lit only while it is on) and its display label (popup chain rows). No entity (empty or "none") /
// empty label: not stored; wash ("Light on wall" for its objects): down | up | both | none, else from the model;
// nothing left: no entry. Old layout.groups entries move into tags.
const WASH_DIRS: unknown[] = ['down', 'up', 'both', 'none'];
export function setTag(layout: Layout, name: string, patch: Partial<LayoutTag>): Layout {
  const all: Record<string, LayoutTag> = layoutTags(layout);
  const cur: LayoutTag = { ...all[name], ...patch };
  if (typeof cur.entity === 'string') cur.entity = cur.entity.trim();
  if (!cur.entity || typeof cur.entity !== 'string' || cur.entity.toLowerCase() === 'none') delete cur.entity;
  if (typeof cur.label === 'string') cur.label = cur.label.trim();
  if (!cur.label || typeof cur.label !== 'string') delete cur.label;
  if (!WASH_DIRS.includes(cur.wash)) delete cur.wash; // "Light on wall": empty = from the model
  const tags: Record<string, LayoutTag> = { ...all };
  if (Object.keys(cur).length) tags[name] = cur;
  else delete tags[name];
  const out: Layout = { ...layout, tags };
  delete out.groups;
  return out;
}
export const setGroup = setTag; // pre-0.4.5 name

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

// layout.objects[id].tags: the list, or no key when it equals the defaults (fp.group + HA labels stay live).
export function setObjectTags(layout: Layout, id: string, tags: readonly unknown[], defaults: string[] = []): Layout {
  const list: string[] = [];
  for (const t of tags) { const v = String(t).trim(); if (v && !list.includes(v)) list.push(v); }
  return setObject(layout, id, { tags: sameList(list, defaults) ? undefined : list });
}

// Add / remove one tag on several objects. tagsOf(id): current tags; defaultsOf(id): the default tags.
export type TagsOf = (id: string) => string[];

export function addTagToObjects(layout: Layout, ids: string[], tag: string, tagsOf: TagsOf, defaultsOf: TagsOf): Layout {
  const t = String(tag).trim();
  if (!t) return layout;
  let l = layout;
  for (const id of ids) { const cur = tagsOf(id); if (!cur.includes(t)) l = setObjectTags(l, id, [...cur, t], defaultsOf(id)); }
  return l;
}

export function removeTagFromObjects(layout: Layout, ids: string[], tag: string, tagsOf: TagsOf, defaultsOf: TagsOf): Layout {
  let l = layout;
  for (const id of ids) { const cur = tagsOf(id); if (cur.includes(tag)) l = setObjectTags(l, id, cur.filter((x) => x !== tag), defaultsOf(id)); }
  return l;
}

// A typed slider value: clamped to min..max and rounded to the step grid (from min); null when not a number.
export function sliderValue(raw: unknown, min: number | string | null, max: number | string | null, step: number | string): number | null {

  const s = String(raw ?? '').trim();
  if (s === '') return null;
  const n = Number(s.replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const lo = Number(min), hi = Number(max), st = Number(step) > 0 ? Number(step) : 0;
  let v = Math.min(hi, Math.max(lo, n));
  if (st) {
    const decimals = (String(step).split('.')[1] || '').length;
    v = Number((lo + Math.round((v - lo) / st) * st).toFixed(Math.min(10, decimals + 2)));
    if (v > hi) v = Number((v - st).toFixed(Math.min(10, decimals + 2)));
  }
  return v;
}
