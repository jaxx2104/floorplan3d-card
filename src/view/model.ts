// Model layer of the floorplan view: the GLB underlay (load, merge, placement, ghosting), picking and
// surface queries against it, the drag preview on its surface, the pick highlight and model-space
// conversions. `view.model` itself stays on the view (every part reads it).

import * as THREE from 'three';
import { rememberColor } from '../furniture.ts';
import { collectScreens } from '../screens.ts';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries, deinterleaveAttribute } from 'three/addons/utils/BufferGeometryUtils.js';
import { measuredElevations } from '../bindings.ts';
import { buildManifest, threeAdapter } from '../manifest.ts';
import type { Manifest } from '../types/manifest.ts';
import { sectionLevels, unionBox, nodeIndex, parseSelector, matches, viewTree, escapeName, type NodeIndex, type Visibility } from '../views.ts';
import { mergeGroups, namedGroups, mergedName } from '../merge.ts';
import { mergeRender } from '../render-recipe.ts';
import { patchCloudShadow } from '../cloud-shadow.ts';
import { castsShadow, shadowInfo, isCoplanarOverlay, coplanarWinners, ghostMaterial, pickable } from '../render-rules.ts';
import { isMesh, meshMaterials, type BoxData, type Drawable, type ModelMaterial, type PlaneData, type TexKey } from './core.ts';
import type { FloorplanView } from '../view.ts';
import type { PlanPoint, Vec3 } from '../types/layout.ts';

/** The tag manifest of the loaded model (three.js nodes). */
export type ModelManifest = Manifest<THREE.Object3D>;
/** Node index of the loaded model (three.js nodes). */
export type ModelIndex = NodeIndex<THREE.Object3D>;
/** The loaded GLB underlay (view.model). */
export interface LoadedModel {
  id: string;
  root: THREE.Object3D;
  manifest: ModelManifest;
  tagged: boolean;
  north: number | null;
  opacity: number;
}
export interface ModelVisibility { index: ModelIndex; flags: Visibility; masks: Map<THREE.Object3D, number> }
/** Model bytes, or a function that resolves to them (the card's cache). */
type ModelBytes = ArrayBuffer | (() => ArrayBuffer | Promise<ArrayBuffer>);
type KeepSelectors = string[] | null | undefined;
/** setModel options: {url} or {id, data}, plus placement (plan metres, degrees CCW), opacity and merge rules. */
export interface ModelOptions {
  url?: string | null;
  id?: string | null;
  name?: string;
  data?: ModelBytes;
  dataFresh?: (() => ArrayBuffer | Promise<ArrayBuffer>) | null;
  position?: number[];
  rotation?: number;
  scale?: number;
  opacity?: number;
  merge?: boolean;
  reload?: boolean;
  keep?: KeepSelectors | Promise<KeepSelectors> | (() => KeepSelectors | Promise<KeepSelectors>);
  onMerged?: (() => void) | null;
}
export interface MeshStats { meshes: number; triangles: number; calls: number }
export interface MergeStats { enabled: boolean; before: MeshStats; after: MeshStats; groups: number; merged: number; keep: string[] }
interface SurfaceMesh { mesh: THREE.Mesh; box: THREE.Box3 }
/** One surfaceRays hit (arrays, card world). */
export interface SurfaceRayHit { point: number[]; normal: number[]; distance: number; dir: number[]; object: THREE.Object3D }
/** Drag preview on the model surface (setSurfacePreview). */
export interface SurfacePreview { point: Vec3 | THREE.Vector3; normal: Vec3 | THREE.Vector3; tri?: (Vec3 | THREE.Vector3)[] | null; label?: string | null }

const TEX_KEYS: readonly TexKey[] = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'bumpMap', 'alphaMap'];

// Plan rectangle of a world-space box (used for rooms tagged without an outline).
export function fallbackOutline(box: THREE.Box3): PlanPoint[] {
  return [[box.min.x, -box.max.z], [box.max.x, -box.max.z], [box.max.x, -box.min.z], [box.min.x, -box.min.z]];
}

// @types/three 0.169 declares deinterleaveAttribute(geometry): void; three's function takes an interleaved
// attribute and returns a new BufferAttribute.
const deinterleave = deinterleaveAttribute as unknown as (a: THREE.InterleavedBufferAttribute) => THREE.BufferAttribute;
const isInterleaved = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): a is THREE.InterleavedBufferAttribute =>
  (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute === true;

// fp.north (degrees) on the model root or its two top levels, else null
function northOf(root: THREE.Object3D): number | null {
  const q: [THREE.Object3D, number][] = [[root, 0]];
  while (q.length) {
    const [o, d] = q.shift()!;
    const n: unknown = o.userData && o.userData.fp && o.userData.fp.north;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
    if (d < 2) for (const c of o.children) q.push([c, d + 1]);
  }
  return null;
}

// A mesh geometry baked into its owner's space (own copy: geometries can be shared), float, not
// interleaved, cut to its drawRange.
function bakedGeometry(mesh: THREE.Mesh, toOwner: THREE.Matrix4): THREE.BufferGeometry {
  const src = mesh.geometry, g = new THREE.BufferGeometry();
  const idx = src.index;
  const total = idx ? idx.count : src.attributes.position.count;
  const start = Math.max(0, src.drawRange.start || 0), end = Math.min(total, start + src.drawRange.count);
  const ranged = start > 0 || end < total;
  for (const [k, a0] of Object.entries(src.attributes)) {
    let a = isInterleaved(a0) ? deinterleave(a0) : a0.clone();
    if (ranged && !idx) a = new THREE.BufferAttribute(a.array.slice(start * a.itemSize, end * a.itemSize), a.itemSize, a.normalized);
    g.setAttribute(k, a);
  }
  if (idx) g.setIndex(ranged ? new THREE.BufferAttribute(idx.array.slice(start, end), 1) : idx.clone());
  const m = new THREE.Matrix4().multiplyMatrices(toOwner, mesh.matrixWorld);
  g.applyMatrix4(m);
  if (m.determinant() < 0) { // mirrored part: three flips the face order at render time, a baked one has to be flipped here
    flipWinding(g);
    const t = g.attributes.tangent as THREE.BufferAttribute | undefined; // baked: never interleaved
    if (t && t.itemSize === 4) for (let i = 0; i < t.count; i++) t.setW(i, -t.getW(i)); // and its handedness
  }
  return g;
}

function flipWinding(g: THREE.BufferGeometry): void {
  if (g.index) {
    const a = g.index.array;
    for (let i = 0; i + 2 < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    return;
  }
  for (const a of Object.values(g.attributes)) {
    const n = a.itemSize, arr = (a as THREE.BufferAttribute).array; // baked: never interleaved
    for (let v = 0; v + 2 < a.count; v += 3) {
      for (let c = 0; c < n; c++) { const i = (v + 1) * n + c, j = (v + 2) * n + c, t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    }
  }
}

// Merges static model meshes (see merge.js: per owner, material, attribute set, shadow flags), in place.
// selectors: view rule selectors (layout / YAML / model views) whose node: matches must stay their own nodes.
// unitScale: model units -> metres (the model scale), for the 30 m / 10 m cell limits.
// Every node keeps its original path segment (userData.fpSeg / fpDup), so node: paths do not shift when
// siblings are merged away. Returns { groups, merged (source meshes), failed }.
export function mergeStaticMeshes(root: THREE.Object3D, manifest: ModelManifest, selectors: string[] = [], { unitScale = 1 }: { unitScale?: number } = {}):
  { groups: number; merged: number; failed: number } {
  root.updateMatrixWorld(true);
  const index = nodeIndex(threeAdapter(root), manifest);
  const pathOf = new Map<THREE.Object3D, string>();
  for (const n of index.nodes) {
    pathOf.set(n.node, n.path);
    n.node.userData.fpSeg = n.seg;
    if (n.dup !== null && n.dup !== undefined) n.node.userData.fpDup = n.dup;
  }
  const keep = new Set<THREE.Object3D>();
  for (const s of selectors) {
    const sel = parseSelector(s);
    if (sel && sel.kind === 'node') for (const n of index.nodes) if (matches(sel, n)) keep.add(n.node);
  }
  // groups the Views tab lists and named groups (furniture) keep their own parts
  const listed = new Set(viewTree(index).groups.flatMap((r) => r.nodes.map((i: number) => index.nodes[i].node)));
  const named = namedGroups(root);
  const roomLevels = new Set(manifest.rooms.map((r) => r.level));
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if (isMesh(o)) meshes.push(o); });
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const box = new THREE.Box3(), rel = new THREE.Matrix4(), c = new THREE.Vector3(), sz = new THREE.Vector3();
  const groups = mergeGroups(meshes, {
    root, keep,
    kindOf: (n: THREE.Object3D) => { const e = manifest.byNode.get(n); return e ? (e.kind === 'object' ? 'object' : 'tag') : null; },
    isOwner: (n: THREE.Object3D) => listed.has(n) || named.has(n) || !!(n.userData && n.userData.fp && n.userData.fp.layer),
    boxOf: (m: THREE.Mesh) => {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      box.copy(m.geometry.boundingBox!).applyMatrix4(rel.multiplyMatrices(rootInv, m.matrixWorld));
      box.getCenter(c);
      box.getSize(sz);
      return { cx: c.x * unitScale, cz: c.z * unitScale, size: Math.max(sz.x, sz.y, sz.z) * unitScale };
    },
    // untagged owners (the root, layer / named groups, a level without rooms) merge per 10 m cell
    spatial: (o: THREE.Object3D) => {
      const e = manifest.byNode.get(o);
      return o === root || !e || (e.kind === 'level' && !roomLevels.has(e.id));
    },
  });
  const sources = new Set<THREE.BufferGeometry>();
  let merged = 0, failed = 0;
  const inv = new THREE.Matrix4();
  for (const grp of groups) {
    inv.copy(grp.owner.matrixWorld).invert();
    const geos = grp.meshes.map((m: THREE.Mesh) => bakedGeometry(m, inv));
    const geometry = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!geometry) { failed++; continue; }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const first: THREE.Mesh = grp.meshes[0];
    const out = new THREE.Mesh(geometry, first.material);
    let name = mergedName((first.material as THREE.Material).name, grp.meshes.map((m: THREE.Mesh) => pathOf.get(m) || m.name)); // merge groups share one material
    for (let k = 2; grp.owner.children.some((x: THREE.Object3D) => x.name === name); k++) name = name.replace(/(_\d+)?$/, '') + '_' + k; // hash clash among siblings
    out.name = name;
    out.castShadow = first.castShadow;
    out.receiveShadow = first.receiveShadow;
    out.renderOrder = first.renderOrder;
    out.layers.mask = first.layers.mask;
    out.userData = { name, fpSeg: escapeName(name), merged: grp.meshes.length, seeThrough: false, ...(grp.layers.length ? { fp: { layer: [...grp.layers] } } : {}) };
    grp.owner.add(out);
    out.updateMatrixWorld(true);
    for (const m of grp.meshes) { sources.add(m.geometry); m.removeFromParent(); }
    merged += grp.meshes.length;
  }
  // source geometries still used by a mesh that stays (shared geometry) are kept
  const used = new Set<THREE.BufferGeometry>();
  root.traverse((o) => { const g = (o as Drawable).geometry; if (g) used.add(g); });
  for (const g of sources) if (!used.has(g)) g.dispose();
  return { groups: groups.length - failed, merged, failed };
}

const vecArr = (v: Vec3 | THREE.Vector3): Vec3 => (Array.isArray(v) ? v : [v.x, v.y, v.z]);
const firstMaterial = (o: THREE.Object3D): ModelMaterial | undefined => {
  const m = (o as Drawable).material;
  return (Array.isArray(m) ? m[0] : m) as ModelMaterial | undefined;
};

// World corners of the face a raycast hit ([[x, y, z] x 3]) or null.
function faceTriangle(hit: THREE.Intersection<THREE.Mesh>): Vec3[] | null {
  const geo = hit.object.geometry;
  const pos = hit.face && geo && geo.attributes.position;
  if (!pos || !hit.face) return null;
  return [hit.face.a, hit.face.b, hit.face.c].map((i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(hit.object.matrixWorld).toArray());
}

export class ModelLayer {
  view: FloorplanView;
  _modelId: string | null;
  _modelLoading: Promise<string | null> | null;
  mergeStats: MergeStats | null;
  pickHelper: THREE.BoxHelper | null;
  _preview: THREE.Group | null;
  _previewRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> | null;
  _previewFace: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null;
  _previewLabel: CSS2DObject | null;
  _surfMeshes: SurfaceMesh[] | null;
  _surfRay: THREE.Raycaster;

  constructor(view: FloorplanView) {
    this.view = view;
    this._modelId = null; // id of the model shown or on its way
    this._modelLoading = null; // its load promise (resolves to null or an error message)
    this.mergeStats = null; // { enabled, before, after: { meshes, triangles, calls }, groups, merged } of the loaded model
    this.pickHelper = null; // BoxHelper around the highlighted model node
    this._preview = null; // drag preview (ring, tinted face, label), created on first use
    this._previewRing = null;
    this._previewFace = null;
    this._previewLabel = null;
    this._surfMeshes = null; // [{ mesh, box }] model meshes devices stick to (cached per placement)
    this._surfRay = new THREE.Raycaster();
  }

  // GLB underlay. opts: {url} or {id, data: ArrayBuffer | () => Promise<ArrayBuffer>}, plus
  // position: [x, y, z] plan metres, rotation: degrees CCW, scale, opacity.
  // Top-level nodes named "floor:<id>" are shown only with their floor; everything is cut at the
  // selected floor's cut-away height. Same url/id again only re-places the loaded model.
  // Resolves to null or an error message.
  _modelIdOf(opts: ModelOptions | null | undefined): string | null | undefined {
    const base = opts && (opts.id || opts.url);
    return base && opts.merge === false ? base + '#nomerge' : base; // merge on / off is a reload
  }

  // The model of opts is already shown / on its way (setModel would not fetch it again).
  isModelLoaded(opts: ModelOptions): boolean {
    const id = this._modelIdOf(opts);
    return !!id && !opts.reload && !!this.view.model && this.view.model.id === id;
  }

  isModelLoading(opts: ModelOptions): boolean {
    const id = this._modelIdOf(opts);
    return !!id && !opts.reload && this._modelId === id && !(this.view.model && this.view.model.id === id);
  }

  setModel(opts: ModelOptions | null | undefined): Promise<string | null> {
    const id = this._modelIdOf(opts);
    if (!opts || !id) { // (no opts: no id)
      this._disposeModel();
      return Promise.resolve(null);
    }
    if (opts.reload && this.view.model && this.view.model.id === id) this._disposeModel(true); // load again (e.g. merge with new keep rules)
    const place = () => {
      const g = this.view.modelGroup;
      const [x, y, z] = opts.position || [0, 0, 0];
      g.position.set(Number(x) || 0, Number(z) || 0, -(Number(y) || 0));
      g.rotation.y = ((opts.rotation || 0) * Math.PI) / 180;
      g.scale.setScalar(opts.scale || 1);
      const opacity = opts.opacity ?? 1;
      if (this.view.model) {
        // ghosted: blended but depth writes kept, so overlapping parts do not vanish; glass untouched
        this.view.model.root.traverse((o) => {
          if (!isMesh(o)) return;
          for (const mat of meshMaterials(o)) {
            const g = ghostMaterial(mat.userData, opacity);
            if (!g) continue;
            if (mat.alphaHash !== g.alphaHash || mat.transparent !== g.transparent) mat.needsUpdate = true;
            Object.assign(mat, g);
          }
        });
        this.view.model.opacity = opacity;
        this.view.occlusion._occBoxes = null; this._surfMeshes = null; this.view.mower._ground.clear(); this.view.mower._mowerGround.clear(); // placement changed
        this.view.cam._bounds = this.view.cam._sceneBounds();
      }
      if (this.view.model) this.view.look._fitShadow();
      this.view.look._shadowDirty();
      this.view._applyFloorVisibility();
      this.view.occlusion._scheduleOcclusion(0);
      this.view._objectsInvalid();
      this.view.dirty = true;
    };
    if (this.view.model && this.view.model.id === id) {
      place();
      return Promise.resolve(null);
    }
    if (this._modelId === id) return this._modelLoading!; // already on its way (set with _modelId)
    this._disposeModel(true); // another model follows: keep the model look (no shader rebuild there and back)
    this._modelId = id;
    const label = opts.name || opts.url || 'model';
    this._modelLoading = new Promise((resolve) => {
      const fail = (err: unknown) => {
        console.warn('floorplan3d: could not load model', label, err);
        if (this._modelId === id) {
          this._modelId = null;
          if (!this.view.model && this.view.look._modelLook) this.view.look._applyLook(); // nothing follows: the no-model look
        }
        const msg = err && typeof err === 'object' && 'message' in err ? String(err.message || '') : '';
        resolve(`Could not load model ${label}${err && /timed out/.test(msg) ? ` (${msg})` : ''}`);
      };
      const onLoad = (gltf: GLTF) => {
        if (this._modelId !== id) return resolve(null);
        const root = gltf.scene;
        const manifest = buildManifest(threeAdapter(root));
        // legacy levels without order/elevation stack bottom-up by their lowest point
        for (const l of manifest.levels) {
          const lb = new THREE.Box3().setFromObject(l.node);
          l.minY = lb.isEmpty() ? 0 : lb.min.y; // set for every level
        }
        // rooms tagged without an outline: use their footprint (root is not placed yet, so world = model space)
        root.updateMatrixWorld(true);
        for (const r of manifest.rooms) {
          if (r.outline) continue;
          const box = new THREE.Box3().setFromObject(r.node);
          if (box.isEmpty()) continue;
          r.outline = fallbackOutline(box);
          r.outlineFallback = true;
        }
        // tagged models are never cut: no clipping plane (and no extra shader variant) at all
        const tagged = manifest.levels.some((l) => l.source === 'extras' || l.source === 'name');
        // heights a flat sheet can lie on: level floors, the terrain / floor layers, the model bottom
        const floorYs: number[] = [0];
        for (const l of manifest.levels) if (l.elevation !== null && Number.isFinite(l.elevation)) floorYs.push(l.elevation);
        for (const m of Object.values(measuredElevations(manifest.levels))) floorYs.push(m.elevation);
        const all = new THREE.Box3();
        root.traverse((o) => {
          if (!isMesh(o)) return;
          const b = new THREE.Box3().setFromObject(o);
          all.union(b);
          if (shadowInfo(o).layers.some((l) => /^(terrain|floor)$/i.test(l))) floorYs.push(b.max.y);
        });
        if (!all.isEmpty()) floorYs.push(all.min.y);
        this.view.look._useRecipe(manifest);
        const aniso = Math.min(this.view.look.render.anisotropy, this.view.renderer.capabilities.getMaxAnisotropy());
        root.traverse((o) => {
          if (!isMesh(o)) return;
          const mats = meshMaterials(o) as ModelMaterial[];
          for (const mat of mats) {
            if (!tagged) {
              mat.clippingPlanes = [this.view.modelClip];
              mat.clipShadows = true;
            }
            mat.userData.baseOpacity = mat.opacity;
            mat.userData.wasTransparent = mat.transparent;
            // glTF does not store anisotropic filtering: without it floor boards and tiles blur at grazing angles
            for (const key of TEX_KEYS) {
              const tex = mat[key];
              if (tex && tex.anisotropy !== aniso) { tex.anisotropy = aniso; tex.needsUpdate = true; }
            }
            mat.userData.baseDepthWrite = mat.depthWrite;
            patchCloudShadow(mat, this.view.skyLayer._cloudU); // cloud shadows: compiled in once, uniforms after
            rememberColor(mat); // option furniture: the modelled colour
          }
          const box = new THREE.Box3().setFromObject(o);
          const info = shadowInfo(o, { size: box.getSize(new THREE.Vector3()).toArray(), bottom: box.min.y, floors: floorYs });
          o.receiveShadow = true;
          o.castShadow = castsShadow(info);
          o.userData.seeThrough = !!info.transparent || info.opacity! < 0.6 || info.transmission! > 0; // shadowInfo sets both
          if (isCoplanarOverlay(info)) {
            for (const mat of mats) Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
          }
        });
        this.view._modelVisibility = null;
        this.view.model = { id, root, manifest, tagged, north: northOf(root), opacity: 1 };
        this._liftTextured(root);
        this.view.look.indirect.setModel(root, gltf.parser); // baked lightmaps (fp_lightmap): checked once, applied by the tier
        this.view.look._applyFurniture();
        this.view.look._screens = collectScreens(root); // fp_anim: monitors / pixel frames that play while their entity is on
        this.view.look._applyScreens();
        this.view.modelGroup.add(root);
        this.view.look._applyLook();
        this.mergeStats = null;
        const unitScale = opts.scale || 1;
        if (opts.merge === false) {
          const st = this._modelStats();
          this.mergeStats = { enabled: false, before: st, after: st, groups: 0, merged: 0, keep: [] };
        } else {
          // the keep selectors come from the layout: merge now when it is there, else once it has loaded
          const keep = typeof opts.keep === 'function' ? opts.keep() : opts.keep || [];
          if (keep && !Array.isArray(keep)) { // a promise of the selectors
            const model = this.view.model;
            keep.then((sels) => {
              if (this.view.model !== model) return;
              this._mergeModel(sels, unitScale);
              this._afterMerge();
              if (opts.onMerged) opts.onMerged();
            }, () => {});
          } else {
            this._mergeModel(keep, unitScale);
          }
        }
        place();
        resolve(null);
      };
      const loader = new GLTFLoader();
      if (opts.data === undefined && opts.url) loader.load(opts.url, onLoad, undefined, fail);
      else {
        // bytes from the card (its cache); external resources of a URL model resolve next to it
        const path = opts.url ? THREE.LoaderUtils.extractUrlBase(new URL(opts.url, location.href).href) : '';
        // bytes that fail to parse (a damaged cached copy): opts.dataFresh drops the cache and fetches once more
        const parse = (buf: ArrayBuffer, retried: boolean) => {
          const bad = (err: unknown) => {
            if (retried || !opts.dataFresh || this._modelId !== id) { fail(err); return; }
            const fresh = opts.dataFresh;
            Promise.resolve().then(() => fresh()).then((b) => parse(b, true), () => fail(err));
          };
          try { loader.parse(buf, path, onLoad, bad as (e: ErrorEvent) => void); } catch (e) { bad(e); } // junk bytes throw synchronously
        };
        Promise.resolve(typeof opts.data === 'function' ? opts.data() : opts.data)
          .then((buf) => parse(buf as ArrayBuffer, false)) // url models without bytes take the load() branch
          .catch(fail);
      }
    });
    return this._modelLoading;
  }

  // Merge the loaded model's static meshes (keep: view rule selectors; the model's own views are added).
  _mergeModel(keep: KeepSelectors, unitScale: number): void {
    const { root, manifest } = this.view.model!; // callers checked view.model
    this._restoreModelVisibility(); // hidden by a view: still merged (the card re-applies visibility after)
    const before = this._modelStats();
    const sels: string[] = [...(keep || []), ...manifest.views.flatMap((v: { show: string[]; hide: string[] }) => [...v.show, ...v.hide])];
    let res = null;
    try {
      res = mergeStaticMeshes(root, manifest, sels, { unitScale });
    } catch (err) {
      console.warn('floorplan3d: could not merge model meshes', err);
    }
    const after = res && res.merged ? this._modelStats() : before;
    this.mergeStats = { enabled: true, before, after, groups: res ? res.groups : 0, merged: res ? res.merged : 0, keep: sels };
  }

  // A textured flat sheet coplanar with an untextured one (paving under a plain zone floor) wins the
  // depth test: polygonOffset on its material (cloned when shared with other meshes), drawn after.
  _liftTextured(root: THREE.Object3D): void {
    root.updateMatrixWorld(true);
    const items: { id: number; min: number[]; max: number[]; textured: boolean }[] = [];
    const byId = new Map<number, THREE.Mesh<THREE.BufferGeometry, ModelMaterial>>(), users = new Map<THREE.Material, number>();
    root.traverse((o) => {
      if (!isMesh(o) || !o.material) return;
      for (const m of meshMaterials(o)) users.set(m, (users.get(m) || 0) + 1);
      if (Array.isArray(o.material) || o.userData.liftedCoplanar) return;
      const b = new THREE.Box3().setFromObject(o);
      if (b.isEmpty()) return;
      const single = o as THREE.Mesh<THREE.BufferGeometry, ModelMaterial>; // one material (arrays returned above)
      byId.set(o.id, single);
      items.push({ id: o.id, min: b.min.toArray(), max: b.max.toArray(), textured: !!single.material.map });
    });
    for (const id of coplanarWinners(items)) {
      const o = byId.get(id)!; // every item id is in byId
      let m = o.material;
      if (users.get(m)! > 1) { // counted above
        const planes = m.clippingPlanes; // Material.copy clones them: keep the live (cut-away) planes
        m = m.clone();
        if (planes) m.clippingPlanes = planes;
        o.material = m;
      }
      Object.assign(m, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      m.userData.baseDepthWrite = m.depthWrite;
      o.renderOrder = (o.renderOrder || 0) + 1;
      o.userData.liftedCoplanar = true;
    }
  }

  // Caches that hold model meshes, after a merge on a placed model.
  _afterMerge() {
    if (this.view.model) this._liftTextured(this.view.model.root);
    this.view.occlusion._occBoxes = null; this._surfMeshes = null; this.view.mower._ground.clear(); this.view.mower._mowerGround.clear();
    this.view._applyFloorVisibility(); // floor-only mode covers the merged meshes too
    this.view.cam._bounds = this.view.cam._sceneBounds();
    this.view.look._fitShadow();
    this.view.look._shadowDirty();
    this.view.occlusion._scheduleOcclusion(0);
    this.view._objectsInvalid();
    this.view.dirty = true;
  }

  // Model meshes, triangles and draw calls (one render of the model alone, nothing culled, shadow pass
  // included) for mergeStats. Other scene content is hidden meanwhile (lights stay: same shaders).
  _modelStats(): MeshStats {
    const root = this.view.model!.root, r = this.view.renderer; // callers checked view.model
    let meshes = 0, triangles = 0;
    const culled: THREE.Object3D[] = [];
    root.traverse((o) => {
      if (!isMesh(o)) return;
      meshes++;
      const g = o.geometry;
      if (g) triangles += Math.floor((g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0) / 3);
      if (o.frustumCulled) { o.frustumCulled = false; culled.push(o); }
    });
    // the object light pool stays (its group, not the rest of the objects): without its lights the model's
    // shaders would compile once more just for this render
    const pool = this.view.objectLayer && this.view.objectLayer.lights;
    const hidden = this.view.scene.children.filter((c) => c !== this.view.modelGroup && !(c as THREE.Light).isLight && c.visible && !(pool && c === pool.parent));
    if (pool && pool.parent && pool.parent.visible) hidden.push(...pool.parent.children.filter((c: THREE.Object3D) => c !== pool && c.visible));
    for (const c of hidden) c.visible = false;
    let calls = 0;
    try {
      if (r.shadowMap.enabled) r.shadowMap.needsUpdate = true;
      r.render(this.view.scene, this.view.camera);
      calls = r.info.render.calls;
    } finally {
      for (const c of hidden) c.visible = true;
      for (const o of culled) o.frustumCulled = true;
      this.view.dirty = true;
    }
    return { meshes, triangles, calls };
  }

  modelManifest(): ModelManifest | null {
    return this.view.model ? this.view.model.manifest : null;
  }

  // level id -> { show, floor } from the card's bindings
  setModelLevels(assign: FloorplanView['modelLevels']): void {
    this.view.modelLevels = assign || {};
    this.view._applyFloorVisibility();
    this.view.dirty = true;
  }

  // The tagged part under a screen point: nearest tagged ancestor of the first visible hit below
  // the cut; untagged meshes come back as { kind: 'untagged' } so the UI can say so.
  pickModel(clientX: number, clientY: number) {
    const hit = this._modelHit(clientX, clientY);
    if (!hit) return null;
    const model = this.view.model!; // _modelHit found one
    const fn = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
    const hitInfo = { point: hit.point.toArray(), object: hit.object, up: !fn || Math.abs(fn.y) >= Math.cos((25 * Math.PI) / 180) };
    const owner = model.manifest.ownerOf(hit.object);
    if (owner) return { ...owner, hit: hitInfo };
    const names: string[] = [];
    for (let p: THREE.Object3D | null = hit.object; p && p !== model.root; p = p.parent) names.unshift((p.userData && p.userData.name) || p.name || '?');
    return { kind: 'untagged' as const, node: hit.object, path: names.join('/'), hit: hitInfo };
  }

  // The model surface under a screen point (visible, opaque meshes below the cut, section respected):
  // { point, normal (unit, facing the camera), object, owner (manifest entry or null) } or null.
  surfaceAt(clientX: number, clientY: number) {
    const hit = this._modelHit(clientX, clientY);
    if (!hit) return null;
    const normal = hit.face
      ? hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize()
      : new THREE.Vector3(0, 1, 0);
    if (normal.dot(this.view.raycaster.ray.direction) > 0) normal.negate(); // double-sided / flipped faces: the side we look at
    return { point: hit.point.clone(), normal, object: hit.object, owner: this.view.model!.manifest.ownerOf(hit.object), tri: faceTriangle(hit) }; // _modelHit found one
  }

  // Rays from a card-world point [x, y, z] in each direction (unit [x, y, z]) up to maxDist against the
  // model's surfaces: every mesh regardless of the current view (placement must not jump when the view
  // changes) except helpers, model objects (lamps, the mower) and glass. Returns the first hit per
  // direction: [{ point, normal (unit, raw face side), distance, dir }] (arrays, card world).
  surfaceRays(worldPoint: Vec3, dirs: Vec3[], maxDist: number): SurfaceRayHit[] {
    if (!this.view.model) return [];
    const meshes = this._surfaceMeshes();
    const ray = this._surfRay, out: SurfaceRayHit[] = [];
    const o = new THREE.Vector3(...worldPoint), end = new THREE.Vector3(), seg = new THREE.Box3();
    const nm = new THREE.Matrix3();
    for (const d of dirs) {
      const dir = new THREE.Vector3(...d).normalize();
      ray.set(o, dir);
      ray.near = 0;
      ray.far = maxDist;
      end.copy(dir).multiplyScalar(maxDist).add(o);
      seg.makeEmpty().expandByPoint(o).expandByPoint(end);
      let best: THREE.Intersection | null = null;
      for (const { mesh, box } of meshes) {
        if (!box.intersectsBox(seg)) continue;
        const hit = ray.intersectObject(mesh, false)[0];
        if (hit && (!best || hit.distance < best.distance)) best = hit;
      }
      if (!best) continue;
      const n = best.face
        ? best.face.normal.clone().applyNormalMatrix(nm.getNormalMatrix(best.object.matrixWorld)).normalize()
        : dir.clone().negate();
      out.push({ point: best.point.toArray(), normal: n.toArray(), distance: best.distance, dir: dir.toArray(), object: best.object });
    }
    return out;
  }

  _surfaceMeshes(): SurfaceMesh[] {
    if (this._surfMeshes) return this._surfMeshes;
    const list: SurfaceMesh[] = [];
    this.view.modelGroup.updateMatrixWorld(true);
    const { root, manifest } = this.view.model!; // callers checked view.model
    root.traverse((o) => {
      if (!isMesh(o)) return;
      for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (p.userData && p.userData.helper) return;
      const m: Partial<ModelMaterial> = firstMaterial(o) || { userData: {} };
      const ud = m.userData || {};
      if (!pickable({ isMesh: true, helper: false, transparent: ud.wasTransparent ?? !!m.transparent, opacity: ud.baseOpacity ?? m.opacity ?? 1 })) return;
      if (o.userData.seeThrough) return;
      const owner = manifest.ownerOf(o);
      if (owner && owner.kind === 'object') return;
      const box = new THREE.Box3().setFromObject(o);
      if (!box.isEmpty()) list.push({ mesh: o, box });
    });
    this._surfMeshes = list;
    return list;
  }

  // Drag preview on the model surface: p = { point, normal, tri: [[x,y,z] x3] | null, label } (card world)
  // or null to hide. One ring, one tinted face and one label, created once and reused.
  setSurfacePreview(p: SurfacePreview | null | undefined): void {
    if (!p) {
      if (this._preview && this._preview.visible) { this._preview.visible = false; this._previewLabel!.element.hidden = true; this.view.dirty = true; }
      return;
    }
    if (!this._preview) this._buildPreview();
    // _buildPreview made all four
    const g = this._preview!, ring = this._previewRing!, color = this.view.theme.primary || 0x03a9f4;
    const pt = new THREE.Vector3(...vecArr(p.point)), n = new THREE.Vector3(...vecArr(p.normal)).normalize();
    ring.position.copy(pt).addScaledVector(n, 0.01);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    ring.material.color.set(color);
    const face = this._previewFace!;
    if (p.tri) {
      const pos = face.geometry.attributes.position as THREE.BufferAttribute; // made in _buildPreview
      p.tri.forEach((v, i) => pos.setXYZ(i, ...vecArr(v)));
      pos.needsUpdate = true;
      face.geometry.computeBoundingSphere();
      face.material.color.set(color);
      face.visible = true;
    } else face.visible = false;
    const label = this._previewLabel!;
    label.element.textContent = p.label || '';
    label.element.hidden = !p.label;
    label.visible = !!p.label;
    label.position.copy(pt).addScaledVector(n, 0.05);
    g.visible = true;
    this.view.dirty = true;
  }

  _buildPreview(): void {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.09, 0.12, 40),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95, toneMapped: false }));
    ring.renderOrder = 12;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const face = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.25, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false }));
    face.renderOrder = 11;
    const el = document.createElement('div');
    el.className = 'fp-attach-label';
    el.hidden = true;
    const label = new CSS2DObject(el);
    for (const o of [ring, face, label]) { o.userData.helper = true; o.raycast = () => {}; o.frustumCulled = false; }
    g.add(ring, face, label);
    g.userData.helper = true;
    g.visible = false;
    this._preview = g;
    this._previewRing = ring;
    this._previewFace = face;
    this._previewLabel = label;
    this.view.scene.add(g);
  }

  // First visible model intersection under a screen point (raycaster left set to that ray).
  _modelHit(clientX: number, clientY: number): THREE.Intersection<THREE.Mesh> | null {
    if (!this.view.model) return null;
    const r = this.view.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.view.raycaster.setFromCamera(ndc, this.view.camera);
    const shown = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false; return true; };
    const candidate = (o: THREE.Object3D) => {
      // the material as authored (glass), not as ghosted by the opacity slider
      const m: Partial<ModelMaterial> = firstMaterial(o) || { userData: {} };
      const ud = m.userData || {};
      return pickable({
        isMesh: isMesh(o), helper: !!o.userData.helper,
        transparent: ud.wasTransparent ?? !!m.transparent, opacity: ud.baseOpacity ?? m.opacity ?? 1,
      });
    };
    const hit = this.view.raycaster.intersectObject(this.view.model.root, true)
      .find((h): h is THREE.Intersection<THREE.Mesh> => isMesh(h.object) && candidate(h.object) && shown(h.object) && h.point.y <= this.view.modelClip.constant + 1e-6 && !this.view._cutAway(h.point));
    return hit || null;
  }

  highlightModelNode(node: THREE.Object3D | null | undefined): void {
    if (this.pickHelper) {
      this.view.scene.remove(this.pickHelper);
      this.pickHelper.geometry.dispose();
      (this.pickHelper.material as THREE.Material).dispose(); // BoxHelper makes one LineBasicMaterial
      this.pickHelper = null;
    }
    if (node) {
      this.pickHelper = new THREE.BoxHelper(node, this.view.theme.primary || 0x03a9f4);
      (this.pickHelper.material as THREE.Material).depthTest = false;
      this.pickHelper.renderOrder = 11;
      this.pickHelper.userData.helper = true;
      this.view.scene.add(this.pickHelper);
    }
    this.view.dirty = true;
  }

  // keepLook: a model is about to replace this one, so the renderer keeps the model look (tone mapping,
  // shadows) meanwhile; switching to the no-model look and back would rebuild every shader twice.
  _disposeModel(keepLook = false): void {
    this._modelId = null;
    this.view._modelVisibility = null;
    if (!this.view.model) {
      if (!keepLook && this.view.look._modelLook) this.view.look._applyLook();
      return;
    }
    this.highlightModelNode(null);
    if (this.view.objectLayer) this.view.objectLayer.setModel(null, { keepLights: keepLook }); // restores cloned materials before they are disposed
    this.view._clearGroup(this.view.modelGroup);
    this.view.model = null;
    this.mergeStats = null;
    this.view.occlusion._occBoxes = null; this._surfMeshes = null; this.view.mower._ground.clear(); this.view.mower._mowerGround.clear();
    this.view.occlusion._cancelOcclusion();
    this.view.occlusion._clearOcclusion();
    if (!keepLook) { this.view.look.renderFrom = null; this.view.look._setRender(mergeRender(null)); this.view.look._applyLook(); }
    this.view.dirty = true;
  }

  // True when the model's levels come from tags (extras / names), not the legacy heuristic.
  isTagged(): boolean {
    return !!this.view.model && this.view.model.tagged;
  }

  // flags[i] -> index.nodes[i].node.visible; null returns to the level rules.
  applyModelVisibility(index: ModelIndex | null | undefined, flags: Visibility | null | undefined): void {
    this._restoreModelVisibility();
    if (flags && index) {
      index.nodes.forEach((n: { node: THREE.Object3D }, i: number) => { n.node.visible = !!flags[i]; });
      // on only to keep a descendant (a kept lamp) visible: its own mesh neither renders, casts shadows nor
      // takes clicks (layers are per object, not inherited); restored with the visibility
      const masks = new Map<THREE.Object3D, number>(), selfHidden = flags.selfHidden;
      if (selfHidden) index.nodes.forEach((n: { node: THREE.Object3D }, i: number) => { if (selfHidden[i] && isMesh(n.node)) { masks.set(n.node, n.node.layers.mask); n.node.layers.mask = 0; } });
      this.view._modelVisibility = { index, flags, masks };
    } else {
      this.view._modelVisibility = null;
    }
    this.view._applyFloorVisibility();
    this.view.dirty = true;
  }

  // Set every node of the previously flagged index visible again.
  _restoreModelVisibility(): void {
    if (this.view._modelVisibility) {
      for (const n of this.view._modelVisibility.index.nodes) n.node.visible = true;
      for (const [node, mask] of this.view._modelVisibility.masks || []) node.layers.mask = mask;
    }
    this.view._modelVisibility = null;
  }

  // world-space bounding box of the placed model ({min, max} arrays) or null
  modelBox(): BoxData | null {
    if (!this.view.model) return null;
    this.view.modelGroup.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(this.view.model.root);
    return b.isEmpty() ? null : { min: b.min.toArray(), max: b.max.toArray() };
  }

  // box framing the section: union of the storey/basement levels (the house), else the whole model
  sectionBox(): BoxData | null {
    if (!this.view.model) return null;
    this.view.modelGroup.updateMatrixWorld(true);
    const boxes = sectionLevels(this.view.model.manifest.levels).map((l: { node: THREE.Object3D }) => {
      const b = new THREE.Box3().setFromObject(l.node);
      return b.isEmpty() ? null : { min: b.min.toArray(), max: b.max.toArray() };
    });
    return unionBox(boxes) || this.modelBox();
  }

  // a plane given in model space (glTF scene coordinates) -> card world
  modelPlaneToWorld(plane: PlaneData): PlaneData {
    if (!this.view.model) return plane;
    this.view.modelGroup.updateMatrixWorld(true);
    const p = new THREE.Plane(new THREE.Vector3(...plane.normal), plane.constant).applyMatrix4(this.view.model.root.matrixWorld);
    return { normal: p.normal.toArray(), constant: p.constant };
  }

  // a point in model world (glTF scene coordinates) -> card world, through the model's placement
  modelPointToWorld(p: readonly number[]): Vec3 {
    if (!this.view.model) return [p[0], p[1], p[2]];
    this.view.modelGroup.updateMatrixWorld(true);
    return new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(this.view.model.root.matrixWorld).toArray();
  }

  // World-space triangle vertices of a mesh (flat x,y,z list).
  meshTriangles(mesh: THREE.Mesh): number[] {
    const g = mesh.geometry;
    if (!g || !g.attributes.position) return [];
    mesh.updateWorldMatrix(true, false);
    const pos = g.attributes.position, idx = g.index, out: number[] = [], v = new THREE.Vector3();
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(mesh.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
    return out;
  }

  // Plan-space bounding rectangle of a mesh (fallback when its floor cannot be traced).
  meshPlanRect(mesh: THREE.Object3D): PlanPoint[] {
    const b = new THREE.Box3().setFromObject(mesh);
    const x0 = b.min.x, x1 = b.max.x, y0 = -b.max.z, y1 = -b.min.z;
    const r = (v: number) => Math.round(Math.round(v / 0.05) * 0.05 * 1000) / 1000; // 5 cm, rounded to mm
    return [[r(x0), r(y0)], [r(x1), r(y0)], [r(x1), r(y1)], [r(x0), r(y1)]];
  }

  // The drag preview (view.dispose).
  _disposePreview(): void {
    if (this._preview) { this.view._clearGroup(this._preview); this.view.scene.remove(this._preview); this._preview = null; }
  }
}
