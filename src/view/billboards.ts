// GPU sprites of the view: device markers, room labels, object labels and the mower chip, drawn as instanced
// billboards from one atlas texture after the frame (over bloom and the finish, like the DOM overlay they
// replace: not graded, not blurred, not tone mapped). Constant screen size, snapped to device pixels. The atlas
// is painted on the main thread with Canvas 2D (a cell per distinct picture: sprite-atlas.ts keys) and
// repainted when the theme changes.
//
// Hidden by the model: a sprite as a whole, decided on the GPU at its anchor. The vertex shader reads the
// scene's depth (the depth pre-pass of the opaque meshes, depth-pass.ts: no glass, no helpers) at the anchor
// and compares the anchor pulled OCCLUSION_MARGIN towards the camera: a marker on a wall is never cut by the
// wall it hangs on, a marker behind one is drawn at its hidden opacity, every part of it alike (a value is
// never cut in half by a wall edge). Labels and the chip are never hidden (hiddenAlpha = alpha).
//
// Picking is on the CPU in screen space (sprite-atlas.ts pickAt): the same anchor projection and cell layout
// as the vertex shader.
import * as THREE from "three";
import {
  cellKey,
  cellUv,
  drawOrder,
  growAtlas,
  ShelfPacker,
  type PickItem,
  type SpriteEnv,
  type SpriteLayout,
  type SpriteSpec,
} from "../sprite-atlas.ts";
import { OCCLUSION_MARGIN } from "../render-rules.ts";
import type { IconResolver } from "./icons.ts";

/** A sprite in the scene graph: placed and shown like any object (its parents' visibility counts). */
export class Billboard extends THREE.Object3D {
  readonly isBillboard = true;
  spec: SpriteSpec | null = null;
  /** opacity where nothing hides it */
  alpha = 1;
  /** opacity where the scene is in front of it (= alpha: never hidden) */
  hiddenAlpha = 1;
  /** about the anchor (hover) */
  spriteScale = 1;
  /** id for picking (null: not tappable) */
  pickId: string | null = null;

  constructor() {
    super();
    this.userData.helper = true;
  }

  override raycast(): void {} // never hit by the scene's rays
}

export const isBillboard = (
  o: THREE.Object3D | null | undefined,
): o is Billboard => !!o && (o as Partial<Billboard>).isBillboard === true;

const ATLAS_START = 1024;
const ATLAS_MAX = 4096;
const MAX_DPR = 2;

interface Cell {
  key: string;
  layout: SpriteLayout;
  uv: [number, number, number, number];
}

interface ImageEntry {
  img: HTMLImageElement;
  state: "loading" | "ok" | "failed";
  version: number;
}

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iUv;
attribute vec4 iRect; // cell top-left relative to the anchor, cell size (CSS px)
attribute vec3 iLook; // alpha, hidden alpha, scale
uniform vec2 uView; // drawing buffer px
uniform float uPr; // drawing buffer px per CSS px
uniform float uPull; // metres towards the camera
uniform float uOcc; // 1: the model hides sprites (uDepth holds the scene's depth)
uniform sampler2D uDepth;
varying vec2 vUv;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  if (projectionMatrix[2][3] == 0.0) mv.z += uPull; // orthographic
  else { float d = length(mv.xyz); mv.xyz *= max(d - uPull, 0.01) / max(d, 1e-6); }
  vec4 clip = projectionMatrix * mv;
  vec3 ndc = clip.xyz / clip.w;
  vec2 at = ndc.xy * 0.5 + 0.5;
  bool hidden = false;
  if (uOcc > 0.5 && iLook.y != iLook.x && all(greaterThanEqual(at, vec2(0.0))) && all(lessThanEqual(at, vec2(1.0))))
    hidden = texture(uDepth, at).r < ndc.z * 0.5 + 0.5;
  vec2 anchor = at * uView;
  float s = iLook.z * uPr;
  vec2 tl = floor(anchor + vec2(iRect.x, -iRect.y) * s + 0.5);
  vec2 px = tl + vec2(position.x * iRect.z, -position.y * iRect.w) * s;
  clip.xy = (px / uView * 2.0 - 1.0) * clip.w;
  gl_Position = clip;
  vUv = vec2(mix(iUv.x, iUv.z, position.x), mix(iUv.y, iUv.w, position.y));
  vA = hidden ? iLook.y : iLook.x;
}`;
const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying float vA;
void main() {
  vec4 c = texture2D(uMap, vUv) * vA; // premultiplied
  if (c.a < 0.002) discard;
  gl_FragColor = c;
}`;

const SENTINEL = "rgb(1, 2, 3)";

/** Colours of the card's CSS (var() resolved against the card through a hidden probe), cached until the theme changes. */
export class ColorResolver {
  probe: HTMLElement;
  cache: Map<string, string>;

  constructor(container: HTMLElement) {
    const p = document.createElement("span");
    p.setAttribute("aria-hidden", "true");
    Object.assign(p.style, { display: "none" });
    container.append(p);
    this.probe = p;
    this.cache = new Map();
  }

  resolve(css: string | null | undefined, fallback: string): string {
    if (!css) return fallback;
    const k = css + "\u0001" + fallback;
    let v = this.cache.get(k);
    if (v === undefined) {
      // a var() the theme does not set: the sentinel comes back, ours is used
      const m = /^var\((--[\w-]+)\)$/.exec(css.trim());
      this.probe.style.color = "";
      this.probe.style.color = m ? `var(${m[1]}, ${SENTINEL})` : css;
      const set = this.probe.style.color;
      v = set ? getComputedStyle(this.probe).color || fallback : fallback;
      if (v === SENTINEL) v = fallback;
      this.cache.set(k, v);
    }
    return v;
  }

  clear(): void {
    this.cache.clear();
  }

  dispose(): void {
    this.probe.remove();
  }
}

export class BillboardLayer {
  container: HTMLElement;
  icons: IconResolver;
  colors: ColorResolver;
  items: Set<Billboard>;
  scene: THREE.Scene;
  geometry: THREE.InstancedBufferGeometry;
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  texture: THREE.CanvasTexture;
  packer: ShelfPacker;
  cells: Map<string, Cell>;
  images: Map<string, ImageEntry>;
  dpr: number;
  font: string | null;
  capacity: number;
  /** image load failures (integration logo fallbacks) */
  onImageError: ((url: string) => void) | null;
  /** a resource changed (icon resolved, image loaded): the view draws again */
  onChange: (() => void) | null;
  stats: {
    cells: number;
    paints: number;
    uploads: number;
    repacks: number;
    drawn: number;
  };
  _textureDirty: boolean;
  _env: SpriteEnv | null;
  _model: boolean;
  _compact: boolean;
  _v: THREE.Vector3;

  constructor(container: HTMLElement, icons: IconResolver) {
    this.container = container;
    this.icons = icons;
    this.colors = new ColorResolver(container);
    this.items = new Set();
    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = false;
    this.capacity = 0;
    this.geometry = this._geometry(64);
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = ATLAS_START;
    this.ctx = this.canvas.getContext("2d");
    this.texture = this._texture();
    this.packer = new ShelfPacker(ATLAS_START, ATLAS_START);
    this.cells = new Map();
    this.images = new Map();
    this.dpr = 1;
    this.font = null;
    this.onImageError = null;
    this.onChange = null;
    this.stats = { cells: 0, paints: 0, uploads: 0, repacks: 0, drawn: 0 };
    this._textureDirty = false;
    this._env = null;
    this._model = false;
    this._compact = false;
    this._v = new THREE.Vector3();
    this.mesh = new THREE.Mesh(
      this.geometry,
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uMap: { value: this.texture },
          uView: { value: new THREE.Vector2(1, 1) },
          uPr: { value: 1 },
          uPull: { value: OCCLUSION_MARGIN },
          uOcc: { value: 0 },
          uDepth: { value: null },
        },
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: false,
        depthTest: false, // over everything; what the model hides is decided at the anchor
        side: THREE.DoubleSide,
      }),
    );
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  _geometry(capacity: number): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3),
    );
    g.setIndex([0, 2, 1, 2, 3, 1]);
    const attr = (n: number) =>
      new THREE.InstancedBufferAttribute(
        new Float32Array(capacity * n),
        n,
      ).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("iPos", attr(3));
    g.setAttribute("iUv", attr(4));
    g.setAttribute("iRect", attr(4));
    g.setAttribute("iLook", attr(3));
    g.instanceCount = 0;
    this.capacity = capacity;
    return g;
  }

  _texture(): THREE.CanvasTexture {
    const t = new THREE.CanvasTexture(this.canvas);
    t.flipY = false; // v down, as the canvas
    t.premultiplyAlpha = true;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.colorSpace = THREE.NoColorSpace; // the canvas's sRGB values go to the screen as they are
    return t;
  }

  add(b: Billboard): Billboard {
    this.items.add(b);
    return b;
  }

  remove(b: Billboard): void {
    this.items.delete(b);
  }

  // ---------- resources ----------

  /** Version of a dependency ("icon:<ref>", "img:<url>"): a change makes a new cell. */
  version(dep: string): number {
    if (dep.startsWith("icon:")) return this.icons.version(dep.slice(5));
    if (dep.startsWith("img:")) {
      const e = this._image(dep.slice(4));
      return e.version;
    }
    return 0;
  }

  _image(url: string): ImageEntry {
    let e = this.images.get(url);
    if (!e) {
      const img = new Image();
      const entry: ImageEntry = { img, state: "loading", version: 0 };
      e = entry;
      // the atlas canvas must stay readable for WebGL: no cross-origin image without CORS
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.onload = () => {
        entry.state = "ok";
        entry.version++;
        if (this.onChange) this.onChange();
      };
      img.onerror = () => {
        entry.state = "failed";
        entry.version++;
        if (this.onImageError) this.onImageError(url);
        if (this.onChange) this.onChange();
      };
      img.src = url;
      this.images.set(url, entry);
    }
    return e;
  }

  /** Drops the images not in keep (pictures and logos no marker shows any more). */
  keepImages(keep: Set<string>): void {
    for (const [url, e] of this.images) {
      if (keep.has(url)) continue;
      e.img.onload = e.img.onerror = null;
      this.images.delete(url);
    }
  }

  /** A loaded image, null while loading or failed. */
  image(url: string): HTMLImageElement | null {
    const e = this._image(url);
    return e.state === "ok" ? e.img : null;
  }

  /** The theme or the card's CSS changed: every cell is painted again. */
  invalidate(): void {
    this.colors.clear();
    this.font = null;
    this._clearAtlas();
  }

  _clearAtlas(): void {
    this.cells.clear();
    this.packer.reset(this.canvas.width, this.canvas.height);
    if (this.ctx)
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._textureDirty = true;
    this.stats.cells = 0;
  }

  env(): SpriteEnv {
    if (!this.font)
      this.font =
        getComputedStyle(this.container).fontFamily ||
        "Roboto, Noto, sans-serif";
    const ctx = this.ctx;
    const e: SpriteEnv = (this._env ||= {
      dpr: this.dpr,
      model: false,
      compact: false,
      font: this.font,
      color: (css, fb) => this.colors.resolve(css, fb),
      measure: (text, font) => {
        if (!ctx) return text.length * 6;
        ctx.font = font;
        return ctx.measureText(text).width;
      },
      icon: (ref) => this.icons.glyph(ref),
      image: (url) => this.image(url),
    });
    e.dpr = this.dpr;
    e.font = this.font;
    e.model = this._model;
    e.compact = this._compact;
    return e;
  }

  // ---------- the atlas ----------

  /** Size class of the markers (model shown, zoomed out): a change repaints the cells in use. */
  setSize(model: boolean, compact: boolean): void {
    this._model = model;
    this._compact = compact;
  }

  _cellKey(spec: SpriteSpec): string {
    return cellKey(spec, { model: this._model, compact: this._compact }, (d) =>
      this.version(d),
    );
  }

  // Cells for every key in need (painted when missing). A full atlas is cleared and repacked with what is in
  // use; when that does not fit either it grows.
  _ensure(needed: Map<string, SpriteSpec>): void {
    const dpr = Math.min(
      MAX_DPR,
      Math.max(1, globalThis.devicePixelRatio || 1),
    );
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this._clearAtlas();
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      let ok = true;
      for (const [key, spec] of needed) {
        if (this.cells.has(key)) continue;
        if (!this._paint(key, spec)) {
          ok = false;
          break;
        }
      }
      if (ok) return;
      this.stats.repacks++;
      if (attempt > 0) {
        const next = growAtlas(
          this.canvas.width,
          this.canvas.height,
          ATLAS_MAX,
        );
        if (next) this._resize(next[0], next[1]);
      }
      this._clearAtlas();
    }
  }

  _resize(w: number, h: number): void {
    this.canvas.width = w;
    this.canvas.height = h;
    this.texture.dispose();
    this.texture = this._texture();
    this.mesh.material.uniforms.uMap.value = this.texture;
  }

  _paint(key: string, spec: SpriteSpec): boolean {
    const env = this.env();
    const layout = spec.layout(env);
    const cell = this.packer.add(layout.w * this.dpr, layout.h * this.dpr);
    if (!cell) return false;
    const ctx = this.ctx;
    if (ctx) {
      ctx.save();
      ctx.clearRect(cell.x, cell.y, cell.w, cell.h);
      ctx.beginPath();
      ctx.rect(cell.x, cell.y, cell.w, cell.h);
      ctx.clip();
      ctx.translate(cell.x, cell.y);
      ctx.scale(this.dpr, this.dpr);
      try {
        spec.paint(ctx, env, layout);
      } finally {
        ctx.restore();
      }
    }
    // the quad is the cell's whole texel size (ceil'd): its CSS size follows from that
    this.cells.set(key, {
      key,
      layout: { ...layout, w: cell.w / this.dpr, h: cell.h / this.dpr },
      uv: cellUv(cell, this.canvas.width, this.canvas.height),
    });
    this.stats.paints++;
    this.stats.cells = this.cells.size;
    this._textureDirty = true;
    return true;
  }

  // ---------- per frame ----------

  _shown(b: Billboard, root: THREE.Object3D, camera: THREE.Camera): boolean {
    if (!b.spec || b.alpha <= 0 || !b.layers.test(camera.layers)) return false;
    let o: THREE.Object3D | null = b;
    for (; o; o = o.parent) {
      if (!o.visible) return false;
      if (o === root) return true;
    }
    return false; // not in the view's scene
  }

  // The sprites to draw this frame: shown, in front of the camera, with their view depth.
  _collect(
    root: THREE.Object3D,
    camera: THREE.Camera,
  ): { b: Billboard; z: number; p: THREE.Vector3 }[] {
    const out: { b: Billboard; z: number; p: THREE.Vector3 }[] = [];
    const vi = camera.matrixWorldInverse.elements;
    for (const b of this.items) {
      if (!this._shown(b, root, camera)) continue;
      const e = b.matrixWorld.elements;
      const x = e[12],
        y = e[13],
        z = e[14];
      const vz = vi[2] * x + vi[6] * y + vi[10] * z + vi[14];
      const p = new THREE.Vector3(x, y, z).project(camera);
      if (!(p.z >= -1 && p.z <= 1)) continue; // as CSS2D: nothing behind the camera / beyond the far plane
      out.push({ b, z: vz, p });
    }
    return out;
  }

  /** Draws the sprites over what is in the bound framebuffer. depth: the scene's depth for this camera (the
   * model hides sprites), null: nothing is hidden. */
  draw(
    renderer: THREE.WebGLRenderer,
    root: THREE.Object3D,
    camera: THREE.Camera,
    depth: THREE.Texture | null,
  ): number {
    const occlusion = !!depth;
    root.updateMatrixWorld();
    camera.updateMatrixWorld();
    const list = this._collect(root, camera);
    const needed = new Map<string, SpriteSpec>();
    const keys: string[] = [];
    for (const { b } of list) {
      const k = this._cellKey(b.spec!);
      keys.push(k);
      if (!needed.has(k)) needed.set(k, b.spec!);
    }
    this._ensure(needed);
    if (list.length > this.capacity) {
      this.geometry.dispose();
      this.geometry = this._geometry(Math.ceil(list.length * 1.5));
      this.mesh.geometry = this.geometry;
    }
    const g = this.geometry;
    const pos = g.getAttribute("iPos") as THREE.InstancedBufferAttribute,
      uv = g.getAttribute("iUv") as THREE.InstancedBufferAttribute,
      rect = g.getAttribute("iRect") as THREE.InstancedBufferAttribute,
      look = g.getAttribute("iLook") as THREE.InstancedBufferAttribute;
    const P = pos.array as Float32Array,
      U = uv.array as Float32Array,
      R = rect.array as Float32Array,
      L = look.array as Float32Array;
    const order = drawOrder(list.map((x) => -x.z)); // farthest (most negative view z) first
    let n = 0;
    for (const i of order) {
      const { b } = list[i];
      const cell = this.cells.get(keys[i]);
      if (!cell) continue; // did not fit the atlas at its largest
      const e = b.matrixWorld.elements;
      P.set([e[12], e[13], e[14]], n * 3);
      U.set(cell.uv, n * 4);
      R.set(
        [-cell.layout.ax, -cell.layout.ay, cell.layout.w, cell.layout.h],
        n * 4,
      );
      L.set([b.alpha, b.hiddenAlpha, b.spriteScale], n * 3);
      n++;
    }
    for (const a of [pos, uv, rect, look]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
    g.instanceCount = n;
    this.stats.drawn = n;
    if (!n) return 0;
    if (this._textureDirty) {
      this.texture.needsUpdate = true;
      this._textureDirty = false;
      this.stats.uploads++;
    }
    const u = this.mesh.material.uniforms;
    renderer.getDrawingBufferSize(u.uView.value);
    u.uPr.value = renderer.getPixelRatio();
    u.uOcc.value = occlusion ? 1 : 0;
    u.uDepth.value = depth;
    const auto = renderer.autoClear,
      reset = renderer.info.autoReset;
    renderer.autoClear = false;
    renderer.info.autoReset = false; // the frame's draw counts stay
    try {
      renderer.render(this.scene, camera);
    } finally {
      renderer.autoClear = auto;
      renderer.info.autoReset = reset;
    }
    return n;
  }

  /** Where a sprite is on screen (client px): anchor, scale and its cell layout; null when not drawn. */
  screenOf(
    b: Billboard,
    root: THREE.Object3D,
    camera: THREE.Camera,
    rect: DOMRect,
  ): PickItem | null {
    if (!this._shown(b, root, camera)) return null;
    b.updateWorldMatrix(true, false);
    const p = this._v.setFromMatrixPosition(b.matrixWorld);
    const vz = p.clone().applyMatrix4(camera.matrixWorldInverse).z;
    p.project(camera);
    if (!(p.z >= -1 && p.z <= 1)) return null;
    const layout = this._layoutOf(b.spec!);
    return {
      id: b.pickId || "",
      x: rect.left + ((p.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - p.y) / 2) * rect.height,
      depth: -vz,
      scale: b.spriteScale,
      hits: layout.hits,
    };
  }

  // the layout of a sprite (its cell's when painted, else computed)
  _layoutOf(spec: SpriteSpec): SpriteLayout {
    const c = this.cells.get(this._cellKey(spec));
    return c ? c.layout : spec.layout(this.env());
  }

  /** Every tappable sprite on screen (for pickAt). */
  pickItems(
    root: THREE.Object3D,
    camera: THREE.Camera,
    rect: DOMRect,
  ): PickItem[] {
    root.updateMatrixWorld();
    camera.updateMatrixWorld();
    const out: PickItem[] = [];
    for (const b of this.items) {
      if (!b.pickId) continue;
      const s = this.screenOf(b, root, camera, rect);
      if (s && s.hits.length) out.push(s);
    }
    return out;
  }

  dispose(): void {
    this.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
    this.colors.dispose();
    this.items.clear();
    this.cells.clear();
    for (const e of this.images.values()) {
      e.img.onload = e.img.onerror = null;
    }
    this.images.clear();
  }
}
