// Sky layer of the floorplan view: sun / moon discs on the dome around the house and the compass ring,
// weather (cloud cover, cloud shadows and their drift, rain / snow) and the room mask that keeps them
// out of the rooms. The scene-side sky group and moon light stay on the view. (src/sky.js is the pure
// sky math this part draws with.)

import * as THREE from 'three';
import { moonLight, moonLitRight, SUN_MIN_Y, SUN_DISC_M, MOON_DISC_M } from '../sky.js';
import { cloudLight, coverageChanged, convexHull, hullDistance, skyKeepOut } from '../weather.js';
import { precipAmounts, placeDrops, makePrecipUniforms, makePrecipLayer, drawRoomMask, RAIN_MAX, SNOW_MAX, PRECIP_FRAME_MS } from '../precip.js';
import { swayLean, makeCloudUniforms, cloudPattern, cloudShadowParams, cloudShadowOffset, roomMaskFrame, roomMaskTexture } from '../cloud-shadow.js';
import { testMode, frameInterval, isPerspective, type Drawable, type Vec3 } from './core.js';
import type { FloorplanView } from '../view.js';
import type { CloudUniforms } from '../cloud-shadow.js';
import type { PrecipKind, PrecipUniforms } from '../precip.js';
import type { PlanPoint } from '../types/layout.js';

/** A body on the sky dome: unit vector toward it (world); the moon also its phase and lit share. */
export interface SkyBody { dir: Vec3; phase?: number; illumination?: number; latitude?: number }
export interface SkyBodiesSpec { sun?: SkyBody | null; moon?: SkyBody | null; north?: Vec3 | number[] | null; on?: boolean }
export interface WeatherSpec { coverage?: unknown; clouds?: unknown; condition?: string | null; wind?: unknown }
/** Weather state: coverage % applied (null before the first), clouds option, drift time (s), last drift frame. */
export interface WeatherState {
  applied: number | null;
  show: boolean;
  t: number;
  frameAt: number;
  shown: number;
  wind: number;
  condition?: string | null;
  falling?: boolean;
}
type SkySprite = THREE.Sprite;
type PrecipLayer = THREE.LineSegments | THREE.Points;
/** Screen hull of a room: [x, y] px from the centre, y up. */
type Hull = number[][];

const CLOUD_FRAME_MS = 50; // cloud shadow drift: at most 20 frames per second

// Sun sprite texture: warm disc (half the sprite) in a soft glow.
let sunTexture: THREE.CanvasTexture | null = null;
function getSunTexture(): THREE.CanvasTexture {
  if (sunTexture) return sunTexture;
  const c = document.createElement('canvas');
  const n = testMode() ? 64 : 128, r = n / 2;
  c.width = c.height = n;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, 'rgba(255,252,236,1)');
    grad.addColorStop(0.42, 'rgba(255,240,196,1)');
    grad.addColorStop(0.5, 'rgba(255,214,140,0.55)');
    grad.addColorStop(0.7, 'rgba(255,190,110,0.18)');
    grad.addColorStop(1, 'rgba(255,180,100,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, n, n);
  }
  sunTexture = new THREE.CanvasTexture(c);
  sunTexture.colorSpace = THREE.SRGBColorSpace;
  return sunTexture;
}

// Moon disc (90 % of the canvas): lit part by illumination, lit on the right when `waxing`
// (see moonLitRight: waxing seen from the northern hemisphere), the dark part faint.
export function drawMoon(g: CanvasRenderingContext2D, size: number, illumination: number, waxing: boolean): void {
  const r = size * 0.45, cx = size / 2, cy = size / 2;
  g.clearRect(0, 0, size, size);
  g.fillStyle = 'rgba(120,135,170,0.22)';
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  const k = Math.max(0, Math.min(1, illumination));
  if (k < 0.01) return;
  const side = waxing ? 1 : -1, ex = r * Math.abs(1 - 2 * k);
  g.fillStyle = 'rgba(236,240,250,1)';
  g.beginPath();
  // lit limb: half circle on the lit side, back along the terminator (an ellipse)
  g.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, side < 0);
  g.ellipse(cx, cy, ex, r, 0, Math.PI / 2, -Math.PI / 2, (k > 0.5) === (side < 0));
  g.closePath();
  g.fill();
}

export class SkyLayer {
  view: FloorplanView;
  skyBodies: { sun: SkyBody | null; moon: SkyBody | null };
  skySprites: { sun: SkySprite | null; moon: SkySprite | null };
  _moonKey: string | null;
  skyRing: THREE.Group | null;
  _skyOn: boolean;
  _skyNorth: Vec3 | number[] | null;
  weather: WeatherState;
  _cloudU: CloudUniforms;
  _roomMask: THREE.CanvasTexture | null;
  _precipU: PrecipUniforms;
  _precip: Record<PrecipKind, PrecipLayer | null>;

  constructor(view: FloorplanView) {
    this.view = view;
    this.skyBodies = { sun: null, moon: null }; // { dir: [x, y, z] world, phase?, illumination? }
    this.skySprites = { sun: null, moon: null };
    this._moonKey = null;
    this.skyRing = null; // compass ring on the ground at the dome radius, "N" at true north
    this._skyOn = false; // option sky_bodies (with a model)
    this._skyNorth = null; // [x, y, z] world unit vector of true north
    // weather: coverage % applied (null before the first), clouds option, drift time (s), last drift frame
    this.weather = { applied: null, show: true, t: 0, frameAt: 0, shown: 0, wind: 0 };
    this._cloudU = makeCloudUniforms(); // cloud shadows: shared by every patched model material
    this._roomMask = null; // room mask texture for the cloud shadows (rebuilt with the rooms)
    this._precipU = makePrecipUniforms(); // rain / snow: time, fall range, screen mask of the rooms
    this._precip = { rain: null, snow: null }; // layers, created on the first rain / snow
  }

  // Sun / moon on a dome around the house: { sun: { dir } | null, moon: { dir, phase, illumination } | null,
  // north: [x, y, z] world unit vector of true north, on: sky_bodies }. Each body sits at house centre
  // + dir x dome radius, so its azimuth / elevation read off the compass ring (3D and top view).
  setSkyBodies({ sun = null, moon = null, north = null, on = true }: SkyBodiesSpec = {}): void {
    this._skyOn = !!on;
    this.skyBodies = on ? { sun: sun && sun.dir ? sun : null, moon: moon && moon.dir ? moon : null } : { sun: null, moon: null };
    if (this.skyBodies.sun && !this.skySprites.sun) this.skySprites.sun = this._skySprite(getSunTexture());
    if (this.skyBodies.moon) {
      if (!this.skySprites.moon) {
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        this.skySprites.moon = this._skySprite(tex);
      }
      this._paintMoon(this.skyBodies.moon);
    }
    this._cloudLook(); // a new disc gets its cloud opacity
    if (north) this._skyNorth = north;
    if (this._skyOn && !this.skyRing) this._makeSkyRing();
    if (this.view.model) this._applyMoonLight();
    this._placeSkyBodies();
    this.view.dirty = true;
  }

  // Unit ring (scaled to the dome radius) with a tick and an "N" on local +x (turned to true north).
  _makeSkyRing(): void {
    const g = new THREE.Group();
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 128; i++) { const a = (i / 128) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a))); }
    const line = (opacity: number) => new THREE.LineBasicMaterial({ color: 0xffb74d, transparent: true, opacity, depthWrite: false, toneMapped: false, fog: false });
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), line(0.25));
    const tick = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0.94, 0, 0), new THREE.Vector3(1.08, 0, 0)]), line(0.6));
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'rgba(255,183,77,0.9)';
      ctx.font = 'bold 44px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', 32, 34);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, fog: false }));
    label.position.set(1.16, 0.02, 0);
    label.userData.ringLabel = true;
    for (const o of [ring, tick, label]) { o.userData.helper = true; o.raycast = () => {}; }
    g.add(ring, tick, label);
    g.userData.helper = true;
    g.visible = false;
    this.skyRing = g;
    this.view.skyGroup.add(g);
  }

  _skySprite(map: THREE.Texture): SkySprite {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, toneMapped: false, fog: false }));
    s.castShadow = s.receiveShadow = false;
    s.frustumCulled = false; // placed per frame
    s.visible = false;
    s.userData.helper = true;
    s.raycast = () => {}; // never picked
    this.view.skyGroup.add(s);
    return s;
  }

  // Redraw the moon texture only when the shape changes visibly (texture upload, no shader change).
  _paintMoon(moon: SkyBody): void {
    const tex = this.skySprites.moon!.material.map!, ill = Math.round((Number(moon.illumination) || 0) * 50) / 50;
    const right = moonLitRight(moon.phase, moon.latitude); // mirrored south of the equator
    const key = ill + (right ? '+' : '-');
    if (key === this._moonKey) return;
    this._moonKey = key;
    const canvas = tex.image as HTMLCanvasElement; // made by setSkyBodies
    const g = canvas.getContext && canvas.getContext('2d');
    if (g) drawMoon(g, canvas.width, ill, right);
    tex.needsUpdate = true;
  }

  _applyMoonLight(): void {
    const l = this.view.moonLight, moon = this.skyBodies.moon;
    l.intensity = this.view.model ? moonLight(this.view.look.sky.night, moon) * cloudLight(this.weather.applied || 0).moon : 0;
    if (l.intensity > 0 && this.view.look._shadowBox) {
      const { centre, radius } = this.view.look._shadowBox;
      l.target.position.copy(centre);
      l.position.copy(centre).addScaledVector(new THREE.Vector3(...moon!.dir), radius * 2.5); // lit only with a moon (moonLight)
      l.target.updateMatrixWorld();
    }
  }

  // Weather: { coverage 0..100, clouds: option clouds (cloud shadows, rain, snow), condition: the state }. Applied only when the coverage moved >= 5 points
  // (or reached 0 / 100) or the option changed: light values, disc opacities, cloud shadows. Returns true when applied.
  setWeather({ coverage = 0, clouds = true, condition = null, wind = 0 }: WeatherSpec = {}): boolean {
    const w = this.weather;
    w.wind = Math.max(0, Number(wind) || 0); // m/s: the plants' sway (uniform only)
    this._cloudU.fpSway.value = this.view.look._sway ? swayLean(w.wind, this.view.look._sway.strength) : 0;
    const show = clouds !== false, c = Math.max(0, Math.min(100, Number(coverage) || 0)), cond = condition || null;
    if (!coverageChanged(w.applied, c) && show === w.show && cond === (w.condition ?? null)) return false;
    w.applied = c;
    w.show = show;
    w.condition = cond;
    if (this.view.model) this.view.look._applyLights();
    else this._cloudLook();
    this._placeSkyBodies();
    this.view.dirty = true;
    return true;
  }

  // Disc opacity and cloud shadows for the coverage and night (uniforms only, no shader change).
  _cloudLook(): void {
    const c = (this.weather.applied || 0) / 100, t = Math.max(0, Math.min(1, this.view.look.sky.night || 0)), L = cloudLight(c * 100, t);
    if (this.skySprites.sun) this.skySprites.sun.material.opacity = L.sunDisc * (this.skySprites.sun.userData.clear ?? 1);
    if (this.skySprites.moon) this.skySprites.moon.material.opacity = L.moon * (this.skySprites.moon.userData.clear ?? 1);
    const P = cloudShadowParams(c * 100, L.sun), U = this._cloudU, on = this._cloudShadowsOn();
    U.fpCloudCover.value = P.cover;
    U.fpCloudStrength.value = on ? P.strength : 0;
    U.fpRoomShade.value = on ? P.roomShade : 1;
  }

  // Cloud shadows show: a model (patched materials), the clouds option, the sky on, some coverage.
  _cloudShadowsOn(): boolean {
    return this._weatherFxOn() && (this.weather.applied || 0) > 0;
  }

  // Weather effects (cloud shadows, rain, snow) may show: a model, the clouds option, the sky on.
  _weatherFxOn(): boolean {
    return !!this.view.model && this._skyOn && !this.view.sectionClip && this.weather.show;
  }

  // Cloud shadows drifting over the model's surroundings (not the rooms: _updateRoomMask), with
  // weather.t; shown with a model, the clouds option and the sky on, in 3D and top view alike.
  _placeClouds(): void {
    const w = this.weather, U = this._cloudU, shown = this._cloudShadowsOn() ? 1 : 0;
    if (shown !== w.shown && this.view.model) { w.shown = shown; this.view.look._applyLights(); } // the sun's strength depends on it
    w.shown = shown;
    if (w.shown && !U.fpCloudMap.value) U.fpCloudMap.value = cloudPattern();
    U.fpCloudOffset.value.set(...cloudShadowOffset(w.t));
  }

  // Rain / snow for the condition around the house (precip.js): layers made on first use (again when
  // the amount changes), falling from above the rooms to the bottom of the model; the screen mask of
  // the room hulls is redrawn each frame while they show. Returns true while something falls.
  _placePrecip(hull: Hull[] | null): boolean {
    const P = this._precip, U = this._precipU, d = this.view.look._dome, w = this.weather;
    const amt = this._weatherFxOn() && d ? precipAmounts(w.condition) : { rain: 0, snow: 0 };
    let falling = false;
    for (const [kind, max] of [['rain', RAIN_MAX], ['snow', SNOW_MAX]] as const) {
      const count = Math.round(max * (amt[kind] || 0));
      let layer = P[kind];
      if (layer && layer.userData.count !== count && count) { this._disposePrecip(kind); layer = null; }
      if (!layer && count) {
        const rooms = (this.view._rooms || []).map((x) => x.room.polygon).filter((pl) => pl && pl.length >= 3);
        layer = P[kind] = makePrecipLayer(kind, placeDrops(count, [d!.centre.x, d!.centre.z], d!.radius, rooms), U); // count > 0 needs the dome
        layer.userData.count = count;
        this.view.skyGroup.add(layer);
      }
      if (layer) layer.visible = count > 0;
      falling = falling || count > 0;
    }
    if (!falling || !d) return false; // (falling implies the dome)
    const hb = this.view.look._houseBox, size = this.view.renderer.getSize(new THREE.Vector2()), buf = this.view.renderer.getDrawingBufferSize(new THREE.Vector2());
    U.uTop.value = (hb ? hb.max.y : d.centre.y + 3) + 3;
    U.uBottom.value = this.view.look._modelBottom ?? d.centre.y;
    U.uTime.value = w.t;
    U.uRes.value.copy(buf);
    U.uMask.value = drawRoomMask(hull, size.x, size.y, U.uMask.value as THREE.CanvasTexture | null); // only drawRoomMask sets it
    return true;
  }

  _disposePrecip(kind: PrecipKind): void {
    const l = this._precip[kind];
    if (!l) return;
    l.removeFromParent();
    l.geometry.dispose();
    (l.material as THREE.Material).dispose(); // made with one ShaderMaterial
    this._precip[kind] = null;
  }

  // Room mask for the cloud shadows from the room polygons (all floors), from the lowest room floor up.
  _updateRoomMask(): void {
    const U = this._cloudU, polys: PlanPoint[][] = [];
    let floor = Infinity;
    for (const { room, floorId } of this.view._rooms || []) {
      if (!room.polygon || room.polygon.length < 3) continue;
      polys.push(room.polygon);
      const f = (this.view.floors || []).find((x) => x.id === floorId);
      floor = Math.min(floor, f ? f.elevation : 0);
    }
    const frame = roomMaskFrame(polys);
    if (this._roomMask) this._roomMask.dispose();
    this._roomMask = frame ? roomMaskTexture(polys, frame) : null;
    U.fpRoomMask.value = this._roomMask;
    if (frame) U.fpRoomFrame.value.set(frame.minX, frame.minZ, frame.sizeX, frame.sizeZ);
    else U.fpRoomFrame.value.set(0, 0, 0, 0);
    U.fpRoomFloor.value = Number.isFinite(floor) ? floor - 0.05 : 0;
    this.view.dirty = true;
  }

  // The rooms as boxes (as fit(): room polygons on the visible floors, floor to ceiling), each a list
  // of world points; without room polygons the house box as one.
  _roomSolids(): THREE.Vector3[][] {
    const out: THREE.Vector3[][] = [];
    for (const { room, floorId } of this.view._rooms || []) {
      if (!this.view._shows(floorId) || !room.polygon || room.polygon.length < 3) continue;
      const f = this.view.floors.find((x) => x.id === floorId);
      const y0 = f ? f.elevation : 0, y1 = y0 + ((f && f.height) || 2.7);
      out.push(room.polygon.flatMap(([x, y]) => [new THREE.Vector3(x, y0, -y), new THREE.Vector3(x, y1, -y)]));
    }
    const b = this.view.look._houseBox;
    if (!out.length && b && !b.isEmpty()) {
      out.push([0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z)));
    }
    return out;
  }

  // The rooms on screen: one convex hull per room (px from the centre, y up); [] without rooms, null
  // when a corner is behind the camera (the camera is in or right over the rooms: no sky).
  _roomHull(): Hull[] | null {
    const cam = this.view.camera, size = this.view.renderer.getSize(new THREE.Vector2()), v = new THREE.Vector3(), hulls: Hull[] = [];
    cam.updateMatrixWorld();
    for (const solid of this._roomSolids()) {
      const pts: number[][] = [];
      for (const p of solid) {
        if (isPerspective(cam) && v.copy(p).applyMatrix4(cam.matrixWorldInverse).z > -cam.near) return null;
        v.copy(p).project(cam);
        pts.push([v.x * size.x / 2, v.y * size.y / 2]);
      }
      hulls.push(convexHull(pts));
    }
    return hulls;
  }

  // Screen distance (px, < 0 inside) of a world point from the nearest room hull, and the screen size (px)
  // of a world length there.
  _skyScreen(hulls: Hull[], pos: THREE.Vector3, radius: number): { dist: number; r: number } {
    const cam = this.view.camera, size = this.view.renderer.getSize(new THREE.Vector2());
    const c = pos.clone().project(cam);
    const e = pos.clone().addScaledVector(new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), radius).project(cam);
    const px = [c.x * size.x / 2, c.y * size.y / 2];
    return { dist: Math.min(Infinity, ...hulls.map((h) => hullDistance(h, px))), r: Math.hypot(e.x * size.x / 2 - px[0], e.y * size.y / 2 - px[1]) };
  }

  // Opacity factor 0..1 of a sky sprite (world centre, world radius): gone where it covers a room.
  _skyClear(hulls: Hull[] | null, pos: THREE.Vector3, radius: number): number {
    if (hulls === null) return 0;
    if (!hulls.length) return 1;
    const { dist, r } = this._skyScreen(hulls, pos, radius);
    return skyKeepOut(dist, r);
  }

  // Sun / moon on the dome (house centre + dir x radius) as world-size discs, hidden below the horizon
  // (sun < -2 deg, moon < 0); the ring and both discs need a model and sky_bodies. A disc fades out
  // where it would cover the rooms on screen (the dome is smaller than the orbit). In 3D the disc is
  // then pushed back along the camera ray to near the far plane (same spot and size on screen), so the
  // surroundings hide it: it only shows over open background, not floating over a neighbour building.
  _placeSkyBodies(): void {
    const d = this.view.look._dome, on = !!this.view.model && this._skyOn && !!d && !this.view.sectionClip; // the section's global plane would cut them
    const hull = on ? this._roomHull() : [];
    const cam = this.view.camera, back = this.view.mode !== 'top' && isPerspective(cam);
    const put = (sprite: SkySprite | null, body: SkyBody | null, minY: number, size: number, radius: number) => {
      if (!sprite) return;
      const show = on && !!body && body.dir[1] > minY;
      sprite.visible = show;
      if (!show) return;
      const dome: THREE.Vector3 = (sprite.userData.domePos || (sprite.userData.domePos = new THREE.Vector3()));
      dome.copy(d!.centre).addScaledVector(new THREE.Vector3(...body.dir).normalize(), d!.radius); // on implies the dome
      sprite.userData.clear = this._skyClear(hull, dome, radius);
      if (!sprite.userData.clear) sprite.visible = false;
      sprite.position.copy(dome);
      sprite.scale.setScalar(size);
      const dist = dome.distanceTo(cam.position), far = cam.far * 0.95;
      if (back && dist > 0 && far > dist) {
        sprite.position.sub(cam.position).multiplyScalar(far / dist).add(cam.position);
        sprite.scale.setScalar((size * far) / dist);
      }
    };
    put(this.skySprites.sun, this.skyBodies.sun, SUN_MIN_Y, SUN_DISC_M * 2, SUN_DISC_M * 0.7); // disc = half the sprite, plus some glow
    put(this.skySprites.moon, this.skyBodies.moon, 0, MOON_DISC_M / 0.9, MOON_DISC_M / 2); // disc = 90 % of the sprite
    this._placeClouds();
    this.weather.falling = this._placePrecip(hull);
    this._cloudLook(); // per-sprite opacity for this camera
    const ring = this.skyRing;
    if (!ring) return;
    ring.visible = on;
    if (!on) return;
    ring.position.set(d!.centre.x, d!.centre.y + 0.02, d!.centre.z); // on implies the dome
    ring.scale.setScalar(d!.radius);
    const n = this._skyNorth || [0, 0, -1];
    ring.rotation.y = Math.atan2(-n[2], n[0]); // local +x -> north
    const label = ring.children.find((o) => o.userData.ringLabel);
    if (label) label.scale.setScalar(1.4 / d!.radius); // ~1.4 m in the world
  }

  // Cloud shadow drift / rain and snow: at most one frame per CLOUD_FRAME_MS (PRECIP_FRAME_MS while
  // something falls), only while they show, the card is on screen and the page visible.
  _driftClouds(): void {
    const w = this.weather;
    const moving = (w.shown && this._cloudU.fpCloudStrength.value) || w.falling;
    if (!moving || !this.view.onScreen || (this.view.test && !this.view.test.drift) || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) { w.frameAt = 0; return; }
    const now = performance.now();
    if (!w.frameAt) { w.frameAt = now; return; }
    if (now - w.frameAt < frameInterval(w.falling ? PRECIP_FRAME_MS : CLOUD_FRAME_MS, this.view._maxFps)) return; // rain / snow need a smoother fall
    const dt = Math.min(1, (now - w.frameAt) / 1000);
    w.frameAt = now;
    w.t += dt;
    this.view.stats.cloudFrames++;
    this.view.dirty = true;
  }

  // Sky resources (view.dispose): sprite textures except the shared sun texture, the room mask, rain /
  // snow and the compass ring.
  dispose(): void {
    for (const s of Object.values(this.skySprites)) {
      if (!s) continue;
      if (s.material.map !== sunTexture) s.material.map!.dispose(); // every sky sprite has its texture
      s.material.dispose();
    }
    this.skySprites = { sun: null, moon: null };
    if (this._roomMask) this._roomMask.dispose();
    this._roomMask = null;
    this._disposePrecip('rain');
    this._disposePrecip('snow');
    if (this._precipU.uMask.value) this._precipU.uMask.value.dispose();
    this._precipU.uMask.value = null;
    if (this.skyRing) {
      this.skyRing.traverse((obj) => { const o = obj as Drawable; const m = o.material as THREE.SpriteMaterial | undefined; if (m && m.map) m.map.dispose(); });
      this.view._clearGroup(this.skyRing);
    }
    this.skyRing = null;
  }
}
