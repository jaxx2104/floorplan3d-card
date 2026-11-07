import { describe, it, expect } from "bun:test";
import {
  normCutaway,
  sideLow,
  viewHorizontal,
  LOW_ON,
  LOW_OFF,
} from "../src/cutaway.ts";
import { buildManifest } from "../src/manifest.ts";
import { ModelCutaway } from "../src/view/cutaway.ts";
import * as THREE from "three";

describe("normCutaway", () => {
  it("accepts a variant and normalises facing", () => {
    expect(
      normCutaway({ side: "south", facing: [0, 2], variant: "low" }),
    ).toEqual({
      side: "south",
      facing: [0, 1],
      variant: "low",
      clip: null,
    });
  });
  it("accepts a clip height", () => {
    expect(normCutaway({ side: "east", facing: [1, 0], clip: 1 })).toEqual({
      side: "east",
      facing: [1, 0],
      variant: null,
      clip: 1,
    });
  });
  it("rejects bad tags with a reason", () => {
    for (const t of [
      null,
      { facing: [1, 0], variant: "low" },
      { side: "South", facing: [1, 0], variant: "low" },
      { side: "s", facing: [0, 0], variant: "low" },
      { side: "s", facing: [1], variant: "low" },
      { side: "s", facing: [1, 0], variant: "mid" },
      { side: "s", facing: [1, 0] },
      { side: "s", facing: [1, 0], variant: "low", clip: 1 },
      { side: "s", facing: [1, 0], clip: "1" },
    ])
      expect(typeof normCutaway(t)).toBe("string");
  });
});

describe("viewHorizontal", () => {
  it("is the unit horizontal direction from the target to the camera", () => {
    const v = viewHorizontal([3, 5, 4]);
    expect(v[0]).toBeCloseTo(0.6);
    expect(v[1]).toBeCloseTo(0.8);
  });
  it("is null looking (nearly) straight down", () => {
    expect(viewHorizontal([0, 10, 0])).toBeNull();
    expect(viewHorizontal([0.1, 10, 0.1])).toBeNull();
    expect(viewHorizontal([0, 0, 0])).toBeNull();
  });
});

describe("sideLow", () => {
  it("lowers the sides facing the camera, keeps the far ones", () => {
    const view = viewHorizontal([8.5, 23.5, 14.1]); // the default view from the south-south-east
    expect(sideLow([0, 1], view, false)).toBe(true); // south
    expect(sideLow([1, 0], view, false)).toBe(true); // east
    expect(sideLow([0, -1], view, false)).toBe(false); // north
    expect(sideLow([-1, 0], view, false)).toBe(false); // west
  });
  it("has hysteresis at the edge", () => {
    const d = (LOW_ON + LOW_OFF) / 2;
    const view = [d, Math.sqrt(1 - d * d)];
    expect(sideLow([1, 0], view, false)).toBe(false);
    expect(sideLow([1, 0], view, true)).toBe(true);
  });
  it("keeps every side full from straight above", () => {
    expect(sideLow([0, 1], null, true)).toBe(false);
  });
});

describe("manifest cutaways", () => {
  const tree = (nodes) => ({
    roots: () => nodes,
    children: (n) => n.children || [],
    parent: () => null,
    name: (n) => n.name,
    extras: (n) => n.extras,
  });
  it("collects valid fp.cutaway nodes and warns on bad ones", () => {
    const good = {
      name: "walls_south_low",
      extras: {
        fp: { cutaway: { side: "south", facing: [0, 1], variant: "low" } },
      },
    };
    const bad = {
      name: "x",
      extras: { fp: { cutaway: { side: "south", facing: [0, 1] } } },
    };
    const m = buildManifest(tree([{ name: "house", children: [good, bad] }]));
    expect(m.cutaways.map((c) => c.node)).toEqual([good]);
    expect(m.cutaways[0].variant).toBe("low");
    expect(m.warnings.some((w) => w.includes("x: cutaway"))).toBe(true);
  });
});

describe("ModelCutaway", () => {
  const setup = () => {
    const root = new THREE.Group();
    const full = new THREE.Group(),
      low = new THREE.Group();
    root.add(full, low);
    root.updateMatrixWorld(true);
    const cut = new ModelCutaway();
    const tag = { side: "south", facing: [0, 1] };
    cut.setModel(root, [
      { ...tag, variant: "full", clip: null, node: full },
      { ...tag, variant: "low", clip: null, node: low },
    ]);
    const cam = new THREE.PerspectiveCamera();
    const target = new THREE.Vector3();
    return { root, full, low, cut, cam, target };
  };
  it("shows the full variant until the camera faces the side", () => {
    const { full, low, cut, cam, target } = setup();
    expect([full.visible, low.visible]).toEqual([true, false]);
    cam.position.set(0, 10, 10);
    expect(cut.update(cam, target)).toBe(true);
    expect([full.visible, low.visible]).toEqual([false, true]);
    expect(cut.sig).toBe("south");
    cam.position.set(0, 10, -10);
    expect(cut.update(cam, target)).toBe(true);
    expect([full.visible, low.visible]).toEqual([true, false]);
  });
  it("keeps its variants through a visibility pass that shows every node", () => {
    const { full, low, cut, cam, target } = setup();
    cam.position.set(0, 10, 10);
    cut.update(cam, target);
    cut.release();
    full.visible = low.visible = true; // the view rules restore every node
    cut.reapply();
    expect([full.visible, low.visible]).toEqual([false, true]);
  });
  it("leaves a node a view rule hid hidden when its side switches", () => {
    const { full, low, cut, cam, target } = setup();
    cut.release();
    low.visible = false; // hidden by a view rule
    cut.reapply();
    cam.position.set(0, 10, 10);
    cut.update(cam, target);
    expect([full.visible, low.visible]).toEqual([false, false]);
    cam.position.set(0, 10, -10);
    cut.update(cam, target);
    expect([full.visible, low.visible]).toEqual([true, false]);
  });
});
