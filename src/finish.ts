// The finish over the frame: the look of a photo of a miniature.
// - bokeh: the rooms stay sharp from any camera, the surroundings blur with their distance from the rooms' box
//   (the facade below, the neighbours, the site, the sky). The circle of confusion comes from the depth
//   pre-pass (depth-pass.ts): world position per pixel, distance to the box. The canvas is gathered over a
//   disc (bright points weigh more: bokeh highlights at night); sharp pixels do not spread into blurred ones.
//   Our own shader: three's BokehPass focuses on one distance from the camera, not on a box.
// - tilt: three's Horizontal / VerticalTiltShiftShader, the blur growing with the distance on screen from a
//   line through the rooms' middle, like a tilt-shift lens.
// - grade: three's HueSaturationShader, BrightnessContrastShader and VignetteShader, as in photos of models.
// After the frame render the canvas is copied and drawn back through those ShaderPasses (on display values,
// as the canvas holds them; the last pass draws onto the canvas). Labels (CSS) stay as they are.
import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { HueSaturationShader } from "three/addons/shaders/HueSaturationShader.js";
import { BrightnessContrastShader } from "three/addons/shaders/BrightnessContrastShader.js";
import { VignetteShader } from "three/addons/shaders/VignetteShader.js";
import { HorizontalTiltShiftShader } from "three/addons/shaders/HorizontalTiltShiftShader.js";
import { VerticalTiltShiftShader } from "three/addons/shaders/VerticalTiltShiftShader.js";
import type { DepthPrepass } from "./depth-pass.ts";
import { isPerspective, type ViewCamera } from "./view/core.ts";

export const BOKEH_DEFAULTS = Object.freeze({
  strength: 10,
  start: 0.5,
  range: 10,
  tilt: 0,
});
const BOKEH_RANGE = {
  strength: [0, 20],
  start: [0, 50],
  range: [0.5, 200],
  tilt: [0, 1],
};
export const GRADE_DEFAULTS = Object.freeze({
  saturation: 1.15,
  contrast: 0.25,
  vignette: 0.25,
});
const GRADE_RANGE = { saturation: [0, 2], contrast: [0, 1], vignette: [0, 1] };
export const BOKEH_SAMPLES = 48;
// share of the screen from the focus line (the rooms' middle on screen) at which the tilt blur is full
export const TILT_FULL = 0.4;

export interface BokehSettings {
  strength: number;
  start: number;
  range: number;
  tilt: number;
}
export interface GradeSettings {
  saturation: number;
  contrast: number;
  vignette: number;
}
export interface FinishSettings {
  bokeh: BokehSettings | null;
  grade: GradeSettings | null;
}

function norm<T extends object>(
  opt: unknown,
  defaults: Readonly<T>,
  ranges: Record<keyof T, number[]>,
): T | null {
  if (!opt) return null;
  const o =
    opt === true
      ? {}
      : typeof opt === "object"
        ? (opt as Record<string, unknown>)
        : null;
  if (!o) return null;
  const out = {} as Record<keyof T, number>; // every key of ranges is set below
  for (const [k, [lo, hi]] of Object.entries(ranges) as [
    keyof T & string,
    number[],
  ][]) {
    const v = Number(o[k]);
    out[k] =
      o[k] === undefined || !Number.isFinite(v)
        ? (defaults[k] as number)
        : Math.min(hi, Math.max(lo, v));
  }
  return out as T;
}

// Card option bokeh: true | { strength (px blur radius at most), start (m from the rooms: still sharp),
// range (m further: full blur), tilt (0..1: tilt-shift blur above and below the rooms' middle on screen) }
// -> settings, or null (off).
export function normBokeh(opt: unknown): BokehSettings | null {
  const out = norm<BokehSettings>(opt, BOKEH_DEFAULTS, BOKEH_RANGE);
  return out && out.strength > 0 ? out : null;
}

// Card option grade: true | { saturation (1 = as rendered), contrast (0..1), vignette (0..1) }
// -> settings, or null (off).
export const normGrade = (opt: unknown): GradeSettings | null =>
  norm<GradeSettings>(opt, GRADE_DEFAULTS, GRADE_RANGE);

const smooth = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

// Blur share 0..1 at a distance (m) from the rooms' box; must match the shader.
export const cocAt = (
  dist: number,
  { start, range }: { start: number; range: number },
): number => smooth((dist - start) / range);

// Tilt-shift: the shaders' blur step (share of the screen per share of the screen from the focus line) for a
// tilt (0..1) of the bokeh radius (px) at TILT_FULL from the line, on a side of sizePx. 4: their outermost tap.
export const tiltStep = (
  radiusPx: number,
  tilt: number,
  sizePx: number,
): number => (tilt * radiusPx) / (4 * TILT_FULL * sizePx);

// Focus line (0..1, bottom up) of the tilt-shift: the middle of the rooms' band on screen, null without one.
export const focusLine = (band: [number, number] | null): number | null =>
  band ? (band[0] + band[1]) / 2 : null;

// The addon shaders' uniforms for the grade settings:
// - saturation (1 = as rendered) -> HueSaturationShader saturation (-1: grey, 0: as is, s > 0: 1 / (1 - s) x)
// - contrast (0..1) -> BrightnessContrastShader contrast: a straight line through mid grey, slope 1 .. 2
// - vignette (0..1) -> VignetteShader towards black, the corners (|uv - 0.5|^2 = 0.5) vignette x darker
export function gradeUniforms(g: GradeSettings): {
  saturation: number;
  contrast: number;
  offset: number;
  darkness: number;
} {
  const k = g.saturation;
  return {
    saturation: k >= 1 ? 1.001 - 1 / k : k - 1,
    contrast: 0.5 * g.contrast,
    offset: Math.sqrt(2 * g.vignette),
    darkness: 1,
  };
}

// Screen band (0..1, bottom up) of a world box seen by a camera: [y0, y1], or null when it is behind it.
export function screenBand(
  box: THREE.Box3 | null | undefined,
  camera: ViewCamera,
): [number, number] | null {
  if (!box || box.isEmpty()) return null;
  let y0 = Infinity,
    y1 = -Infinity;
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    );
    v.applyMatrix4(camera.matrixWorldInverse);
    if (isPerspective(camera) && v.z > -camera.near) return null;
    v.applyMatrix4(camera.projectionMatrix);
    const y = v.y * 0.5 + 0.5;
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  return [y0, y1];
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// circle of confusion (0..1) per depth pixel; must match cocAt
const COC_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 invProj, camWorld;
uniform vec3 boxMin, boxMax;
uniform float start, range;
varying vec2 vUv;
void main() {
  float d = texture2D(tDepth, vUv).x;
  float coc = 1.0;
  if (d < 1.0) {
    vec4 v = invProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec3 w = (camWorld * vec4(v.xyz / v.w, 1.0)).xyz;
    float dist = length(max(max(boxMin - w, w - boxMax), 0.0));
    coc = smoothstep(0.0, 1.0, (dist - start) / range);
  }
  gl_FragColor = vec4(coc, 0.0, 0.0, 1.0);
}`;

// the disc gather, as a ShaderPass shader (tDiffuse: the frame)
const BokehShader = {
  name: "FloorplanBokehShader",
  uniforms: {
    tDiffuse: { value: null },
    tCoc: { value: null },
    texel: { value: new THREE.Vector2() },
    maxR: { value: 0 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse, tCoc;
uniform vec2 texel;
uniform float maxR;
varying vec2 vUv;
#define N ${BOKEH_SAMPLES}
float weight(vec3 c) { float l = dot(c, vec3(0.299, 0.587, 0.114)); return 1.0 + 4.0 * l * l * l * l; }
void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  float r = texture2D(tCoc, vUv).r * maxR;
  if (r < 0.5) { gl_FragColor = base; return; }
  float w0 = weight(base.rgb);
  vec3 sum = base.rgb * w0;
  float wsum = w0;
  for (int i = 0; i < N; i++) {
    float a = (float(i) + 0.5) / float(N);
    float rad = sqrt(a) * r, ang = float(i) * 2.39996323;
    vec2 uv = vUv + vec2(cos(ang), sin(ang)) * rad * texel;
    // a sample counts when its own blur reaches this far: the sharp rooms do not bleed outwards
    float w = smoothstep(rad - 1.0, rad + 1.0, texture2D(tCoc, uv).r * maxR);
    vec3 c = texture2D(tDiffuse, uv).rgb;
    w *= weight(c);
    sum += c * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / wsum, base.a);
}`,
};

const target = (): THREE.WebGLRenderTarget =>
  new THREE.WebGLRenderTarget(1, 1, {
    depthBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });

export class ScreenFinish {
  renderer: THREE.WebGLRenderer;
  settings: FinishSettings;
  box: THREE.Box3;
  cocTarget: THREE.WebGLRenderTarget;
  color: THREE.FramebufferTexture | null;
  coc: THREE.ShaderMaterial;
  fsQuad: FullScreenQuad;
  bokeh: ShaderPass;
  tiltH: ShaderPass;
  tiltV: ShaderPass;
  hueSaturation: ShaderPass;
  brightnessContrast: ShaderPass;
  vignette: ShaderPass;
  /** ping-pong targets between the passes, at the drawing buffer size */
  buffers: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  /** the tilt-shift focus line (0..1 up the screen) of the last prepare(); null: no tilt this frame */
  _line: number | null;

  // settings: { bokeh: normBokeh() | null, grade: normGrade() | null }
  constructor(renderer: THREE.WebGLRenderer, settings: FinishSettings) {
    this.renderer = renderer;
    this.settings = settings;
    this.box = new THREE.Box3();
    this.cocTarget = target();
    this.color = null; // FramebufferTexture at the drawing buffer size
    this.coc = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: COC_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDepth: { value: null },
        invProj: { value: new THREE.Matrix4() },
        camWorld: { value: new THREE.Matrix4() },
        boxMin: { value: new THREE.Vector3() },
        boxMax: { value: new THREE.Vector3() },
        start: { value: 0 },
        range: { value: 1 },
      },
    });
    this.fsQuad = new FullScreenQuad(this.coc);
    this.bokeh = new ShaderPass(BokehShader);
    this.bokeh.uniforms.tCoc.value = this.cocTarget.texture;
    this.tiltH = new ShaderPass(HorizontalTiltShiftShader);
    this.tiltV = new ShaderPass(VerticalTiltShiftShader);
    this.hueSaturation = new ShaderPass(HueSaturationShader);
    this.brightnessContrast = new ShaderPass(BrightnessContrastShader);
    this.vignette = new ShaderPass(VignetteShader);
    for (const p of this._all()) {
      p.material.depthTest = false; // over the canvas and its depth buffer
      p.material.depthWrite = false;
    }
    this.buffers = [target(), target()];
    this._line = null;
  }

  get needsDepth(): boolean {
    return !!this.settings.bokeh;
  }

  // The rooms' box (world) the lens focuses on.
  setFocus(box: THREE.Box3 | null | undefined): void {
    if (box && !box.isEmpty()) this.box.copy(box);
    else this.box.makeEmpty();
  }

  // Circle of confusion from the depth pre-pass and the tilt-shift line, before the frame render (bokeh only).
  prepare(depth: DepthPrepass, camera: ViewCamera): void {
    const b = this.settings.bokeh;
    if (!b) return;
    const r = this.renderer,
      u = this.coc.uniforms;
    if (
      this.cocTarget.width !== depth.size.x ||
      this.cocTarget.height !== depth.size.y
    )
      this.cocTarget.setSize(depth.size.x, depth.size.y);
    u.tDepth.value = depth.target.depthTexture;
    u.invProj.value.copy(camera.projectionMatrixInverse);
    u.camWorld.value.copy(camera.matrixWorld);
    if (this.box.isEmpty()) {
      u.boxMin.value.setScalar(-1e6);
      u.boxMax.value.setScalar(1e6);
    } else {
      u.boxMin.value.copy(this.box.min);
      u.boxMax.value.copy(this.box.max);
    }
    u.start.value = b.start;
    u.range.value = b.range;
    this._line = b.tilt > 0 ? focusLine(screenBand(this.box, camera)) : null;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.cocTarget);
    this.fsQuad.render(r);
    r.setRenderTarget(prev);
  }

  // The passes of this frame, in order.
  passes(): ShaderPass[] {
    const { bokeh, grade } = this.settings,
      out: ShaderPass[] = [];
    if (bokeh) out.push(this.bokeh);
    if (bokeh && this._line !== null) out.push(this.tiltH, this.tiltV);
    if (grade && grade.saturation !== 1) out.push(this.hueSaturation);
    if (grade && grade.contrast > 0) out.push(this.brightnessContrast);
    if (grade && grade.vignette > 0) out.push(this.vignette);
    return out;
  }

  // After the frame render (canvas): copy it, draw it back finished.
  apply(): void {
    const passes = this.passes();
    if (!passes.length) return;
    const r = this.renderer,
      size = r.getDrawingBufferSize(new THREE.Vector2()),
      { bokeh, grade } = this.settings;
    if (
      !this.color ||
      this.color.image.width !== size.x ||
      this.color.image.height !== size.y
    ) {
      if (this.color) this.color.dispose();
      this.color = new THREE.FramebufferTexture(size.x, size.y);
    }
    for (const t of this.buffers)
      if (t.width !== size.x || t.height !== size.y) t.setSize(size.x, size.y);
    if (bokeh) {
      const radius = bokeh.strength * r.getPixelRatio();
      this.bokeh.uniforms.texel.value.set(1 / size.x, 1 / size.y);
      this.bokeh.uniforms.maxR.value = radius;
      if (this._line !== null) {
        this.tiltH.uniforms.h.value = tiltStep(radius, bokeh.tilt, size.x);
        this.tiltH.uniforms.r.value = this._line;
        this.tiltV.uniforms.v.value = tiltStep(radius, bokeh.tilt, size.y);
        this.tiltV.uniforms.r.value = this._line;
      }
    }
    if (grade) {
      const g = gradeUniforms(grade);
      this.hueSaturation.uniforms.saturation.value = g.saturation;
      this.brightnessContrast.uniforms.contrast.value = g.contrast;
      this.vignette.uniforms.offset.value = g.offset;
      this.vignette.uniforms.darkness.value = g.darkness;
    }
    const prev = r.getRenderTarget(),
      prevAutoClear = r.autoClear;
    r.setRenderTarget(null);
    r.copyFramebufferToTexture(this.color);
    r.autoClear = false;
    // ShaderPass reads readBuffer.texture: the copy of the canvas first, then the ping-pong targets
    let read = { texture: this.color } as unknown as THREE.WebGLRenderTarget;
    passes.forEach((p, i) => {
      const write = this.buffers[i % 2];
      p.renderToScreen = i === passes.length - 1;
      p.render(r, write, read, 0, false);
      read = write;
    });
    r.autoClear = prevAutoClear;
    r.setRenderTarget(prev);
  }

  _all(): ShaderPass[] {
    return [
      this.bokeh,
      this.tiltH,
      this.tiltV,
      this.hueSaturation,
      this.brightnessContrast,
      this.vignette,
    ];
  }

  dispose(): void {
    this.coc.dispose();
    this.fsQuad.dispose();
    for (const p of this._all()) p.dispose();
    this.cocTarget.dispose();
    for (const t of this.buffers) t.dispose();
    if (this.color) this.color.dispose();
  }
}
