// The finish over the frame: the look of a photo of a miniature.
// - bokeh: the rooms stay sharp from any camera, the surroundings blur with their distance from the rooms' box
//   (the facade below, the neighbours, the site, the sky), and with tilt also with their distance on screen
//   from a narrow band through the rooms, like a tilt-shift lens. The circle of confusion comes from the depth
//   pre-pass (depth-pass.js): world position per pixel, distance to the box. The canvas is gathered over a
//   disc (bright points weigh more: bokeh highlights at night); sharp pixels do not spread into blurred ones.
// - grade: saturation, an S-curve contrast and a vignette, as in the photos of models.
// After the frame render the canvas is copied and drawn back finished. Labels (CSS) stay as they are.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export const BOKEH_DEFAULTS = Object.freeze({ strength: 10, start: 0.5, range: 10, tilt: 0 });
const BOKEH_RANGE = { strength: [0, 20], start: [0, 50], range: [0.5, 200], tilt: [0, 1] };
export const GRADE_DEFAULTS = Object.freeze({ saturation: 1.15, contrast: 0.25, vignette: 0.25 });
const GRADE_RANGE = { saturation: [0, 2], contrast: [0, 1], vignette: [0, 1] };
export const BOKEH_SAMPLES = 48;
// share of the screen height over which the tilt blur grows to full outside the focus band, and the band's
// half height around the rooms' centre on screen (narrow like a tilt-shift lens: the rooms themselves stay
// sharp anyway, only what is outside them blurs)
export const TILT_FALLOFF = 0.3;
export const TILT_BAND = 0.1;

function norm(opt, defaults, ranges) {
  if (!opt) return null;
  const o = opt === true ? {} : typeof opt === 'object' ? opt : null;
  if (!o) return null;
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(ranges)) {
    const v = Number(o[k]);
    out[k] = o[k] === undefined || !Number.isFinite(v) ? defaults[k] : Math.min(hi, Math.max(lo, v));
  }
  return out;
}

// Card option bokeh: true | { strength (px blur radius at most), start (m from the rooms: still sharp),
// range (m further: full blur), tilt (0..1: tilt-shift blur above and below the rooms on screen) }
// -> settings, or null (off).
export function normBokeh(opt) {
  const out = norm(opt, BOKEH_DEFAULTS, BOKEH_RANGE);
  return out && out.strength > 0 ? out : null;
}

// Card option grade: true | { saturation (1 = as rendered), contrast (0..1 of an S-curve), vignette (0..1) }
// -> settings, or null (off).
export const normGrade = (opt) => norm(opt, GRADE_DEFAULTS, GRADE_RANGE);

const smooth = (t) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

// Blur share 0..1 at a distance (m) from the rooms' box; must match the shader.
export const cocAt = (dist, { start, range }) => smooth((dist - start) / range);

// Tilt-shift blur share 0..1 at screen height y (0..1) for the rooms' band [y0, y1]; must match the shader.
export const tiltAt = (y, y0, y1, tilt) => tilt * smooth(Math.max(y0 - y, y - y1) / TILT_FALLOFF);

// Focus band (0..1, bottom up) on screen: TILT_BAND around the middle of the box's band, inside it.
export function focusBand(band) {
  if (!band) return null;
  const mid = (band[0] + band[1]) / 2, half = Math.min(TILT_BAND, (band[1] - band[0]) / 2);
  return [mid - half, mid + half];
}

// Screen band (0..1, bottom up) of a world box seen by a camera: [y0, y1], or null when it is behind it.
export function screenBand(box, camera) {
  if (!box || box.isEmpty()) return null;
  let y0 = Infinity, y1 = -Infinity;
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    v.applyMatrix4(camera.matrixWorldInverse);
    if (camera.isPerspectiveCamera && v.z > -camera.near) return null;
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

// circle of confusion (0..1) per depth pixel; must match cocAt / tiltAt
const COC_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 invProj, camWorld;
uniform vec3 boxMin, boxMax;
uniform float start, range, tilt;
uniform vec2 band;
varying vec2 vUv;
void main() {
  float d = texture2D(tDepth, vUv).x;
  float coc = 1.0;
  if (d < 1.0) {
    vec4 v = invProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec3 w = (camWorld * vec4(v.xyz / v.w, 1.0)).xyz;
    float dist = length(max(max(boxMin - w, w - boxMax), 0.0));
    float t = tilt * smoothstep(0.0, 1.0, max(band.x - vUv.y, vUv.y - band.y) / ${TILT_FALLOFF.toFixed(2)});
    // the rooms stay sharp; the tilt blur fades in over the first metre outside them
    coc = max(smoothstep(0.0, 1.0, (dist - start) / range), t * smoothstep(start, start + 1.0, dist));
  }
  gl_FragColor = vec4(coc, 0.0, 0.0, 1.0);
}`;

const FINISH_FRAG = /* glsl */ `
uniform sampler2D tColor, tCoc;
uniform vec2 texel;
uniform float maxR, saturation, contrast, vignette, aspect;
varying vec2 vUv;
#define N ${BOKEH_SAMPLES}
float weight(vec3 c) { float l = dot(c, vec3(0.299, 0.587, 0.114)); return 1.0 + 4.0 * l * l * l * l; }
vec3 bokeh(vec3 base) {
  float r = maxR > 0.0 ? texture2D(tCoc, vUv).r * maxR : 0.0;
  if (r < 0.5) return base;
  float w0 = weight(base);
  vec3 sum = base * w0;
  float wsum = w0;
  for (int i = 0; i < N; i++) {
    float a = (float(i) + 0.5) / float(N);
    float rad = sqrt(a) * r, ang = float(i) * 2.39996323;
    vec2 uv = vUv + vec2(cos(ang), sin(ang)) * rad * texel;
    // a sample counts when its own blur reaches this far: the sharp rooms do not bleed outwards
    float w = smoothstep(rad - 1.0, rad + 1.0, texture2D(tCoc, uv).r * maxR);
    vec3 c = texture2D(tColor, uv).rgb;
    w *= weight(c);
    sum += c * w;
    wsum += w;
  }
  return sum / wsum;
}
void main() {
  vec4 base = texture2D(tColor, vUv);
  vec3 c = bokeh(base.rgb);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = clamp(mix(vec3(l), c, saturation), 0.0, 1.0);
  c = mix(c, c * c * (3.0 - 2.0 * c), contrast);
  vec2 q = (vUv - 0.5) * vec2(aspect, 1.0);
  c *= 1.0 - vignette * smoothstep(0.35, 1.0, length(q) * 1.25);
  gl_FragColor = vec4(c, base.a);
}`;

export class ScreenFinish {
  // settings: { bokeh: normBokeh() | null, grade: normGrade() | null }
  constructor(renderer, settings) {
    this.renderer = renderer;
    this.settings = settings;
    this.box = new THREE.Box3();
    this.cocTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.color = null; // FramebufferTexture at the drawing buffer size
    this.coc = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COC_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tDepth: { value: null }, invProj: { value: new THREE.Matrix4() }, camWorld: { value: new THREE.Matrix4() },
        boxMin: { value: new THREE.Vector3() }, boxMax: { value: new THREE.Vector3() }, start: { value: 0 }, range: { value: 1 },
        tilt: { value: 0 }, band: { value: new THREE.Vector2(0, 1) },
      },
    });
    this.finish = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FINISH_FRAG, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: {
        tColor: { value: null }, tCoc: { value: this.cocTarget.texture }, texel: { value: new THREE.Vector2() }, maxR: { value: 0 },
        saturation: { value: 1 }, contrast: { value: 0 }, vignette: { value: 0 }, aspect: { value: 1 },
      },
    });
    this.fsQuad = new FullScreenQuad(null);
  }

  get needsDepth() {
    return !!this.settings.bokeh;
  }

  // The rooms' box (world) the lens focuses on.
  setFocus(box) {
    if (box && !box.isEmpty()) this.box.copy(box);
    else this.box.makeEmpty();
  }

  // Circle of confusion from the depth pre-pass, before the frame render (bokeh only).
  prepare(depth, camera) {
    const b = this.settings.bokeh;
    if (!b) return;
    const r = this.renderer, u = this.coc.uniforms;
    if (this.cocTarget.width !== depth.size.x || this.cocTarget.height !== depth.size.y) this.cocTarget.setSize(depth.size.x, depth.size.y);
    u.tDepth.value = depth.target.depthTexture;
    u.invProj.value.copy(camera.projectionMatrixInverse);
    u.camWorld.value.copy(camera.matrixWorld);
    if (this.box.isEmpty()) { u.boxMin.value.setScalar(-1e6); u.boxMax.value.setScalar(1e6); }
    else { u.boxMin.value.copy(this.box.min); u.boxMax.value.copy(this.box.max); }
    u.start.value = b.start;
    u.range.value = b.range;
    const band = focusBand(screenBand(this.box, camera));
    u.tilt.value = band ? b.tilt : 0;
    if (band) u.band.value.set(band[0], band[1]);
    const prev = r.getRenderTarget();
    this.fsQuad.material = this.coc;
    r.setRenderTarget(this.cocTarget);
    this.fsQuad.render(r);
    r.setRenderTarget(prev);
  }

  // After the frame render (canvas): copy it, draw it back finished.
  apply() {
    const r = this.renderer, size = r.getDrawingBufferSize(new THREE.Vector2()), { bokeh, grade } = this.settings;
    if (!this.color || this.color.image.width !== size.x || this.color.image.height !== size.y) {
      if (this.color) this.color.dispose();
      this.color = new THREE.FramebufferTexture(size.x, size.y);
    }
    const prev = r.getRenderTarget(), prevAutoClear = r.autoClear;
    r.setRenderTarget(null);
    r.copyFramebufferToTexture(this.color);
    const u = this.finish.uniforms;
    u.tColor.value = this.color;
    u.texel.value.set(1 / size.x, 1 / size.y);
    u.aspect.value = size.x / size.y;
    u.maxR.value = bokeh ? bokeh.strength * r.getPixelRatio() : 0;
    u.saturation.value = grade ? grade.saturation : 1;
    u.contrast.value = grade ? grade.contrast : 0;
    u.vignette.value = grade ? grade.vignette : 0;
    r.autoClear = false;
    this.fsQuad.material = this.finish;
    this.fsQuad.render(r);
    r.autoClear = prevAutoClear;
    r.setRenderTarget(prev);
  }

  dispose() {
    this.coc.dispose();
    this.finish.dispose();
    this.fsQuad.dispose();
    this.cocTarget.dispose();
    if (this.color) this.color.dispose();
  }
}
