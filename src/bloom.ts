// Selective bloom (render quality 'high', QualityTier.bloom): only emissive things glow — lamp glow meshes of
// lights that are on, screens, any emissive model material — never walls lit by a lamp or the sun.
// After the frame render: the emissive surfaces alone (everything opaque drawn black, so walls in front still
// hide a lamp) at half the drawing buffer size in a half-float target, blurred down and up a mip chain
// (dual filter: 5 taps down, 8 taps up), added to the canvas in display-linear light. A frame with no emissive
// surface in view runs nothing but the search (a walk over the visible meshes); idle frames are never drawn.
import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { occludes } from "./depth-pass.ts";
import type { Drawable } from "./view/core.ts";

/** Share of the bloom added to the frame. */
export const BLOOM_STRENGTH = 0.6;
/** Blur levels below the half-size source (1/4 .. 1/64 of the drawing buffer). */
export const BLOOM_LEVELS = 5;
/** Emissive radiance (colour × intensity, brightest channel) below which a surface does not bloom. */
export const BLOOM_MIN_EMISSIVE = 0.05;

type EmissiveMaterial = THREE.Material & {
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  emissiveMap?: THREE.Texture | null;
  map?: THREE.Texture | null;
  alphaMap?: THREE.Texture | null;
};
type Flags = {
  isMesh?: boolean;
  isSprite?: boolean;
  isPoints?: boolean;
  isLine?: boolean;
};

const matsOf = (o: Drawable): (EmissiveMaterial | undefined)[] =>
  (Array.isArray(o.material) ? o.material : [o.material]) as (
    EmissiveMaterial | undefined
  )[];

// The emissive radiance of a material (brightest channel of colour × intensity), 0 when it does not glow.
export function emissiveLevel(m: EmissiveMaterial | null | undefined): number {
  if (!m || m.visible === false || m.colorWrite === false || !m.emissive)
    return 0;
  const e = m.emissive,
    k = m.emissiveIntensity ?? 1;
  return Math.max(e.r, e.g, e.b) * Math.max(0, k);
}

// A mesh that blooms: one of its materials glows at least BLOOM_MIN_EMISSIVE.
export function blooms(o: Drawable): boolean {
  const f = o as Flags;
  if (!f.isMesh || f.isSprite || (o.userData && o.userData.helper))
    return false;
  return matsOf(o).some((m) => emissiveLevel(m) >= BLOOM_MIN_EMISSIVE);
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// dual filter (Bjørge 2015): the centre and 4 diagonal taps one source texel out (each a bilinear 2 x 2 average)
const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += texture2D(tSrc, vUv + vec2(-1.0, -1.0) * texel).rgb;
  c += texture2D(tSrc, vUv + vec2(1.0, -1.0) * texel).rgb;
  c += texture2D(tSrc, vUv + vec2(-1.0, 1.0) * texel).rgb;
  c += texture2D(tSrc, vUv + vec2(1.0, 1.0) * texel).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}`;

const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv + vec2(-2.0, 0.0) * texel).rgb;
  c += texture2D(tSrc, vUv + vec2(2.0, 0.0) * texel).rgb;
  c += texture2D(tSrc, vUv + vec2(0.0, -2.0) * texel).rgb;
  c += texture2D(tSrc, vUv + vec2(0.0, 2.0) * texel).rgb;
  c += texture2D(tSrc, vUv + vec2(-1.0, -1.0) * texel).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(1.0, -1.0) * texel).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(-1.0, 1.0) * texel).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(1.0, 1.0) * texel).rgb * 2.0;
  gl_FragColor = vec4(c / 12.0, 1.0);
}`;

// the canvas (tone mapped, sRGB or linear) + the bloom (scene linear, compressed so it never clips harshly)
const ADD_FRAG = /* glsl */ `
uniform sampler2D tColor, tBloom;
uniform float strength, exposure, srgb;
varying vec2 vUv;
vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
void main() {
  vec4 base = texture2D(tColor, vUv);
  vec3 b = 1.0 - exp(-texture2D(tBloom, vUv).rgb * strength * exposure);
  vec3 c = srgb > 0.5 ? toLin(base.rgb) : base.rgb;
  c = min(c + b, 1.0);
  gl_FragColor = vec4(srgb > 0.5 ? toSrgb(c) : c, base.a);
}`;

const target = (): THREE.WebGLRenderTarget =>
  new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });

export class SelectiveBloom {
  renderer: THREE.WebGLRenderer;
  source: THREE.WebGLRenderTarget;
  levels: THREE.WebGLRenderTarget[];
  color: THREE.FramebufferTexture | null;
  down: THREE.ShaderMaterial;
  up: THREE.ShaderMaterial;
  add: THREE.ShaderMaterial;
  fsQuad: FullScreenQuad;
  stats: { passes: number; skipped: number };
  _black: WeakMap<THREE.Material, THREE.MeshBasicMaterial>;
  _glow: WeakMap<THREE.Material, THREE.MeshBasicMaterial>;
  _frustum: THREE.Frustum;
  _m: THREE.Matrix4;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.source = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.levels = Array.from({ length: BLOOM_LEVELS }, target);
    this.color = null; // FramebufferTexture at the drawing buffer size
    const pass = (frag: string, blending: THREE.Blending = THREE.NoBlending) =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: frag,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        blending,
        uniforms: {
          tSrc: { value: null },
          texel: { value: new THREE.Vector2() },
        },
      });
    this.down = pass(DOWN_FRAG);
    this.up = pass(UP_FRAG, THREE.AdditiveBlending); // each level adds onto the one above it
    this.add = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: ADD_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        tColor: { value: null },
        tBloom: { value: null },
        strength: { value: BLOOM_STRENGTH },
        exposure: { value: 1 },
        srgb: { value: 1 },
      },
    });
    this.fsQuad = new FullScreenQuad(this.down);
    this.stats = { passes: 0, skipped: 0 };
    this._black = new WeakMap();
    this._glow = new WeakMap();
    this._frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
  }

  // Stand-ins keep the source's side, clipping (the cut-away) and alpha test.
  _sync<T extends THREE.MeshBasicMaterial>(
    d: T,
    m: EmissiveMaterial,
    map: THREE.Texture | null,
  ): T {
    d.side = m.side;
    d.clippingPlanes = m.clippingPlanes;
    d.clipIntersection = m.clipIntersection;
    const alphaMap = m.alphaTest > 0 ? m.alphaMap || null : null;
    if (
      !!map !== !!d.map ||
      !!alphaMap !== !!d.alphaMap ||
      m.alphaTest > 0 !== d.alphaTest > 0
    )
      d.needsUpdate = true; // other shader defines
    d.alphaTest = m.alphaTest;
    d.map = map;
    d.alphaMap = alphaMap;
    return d;
  }

  _blackMat(m: EmissiveMaterial): THREE.MeshBasicMaterial {
    let d = this._black.get(m);
    if (!d) {
      d = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false });
      this._black.set(m, d);
    }
    return this._sync(d, m, m.alphaTest > 0 ? m.map || null : null);
  }

  // The emissive surface alone: colour × intensity (scene linear), times its emissive map.
  _glowMat(m: EmissiveMaterial): THREE.MeshBasicMaterial {
    let d = this._glow.get(m);
    if (!d) {
      d = new THREE.MeshBasicMaterial({ fog: false });
      this._glow.set(m, d);
    }
    const level = emissiveLevel(m);
    if (level > 0)
      d.color.copy(m.emissive!).multiplyScalar(m.emissiveIntensity ?? 1); // level > 0: emissive set
    else d.color.setRGB(0, 0, 0);
    d.transparent = m.transparent;
    d.depthWrite = m.depthWrite;
    d.opacity = m.opacity;
    return this._sync(d, m, m.emissiveMap || null);
  }

  // Is any emissive surface in view? (the walk the skip costs)
  _anyInView(scene: THREE.Scene, camera: THREE.Camera): boolean {
    camera.updateMatrixWorld();
    this._frustum.setFromProjectionMatrix(
      this._m.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      ),
    );
    let found = false;
    scene.traverseVisible((obj) => {
      if (found) return;
      const o = obj as Drawable;
      if (blooms(o) && this._frustum.intersectsObject(obj)) found = true;
    });
    return found;
  }

  // After the frame render (canvas): bloom the emissive surfaces into it. -> true when a pass ran.
  render(scene: THREE.Scene, camera: THREE.Camera): boolean {
    if (!this._anyInView(scene, camera)) {
      this.stats.skipped++;
      return false;
    }
    this.stats.passes++;
    const r = this.renderer,
      full = r.getDrawingBufferSize(new THREE.Vector2());
    let w = Math.max(1, Math.round(full.x / 2)),
      h = Math.max(1, Math.round(full.y / 2));
    if (this.source.width !== w || this.source.height !== h) {
      this.source.setSize(w, h);
      for (const l of this.levels) {
        w = Math.max(1, Math.round(w / 2));
        h = Math.max(1, Math.round(h / 2));
        l.setSize(w, h);
      }
    }
    const prevTarget = r.getRenderTarget(),
      prevAutoClear = r.autoClear,
      prevShadow = r.shadowMap.needsUpdate;
    const clear = r.getClearColor(new THREE.Color()),
      clearAlpha = r.getClearAlpha();
    const swapped: [Drawable, THREE.Material | THREE.Material[] | undefined][] =
        [],
      hidden: THREE.Object3D[] = [];
    scene.traverseVisible((obj) => {
      const o = obj as Drawable,
        f = obj as Flags;
      if (!(f.isMesh || f.isPoints || f.isLine || f.isSprite)) return;
      const glow = blooms(o);
      if (!glow && !occludes(o)) {
        o.visible = false;
        hidden.push(o);
        return;
      }
      swapped.push([o, o.material]);
      const stand = (m: EmissiveMaterial) =>
        glow && emissiveLevel(m) > 0 ? this._glowMat(m) : this._blackMat(m);
      o.material = Array.isArray(o.material)
        ? o.material.map((m) => stand(m as EmissiveMaterial))
        : stand(o.material as EmissiveMaterial);
    });
    r.shadowMap.needsUpdate = false; // the shadow maps were drawn with the frame
    r.autoClear = true;
    r.setClearColor(0x000000, 1);
    try {
      r.setRenderTarget(this.source);
      r.render(scene, camera);
    } finally {
      for (const [o, m] of swapped) o.material = m;
      for (const o of hidden) o.visible = true;
      r.shadowMap.needsUpdate = prevShadow;
    }
    // down the chain, then back up: each level adds the blurred level below it
    const q = this.fsQuad;
    let src: THREE.WebGLRenderTarget = this.source;
    q.material = this.down;
    for (const l of this.levels) {
      this.down.uniforms.tSrc.value = src.texture;
      this.down.uniforms.texel.value.set(1 / src.width, 1 / src.height);
      r.setRenderTarget(l);
      q.render(r);
      src = l;
    }
    q.material = this.up;
    r.autoClear = false;
    for (let i = this.levels.length - 1; i > 0; i--) {
      const lo = this.levels[i];
      this.up.uniforms.tSrc.value = lo.texture;
      this.up.uniforms.texel.value.set(0.5 / lo.width, 0.5 / lo.height);
      r.setRenderTarget(this.levels[i - 1]);
      q.render(r);
    }
    // onto the canvas
    if (
      !this.color ||
      this.color.image.width !== full.x ||
      this.color.image.height !== full.y
    ) {
      if (this.color) this.color.dispose();
      this.color = new THREE.FramebufferTexture(full.x, full.y);
    }
    r.setRenderTarget(null);
    r.copyFramebufferToTexture(this.color);
    const u = this.add.uniforms;
    u.tColor.value = this.color;
    u.tBloom.value = this.levels[0].texture;
    u.strength.value = BLOOM_STRENGTH / this.levels.length;
    u.exposure.value = r.toneMappingExposure;
    u.srgb.value = r.outputColorSpace === THREE.SRGBColorSpace ? 1 : 0;
    q.material = this.add;
    q.render(r);
    r.setRenderTarget(prevTarget);
    r.setClearColor(clear, clearAlpha);
    r.autoClear = prevAutoClear;
    return true;
  }

  dispose(): void {
    this.down.dispose();
    this.up.dispose();
    this.add.dispose();
    this.fsQuad.dispose();
    this.source.dispose();
    for (const l of this.levels) l.dispose();
    if (this.color) this.color.dispose();
  }
}
