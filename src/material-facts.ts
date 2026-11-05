// The facts of every glTF material as the material classes see them (material-class.ts), read from the file's
// JSON before any three.js object exists: the GLTFLoader plugin (physical-materials.ts) decides each
// material's class while the loader builds it, and tools/check-model.mjs reports the same classes. Pure.
//
// Node and mesh names, the fp tags and the level elevations come from the manifest of the JSON (manifest.ts
// gltfAdapter); mesh boxes from the POSITION accessors' min / max (required by glTF) and the node transforms,
// in the scene's frame (the model space the card measures in).
import {
  buildManifest,
  gltfAdapter,
  type GltfJson,
  type GltfNode,
} from "./manifest.ts";
import { nodeIndex } from "./views.ts";
import { measuredElevations } from "./bindings.ts";
import type {
  MaterialFacts,
  MeshFacts,
  SelectorNode,
} from "./material-class.ts";
import type { Manifest, ManifestLevel } from "./types/manifest.ts";

/** The glTF JSON fields the facts read (besides the node tree of GltfJson). */
export interface GltfMaterialDef {
  name?: string;
  extras?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  alphaMode?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    baseColorTexture?: unknown;
  };
  emissiveFactor?: number[];
  emissiveTexture?: unknown;
}
export interface GltfDoc extends GltfJson {
  nodes?: (GltfNode & { mesh?: number })[];
  meshes?: {
    name?: string;
    primitives?: { attributes?: Record<string, number>; material?: number }[];
  }[];
  materials?: GltfMaterialDef[];
  accessors?: { min?: number[]; max?: number[] }[];
  extensionsUsed?: string[];
}

/** Material extensions with which GLTFLoader already makes a MeshPhysicalMaterial (three r187). */
export const PHYSICAL_EXTENSIONS: readonly string[] = Object.freeze([
  "KHR_materials_anisotropy",
  "KHR_materials_clearcoat",
  "KHR_materials_diffuse_roughness",
  "KHR_materials_dispersion",
  "KHR_materials_ior",
  "KHR_materials_iridescence",
  "KHR_materials_sheen",
  "KHR_materials_specular",
  "KHR_materials_transmission",
  "KHR_materials_volume",
  "EXT_materials_bump",
]);
/** Material extensions that make the material something the card leaves as the file says. */
const AS_FILE = new Set([...PHYSICAL_EXTENSIONS, "KHR_materials_unlit"]);

// A floor surface: at most this thick, at least this wide, its top this close to its level's floor height.
export const FLOOR_SURFACE = Object.freeze({
  maxThick: 0.4,
  minWide: 0.3,
  tol: 0.05,
});

// --- column-major 4x4 matrices (glTF's order) ---
type M4 = number[];
const IDENTITY: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function localMatrix(n: GltfNode): M4 {
  if (Array.isArray(n.matrix) && n.matrix.length === 16) return n.matrix;
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  const x2 = x + x,
    y2 = y + y,
    z2 = z + z;
  const xx = x * x2,
    xy = x * y2,
    xz = x * z2,
    yy = y * y2,
    yz = y * z2,
    zz = z * z2,
    wx = w * x2,
    wy = w * y2,
    wz = w * z2;
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}
function mul(a: M4, b: M4): M4 {
  const c = new Array<number>(16);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      c[col * 4 + row] = s;
    }
  return c;
}

/** An axis-aligned box: [min x, y, z, max x, y, z]. */
type Box = [number, number, number, number, number, number];
const emptyBox = (): Box => [
  Infinity,
  Infinity,
  Infinity,
  -Infinity,
  -Infinity,
  -Infinity,
];
const isEmpty = (b: Box): boolean => b[0] > b[3];
function union(a: Box, b: Box): void {
  for (let i = 0; i < 3; i++) {
    a[i] = Math.min(a[i], b[i]);
    a[i + 3] = Math.max(a[i + 3], b[i + 3]);
  }
}
// The accessor box (local) under the matrix: its eight corners transformed.
function boxOf(min: number[], max: number[], m: M4): Box {
  const out = emptyBox();
  for (let i = 0; i < 8; i++) {
    const p = [
      i & 1 ? max[0] : min[0],
      i & 2 ? max[1] : min[1],
      i & 4 ? max[2] : min[2],
    ];
    for (let r = 0; r < 3; r++) {
      const v = m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r];
      out[r] = Math.min(out[r], v);
      out[r + 3] = Math.max(out[r + 3], v);
    }
  }
  return out;
}

/** The facts of the file's materials (index = glTF material index) and the manifest they were read with. */
export interface GltfFacts {
  materials: MaterialFacts[];
  manifest: Manifest<number>;
}

export function gltfMaterialFacts(json: GltfDoc): GltfFacts {
  const nodes = json.nodes || [],
    meshes = json.meshes || [],
    accessors = json.accessors || [];
  const adapter = gltfAdapter(json);
  const manifest = buildManifest(adapter);
  const index = nodeIndex(adapter, manifest);
  const info = new Map<number, SelectorNode>();
  for (const n of index.nodes) info.set(n.node, n);
  const parent = (i: number): number | null => adapter.parent(i) ?? null;

  // world matrices of the scene's nodes, and the box of every primitive of every mesh node
  type Prim = {
    node: number;
    mesh: number;
    prim: number;
    box: Box;
    multi: boolean;
  };
  const prims: Prim[] = [];
  const nodeBox = new Map<number, Box>(); // a node's own primitives
  const walk = (i: number, up: M4, seen: Set<number>): void => {
    if (seen.has(i) || !nodes[i]) return;
    seen.add(i);
    const n = nodes[i],
      world = mul(up, localMatrix(n));
    const mesh = n.mesh !== undefined ? meshes[n.mesh] : undefined;
    if (mesh) {
      const list = mesh.primitives || [];
      const own = emptyBox();
      list.forEach((p, k) => {
        const a = p.attributes && accessors[p.attributes.POSITION];
        const box =
          a && Array.isArray(a.min) && Array.isArray(a.max)
            ? boxOf(a.min, a.max, world)
            : emptyBox();
        union(own, box);
        prims.push({
          node: i,
          mesh: n.mesh!,
          prim: k,
          box,
          multi: list.length > 1,
        });
      });
      nodeBox.set(i, own);
    }
    for (const c of n.children || []) walk(c, world, seen);
  };
  const seen = new Set<number>();
  for (const r of adapter.roots()) walk(r, IDENTITY, seen);

  // a level's lowest point: what the card measures after loading (view/model.ts), for measuredElevations
  const subtreeBox = (i: number): Box => {
    const b = emptyBox();
    const own = nodeBox.get(i);
    if (own) union(b, own);
    for (const c of nodes[i].children || []) union(b, subtreeBox(c));
    return b;
  };
  for (const l of manifest.levels) {
    const b = subtreeBox(l.node);
    l.minY = isEmpty(b) ? 0 : b[1];
  }
  const meas = measuredElevations(manifest.levels);

  const out: MaterialFacts[] = (json.materials || []).map((m) => {
    const pbr = m.pbrMetallicRoughness || {};
    const ef = m.emissiveFactor || [0, 0, 0];
    return {
      name: m.name || "",
      physical: Object.keys(m.extensions || {}).some((e) => AS_FILE.has(e)),
      extras: m.extras ? m.extras.fp_surface : undefined,
      transparent: m.alphaMode === "BLEND",
      opacity: Array.isArray(pbr.baseColorFactor)
        ? (pbr.baseColorFactor[3] ?? 1)
        : 1,
      textured: pbr.baseColorTexture !== undefined,
      emissive: ef.some((v) => v > 0) || m.emissiveTexture !== undefined,
      uses: [],
    };
  });
  const F = FLOOR_SURFACE;
  for (const p of prims) {
    const prim = (meshes[p.mesh].primitives || [])[p.prim];
    const f =
      prim && prim.material !== undefined ? out[prim.material] : undefined;
    if (!f) continue; // three's default material
    const chain: SelectorNode[] = [],
      groups: string[] = [],
      layers: string[] = [];
    let object = false,
      room = false,
      zone = false,
      level: ManifestLevel<number> | null = null,
      tagged = false;
    // a multi-primitive mesh is a group (the node) of meshes in three: the node counts as the mesh's group
    for (let n: number | null = p.node; n !== null; n = parent(n)) {
      const s = info.get(n);
      if (s) {
        chain.push(s);
        layers.push(...s.layers);
      }
      const e = manifest.byNode.get(n);
      if (e) {
        tagged = true;
        if (e.kind === "object") object = true;
        else if (e.kind === "room") room = true;
        else if (e.kind === "zone") zone = true;
        else if (e.kind === "level" && !level) level = e;
      } else if ((n !== p.node || p.multi) && !tagged) {
        const name = adapter.name(n);
        if (name) groups.push(name);
      }
    }
    const lv = level as ManifestLevel<number> | null;
    const storey = !!lv && (lv.role === "storey" || lv.role === "basement");
    const indoor =
      !zone &&
      !layers.some((l) => /^terrain$/i.test(String(l))) &&
      (room || storey);
    let floorTop = false;
    if (room && storey && !isEmpty(p.box)) {
      const e =
        lv.elevation !== null && Number.isFinite(lv.elevation)
          ? lv.elevation
          : meas[lv.id]?.elevation;
      const b = p.box;
      floorTop =
        e !== undefined &&
        b[4] - b[1] <= F.maxThick &&
        Math.min(b[3] - b[0], b[5] - b[2]) >= F.minWide &&
        Math.abs(b[4] - e) <= F.tol;
    }
    const mesh = meshes[p.mesh];
    const use: MeshFacts = {
      name: p.multi
        ? mesh.name || `mesh_${p.mesh}`
        : nodes[p.node].name || mesh.name || "",
      groups,
      layers,
      object,
      indoor,
      floorTop,
      chain,
    };
    f.uses.push(use);
  }
  return { materials: out, manifest };
}

/** KHR / EXT material extensions the file uses: name -> number of materials. */
export function materialExtensions(json: GltfDoc): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of json.materials || [])
    for (const e of Object.keys(m.extensions || {})) out[e] = (out[e] || 0) + 1;
  return out;
}
