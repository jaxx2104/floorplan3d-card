import { describe, it, expect } from "bun:test";
import { transformPoint, inverseTransformPoint } from "../src/bindings.ts";

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
