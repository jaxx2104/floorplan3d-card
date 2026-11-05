// Lamps authored in the model as glTF KHR_lights_punctual. GLTFLoader turns each into a three.js Point / Spot /
// DirectionalLight (intensity in candela, range, cone); left in the scene they would be lights that are always
// on and bound to nothing. After the loader has built the scene (afterRoot) every one of them is replaced by a
// plain node with the light's place and its photometry in userData.fpLamp: a light object (type light) that
// holds one takes its position, aim, beam, cone, range and candela from it for the card's real lights, bound
// to the object's HA light like every model lamp (objects/types.ts). Lamps outside light objects do nothing.
import * as THREE from "three";
import type {
  GLTFLoaderPlugin,
  GLTFParser,
} from "three/addons/loaders/GLTFLoader.js";

/** A model lamp as the card reads it (userData.fpLamp of its node). */
export interface ModelLamp {
  beam: "point" | "spot" | "directional";
  /** Luminous intensity at full brightness (cd; lux for a directional light). */
  candela: number;
  /** Metres the light reaches (0: no limit; glTF range). */
  range: number;
  /** Spot cone (outer, degrees) and edge softness 0..1 (1 - inner / outer), else null. */
  angle: number | null;
  penumbra: number | null;
}

const fin = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

// The photometry of one of GLTFLoader's lights.
export function lampSpec(l: THREE.Light): ModelLamp {
  const spot = (l as Partial<THREE.SpotLight>).isSpotLight
    ? (l as THREE.SpotLight)
    : null;
  return {
    beam: spot
      ? "spot"
      : (l as Partial<THREE.DirectionalLight>).isDirectionalLight
        ? "directional"
        : "point",
    candela: fin(l.intensity) ? Math.max(0, l.intensity) : 1,
    range: fin((l as THREE.PointLight).distance)
      ? (l as THREE.PointLight).distance
      : 0,
    angle: spot ? THREE.MathUtils.radToDeg(spot.angle) : null,
    penumbra: spot ? spot.penumbra : null,
  };
}

// Replace every light under root by a plain node at its place (same name, userData plus fpLamp, children, sibling
// position and loader association). -> number replaced.
export function replaceLights(
  root: THREE.Object3D,
  associations?: Map<THREE.Object3D, unknown> | null,
): number {
  const lights: THREE.Light[] = [];
  root.traverse((o) => {
    if ((o as Partial<THREE.Light>).isLight) lights.push(o as THREE.Light);
  });
  for (const l of lights) {
    const m = new THREE.Object3D();
    m.name = l.name;
    m.userData = { ...l.userData, fpLamp: lampSpec(l) };
    m.position.copy(l.position);
    m.quaternion.copy(l.quaternion);
    m.scale.copy(l.scale);
    m.visible = l.visible;
    const target = (l as Partial<THREE.SpotLight>).target;
    for (const c of [...l.children]) if (c !== target) m.add(c);
    const parent = l.parent;
    if (parent) {
      parent.children[parent.children.indexOf(l)] = m; // the node keeps its place among its siblings (node paths)
      m.parent = parent;
      l.parent = null;
    }
    if (associations && associations.has(l))
      associations.set(m, associations.get(l));
    l.dispose();
  }
  return lights.length;
}

// The GLTFLoader plugin: loader.register(lampPlugin()).
export function lampPlugin(): (parser: GLTFParser) => GLTFLoaderPlugin {
  return (parser) => ({
    name: "floorplan3d_lamps",
    afterRoot: (gltf) => {
      for (const scene of gltf.scenes || [gltf.scene])
        replaceLights(
          scene,
          parser.associations as unknown as Map<THREE.Object3D, unknown>,
        );
      return null;
    },
  });
}

/** The lamp of a model object: the first point / spot lamp node in its subtree, not inside a nested object. */
export function findLamp(
  node: THREE.Object3D | null | undefined,
): THREE.Object3D | null {
  if (!node) return null;
  const walk = (n: THREE.Object3D): THREE.Object3D | null => {
    const lamp = n.userData && (n.userData.fpLamp as ModelLamp | undefined);
    if (lamp && lamp.beam !== "directional") return n;
    for (const c of n.children) {
      const fp =
        c.userData && (c.userData.fp as { kind?: unknown } | undefined);
      if (fp && fp.kind === "object") continue; // another object's lamp
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(node);
}

export const lampOf = (
  n: THREE.Object3D | null | undefined,
): ModelLamp | null =>
  (n && n.userData && (n.userData.fpLamp as ModelLamp | undefined)) || null;
