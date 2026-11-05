// Fixtures for the model-object tests (ObjectLayer and friends): a fake view and a model with lamps.
import * as THREE from "three";

/** The view surface ObjectLayer uses; counts redraws and shadow updates. Floor "up" is at 3 m. */
export function fakeView() {
  return {
    objectsGroup: new THREE.Group(),
    dirty: 0,
    shadow: 0,
    flagged: [],
    markDirty() {
      this.dirty++;
    },
    floorElevation: (f) => (f === "up" ? 3 : 0),
    requestShadowUpdate(lights) {
      this.shadow++;
      this.dirty++;
      this.flagged.push(...lights);
    },
  };
}

/**
 * A model with one level "ground" and an object per entry: { id, x, type?, group?, hints?,
 * glowName? }. Each object node sits at (x, 2, 0) with a small glow mesh child.
 */
export function lampModel(objs) {
  const root = new THREE.Group();
  const level = new THREE.Group();
  root.add(level);
  const objects = objs.map((l) => {
    const node = new THREE.Group();
    node.position.set(l.x, 2, 0);
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.06, 0.06),
      new THREE.MeshStandardMaterial(),
    );
    glow.name = l.glowName || "glow";
    node.add(glow);
    level.add(node);
    return {
      id: l.id,
      type: l.type || "light",
      level: "ground",
      group: l.group || null,
      glow: null,
      hints: l.hints || {},
      node,
      suggest: {},
    };
  });
  return {
    id: "m",
    root,
    manifest: { levels: [{ id: "ground", node: level }], objects },
  };
}

/** Auto bindings object id -> entity from [[id, entity], ...]. */
export const bindings = (pairs) =>
  new Map(
    pairs.map(([id, entity]) => [
      id,
      { entity, auto: true, missing: false, hidden: false },
    ]),
  );

/** ObjectLayer.update context: every level visible, lights on. */
export const allVisible = { visibleLevel: () => true, lightsOn: true };
