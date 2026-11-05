import { describe, it, expect } from "bun:test";
import { transformPoint, inverseTransformPoint } from "../src/bindings.ts";
import { realignPins, setPin, migrateLegacyPins } from "../src/editor.ts";

const align = { position: [3, -2, 0.5], rotation: 30, scale: 2 };

describe("inverseTransformPoint", () => {
  it("round-trips transformPoint within 1e-9", () => {
    for (const p of [
      [0, 0],
      [1.5, -2.25],
      [-7, 4],
      [10, 10],
    ]) {
      const back = inverseTransformPoint(transformPoint(p, align), align);
      expect(back[0]).toBeCloseTo(p[0], 9);
      expect(back[1]).toBeCloseTo(p[1], 9);
      const fwd = transformPoint(inverseTransformPoint(p, align), align);
      expect(fwd[0]).toBeCloseTo(p[0], 9);
      expect(fwd[1]).toBeCloseTo(p[1], 9);
    }
  });

  it("defaults to identity", () => {
    expect(inverseTransformPoint([1, 2])).toEqual([1, 2]);
    expect(inverseTransformPoint([1, 2], {})).toEqual([1, 2]);
  });
});

describe("setPin", () => {
  it("keeps on_model only when set", () => {
    expect(
      setPin({}, "a", { x: 1, y: 1, z: 1, floor_id: "g" }).pins.a,
    ).not.toHaveProperty("on_model");
    expect(
      setPin({}, "a", { x: 1, y: 1, z: 1, floor_id: "g", on_model: true }).pins
        .a.on_model,
    ).toBe(true);
  });
});

describe("realignPins", () => {
  const layout = {
    rooms: [],
    pins: {
      a: { x: 1, y: 0, z: 2, floor_id: "g", on_model: true },
      b: { x: 1, y: 0, z: 2, floor_id: "g" },
    },
  };

  it("maps on_model pins through old inverse then new transform", () => {
    const oldA = { position: [0, 0, 0], rotation: 0, scale: 1 };
    const newA = { position: [0, 0, 0], rotation: 90, scale: 1 };
    const out = realignPins(layout, oldA, newA);
    expect(out.pins.a.x).toBeCloseTo(0, 6);
    expect(out.pins.a.y).toBeCloseTo(1, 6);
    expect(out.pins.a.z).toBe(2);
    expect(out.pins.a.on_model).toBe(true);
    expect(out.pins.a.floor_id).toBe("g");
    expect(out.pins.b).toBe(layout.pins.b);
    expect(layout.pins.a.x).toBe(1); // input untouched
  });

  it("follows offset, rotation and scale; z scales with scale", () => {
    // pin (1, 0) under old (90 deg, x0.5) is model point (0, -2); new (180 deg, x2, +[3, -2]) puts it at (3, 2)
    const oldA = { position: [0, 0, 0], rotation: 90, scale: 0.5 };
    const newA = { position: [3, -2, 0], rotation: 180, scale: 2 };
    const out = realignPins(layout, oldA, newA);
    expect(out.pins.a.x).toBeCloseTo(3, 6);
    expect(out.pins.a.y).toBeCloseTo(2, 6);
    expect(out.pins.a.z).toBeCloseTo(8, 6); // z 2 scaled by 2 / 0.5
  });

  it("returns the same layout when nothing changes or no pins follow the model", () => {
    const same = { position: [0, 0, 0], rotation: 0, scale: 1 };
    expect(realignPins(layout, same, { ...same })).toBe(layout);
    const plain = { pins: { b: layout.pins.b } };
    expect(realignPins(plain, same, align)).toBe(plain);
    expect(realignPins({}, same, align)).toEqual({});
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
