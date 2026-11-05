// Sky-driven environment light (every render quality, with a model): three's Sky (Preetham, its own clouds from the weather) for
// the current sun, or by night for the moon, with a ground below the horizon, rendered into a small cube map and
// prefiltered with PMREMGenerator into scene.environment, so model materials get image-based fill light and sky
// reflections. The Sky is used as three ships it (no shader patch). The background stays the card's colour. Rebuilt only when the sky changes noticeably (sun / moon moved > ENV_ANGLE_DEG,
// clouds, day / night), at most every ENV_THROTTLE_MS (a day / night flip at once) and never per frame;
// the brightness in between is scene.environmentIntensity (a uniform). Lamps are separate lights and stay
// as they are. Nothing here is created before a model is loaded.

import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { cloudLight } from "../weather.ts";
import type { Vec3 } from "../types/layout.ts";

/** Which body lights the sky: the sun, the moon, or a moonless night sky. */
export type EnvBody = "sun" | "moon" | "dark";
/** Inputs of one environment build. */
export interface EnvSky {
  body: EnvBody;
  /** unit vector toward the body (world) */
  dir: Vec3;
  /** cloud cover 0..100 (in COVERAGE_STEP steps, as the view applies it) */
  coverage: number;
  /** colour of the ground below the horizon (hex, sRGB): the recipe's hemisphere ground colour */
  ground: number;
}

export const ENV_ANGLE_DEG = 2; // the sun moves 15 degrees an hour: a rebuild every ~8 minutes
export const ENV_THROTTLE_MS = 2000;
export const ENV_CUBE = 64; // the sky is smooth: 64 px faces (prefiltered: lodMax 6)
// Brightness of the environment (scene.environmentIntensity) by day; by night the moon's sky this much of it
// (with the moon's lit share), a moonless sky less. Tuned to the Sky's own (linear) output: against the earlier
// patched sky (its gamma re-applied) the cosine-weighted fill of a wall stays within about 15 % under a clear sky
// at sun heights of 20-60 degrees, by moonlight and in a moonless night.
export const ENV_DAY = 0.09;
export const ENV_NIGHT = 0.1;
export const ENV_DARK = 0.03;
// moonless night: a faint sky lit from high up
const DARK_DIR: Vec3 = [0, 0.94, -0.34];
/** Default ground colour (the default recipe's hemisphere ground). */
export const ENV_GROUND = 0x2a2520;
// the ground colour (a dim light colour) into the Sky's radiance units: about the earlier horizon x albedo
export const ENV_GROUND_GAIN = 55;
// Sky's sun strength (its vertex shader: EE, cutoffAngle, steepness): the ground dims with the sky at dusk
const SKY_EE_CUTOFF = 1.6110731556870734,
  SKY_STEEPNESS = 1.5;

const norm = (v: readonly number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// The sky to build for: night (0..1) >= 0.5 is lit by the moon when it is up, else a dark sky; by day the
// sun (its light's direction, also below the horizon in the dusk).
export function envSky(
  night: number,
  sunDir: readonly number[],
  moon: { dir?: readonly number[] | null } | null | undefined,
  coverage: number,
  ground: number = ENV_GROUND,
): EnvSky {
  const c = Math.max(0, Math.min(100, Number(coverage) || 0));
  if (!(night >= 0.5))
    return { body: "sun", dir: norm(sunDir), coverage: c, ground };
  if (moon && moon.dir && moon.dir[1] > 0)
    return { body: "moon", dir: norm(moon.dir), coverage: c, ground };
  return { body: "dark", dir: DARK_DIR, coverage: c, ground };
}

// A build is due: none yet, another body (day / night), other clouds or ground, or the body moved > ENV_ANGLE_DEG.
export function envChanged(a: EnvSky | null, b: EnvSky): boolean {
  if (
    !a ||
    a.body !== b.body ||
    a.coverage !== b.coverage ||
    a.ground !== b.ground
  )
    return true;
  const dot = a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2];
  return (
    Math.acos(Math.max(-1, Math.min(1, dot))) > (ENV_ANGLE_DEG * Math.PI) / 180
  );
}

// scene.environmentIntensity for night 0..1, cloud cover and the moon's lit share: the day's sky by day (its clouds,
// lit by the sun in the Sky shader, make it brighter under cover), the moon's sky dimmer by its phase and the clouds.
export function envIntensity(
  night: number,
  coverage: number,
  moonIllumination: unknown = 1,
  body: EnvBody = night >= 0.5 ? "moon" : "sun",
): number {
  if (body === "sun") return ENV_DAY;
  if (body === "dark") return ENV_DAY * ENV_DARK;
  const L = cloudLight(coverage, night);
  const ill = Math.max(0, Math.min(1, Number(moonIllumination) || 0));
  return ENV_DAY * ENV_NIGHT * (0.35 + 0.65 * ill) * L.moon;
}

/** The Sky's settings for a build (its own uniforms): a little hazier and its clouds under cover. */
export interface SkySettings {
  turbidity: number;
  mieCoefficient: number;
  cloudCoverage: number;
  cloudDensity: number;
}
export function skyUniforms(sky: EnvSky): SkySettings {
  const c = sky.coverage / 100;
  return {
    turbidity: 2 + 2 * c,
    mieCoefficient: 0.005 + 0.015 * c,
    cloudCoverage: 0.7 * c, // the Sky's full cover hides the sky; 0.7 leaves gaps that the haze greys
    cloudDensity: 0.4,
  };
}

// The ground's colour (linear) for a build: the ground colour scaled into the Sky's units, dimmed with the Sky's
// own sun strength (a low sun's sky is darker).
export function groundColor(sky: EnvSky): THREE.Color {
  const zen = Math.acos(Math.max(-1, Math.min(1, sky.dir[1])));
  const e = Math.max(0, 1 - Math.exp(-(SKY_EE_CUTOFF - zen) / SKY_STEEPNESS));
  return new THREE.Color(sky.ground).multiplyScalar(ENV_GROUND_GAIN * e);
}

// three's Sky as it ships, without its sun disc (the sun is the directional light already; a disc in the map would
// light everything twice), and a ground: the lower half of a sphere inside the Sky's box (the Sky shows the horizon's
// colour below the horizon).
export function makeSky(): {
  sky: Sky;
  ground: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
} {
  const sky = new Sky();
  sky.material.uniforms.showSunDisc.value = 0;
  sky.scale.setScalar(100);
  const ground = new THREE.Mesh(
    new THREE.SphereGeometry(
      40,
      24,
      6,
      0,
      Math.PI * 2,
      Math.PI / 2,
      Math.PI / 2,
    ),
    new THREE.MeshBasicMaterial({ side: THREE.BackSide, color: 0 }),
  );
  return { sky, ground };
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
  _ground: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null;
  _skyScene: THREE.Scene | null;
  _cube: THREE.WebGLCubeRenderTarget | null;
  _cubeCam: THREE.CubeCamera | null;
  _pmrem: THREE.PMREMGenerator | null;
  _target: THREE.WebGLCubeRenderTarget | null;

  // onDue: a build is due (the view renders a frame, which calls flush()).
  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    onDue: () => void,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.built = null;
    this.pending = null;
    this.builds = 0;
    this._at = -Infinity;
    this._timer = null;
    this._onDue = onDue;
    this._sky = null;
    this._ground = null;
    this._skyScene = null;
    this._cube = null;
    this._cubeCam = null;
    this._pmrem = null;
    this._target = null;
  }

  // The sky changed: a build when it differs noticeably from the one in use, now when the last is older than
  // ENV_THROTTLE_MS or the body changed (day / night), else once the throttle allows.
  request(sky: EnvSky): void {
    if (!envChanged(this.built, sky)) {
      this.pending = null;
      this._clearTimer();
      return;
    }
    this.pending = sky;
    const wait =
      !this.built || this.built.body !== sky.body
        ? 0
        : this._at + ENV_THROTTLE_MS - performance.now();
    if (wait <= 0) {
      this._clearTimer();
      this._onDue();
      return;
    }
    if (!this._timer)
      this._timer = setTimeout(() => {
        this._timer = null;
        if (this.pending) this._onDue();
      }, wait);
  }

  // Before a frame: build the pending sky if the throttle allows (else its timer comes back).
  flush(): boolean {
    const p = this.pending;
    if (!p || this._timer) return false;
    if (
      this.built &&
      this.built.body === p.body &&
      performance.now() - this._at < ENV_THROTTLE_MS
    ) {
      this.request(p);
      return false;
    }
    this.pending = null;
    this._build(p);
    return true;
  }

  _build(sky: EnvSky): void {
    const r = this.renderer;
    if (!this._sky) {
      const made = makeSky();
      this._sky = made.sky;
      this._ground = made.ground;
      this._skyScene = new THREE.Scene();
      this._skyScene.add(this._sky, this._ground);
      this._cube = new THREE.WebGLCubeRenderTarget(ENV_CUBE, {
        type: THREE.HalfFloatType,
        generateMipmaps: false,
      });
      this._cubeCam = new THREE.CubeCamera(0.1, 1000, this._cube);
      this._pmrem = new THREE.PMREMGenerator(r);
    }
    const U = this._sky.material.uniforms,
      S = skyUniforms(sky);
    U.sunPosition.value.set(...sky.dir);
    U.turbidity.value = S.turbidity;
    U.mieCoefficient.value = S.mieCoefficient;
    U.cloudCoverage.value = S.cloudCoverage;
    U.cloudDensity.value = S.cloudDensity;
    this._ground!.material.color.copy(groundColor(sky));
    const clip = r.clippingPlanes,
      auto = r.autoClear;
    r.clippingPlanes = []; // the section's plane is for the house, not the sky
    r.autoClear = true;
    try {
      this._cubeCam!.update(r, this._skyScene!);
      // the same target again: scene.environment keeps its texture (no material update)
      this._target = this._pmrem!.fromCubemap(
        this._cube!.texture,
        this._target,
      );
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
    if (this._target && this.scene.environment === this._target.texture)
      this.scene.environment = null;
    if (this._target) this._target.dispose();
    if (this._cube) this._cube.dispose();
    if (this._pmrem) this._pmrem.dispose();
    if (this._sky) {
      this._sky.geometry.dispose();
      this._sky.material.dispose();
    }
    if (this._ground) {
      this._ground.geometry.dispose();
      this._ground.material.dispose();
    }
    this._target =
      this._cube =
      this._pmrem =
      this._sky =
      this._ground =
      this._skyScene =
      this._cubeCam =
        null;
    this.built = this.pending = null;
  }
}
