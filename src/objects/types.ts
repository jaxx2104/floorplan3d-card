// Object types: how a model object looks for its HA state. prepare() once per model load,
// update() when the object's state changed. Real lights come from the layer's fixed pool.
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { lightColor, lightLevel } from "./logic.ts";
import { physicalColor } from "../photometry.ts";
import { findLamp, lampOf, type ModelLamp } from "./model-lamps.ts";
import type { ChainState } from "./logic.ts";
import type { HassEntity } from "../types/ha.ts";
import type { ObjectUi } from "../types/layout.ts";
import type { ManifestLevel, ManifestObject } from "../types/manifest.ts";
import type { RenderSettings } from "../render-recipe.ts";

type Rgb = readonly number[];
type States = Record<string, HassEntity>;
type RawHints = Record<string, unknown> | null | undefined;

/** A manifest object in the card (three.js nodes; tests may leave the node out). */
export type ModelObject = ManifestObject<THREE.Object3D | null>;

/** What the object types need from the view (a narrow interface: tests pass fakes). */
export interface ObjectViewHost {
  objectsGroup: THREE.Object3D;
  render?: Partial<Pick<RenderSettings, "glowIntensityPerBrightness">> | null;
  floorElevation(floorId: string | null | undefined): number;
  _shadowDirty?(): void;
}

export interface PrepareCtx {
  root: THREE.Object3D;
  view?: ObjectViewHost | null;
  levels?: readonly Pick<ManifestLevel, "id" | "elevation">[];
}

export interface UpdateCtx {
  states: States;
  entity: string | null;
  mowerEntity?: string | null;
  /** Physical lamp light (render quality 'high'): photometry.ts physicalColor. */
  physical?: boolean;
  [key: string]: unknown;
}

/** Mower pose on the plan: x / y metres, floor, heading (radians ccw from east), ground (world y) or null. */
export interface MowerPose {
  x: number;
  y: number;
  floorId?: string | null;
  heading?: number | null;
  ground?: number | null;
}

export interface TypeResult {
  lit: boolean;
  level: number;
  color: Rgb | null;
  moved?: boolean;
}

/** hintDefaults(): every hint valid. */
export interface Hints {
  beam: "spot" | "point";
  up: boolean;
  max: number;
  distance: number;
  decay: number;
  angle: number;
  penumbra: number;
  target: number[] | null;
  castShadow: boolean;
  offset: number[] | null;
  /** Luminous flux (lm) at full brightness for physical light (render quality 'high'); null: DEFAULT_LUMENS. */
  lumens: number | null;
  /** Luminous intensity (cd) at full brightness of the model's own lamp (KHR_lights_punctual); before lumens. */
  candela: number | null;
}

/** State every type's part carries (the layer reads these). */
export interface BasePart {
  obj: ModelObject;
  glow: THREE.Mesh | null;
  hints: Hints;
  pool: boolean;
  anchor: THREE.Vector3;
  level?: number;
  color?: Rgb | null;
  glowK?: number;
  root?: THREE.Object3D;
  view?: ObjectViewHost | null;
  label?: CSS2DObject | null;
  text?: string | null;
  moving?: THREE.Object3D | null;
  /** Spot aim point (model root frame), set by the layer. */
  aim?: THREE.Vector3;
  /** The model's lamp node (KHR_lights_punctual, model-lamps.ts): the light's place and aim. */
  lamp?: THREE.Object3D | null;
  /** hints.target is the model lamp's own aim (trusted like hints.target_ok). */
  lampAim?: boolean;
}
interface LightPart extends BasePart {
  level: number;
  color: Rgb | null;
}
interface StatusPart extends LightPart {
  root: THREE.Object3D;
  view: ObjectViewHost | null | undefined;
  levels: readonly Pick<ManifestLevel, "id" | "elevation">[];
  label: CSS2DObject | null;
  text: string | null;
}
interface MowerPart extends StatusPart {
  origin?: {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    localY: number;
  } | null;
}
interface Pleat {
  node: THREE.Object3D;
  dist: number;
  at: RailPoint;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}
interface CoverPart extends BasePart {
  root: THREE.Object3D;
  view: ObjectViewHost | null | undefined;
  moving: THREE.Object3D | null;
  origin: { position: THREE.Vector3; scale: THREE.Vector3 } | null;
  pose: string | null | undefined;
  rail?: Rail | null;
  pleats?: Pleat[];
}

/** One object type: its look per HA state. Method syntax: the layer holds parts of every type as BasePart. */
export interface ObjectType<P extends BasePart = BasePart> {
  prepare(obj: ModelObject, ctx: PrepareCtx): P;
  update(part: P, chain: ChainState, ctx: UpdateCtx): TypeResult;
  dispose(part: P): void;
  place?(part: P, pose: MowerPose | null | undefined): void;
  relayout?(part: P): void;
  inputs?(entity: string): string[];
  defaults: ObjectUi;
}

const fin = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const vec3 = (a: unknown): number[] | null =>
  Array.isArray(a) && a.length === 3 && a.every(fin) ? a.slice() : null;

// Invalid hints fall back to defaults; a down beam is a point light, an up beam a spot aimed up (up: true).
// A model lamp (KHR_lights_punctual) gives the defaults of what the hints leave out: beam, cone, range, candela.
export function hintDefaults(
  hints: unknown,
  lamp: ModelLamp | null = null,
): Hints {
  const h = (hints && typeof hints === "object" ? hints : {}) as Record<
    string,
    unknown
  >;
  const spot =
    h.beam === "spot" ||
    h.beam === "up" ||
    (h.beam === undefined && !!lamp && lamp.beam === "spot");
  const angle = fin(h.angle)
    ? h.angle
    : lamp && fin(lamp.angle)
      ? lamp.angle
      : 24;
  const penumbra =
    fin(h.penumbra) && h.penumbra >= 0 && h.penumbra <= 1
      ? h.penumbra
      : lamp && fin(lamp.penumbra)
        ? Math.min(1, Math.max(0, lamp.penumbra))
        : 0.6;
  return {
    beam: spot ? "spot" : "point",
    up: h.beam === "up",
    max: fin(h.max) && h.max >= 0 ? h.max : 5,
    distance:
      fin(h.distance) && h.distance >= 0
        ? h.distance
        : lamp && lamp.range > 0
          ? lamp.range
          : 0,
    decay: fin(h.decay) && h.decay >= 0 ? h.decay : 2,
    angle: Math.min(80, Math.max(5, angle)),
    penumbra,
    target: vec3(h.target),
    castShadow: typeof h.castShadow === "boolean" ? h.castShadow : true,
    offset: vec3(h.offset),
    lumens: fin(h.lumens) && h.lumens >= 0 ? h.lumens : null,
    candela: lamp && fin(lamp.candela) ? lamp.candela : null,
  };
}

// Glow emissive strength by the glow mesh's size (world bounding-sphere diameter, m): small bulbs at full
// strength, large shades dimmed (they stay coloured instead of blowing out to white).
export const GLOW_REF = 0.12;
export function glowEmissiveScale(size: unknown): number {
  if (!fin(size) || size <= 0) return 1;
  return Math.min(1, Math.max(0.25, Math.pow(GLOW_REF / size, 0.7)));
}

// World bounding-sphere diameter of a mesh (0 without geometry).
function glowSize(mesh: THREE.Mesh): number {
  const g = mesh.geometry;
  if (!g || !g.attributes || !g.attributes.position) return 0;
  g.computeBoundingSphere(); // the true sphere (GLTFLoader's comes from the box: √3 too large for a round bulb)
  mesh.updateWorldMatrix(true, false);
  return g.boundingSphere!.clone().applyMatrix4(mesh.matrixWorld).radius * 2; // computed just above
}

const nameOf = (n: THREE.Object3D): string =>
  (n.userData && (n.userData.name as string | undefined)) || n.name || "";

// First node named `name` (userData.name or name) under node, resolved to a mesh (itself or its first mesh).
export function findGlow(
  node: THREE.Object3D | null | undefined,
  name: string | null | undefined,
): THREE.Mesh | null {
  if (!node || !name) return null;
  const firstMesh = (n: THREE.Object3D): THREE.Mesh | null => {
    if ((n as THREE.Mesh).isMesh) return n as THREE.Mesh;
    for (const c of n.children || []) {
      const m = firstMesh(c);
      if (m) return m;
    }
    return null;
  };
  const find = (n: THREE.Object3D): THREE.Mesh | null => {
    if (nameOf(n) === name || n.name === name) {
      const m = firstMesh(n);
      if (m) return m;
    }
    for (const c of n.children || []) {
      const m = find(c);
      if (m) return m;
    }
    return null;
  };
  return find(node);
}

type GlowMaterial = THREE.Material & {
  emissive?: THREE.Color;
  emissiveIntensity?: number;
};
const matsOf = (mesh: THREE.Mesh): GlowMaterial[] =>
  Array.isArray(mesh.material) ? mesh.material : [mesh.material];

// The anchor in the model root's frame: the model lamp's place, else glow centre, else fp anchor (node frame), else
// node box centre; + hints.offset. Only the node's ancestors and subtree are brought up to date (not the whole model).
function anchorOf(
  obj: ModelObject,
  glow: THREE.Mesh | null,
  root: THREE.Object3D,
  offset: readonly number[] | null,
  lamp: THREE.Object3D | null = null,
): THREE.Vector3 {
  if (obj.node) obj.node.updateWorldMatrix(true, true);
  else root.updateWorldMatrix(true, false);
  const p = new THREE.Vector3();
  const box = new THREE.Box3();
  if (lamp) lamp.getWorldPosition(p);
  else if (glow && !box.setFromObject(glow).isEmpty()) box.getCenter(p);
  // callers only reach here with a node (obj.node ? anchorOf(...) : ...)
  else if (Array.isArray(obj.anchor))
    obj.node!.localToWorld(
      p.set(obj.anchor[0], obj.anchor[1], obj.anchor[2] || 0),
    );
  else if (!box.setFromObject(obj.node!).isEmpty()) box.getCenter(p);
  else obj.node!.getWorldPosition(p);
  root.worldToLocal(p);
  if (offset) p.add(new THREE.Vector3(offset[0], offset[1], offset[2]));
  return p;
}

// A glow mesh can belong to several objects (e.g. two fixtures resolving to one mesh): its material is
// cloned once; every owner writes its level and the mesh shows the strongest owner.
interface GlowEntry {
  original: THREE.Material | THREE.Material[];
  clones: GlowMaterial[];
  owners: Set<BasePart>;
  scale: number;
}
const shared = new WeakMap<THREE.Mesh, GlowEntry>(); // mesh -> { original, clones: Material[], owners: Set<part> }

// Claim a glow mesh for a part: clones its material once, shared between owners.
function claimGlow(part: BasePart, glow: THREE.Mesh | null): void {
  if (!glow) return;
  let entry = shared.get(glow);
  if (!entry) {
    const original = glow.material;
    const clones = matsOf(glow).map((m) => {
      const c: GlowMaterial = m.clone();
      c.userData = {
        ...m.userData,
        baseEmissive: m.emissive ? m.emissive.getHex() : 0,
      };
      if (c.emissive) c.emissive.setRGB(0, 0, 0);
      c.emissiveIntensity = 0;
      return c;
    });
    glow.material = Array.isArray(original) ? clones : clones[0];
    entry = {
      original,
      clones,
      owners: new Set(),
      scale: glowEmissiveScale(glowSize(glow)),
    };
    shared.set(glow, entry);
  }
  entry.owners.add(part);
}

function prepareLight(
  obj: ModelObject,
  { root, view }: PrepareCtx,
  pool: boolean,
): LightPart {
  const lamp = obj.node ? findLamp(obj.node) : null;
  const hints = hintDefaults(obj.hints, lampOf(lamp));
  const glow = obj.node ? findGlow(obj.node, obj.glow || "glow") : null;
  // glow emissive per brightness: the render recipe's glowIntensityPerBrightness (default 3)
  const gi =
    view && view.render ? view.render.glowIntensityPerBrightness : undefined;
  const k = fin(gi) ? gi : 3;
  // anchor: placeholder until computed below (claimGlow does not read it)
  const part: LightPart = {
    obj,
    glow,
    hints,
    pool,
    level: 0,
    color: null,
    anchor: new THREE.Vector3(),
    glowK: k,
    lamp,
  };
  claimGlow(part, glow);
  part.anchor = obj.node
    ? anchorOf(obj, glow, root, hints.offset, lamp)
    : new THREE.Vector3();
  // a model spot aims where the file points it (its -Z axis), 1 m out, unless hints.target says otherwise
  if (lamp && hints.beam === "spot" && !hints.target) {
    const pos = lamp.getWorldPosition(new THREE.Vector3());
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(
      lamp.getWorldQuaternion(new THREE.Quaternion()),
    );
    const tip = root.worldToLocal(pos.clone().add(dir)),
      base = root.worldToLocal(pos);
    hints.target = part.anchor.clone().add(tip.sub(base)).toArray();
    part.lampAim = true;
  }
  return part;
}

function paint(glow: THREE.Mesh | null): void {
  const entry = glow && shared.get(glow);
  if (!entry) return;
  let best: BasePart | null = null;
  for (const p of entry.owners)
    if (!best || (p.level ?? 0) > (best.level ?? 0)) best = p;
  const level = best ? (best.level ?? 0) : 0,
    c = (best && best.color) || [0, 0, 0];
  for (const m of entry.clones) {
    if (m.emissive)
      m.emissive.setRGB(
        c[0] / 255,
        c[1] / 255,
        c[2] / 255,
        THREE.SRGBColorSpace,
      );
    m.emissiveIntensity = level * (best ? (best.glowK ?? 3) : 3) * entry.scale;
  }
}

function updateLight(
  part: LightPart,
  chain: ChainState,
  ctx?: UpdateCtx,
): TypeResult {
  const level = chain.lit
    ? lightLevel(chain.source || { state: "on", attributes: {} })
    : 0;
  const color =
    ctx && ctx.physical
      ? physicalColor(chain.source, lightColor)
      : lightColor(chain.source);
  part.level = level;
  part.color = color;
  paint(part.glow);
  return { lit: level > 0, level, color };
}

function disposeLight(part: BasePart): void {
  const entry = part.glow && shared.get(part.glow);
  if (!entry || !entry.owners.delete(part)) return;
  const glow = part.glow!; // entry exists only for a glow mesh
  if (entry.owners.size) {
    paint(glow);
    return;
  }
  glow.material = entry.original;
  for (const m of entry.clones) m.dispose();
  shared.delete(glow);
}

// ---- status looks: mower / dock / ev_charger / climate ----
// lawn_mower states, plus vacuum's cleaning (a robot vacuum can stand in for the mower)
const MOWER_COLORS: Record<string, Rgb> = {
  mowing: [76, 175, 80],
  cleaning: [76, 175, 80],
  returning: [255, 179, 0],
  error: [244, 67, 54],
};
const CHARGER_COLORS: Record<string, Rgb> = {
  charging: [76, 175, 80],
  ready: [33, 150, 243],
  available: [33, 150, 243],
  error: [244, 67, 54],
  faulted: [244, 67, 54],
};
const CLIMATE_COLORS: Record<string, Rgb> = {
  heating: [255, 120, 60],
  cooling: [80, 160, 255],
};

// Status colour [r,g,b] or null (dim). For dock the value is the mower state; for climate the hvac_action.
export function statusColor(type: string, state: unknown): number[] | null {
  const s = typeof state === "string" ? state : "";
  const tables: Record<string, Record<string, Rgb>> = {
    mower: MOWER_COLORS,
    ev_charger: CHARGER_COLORS,
    climate: CLIMATE_COLORS,
  };
  if (type === "dock")
    return s === "docked" ? MOWER_COLORS.mowing.slice() : null;
  const t = tables[type];
  return t && Object.prototype.hasOwnProperty.call(t, s) ? t[s].slice() : null;
}

const num = (v: unknown): number =>
  typeof v === "number"
    ? v
    : typeof v === "string" && v.trim() !== ""
      ? Number(v)
      : NaN;
const fmt = (v: number): string => String(Math.round(v * 10) / 10);

// The separate power sensors a charger label may read (sensor.<name>_power / _charging_power).
export function chargerInputs(entity: unknown): string[] {
  const base = typeof entity === "string" ? entity.replace(/^[^.]*\./, "") : "";
  return base ? [`sensor.${base}_power`, `sensor.${base}_charging_power`] : [];
}

// Text shown beside an object (CSS2D label) or null: charger power while charging, climate current temperature.
export function objectLabel(
  type: string,
  states: States | null | undefined,
  entity: string | null | undefined,
): string | null {
  const s = entity && states ? states[entity] : null;
  if (!s) return null;
  const a = s.attributes || {};
  if (type === "climate") {
    const t = num(a.current_temperature);
    return Number.isFinite(t)
      ? `${fmt(t)} ${a.temperature_unit || "\u00b0C"}`
      : null;
  }
  if (type === "ev_charger") {
    if (s.state !== "charging") return null;
    const unit = String(a.power_unit || a.unit_of_measurement || "kW");
    for (const k of Object.keys(a)) {
      if (!/power/i.test(k) || /unit/i.test(k)) continue;
      const v = num(a[k]);
      if (Number.isFinite(v)) return `${fmt(v)} ${unit}`;
    }
    // entity and states are set: s was found through them
    for (const e of [entity!, ...chargerInputs(entity)]) {
      const p = states![e];
      const v = p ? num(p.state) : NaN;
      if (
        Number.isFinite(v) &&
        p &&
        p.attributes &&
        p.attributes.unit_of_measurement
      )
        return `${fmt(v)} ${p.attributes.unit_of_measurement}`;
    }
  }
  return null;
}

const stateOf = (
  ctx: UpdateCtx | null | undefined,
  entity: string | null | undefined,
): string | null => {
  const s = entity && ctx && ctx.states ? ctx.states[entity] : null;
  return s ? s.state : null;
};
const ledName = (obj: ModelObject): string =>
  (obj.hints && typeof obj.hints.led === "string" && obj.hints.led) ||
  obj.glow ||
  "led";

function prepareStatus(
  obj: ModelObject,
  ctx: PrepareCtx,
  glowName: string,
  withLabel: boolean,
): StatusPart {
  const glow = obj.node ? findGlow(obj.node, glowName) : null;
  // anchor: placeholder until computed below (claimGlow does not read it)
  const part: StatusPart = {
    obj,
    glow,
    hints: hintDefaults(obj.hints),
    pool: false,
    level: 0,
    color: null,
    anchor: new THREE.Vector3(),
    root: ctx.root,
    view: ctx.view,
    levels: ctx.levels || [],
    label: null,
    text: null,
  };
  claimGlow(part, glow);
  part.anchor = obj.node
    ? anchorOf(obj, glow, ctx.root, part.hints.offset)
    : new THREE.Vector3();
  if (withLabel && ctx.view && typeof document !== "undefined") {
    const el = document.createElement("div");
    el.className = "fp-room-label fp-obj-label";
    const label = new CSS2DObject(el);
    label.center.set(0.5, 1.2);
    label.visible = false;
    ctx.view.objectsGroup.add(label);
    part.label = label;
    relayout(part);
  }
  return part;
}

function updateStatus(part: LightPart, color: Rgb | null): TypeResult {
  part.color = color;
  part.level = color ? 1 : 0;
  paint(part.glow);
  return { lit: false, level: part.level, color };
}

function setLabel(part: StatusPart, text: string | null): void {
  const next = text || null;
  if (next === part.text) return; // no DOM writes when nothing changed
  part.text = next;
  if (part.label) {
    part.label.element.textContent = part.text || "";
    part.label.visible = !!part.text;
  }
}

// The model moved: labels follow their anchor.
function relayout(part: BasePart): void {
  if (part.label && part.root)
    part.label.position.copy(part.root.localToWorld(part.anchor.clone()));
}

function disposeStatus(part: BasePart): void {
  disposeLight(part);
  if (part.label) {
    const el = part.label.element;
    if (part.label.parent) part.label.parent.remove(part.label);
    if (el && el.parentNode) el.parentNode.removeChild(el); // removing the object leaves its element behind
    part.label = null;
  }
}

// hints.front: which local axis of the node is its front; the yaw offset that turns it to the heading.
const FRONT_YAW: Record<string, number> = {
  "+x": 0,
  "-x": Math.PI,
  "+z": Math.PI / 2,
  "-z": -Math.PI / 2,
};
const frontOf = (obj: ModelObject): string =>
  obj.hints &&
  typeof obj.hints.front === "string" &&
  Object.prototype.hasOwnProperty.call(FRONT_YAW, obj.hints.front)
    ? obj.hints.front
    : "+x";

// Mower node: world position from the plan point (x, base + own y offset, -y), turned to its heading. base: the
// ground under it (pose.ground, world y of the lawn) when known, else the HA floor's elevation.
// The node's own transform is remembered and restored on dispose / pose null.
function placeMower(part: MowerPart, pose: MowerPose | null | undefined): void {
  const node = part.obj.node;
  if (!node || !node.parent) return;
  if (!part.origin) {
    node.updateWorldMatrix(true, false);
    const lv = part.levels.find((l) => l.id === part.obj.level);
    const base = lv && fin(lv.elevation) ? lv.elevation : 0; // elevation of the floor the node stands on
    part.origin = {
      position: node.position.clone(),
      quaternion: node.quaternion.clone(),
      localY: node.getWorldPosition(new THREE.Vector3()).y - base,
    };
  }
  if (!pose) {
    restoreMower(part);
    return;
  }
  const parent = node.parent;
  parent.updateWorldMatrix(true, false);
  const base = fin(pose.ground)
    ? pose.ground
    : part.view
      ? part.view.floorElevation(pose.floorId)
      : 0;
  const world = new THREE.Vector3(pose.x, base + part.origin.localY, -pose.y);
  node.position.copy(parent.worldToLocal(world));
  if (fin(pose.heading)) {
    // heading is an absolute plan angle: the node's own forward (+x of the model) turns to it, whatever the model alignment
    const pq = parent.getWorldQuaternion(new THREE.Quaternion());
    const rq = part.root.getWorldQuaternion(new THREE.Quaternion());
    const yaw = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      pose.heading + FRONT_YAW[frontOf(part.obj)],
    );
    node.quaternion.copy(
      pq
        .clone()
        .invert()
        .multiply(yaw)
        .multiply(rq.invert())
        .multiply(pq)
        .multiply(part.origin.quaternion),
    );
  }
  node.updateMatrixWorld(true);
  part.anchor = anchorOf(part.obj, part.glow, part.root, part.hints.offset);
}

function restoreMower(part: MowerPart): void {
  const node = part.obj.node;
  if (!part.origin || !node) return;
  node.position.copy(part.origin.position);
  node.quaternion.copy(part.origin.quaternion);
  node.updateMatrixWorld(true);
  part.origin = null;
  part.anchor = anchorOf(part.obj, part.glow, part.root, part.hints.offset);
}

function disposeMower(part: MowerPart): void {
  restoreMower(part);
  disposeStatus(part);
}

// ---- cover: a curtain gathers, a desk top lifts, following current_position (0 closed .. 100 open) ----
// hints.motion 'gather' (default): the moving part scales along its local hints.axis ('x' | 'y' | 'z', default
// 'x') about its own origin, from 1 at 0 % to hints.min at 100 % (default 0.15): put the origin on the side the
// curtain gathers to. hints.motion 'lift': the moving part rises hints.range[0] metres at 0 % and
// hints.range[1] at 100 % above its modelled pose (negative: lower). The moving part is the child named
// hints.part (default 'moving'), else the whole node. No position (unknown, unavailable): the modelled pose.
// A curtain on a bent rail: hints.path, the rail as [[x, z], ...] metres in the moving part's frame from the
// gathered end. Each child of the moving part (a pleat) keeps its offset from the rail and slides along it to
// scale × its distance from the start, turning with the rail.
const AXES: Record<string, number> = { x: 0, y: 1, z: 2 };

export interface RailSegment {
  x0: number;
  z0: number;
  dx: number;
  dz: number;
  len: number;
  at: number;
}
export interface Rail {
  segs: RailSegment[];
  total: number;
}
export interface RailPoint {
  x: number;
  z: number;
  dx: number;
  dz: number;
}
export type CoverPose = { lift: number } | { axis: string; scale: number };

// Rail helpers for hints.path: valid [[x, z], ...] (2+ points) or null; the point and direction at a
// distance along it (clamped to its ends); the distance of the closest point to (x, z).
export function railOf(path: unknown): Rail | null {
  if (
    !Array.isArray(path) ||
    path.length < 2 ||
    !path.every((q) => Array.isArray(q) && q.length === 2 && q.every(fin))
  )
    return null;
  const segs: RailSegment[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const [x0, z0] = path[i - 1],
      [x1, z1] = path[i];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len <= 0) continue;
    segs.push({
      x0,
      z0,
      dx: (x1 - x0) / len,
      dz: (z1 - z0) / len,
      len,
      at: total,
    });
    total += len;
  }
  return segs.length ? { segs, total } : null;
}

export function railAt(rail: Rail, dist: number): RailPoint {
  const d = Math.min(rail.total, Math.max(0, dist));
  let s = rail.segs[0];
  for (const g of rail.segs) if (d >= g.at) s = g;
  const t = Math.min(s.len, d - s.at);
  return { x: s.x0 + s.dx * t, z: s.z0 + s.dz * t, dx: s.dx, dz: s.dz };
}

export function railDistance(rail: Rail, x: number, z: number): number {
  let best = Infinity,
    out = 0;
  for (const g of rail.segs) {
    const t = Math.min(
      g.len,
      Math.max(0, (x - g.x0) * g.dx + (z - g.z0) * g.dz),
    );
    const e = Math.hypot(g.x0 + g.dx * t - x, g.z0 + g.dz * t - z);
    if (e < best) {
      best = e;
      out = g.at + t;
    }
  }
  return out;
}

// Turn about +y (three.js) from direction a to direction b, both (dx, dz).
const yawBetween = (a: RailPoint, b: RailPoint): number =>
  Math.atan2(-b.dz, b.dx) - Math.atan2(-a.dz, a.dx);
export function coverPose(
  hints: RawHints,
  position: unknown,
): CoverPose | null {
  const h: Record<string, unknown> =
    hints && typeof hints === "object" ? hints : {};
  const pos = num(position);
  if (!Number.isFinite(pos)) return null;
  const t = Math.min(100, Math.max(0, pos)) / 100;
  if (h.motion === "lift") {
    const r =
      Array.isArray(h.range) && h.range.length === 2 && h.range.every(fin)
        ? h.range
        : [0, 0];
    return { lift: r[0] + (r[1] - r[0]) * t };
  }
  const min = fin(h.min) ? Math.min(1, Math.max(0.01, h.min)) : 0.15;
  return {
    axis:
      typeof h.axis === "string" &&
      Object.prototype.hasOwnProperty.call(AXES, h.axis)
        ? h.axis
        : "x",
    scale: 1 - t + min * t,
  };
}

function prepareCover(obj: ModelObject, ctx: PrepareCtx): CoverPart {
  const name =
    (obj.hints && typeof obj.hints.part === "string" && obj.hints.part) ||
    "moving";
  let moving: THREE.Object3D | null = null;
  const node = obj.node;
  if (node)
    node.traverse((n) => {
      if (!moving && n !== node && nameOf(n) === name) moving = n;
    });
  const part: CoverPart = {
    ...generic.prepare(obj, ctx),
    root: ctx.root,
    view: ctx.view,
    moving: moving || obj.node,
    origin: null,
    pose: undefined,
  };
  part.rail = railOf(obj.hints && obj.hints.path);
  const rail = part.rail;
  if (rail && part.moving) {
    // each pleat: its rest pose, distance along the rail and offset from it
    part.pleats = part.moving.children.map((n) => {
      const dist = railDistance(rail, n.position.x, n.position.z),
        at = railAt(rail, dist);
      return {
        node: n,
        dist,
        at,
        position: n.position.clone(),
        quaternion: n.quaternion.clone(),
      };
    });
  }
  return part;
}

function updateCover(
  part: CoverPart,
  chain: ChainState,
  ctx: UpdateCtx,
): TypeResult {
  const s = ctx.entity && ctx.states ? ctx.states[ctx.entity] : null;
  const pose = coverPose(
    part.obj.hints,
    s && s.attributes ? s.attributes.current_position : null,
  );
  const key = pose ? JSON.stringify(pose) : null;
  if (key !== part.pose) {
    part.pose = key;
    placeCover(part, pose);
    if (part.view && part.view._shadowDirty) part.view._shadowDirty(); // the curtain / desk casts elsewhere now
    return { lit: false, level: 0, color: null, moved: true }; // the layer re-anchors objects mounted on it
  }
  return { lit: false, level: 0, color: null };
}

function placeCover(part: CoverPart, pose: CoverPose | null): void {
  const n = part.moving;
  if (!n) return;
  if (!part.origin)
    part.origin = { position: n.position.clone(), scale: n.scale.clone() };
  n.position.copy(part.origin.position);
  n.scale.copy(part.origin.scale);
  if (part.pleats && part.rail) {
    // pleats exist only with a rail
    const k = pose && "scale" in pose ? pose.scale : 1,
      up = new THREE.Vector3(0, 1, 0);
    for (const q of part.pleats) {
      const to = railAt(part.rail, q.dist * k),
        turn = new THREE.Quaternion().setFromAxisAngle(
          up,
          yawBetween(q.at, to),
        );
      const off = q.position
        .clone()
        .sub(new THREE.Vector3(q.at.x, q.position.y, q.at.z))
        .applyQuaternion(turn);
      q.node.position.set(to.x, q.position.y, to.z).add(off);
      q.node.quaternion.copy(turn).multiply(q.quaternion);
    }
  } else if (pose && "scale" in pose)
    n.scale.setComponent(
      AXES[pose.axis],
      part.origin.scale.getComponent(AXES[pose.axis]) * pose.scale,
    );
  if (pose && "lift" in pose && pose.lift && n.parent) {
    // world up by lift metres, in the parent's frame (the model may be scaled and turned)
    n.parent.updateWorldMatrix(true, false);
    const at = n.parent.localToWorld(part.origin.position.clone());
    n.position.copy(
      n.parent.worldToLocal(at.add(new THREE.Vector3(0, pose.lift, 0))),
    );
  }
  n.updateMatrixWorld(true);
}

// A part's anchor again after its node moved (mounted on a cover).
export function reanchor(part: BasePart, root: THREE.Object3D): void {
  if (!part.obj || !part.obj.node) return;
  part.anchor = anchorOf(
    part.obj,
    part.glow,
    root,
    part.hints ? part.hints.offset : null,
    part.lamp || null,
  );
  if (part.label && part.root) relayout(part);
}

function disposeCover(part: CoverPart): void {
  if (part.origin) placeCover(part, null);
}

const generic: ObjectType = {
  prepare: (obj, ctx): BasePart => ({
    obj,
    glow: null,
    hints: hintDefaults(obj.hints),
    pool: false,
    anchor: obj.node
      ? anchorOf(obj, null, ctx.root, null)
      : new THREE.Vector3(),
  }),
  update: () => ({ lit: false, level: 0, color: null }),
  dispose: () => {},
  defaults: {
    tap_action: { action: "more-info" },
    hold_action: { action: "popup" },
    popup: ["state"],
  },
};

// each entry typed with its own part (ObjectType's methods are bivariant, so it widens to ObjectType)
const typed = <P extends BasePart>(t: ObjectType<P>): ObjectType => t;

export const TYPES: Record<string, ObjectType> = {
  light: typed<LightPart>({
    prepare: (obj, ctx) => prepareLight(obj, ctx, true),
    update: updateLight,
    dispose: disposeLight,
    defaults: {
      tap_action: { action: "toggle" },
      hold_action: { action: "popup" },
      popup: ["toggle", "brightness", "color"],
    },
  }),
  light_strip: typed<LightPart>({
    // real light only when the model asks for one (hints.max)
    prepare: (obj, ctx) =>
      prepareLight(
        obj,
        ctx,
        !!obj.hints && fin(obj.hints.max) && obj.hints.max > 0,
      ),
    update: updateLight,
    dispose: disposeLight,
    defaults: {
      tap_action: { action: "toggle" },
      hold_action: { action: "popup" },
      popup: ["toggle", "brightness", "color"],
    },
  }),
  mower: typed<MowerPart>({
    prepare: (obj, ctx) => prepareStatus(obj, ctx, obj.glow || "glow", false),
    update: (part, chain, ctx) =>
      updateStatus(part, statusColor("mower", stateOf(ctx, ctx.entity))),
    place: placeMower,
    dispose: disposeMower,
    defaults: {
      tap_action: { action: "popup" },
      hold_action: { action: "more-info" },
      popup: ["state", "battery", "device", "start", "dock"],
    },
  }),
  dock: typed<StatusPart>({
    prepare: (obj, ctx) => prepareStatus(obj, ctx, ledName(obj), false),
    update: (part, chain, ctx) =>
      updateStatus(part, statusColor("dock", stateOf(ctx, ctx.mowerEntity))),
    dispose: disposeStatus,
    defaults: {
      tap_action: { action: "more-info" },
      hold_action: { action: "more-info" },
      popup: ["state"],
    },
  }),
  ev_charger: typed<StatusPart>({
    prepare: (obj, ctx) => prepareStatus(obj, ctx, ledName(obj), true),
    update: (part, chain, ctx) => {
      const st = stateOf(ctx, ctx.entity);
      setLabel(part, objectLabel("ev_charger", ctx.states, ctx.entity));
      return updateStatus(part, statusColor("ev_charger", st));
    },
    inputs: chargerInputs, // the layer re-evaluates when the power sensor changes
    relayout,
    dispose: disposeStatus,
    defaults: {
      tap_action: { action: "more-info" },
      hold_action: { action: "popup" },
      popup: ["state", "power", "energy"],
    },
  }),
  climate: typed<StatusPart>({
    prepare: (obj, ctx) => prepareStatus(obj, ctx, obj.glow || "glow", true),
    update: (part, chain, ctx) => {
      const s = ctx.entity && ctx.states ? ctx.states[ctx.entity] : null;
      setLabel(part, objectLabel("climate", ctx.states, ctx.entity));
      return updateStatus(
        part,
        statusColor(
          "climate",
          s && s.attributes ? s.attributes.hvac_action : null,
        ),
      );
    },
    relayout,
    dispose: disposeStatus,
    defaults: {
      tap_action: { action: "more-info" },
      hold_action: { action: "popup" },
      popup: ["temperature", "mode"],
    },
  }),
  cover: typed<CoverPart>({
    prepare: prepareCover,
    update: updateCover,
    dispose: disposeCover,
    defaults: {
      tap_action: { action: "toggle" },
      hold_action: { action: "more-info" },
      popup: ["state"],
    },
  }),
  generic,
};

export const typeOf = (type: string): ObjectType =>
  Object.prototype.hasOwnProperty.call(TYPES, type)
    ? TYPES[type]
    : TYPES.generic;
