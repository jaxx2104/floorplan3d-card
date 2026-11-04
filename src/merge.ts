// Which static model meshes can be merged into one draw call (pure: works on three.js-like nodes,
// so it is unit tested with plain objects). view.js does the geometry work.
import { GLASS_RE } from './render-rules.ts';

// The three.js-like shapes read here (plain objects in the tests, three.js nodes in the card).
interface MergeAttr {
  itemSize?: number;
  normalized?: boolean;
  count?: number;
  array?: ArrayLike<number>;
  data?: { array?: ArrayLike<number> };
}
export interface MergeGeometry {
  attributes?: Record<string, MergeAttr>;
  index?: unknown;
  morphAttributes?: Record<string, unknown>;
}
export interface MergeMaterial {
  uuid?: string;
  name?: string;
  transparent?: boolean;
  opacity?: number;
  transmission?: number;
  userData?: Record<string, unknown>;
}
export interface MergeNode {
  name?: string;
  userData?: Record<string, unknown> & { name?: string; fp?: { layer?: unknown }; seeThrough?: unknown; helper?: unknown };
  isMesh?: boolean;
  isSkinnedMesh?: boolean;
  isInstancedMesh?: boolean;
  isBatchedMesh?: boolean;
  material?: MergeMaterial | MergeMaterial[] | null;
  geometry?: MergeGeometry;
  morphTargetInfluences?: number[];
  children?: MergeNode[];
  visible?: boolean;
  parent?: MergeNode | null;
  castShadow?: boolean;
  receiveShadow?: boolean;
  renderOrder?: number;
  layers?: { mask: number };
}
export interface MergeOptions {
  root?: MergeNode | null;
  kindOf?: (n: MergeNode) => 'object' | 'tag' | string | null | undefined;
  isOwner?: (n: MergeNode) => boolean;
  keep?: Set<MergeNode>;
  maxVertices?: number;
  boxOf?: (m: MergeNode) => { cx: number; cz: number; size: number } | null;
  spatial?: (owner: MergeNode) => boolean;
}
export interface MergeGroup {
  owner: MergeNode;
  meshes: MergeNode[];
  vertices: number;
  layers: string[];
  key: string;
}

export const MAX_MERGE_VERTICES = 1000000;
export const MAX_MERGE_MESH_M = 30; // a mesh larger than this (terrain, plot-wide parts) stays as is
export const MERGE_CELL_M = 10; // spatial owners (untagged parts of the model) merge per 10 m cell
const FLOOR_RE = /_floor$/i; // room floor pieces (<roomId>_floor): Pick traces them one by one

const matsOf = (o: MergeNode): MergeMaterial[] => (Array.isArray(o.material) ? o.material : o.material ? [o.material] : []);
const nameOf = (n: MergeNode): string => (n.userData && n.userData.name) || n.name || '';
const arrOf = (a: MergeAttr) => a.array || (a.data && a.data.array);
const ownLayers = (n: MergeNode): string[] => {
  const l = n.userData && n.userData.fp && n.userData.fp.layer;
  return Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string') : typeof l === 'string' ? [l] : [];
};

// Attribute set of a geometry: names, item sizes, normalized, array type, index presence. null = no position.
export function geometrySignature(g: MergeGeometry | null | undefined): string | null {
  const attrs = (g && g.attributes) || {};
  if (!attrs.position) return null;
  const parts = Object.keys(attrs).sort().map((k) => {
    const a = attrs[k];
    const arr = arrOf(a);
    return `${k}:${a.itemSize}:${a.normalized ? 1 : 0}:${arr ? arr.constructor.name : '?'}`;
  });
  return parts.join(',') + (g!.index ? '|i' : '|-'); // attrs.position came from g
}

const seeThrough = (o: MergeNode): boolean => {
  if (o.userData && o.userData.seeThrough) return true;
  return matsOf(o).some((m) => {
    const ud = m.userData || {};
    return !!m.transparent || !!ud.wasTransparent || (m.opacity ?? 1) < 1 || ((ud.baseOpacity as number | undefined) ?? 1) < 1 || (m.transmission || 0) > 0
      || GLASS_RE.test(m.name || '');
  });
};

// Why a mesh can never be merged (null = it can).
type ResolvedOptions = MergeOptions & Required<Pick<MergeOptions, 'kindOf' | 'isOwner' | 'keep' | 'maxVertices'>>;

function excluded(o: MergeNode, opts: ResolvedOptions): string | null {
  if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || o.isBatchedMesh) return 'kind';
  if (Array.isArray(o.material) || !o.material) return 'materials';
  if ((o.morphTargetInfluences && o.morphTargetInfluences.length) || (o.geometry && o.geometry.morphAttributes && Object.keys(o.geometry.morphAttributes).length)) return 'morph';
  if (o.children && o.children.length) return 'children';
  if (o.visible === false || (o.userData && o.userData.helper)) return 'hidden';
  if (opts.kindOf(o) || opts.keep.has(o)) return 'referenced';
  const name = nameOf(o);
  if (FLOOR_RE.test(name) || FLOOR_RE.test(o.name || '')) return 'floor';
  if (GLASS_RE.test(name) || seeThrough(o)) return 'transparent';
  if (!geometrySignature(o.geometry)) return 'geometry';
  // baking the transform needs float positions / normals / tangents (quantized ones would clamp)
  const a = o.geometry!.attributes!; // geometrySignature passed: both exist
  if (['position', 'normal', 'tangent'].some((k) => a[k] && !(arrOf(a[k]) instanceof Float32Array))) return 'quantized';
  return null;
}

// meshes: candidate mesh nodes (traversal order). opts: { root, kindOf(node) -> 'object' | 'tag' | null,
// isOwner(node) -> bool (layer groups, named groups, groups listed in the Views tree), keep: Set of nodes
// referenced by node: selectors (a mesh is left alone, a group owns its meshes), maxVertices,
// boxOf(mesh) -> { cx, cz, size } in metres (size = largest box side; over MAX_MERGE_MESH_M: not merged),
// spatial(owner) -> bool (untagged owners: one group per MERGE_CELL_M cell of the box centre) }.
// Owner = the nearest ancestor that is tagged, an owner or kept; else root. Anything below an object is
// left alone. Returns [{ owner, meshes, vertices, layers, key }], only groups of two or more meshes.
export function mergeGroups(meshes: MergeNode[], opts: MergeOptions): MergeGroup[] {
  const o: ResolvedOptions = { kindOf: () => null, isOwner: () => false, keep: new Set(), maxVertices: MAX_MERGE_VERTICES, ...opts };
  const ownerIds = new Map<MergeNode, number>();
  const buckets = new Map<string, { owner: MergeNode; layers: string[]; key: string; meshes: MergeNode[] }>();
  for (const m of meshes) {
    if (excluded(m, o)) continue;
    const box = o.boxOf ? o.boxOf(m) : null;
    if (box && !(box.size <= MAX_MERGE_MESH_M)) continue;
    let owner: MergeNode | null | undefined = null, inObject = false;
    for (let p = m.parent; p && p !== o.root; p = p.parent) {
      const k = o.kindOf(p);
      if (k === 'object') { inObject = true; break; }
      if (!owner && (k || o.isOwner(p) || o.keep.has(p))) owner = p;
    }
    if (inObject) continue;
    owner = (owner || o.root)!; // the caller passes a root
    if (!ownerIds.has(owner)) ownerIds.set(owner, ownerIds.size);
    const layers = [...new Set(ownLayers(m))].sort();
    const cell = box && o.spatial && o.spatial(owner) ? `${Math.floor(box.cx / MERGE_CELL_M)},${Math.floor(box.cz / MERGE_CELL_M)}` : '';
    const mat = m.material as MergeMaterial; // excluded() rejects none / arrays
    const key = [ownerIds.get(owner), mat.uuid, geometrySignature(m.geometry), m.castShadow ? 1 : 0, m.receiveShadow ? 1 : 0,
      m.renderOrder || 0, m.layers ? m.layers.mask : 1, layers.join('\u0001'), cell].join('|');
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { owner, layers, key, meshes: [] }));
    b.meshes.push(m);
  }
  const out: MergeGroup[] = [];
  for (const b of buckets.values()) {
    let chunk: MergeGroup | null = null;
    const flush = () => { if (chunk && chunk.meshes.length >= 2) out.push(chunk); chunk = null; };
    for (const m of b.meshes) {
      const n = m.geometry!.attributes!.position.count!; // checked by geometrySignature
      if (n > o.maxVertices) continue;
      if (chunk && chunk.vertices + n > o.maxVertices) flush();
      if (!chunk) chunk = { owner: b.owner, layers: b.layers, key: b.key, meshes: [], vertices: 0 };
      chunk.meshes.push(m);
      chunk.vertices += n;
    }
    flush();
  }
  return out;
}

// Named groups (not "?") with two or more meshes below them: they own their meshes, so a named piece of
// furniture keeps a node of its own that view rules can hide. The root itself is not included.
export function namedGroups(root: MergeNode): Set<MergeNode> {
  const out = new Set<MergeNode>();
  const walk = (n: MergeNode): number => {
    let count = n.isMesh ? 1 : 0;
    for (const c of n.children || []) count += walk(c);
    const name = nameOf(n);
    if (n !== root && !n.isMesh && name && name !== '?' && count >= 2) out.add(n);
    return count;
  };
  walk(root);
  return out;
}

// FNV-1a 32 bit of a string as 8 hex digits.
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Name of a merged mesh from what is in it: material name + the sorted original paths of its sources.
export const mergedName = (materialName: unknown, paths: Iterable<string>): string => 'fp_merged_' + fnv1a(String(materialName || '') + '\n' + [...paths].sort().join('\n'));
