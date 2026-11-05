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
//     emissive, transmission, sheen, opacity). Clear coat is read as 0: the tracer's clear-coat layer leaves a
//     regular grid of black pixels on the clear-coated floors (NaN samples) that never converges; the floors keep
//     their own roughness and reflect the room as a plain glossy surface.
//   - the image: accumulated at STILL_SCALE, then denoised once per sample by a geometry-guided edge-avoiding
//     a-trous filter (STILL_DENOISE.passes 5x5 passes at growing steps over a normal / depth guide drawn from the
//     model at the session's start, plus a loose luminance term so shadow edges stay): neighbours count only on the
//     same surface. Upscaled (bilinear), tone mapped and blended over the raster frame. (three-gpu-pathtracer's
//     DenoiseMaterial is colour-only: the noise of a sun sampled once in a dozen lights is stronger than any edge
//     it could keep, so it either blurs nothing or everything.)
// What it cannot express is left out: the hemisphere light (the sky environment lights instead), shader patches
// (cloud shadows, contact shadows, PCSS, city windows, sway, probes and baked lightmaps: the trace computes the
// indirect light itself), clipping (the view does not trace while a cut-away or section clips), and the post
// passes (ambient occlusion, bloom, bokeh / grade): they stay in the raster frame below while the trace fades in.
import * as THREE from "three";
import { WebGLPathTracer } from "three-gpu-pathtracer";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import {
  STILL_BOUNCES,
  STILL_DENOISE,
  STILL_SAMPLE_MAX,
  STILL_SCALE,
  STILL_TILES,
  STILL_TRANSMISSIVE_BOUNCES,
} from "./still.ts";

// three-gpu-pathtracer 0.0.28 still includes <cube_uv_reflection_fragment> in CubeToEquirectGenerator (used for
// a cube environment / background), a chunk three r187 removed with CubeUVReflectionMapping. That shader only
// samples the cube with textureCube, so an empty chunk is enough; the raster programs never include it.
if (!("cube_uv_reflection_fragment" in THREE.ShaderChunk))
  (THREE.ShaderChunk as Record<string, string>).cube_uv_reflection_fragment =
    "";

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
  /** draws the traced geometry alone with this material into the bound target (the denoise guide) */
  drawGuide: (material: THREE.Material) => void;
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
  const hex = (c: THREE.Color | undefined) => (c ? c.getHexString() : "-");
  return [
    m.uuid,
    m.version,
    hex(s.color),
    hex(s.emissive),
    s.emissiveIntensity ?? 0,
    m.opacity,
    s.roughness ?? "",
    s.metalness ?? "",
    s.transmission ?? "",
    m.visible ? 1 : 0,
  ].join(":");
}

// Copies a texture to the drawing buffer as it is (no tone mapping, no colour conversion): the raster frame.
function copyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: null } },
    vertexShader:
      "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }",
    fragmentShader:
      "uniform sampler2D map;\nvarying vec2 vUv;\nvoid main() { gl_FragColor = texture2D( map, vUv ); }",
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
  });
}

// A path's radiance capped at STILL_SAMPLE_MAX (and NaN dropped) before it is accumulated: the sun is sampled once in
// a dozen lights, so a rare path that finds it (or a lamp's bright bounce) would stay a white dot for hundreds of
// samples. Slightly biased (the brightest light paths are dimmed), never visible on the lamp glows (tone mapped white).
export function clampSamples(material: THREE.ShaderMaterial): void {
  const end = "gl_FragColor.a *= opacity;";
  if (material.fragmentShader.split(end).length !== 2)
    throw new Error("floorplan3d: unexpected path tracing shader");
  material.fragmentShader = material.fragmentShader.replace(
    end,
    `if ( any( isnan( gl_FragColor.rgb ) ) || any( isinf( gl_FragColor.rgb ) ) ) gl_FragColor.rgb = vec3( 0.0 );
    { float l = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ); if ( l > ${STILL_SAMPLE_MAX.toFixed(1)} ) gl_FragColor.rgb *= ${STILL_SAMPLE_MAX.toFixed(1)} / l; }
    ${end}`,
  );
  material.needsUpdate = true;
}

// three-gpu-pathtracer 0.0.25+ deprecates WebGLPathTracer for its WebGPU tracer (real WebGPU only, not the WebGL2
// fallback the card renders with), and it still starts a THREE.Clock (deprecated in three r183): both warn at
// construction. The warnings are dropped there and only there.
function quietly<T>(make: () => T): T {
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (!/deprecated|has been replaced/i.test(String(args[0])))
      warn.apply(console, args);
  };
  try {
    return make();
  } finally {
    console.warn = warn;
  }
}

// Lift (m) of a polygon-offset sheet above the surface it lies on, for the trace.
const SHEET_LIFT_M = 0.003;

const QUAD_VS =
  "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }";

// The denoise guide: view-space normal (facing the camera) and linear depth (0: nothing, the background).
function guideMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: `varying vec3 vN; varying float vZ;
      void main() { vec4 mv = modelViewMatrix * vec4( position, 1.0 ); vN = normalMatrix * normal; vZ = - mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec3 vN; varying float vZ;
      void main() { vec3 n = normalize( vN ); gl_FragColor = vec4( gl_FrontFacing ? n : - n, vZ ); }`,
    side: THREE.DoubleSide,
  });
}

// One a-trous pass (5x5 B3 spline kernel at `step` texels): neighbours weighted by normal, depth and luminance
// similarity; nothing crosses between the model and the background.
function atrousMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null },
      guide: { value: null },
      step: { value: 1 },
      sigmaZ: { value: STILL_DENOISE.depth },
      sigmaL: { value: STILL_DENOISE.luminance },
      normalPow: { value: STILL_DENOISE.normal },
    },
    vertexShader: QUAD_VS,
    fragmentShader: `uniform sampler2D map; uniform sampler2D guide; uniform float step; uniform float sigmaZ; uniform float sigmaL; uniform float normalPow;
      varying vec2 vUv;
      float lum( vec3 c ) { c = c / ( 1.0 + c ); return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
      void main() {
        ivec2 size = textureSize( map, 0 ), p = ivec2( vUv * vec2( size ) );
        vec4 c0 = texelFetch( map, p, 0 ), g0 = texelFetch( guide, p, 0 );
        if ( g0.a <= 0.0 ) { gl_FragColor = c0; return; }
        if ( step < 1.5 ) {
          // first pass: a firefly (brighter than every neighbour on its surface) is cut to their brightest
          vec3 hi = vec3( 0.0 ); bool any = false;
          for ( int y = -1; y <= 1; y ++ ) for ( int x = -1; x <= 1; x ++ ) {
            if ( x == 0 && y == 0 ) continue;
            ivec2 q = clamp( p + ivec2( x, y ), ivec2( 0 ), size - 1 );
            if ( texelFetch( guide, q, 0 ).a <= 0.0 ) continue;
            hi = max( hi, texelFetch( map, q, 0 ).rgb ); any = true;
          }
          if ( any ) c0.rgb = min( c0.rgb, hi );
        }
        float l0 = lum( c0.rgb );
        float k[ 3 ] = float[ 3 ]( 0.375, 0.25, 0.0625 );
        vec4 sum = vec4( 0.0 ); float wsum = 0.0;
        for ( int y = -2; y <= 2; y ++ ) for ( int x = -2; x <= 2; x ++ ) {
          ivec2 q = clamp( p + ivec2( x, y ) * int( step ), ivec2( 0 ), size - 1 );
          vec4 c = texelFetch( map, q, 0 ), g = texelFetch( guide, q, 0 );
          if ( g.a <= 0.0 ) continue;
          float w = k[ abs( x ) ] * k[ abs( y ) ];
          w *= pow( max( 0.0, dot( g0.xyz, g.xyz ) ), normalPow );
          w *= exp( - abs( g.a - g0.a ) / ( sigmaZ * g0.a * step + 1e-4 ) );
          w *= exp( - abs( lum( c.rgb ) - l0 ) / sigmaL );
          sum += c * w; wsum += w;
        }
        gl_FragColor = wsum > 0.0 ? sum / wsum : c0;
      }`,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
}

// The denoised trace over the raster frame: upscaled (bilinear), tone mapped, premultiplied by its alpha and the
// fade's opacity.
function compositeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, opacity: { value: 1 } },
    vertexShader: QUAD_VS,
    fragmentShader: `uniform sampler2D map; uniform float opacity; varying vec2 vUv;
      void main() {
        vec4 c = texture2D( map, vUv );
        gl_FragColor = vec4( max( c.rgb, vec3( 0.0 ) ), clamp( c.a, 0.0, 1.0 ) );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        gl_FragColor.rgb *= gl_FragColor.a;
        gl_FragColor *= opacity;
      }`,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
}

const halfTarget = (
  w: number,
  h: number,
  filter: THREE.MagnificationTextureFilter,
) =>
  new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    minFilter: filter,
    magFilter: filter,
    depthBuffer: filter === THREE.NearestFilter,
    generateMipmaps: false,
  });

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
  _guideMat: THREE.ShaderMaterial;
  _atrous: FullScreenQuad;
  _composite: FullScreenQuad;
  /** guide (normal, depth) and the denoise ping-pong targets, at the trace's size */
  _guide: THREE.WebGLRenderTarget | null;
  _ping: THREE.WebGLRenderTarget[];
  /** the target holding the denoised image, and the sample it was made at */
  _denoised: THREE.WebGLRenderTarget | null;
  _denoisedAt: number;
  _proxy: THREE.Scene;
  _src: TraceSource | null;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const t = quietly(() => new WebGLPathTracer(renderer));
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
    clampSamples((t as unknown as TracerInternals)._pathTracer.material);
    this.builds = 0;
    this._geometryKey = null;
    this._envKey = null;
    this._matSig = "";
    this._raster = null;
    this._copy = new FullScreenQuad(copyMaterial());
    this._guideMat = guideMaterial();
    this._atrous = new FullScreenQuad(atrousMaterial());
    this._composite = new FullScreenQuad(compositeMaterial());
    this._guide = null;
    this._ping = [];
    this._denoised = null;
    this._denoisedAt = -1;
    this._src = null;
    // the scene the tracer reads: the source's meshes and lights, the sky environment, no background
    const walk = (
      roots: THREE.Object3D[],
      cb: (o: THREE.Object3D) => void,
      light: boolean,
    ) => {
      const src = this._src;
      if (!src) return;
      const visit = (o: THREE.Object3D) => {
        if (!o.visible || src.skip(o)) return;
        if (!light) {
          if (!src.drop(o)) cb(o);
        } else if (
          (o as Partial<THREE.Light>).isLight &&
          (o as THREE.Light).intensity > 0
        )
          cb(o);
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
      traverseVisible: (cb: (o: THREE.Object3D) => void) => {
        if (this._src) walk(this._src.meshes, cb, false);
      },
      traverse: (cb: (o: THREE.Object3D) => void) => {
        if (this._src) walk(this._src.lights, cb, true);
      },
    };
    Object.defineProperties(proxy, {
      environment: { get: () => (this._src ? this._src.environment : null) },
      environmentIntensity: {
        get: () => (this._src ? this._src.environmentIntensity : 0),
      },
    });
    this._proxy = proxy as unknown as THREE.Scene;
  }

  // Before a session: the geometry built when its key changed (else reused), the lights, the environment when it
  // was rebuilt and the materials when one changed. -> the geometry was built now.
  prepare(src: TraceSource, camera: THREE.Camera): boolean {
    this._src = src;
    return this._ownOpacity(() => {
      const t = this.tracer,
        inner = t as unknown as TracerInternals;
      if (src.geometryKey !== this._geometryKey) {
        quietly(() => t.setScene(this._proxy, camera));
        this._geometryKey = src.geometryKey;
        this._envKey = src.envKey;
        this._matSig = this._materialsSig();
        this.builds++;
        return true;
      }
      t.setCamera(camera);
      quietly(() => t.updateLights());
      if (src.envKey !== this._envKey) {
        inner._previousEnvironment = null; // the same cube texture with new contents
        this._envKey = src.envKey;
      }
      quietly(() => t.updateEnvironment()); // its intensity too (a uniform)
      const sig = this._materialsSig();
      if (sig !== this._matSig) {
        quietly(() => t.updateMaterials());
        this._matSig = sig;
      }
      return false;
    });
  }

  // The materials as the trace reads them, restored right after (plain field writes: no material version bump, no
  // recompile of the raster frame's programs):
  //   - their own opacity: the card's model_opacity ghosts the raster model (blended, depth kept); traced, a 0.95
  //     ghost would let one ray in twenty through every wall (noise, not a ghost);
  //   - no clear coat (the tracer's clear-coat layer: black pixels, see above). _clearcoat is three's field behind
  //     the clearcoat setter, which bumps the version when it crosses 0.
  //   - sheets drawn with a polygon offset over a coplanar surface (a paved area on a lawn slab): the raster frame
  //     lets the offset win, the trace would pick either at random; they are lifted SHEET_LIFT_M for the trace.
  _ownOpacity<T>(fn: () => T): T {
    const saved: [THREE.Material, number, boolean, number | undefined][] = [];
    const lifted: [THREE.Object3D, THREE.Matrix4][] = [];
    const seen = new Set<THREE.Material>();
    this._proxy.traverseVisible((o) => {
      if (!(o as Partial<THREE.Mesh>).isMesh) return;
      const mats = ([] as THREE.Material[]).concat((o as THREE.Mesh).material);
      if (mats.some((m) => m && m.polygonOffset && m.polygonOffsetFactor < 0)) {
        lifted.push([o, o.matrixWorld.clone()]);
        o.matrixWorld.premultiply(
          new THREE.Matrix4().makeTranslation(0, SHEET_LIFT_M, 0),
        );
      }
      for (const m of mats) {
        if (!m || seen.has(m)) continue;
        seen.add(m);
        const ud = m.userData,
          cc = m as unknown as { _clearcoat?: number };
        const coat =
          typeof cc._clearcoat === "number" && cc._clearcoat > 0
            ? cc._clearcoat
            : undefined;
        if (ud.baseOpacity === undefined && coat === undefined) continue;
        saved.push([m, m.opacity, m.transparent, coat]);
        if (ud.baseOpacity !== undefined) {
          m.opacity = ud.baseOpacity;
          m.transparent = ud.wasTransparent ?? m.transparent;
        }
        if (coat !== undefined) cc._clearcoat = 0;
      }
    });
    try {
      return fn();
    } finally {
      for (const [o, mw] of lifted) o.matrixWorld.copy(mw);
      for (const [m, opacity, transparent, coat] of saved) {
        m.opacity = opacity;
        m.transparent = transparent;
        if (coat !== undefined)
          (m as unknown as { _clearcoat: number })._clearcoat = coat;
      }
    }
  }

  _materialsSig(): string {
    const mats = (this.tracer as unknown as TracerInternals)._materials || [];
    return mats.map(materialSig).join("|");
  }

  // The raster frame just drawn (the drawing buffer, before the browser shows it) kept as the image under the trace.
  keepRaster(): void {
    const r = this.renderer,
      size = r.getDrawingBufferSize(new THREE.Vector2());
    if (
      !this._raster ||
      this._raster.image.width !== size.x ||
      this._raster.image.height !== size.y
    ) {
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
    this._denoised = null;
    this._denoisedAt = -1;
    this._drawGuide();
  }

  // The denoise guide for this camera, at the trace's size (the drawing buffer times STILL_SCALE).
  _drawGuide(): void {
    const r = this.renderer,
      size = r.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, Math.floor(size.x * STILL_SCALE)),
      h = Math.max(1, Math.floor(size.y * STILL_SCALE));
    if (!this._guide || this._guide.width !== w || this._guide.height !== h) {
      for (const t of [this._guide, ...this._ping]) if (t) t.dispose();
      this._guide = halfTarget(w, h, THREE.NearestFilter);
      this._ping = [
        halfTarget(w, h, THREE.LinearFilter),
        halfTarget(w, h, THREE.LinearFilter),
      ];
    }
    const prev = r.getRenderTarget(),
      clear = r.getClearColor(new THREE.Color()),
      alpha = r.getClearAlpha(),
      auto = r.autoClear;
    r.setRenderTarget(this._guide);
    r.setClearColor(0x000000, 0);
    r.autoClear = true;
    try {
      r.clear();
      if (this._src) this._src.drawGuide(this._guideMat);
    } finally {
      r.setRenderTarget(prev);
      r.setClearColor(clear, alpha);
      r.autoClear = auto;
    }
  }

  // The accumulated trace denoised (once per whole sample) -> the target to show.
  _denoise(): THREE.WebGLRenderTarget | null {
    const n = Math.floor(this.tracer.samples);
    if (this._denoised && n === this._denoisedAt) return this._denoised;
    if (!this._guide) return null;
    const r = this.renderer,
      m = this._atrous.material as THREE.ShaderMaterial,
      prev = r.getRenderTarget();
    let src: THREE.Texture = this.tracer.target.texture,
      out: THREE.WebGLRenderTarget | null = null;
    m.uniforms.guide.value = this._guide.texture;
    for (let i = 0; i < STILL_DENOISE.passes; i++) {
      out = this._ping[i % 2];
      m.uniforms.map.value = src;
      m.uniforms.step.value = 1 << i;
      r.setRenderTarget(out);
      this._atrous.render(r);
      src = out.texture;
    }
    r.setRenderTarget(prev);
    this._denoised = out;
    this._denoisedAt = n;
    return out;
  }

  /** samples per pixel so far (fractions while a sample's tiles are drawn) */
  get samples(): number {
    return this.tracer.samples;
  }

  get compiling(): boolean {
    return Boolean(
      (this.tracer as unknown as { isCompiling: boolean }).isCompiling,
    );
  }

  // One tile of the next sample.
  step(): void {
    const r = this.renderer,
      clip = r.clippingPlanes,
      auto = r.autoClear;
    r.clippingPlanes = [];
    try {
      this.tracer.renderSample();
    } finally {
      r.clippingPlanes = clip;
      r.autoClear = auto;
    }
  }

  // The raster frame, then the denoised trace at opacity (tone mapped and upscaled) over it, into the drawing buffer.
  draw(opacity: number): void {
    const r = this.renderer,
      auto = r.autoClear;
    r.setRenderTarget(null);
    r.autoClear = false;
    try {
      if (this._raster) {
        (this._copy.material as THREE.ShaderMaterial).uniforms.map.value =
          this._raster;
        this._copy.render(r);
      }
      const img = opacity > 0 ? this._denoise() : null;
      if (img) {
        r.setRenderTarget(null);
        const m = this._composite.material as THREE.ShaderMaterial;
        m.uniforms.map.value = img.texture;
        m.uniforms.opacity.value = opacity;
        this._composite.render(r);
      }
    } finally {
      r.autoClear = auto;
    }
  }

  dispose(): void {
    const inner = this.tracer as unknown as TracerInternals;
    // not WebGLPathTracer.dispose: it leaves the low-res renderer, the uniforms' GPU textures and the merged geometry
    for (const p of [inner._pathTracer, inner._lowResPathTracer]) {
      // the BVH, attribute, material, texture array, light and environment uniforms are GPU textures
      for (const u of Object.values(p.material.uniforms)) {
        const v = u.value as { dispose?: () => void } | null;
        if (v && typeof v.dispose === "function") v.dispose();
      }
      p.material.dispose();
      p.dispose();
    }
    inner._quad.dispose();
    inner._quad.material.dispose();
    inner._generator.geometry.dispose();
    this._copy.dispose();
    this._copy.material.dispose();
    this._atrous.dispose();
    this._atrous.material.dispose();
    this._composite.dispose();
    this._composite.material.dispose();
    this._guideMat.dispose();
    for (const t of [this._guide, ...this._ping]) if (t) t.dispose();
    this._guide = this._denoised = null;
    this._ping = [];
    if (this._raster) this._raster.dispose();
    this._raster = null;
    this._src = null;
  }
}
