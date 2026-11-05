// Light probe grids (every render quality; QualityTier.probeSpacing sets their density): the indirect light indoors. The sky
// environment (view/env-light.ts) has no occlusion: every surface gets the sky's fill as if it stood outdoors,
// corners are as bright as the middle of a wall and nothing bounces between walls. So each storey with indoor rooms
// gets one of three's irradiance volumes (LightProbeGridWebGL: a box of L2 spherical-harmonics probes, baked on the
// GPU from cube renders, sampled trilinearly by three's own lights_fragment_begin), over the box of its indoor rooms
// from floor to ceiling, a probe every PROBE_SPACING_M (the tier's spacing). A probe sees the scene as it is lit now (the sun through the
// windows, the lamps that are on, the sky seen through the openings). Three adds a grid's irradiance to the
// material's light; the patched model materials (cloud-shadow.ts, material userData.fpProbe) take it in place of
// the sky environment's diffuse fill instead and dim the sky's reflections by the same ratio (PROBE_BEGIN /
// PROBE_BODY), and a surface with a baked lightmap (lightmap.ts) takes neither.
//
// A probe on the plan's lattice that falls in a wall or right beside one is moved into its room (probeSpot), so it
// does not see through the wall; the grid still interpolates between the probes on both sides of a wall over one
// spacing (the light of a bright room leaks that far into its dark neighbour, see the README).
//
// Rebuilt only when what they see changes: the rooms or the model, the sky environment (it is rebuilt when the sun
// or moon moved > ENV_ANGLE_DEG, clouds, day / night, throttled), a lamp turned on / off or its brightness or colour,
// the light levels (sun, moon, environment) by more than PROBE_LIGHT_STEP. A change starts a pass that
// bakes probes for up to PROBE_BUDGET_MS a frame into a second set of grids and swaps them in at its end; changes during a pass
// make one more pass after it, at most every PROBE_THROTTLE_MS except for rooms and sky.
import * as THREE from "three";
import { LightProbeGridWebGL } from "three/addons/lighting/LightProbeGridWebGL.js";
import { insidePolygon } from "./lightmap.ts";
import type { PlanPoint } from "./types/layout.ts";

/** Storeys with a grid at most (a grid is a 3D texture unit in every lit shader). */
export const PROBE_MAX_FLOORS = 4;
/** Default probe spacing (m) across the plan (the tiers set theirs), probes per axis at most, probe layers per storey. */
export const PROBE_SPACING_M = 0.5;
export const PROBE_MAX_AXIS = 32;
export const PROBE_LAYERS = 1;
/** A probe keeps this far (m) from its room's walls (the wall's thickness and a little air). */
export const PROBE_INSET_M = 0.2;
/** Cube face size (px) of a probe's capture: SH L2 keeps only the broad light, 16 px still sees a window. */
export const PROBE_CUBE = 16;
/** While a pass runs, a frame bakes PROBE_CHUNK probes at a time until PROBE_BUDGET_MS (at least one chunk). */
export const PROBE_CHUNK = 8;
export const PROBE_BUDGET_MS = 6;
/** Gain of the captured light (the capture sees the direct light of the walls once: one bounce). */
export const PROBE_GAIN = 0.5;
/** Light level change (relative) that asks for a rebuild. */
export const PROBE_LIGHT_STEP = 0.1;
/** Minimum time (ms) between passes for lamp / light level changes. */
export const PROBE_THROTTLE_MS = 2000;

/** An indoor room with probes: its key, plan polygon, storey and world floor / top height. */
export interface ProbeRoom {
  key: string;
  polygon: PlanPoint[];
  storey: number;
  y0: number;
  y1: number;
}
/** The storey heights (world y). */
export interface ProbeStorey {
  y0: number;
  y1: number;
}
/** A storey's grid: world centre and size, probes per axis (x, y, z), and the plan point each probe captures at
 * (x / y per column ix + nx * iz). */
export interface ProbeGridSpec {
  storey: number;
  center: [number, number, number];
  size: [number, number, number];
  res: [number, number, number];
  spots: PlanPoint[];
}

type RoomIn = {
  room: { id: string; polygon?: PlanPoint[] | null; outdoor?: boolean };
  floorId: string;
};
type FloorIn = { id: string; elevation: number; height?: number };

// The rooms that get probes: indoor rooms (not outdoor zones) with a polygon on a known floor, on the lowest
// PROBE_MAX_FLOORS storeys that have such rooms.
export function probeRooms(
  rooms: readonly RoomIn[] | null | undefined,
  floors: readonly FloorIn[] | null | undefined,
): { rooms: ProbeRoom[]; storeys: ProbeStorey[] } {
  const fl = new Map((floors || []).map((f) => [f.id, f]));
  const usable = (rooms || []).filter(
    (r) =>
      r.room &&
      !r.room.outdoor &&
      r.room.polygon &&
      r.room.polygon.length >= 3 &&
      fl.has(r.floorId) &&
      Number.isFinite(fl.get(r.floorId)!.elevation),
  );
  const ids = [...new Set(usable.map((r) => r.floorId))]
    .sort((a, b) => fl.get(a)!.elevation - fl.get(b)!.elevation)
    .slice(0, PROBE_MAX_FLOORS);
  const storeys = ids.map((id) => {
    const f = fl.get(id)!,
      h = f.height && f.height > 0 ? f.height : 2.7;
    return { y0: f.elevation, y1: f.elevation + h };
  });
  const out: ProbeRoom[] = [];
  for (const r of usable) {
    const s = ids.indexOf(r.floorId);
    if (s < 0) continue;
    const { y0, y1 } = storeys[s];
    out.push({
      key: r.room.id,
      polygon: r.room.polygon!.map((p): PlanPoint => [p[0], p[1]]),
      storey: s,
      y0,
      y1,
    });
  }
  return { rooms: out, storeys };
}

// Nearest point of segment a-b to p, and its distance.
const nearestOnEdge = (
  x: number,
  y: number,
  [ax, ay]: readonly number[],
  [bx, by]: readonly number[],
): [number, number, number] => {
  const dx = bx - ax,
    dy = by - ay,
    l = dx * dx + dy * dy;
  const t = l
    ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l))
    : 0;
  const qx = ax + t * dx,
    qy = ay + t * dy;
  return [qx, qy, Math.hypot(x - qx, y - qy)];
};

// Where the probe at plan point (x, y) captures: in the room it lies in (or, in a wall's thickness, the nearest
// room within inset), at least inset from that room's edges (pushed off the nearest edge, twice for a corner);
// a point away from every room (outdoors, in an L-shaped plan's notch) stays where it is.
export function probeSpot(
  x: number,
  y: number,
  polygons: readonly (readonly (readonly number[])[])[],
  inset = PROBE_INSET_M,
): PlanPoint {
  let poly = polygons.find((p) => insidePolygon(x, y, p));
  if (!poly) {
    let best = inset;
    for (const p of polygons)
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const d = nearestOnEdge(x, y, p[j], p[i])[2];
        if (d < best) {
          best = d;
          poly = p;
        }
      }
    if (!poly) return [x, y];
  }
  let px = x,
    py = y;
  for (let k = 0; k < 3; k++) {
    let q: [number, number, number] | null = null;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const e = nearestOnEdge(px, py, poly[j], poly[i]);
      if (!q || e[2] < q[2]) q = e;
    }
    const inside = insidePolygon(px, py, poly);
    if (!q || (inside && q[2] >= inset - 1e-6)) break;
    // away from the edge, into the room: along the edge's normal through the point (the other way when outside)
    let nx = px - q[0],
      ny = py - q[1];
    const l = Math.hypot(nx, ny);
    if (l < 1e-9) break;
    nx /= l;
    ny /= l;
    if (!inside) {
      nx = -nx;
      ny = -ny;
    }
    px = q[0] + nx * inset;
    py = q[1] + ny * inset;
  }
  return [px, py];
}

// The grid of each storey: over the plan box of its indoor rooms (no margin: an outer wall's outside face, read
// half a spacing out along its normal, falls outside the box and keeps the sky), floor to ceiling, a probe every
// spacing (at most PROBE_MAX_AXIS a side), PROBE_LAYERS high. skip: storeys without a grid.
export function probeGrids(
  rooms: readonly ProbeRoom[],
  storeys: readonly ProbeStorey[],
  skip: ReadonlySet<number> = new Set(),
  spacing: number = PROBE_SPACING_M,
): ProbeGridSpec[] {
  const out: ProbeGridSpec[] = [];
  storeys.forEach((s, k) => {
    if (skip.has(k)) return;
    const polys = rooms.filter((r) => r.storey === k).map((r) => r.polygon);
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const p of polys)
      for (const [x, y] of p) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    if (!Number.isFinite(minX) || maxX - minX < 1e-3 || maxY - minY < 1e-3)
      return;
    const w = maxX - minX,
      d = maxY - minY,
      y0 = s.y0 - 0.02,
      h = s.y1 + 0.02 - y0;
    const n = (len: number) =>
      Math.max(1, Math.min(PROBE_MAX_AXIS, Math.round(len / spacing)));
    const nx = n(w),
      nz = n(d);
    const spots: PlanPoint[] = [];
    // world z = -plan y, so grid row iz runs from the plan's north (max y) southwards
    for (let iz = 0; iz < nz; iz++)
      for (let ix = 0; ix < nx; ix++)
        spots.push(
          probeSpot(
            minX + ((ix + 0.5) / nx) * w,
            maxY - ((iz + 0.5) / nz) * d,
            polys,
          ),
        );
    out.push({
      storey: k,
      center: [(minX + maxX) / 2, y0 + h / 2, -(minY + maxY) / 2],
      size: [w, h, d],
      res: [nx, PROBE_LAYERS, nz],
      spots,
    });
  });
  return out;
}

/** What the probes saw: the rooms (and model), sky builds, lamps (per grid, then the ones in no grid's storey),
 * light levels. */
export interface ProbeInputs {
  rooms: string;
  sky: number;
  lamps: string[];
  light: string;
}
export type ProbeReason = "rooms" | "sky" | "lamps" | "light";

// A light level in PROBE_LIGHT_STEP steps (0 for off).
export const lightStep = (v: number): number =>
  v > 1e-4 ? Math.round(Math.log(v) / Math.log(1 + PROBE_LIGHT_STEP)) : -9999;

type Lamp = {
  intensity: number;
  color: { getHex(): number };
  position: { x: number; y: number; z: number };
  visible?: boolean;
};
// Lamp signature: the lights that are on (intensity step, colour, position to 10 cm), in order.
export function lampKey(lights: readonly Lamp[]): string {
  return lights
    .filter((l) => l.visible !== false && l.intensity > 1e-4)
    .map(
      (l) =>
        `${lightStep(l.intensity)}:${l.color.getHex().toString(16)}:${Math.round(l.position.x * 10)},${Math.round(l.position.y * 10)},${Math.round(l.position.z * 10)}`,
    )
    .join(";");
}
// Lamp signatures per storey height range [y0, y1] (world y), then of the lamps in none of them.
export function lampKeys(
  lights: readonly Lamp[],
  ranges: readonly (readonly [number, number])[],
): string[] {
  const at = (l: Lamp) =>
    ranges.findIndex(([y0, y1]) => l.position.y >= y0 && l.position.y <= y1);
  return [
    ...ranges.map((_, i) => lampKey(lights.filter((l) => at(l) === i))),
    lampKey(lights.filter((l) => at(l) < 0)),
  ];
}

// Why a rebuild is due (null: the probes still hold). Rooms and the sky come first (they rebuild at once).
export function probeDue(
  built: ProbeInputs | null,
  next: ProbeInputs,
): ProbeReason | null {
  if (!built || built.rooms !== next.rooms) return "rooms";
  if (built.sky !== next.sky) return "sky";
  if (built.lamps.join("|") !== next.lamps.join("|")) return "lamps";
  if (built.light !== next.light) return "light";
  return null;
}
// The grids a pass rebakes: every grid, but only those whose storey's lamps changed when nothing else did (a
// lamp in no storey, e.g. on the facade, counts for all).
export function probeTargets(
  built: ProbeInputs | null,
  next: ProbeInputs,
  grids: number,
): number[] {
  const all = Array.from({ length: grids }, (_, i) => i);
  if (
    !built ||
    built.rooms !== next.rooms ||
    built.sky !== next.sky ||
    built.light !== next.light ||
    built.lamps.length !== grids + 1 ||
    next.lamps.length !== grids + 1 ||
    built.lamps[grids] !== next.lamps[grids]
  )
    return all;
  return all.filter((i) => built.lamps[i] !== next.lamps[i]);
}
// Rooms and sky now (the environment has its own throttle), lamps and light levels at most every PROBE_THROTTLE_MS.
export const probeWait = (
  why: ProbeReason,
  lastAt: number,
  now: number,
): number =>
  why === "rooms" || why === "sky"
    ? 0
    : Math.max(0, lastAt + PROBE_THROTTLE_MS - now);

/** Uniforms the patched materials read (shared, see makeCloudUniforms): 1 once the grids hold a bake. */
export interface ProbeUniforms {
  fpProbeOn: THREE.IUniform<number>;
}
export function makeProbeUniforms(): ProbeUniforms {
  return { fpProbeOn: { value: 0 } };
}

// three's grid sampling in lights_fragment_begin, as the patched materials compile it: the grid's irradiance kept
// apart (fpGridE, used by PROBE_BODY) instead of added to the light, and skipped under a baked lightmap. -> null
// when three changed the chunk (no grids then rather than a broken shader).
const GRID_IF = "#if NUM_LIGHT_PROBE_GRIDS > 0";
const GRID_ADD = "irradiance += getLightProbeGridIrradiance(";
export function probeBegin(chunk: string): string | null {
  if (chunk.split(GRID_IF).length !== 2 || chunk.split(GRID_ADD).length !== 2)
    return null;
  return chunk
    .replace(
      GRID_IF,
      `vec3 fpGridE = vec3( 0.0 );\n#if NUM_LIGHT_PROBE_GRIDS > 0 && ! defined( USE_LIGHTMAP )`,
    )
    .replace(GRID_ADD, "fpGridE = getLightProbeGridIrradiance(");
}

const LUMA = "vec3( 0.2126, 0.7152, 0.0722 )";
// after #include <lights_pars_begin>
export const PROBE_HEAD = /* glsl */ `
uniform float fpProbeOn;
`;
// after #include <lights_fragment_maps>: inside a grid its irradiance in place of the sky environment's diffuse
// fill, the sky's reflections dimmed as much; a baked lightmap (lightmap.ts) is the surface's ambient light
// instead of both
export const PROBE_BODY = /* glsl */ `
#if defined( RE_IndirectDiffuse ) && defined( STANDARD )
  #ifdef USE_LIGHTMAP
  iblIrradiance = vec3( 0.0 );
  #elif NUM_LIGHT_PROBE_GRIDS > 0
  if ( probeGrid >= 0 && fpProbeOn > 0.0 ) {
    vec3 fpE = ${PROBE_GAIN.toFixed(2)} * fpGridE;
    float fpK = dot( fpE, ${LUMA} ) / max( dot( iblIrradiance, ${LUMA} ), 1e-4 );
    irradiance += fpE;
    iblIrradiance = vec3( 0.0 );
    #if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
    radiance *= clamp( fpK, 0.0, 1.0 );
    #endif
  }
  #endif
#endif
`;

/** The probe set's rooms: rooms, storeys, storeys without a grid (all their rooms baked). */
export interface ProbeSetup {
  rooms: ProbeRoom[];
  storeys: ProbeStorey[];
  skip: ReadonlySet<number>;
  /** probe spacing (m): the quality tier's */
  spacing?: number;
}

// One storey's grid: three's grid whose probes capture at their spots (moved off the walls) rather than on the
// lattice; the lattice is still where the shader places their values.
export class StoreyGrid extends LightProbeGridWebGL {
  spec: ProbeGridSpec;
  constructor(spec: ProbeGridSpec) {
    super(...spec.size, ...spec.res);
    this.spec = spec;
    this.name = `fp-probes-${spec.storey}`;
    this.position.set(...spec.center);
    this.updateBoundingBox();
  }
  getProbePosition(
    ix: number,
    iy: number,
    iz: number,
    target: THREE.Vector3,
  ): THREE.Vector3 {
    super.getProbePosition(ix, iy, iz, target);
    const s = this.spec.spots[ix + this.spec.res[0] * iz];
    if (s) target.set(s[0], target.y, -s[1]);
    return target;
  }
}

let black: THREE.Data3DTexture | null = null;
// A black 1 x 1 x 1 volume: a grid without a bake yet, and the live grids while a pass captures (one bounce, no
// feedback). The grid count, which is in every lit program, stays the same.
function blackVolume(): THREE.Data3DTexture {
  if (black) return black;
  black = new THREE.Data3DTexture(new Uint16Array(4), 1, 1, 1);
  black.type = THREE.HalfFloatType;
  black.needsUpdate = true;
  return black;
}

// The grids of the storeys and their passes. capture(bake) runs bake() with the scene set up for a capture (the
// view hides its overlays and shows the whole house); bake renders the scene into the probes.
export class LightProbes {
  renderer: THREE.WebGLRenderer;
  uniforms: ProbeUniforms;
  /** the live grids (in the scene); a pass bakes the spare set and swaps */
  group: THREE.Group;
  stats: { captures: number; passes: number };
  setup: ProbeSetup | null;
  /** inputs of the pass in progress or the last one (null: none yet) */
  inputs: ProbeInputs | null;
  /** inputs waiting for a pass and when it may start */
  pending: ProbeInputs | null;
  live: StoreyGrid[];
  spare: StoreyGrid[];
  _dueAt: number;
  _at: number;
  /** the pass in progress: the next grid and probe to bake */
  _queue: { grids: number[]; grid: number; probe: number } | null;
  _timer: ReturnType<typeof setTimeout> | null;
  _onDue: () => void;
  _disposed: boolean;

  constructor(
    renderer: THREE.WebGLRenderer,
    uniforms: ProbeUniforms,
    onDue: () => void,
  ) {
    this.renderer = renderer;
    this.uniforms = uniforms;
    this.group = new THREE.Group();
    this.group.name = "fp-light-probes";
    this.stats = { captures: 0, passes: 0 };
    this.setup = null;
    this.inputs = null;
    this.pending = null;
    this.live = [];
    this.spare = [];
    this._dueAt = 0;
    this._at = -Infinity;
    this._queue = null;
    this._timer = null;
    this._onDue = onDue;
    this._disposed = false;
  }

  /** Probes a pass of every grid bakes. */
  get size(): number {
    return this.spare.reduce(
      (n, g) => n + g.resolution.x * g.resolution.y * g.resolution.z,
      0,
    );
  }

  /** The world height range of each grid (for lampKeys). */
  ranges(): [number, number][] {
    return this.live.map((g) => [g.boundingBox.min.y, g.boundingBox.max.y]);
  }

  // New rooms: new grids (black until the next pass; the materials use the sky meanwhile).
  setRooms(setup: ProbeSetup): void {
    this._abort();
    this._free();
    this.setup = setup;
    this.uniforms.fpProbeOn.value = 0;
    const specs = probeGrids(
      setup.rooms,
      setup.storeys,
      setup.skip,
      setup.spacing,
    );
    this.live = specs.map((s) => new StoreyGrid(s));
    this.spare = specs.map((s) => new StoreyGrid(s));
    for (const g of this.live) {
      g.texture = blackVolume();
      this.group.add(g);
    }
  }

  // What the probes would see now: a pass when it differs (at once for rooms / sky, else throttled).
  request(next: ProbeInputs, now = performance.now()): ProbeReason | null {
    const ref = this.pending || this.inputs;
    const why = probeDue(ref, next);
    if (!why) return null;
    const wait = probeWait(why, this._at, now);
    // a later change never makes an earlier-due pass wait longer
    this._dueAt = this.pending ? Math.min(this._dueAt, now + wait) : now + wait;
    this.pending = next;
    if (this._dueAt > now && !this._timer && !this._queue)
      this._timer = setTimeout(() => {
        this._timer = null;
        this._onDue();
      }, this._dueAt - now);
    return why;
  }

  // After a frame: start a due pass, bake its next probes (PROBE_CHUNK at a time for up to PROBE_BUDGET_MS by
  // clock). -> the probes baked.
  step(
    capture: (bake: (scene: THREE.Scene) => void) => void,
    now = performance.now(),
    clock: () => number = () => performance.now(),
  ): number {
    if (this._disposed || !this.setup) return 0;
    if (!this._queue) {
      if (!this.pending) return 0;
      if (now < this._dueAt) {
        if (!this._timer)
          this._timer = setTimeout(() => {
            this._timer = null;
            this._onDue();
          }, this._dueAt - now);
        return 0;
      }
      const grids = probeTargets(
        this.on ? this.inputs : null,
        this.pending,
        this.spare.length,
      );
      this.inputs = this.pending;
      this.pending = null;
      this._at = now;
      if (!grids.length) {
        this.stats.passes++;
        return 0;
      }
      this._queue = { grids, grid: 0, probe: 0 };
    }
    const q = this._queue,
      t0 = clock();
    let baked = 0;
    const textures = this.live.map((g) => g.texture);
    const on = this.uniforms.fpProbeOn.value;
    for (const g of this.live) g.texture = blackVolume();
    this.uniforms.fpProbeOn.value = 0;
    try {
      capture((scene) => {
        do {
          const grid = this.spare[q.grids[q.grid]],
            total = grid.resolution.x * grid.resolution.y * grid.resolution.z,
            count = Math.min(PROBE_CHUNK, total - q.probe);
          grid.bake(this.renderer, scene, {
            start: q.probe,
            count,
            cubemapSize: PROBE_CUBE,
            near: 0.05,
            far: 500,
          });
          baked += count;
          q.probe += count;
          if (q.probe >= total) {
            q.grid++;
            q.probe = 0;
          }
        } while (q.grid < q.grids.length && clock() - t0 < PROBE_BUDGET_MS);
      });
    } finally {
      this.live.forEach((g, i) => (g.texture = textures[i]));
      this.uniforms.fpProbeOn.value = on;
    }
    this.stats.captures += baked;
    if (q.grid >= q.grids.length) this._commit();
    else this._onDue();
    return baked;
  }

  /** The grids hold a bake. */
  get on(): boolean {
    return this.uniforms.fpProbeOn.value > 0;
  }

  // The pass is done: its baked grids replace the live ones (same count: no recompile).
  _commit(): void {
    const q = this._queue!;
    this._queue = null;
    for (const i of q.grids) {
      const was = this.live[i];
      this.group.remove(was);
      this.live[i] = this.spare[i];
      this.spare[i] = was;
      this.group.add(this.live[i]);
    }
    this.uniforms.fpProbeOn.value = 1;
    this.stats.passes++;
    this._onDue(); // a frame with the new light (and a change that came in during the pass)
  }

  // Drop a pass in progress.
  _abort(): void {
    this._queue = null;
  }

  _free(): void {
    for (const g of [...this.live, ...this.spare]) {
      g.removeFromParent();
      if (g.texture === black) g.texture = null; // the shared volume is not the grid's own
      g.dispose();
    }
    this.live = [];
    this.spare = [];
  }

  /** A pass is running or due. */
  get active(): boolean {
    return !!this._queue || !!this.pending;
  }

  dispose(): void {
    this._disposed = true;
    this._abort();
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._free();
    this.group.removeFromParent();
    this.uniforms.fpProbeOn.value = 0;
    this.setup = null;
  }
}
