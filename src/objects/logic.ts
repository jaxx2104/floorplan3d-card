// Pure logic for model objects: binding, chains, colour, budget, sun. No Three.js here.
import type { Hass, HassEntity, HassEntityRegistryEntry } from "../types/ha.ts";
import type { Layout, LayoutObject, LayoutTag } from "../types/layout.ts";
import type { ManifestObject } from "../types/manifest.ts";

type States = Record<string, HassEntity>;
type Entities = Record<string, HassEntityRegistryEntry>;
type Rgb = [number, number, number];
/** The object fields the binding / chain logic reads (tests pass partial objects). */
export type ObjectLike = Pick<ManifestObject, "id"> &
  Partial<Pick<ManifestObject, "type" | "group" | "suggest">>;

/** Resolved HA binding of one model object. */
export interface ObjectBinding {
  entity: string | null;
  auto: boolean;
  missing: boolean;
  hidden: boolean;
  from?: "mower";
  tags?: string[];
}
export interface Controller {
  entity: string;
  tag: string;
}
export interface ChainState {
  lit: boolean;
  unavailable: boolean;
  source: HassEntity | null;
  entities: string[];
  reason: string | null;
  controllers: Controller[];
}
/** A lamp competing for the real-light pool (lightBudget). */
export interface BudgetFixture {
  id: string;
  lit: boolean;
  visible: boolean;
  group?: string | null;
  max?: number;
  beam?: string;
  castShadow?: boolean;
  wash?: unknown;
}
export interface RealLight {
  kind: "point" | "spot";
  factor: number;
  grouped?: true;
}
export interface ScreenPoint {
  id: string;
  x: number;
  y: number;
}
type XYZ = { x: number; y: number; z: number };
type VecLike = XYZ | readonly number[];

const isOn = <S extends Pick<HassEntity, "state">>(
  s: S | null | undefined,
): s is S => !!s && s.state === "on";
const bad = (s: HassEntity | null | undefined): boolean =>
  !s || s.state === "unavailable" || s.state === "unknown";

const MOWER_TYPES = new Set(["mower", "dock"]);

// The lawn_mower entity behind the Mower tab entity: itself, else a lawn_mower of the same device, else as is.
export function mowerTabEntity(
  entity: string | null | undefined,
  entities: Entities = {},
): string | null {
  if (!entity) return null;
  if (entity.startsWith("lawn_mower.")) return entity;
  const reg = entities && entities[entity];
  if (reg && reg.device_id) {
    const sib = Object.keys(entities).find(
      (e) =>
        e.startsWith("lawn_mower.") && entities[e].device_id === reg.device_id,
    );
    if (sib) return sib;
  }
  return entity;
}

// opts.mowerEntity: mower / dock objects without an explicit binding whose suggest.entity is missing
// (or not in HA) use it (auto, from: 'mower').
export function bindObjects(
  objects: readonly ObjectLike[],
  layoutObjects: Record<string, LayoutObject> = {},
  states: States = {},
  opts: {
    mowerEntity?: string | null;
    hass?: Pick<Hass, "entities" | "labels"> | null;
  } = {},
): Map<string, ObjectBinding> {
  const out = new Map<string, ObjectBinding>();
  const me =
    opts.mowerEntity && states[opts.mowerEntity] ? opts.mowerEntity : null;
  for (const o of objects) {
    const saved: LayoutObject = layoutObjects[o.id] || {};
    const hidden = !!saved.hidden;
    if (saved.entity !== undefined) {
      const entity = saved.entity || null;
      out.set(o.id, {
        entity: entity && states[entity] ? entity : null,
        auto: false,
        missing: !!entity && !states[entity],
        hidden,
      });
      continue;
    }
    const s = (o.suggest || {}).entity;
    if (!(s && states[s]) && me && MOWER_TYPES.has(o.type ?? "")) {
      out.set(o.id, {
        entity: me,
        auto: true,
        missing: false,
        hidden,
        from: "mower",
      });
      continue;
    }
    out.set(o.id, {
      entity: s && states[s] ? s : null,
      auto: true,
      missing: !!s && !states[s],
      hidden,
    });
  }
  // opts.hass: every binding also carries the object's tags (saved, else fp.group + HA labels)
  if (opts.hass)
    for (const o of objects) {
      const b = out.get(o.id)!;
      b.tags = objectTags(o, layoutObjects[o.id], b.entity, opts.hass);
    } // every object was bound above
  return out;
}

const cleanTags = (list: readonly unknown[]): string[] => {
  const out: string[] = [];
  for (const t of list) {
    const v = typeof t === "string" ? t.trim() : "";
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
};

// An object's tags: layout.objects[id].tags when saved, else fp.group (if any) + the HA labels of the
// bound entity (hass.entities[e].labels; names from hass.labels when HA exposes them, else the label ids).
export function objectTags(
  obj: Pick<ObjectLike, "group"> | null | undefined,
  saved: LayoutObject | null | undefined,
  entity: string | null | undefined,
  hass: Pick<Hass, "entities" | "labels"> | null | undefined,
): string[] {
  if (saved && Array.isArray(saved.tags)) return cleanTags(saved.tags);
  const out: string[] = [];
  if (obj && obj.group) out.push(obj.group);
  const reg = entity && hass && hass.entities ? hass.entities[entity] : null;
  const labels: NonNullable<Hass["labels"]> = (hass && hass.labels) || {};
  for (const id of reg && Array.isArray(reg.labels) ? reg.labels : []) {
    const l = labels[id];
    out.push((l && typeof l.name === "string" && l.name) || id);
  }
  return cleanTags(out);
}

// Tag settings (controller entity, label) by tag name: layout.tags (the v1 layout.groups are migrated into it).
export function layoutTags(
  layout: Partial<Pick<Layout, "tags">> | null | undefined,
): Record<string, LayoutTag> {
  return (layout && layout.tags) || {};
}

type TagSettings =
  Record<string, LayoutTag | null | undefined> | null | undefined;

const tagsOf = (
  obj: Pick<ObjectLike, "group"> | null | undefined,
  binding: Pick<ObjectBinding, "tags"> | null | undefined,
): string[] =>
  binding && Array.isArray(binding.tags)
    ? binding.tags
    : obj && obj.group
      ? [obj.group]
      : [];

// The controllers an object's chain needs: [{ entity, tag }] for each of its tags with a controller
// (unique, never the object's own entity). Without resolved tags: fp.group.
export function controllersOf(
  obj: Pick<ObjectLike, "group"> | null | undefined,
  binding: Partial<Pick<ObjectBinding, "entity" | "tags">> | null | undefined,
  tags: TagSettings = {},
): Controller[] {
  const own = binding && binding.entity;
  const out: Controller[] = [];
  for (const t of tagsOf(obj, binding)) {
    const e = tags && tags[t] && tags[t].entity;
    if (e && e !== own && !out.some((c) => c.entity === e))
      out.push({ entity: e, tag: t });
  }
  return out;
}

// Light budget grouping: objects sharing a controller tag are one group; else fp.group.
export function budgetGroup(
  obj: Pick<ObjectLike, "group"> | null | undefined,
  binding: Pick<ObjectBinding, "tags"> | null | undefined,
  tags: TagSettings = {},
): string | null {
  for (const t of tagsOf(obj, binding))
    if (tags && tags[t] && tags[t].entity) return t;
  return (obj && obj.group) || null;
}

// Tag controllers that exist in HA. A controller entity HA doesn't know (a typo, a removed
// entity, a literal "none") is ignored: the group behaves as if it had no controller.
export function effectiveGroups(
  groups: TagSettings = {},
  states: States = {},
): Record<string, LayoutTag & { entity: string }> {
  const out: Record<string, LayoutTag & { entity: string }> = {};
  for (const [name, g] of Object.entries(groups || {})) {
    const e = g && typeof g.entity === "string" ? g.entity : null;
    if (e && states[e]) out[name] = { ...g, entity: e };
  }
  return out;
}

/**
 * Chain object state through its tag controllers: the own entity and every controller must be on.
 * Callers gate on `lit`; `source` may be an off light. groups: effective tag settings (effectiveGroups).
 */
export function chainState(
  obj: Pick<ObjectLike, "group"> | null | undefined,
  binding: Partial<Pick<ObjectBinding, "entity" | "tags">> | null | undefined,
  groups: TagSettings = {},
  states: States = {},
): ChainState {
  const controllers = controllersOf(obj, binding, groups);
  const entities = [
    binding && binding.entity,
    ...controllers.map((c) => c.entity),
  ].filter((e): e is string => !!e);
  if (!entities.length)
    return {
      lit: false,
      unavailable: false,
      source: null,
      entities,
      reason: null,
      controllers,
    };
  const sts = entities.map((e) => states[e]);
  const unavailable = sts.some(bad);
  const lit = !unavailable && sts.every(isOn);
  let reason = null;
  const off = controllers.find((c) => !isOn(states[c.entity]));
  if (!lit && !unavailable && off) reason = `${off.entity} is off`;
  const source =
    sts.find((s, i) => s && entities[i].startsWith("light.")) || null;
  return { lit, unavailable, source, entities, reason, controllers };
}

function hsvToRgb(h: number, s: number, v: number): Rgb {
  const f = (n: number): number => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)].map((x) => Math.round(x * 255)) as Rgb; // three components in, three out
}

function kelvinToRgb(k: number): Rgb {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g =
    t <= 66
      ? 99.4708025861 * Math.log(t) - 161.1195681661
      : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b =
    t >= 66
      ? 255
      : t <= 19
        ? 0
        : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((x) => Math.round(Math.min(255, Math.max(0, x)))) as Rgb; // three components in, three out
}

export function lightColor(
  s: Pick<HassEntity, "attributes"> | null | undefined,
): Rgb {
  const a: HassEntity["attributes"] = (s && s.attributes) || {};
  if (Array.isArray(a.rgb_color)) return a.rgb_color.slice(0, 3) as Rgb;
  if (Array.isArray(a.hs_color))
    return hsvToRgb(a.hs_color[0], a.hs_color[1] / 100, 1);
  if (a.color_temp_kelvin) return kelvinToRgb(a.color_temp_kelvin);
  return hsvToRgb(30, 0.5, 1); // warm white
}

export function lightLevel(
  s: Pick<HassEntity, "state" | "attributes"> | null | undefined,
): number {
  if (!isOn(s)) return 0;
  const b = s.attributes && s.attributes.brightness;
  return typeof b === "number" ? Math.max(0, Math.min(1, b / 255)) : 1;
}

// Groups up to this size light each lamp (one real light per fixture) while the pool has room.
// Group lights never take a shadow slot when a non-shadow one is free (`grouped` in the result).
// A group of 2+ lamps that all have a chosen wall wash (fixture.wash: "Light on wall" set on the lamp or its
// tag) is lit evenly or not at all: its washes carry the look, so one lamp with a real light (the middle
// fixture) would stand out from the others.
export const SMALL_GROUP = 6;
type Cand = { f: BudgetFixture; factor: number; grouped?: true };

export function lightBudget(
  fixtures: readonly BudgetFixture[],
  { points = 8, spots = 4, shadows = 4 } = {},
): { real: Map<string, RealLight>; shadows: Set<string> } {
  const cand: Cand[] = [];
  const groups = new Map<string, BudgetFixture[]>();
  for (const f of fixtures) {
    if (!f.lit || !f.visible) continue;
    if (f.group) {
      if (!groups.has(f.group)) groups.set(f.group, []);
      groups.get(f.group)!.push(f);
    } else cand.push({ f, factor: 1 });
  }
  const small: { list: BudgetFixture[]; mid: BudgetFixture; max: number }[] =
    [];
  const middle = (list: BudgetFixture[]): BudgetFixture => {
    const sorted = list
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    return sorted[Math.floor((sorted.length - 1) / 2)];
  };
  // every group competes with its middle fixture (factor 1.5); small groups may be expanded below
  const even = new Set<string>(); // groups lit per lamp or not at all
  for (const list of groups.values()) {
    const washed = list.length > 1 && list.every((f) => f.wash);
    if (washed && list.length > SMALL_GROUP) continue;
    const c: Cand = { f: middle(list), factor: 1.5, grouped: true };
    if (washed) even.add(c.f.id);
    if (list.length <= SMALL_GROUP)
      small.push({
        list,
        mid: c.f,
        max: Math.max(...list.map((f) => f.max || 0)),
      });
    cand.push(c);
  }
  const byMax = (a: BudgetFixture, b: BudgetFixture): number =>
    (b.max || 0) - (a.max || 0) || (a.id < b.id ? -1 : 1);
  cand.sort((a, b) => byMax(a.f, b.f));
  const real = new Map<string, RealLight>(),
    shadowSet = new Set<string>();
  let p = 0,
    s = 0,
    gp = 0; // gp: grouped point lights, which belong in the non-shadow point slots
  const groupCap = points - shadows;
  const kindOf = (f: BudgetFixture): RealLight["kind"] =>
    f.beam === "spot" ? "spot" : "point";
  const room = (kind: RealLight["kind"]): boolean =>
    kind === "spot" ? s < spots : p < points;
  const take = (kind: RealLight["kind"]): void => {
    if (kind === "spot") s++;
    else p++;
  };
  for (const c of cand) {
    const kind = kindOf(c.f);
    if (!room(kind)) continue;
    take(kind);
    if (c.grouped && kind === "point") gp++;
    real.set(
      c.f.id,
      c.grouped
        ? { kind, factor: c.factor, grouped: true }
        : { kind, factor: c.factor },
    );
    if (
      !c.grouped &&
      kind === "point" &&
      c.f.castShadow !== false &&
      shadowSet.size < shadows
    )
      shadowSet.add(c.f.id);
  }
  // spare slots: small groups whose middle got a light, strongest first, get one light per lamp (factor 1)
  // when every other lamp fits — group lamps only in non-shadow point slots or spot slots, never partial
  small.sort((a, b) => b.max - a.max || (a.mid.id < b.mid.id ? -1 : 1));
  for (const { list, mid } of small) {
    if (!real.has(mid.id) || list.length < 2) continue;
    const rest = list.filter((f) => f !== mid);
    const needP = rest.filter((f) => kindOf(f) === "point").length,
      needS = rest.length - needP;
    if (p + needP > points || gp + needP > groupCap || s + needS > spots)
      continue;
    for (const f of rest) {
      const kind = kindOf(f);
      take(kind);
      real.set(f.id, { kind, factor: 1, grouped: true });
    }
    gp += needP;
    real.get(mid.id)!.factor = 1; // checked by real.has above
    even.delete(mid.id);
  }
  for (const id of even) real.delete(id); // a washed group that did not fit lamp by lamp: washes only
  return { real, shadows: shadowSet };
}

export function nightFactor(elevation: unknown): number {
  if (typeof elevation !== "number" || !Number.isFinite(elevation)) return 0;
  const t = Math.max(0, Math.min(1, (6 - elevation) / 12));
  return t * t * (3 - 2 * t);
}

// Bearing clockwise from model north = HA azimuth + fp.north; plan (x east, y north) → world (x, ·, −y);
// then the model alignment rotation (degrees, counter-clockwise seen from above).
export function sunVector(
  azimuth: number,
  elevation: number,
  north = 0,
  alignRotation = 0,
): [number, number, number] {
  const d = Math.PI / 180;
  const b = (azimuth + north) * d,
    e = elevation * d;
  let px = Math.sin(b) * Math.cos(e),
    py = Math.cos(b) * Math.cos(e);
  const r = alignRotation * d;
  [px, py] = [
    px * Math.cos(r) - py * Math.sin(r),
    px * Math.sin(r) + py * Math.cos(r),
  ];
  return [px, Math.sin(e), -py];
}

// Sun strength factor 0..1: smoothstep(-2, +4 degrees) so the sun is off at / under the horizon.
// A missing elevation is day (1), like nightFactor (0).
export function sunStrength(elevation: unknown): number {
  if (typeof elevation !== "number" || !Number.isFinite(elevation)) return 1;
  const t = Math.max(0, Math.min(1, (elevation + 2) / 6));
  return t * t * (3 - 2 * t);
}

// Never light from underneath: y >= minY, renormalised.
export function clampSunDir<V extends readonly number[] | null | undefined>(
  v: V,
  minY = 0.05,
): V | [number, number, number] {
  if (!v) return v;
  let [x, y, z] = v as readonly number[];
  if (y >= minY) return [x, y, z];
  const h = Math.hypot(x, z);
  if (h < 1e-9) return [0, 1, 0];
  const k = Math.sqrt(1 - minY * minY) / h;
  return [x * k, minY, z * k];
}

export function screenNearest(
  points: readonly ScreenPoint[],
  x: number,
  y: number,
  radius: number,
): string | null {
  let best: string | null = null,
    bd = radius;
  for (const p of points) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (best === null ? d <= radius : d < bd) {
      bd = d;
      best = p.id;
    }
  }
  return best;
}

// Ids of the points within radius px of (x, y), nearest first (ties keep their order).
export function screenByDistance(
  points: readonly ScreenPoint[],
  x: number,
  y: number,
  radius: number,
): string[] {
  return points
    .map((p, i) => ({ id: p.id, i, d: Math.hypot(p.x - x, p.y - y) }))
    .filter((p) => p.d <= radius)
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((p) => p.id);
}

// ---------- magnetic drag ----------
const vec = (v: VecLike): XYZ =>
  Array.isArray(v) ? { x: v[0], y: v[1], z: v[2] } : (v as XYZ);
export const SNAP_OFFSET = 0.05; // markers float 5 cm off the surface they stick to

// A model surface hit ({ point, normal } in card world) -> plan pin 5 cm off the surface along its normal.
export function snapPin(
  hit: { point: VecLike; normal: VecLike },
  floorElevation: number | null | undefined,
  floorId: string,
): { x: number; y: number; z: number; floor_id: string } {
  const p = vec(hit.point),
    n = vec(hit.normal);
  const wx = p.x + n.x * SNAP_OFFSET,
    wy = p.y + n.y * SNAP_OFFSET,
    wz = p.z + n.z * SNAP_OFFSET;
  return { x: wx, y: -wz, z: wy - (floorElevation || 0), floor_id: floorId };
}

// Offset (world metres, mm) of a plan position { x, y, z } on a floor at floorElevation from an anchor.
export function attachOffset(
  anchor: VecLike,
  pos: XYZ,
  floorElevation: number | null | undefined,
): [number, number, number] {
  const a = vec(anchor),
    r = (v: number): number => Math.round(v * 1000) / 1000 || 0;
  return [
    r(pos.x - a.x),
    r((floorElevation || 0) + pos.z - a.y),
    r(-pos.y - a.z),
  ];
}

// Plan position { x, y, z } of an attached marker: anchor + offset, z above floorElevation.
export function attachedPosition(
  anchor: VecLike | null | undefined,
  offset: unknown,
  floorElevation: number | null | undefined,
): XYZ | null {
  if (
    !anchor ||
    !Array.isArray(offset) ||
    offset.length !== 3 ||
    !offset.every(Number.isFinite)
  )
    return null;
  const a = vec(anchor);
  return {
    x: a.x + offset[0],
    y: -(a.z + offset[2]),
    z: a.y + offset[1] - (floorElevation || 0),
  };
}

// The floor a model hit at world height y stands on: the highest floor with elevation <= y + tol, else null.
export function floorAtHeight(
  floors: readonly { id: string; elevation: number }[] | null | undefined,
  y: number,
  tol = 0.05,
): string | null {
  let best: { id: string; elevation: number } | null = null;
  for (const f of floors || [])
    if (f.elevation <= y + tol && (!best || f.elevation > best.elevation))
      best = f;
  return best ? best.id : null;
}
