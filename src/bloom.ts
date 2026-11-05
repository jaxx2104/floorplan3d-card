// Selective bloom (render quality 'high' and 'still', QualityTier.bloom): only emissive things glow — lamp glow meshes of
// lights that are on, screens, any emissive model material — never walls lit by a lamp or the sun.
// After the frame render: the emissive surfaces alone (everything opaque drawn black, so walls in front still
// hide a lamp) at half the drawing buffer size in a half-float target, blurred by three's UnrealBloomPass (its
// mip chain of separable Gaussians, no threshold: the source holds nothing but the emissive surfaces), its
// composite added to the canvas in display-linear light. A frame with no emissive surface in view runs nothing
// but the search (a walk over the visible meshes); idle frames are never drawn.
import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { occludes } from "./depth-pass.ts";
import type { Drawable } from "./view/core.ts";

/** Share of the bloom added to the frame. */
export const BLOOM_STRENGTH = 0.6;
/** UnrealBloomPass radius (0..1: the share of the wide mips; 0.5 weighs its five mips alike). */
export const BLOOM_RADIUS = 0.5;
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

// UnrealBloomPass strength for a composite of BLOOM_STRENGTH x the mean of its mips: its composite is
// 3 x strength x the sum of the mips, each weighted by mix(factor, 1.2 - factor, radius).
export function unrealStrength(radius: number = BLOOM_RADIUS): number {
  const factors = [1.0, 0.8, 0.6, 0.4, 0.2];
  const sum = factors.reduce((t, f) => t + f + (1.2 - 2 * f) * radius, 0);
  return BLOOM_STRENGTH / (3 * sum);
}

export class SelectiveBloom {
  renderer: THREE.WebGLRenderer;
  source: THREE.WebGLRenderTarget;
  blur: UnrealBloomPass;
  color: THREE.FramebufferTexture | null;
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
    // sized to the source: its mips start at half of that
    this.blur = new UnrealBloomPass(
      new THREE.Vector2(2, 2),
      unrealStrength(),
      BLOOM_RADIUS,
      -1, // no threshold: every emissive pixel blooms
    );
    this.color = null; // FramebufferTexture at the drawing buffer size
    this.add = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: ADD_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        tColor: { value: null },
        tBloom: { value: null },
        strength: { value: 1 },
        exposure: { value: 1 },
        srgb: { value: 1 },
      },
    });
    this.fsQuad = new FullScreenQuad(this.add);
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
    const w = Math.max(1, Math.round(full.x / 2)),
      h = Math.max(1, Math.round(full.y / 2));
    if (this.source.width !== w || this.source.height !== h) {
      this.source.setSize(w, h);
      this.blur.setSize(w, h); // its mips: 1/4 .. 1/64 of the drawing buffer
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
    // the blur: UnrealBloomPass's composite lands in its first horizontal target (it then also adds itself
    // onto the source, which is not read again)
    this.blur.render(r, this.source, this.source, 0, false);
    const q = this.fsQuad;
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
    r.autoClear = false;
    r.copyFramebufferToTexture(this.color);
    const u = this.add.uniforms;
    u.tColor.value = this.color;
    u.tBloom.value = this.blur.renderTargetsHorizontal[0].texture;
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
    this.blur.dispose();
    this.add.dispose();
    this.fsQuad.dispose();
    this.source.dispose();
    if (this.color) this.color.dispose();
  }
}
