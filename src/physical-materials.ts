// Physical materials (render quality 'high', QualityTier.physicalMaterials): glass, floors and fabric of the
// model become MeshPhysicalMaterial (which are glass / floor / fabric: material-class.ts).
//
// The upgrade is in place: the material object stays the same (its prototype, type and defines become
// physical, three's physical fields are added) and goes back the same way. The rest of the card keeps its
// references (merged static meshes share it, the cloud-shadow patch, the opacity slider, the furniture
// colours, wash / bloom stand-ins), and a tier change upgrades and restores the same objects. Each swap
// disposes the material's renderer state first: its program and uniforms are those of the other shader.
//
// Glass is thin glass, not three's transmission: transmission renders the opaque scene into an extra target
// every frame a transmissive surface is in view (and every window would need it). Thin glass is the model's
// own transparency with a smooth physical surface: the sky environment's reflection and a Schlick fresnel
// that turns a pane more opaque (more reflection, less see-through) at grazing angles (the shader patch in
// cloud-shadow.ts, keyed as its own program variant). A file with KHR_materials_transmission keeps its real
// transmission: such materials are already physical and left as they are.
import * as THREE from "three";
import type {
  MaterialFacts,
  MeshFacts,
  SelectorNode,
  Surface,
} from "./material-class.ts";
import { nodeIndex } from "./views.ts";
import { threeAdapter } from "./manifest.ts";
import { measuredElevations } from "./bindings.ts";
import type { Manifest } from "./types/manifest.ts";

/** What the upgrade sets, per class. Colours stay the model's (the glass keeps its tint). */
export const SURFACE_LOOK = Object.freeze({
  // thin glass: smooth, dielectric, full specular (ior 1.5: 4 % head-on), fresnel alpha in the shader
  glass: Object.freeze({
    roughness: 0.04,
    metalness: 0,
    ior: 1.5,
    specularIntensity: 1,
  }),
  // a subtle clear coat over the floor's own roughness (lacquer, sealed tiles)
  floor: Object.freeze({ clearcoat: 0.4, clearcoatRoughness: 0.2 }),
  // soft sheen at grazing angles: a neutral sheen colour (linear), so furniture: white still reads white
  fabric: Object.freeze({ sheen: 1, sheenRoughness: 0.75, sheenColor: 0.25 }),
});

// three's physical fields: own keys of a MeshPhysicalMaterial that a MeshStandardMaterial lacks (found once)
let physKeys: string[] | null = null;
const PHYS_SKIP = new Set([
  "uuid",
  "id",
  "type",
  "defines",
  "isMeshPhysicalMaterial",
]);
function physicalKeys(): string[] {
  if (physKeys) return physKeys;
  const std = new THREE.MeshStandardMaterial(),
    phys = new THREE.MeshPhysicalMaterial();
  physKeys = Object.keys(Object.getOwnPropertyDescriptors(phys)).filter(
    (k) => !PHYS_SKIP.has(k) && !Object.prototype.hasOwnProperty.call(std, k),
  );
  std.dispose();
  phys.dispose();
  return physKeys;
}

type Promoted = THREE.MeshStandardMaterial & {
  userData: {
    fpSurface?: Surface;
    fpSurfaceBase?: { roughness: number; metalness: number };
    fpGlass?: boolean;
  };
};

/** The surface a material was upgraded to, or null. */
export const surfaceOf = (m: THREE.Material): Surface | null =>
  (m.userData && m.userData.fpSurface) || null;

// Upgrade a plain MeshStandardMaterial in place to a physical one of class surface, or (null) restore it.
// -> true when it changed (it recompiles at its next use). Materials physical from the file are never touched.
export function setSurface(
  mat: THREE.Material,
  surface: Surface | null,
): boolean {
  const m = mat as Promoted;
  const cur = surfaceOf(m);
  if (cur === surface) return false;
  if (
    !cur &&
    (!(m as Partial<THREE.MeshStandardMaterial>).isMeshStandardMaterial ||
      (m as Partial<THREE.MeshPhysicalMaterial>).isMeshPhysicalMaterial)
  )
    return false;
  if (cur) restore(m);
  if (surface) promote(m, surface);
  m.needsUpdate = true;
  return true;
}

// type is read-only and defines undeclared in three's typings; both are plain fields at runtime
interface Writable {
  type: string;
  defines: Record<string, unknown> | undefined;
}

function promote(m: Promoted, surface: Surface): void {
  m.dispose(); // the renderer drops its program and uniforms: the physical shader has its own
  const fresh = new THREE.MeshPhysicalMaterial();
  for (const k of physicalKeys()) {
    const d = Object.getOwnPropertyDescriptor(fresh, k)!;
    Object.defineProperty(m, k, { ...d, configurable: true }); // reflectivity is an accessor on ior
  }
  fresh.dispose();
  Object.setPrototypeOf(m, THREE.MeshPhysicalMaterial.prototype);
  const p = m as unknown as THREE.MeshPhysicalMaterial & Promoted;
  Object.defineProperty(p, "isMeshPhysicalMaterial", {
    value: true,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  const w = p as unknown as Writable;
  w.type = "MeshPhysicalMaterial";
  w.defines = { ...w.defines, PHYSICAL: "" };
  p.userData.fpSurface = surface;
  if (surface === "glass") {
    const L = SURFACE_LOOK.glass;
    p.userData.fpSurfaceBase = {
      roughness: p.roughness,
      metalness: p.metalness,
    };
    p.roughness = Math.min(p.roughness, L.roughness);
    p.metalness = L.metalness;
    p.ior = L.ior;
    p.specularIntensity = L.specularIntensity;
    p.userData.fpGlass = true; // the fresnel alpha (cloud-shadow.ts), only on transparent panes
  } else if (surface === "floor") {
    p.clearcoat = SURFACE_LOOK.floor.clearcoat;
    p.clearcoatRoughness = SURFACE_LOOK.floor.clearcoatRoughness;
  } else {
    const L = SURFACE_LOOK.fabric;
    p.sheen = L.sheen;
    p.sheenRoughness = L.sheenRoughness;
    p.sheenColor.setScalar(L.sheenColor);
  }
}

function restore(m: Promoted): void {
  m.dispose();
  const base = m.userData.fpSurfaceBase;
  for (const k of physicalKeys())
    delete (m as unknown as Record<string, unknown>)[k];
  delete (m as unknown as Record<string, unknown>).isMeshPhysicalMaterial;
  Object.setPrototypeOf(m, THREE.MeshStandardMaterial.prototype);
  const w = m as unknown as Writable;
  w.type = "MeshStandardMaterial";
  const defines = { ...w.defines };
  delete defines.PHYSICAL;
  w.defines = defines;
  if (base) {
    m.roughness = base.roughness;
    m.metalness = base.metalness;
  }
  delete m.userData.fpSurface;
  delete m.userData.fpSurfaceBase;
  delete m.userData.fpGlass;
}

// Fragment snippet of thin glass (before three's opaque_fragment): Schlick fresnel of a dielectric (F0 4 %)
// raises the pane's alpha towards 1 at grazing angles, where its reflection outshines what is behind it.
export const GLASS_FRESNEL = /* glsl */ `
#ifndef OPAQUE
{
  vec3 fpV = isOrthographic ? vec3( 0.0, 0.0, 1.0 ) : normalize( vViewPosition );
  float fpC = clamp( abs( dot( normal, fpV ) ), 0.0, 1.0 );
  diffuseColor.a = mix( diffuseColor.a, 1.0, 0.04 + 0.96 * pow( 1.0 - fpC, 5.0 ) );
}
#endif
`;

/** Per-class counts of the upgraded materials under root. */
export function surfaceCounts(root: THREE.Object3D): Record<Surface, number> {
  const out: Record<Surface, number> = { glass: 0, floor: 0, fabric: 0 },
    seen = new Set<THREE.Material>();
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material;
    if (!mat) return;
    for (const m of ([] as THREE.Material[]).concat(mat)) {
      if (seen.has(m)) continue;
      seen.add(m);
      const s = surfaceOf(m);
      if (s) out[s]++;
    }
  });
  return out;
}

// A floor surface: at most this thick, at least this wide, its top this close to its level's floor height.
export const FLOOR_SURFACE = Object.freeze({
  maxThick: 0.4,
  minWide: 0.3,
  tol: 0.05,
});

// The facts of every model material (material-class.ts), gathered once per model before its static meshes are
// merged (node paths, mesh names and their places are the modelled ones then). Materials of several meshes
// list each use.
export function materialFacts(
  root: THREE.Object3D,
  manifest: Manifest<THREE.Object3D>,
): Map<THREE.Material, MaterialFacts> {
  root.updateMatrixWorld(true);
  const index = nodeIndex(threeAdapter(root), manifest);
  const info = new Map<THREE.Object3D, SelectorNode>();
  for (const n of index.nodes) info.set(n.node, n);
  const meas = measuredElevations(manifest.levels);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const box = new THREE.Box3(),
    size = new THREE.Vector3();
  const out = new Map<THREE.Material, MaterialFacts>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const chain: SelectorNode[] = [],
      groups: string[] = [],
      layers: string[] = [];
    let object = false,
      room = false,
      zone = false,
      level: Manifest<THREE.Object3D>["levels"][number] | null = null,
      tagged = false;
    for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) {
      const n = info.get(p);
      if (n) {
        chain.push(n);
        layers.push(...n.layers);
      }
      const e = manifest.byNode.get(p);
      if (e) {
        tagged = true;
        if (e.kind === "object") object = true;
        else if (e.kind === "room") room = true;
        else if (e.kind === "zone") zone = true;
        else if (e.kind === "level" && !level) level = e;
      } else if (p !== o && !tagged) {
        const name = (p.userData && (p.userData.name as string)) || p.name;
        if (name) groups.push(name);
      }
    }
    const lv = level as Manifest<THREE.Object3D>["levels"][number] | null;
    const storey = !!lv && (lv.role === "storey" || lv.role === "basement");
    const indoor =
      !zone &&
      !layers.some((l) => /^terrain$/i.test(String(l))) &&
      (room || storey);
    let floorTop = false;
    if (room && storey) {
      const e =
        lv.elevation !== null && Number.isFinite(lv.elevation)
          ? lv.elevation
          : meas[lv.id]?.elevation;
      box.setFromObject(o).applyMatrix4(rootInv); // model space (the root may be placed already)
      box.getSize(size);
      const F = FLOOR_SURFACE;
      floorTop =
        e !== undefined &&
        !box.isEmpty() &&
        size.y <= F.maxThick &&
        Math.min(size.x, size.z) >= F.minWide &&
        Math.abs(box.max.y - e) <= F.tol;
    }
    const use: MeshFacts = {
      name: (o.userData && (o.userData.name as string)) || o.name || "",
      groups,
      layers,
      object,
      indoor,
      floorTop,
      chain,
    };
    for (const m of ([] as THREE.Material[]).concat(mesh.material)) {
      let f = out.get(m);
      if (!f) {
        const sm = m as Partial<THREE.MeshPhysicalMaterial>;
        const textured = !!(sm.map || sm.alphaMap);
        f = {
          name: m.name || "",
          physical: !!sm.isMeshPhysicalMaterial && !surfaceOf(m),
          extras: m.userData ? m.userData.fp_surface : undefined,
          transparent: !!m.transparent,
          opacity: m.opacity ?? 1,
          textured,
          emissive:
            !!(sm.emissive && sm.emissive.getHex() !== 0) || !!sm.emissiveMap,
          uses: [],
        };
        out.set(m, f);
      }
      f.uses.push(use);
    }
  });
  return out;
}
