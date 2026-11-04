// Per-room light probes (render quality 'high', QualityTier.lightProbes): the indirect light of each indoor room.
// The sky environment (view/env-light.ts) has no occlusion: every surface gets the sky's fill as if it stood
// outdoors, corners are as bright as the middle of a wall and nothing bounces between walls. So, per room, a small
// cube capture from the room's middle at half its height renders the scene as it is lit now (the sun through the
// windows, the lamps that are on, the sky seen through the openings) and three's LightProbeGenerator projects it to
// L2 spherical harmonics. The patched model materials (cloud-shadow.ts, material userData.fpProbe) look the room up
// and take that room's irradiance in place of the sky environment's diffuse fill, and dim the sky's reflections by
// the same ratio.
//
// Why per fragment and not three's LightProbe: a LightProbe in the scene is global (one set of coefficients for
// every material), and a material per room would split the merged static meshes (merge.ts groups by material) and
// fail for a floor or wall material shared by several rooms. So one texture holds both a room map (per storey, the
// room under each 10 cm of plan) and the coefficients of every room; the shader finds the storey by height, the
// room by texelFetch (no filtering: an id is exact) at the fragment's position pushed PROBE_PUSH_M along its normal
// (a wall face belongs to the room it faces), then evaluates the SH with three's shGetIrradianceAt. One texture
// unit, uniforms only after the one-time patch, a few texel fetches per pixel indoors.
//
// Rebuilt only when what they see changes: the rooms or the model, the sky environment (it is rebuilt when the sun
// or moon moved > ENV_ANGLE_DEG, clouds, day / night, throttled), a lamp turned on / off or its brightness or colour,
// the light levels (sun, moon, hemisphere, environment) by more than PROBE_LIGHT_STEP. A change starts a pass that
// captures one room per frame (the read-back is asynchronous) and swaps all rooms in at its end; changes during a
// pass make one more pass after it, at most every PROBE_THROTTLE_MS except for rooms and sky.
import * as THREE from 'three';
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js';
import { insidePolygon } from './lightmap.ts';
import type { PlanPoint, Vec3 } from './types/layout.ts';

/** Rooms with a probe at most, and storeys. */
export const PROBE_MAX = 32;
export const PROBE_MAX_FLOORS = 4;
/** Cube face size (px) of a capture: SH L2 keeps only the broad light, 32 px still sees a window. */
export const PROBE_CUBE = 32;
/** Room map texel (m) and its size bound (px per side). */
export const PROBE_TEXEL_M = 0.1;
export const PROBE_MAP_MAX = 256;
/** Margin (m) around the rooms of the room map. */
export const PROBE_MARGIN_M = 0.3;
/** Lookup offset (m) along the surface normal (x / z): a wall face reads the room it faces. */
export const PROBE_PUSH_M = 0.15;
/** Room occlusion of the indirect light: rays (plan) per texel, their reach (m), the light left in a corner, and
 * the light left at a wall's foot / top (vertical faces, fading over PROBE_EDGE_M). */
export const PROBE_RAYS = 12;
export const PROBE_REACH_M = 1.2;
export const PROBE_AO_MIN = 0.3;
export const PROBE_EDGE_MIN = 0.55;
export const PROBE_EDGE_M = 0.6;
/** Gain of the captured light (the capture sees the direct light of the walls once: one bounce). */
export const PROBE_GAIN = 0.5;
/** Light level change (relative) that asks for a rebuild. */
export const PROBE_LIGHT_STEP = 0.1;
/** Minimum time (ms) between passes for lamp / light level changes. */
export const PROBE_THROTTLE_MS = 2000;

/** An indoor room with a probe: its key, plan polygon, storey, world floor / top height and capture point. */
export interface ProbeRoom { key: string; polygon: PlanPoint[]; storey: number; y0: number; y1: number; point: Vec3 }
/** The storey heights of the room map lookup (world y). */
export interface ProbeStorey { y0: number; y1: number }
/** Room map frame: world x / z bounds. */
export interface ProbeFrame { minX: number; minZ: number; sizeX: number; sizeZ: number }

const area2 = (poly: readonly (readonly number[])[]): number => {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a;
};
const edgeDist = (x: number, y: number, poly: readonly (readonly number[])[]): number => {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i], dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l)) : 0;
    d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return d;
};

// Capture point (plan) of a room: the polygon's centroid when it lies inside and away from the walls (>= 0.4 m or
// a third of the best), else the point of a 16 x 16 grid furthest from the walls (an L-shaped room's elbow).
export function probePoint(polygon: readonly (readonly number[])[]): PlanPoint {
  const a = area2(polygon);
  let cx = 0, cy = 0;
  if (Math.abs(a) > 1e-9) {
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [x0, y0] = polygon[j], [x1, y1] = polygon[i], k = x0 * y1 - x1 * y0;
      cx += (x0 + x1) * k;
      cy += (y0 + y1) * k;
    }
    cx /= 3 * a;
    cy /= 3 * a;
  } else {
    cx = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
    cy = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of polygon) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  let best: PlanPoint = [cx, cy], bestD = -1;
  const N = 16;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = minX + ((i + 0.5) / N) * (maxX - minX), y = minY + ((j + 0.5) / N) * (maxY - minY);
      if (!insidePolygon(x, y, polygon)) continue;
      const d = edgeDist(x, y, polygon);
      if (d > bestD) { bestD = d; best = [x, y]; }
    }
  }
  if (insidePolygon(cx, cy, polygon)) {
    const d = edgeDist(cx, cy, polygon);
    if (d >= Math.min(0.4, bestD / 3) || bestD < 0) return [cx, cy];
  }
  return best;
}

type RoomIn = { room: { id: string; polygon?: PlanPoint[] | null; outdoor?: boolean }; floorId: string };
type FloorIn = { id: string; elevation: number; height?: number };

// The rooms that get a probe: indoor rooms (not outdoor zones) with a polygon on a known floor, on the lowest
// PROBE_MAX_FLOORS storeys that have such rooms, at most PROBE_MAX; each captured at half its storey's height.
export function probeRooms(rooms: readonly RoomIn[] | null | undefined, floors: readonly FloorIn[] | null | undefined): { rooms: ProbeRoom[]; storeys: ProbeStorey[] } {
  const fl = new Map((floors || []).map((f) => [f.id, f]));
  const usable = (rooms || []).filter((r) => r.room && !r.room.outdoor && r.room.polygon && r.room.polygon.length >= 3 && fl.has(r.floorId) && Number.isFinite(fl.get(r.floorId)!.elevation));
  const ids = [...new Set(usable.map((r) => r.floorId))].sort((a, b) => fl.get(a)!.elevation - fl.get(b)!.elevation).slice(0, PROBE_MAX_FLOORS);
  const storeys = ids.map((id) => { const f = fl.get(id)!, h = f.height && f.height > 0 ? f.height : 2.7; return { y0: f.elevation, y1: f.elevation + h }; });
  const out: ProbeRoom[] = [];
  for (const r of usable) {
    const s = ids.indexOf(r.floorId);
    if (s < 0 || out.length >= PROBE_MAX) continue;
    const { y0, y1 } = storeys[s], polygon = r.room.polygon!.map((p): PlanPoint => [p[0], p[1]]), [px, py] = probePoint(polygon);
    out.push({ key: r.room.id, polygon, storey: s, y0, y1, point: [px, (y0 + y1) / 2, -py] });
  }
  return { rooms: out, storeys };
}

// Room map frame (world x / z) around the rooms' polygons, or null without rooms.
export function probeFrame(rooms: readonly ProbeRoom[]): ProbeFrame | null {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const r of rooms) for (const [x, y] of r.polygon) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, -y); maxZ = Math.max(maxZ, -y); }
  if (!Number.isFinite(minX)) return null;
  const m = PROBE_MARGIN_M;
  return { minX: minX - m, minZ: minZ - m, sizeX: maxX - minX + 2 * m, sizeZ: maxZ - minZ + 2 * m };
}

// Tile size (px) of the room map for a frame: PROBE_TEXEL_M texels, at most PROBE_MAP_MAX a side.
export function probeTile(frame: ProbeFrame): { w: number; h: number } {
  const k = Math.max(frame.sizeX, frame.sizeZ) / PROBE_TEXEL_M > PROBE_MAP_MAX ? PROBE_MAP_MAX / Math.max(frame.sizeX, frame.sizeZ) : 1 / PROBE_TEXEL_M;
  return { w: Math.max(1, Math.ceil(frame.sizeX * k)), h: Math.max(1, Math.ceil(frame.sizeZ * k)) };
}

// Room ids (index + 1, 0: no probe) per texel of the room map: storeys side by side (tile w x h each), row j at
// world z = minZ + (j + 0.5) / h x sizeZ. skip: rooms without a probe (baked). -> w x storeys by h values.
export function roomIdGrid(rooms: readonly ProbeRoom[], storeys: number, frame: ProbeFrame, tile: { w: number; h: number }, skip: ReadonlySet<number> = new Set()): Uint16Array {
  const W = tile.w * storeys, out = new Uint16Array(W * tile.h);
  rooms.forEach((r, k) => {
    if (skip.has(k)) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of r.polygon) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const i0 = Math.max(0, Math.floor(((minX - frame.minX) / frame.sizeX) * tile.w)), i1 = Math.min(tile.w - 1, Math.ceil(((maxX - frame.minX) / frame.sizeX) * tile.w));
    const j0 = Math.max(0, Math.floor(((-maxY - frame.minZ) / frame.sizeZ) * tile.h)), j1 = Math.min(tile.h - 1, Math.ceil(((-minY - frame.minZ) / frame.sizeZ) * tile.h));
    for (let j = j0; j <= j1; j++) {
      const y = -(frame.minZ + ((j + 0.5) / tile.h) * frame.sizeZ);
      for (let i = i0; i <= i1; i++) {
        const x = frame.minX + ((i + 0.5) / tile.w) * frame.sizeX;
        if (insidePolygon(x, y, r.polygon)) out[j * W + r.storey * tile.w + i] = k + 1;
      }
    }
  });
  return out;
}

// Openness of the plan around each texel of the room map (the walls of its storey: every room edge): the mean
// share of PROBE_RAYS rays that run PROBE_REACH_M without meeting a wall. 1 in the open middle of a room, about 0.5
// beside a straight wall, about 0.25 in a corner; 0 outside the rooms (unused there). Same layout as roomIdGrid.
export function roomOpenness(rooms: readonly ProbeRoom[], storeys: number, frame: ProbeFrame, tile: { w: number; h: number }, ids: Uint16Array): Float32Array {
  const W = tile.w * storeys, out = new Float32Array(W * tile.h), R = PROBE_REACH_M;
  const dirs = Array.from({ length: PROBE_RAYS }, (_, k) => [Math.cos(((k + 0.5) / PROBE_RAYS) * 2 * Math.PI), Math.sin(((k + 0.5) / PROBE_RAYS) * 2 * Math.PI)]);
  for (let s = 0; s < storeys; s++) {
    const edges: number[][] = [];
    for (const r of rooms) {
      if (r.storey !== s) continue;
      r.polygon.forEach((a, i) => { const b = r.polygon[(i + 1) % r.polygon.length]; edges.push([a[0], a[1], b[0], b[1]]); });
    }
    for (let j = 0; j < tile.h; j++) {
      const y = -(frame.minZ + ((j + 0.5) / tile.h) * frame.sizeZ);
      for (let i = 0; i < tile.w; i++) {
        const at = j * W + s * tile.w + i;
        if (!ids[at]) continue;
        const x = frame.minX + ((i + 0.5) / tile.w) * frame.sizeX;
        const near = edges.filter((e) => Math.min(e[0], e[2]) - R <= x && x <= Math.max(e[0], e[2]) + R && Math.min(e[1], e[3]) - R <= y && y <= Math.max(e[1], e[3]) + R);
        let sum = 0;
        for (const [dx, dy] of dirs) {
          let t = R;
          for (const [ax, ay, bx, by] of near) {
            const ex = bx - ax, ey = by - ay, den = dx * ey - dy * ex;
            if (Math.abs(den) < 1e-9) continue;
            const qx = ax - x, qy = ay - y, u = (qx * ey - qy * ex) / den, v = (qx * dy - qy * dx) / den;
            if (u >= 0 && u < t && v >= 0 && v <= 1) t = u;
          }
          sum += t / R;
        }
        out[at] = sum / PROBE_RAYS;
      }
    }
  }
  return out;
}

/** What the probes saw: the rooms (and model), sky builds, lamps, light levels. */
export interface ProbeInputs { rooms: string; sky: number; lamps: string; light: string }
export type ProbeReason = 'rooms' | 'sky' | 'lamps' | 'light';

// A light level in PROBE_LIGHT_STEP steps (0 for off).
export const lightStep = (v: number): number => (v > 1e-4 ? Math.round(Math.log(v) / Math.log(1 + PROBE_LIGHT_STEP)) : -9999);

// Lamp signature: the lights that are on (intensity step, colour, position to 10 cm), in order.
export function lampKey(lights: readonly { intensity: number; color: { getHex(): number }; position: { x: number; y: number; z: number }; visible?: boolean }[]): string {
  return lights.filter((l) => l.visible !== false && l.intensity > 1e-4)
    .map((l) => `${lightStep(l.intensity)}:${l.color.getHex().toString(16)}:${Math.round(l.position.x * 10)},${Math.round(l.position.y * 10)},${Math.round(l.position.z * 10)}`).join(';');
}

// Why a rebuild is due (null: the probes still hold). Rooms and the sky come first (they rebuild at once).
export function probeDue(built: ProbeInputs | null, next: ProbeInputs): ProbeReason | null {
  if (!built || built.rooms !== next.rooms) return 'rooms';
  if (built.sky !== next.sky) return 'sky';
  if (built.lamps !== next.lamps) return 'lamps';
  if (built.light !== next.light) return 'light';
  return null;
}
// Rooms and sky now (the environment has its own throttle), lamps and light levels at most every PROBE_THROTTLE_MS.
export const probeWait = (why: ProbeReason, lastAt: number, now: number): number => (why === 'rooms' || why === 'sky' ? 0 : Math.max(0, lastAt + PROBE_THROTTLE_MS - now));

/** Uniforms the patched materials read (shared, see makeCloudUniforms). */
export interface ProbeUniforms {
  fpProbeMap: THREE.IUniform<THREE.Texture | null>;
  fpProbeFrame: THREE.IUniform<THREE.Vector4>;
  fpProbeY: THREE.IUniform<THREE.Vector4>;
  fpProbeTop: THREE.IUniform<THREE.Vector4>;
  fpProbe: THREE.IUniform<THREE.Vector4>;
}
export function makeProbeUniforms(): ProbeUniforms {
  return {
    fpProbeMap: { value: null },
    fpProbeFrame: { value: new THREE.Vector4(0, 0, 1, 1) },
    fpProbeY: { value: new THREE.Vector4() },
    fpProbeTop: { value: new THREE.Vector4() },
    fpProbe: { value: new THREE.Vector4(0, 1, 0, 1) }, // storeys, tile w, weight (0: off), tile h
  };
}

const LUMA = 'vec3( 0.2126, 0.7152, 0.0722 )';
// after #include <lights_pars_begin> (needs vFpCloudW and three's shGetIrradianceAt)
export const PROBE_HEAD = /* glsl */ `
uniform sampler2D fpProbeMap;
uniform vec4 fpProbeFrame;
uniform vec4 fpProbeY;
uniform vec4 fpProbeTop;
uniform vec4 fpProbe;
int fpProbeRoom( vec3 nW, out float open, out float edge ) {
  if ( fpProbe.z <= 0.0 ) return -1;
  vec3 p = vFpCloudW + nW * vec3( ${PROBE_PUSH_M.toFixed(2)}, 0.05, ${PROBE_PUSH_M.toFixed(2)} );
  int s = -1;
  for ( int i = 0; i < ${PROBE_MAX_FLOORS}; i ++ ) {
    if ( float( i ) >= fpProbe.x ) break;
    if ( p.y >= fpProbeY[ i ] && p.y <= fpProbeTop[ i ] ) s = i;
  }
  if ( s < 0 ) return -1;
  vec2 m = ( p.xz - fpProbeFrame.xy ) / fpProbeFrame.zw;
  if ( m.x < 0.0 || m.y < 0.0 || m.x >= 1.0 || m.y >= 1.0 ) return -1;
  ivec2 t = ivec2( s * int( fpProbe.y ) + int( m.x * fpProbe.y ), int( m.y * fpProbe.w ) );
  vec4 c = texelFetch( fpProbeMap, t, 0 );
  open = c.g;
  // vertical faces darken towards the floor and the ceiling of their storey
  float d = min( p.y - fpProbeY[ s ] - 0.02, fpProbeTop[ s ] - 0.3 - p.y );
  edge = mix( 1.0, mix( ${PROBE_EDGE_MIN.toFixed(2)}, 1.0, smoothstep( 0.0, ${PROBE_EDGE_M.toFixed(2)}, d ) ), 1.0 - abs( nW.y ) );
  return int( c.r + 0.5 ) - 1;
}
vec3 fpProbeIrradiance( int room, vec3 nW ) {
  vec3 c[ 9 ];
  int row = int( fpProbe.w ) + room;
  for ( int j = 0; j < 9; j ++ ) c[ j ] = texelFetch( fpProbeMap, ivec2( j, row ), 0 ).rgb;
  return max( shGetIrradianceAt( nW, c ), vec3( 0.0 ) );
}
`;
// after #include <lights_fragment_maps>: the room's irradiance in place of the sky environment's diffuse fill, its
// reflections dimmed as much; a baked lightmap (lightmap.ts) is the surface's ambient light instead of both
export const PROBE_BODY = /* glsl */ `
#if defined( RE_IndirectDiffuse ) && defined( STANDARD )
{
  #ifdef USE_LIGHTMAP
  iblIrradiance = vec3( 0.0 );
  #else
  vec3 fpNW = inverseTransformDirection( geometryNormal, viewMatrix );
  float fpOpen, fpEdge;
  int fpPR = fpProbeRoom( fpNW, fpOpen, fpEdge );
  if ( fpPR >= 0 ) {
    // the room's light, less in its corners and along its edges (the plan's openness, see roomOpenness)
    float fpAo = mix( ${PROBE_AO_MIN.toFixed(2)}, 1.0, smoothstep( 0.2, 0.8, fpOpen ) ) * fpEdge;
    vec3 fpE = ${PROBE_GAIN.toFixed(2)} * fpAo * fpProbeIrradiance( fpPR, fpNW );
    float fpK = dot( fpE, ${LUMA} ) / max( dot( iblIrradiance, ${LUMA} ), 1e-4 );
    iblIrradiance = mix( iblIrradiance, fpE, fpProbe.z );
    #if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
    radiance *= mix( 1.0, clamp( fpK, 0.0, 1.0 ), fpProbe.z );
    #endif
  }
  #endif
}
#endif
`;

/** The probe set's rooms: rooms, storeys, frame, rooms without a probe (baked). */
export interface ProbeSetup { rooms: ProbeRoom[]; storeys: ProbeStorey[]; skip: ReadonlySet<number> }

// The probes of the rooms: the shared texture (room map + coefficients), the passes and their capture target.
// capture(cubeCamera) renders the scene into the cube (the view hides its overlays and shows the whole house).
export class LightProbes {
  renderer: THREE.WebGLRenderer;
  uniforms: ProbeUniforms;
  stats: { captures: number; passes: number };
  setup: ProbeSetup | null;
  /** inputs of the pass in progress or the last one (null: none yet) */
  inputs: ProbeInputs | null;
  /** inputs waiting for a pass and when it may start */
  pending: ProbeInputs | null;
  _dueAt: number;
  _at: number;
  _queue: number[] | null;
  _staging: Float32Array | null;
  _busy: boolean;
  _gen: number;
  _timer: ReturnType<typeof setTimeout> | null;
  _onDue: () => void;
  _tex: THREE.DataTexture | null;
  _tile: { w: number; h: number };
  _cube: THREE.WebGLCubeRenderTarget | null;
  _cam: THREE.CubeCamera | null;
  _type: THREE.TextureDataType;
  _disposed: boolean;
  /** the read-back failed once: no more passes (the sky's fill stays) */
  _failed: boolean;

  constructor(renderer: THREE.WebGLRenderer, uniforms: ProbeUniforms, onDue: () => void) {
    this.renderer = renderer;
    this.uniforms = uniforms;
    this.stats = { captures: 0, passes: 0 };
    this.setup = null;
    this.inputs = null;
    this.pending = null;
    this._dueAt = 0;
    this._at = -Infinity;
    this._queue = null;
    this._staging = null;
    this._busy = false;
    this._gen = 0;
    this._timer = null;
    this._onDue = onDue;
    this._tex = null;
    this._tile = { w: 1, h: 1 };
    this._cube = null;
    this._cam = null;
    // HDR capture when the half-float target can be read back, else 8 bit (light above 1 clips)
    this._type = renderer.capabilities.textureTypeReadable(THREE.HalfFloatType) ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this._disposed = false;
    this._failed = false;
  }

  // New rooms: the room map is redrawn, every probe is dropped (the materials use the sky until the next pass).
  setRooms(setup: ProbeSetup): void {
    this._abort();
    this.setup = setup;
    const U = this.uniforms;
    U.fpProbe.value.z = 0;
    if (this._tex) { this._tex.dispose(); this._tex = null; }
    U.fpProbeMap.value = null;
    const frame = probeFrame(setup.rooms);
    if (!frame || !setup.storeys.length) { U.fpProbe.value.x = 0; return; }
    const tile = probeTile(frame), n = setup.storeys.length, W = Math.max(9, tile.w * n), H = tile.h + setup.rooms.length;
    const ids = roomIdGrid(setup.rooms, n, frame, tile, setup.skip), open = roomOpenness(setup.rooms, n, frame, tile, ids), data = new Uint16Array(W * H * 4);
    for (let j = 0; j < tile.h; j++) {
      for (let i = 0; i < tile.w * n; i++) {
        const o = (j * W + i) * 4, k = j * tile.w * n + i;
        data[o] = THREE.DataUtils.toHalfFloat(ids[k]);
        data[o + 1] = THREE.DataUtils.toHalfFloat(open[k]);
      }
    }
    this._tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
    this._tex.minFilter = this._tex.magFilter = THREE.NearestFilter;
    this._tex.generateMipmaps = false;
    this._tex.flipY = false;
    this._tex.colorSpace = THREE.NoColorSpace;
    this._tex.needsUpdate = true;
    this._tile = tile;
    U.fpProbeMap.value = this._tex;
    U.fpProbeFrame.value.set(frame.minX, frame.minZ, frame.sizeX, frame.sizeZ);
    U.fpProbe.value.set(n, tile.w, 0, tile.h);
    setup.storeys.forEach((s, i) => {
      U.fpProbeY.value.setComponent(i, s.y0 - 0.02);
      U.fpProbeTop.value.setComponent(i, s.y1 + 0.3);
    });
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
    if (this._dueAt > now && !this._timer && !this._queue) this._timer = setTimeout(() => { this._timer = null; this._onDue(); }, this._dueAt - now);
    return why;
  }

  // Before / after a frame: start a due pass, capture the next room of the pass (one a frame, none while a
  // read-back runs). -> true when a room was captured.
  step(capture: (cam: THREE.CubeCamera) => void, now = performance.now()): boolean {
    if (this._disposed || this._failed || this._busy || !this.setup) return false;
    if (!this._queue) {
      if (!this.pending) return false;
      if (now < this._dueAt) {
        if (!this._timer) this._timer = setTimeout(() => { this._timer = null; this._onDue(); }, this._dueAt - now);
        return false;
      }
      this.inputs = this.pending;
      this.pending = null;
      this._at = now;
      this._queue = this.setup.rooms.map((_, i) => i).filter((i) => !this.setup!.skip.has(i));
      this._staging = new Float32Array(this.setup.rooms.length * 27);
      if (!this._queue.length) { this._commit(); return false; }
    }
    const k = this._queue.shift()!;
    if (!this._cube) {
      this._cube = new THREE.WebGLCubeRenderTarget(PROBE_CUBE, { type: this._type, generateMipmaps: false });
      this._cam = new THREE.CubeCamera(0.05, 500, this._cube);
    }
    const p = this.setup.rooms[k].point;
    this._cam!.position.set(p[0], p[1], p[2]);
    this._cam!.updateMatrixWorld(true);
    capture(this._cam!);
    this.stats.captures++;
    this._busy = true;
    const gen = this._gen;
    LightProbeGenerator.fromCubeRenderTarget(this.renderer, this._cube).then((probe) => {
      if (gen !== this._gen || this._disposed) return;
      this._busy = false;
      const c = probe.sh.coefficients, s = this._staging!;
      for (let j = 0; j < 9; j++) { s[k * 27 + j * 3] = c[j].x; s[k * 27 + j * 3 + 1] = c[j].y; s[k * 27 + j * 3 + 2] = c[j].z; }
      if (this._queue && !this._queue.length) this._commit();
      this._onDue();
    }, (err) => {
      if (gen !== this._gen || this._disposed) return;
      console.warn('floorplan3d: light probe read-back failed; the rooms keep the sky light', err);
      this._abort();
      this._failed = true;
      this.uniforms.fpProbe.value.z = 0;
    });
    return true;
  }

  // The pass is done: every room's coefficients into the texture, the materials use them.
  _commit(): void {
    const tex = this._tex, s = this._staging, setup = this.setup;
    this._queue = null;
    this._staging = null;
    if (!tex || !s || !setup) return;
    const W = tex.image.width, d = tex.image.data as unknown as Uint16Array, h = this._tile.h;
    for (let k = 0; k < setup.rooms.length; k++) {
      for (let j = 0; j < 9; j++) {
        const o = ((h + k) * W + j) * 4;
        d[o] = THREE.DataUtils.toHalfFloat(s[k * 27 + j * 3]);
        d[o + 1] = THREE.DataUtils.toHalfFloat(s[k * 27 + j * 3 + 1]);
        d[o + 2] = THREE.DataUtils.toHalfFloat(s[k * 27 + j * 3 + 2]);
      }
    }
    tex.needsUpdate = true;
    this.uniforms.fpProbe.value.z = 1;
    this.stats.passes++;
    if (this.pending) this._onDue(); // a change came in during the pass
  }

  // Drop a pass in progress (its read-back is ignored).
  _abort(): void {
    this._gen++;
    this._busy = false;
    this._queue = null;
    this._staging = null;
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
    const U = this.uniforms;
    U.fpProbe.value.set(0, 1, 0, 1);
    U.fpProbeMap.value = null;
    if (this._tex) this._tex.dispose();
    if (this._cube) this._cube.dispose();
    this._tex = this._cube = this._cam = null;
    this.setup = null;
  }
}
