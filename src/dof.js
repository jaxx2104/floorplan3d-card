// Focus on the home (card option bokeh): the rooms stay sharp from any camera, the surroundings blur with
// their distance from the rooms' box (the facade below, the neighbours, the street, the sky), like a lens
// focused on the flat. The circle of confusion comes from the depth pre-pass (depth-pass.js): world
// position per pixel, distance to the box. After the frame render the canvas is copied and gathered over
// a disc (bright points weigh more: bokeh highlights at night); sharp pixels do not spread into blurred
// ones. Labels (CSS) stay sharp.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export const BOKEH_DEFAULTS = Object.freeze({ strength: 10, start: 0.5, range: 10 });
const BOKEH_RANGE = { strength: [0, 20], start: [0, 50], range: [0.5, 200] };
export const BOKEH_SAMPLES = 48;

// Card option bokeh: true | { strength (px blur radius at most), start (m from the rooms: still sharp),
// range (m further: full blur) } -> settings, or null (off).
export function normBokeh(opt) {
  if (!opt) return null;
  const o = opt === true ? {} : typeof opt === 'object' ? opt : null;
  if (!o) return null;
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(BOKEH_RANGE)) {
    const v = Number(o[k]);
    out[k] = o[k] === undefined || !Number.isFinite(v) ? BOKEH_DEFAULTS[k] : Math.min(hi, Math.max(lo, v));
  }
  return out.strength > 0 ? out : null;
}

// Blur share 0..1 at a distance (m) from the rooms' box.
export function cocAt(dist, { start, range }) {
  const t = Math.max(0, Math.min(1, (dist - start) / range));
  return t * t * (3 - 2 * t);
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

const GATHER_FRAG = /* glsl */ `
uniform sampler2D tColor, tCoc;
uniform vec2 texel;
uniform float maxR;
varying vec2 vUv;
#define N ${BOKEH_SAMPLES}
float weight(vec3 c) { float l = dot(c, vec3(0.299, 0.587, 0.114)); return 1.0 + 4.0 * l * l * l * l; }
void main() {
  vec4 base = texture2D(tColor, vUv);
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
    vec3 c = texture2D(tColor, uv).rgb;
    w *= weight(c);
    sum += c * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / wsum, base.a);
}`;

export class DepthOfField {
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
      },
    });
    this.gather = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: GATHER_FRAG, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: { tColor: { value: null }, tCoc: { value: this.cocTarget.texture }, texel: { value: new THREE.Vector2() }, maxR: { value: 0 } },
    });
    this.fsQuad = new FullScreenQuad(null);
  }

  // The rooms' box (world) the lens focuses on.
  setFocus(box) {
    if (box && !box.isEmpty()) this.box.copy(box);
    else this.box.makeEmpty();
  }

  // Circle of confusion from the depth pre-pass, before the frame render.
  prepare(depth, camera) {
    const r = this.renderer, u = this.coc.uniforms, s = this.settings;
    if (this.cocTarget.width !== depth.size.x || this.cocTarget.height !== depth.size.y) this.cocTarget.setSize(depth.size.x, depth.size.y);
    u.tDepth.value = depth.target.depthTexture;
    u.invProj.value.copy(camera.projectionMatrixInverse);
    u.camWorld.value.copy(camera.matrixWorld);
    if (this.box.isEmpty()) { u.boxMin.value.setScalar(-1e6); u.boxMax.value.setScalar(1e6); }
    else { u.boxMin.value.copy(this.box.min); u.boxMax.value.copy(this.box.max); }
    u.start.value = s.start;
    u.range.value = s.range;
    const prev = r.getRenderTarget();
    this.fsQuad.material = this.coc;
    r.setRenderTarget(this.cocTarget);
    this.fsQuad.render(r);
    r.setRenderTarget(prev);
  }

  // After the frame render (canvas): copy it, draw it back blurred.
  apply() {
    const r = this.renderer, size = r.getDrawingBufferSize(new THREE.Vector2());
    if (!this.color || this.color.image.width !== size.x || this.color.image.height !== size.y) {
      if (this.color) this.color.dispose();
      this.color = new THREE.FramebufferTexture(size.x, size.y);
    }
    const prev = r.getRenderTarget(), prevAutoClear = r.autoClear;
    r.setRenderTarget(null);
    r.copyFramebufferToTexture(this.color);
    const u = this.gather.uniforms;
    u.tColor.value = this.color;
    u.texel.value.set(1 / size.x, 1 / size.y);
    u.maxR.value = this.settings.strength * r.getPixelRatio();
    r.autoClear = false;
    this.fsQuad.material = this.gather;
    this.fsQuad.render(r);
    r.autoClear = prevAutoClear;
    r.setRenderTarget(prev);
  }

  dispose() {
    this.coc.dispose();
    this.gather.dispose();
    this.fsQuad.dispose();
    this.cocTarget.dispose();
    if (this.color) this.color.dispose();
  }
}
