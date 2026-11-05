// Physical materials: glass, floors and fabric of the model are made MeshPhysicalMaterial while GLTFLoader
// builds them, once per load and in every quality tier (which are glass / floor / fabric: material-class.ts,
// from the file's JSON: material-facts.ts). A GLTFLoader plugin: getMaterialType picks the class,
// extendMaterialParams adds the look. Materials the file makes physical itself (KHR_materials_*, built by
// GLTFLoader's own plugins, which come first) or unlit are left exactly as the file says.
//
// Glass is thin glass, not three's transmission: transmission renders the opaque scene into an extra target
// every frame a transmissive surface is in view (and every window would need it). Thin glass is the model's
// own transparency with a smooth physical surface: the sky environment's reflection and a Schlick fresnel
// that turns a pane more opaque (more reflection, less see-through) at grazing angles (the shader patch in
// cloud-shadow.ts, keyed as its own program variant by userData.fpGlass). A file with
// KHR_materials_transmission keeps its real transmission.
import * as THREE from "three";
import type {
  GLTFLoaderPlugin,
  GLTFParser,
} from "three/addons/loaders/GLTFLoader.js";
import {
  classifyMaterial,
  type MaterialRule,
  type Surface,
} from "./material-class.ts";
import { gltfMaterialFacts, type GltfDoc } from "./material-facts.ts";

/** What the class adds, per class. Colours stay the model's (the glass keeps its tint). */
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

/** The class a material was made with (userData.fpSurface), or null. */
export const surfaceOf = (m: THREE.Material): Surface | null =>
  (m.userData && (m.userData.fpSurface as Surface | undefined)) || null;

// The class's look added to GLTFLoader's material parameters (the file's pbrMetallicRoughness already in).
export function surfaceParams(
  surface: Surface,
  params: Record<string, unknown>,
): void {
  const userData: Record<string, unknown> = {
    ...(params.userData as object | undefined),
    fpSurface: surface,
  };
  params.userData = userData;
  if (surface === "glass") {
    const L = SURFACE_LOOK.glass;
    params.roughness = Math.min(
      typeof params.roughness === "number" ? params.roughness : 1,
      L.roughness,
    );
    params.metalness = L.metalness;
    params.ior = L.ior;
    params.specularIntensity = L.specularIntensity;
    userData.fpGlass = true; // the fresnel alpha (cloud-shadow.ts), only on transparent panes
  } else if (surface === "floor") {
    params.clearcoat = SURFACE_LOOK.floor.clearcoat;
    params.clearcoatRoughness = SURFACE_LOOK.floor.clearcoatRoughness;
  } else {
    const L = SURFACE_LOOK.fabric;
    params.sheen = L.sheen;
    params.sheenRoughness = L.sheenRoughness;
    params.sheenColor = new THREE.Color().setScalar(L.sheenColor);
  }
}

/** Card YAML render.materials, and whether the model's own fp.render.materials apply (not with render: default). */
export interface SurfaceOptions {
  rules?: readonly MaterialRule[];
  modelRules?: boolean;
}

// Each material's class (index = glTF material index) from the file's JSON and the rules: the model's
// fp.render.materials (unless modelRules is false), then the card's.
export function surfaceClasses(
  json: GltfDoc,
  { rules = [], modelRules = true }: SurfaceOptions = {},
): (Surface | null)[] {
  const { materials, manifest } = gltfMaterialFacts(json);
  const all: MaterialRule[] = [
    ...((modelRules && manifest.render && manifest.render.materials) || []),
    ...rules,
  ];
  return materials.map((f) => classifyMaterial(f, all));
}

// The GLTFLoader plugin: loader.register(surfacePlugin(opts)). The classes are decided at the first material.
export function surfacePlugin(
  opts: SurfaceOptions = {},
): (parser: GLTFParser) => GLTFLoaderPlugin {
  return (parser) => {
    let classes: (Surface | null)[] | null = null;
    const classOf = (i: number): Surface | null => {
      if (!classes) {
        try {
          classes = surfaceClasses(parser.json as GltfDoc, opts);
        } catch (err) {
          console.warn("floorplan3d: material classes", err);
          classes = [];
        }
      }
      return classes[i] || null;
    };
    return {
      name: "floorplan3d_surfaces",
      getMaterialType: (i) => (classOf(i) ? THREE.MeshPhysicalMaterial : null),
      extendMaterialParams: (i, params) => {
        const s = classOf(i);
        if (s) surfaceParams(s, params);
        return null;
      },
    };
  };
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

/** Per-class counts of the physical-class materials under root. */
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
