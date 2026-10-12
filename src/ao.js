// Screen-space ambient occlusion over the model (card option ao). Before each frame, from the depth pre-pass
// of the opaque meshes (depth-pass.js: their own side, clipping planes and alpha test, so the cut-away stays
// cut): SAO (scalable ambient obscurance) at a reduced resolution and a depth-aware blur. In the frame itself a full-screen quad multiplies the canvas right after the opaque pass (lowest transparent render
// order), so whatever is drawn later (glows, rain, sprites, lines) is not darkened, and the main render keeps
// its tone mapping, MSAA and background.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export const AO_DEFAULTS = Object.freeze({ intensity: 1, radius: 0.5, resolution: 0.5 });
const AO_RANGE = { intensity: [0, 4], radius: [0.05, 3], resolution: [0.25, 1] };
export const AO_SAMPLES = 16;
// darkest the occlusion gets (share of the light left)
export const AO_FLOOR = 0.45;

// Card option ao: true | { intensity, radius (m), resolution (share of the canvas) } -> settings, or null (off).
export function normAo(opt) {
  if (!opt) return null;
  const o = opt === true ? {} : typeof opt === 'object' ? opt : null;
  if (!o) return null;
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(AO_RANGE)) {
    const v = Number(o[k]);
    out[k] = o[k] === undefined || !Number.isFinite(v) ? AO_DEFAULTS[k] : Math.min(hi, Math.max(lo, v));
  }
  return out;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// view-space position from the depth texture (any projection, view offsets included)
const VIEW_POS = /* glsl */ `
uniform sampler2D tDepth, tFront;
bool front(vec2 uv) { return texture2D(tFront, uv).r > 0.5; }
uniform mat4 invProj;
vec3 viewPos(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  vec4 v = invProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return v.xyz / v.w;
}`;

const SAO_FRAG = /* glsl */ `
${VIEW_POS}
uniform vec2 texel;
uniform float radius, intensity, projScale, persp;
varying vec2 vUv;
#define N ${AO_SAMPLES}
#define TURNS 7.0
#define AO_FLOOR ${AO_FLOOR.toFixed(2)}
void main() {
  float d = texture2D(tDepth, vUv).x;
  if (d >= 1.0 || !front(vUv)) { gl_FragColor = vec4(1.0); return; }
  vec3 p = viewPos(vUv);
  // normal from the nearer neighbour on each axis: no smearing across depth edges
  vec3 l = viewPos(vUv - vec2(texel.x, 0.0)), r = viewPos(vUv + vec2(texel.x, 0.0));
  vec3 b = viewPos(vUv - vec2(0.0, texel.y)), t = viewPos(vUv + vec2(0.0, texel.y));
  vec3 dx = abs(r.z - p.z) < abs(p.z - l.z) ? r - p : p - l;
  vec3 dy = abs(t.z - p.z) < abs(p.z - b.z) ? t - p : p - b;
  vec3 n = normalize(cross(dx, dy));
  float rPx = radius * projScale / mix(1.0, -p.z, persp); // the radius on screen, in AO pixels
  rPx = min(rPx, 0.25 / texel.y);
  if (rPx < 1.0) { gl_FragColor = vec4(1.0); return; }
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
  float r2 = radius * radius, sum = 0.0, bias = 0.05 * radius + 0.002 * -p.z;
  for (int i = 0; i < N; i++) {
    float a = (float(i) + 0.5) / float(N);
    float ang = a * TURNS * 6.2831853 + noise;
    vec2 uv = vUv + a * rPx * vec2(cos(ang), sin(ang)) * texel;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 || !front(uv)) continue;
    vec3 v = viewPos(uv) - p;
    float vv = dot(v, v), vn = dot(v, n);
    float f = max(r2 - vv, 0.0);
    sum += f * f * f * max((vn - bias) / (0.01 * r2 + vv), 0.0);
  }
  // never below AO_FLOOR: a deep corner reads as shade, not as a black band
  float ao = max(AO_FLOOR, 1.0 - sum * intensity / (r2 * r2 * r2) * (5.0 / float(N)));
  gl_FragColor = vec4(vec3(ao), 1.0);
}`;

// separable blur that keeps depth edges (weights fall off with the view depth difference)
const BLUR_FRAG = /* glsl */ `
${VIEW_POS}
uniform sampler2D tAo;
uniform vec2 dir;
varying vec2 vUv;
void main() {
  float z = viewPos(vUv).z, sum = 0.0, wsum = 0.0;
  for (int i = -4; i <= 4; i++) {
    vec2 uv = vUv + float(i) * dir;
    float zi = viewPos(uv).z;
    float w = exp(-float(i * i) / 10.0) * max(0.0, 1.0 - abs(zi - z) / (0.05 * abs(z) + 0.02));
    sum += texture2D(tAo, uv).x * w;
    wsum += w;
  }
  gl_FragColor = vec4(vec3(wsum > 0.0 ? sum / wsum : 1.0), 1.0);
}`;

const APPLY_FRAG = /* glsl */ `
uniform sampler2D tAo;
varying vec2 vUv;
void main() { gl_FragColor = vec4(vec3(texture2D(tAo, vUv).x), 1.0); }`;

export class AmbientOcclusion {
  constructor(renderer, settings) {
    this.renderer = renderer;
    this.settings = settings;
    this.size = new THREE.Vector2();
    const rt = () => new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.aoTarget = rt();
    this.blurTarget = rt();
    const tDepth = { value: null }, tFront = { value: null }, invProj = { value: new THREE.Matrix4() };
    this.sao = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: SAO_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tDepth, tFront, invProj, texel: { value: new THREE.Vector2() }, radius: { value: 0 }, intensity: { value: 0 }, projScale: { value: 0 }, persp: { value: 1 } },
    });
    this.blur = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tDepth, tFront, invProj, tAo: { value: null }, dir: { value: new THREE.Vector2() } },
    });
    this.fsQuad = new FullScreenQuad(null);
    // multiplies the canvas colour, keeps its alpha
    const apply = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: APPLY_FRAG, uniforms: { tAo: { value: this.aoTarget.texture } },
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), apply);
    quad.frustumCulled = false;
    quad.renderOrder = -1e6;
    quad.raycast = () => {};
    quad.userData.helper = true;
    // the group's render order sorts it before every other transparent object
    this.object = new THREE.Group();
    this.object.renderOrder = -1e6;
    this.object.userData.helper = true;
    this.object.visible = false; // only in the frame render (not in picking / occlusion / stats renders)
    this.object.add(quad);
    this.quad = quad;
    this._tDepth = tDepth;
    this._tFront = tFront;
  }

  _setSize(w, h) {
    if (this.size.x === w && this.size.y === h) return;
    this.size.set(w, h);
    this.aoTarget.setSize(w, h);
    this.blurTarget.setSize(w, h);
  }

  // SAO and blur from the depth pre-pass (depth-pass.js) for this camera; shows the quad for the next scene
  // render (end() hides it).
  begin(depth, camera) {
    const r = this.renderer, s = this.settings;
    const w = depth.size.x, h = depth.size.y;
    this._setSize(w, h);
    this._tDepth.value = depth.target.depthTexture;
    this._tFront.value = depth.target.texture;
    const prevTarget = r.getRenderTarget(), prevAutoClear = r.autoClear;
    const clear = r.getClearColor(new THREE.Color()), clearAlpha = r.getClearAlpha();
    r.autoClear = true;

    const u = this.sao.uniforms, proj = camera.projectionMatrix;
    u.invProj.value.copy(camera.projectionMatrixInverse);
    u.texel.value.set(1 / w, 1 / h);
    u.radius.value = s.radius;
    u.intensity.value = s.intensity;
    u.persp.value = camera.isPerspectiveCamera ? 1 : 0;
    u.projScale.value = proj.elements[5] * 0.5 * h;
    r.setClearColor(0xffffff, 1);
    this.fsQuad.material = this.sao;
    r.setRenderTarget(this.aoTarget);
    this.fsQuad.render(r);
    this.fsQuad.material = this.blur;
    const bu = this.blur.uniforms;
    bu.tAo.value = this.aoTarget.texture;
    bu.dir.value.set(1 / w, 0);
    r.setRenderTarget(this.blurTarget);
    this.fsQuad.render(r);
    bu.tAo.value = this.blurTarget.texture;
    bu.dir.value.set(0, 1 / h);
    r.setRenderTarget(this.aoTarget);
    this.fsQuad.render(r);

    r.setRenderTarget(prevTarget);
    r.setClearColor(clear, clearAlpha);
    r.autoClear = prevAutoClear;
    this.object.visible = true;
  }

  end() {
    this.object.visible = false;
  }

  dispose() {
    if (this.object.parent) this.object.parent.remove(this.object);
    this.quad.geometry.dispose();
    this.quad.material.dispose();
    this.sao.dispose();
    this.blur.dispose();
    this.fsQuad.dispose();
    this.aoTarget.dispose();
    this.blurTarget.dispose();
  }
}
