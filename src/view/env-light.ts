// Sky-driven environment light (render quality 'high'): three's Sky (Preetham) for the current sun, or by
// night for the moon, rendered into a small cube map and prefiltered with PMREMGenerator into
// scene.environment, so model materials get image-based fill light and sky reflections. The background
// stays the card's colour. Rebuilt only when the sky changes noticeably (sun / moon moved > ENV_ANGLE_DEG,
// clouds, day / night), at most every ENV_THROTTLE_MS (a day / night flip at once) and never per frame;
// the brightness in between is scene.environmentIntensity (a uniform). Lamps are separate lights and stay
// as they are. Nothing here is created until the tier asks for it.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { cloudLight } from '../weather.ts';
import type { Vec3 } from '../types/layout.ts';

/** Which body lights the sky: the sun, the moon, or a moonless night sky. */
export type EnvBody = 'sun' | 'moon' | 'dark';
/** Inputs of one environment build. */
export interface EnvSky {
  body: EnvBody;
  /** unit vector toward the body (world) */
  dir: Vec3;
  /** cloud cover 0..100 (in COVERAGE_STEP steps, as the view applies it) */
  coverage: number;
}

export const ENV_ANGLE_DEG = 2; // the sun moves 15 degrees an hour: a rebuild every ~8 minutes
export const ENV_THROTTLE_MS = 2000;
export const ENV_CUBE = 64; // the sky is smooth: 64 px faces (prefiltered: lodMax 6)
// Brightness of the environment (scene.environmentIntensity) by day; by night the moon's sky this much of it
// (with the moon's lit share), a moonless sky less.
export const ENV_DAY = 0.12;
export const ENV_NIGHT = 0.15;
export const ENV_DARK = 0.05;
// the night sky (moon or none): a cool tint over the daylight model the sky shader draws
const NIGHT_TINT: Vec3 = [0.55, 0.65, 1];
// moonless night: a faint sky lit from high up
const DARK_DIR: Vec3 = [0, 0.94, -0.34];
// ground below the horizon: the horizon's colour times a warm ground albedo
const GROUND: Vec3 = [0.3, 0.27, 0.22];

const norm = (v: readonly number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// The sky to build for: night (0..1) >= 0.5 is lit by the moon when it is up, else a dark sky; by day the
// sun (its light's direction, also below the horizon in the dusk).
export function envSky(night: number, sunDir: readonly number[], moon: { dir?: readonly number[] | null } | null | undefined, coverage: number): EnvSky {
  const c = Math.max(0, Math.min(100, Number(coverage) || 0));
  if (!(night >= 0.5)) return { body: 'sun', dir: norm(sunDir), coverage: c };
  if (moon && moon.dir && moon.dir[1] > 0) return { body: 'moon', dir: norm(moon.dir), coverage: c };
  return { body: 'dark', dir: DARK_DIR, coverage: c };
}

// A build is due: none yet, another body (day / night), other clouds, or the body moved > ENV_ANGLE_DEG.
export function envChanged(a: EnvSky | null, b: EnvSky): boolean {
  if (!a || a.body !== b.body || a.coverage !== b.coverage) return true;
  const dot = a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2];
  return Math.acos(Math.max(-1, Math.min(1, dot))) > (ENV_ANGLE_DEG * Math.PI) / 180;
}

// scene.environmentIntensity for night 0..1, cloud cover and the moon's lit share: the day's sky by day
// (brighter under clouds as the hemisphere light), the moon's sky dimmer by its phase and the clouds.
export function envIntensity(night: number, coverage: number, moonIllumination: unknown = 1, body: EnvBody = night >= 0.5 ? 'moon' : 'sun'): number {
  const L = cloudLight(coverage, night);
  if (body === 'sun') return ENV_DAY * L.hemi;
  if (body === 'dark') return ENV_DAY * ENV_DARK;
  const ill = Math.max(0, Math.min(1, Number(moonIllumination) || 0));
  return ENV_DAY * ENV_NIGHT * (0.35 + 0.65 * ill) * L.moon;
}

// Sky shader settings for a build: hazier and greyer under clouds.
export function skyUniforms(sky: EnvSky): { turbidity: number; mieCoefficient: number; grey: number; tint: Vec3 } {
  const c = sky.coverage / 100;
  return { turbidity: 2 + 8 * c, mieCoefficient: 0.005 + 0.015 * c, grey: 0.85 * c, tint: sky.body === 'sun' ? [1, 1, 1] : NIGHT_TINT };
}

// three's Sky without the sun disc (the sun is the directional light already; a disc in the map would
// light everything twice), with a ground below the horizon, cloud grey and a tint.
function makeSky(): Sky {
  const sky = new Sky();
  const m = sky.material;
  m.uniforms.fpGrey = { value: 0 };
  m.uniforms.fpTint = { value: new THREE.Vector3(1, 1, 1) };
  m.uniforms.fpGround = { value: new THREE.Vector3(...GROUND) };
  const fs = m.fragmentShader;
  const disc = 'L0 += ( vSunE * 19000.0 * Fex ) * sundisk;';
  const out = 'gl_FragColor = vec4( retColor, 1.0 );';
  if (!fs.includes(disc) || !fs.includes(out)) throw new Error('floorplan3d: unexpected Sky shader');
  m.fragmentShader = 'uniform float fpGrey;\nuniform vec3 fpTint;\nuniform vec3 fpGround;\n' + fs.replace(disc, '').replace(out, `
    retColor = mix( retColor, vec3( dot( retColor, vec3( 0.2126, 0.7152, 0.0722 ) ) ), fpGrey );
    retColor *= mix( vec3( 1.0 ), fpGround, smoothstep( 0.0, -0.06, direction.y ) ) * fpTint;
    ${out}`);
  sky.scale.setScalar(100);
  return sky;
}

export class EnvLight {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** inputs of the environment in use (null: none built) */
  built: EnvSky | null;
  /** inputs waiting for their build (null: nothing to do) */
  pending: EnvSky | null;
  builds: number;
  _at: number;
  _timer: ReturnType<typeof setTimeout> | null;
  _onDue: () => void;
  _sky: Sky | null;
  _skyScene: THREE.Scene | null;
  _cube: THREE.WebGLCubeRenderTarget | null;
  _cubeCam: THREE.CubeCamera | null;
  _pmrem: THREE.PMREMGenerator | null;
  _target: THREE.WebGLRenderTarget | null;

  // onDue: a build is due (the view renders a frame, which calls flush()).
  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, onDue: () => void) {
    this.renderer = renderer;
    this.scene = scene;
    this.built = null;
    this.pending = null;
    this.builds = 0;
    this._at = -Infinity;
    this._timer = null;
    this._onDue = onDue;
    this._sky = null;
    this._skyScene = null;
    this._cube = null;
    this._cubeCam = null;
    this._pmrem = null;
    this._target = null;
  }

  // The sky changed: a build when it differs noticeably from the one in use, now when the last is older than
  // ENV_THROTTLE_MS or the body changed (day / night), else once the throttle allows.
  request(sky: EnvSky): void {
    if (!envChanged(this.built, sky)) { this.pending = null; this._clearTimer(); return; }
    this.pending = sky;
    const wait = !this.built || this.built.body !== sky.body ? 0 : this._at + ENV_THROTTLE_MS - performance.now();
    if (wait <= 0) { this._clearTimer(); this._onDue(); return; }
    if (!this._timer) this._timer = setTimeout(() => { this._timer = null; if (this.pending) this._onDue(); }, wait);
  }

  // Before a frame: build the pending sky if the throttle allows (else its timer comes back).
  flush(): boolean {
    const p = this.pending;
    if (!p || this._timer) return false;
    if (this.built && this.built.body === p.body && performance.now() - this._at < ENV_THROTTLE_MS) { this.request(p); return false; }
    this.pending = null;
    this._build(p);
    return true;
  }

  _build(sky: EnvSky): void {
    const r = this.renderer;
    if (!this._sky) {
      this._sky = makeSky();
      this._skyScene = new THREE.Scene();
      this._skyScene.add(this._sky);
      this._cube = new THREE.WebGLCubeRenderTarget(ENV_CUBE, { type: THREE.HalfFloatType, generateMipmaps: false });
      this._cubeCam = new THREE.CubeCamera(0.1, 1000, this._cube);
      this._pmrem = new THREE.PMREMGenerator(r);
    }
    const U = this._sky.material.uniforms, S = skyUniforms(sky);
    U.sunPosition.value.set(...sky.dir);
    U.turbidity.value = S.turbidity;
    U.mieCoefficient.value = S.mieCoefficient;
    U.fpGrey.value = S.grey;
    U.fpTint.value.set(...S.tint);
    const clip = r.clippingPlanes, auto = r.autoClear;
    r.clippingPlanes = []; // the section's plane is for the house, not the sky
    r.autoClear = true;
    try {
      this._cubeCam!.update(r, this._skyScene!);
      // the same target again: scene.environment keeps its texture (no material update)
      this._target = this._pmrem!.fromCubemap(this._cube!.texture, this._target);
    } finally {
      r.clippingPlanes = clip;
      r.autoClear = auto;
    }
    this.scene.environment = this._target.texture;
    this.built = sky;
    this._at = performance.now();
    this.builds++;
  }

  _clearTimer(): void {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  // Off: scene.environment cleared and every GPU resource freed.
  dispose(): void {
    this._clearTimer();
    if (this._target && this.scene.environment === this._target.texture) this.scene.environment = null;
    if (this._target) this._target.dispose();
    if (this._cube) this._cube.dispose();
    if (this._pmrem) this._pmrem.dispose();
    if (this._sky) { this._sky.geometry.dispose(); this._sky.material.dispose(); }
    this._target = this._cube = this._pmrem = this._sky = this._skyScene = this._cubeCam = null;
    this.built = this.pending = null;
  }
}
