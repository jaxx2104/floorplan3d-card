import { describe, it, expect } from "bun:test";
import {
  outlineFromTriangles,
  outlineFromRaster,
  outlineLoops,
  pickLoop,
  rasterGrid,
  outlineFromGrid,
} from "../src/outline.ts";
import { pointInPolygon, signedArea } from "../src/placement.ts";

// a horizontal quad at height y from plan rect (x0..x1, y0..y1) → two triangles (world z = -plan y), CCW from above
const quad = (x0, y0, x1, y1, y = 0) => [
  x0,
  y,
  -y0,
  x1,
  y,
  -y0,
  x1,
  y,
  -y1,
  x0,
  y,
  -y0,
  x1,
  y,
  -y1,
  x0,
  y,
  -y1,
];
const wall = (x0, y0, x1) => [x0, 0, -y0, x1, 0, -y0, x1, 2.7, -y0]; // vertical triangle, ignored
const norm = (p) =>
  p.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
const area = (p) => Math.abs(signedArea(p));

describe("outlineFromTriangles", () => {
  it("rectangle from two triangles", () => {
    const out = outlineFromTriangles(
      [...quad(0, 0, 4, 3), ...wall(0, 0, 4)],
      [2, 0, -1.5],
    );
    expect(out).toHaveLength(4);
    expect(area(out)).toBeCloseTo(12);
  });
  it("L-shape made of quads sharing whole edges", () => {
    // vertices must coincide on shared edges; T-junctions are not traced (the pick then falls back to the rectangle)
    const out = outlineFromTriangles(
      [...quad(0, 0, 2, 2), ...quad(2, 0, 4, 2), ...quad(0, 2, 2, 5)],
      [1, 0, -1],
    );
    expect(out).toHaveLength(6);
    expect(area(out)).toBeCloseTo(8 + 6);
  });
  it("two separate slabs: picks the loop containing the hit", () => {
    const out = outlineFromTriangles(
      [...quad(0, 0, 4, 3), ...quad(6, 0, 9, 3)],
      [7, 0, -1],
    );
    expect(pointInPolygon([7, 1], out)).toBe(true);
    expect(area(out)).toBeCloseTo(9);
  });
  it("ignores faces at another height", () => {
    const out = outlineFromTriangles(
      [...quad(0, 0, 4, 3, 0), ...quad(0, 0, 10, 10, 2.9)],
      [1, 0, -1],
    );
    expect(area(out)).toBeCloseTo(12);
  });
  it("snaps to 5 cm and drops collinear points", () => {
    const out = outlineFromTriangles(
      [...quad(0, 0, 2.02, 3), ...quad(2.02, 0, 4.01, 3)],
      [1, 0, -1],
    );
    expect(
      norm(out).every(
        ([x, y]) =>
          Math.abs(x * 20 - Math.round(x * 20)) < 1e-6 &&
          Math.abs(y * 20 - Math.round(y * 20)) < 1e-6,
      ),
    ).toBe(true);
    expect(out).toHaveLength(4);
  });
  it("returns null when nothing is under the hit", () => {
    expect(outlineFromTriangles(quad(0, 0, 4, 3), [10, 0, -10])).toBeNull();
    expect(outlineFromTriangles([], [0, 0, 0])).toBeNull();
  });
  it("pinch vertices: two squares touching at a corner", () => {
    const out12 = outlineFromTriangles(
      [...quad(0, 0, 2, 2), ...quad(2, 2, 4, 4)],
      [3, 0, -3],
    );
    expect(area(out12)).toBeCloseTo(4);
  });
  it("simplify collinear before snap: vertex 0.01 m off line removed even if snapping would move it", () => {
    const out = outlineFromTriangles(
      [...quad(0, 0, 2, 2.01), ...quad(2, 0, 4, 2.01)],
      [1, 0, -1],
    );
    expect(out).toHaveLength(4);
  });
  it("flipped triangle inside quad makes rectangle", () => {
    const flipped = [2, 0, -1, 2, 0, -2, 1, 0, -1.5]; // CW from above
    const out = outlineFromTriangles(
      [...quad(0, 0, 4, 3), ...flipped],
      [2, 0, -1.5],
    );
    expect(out).toHaveLength(4);
    expect(area(out)).toBeCloseTo(12);
  });
  it("a quad lying on top of the floor leaves the outer boundary", () => {
    const out = outlineFromTriangles(
      [...quad(0, 0, 4, 3), ...quad(1, 1, 3, 2)],
      [0.5, 0, -0.5],
    );
    expect(out).toHaveLength(4);
    expect(area(out)).toBeCloseTo(12);
  });
  it("pinch with unequal edge lengths: 2×2 square touching 3×1 rectangle", () => {
    const out = outlineFromTriangles(
      [...quad(0, 0, 2, 2), ...quad(2, 0, 5, 1)],
      [3.5, 0, -0.5],
    );
    expect(out).toHaveLength(4);
    expect(area(out)).toBeCloseTo(3);
  });
  it("merges points within 5 mm", () => {
    const t = quad(0, 0, 4, 3);
    t[3] += 0.003;
    t[11] -= 0.002; // nudge shared-corner copies by a few mm
    expect(area(outlineFromTriangles(t, [2, 0, -1.5]))).toBeCloseTo(12, 1);
  });
  it("hit on the boundary seam falls back to the largest nearby loop", () => {
    const out = outlineFromTriangles(
      [...quad(0, 0, 4, 3), ...quad(0.5, 0.5, 1, 1)],
      [4.05, 0, -1.5],
    );
    expect(area(out)).toBeCloseTo(12);
  });
  it("perf: 20k disjoint triangles plus target quad completes quickly", () => {
    const tris = [];
    for (let i = 0; i < 20000; i++) {
      tris.push(...quad(100 + i * 10, 100, 101 + i * 10, 101));
    }
    tris.push(...quad(0, 0, 4, 3));
    const start = Date.now();
    const out = outlineFromTriangles(tris, [2, 0, -1.5]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000); // generous: shared CI runners;
    expect(area(out)).toBeCloseTo(12);
  });
});

describe("outlineFromRaster", () => {
  it("rectangle", () => {
    const out = outlineFromRaster(quad(0, 0, 4, 3), [2, 0, -1.5]);
    expect(out).toHaveLength(4);
    expect(area(out)).toBeCloseTo(12, 0);
  });
  it("L-shape", () => {
    const out = outlineFromRaster(
      [...quad(0, 0, 2, 2), ...quad(2, 0, 4, 2), ...quad(0, 2, 2, 5)],
      [1, 0, -1],
    );
    expect(out).toHaveLength(6);
    expect(area(out)).toBeCloseTo(14, 0);
  });
  it("hit outside any floor -> null", () => {
    expect(
      outlineFromRaster(
        [...quad(0, 0, 4, 3), ...quad(6, 0, 9, 3)],
        [5, 0, -1.5],
      ),
    ).toBeNull();
  });
  it("picks only the connected slab", () => {
    const out = outlineFromRaster(
      [...quad(0, 0, 4, 3), ...quad(6, 0, 9, 3)],
      [7, 0, -1],
    );
    expect(area(out)).toBeCloseTo(9, 0);
  });
});

describe("loops + pickLoop", () => {
  const tris = [...quad(0, 0, 4, 3), ...quad(6, 0, 9, 3)];
  it("outlineLoops returns every loop at the height", () => {
    expect(outlineLoops(tris, 0)).toHaveLength(2);
    expect(outlineLoops(tris, 2)).toHaveLength(0);
  });
  it("pickLoop: containing, near, none", () => {
    const loops = outlineLoops(tris, 0);
    expect(area(pickLoop(loops, [7, 1]))).toBeCloseTo(9);
    expect(area(pickLoop(loops, [4.05, 1]))).toBeCloseTo(12);
    expect(pickLoop(loops, [5, 1])).toBeNull();
  });
  it("rasterGrid is reusable for several hits", () => {
    const g = rasterGrid(tris, 0);
    expect(area(outlineFromGrid(g, [1, 0, -1]))).toBeCloseTo(12, 0);
    expect(area(outlineFromGrid(g, [7, 0, -1]))).toBeCloseTo(9, 0);
  });
});
