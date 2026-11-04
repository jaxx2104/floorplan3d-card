// The path tracer of render quality 'still' (still.ts): three-gpu-pathtracer, in its own chunk, imported by
// view/still.ts only when the tier traces. A session traces the model as it is lit now:
//   - geometry: the model's visible meshes (helpers, the view's overlays, markers, glows and light washes are not
//     part of it), merged with a BVH over them. Built once per model / visibility / material upgrade and reused by
//     every idle session after it; lights, materials and the environment are re-read at each session's start
//     (uniform data, cheap), the materials only when one changed.
//   - lights: the sun and the moon (directional), the lamps of the model objects (point / spot lights in physical
//     units under the tier's physicalLights), emissive surfaces (lamp glows, screens) as area emitters.
//   - environment: the sky environment's cube (view/env-light.ts, the sky without the sun disc) at
//     scene.environmentIntensity; the background stays the raster frame's (the card colour, the sun / moon sprites).
//   - materials: three's standard and physical properties and maps (colour, roughness, metalness, normal,
//     emissive, transmission, clear coat, sheen, opacity).
// What it cannot express is left out: the hemisphere light (the sky environment lights instead), shader patches
// (cloud shadows, contact shadows, PCSS, city windows, sway, probes and baked lightmaps: the trace computes the
// indirect light itself), clipping (the view does not trace while a cut-away or section clips), and the post
// passes (ambient occlusion, bloom, bokeh / grade): they stay in the raster frame below while the trace fades in.
import * as THREE from 'three';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { STILL_BOUNCES, STILL_SCALE, STILL_TILES, STILL_TRANSMISSIVE_BOUNCES } from './still.ts';

/** What a session traces. */
export interface TraceSource {
  /** roots of the traced geometry (visible meshes under them) */
  meshes: THREE.Object3D[];
  /** roots of the traced lights (visible lights with some intensity) */
  lights: THREE.Object3D[];
  /** objects left out with their children (helpers) */
  skip: (o: THREE.Object3D) => boolean;
  /** meshes left out alone (hidden from the camera by layers, invisible materials); their children still count */
  drop: (o: THREE.Object3D) => boolean;
  /** the sky environment cube (null: none) and its intensity */
  environment: THREE.CubeTexture | null;
  environmentIntensity: number;
  /** changes when the geometry to trace changed (model, visible levels / nodes, material upgrades) */
  geometryKey: string;
  /** changes when the environment cube was rebuilt */
  envKey: string;
}

// WebGLPathTracer internals used here (not in its typings).
interface TracerInternals {
  _quad: FullScreenQuad;
  _materials: THREE.Material[] | null;
  _previousEnvironment: THREE.Texture | null;
  _pathTracer: { dispose(): void; material: THREE.ShaderMaterial };
  _lowResPathTracer: { dispose(): void; material: THREE.ShaderMaterial };
  _generator: { geometry: THREE.BufferGeometry };
}

// A material's state the trace reads: when it changes the materials are uploaded again.
function materialSig(m: THREE.Material): string {
  const s = m as Partial<THREE.MeshPhysicalMaterial>;
  const hex = (c: THREE.Color | undefined) => (c ? c.getHexString() : '-');
  return [m.uuid, m.version, hex(s.color), hex(s.emissive), s.emissiveIntensity ?? 0, m.opacity, s.roughness ?? '', s.metalness ?? '', s.transmission ?? '', m.visible ? 1 : 0].join(':');
}

// Copies a texture to the drawing buffer as it is (no tone mapping, no colour conversion): the raster frame.
function copyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: null } },
    vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
    fragmentShader: 'uniform sampler2D map;\nvarying vec2 vUv;\nvoid main() { gl_FragColor = texture2D( map, vUv ); }',
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });
}

export class PathTraceSession {
  renderer: THREE.WebGLRenderer;
  tracer: WebGLPathTracer;
  /** builds of the traced geometry (BVH) */
  builds: number;
  _geometryKey: string | null;
  _envKey: string | null;
  _matSig: string;
  _raster: THREE.FramebufferTexture | null;
  _copy: FullScreenQuad;
  _proxy: THREE.Scene;
  _src: TraceSource | null;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const t = new WebGLPathTracer(renderer);
    t.renderToCanvas = false; // the view draws: the raster frame, then the trace over it
    t.rasterizeScene = false;
    t.renderDelay = 0;
    t.minSamples = 0;
    t.fadeDuration = 0;
    t.dynamicLowRes = false;
    t.renderScale = STILL_SCALE;
    t.tiles.set(STILL_TILES, STILL_TILES);
    t.bounces = STILL_BOUNCES;
    t.transmissiveBounces = STILL_TRANSMISSIVE_BOUNCES;
    t.filterGlossyFactor = 0.5; // fewer fireflies from glossy paths
    this.tracer = t;
    const quad = (t as unknown as TracerInternals)._quad;
    quad.material.transparent = true;
    quad.material.blending = THREE.NormalBlending; // the trace over the raster frame (its background stays)
    this.builds = 0;
    this._geometryKey = null;
    this._envKey = null;
    this._matSig = '';
    this._raster = null;
    this._copy = new FullScreenQuad(copyMaterial());
    this._src = null;
    // the scene the tracer reads: the source's meshes and lights, the sky environment, no background
    const walk = (roots: THREE.Object3D[], cb: (o: THREE.Object3D) => void, light: boolean) => {
      const src = this._src;
      if (!src) return;
      const visit = (o: THREE.Object3D) => {
        if (!o.visible || src.skip(o)) return;
        if (!light) { if (!src.drop(o)) cb(o); }
        else if ((o as Partial<THREE.Light>).isLight && (o as THREE.Light).intensity > 0) cb(o);
        for (const c of o.children) visit(c);
      };
      for (const r of roots) visit(r);
    };
    const proxy = {
      isScene: true,
      background: null,
      backgroundBlurriness: 0,
      backgroundIntensity: 1,
      backgroundRotation: new THREE.Euler(),
      environmentRotation: new THREE.Euler(),
      updateMatrixWorld: () => {}, // the view's frame did
      traverseVisible: (cb: (o: THREE.Object3D) => void) => { if (this._src) walk(this._src.meshes, cb, false); },
      traverse: (cb: (o: THREE.Object3D) => void) => { if (this._src) walk(this._src.lights, cb, true); },
    };
    Object.defineProperties(proxy, {
      environment: { get: () => (this._src ? this._src.environment : null) },
      environmentIntensity: { get: () => (this._src ? this._src.environmentIntensity : 0) },
    });
    this._proxy = proxy as unknown as THREE.Scene;
  }

  // Before a session: the geometry built when its key changed (else reused), the lights, the environment when it
  // was rebuilt and the materials when one changed. -> the geometry was built now.
  prepare(src: TraceSource, camera: THREE.Camera): boolean {
    this._src = src;
    // the sky cube is read back synchronously (CubeToEquirectGenerator): no pack buffer may be left bound (three
    // r169 leaves one bound after an async read-back, e.g. a light probe's)
    const gl = this.renderer.getContext();
    if (gl instanceof WebGL2RenderingContext) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return this._ownOpacity(() => {
      const t = this.tracer, inner = t as unknown as TracerInternals;
      if (src.geometryKey !== this._geometryKey) {
        t.setScene(this._proxy, camera);
        this._geometryKey = src.geometryKey;
        this._envKey = src.envKey;
        this._matSig = this._materialsSig();
        this.builds++;
        return true;
      }
      t.setCamera(camera);
      t.updateLights();
      if (src.envKey !== this._envKey) {
        inner._previousEnvironment = null; // the same cube texture with new contents
        this._envKey = src.envKey;
      }
      t.updateEnvironment(); // its intensity too (a uniform)
      const sig = this._materialsSig();
      if (sig !== this._matSig) { t.updateMaterials(); this._matSig = sig; }
      return false;
    });
  }

  // The materials read with their own opacity: the card's model_opacity ghosts the raster model (blended, depth
  // kept); traced, a 0.95 ghost would let one ray in twenty through every wall (noise, not a ghost). Restored
  // right after (plain property writes: no material version bump, no recompile).
  _ownOpacity<T>(fn: () => T): T {
    const saved: [THREE.Material, number, boolean][] = [];
    this._proxy.traverseVisible((o) => {
      if (!(o as Partial<THREE.Mesh>).isMesh) return;
      for (const m of ([] as THREE.Material[]).concat((o as THREE.Mesh).material)) {
        const ud = m.userData;
        if (ud.baseOpacity === undefined) continue;
        saved.push([m, m.opacity, m.transparent]);
        m.opacity = ud.baseOpacity;
        m.transparent = ud.wasTransparent ?? m.transparent;
      }
    });
    try {
      return fn();
    } finally {
      for (const [m, opacity, transparent] of saved) { m.opacity = opacity; m.transparent = transparent; }
    }
  }

  _materialsSig(): string {
    const mats = (this.tracer as unknown as TracerInternals)._materials || [];
    return mats.map(materialSig).join('|');
  }

  // The raster frame just drawn (the drawing buffer, before the browser shows it) kept as the image under the trace.
  keepRaster(): void {
    const r = this.renderer, size = r.getDrawingBufferSize(new THREE.Vector2());
    if (!this._raster || this._raster.image.width !== size.x || this._raster.image.height !== size.y) {
      if (this._raster) this._raster.dispose();
      this._raster = new THREE.FramebufferTexture(size.x, size.y);
    }
    r.setRenderTarget(null);
    r.copyFramebufferToTexture(this._raster);
  }

  // A new session from the camera (samples back to 0).
  begin(camera: THREE.Camera): void {
    this.tracer.setCamera(camera);
    this.tracer.reset();
  }

  /** samples per pixel so far (fractions while a sample's tiles are drawn) */
  get samples(): number {
    return this.tracer.samples;
  }

  get compiling(): boolean {
    return Boolean((this.tracer as unknown as { isCompiling: boolean }).isCompiling);
  }

  // One tile of the next sample.
  step(): void {
    const r = this.renderer, clip = r.clippingPlanes, auto = r.autoClear;
    r.clippingPlanes = [];
    try {
      this.tracer.renderSample();
    } finally {
      r.clippingPlanes = clip;
      r.autoClear = auto;
    }
  }

  // The raster frame, then the trace at opacity (tone mapped and upscaled) over it, into the drawing buffer.
  draw(opacity: number): void {
    const r = this.renderer, quad = (this.tracer as unknown as TracerInternals)._quad, auto = r.autoClear;
    r.setRenderTarget(null);
    r.autoClear = false;
    try {
      if (this._raster) {
        (this._copy.material as THREE.ShaderMaterial).uniforms.map.value = this._raster;
        this._copy.render(r);
      }
      if (opacity > 0) {
        const m = quad.material as THREE.ShaderMaterial & { map: THREE.Texture | null; opacity: number };
        m.map = this.tracer.target.texture;
        m.opacity = opacity;
        m.blending = THREE.NormalBlending;
        quad.render(r);
      }
    } finally {
      r.autoClear = auto;
    }
  }

  dispose(): void {
    const inner = this.tracer as unknown as TracerInternals;
    // WebGLPathTracer.dispose (0.0.23) frees a quad it does not have: free its parts here
    for (const p of [inner._pathTracer, inner._lowResPathTracer]) {
      // the BVH, attribute, material, texture array, light and environment uniforms are GPU textures
      for (const u of Object.values(p.material.uniforms)) {
        const v = u.value as { dispose?: () => void } | null;
        if (v && typeof v.dispose === 'function') v.dispose();
      }
      p.material.dispose();
      p.dispose();
    }
    inner._quad.dispose();
    inner._quad.material.dispose();
    inner._generator.geometry.dispose();
    this._copy.dispose();
    this._copy.material.dispose();
    if (this._raster) this._raster.dispose();
    this._raster = null;
    this._src = null;
  }
}
