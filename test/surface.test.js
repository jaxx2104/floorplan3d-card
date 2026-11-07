import { describe, it, expect } from "bun:test";
import {
  surfaceKind,
  chooseSurface,
  nearPolygon,
  worldOf,
  planOf,
  HORIZONTAL_DIRS,
  SURFACE_OFFSET,
  WALL_RANGE,
  surfaceKey,
  surfaceSearch,
} from "../src/surface.ts";

const close = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const h = (point, normal, distance, dir) => ({ point, normal, distance, dir });

describe("surfaceKind", () => {
  it("wall, corner and door anchors stick to walls", () => {
    expect(surfaceKind("sensor", "temperature")).toBe("wall"); // wall
    expect(surfaceKind("camera")).toBe("wall"); // corner
    expect(surfaceKind("lock")).toBe("wall"); // door
    expect(surfaceKind("binary_sensor", "motion")).toBe("wall"); // corner, ceiling height
    expect(surfaceKind("something_new")).toBe("wall"); // default rule: wall
  });
  it("ceiling-grid devices go to the ceiling, floor-standing ones to the floor", () => {
    expect(surfaceKind("light")).toBe("ceiling");
    expect(surfaceKind("fan")).toBe("ceiling");
    expect(surfaceKind("binary_sensor", "smoke")).toBe("ceiling");
    expect(surfaceKind("vacuum")).toBe("floor");
    expect(surfaceKind("lawn_mower")).toBe("floor");
  });
});

describe("surfaceSearch (rays stay on the device's floor)", () => {
  // the first hit of a vertical ray from plan height `from` within `max` among surfaces at heights `zs` (plan, same floor)
  const cast = (g, zs) => {
    const up = g.dirs[0][1] > 0;
    const d = zs
      .map((z) => (up ? z - g.from : g.from - z))
      .filter((x) => x >= 0 && x <= g.max)
      .sort((a, b) => a - b)[0];
    if (d === undefined) return [];
    const z = up ? g.from + d : g.from - d;
    return [h([0, z, 0], [0, up ? -1 : 1, 0], d, g.dirs[0])];
  };
  it("ceiling: starts at max(0.5, z - 1), ends 0.3 m above the floor height", () => {
    expect(surfaceSearch("ceiling", 2.62, 2.7)).toEqual([
      { dirs: [[0, 1, 0]], max: 3.0 - 1.62, from: 1.62 },
    ]);
    expect(surfaceSearch("ceiling", 1.0, 2.7)[0].from).toBe(0.5);
    expect(surfaceSearch("ceiling", 2.62)[0].max).toBeCloseTo(1.38); // floor height unknown: 2.7
  });
  it("ceiling at 2.5 with an upper floor above: the light lands just under 2.5, never upstairs", () => {
    const g = surfaceSearch("ceiling", 2.62, 2.7)[0]; // computed at the floor's 2.7 m height
    const s = chooseSurface("ceiling", cast(g, [2.5, 3.0 + 2.5])); // this ceiling, the upper floor's ceiling
    expect(s.point[1]).toBeCloseTo(2.45);
    expect(chooseSurface("ceiling", cast(g, [3.2, 5.5]))).toBe(null); // only the floor above: keep the point
  });
  it("floor: down to 0.3 m below the floor, not through a stair opening to the floor below", () => {
    const g = surfaceSearch("floor", 0.1, 2.7)[0];
    expect(g).toEqual({ dirs: [[0, -1, 0]], max: 0.4, from: 0.1 });
    expect(chooseSurface("floor", cast(g, [-3]))).toBe(null);
    expect(chooseSurface("floor", cast(g, [0, -3])).point[1]).toBeCloseTo(0.05);
  });
  it("all (stick-all distances): from the point, vertical rays limited to the floor", () => {
    const gs = surfaceSearch("all", 1.5, 2.7);
    expect(gs).toEqual([
      { dirs: HORIZONTAL_DIRS, max: WALL_RANGE, from: 1.5 },
      { dirs: [[0, 1, 0]], max: 1.5, from: 1.5 },
      { dirs: [[0, -1, 0]], max: 1.8, from: 1.5 },
    ]);
    expect(surfaceSearch("wall", 1.5, 2.7)).toEqual([
      { dirs: HORIZONTAL_DIRS, max: WALL_RANGE, from: 1.5 },
    ]);
    expect(surfaceSearch(null, 1.5, 2.7)).toEqual([]);
  });
});

describe("chooseSurface", () => {
  const wallNear = h([1, 1.5, 0], [-1, 0, 0], 1, [1, 0, 0]);
  const wallFar = h([0, 1.5, -2], [0, 0, 1], 2, [0, 0, -1]);
  const ceiling = h([0, 2.6, 0], [0, -1, 0], 1.1, [0, 1, 0]);
  const floor = h([0, 0, 0], [0, 1, 0], 1.5, [0, -1, 0]);
  const slope = h([0.5, 1.5, 0], [-0.7, 0.7, 0], 0.5, [1, 0, 0]); // |n.y| 0.7: not a wall

  it("wall: nearest roughly vertical face, 5 cm off along the normal", () => {
    const s = chooseSurface("wall", [wallFar, slope, wallNear, ceiling]);
    expect(close(s.point, [1 - SURFACE_OFFSET, 1.5, 0])).toBe(true);
    expect(s.normal).toEqual([-1, 0, 0]);
    expect(s.distance).toBe(1);
  });
  it("normals are turned to face the ray origin (back faces, flipped meshes)", () => {
    const s = chooseSurface("wall", [h([1, 1.5, 0], [1, 0, 0], 1, [1, 0, 0])]);
    expect(close(s.point, [0.95, 1.5, 0])).toBe(true);
    expect(s.normal).toEqual([-1, 0, 0]);
  });
  it("ceiling: face looking down, 5 cm below; floor: face looking up, 5 cm above", () => {
    expect(
      close(
        chooseSurface("ceiling", [wallNear, ceiling, floor]).point,
        [0, 2.55, 0],
      ),
    ).toBe(true);
    expect(
      close(
        chooseSurface("floor", [wallNear, ceiling, floor]).point,
        [0, 0.05, 0],
      ),
    ).toBe(true);
  });
  it("a ceiling must be hit by an upward ray, a floor by a downward one", () => {
    expect(
      chooseSurface("ceiling", [h([0, 2.6, 0], [0, -1, 0], 1, [1, 0, 0])]),
    ).toBe(null);
    expect(
      chooseSurface("floor", [h([0, 0, 0], [0, 1, 0], 1, [1, 0, 0])]),
    ).toBe(null);
  });
  it("out of range or no hit -> null (keep the computed point)", () => {
    expect(
      chooseSurface("wall", [h([3, 1.5, 0], [-1, 0, 0], 3, [1, 0, 0])]),
    ).toBe(null);
    expect(
      chooseSurface("ceiling", [h([0, 6, 0], [0, -1, 0], 4.5, [0, 1, 0])]),
    ).toBe(null);
    expect(
      chooseSurface("floor", [h([0, -4, 0], [0, 1, 0], 3.5, [0, -1, 0])]),
    ).toBe(null);
    expect(chooseSurface("wall", [])).toBe(null);
    expect(chooseSurface("wall", null)).toBe(null);
    expect(chooseSurface(null, [wallNear])).toBe(null);
  });
  it("accept() filters candidates (e.g. stay near the room)", () => {
    const s = chooseSurface("wall", [wallNear, wallFar], {
      accept: (p) => p[0] < 0.5,
    });
    expect(close(s.point, [0, 1.5, -2 + SURFACE_OFFSET])).toBe(true);
    expect(chooseSurface("wall", [wallNear], { accept: () => false })).toBe(
      null,
    );
  });
  it("any: the nearest hit of every kind", () => {
    expect(chooseSurface("any", [wallFar, ceiling, wallNear]).normal).toEqual([
      -1, 0, 0,
    ]);
    expect(chooseSurface("any", [floor, ceiling]).normal).toEqual([0, -1, 0]);
  });
  it("accepts {x,y,z} vectors too", () => {
    const s = chooseSurface("floor", [
      {
        point: { x: 1, y: 0, z: 2 },
        normal: { x: 0, y: 1, z: 0 },
        distance: 1,
        dir: { x: 0, y: -1, z: 0 },
      },
    ]);
    expect(close(s.point, [1, 0.05, 2])).toBe(true);
  });
});

describe("plan <-> world, nearPolygon, surfaceKey", () => {
  it("world = (x, elevation + z, -y) and back", () => {
    expect(worldOf({ x: 1, y: 2, z: 1.5 }, 3)).toEqual([1, 4.5, -2]);
    expect(planOf([1, 4.5, -2], 3)).toEqual({ x: 1, y: 2, z: 1.5 });
  });
  it("nearPolygon: inside or within margin of an edge", () => {
    const sq = [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ];
    expect(nearPolygon([2, 1], sq, 0.5)).toBe(true);
    expect(nearPolygon([4.4, 1], sq, 0.5)).toBe(true);
    expect(nearPolygon([4.6, 1], sq, 0.5)).toBe(false);
    expect(nearPolygon([2, 1], null, 0.5)).toBe(true); // no room: no constraint
  });
  it("surfaceKey includes the room", () => {
    expect(surfaceKey("wall", "g", { x: 1, y: 2, z: 1.5 }, "r1")).not.toBe(
      surfaceKey("wall", "g", { x: 1, y: 2, z: 1.5 }, "r2"),
    );
  });
  it("surfaceKey changes with the point, floor and kind", () => {
    const a = surfaceKey("wall", "g", { x: 1, y: 2, z: 1.5 });
    expect(a).toBe(surfaceKey("wall", "g", { x: 1.0000001, y: 2, z: 1.5 }));
    expect(a).not.toBe(surfaceKey("wall", "g", { x: 1.01, y: 2, z: 1.5 }));
    expect(a).not.toBe(surfaceKey("ceiling", "g", { x: 1, y: 2, z: 1.5 }));
    expect(a).not.toBe(surfaceKey("wall", "f", { x: 1, y: 2, z: 1.5 }));
  });
});
