import { describe, it, expect, vi, afterEach } from "bun:test";
import * as THREE from "three";

// the bake: records the probes each grid bakes (three's GPU bake needs a WebGL context)
const baked = [];
vi.mock("three/addons/lighting/LightProbeGridWebGL.js", async () => {
  const real =
    await import("../node_modules/three/examples/jsm/lighting/LightProbeGridWebGL.js");
  class Grid extends real.LightProbeGridWebGL {
    bake(_r, _scene, o) {
      if (!this.texture || this.texture.isFake !== this)
        this.texture = Object.assign(new THREE.Data3DTexture(), {
          isFake: this,
        });
      baked.push([this.spec.storey, o.start, o.count, o.cubemapSize]);
    }
    dispose() {
      this.texture = null;
    }
  }
  return { LightProbeGridWebGL: Grid };
});

const {
  probeRooms,
  probeSpot,
  probeGrids,
  lampKey,
  lampKeys,
  lightStep,
  probeDue,
  probeTargets,
  probeWait,
  probeBegin,
  LightProbes,
  StoreyGrid,
  makeProbeUniforms,
  PROBE_MAX_FLOORS,
  PROBE_THROTTLE_MS,
  PROBE_SPACING_M,
  PROBE_MAX_AXIS,
  PROBE_LAYERS,
  PROBE_INSET_M,
  PROBE_CHUNK,
  PROBE_BUDGET_MS,
  PROBE_CUBE,
} = await import("../src/light-probes.ts");
const { patchCloudShadow, makeCloudUniforms, setTierVariant, tierKey } =
  await import("../src/cloud-shadow.ts");
const { insidePolygon } = await import("../src/lightmap.ts");

const sq = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const room = (id, polygon, floorId = "g", outdoor = false) => ({
  room: { id, polygon, outdoor },
  floorId,
});
const FLOORS = [
  { id: "up", elevation: 3, height: 2.6 },
  { id: "g", elevation: 0, height: 2.7 },
];
const edgeDist = (x, y, poly) => {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j],
      [bx, by] = poly[i],
      dx = bx - ax,
      dy = by - ay,
      t = Math.max(
        0,
        Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)),
      );
    d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return d;
};

describe("probe placement", () => {
  it("probeRooms: indoor rooms on known floors, storeys lowest first", () => {
    const { rooms, storeys } = probeRooms(
      [
        room("a", sq(0, 0, 4, 2)),
        room("b", sq(0, 0, 2, 2), "up"),
        room("t", sq(0, -3, 4, 0), "g", true),
        room("x", sq(0, 0, 1, 1), "nowhere"),
        room("y", [
          [0, 0],
          [1, 0],
        ]),
      ],
      FLOORS,
    );
    expect(storeys).toEqual([
      { y0: 0, y1: 2.7 },
      { y0: 3, y1: 5.6 },
    ]);
    expect(rooms.map((r) => [r.key, r.storey, r.y0, r.y1])).toEqual([
      ["a", 0, 0, 2.7],
      ["b", 1, 3, 5.6],
    ]);
  });
  it("probeRooms: at most PROBE_MAX_FLOORS storeys; none without rooms", () => {
    const floors = Array.from({ length: 6 }, (_, i) => ({
      id: "f" + i,
      elevation: 3 * i,
      height: 2.7,
    }));
    const many = Array.from({ length: 50 }, (_, i) =>
      room("r" + i, sq(i, 0, i + 1, 1), "f" + (i % 6)),
    );
    const { rooms, storeys } = probeRooms(many, floors);
    expect(storeys.length).toBe(PROBE_MAX_FLOORS);
    expect(rooms.every((r) => r.storey < PROBE_MAX_FLOORS)).toBe(true);
    expect(probeRooms(null, null)).toEqual({ rooms: [], storeys: [] });
  });
  it("probeSpot: off the walls into its room; in a wall's thickness into the nearest room; outdoors unmoved", () => {
    const A = sq(0, 0, 4, 3),
      B = sq(4, 0, 6, 3),
      polys = [A, B];
    expect(probeSpot(2, 1.5, polys)).toEqual([2, 1.5]); // the middle of a room
    const [x, y] = probeSpot(3.95, 1.5, polys); // beside the shared wall
    expect(x).toBeCloseTo(4 - PROBE_INSET_M);
    expect(y).toBeCloseTo(1.5);
    const c = probeSpot(0.05, 0.05, polys); // a corner: off both walls
    expect(c[0]).toBeCloseTo(PROBE_INSET_M);
    expect(c[1]).toBeCloseTo(PROBE_INSET_M);
    const w = probeSpot(6.05, 1.5, polys); // in the outer wall
    expect(insidePolygon(w[0], w[1], B)).toBe(true);
    expect(edgeDist(w[0], w[1], B)).toBeCloseTo(PROBE_INSET_M);
    expect(probeSpot(8, 1.5, polys)).toEqual([8, 1.5]); // outdoors
    // an L-shaped room's elbow: the spot ends inside, away from both walls
    const L = [
      [0, 0],
      [3, 0],
      [3, 1],
      [1, 1],
      [1, 3],
      [0, 3],
    ];
    const e = probeSpot(1.02, 1.02, [L]);
    expect(insidePolygon(e[0], e[1], L)).toBe(true);
    expect(edgeDist(e[0], e[1], L)).toBeGreaterThan(PROBE_INSET_M - 1e-6);
  });
  it("probeGrids: a grid per storey over its indoor rooms' box, floor to ceiling, a probe every PROBE_SPACING_M", () => {
    const { rooms, storeys } = probeRooms(
      [
        room("a", sq(0, 0, 4, 2)),
        room("b", sq(4, 0, 6, 2)),
        room("c", sq(0, 0, 2, 2), "up"),
      ],
      FLOORS,
    );
    const [g, u] = probeGrids(rooms, storeys);
    expect(g.storey).toBe(0);
    expect(g.center[0]).toBeCloseTo(3);
    expect(g.center[1]).toBeCloseTo(1.35);
    expect(g.center[2]).toBeCloseTo(-1); // world z = -plan y
    expect(g.size[0]).toBeCloseTo(6);
    expect(g.size[1]).toBeCloseTo(2.74);
    expect(g.size[2]).toBeCloseTo(2);
    expect(g.res).toEqual([
      Math.round(6 / PROBE_SPACING_M),
      PROBE_LAYERS,
      Math.round(2 / PROBE_SPACING_M),
    ]);
    expect(g.spots.length).toBe(g.res[0] * g.res[2]);
    // every spot in a room, off its walls; row 0 at the north (max plan y)
    for (const [x, y] of g.spots) {
      const p = [sq(0, 0, 4, 2), sq(4, 0, 6, 2)].find((q) =>
        insidePolygon(x, y, q),
      );
      expect(!!p).toBe(true);
      expect(edgeDist(x, y, p)).toBeGreaterThan(PROBE_INSET_M - 1e-6);
    }
    expect(g.spots[0][1]).toBeGreaterThan(1);
    expect(u.storey).toBe(1);
    expect(u.center[1]).toBeCloseTo(4.3);
    // skipped (baked) storeys and huge plans
    expect(
      probeGrids(rooms, storeys, new Set([0])).map((s) => s.storey),
    ).toEqual([1]);
    const big = probeRooms([room("h", sq(0, 0, 80, 4))], FLOORS);
    expect(probeGrids(big.rooms, big.storeys)[0].res[0]).toBe(PROBE_MAX_AXIS);
    expect(probeGrids([], [])).toEqual([]);
  });
  it("StoreyGrid: the bounds of three's grid from the spec, probes captured at their spots", () => {
    const { rooms, storeys } = probeRooms([room("a", sq(0, 0, 4, 2))], FLOORS);
    const spec = probeGrids(rooms, storeys)[0],
      g = new StoreyGrid(spec);
    expect(g.isLightProbeGrid).toBe(true);
    expect(g.boundingBox.min.toArray().map((v) => +v.toFixed(3))).toEqual([
      0, -0.02, -2,
    ]);
    expect(g.boundingBox.max.toArray().map((v) => +v.toFixed(3))).toEqual([
      4, 2.72, 0,
    ]);
    const p = g.getProbePosition(0, 0, 0, new THREE.Vector3());
    expect(p.x).toBeCloseTo(spec.spots[0][0]);
    expect(p.z).toBeCloseTo(-spec.spots[0][1]);
    expect(p.y).toBeCloseTo(-0.02 + 2.74 / PROBE_LAYERS / 2);
  });
});

describe("probe rebuild triggers", () => {
  const inputs = (o = {}) => ({
    rooms: "R",
    sky: 1,
    lamps: ["", "", ""],
    light: "0",
    ...o,
  });
  it("probeDue: rooms first, then sky, lamps, light levels; nothing when unchanged", () => {
    expect(probeDue(null, inputs())).toBe("rooms");
    expect(probeDue(inputs(), inputs())).toBe(null);
    expect(probeDue(inputs(), inputs({ rooms: "R2", sky: 2 }))).toBe("rooms");
    expect(probeDue(inputs(), inputs({ sky: 2, lamps: ["x", "", ""] }))).toBe(
      "sky",
    );
    expect(probeDue(inputs(), inputs({ lamps: ["", "x", ""] }))).toBe("lamps");
    expect(probeDue(inputs(), inputs({ light: "1" }))).toBe("light");
  });
  it("probeTargets: every grid, only the storeys whose lamps changed, every grid for a lamp outside them", () => {
    expect(probeTargets(null, inputs(), 2)).toEqual([0, 1]);
    expect(probeTargets(inputs(), inputs({ sky: 2 }), 2)).toEqual([0, 1]);
    expect(probeTargets(inputs(), inputs({ lamps: ["", "x", ""] }), 2)).toEqual(
      [1],
    );
    expect(probeTargets(inputs(), inputs({ lamps: ["", "", "x"] }), 2)).toEqual(
      [0, 1],
    );
    expect(probeTargets(inputs(), inputs({ lamps: ["x", ""] }), 2)).toEqual([
      0, 1,
    ]); // other grids
  });
  it("probeWait: rooms and sky at once, lamps and light levels throttled", () => {
    expect(probeWait("rooms", 1000, 1100)).toBe(0);
    expect(probeWait("sky", 1000, 1100)).toBe(0);
    expect(probeWait("lamps", 1000, 1500)).toBe(PROBE_THROTTLE_MS - 500);
    expect(probeWait("light", 1000, 1000 + PROBE_THROTTLE_MS + 1)).toBe(0);
  });
  it("lightStep / lampKey / lampKeys: 10 % steps, lamps that are off or hidden do not count, per storey", () => {
    expect(lightStep(1)).toBe(0);
    expect(lightStep(1.04)).toBe(0);
    expect(lightStep(1.1)).toBe(1);
    expect(lightStep(0)).toBe(lightStep(0.00001));
    const L = (i, x = 0, visible = true, y = 0) =>
      Object.assign(new THREE.PointLight(0xffaa00, i), { visible })
        .translateX(x)
        .translateY(y);
    expect(lampKey([L(0), L(2, 0, false)])).toBe("");
    expect(lampKey([L(2.2)])).toBe(lampKey([L(2.24)])); // within a step
    expect(lampKey([L(2)])).not.toBe(lampKey([L(3)]));
    expect(lampKey([L(2)])).not.toBe(lampKey([L(2, 1)])); // moved (a pool light reassigned)
    const k = lampKeys(
      [L(2, 0, true, 1), L(2, 0, true, 4), L(2, 0, true, 9)],
      [
        [0, 2.7],
        [3, 5.6],
      ],
    );
    expect(k).toEqual([
      lampKey([L(2, 0, true, 1)]),
      lampKey([L(2, 0, true, 4)]),
      lampKey([L(2, 0, true, 9)]),
    ]);
  });
});

describe("LightProbes passes", () => {
  let probes;
  afterEach(() => {
    if (probes) probes.dispose();
    probes = null;
    baked.length = 0;
  });
  const setup = () => {
    const { rooms, storeys } = probeRooms(
      [
        room("a", sq(0, 0, 4, 2)),
        room("b", sq(4, 0, 6, 2)),
        room("c", sq(0, 0, 2, 2), "up"),
      ],
      FLOORS,
    );
    return { rooms, storeys, skip: new Set() };
  };
  const capture = (bake) => bake({});
  const inputs = (o = {}) => ({
    rooms: "R",
    sky: 1,
    lamps: ["", "", ""],
    light: "0",
    ...o,
  });
  // a clock that advances PROBE_BUDGET_MS / 2 a call: two chunks a step
  const ticking = () => {
    let t = 0;
    return () => (t += PROBE_BUDGET_MS / 2);
  };
  const total = () => probes.size;

  it("grids black until the first pass, baked in chunks over frames, swapped in at the end; nothing while idle", () => {
    const due = vi.fn(),
      U = makeProbeUniforms();
    probes = new LightProbes(null, U, due);
    probes.setRooms(setup());
    expect(probes.live.length).toBe(2);
    expect(probes.group.children).toEqual(probes.live);
    expect(
      probes.live.every((g) => g.texture && g.texture.image.width === 1),
    ).toBe(true); // black, counted by three
    expect(U.fpProbeOn.value).toBe(0);
    expect(probes.request(inputs(), 0)).toBe("rooms");
    const live0 = [...probes.live];
    let n = 0,
      steps = 0;
    while (probes.active || !n) {
      const b = probes.step(capture, 0, ticking());
      if (!b) break;
      n += b;
      steps++;
      expect(b).toBeLessThanOrEqual(2 * PROBE_CHUNK);
      if (probes.active) expect(U.fpProbeOn.value).toBe(0);
    }
    expect(n).toBe(total());
    expect(steps).toBeGreaterThan(1);
    expect(probes.stats).toEqual({ captures: total(), passes: 1 });
    expect(U.fpProbeOn.value).toBe(1);
    expect(probes.live.every((g, i) => g !== live0[i])).toBe(true);
    expect(probes.group.children.length).toBe(2);
    expect(baked.every((b) => b[3] === PROBE_CUBE)).toBe(true);
    expect(due).toHaveBeenCalled();
    // idle: same inputs, nothing baked
    expect(probes.request(inputs(), 10)).toBe(null);
    expect(probes.step(capture, 10)).toBe(0);
    expect(probes.stats.captures).toBe(total());
  });
  it("the live grids are black and the swap off while a pass captures (one bounce)", () => {
    const U = makeProbeUniforms();
    probes = new LightProbes(null, U, () => {});
    probes.setRooms(setup());
    probes.request(inputs(), 0);
    while (probes.step(capture, 0)) {} // first pass
    const tex = probes.live.map((g) => g.texture);
    probes.request(inputs({ sky: 2 }), 1);
    let seen = null;
    probes.step(
      (bake) => {
        seen = [
          U.fpProbeOn.value,
          probes.live.map((g) => g.texture.image.width),
        ];
        bake({});
      },
      1,
      ticking(),
    );
    expect(seen).toEqual([0, [1, 1]]);
    expect(probes.active).toBe(true);
    expect(probes.live.every((g, i) => g.texture === tex[i])).toBe(true);
    expect(U.fpProbeOn.value).toBe(1);
  });
  it("lamp changes wait for the throttle and rebake their storey only; the sky rebuilds every grid at once", () => {
    probes = new LightProbes(null, makeProbeUniforms(), () => {});
    probes.setRooms(setup());
    probes.request(inputs(), 0);
    while (probes.step(capture, 0)) {}
    const [g0, g1] = probes.live,
      size1 = g1.resolution.x * g1.resolution.y * g1.resolution.z;
    expect(probes.request(inputs({ lamps: ["", "on", ""] }), 500)).toBe(
      "lamps",
    );
    expect(probes.step(capture, 600)).toBe(0); // throttled
    baked.length = 0;
    let n = 0;
    for (let b; (b = probes.step(capture, PROBE_THROTTLE_MS + 1));) n += b;
    expect(n).toBe(size1);
    expect(baked.every((b) => b[0] === 1)).toBe(true);
    expect(probes.live[0]).toBe(g0); // the ground floor's grid kept
    expect(probes.live[1]).not.toBe(g1);
    expect(probes.stats.passes).toBe(2);
    expect(
      probes.request(
        inputs({ lamps: ["", "on", ""], sky: 2 }),
        PROBE_THROTTLE_MS + 3,
      ),
    ).toBe("sky");
    baked.length = 0;
    expect(probes.step(capture, PROBE_THROTTLE_MS + 3)).toBeGreaterThan(0); // at once
    expect(baked[0][0]).toBe(0);
  });
  it("a change during a pass makes one more pass after it; new rooms drop the pass and the bake", () => {
    probes = new LightProbes(null, makeProbeUniforms(), () => {});
    probes.setRooms(setup());
    probes.request(inputs(), 0);
    probes.step(capture, 0, ticking());
    expect(probes.active).toBe(true);
    expect(probes.request(inputs({ sky: 2 }), 1)).toBe("sky");
    while (probes.stats.passes < 1) probes.step(capture, 1, ticking());
    expect(probes.active).toBe(true); // the sky change is due
    probes.step(capture, 3, ticking());
    const old = probes.live[0];
    probes.setRooms(setup()); // aborted
    expect(probes.active).toBe(false);
    expect(probes.live[0]).not.toBe(old);
    expect(old.parent).toBe(null);
    expect(probes.stats.passes).toBe(1);
    expect(probes.uniforms.fpProbeOn.value).toBe(0);
  });
  it("a storey without a grid (skipped) and no rooms at all: nothing baked", () => {
    probes = new LightProbes(null, makeProbeUniforms(), () => {});
    probes.setRooms({ ...setup(), skip: new Set([0, 1]) });
    expect(probes.live).toEqual([]);
    probes.request(inputs({ lamps: [""] }), 0);
    expect(probes.step(capture, 0)).toBe(0);
    expect(probes.stats).toEqual({ captures: 0, passes: 1 });
  });
});

describe("probe shader variant", () => {
  const compile = (m) => {
    const sh = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    };
    m.onBeforeCompile(sh, null);
    return sh;
  };
  it("probeBegin: three's grid irradiance kept apart, none under a lightmap; null when three changed the chunk", () => {
    const b = probeBegin(THREE.ShaderChunk.lights_fragment_begin);
    expect(b).toContain(
      "#if NUM_LIGHT_PROBE_GRIDS > 0 && ! defined( USE_LIGHTMAP )",
    );
    expect(b).toContain("fpGridE = getLightProbeGridIrradiance(");
    expect(b).not.toContain("irradiance += getLightProbeGridIrradiance(");
    expect(b.indexOf("vec3 fpGridE")).toBeLessThan(b.indexOf("fpGridE ="));
    expect(probeBegin("void main() {}")).toBe(null);
  });
  it("standard: no probe code, cache key as before", () => {
    const m = new THREE.MeshStandardMaterial();
    patchCloudShadow(m, makeCloudUniforms());
    const key = m.customProgramCacheKey();
    expect(setTierVariant(m, { contact: false, probe: false })).toBe(false);
    expect(m.customProgramCacheKey()).toBe(key);
    const fs = compile(m).fragmentShader;
    expect(fs).not.toContain("fpProbe");
    expect(fs).toContain("irradiance += getLightProbeGridIrradiance("); // three's own
  });
  it("high: the grid in place of the sky's diffuse fill after the IBL, own cache key", () => {
    const m = new THREE.MeshStandardMaterial(),
      U = makeCloudUniforms();
    patchCloudShadow(m, U);
    const key = m.customProgramCacheKey();
    expect(setTierVariant(m, { contact: false, probe: true })).toBe(true);
    expect(tierKey(m)).toBe("l");
    expect(m.customProgramCacheKey()).toBe(`${key}l`);
    const fs = compile(m).fragmentShader;
    expect(fs.indexOf("uniform float fpProbeOn;")).toBeGreaterThan(
      fs.indexOf("#include <lights_pars_begin>"),
    );
    expect(fs).toContain("fpGridE = getLightProbeGridIrradiance(");
    expect(fs).toMatch(
      /#include <lights_fragment_maps>\s*#if defined\( RE_IndirectDiffuse \) && defined\( STANDARD \)/,
    );
    expect(fs).toContain("if ( probeGrid >= 0 && fpProbeOn > 0.0 ) {");
    expect(compile(m).uniforms.fpProbeOn).toBe(U.fpProbeOn);
    expect(setTierVariant(m, { contact: false, probe: false })).toBe(true);
    expect(m.customProgramCacheKey()).toBe(key);
  });
  it("Lambert / Phong materials (no sky environment) get no probe", () => {
    const m = new THREE.MeshLambertMaterial();
    patchCloudShadow(m, makeCloudUniforms());
    expect(setTierVariant(m, { contact: false, probe: true })).toBe(false);
    expect(tierKey(m)).toBe("");
  });
});
