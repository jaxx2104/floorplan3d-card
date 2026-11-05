// Final review fixes: roomless markers by zone (I2), model cameras through the alignment (I3),
// one-time pin migration (I5), import keeping / remapping views (I6).
import { describe, it, expect } from "bun:test";
import {
  nodeIndex,
  resolveViews,
  roomAt,
  exteriorShown,
  alignModelPoint,
  cameraToCard,
  topCameraToCard,
} from "../src/views.ts";
import { buildManifest } from "../src/manifest.ts";
import { transformPoint } from "../src/bindings.ts";
import { fitImport, migrateLegacyPins, mergeImport } from "../src/editor.ts";

const rect = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

describe("roomAt (roomless markers: pins, live mower)", () => {
  const rooms = [
    { id: "garden", level: "exterior", polygon: rect(10, 0, 30, 20) },
    { id: "bed", level: "exterior", polygon: rect(12, 2, 14, 4) },
    { id: "kitchen", level: "g", polygon: rect(0, 0, 5, 5) },
    { id: "office", level: "f", polygon: rect(0, 0, 5, 5) },
  ];
  const levelFloor = { g: "ground", f: "first", exterior: "ground" };
  it("picks the smallest room containing the point on the marker floor", () => {
    expect(roomAt([13, 3], "ground", rooms, levelFloor)).toBe("bed");
    expect(roomAt([20, 10], "ground", rooms, levelFloor)).toBe("garden");
    expect(roomAt([1, 1], "ground", rooms, levelFloor)).toBe("kitchen");
    expect(roomAt([1, 1], "first", rooms, levelFloor)).toBe("office");
  });
  it("rooms on unbound levels match any floor; nothing outside", () => {
    expect(roomAt([20, 10], "first", rooms, { g: "ground", f: "first" })).toBe(
      "garden",
    );
    expect(roomAt([20, 10], "first", rooms, levelFloor)).toBe(null);
    expect(roomAt([-5, -5], "ground", rooms, levelFloor)).toBe(null);
  });
  it("prefers a visible room over a smaller hidden one", () => {
    expect(
      roomAt([13, 3], "ground", rooms, levelFloor, new Set(["garden"])),
    ).toBe("garden");
    expect(roomAt([13, 3], "ground", rooms, levelFloor, new Set())).toBe("bed");
  });
});

describe("exteriorShown (live mower)", () => {
  const t = (roots) => ({
    roots: () => roots,
    children: (n) => n.children || [],
    name: (n) => n.name || "",
    extras: (n) => n.extras || {},
    parent: () => null,
  });
  const fp = (o) => ({ fp: o });
  const lawn = {
    name: "lawn",
    extras: fp({ kind: "zone", id: "lawn", outline: rect(0, 0, 1, 1) }),
  };
  const ext = {
    name: "ext",
    extras: fp({ kind: "level", id: "ext", role: "exterior" }),
    children: [lawn],
  };
  const g = { name: "g", extras: fp({ kind: "level", id: "g" }) };
  const a = t([g, ext]);
  const man = buildManifest(a);
  const idx = nodeIndex(a, man);
  it("true when any node of an exterior level is shown, false when none, null without exterior levels", () => {
    expect(
      exteriorShown(
        idx,
        idx.nodes.map(() => true),
        man.levels,
      ),
    ).toBe(true);
    expect(
      exteriorShown(
        idx,
        idx.nodes.map((n) => n.name === "lawn"),
        man.levels,
      ),
    ).toBe(true);
    expect(
      exteriorShown(
        idx,
        idx.nodes.map((n) => n.name === "g"),
        man.levels,
      ),
    ).toBe(false);
    const a2 = t([g]);
    const m2 = buildManifest(a2),
      i2 = nodeIndex(a2, m2);
    expect(
      exteriorShown(
        i2,
        i2.nodes.map(() => true),
        m2.levels,
      ),
    ).toBe(null);
  });
});

describe("model view cameras follow the model alignment", () => {
  const align = { position: [3, -2, 0.5], rotation: 30, scale: 2 };
  it("alignModelPoint matches transformPoint on the plan and scales + lifts height", () => {
    const p = alignModelPoint([1.5, 2, -4], align); // model world: x, height, -north
    const plan = transformPoint([1.5, 4], align);
    expect(p[0]).toBeCloseTo(plan[0], 9);
    expect(-p[2]).toBeCloseTo(plan[1], 9);
    expect(p[1]).toBeCloseTo(2 * 2 + 0.5, 9);
    expect(alignModelPoint([1, 2, 3])).toEqual([1, 2, 3]);
  });
  it("cameraToCard maps model cameras only", () => {
    const fn = (p) => p.map((v) => v + 1);
    const cam = { position: [0, 5, 10], target: [0, 0, 0] };
    expect(cameraToCard({ camera: cam, cameraFrame: "model" }, fn)).toEqual({
      position: [1, 6, 11],
      target: [1, 1, 1],
    });
    expect(cameraToCard({ camera: cam, cameraFrame: "card" }, fn)).toBe(cam);
    expect(cameraToCard({ camera: null, cameraFrame: "model" }, fn)).toBe(null);
    expect(cameraToCard(null, fn)).toBe(null);
  });
  it("topCameraToCard moves the centre and divides the zoom by the scale", () => {
    const top = { center: [1, 4], zoom: 2 };
    const out = topCameraToCard(
      { camera_top: top, camera_topFrame: "model" },
      align,
    );
    const c = transformPoint([1, 4], align);
    expect(out.center[0]).toBeCloseTo(c[0], 9);
    expect(out.center[1]).toBeCloseTo(c[1], 9);
    expect(out.zoom).toBeCloseTo(1, 9);
    expect(
      topCameraToCard({ camera_top: top, camera_topFrame: "card" }, align),
    ).toBe(top);
  });
  it("resolveViews marks where each camera comes from", () => {
    const manifest = {
      levels: [],
      rooms: [],
      views: [
        {
          id: "a",
          label: "A",
          show: ["all"],
          camera: { position: [0, 1, 2], target: [0, 0, 0] },
          camera_top: { center: [1, 1], zoom: 1 },
        },
        {
          id: "b",
          label: "B",
          show: ["all"],
          camera: { position: [0, 1, 2], target: [0, 0, 0] },
        },
      ],
    };
    const vs = resolveViews({
      manifest,
      haFloors: [],
      layoutViews: {
        b: { camera: { position: [5, 5, 5], target: [0, 0, 0] } },
      },
    });
    const a = vs.find((v) => v.id === "a"),
      b = vs.find((v) => v.id === "b");
    expect([a.cameraFrame, a.camera_topFrame]).toEqual(["model", "model"]);
    expect(b.cameraFrame).toBe("card");
    expect(b.camera.position).toEqual([5, 5, 5]);
  });
});

describe("migrateLegacyPins (I5: once, on the first alignment change)", () => {
  const layout = {
    pins: {
      a: { x: 1, y: 1, z: 1, floor_id: "ground" },
      b: { x: 1, y: 1, z: 1, floor_id: "attic" },
      c: { x: 1, y: 1, z: 1, floor_id: "ground", on_model: true },
    },
    model: { position: [0, 0, 0] },
  };
  it("marks pins on bound floors on_model and sets pins_migrated", () => {
    const out = migrateLegacyPins(layout, ["ground"]);
    expect(out.pins.a.on_model).toBe(true);
    expect(out.pins.b.on_model).toBeUndefined();
    expect(out.pins.c).toBe(layout.pins.c);
    expect(out.model.pins_migrated).toBe(true);
    expect(layout.pins.a.on_model).toBeUndefined();
  });
  it("does nothing once migrated", () => {
    const done = { ...layout, model: { pins_migrated: true } };
    expect(migrateLegacyPins(done, ["ground"])).toBe(done);
  });
});

describe("import and views (I6)", () => {
  it("fitImport remaps view floor links through the floor map", () => {
    const layout = {
      floors: [{ id: "up", elevation: 3 }],
      rooms: [{ id: "r", floor_id: "ground", polygon: rect(0, 0, 1, 1) }],
      pins: {},
      views: { first: { floors: ["up", "ground"] }, x: { label: "X" } },
    };
    const { layout: l, floorMap } = fitImport(
      layout,
      [
        { id: "ground", elevation: 0 },
        { id: "first", elevation: 3 },
      ],
      [],
    );
    expect(floorMap).toEqual({ up: "first" });
    expect(l.views.first.floors).toEqual(["first", "ground"]);
    expect(l.views.x).toEqual({ label: "X" });
  });
  it("mergeImport keeps the current views, order, model and mower when the file has none", () => {
    const cur = {
      views: { a: { rules: [{ hide: "all" }] } },
      view_order: ["a"],
      model: { version: "m" },
      mower: { entity: "x" },
    };
    const l = mergeImport(
      { rooms: [], pins: {}, model: null, mower: null },
      { rooms: [] },
      cur,
    );
    expect(l.views).toBe(cur.views);
    expect(l.view_order).toBe(cur.view_order);
    expect(l.model).toBe(cur.model);
    expect(l.mower).toBe(cur.mower);
    const own = mergeImport(
      { rooms: [], views: { b: {} }, model: null },
      { views: { b: {} }, model: null },
      cur,
    );
    expect(own.views).toEqual({ b: {} });
    expect(own.view_order).toBe(cur.view_order);
    expect(own.model).toBe(null);
  });
});
