import { describe, it, expect, vi, afterEach } from "bun:test";
import * as THREE from "three";

// the read-back: SH coefficient 0 = the capture's position x (each room tells its own probe), the rest 0
vi.mock("three/addons/lights/LightProbeGenerator.js", () => ({
  LightProbeGenerator: {
    fromCubeRenderTarget: vi.fn(async (_r, cube) => {
      const sh = new THREE.SphericalHarmonics3();
      sh.coefficients[0].set(cube.__x, 1, 2);
      return new THREE.LightProbe(sh);
    }),
  },
}));

const {
  probePoint,
  probeRooms,
  probeFrame,
  probeTile,
  roomIdGrid,
  roomOpenness,
  lampKey,
  lightStep,
  probeDue,
  probeWait,
  LightProbes,
  makeProbeUniforms,
  PROBE_MAX,
  PROBE_MAX_FLOORS,
  PROBE_THROTTLE_MS,
  PROBE_TEXEL_M,
  PROBE_MAP_MAX,
  PROBE_MARGIN_M,
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

describe("probe placement", () => {
  it("probePoint: the centroid of a convex room", () => {
    const [x, y] = probePoint(sq(0, 0, 4, 2));
    expect(x).toBeCloseTo(2);
    expect(y).toBeCloseTo(1);
  });
  it("probePoint: inside an L-shaped room and away from its walls (the centroid lies at the elbow)", () => {
    const L = [
      [0, 0],
      [6, 0],
      [6, 1],
      [1, 1],
      [1, 6],
      [0, 6],
    ]; // thin L: centroid outside
    const p = probePoint(L);
    expect(insidePolygon(p[0], p[1], L)).toBe(true);
    const C = [
      [0, 0],
      [5, 0],
      [5, 5],
      [3, 5],
      [3, 1],
      [0, 1],
    ]; // centroid inside but near walls
    const q = probePoint(C);
    expect(insidePolygon(q[0], q[1], C)).toBe(true);
  });
  it("probeRooms: indoor rooms on known floors, storeys lowest first, half the storey height, plan -> world", () => {
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
    expect(rooms.map((r) => [r.key, r.storey])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
    expect(rooms[0].point[0]).toBeCloseTo(2);
    expect(rooms[0].point[1]).toBeCloseTo(1.35);
    expect(rooms[0].point[2]).toBeCloseTo(-1); // world z = -plan y
    expect(rooms[1].point[1]).toBeCloseTo(4.3);
  });
  it("probeRooms: at most PROBE_MAX rooms on PROBE_MAX_FLOORS storeys; none without rooms", () => {
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
    expect(rooms.length).toBe(PROBE_MAX);
    expect(rooms.every((r) => r.storey < PROBE_MAX_FLOORS)).toBe(true);
    expect(probeRooms(null, null)).toEqual({ rooms: [], storeys: [] });
  });
  it("room map: frame with a margin, 10 cm texels up to PROBE_MAP_MAX", () => {
    const { rooms } = probeRooms(
      [room("a", sq(0, 0, 4, 2)), room("b", sq(4, 0, 6, 2))],
      FLOORS,
    );
    const f = probeFrame(rooms);
    expect(f).toEqual({
      minX: -PROBE_MARGIN_M,
      minZ: -2 - PROBE_MARGIN_M,
      sizeX: 6 + 2 * PROBE_MARGIN_M,
      sizeZ: 2 + 2 * PROBE_MARGIN_M,
    });
    expect(probeTile(f)).toEqual({
      w: Math.ceil(f.sizeX / PROBE_TEXEL_M),
      h: Math.ceil(f.sizeZ / PROBE_TEXEL_M),
    });
    const big = probeTile({ minX: 0, minZ: 0, sizeX: 80, sizeZ: 40 });
    expect(big.w).toBe(PROBE_MAP_MAX);
    expect(big.h).toBe(PROBE_MAP_MAX / 2);
    expect(probeFrame([])).toBe(null);
  });
  it("roomIdGrid: index + 1 under each room, 0 outside and for skipped (baked) rooms, storeys side by side", () => {
    const { rooms, storeys } = probeRooms(
      [
        room("a", sq(0, 0, 4, 2)),
        room("b", sq(4, 0, 6, 2)),
        room("c", sq(0, 0, 2, 2), "up"),
      ],
      FLOORS,
    );
    const f = probeFrame(rooms),
      t = probeTile(f),
      W = t.w * storeys.length;
    const at = (s, x, y) => {
      const i = Math.floor(((x - f.minX) / f.sizeX) * t.w),
        j = Math.floor(((-y - f.minZ) / f.sizeZ) * t.h);
      return j * W + s * t.w + i;
    };
    const g = roomIdGrid(rooms, storeys.length, f, t);
    expect(g.length).toBe(W * t.h);
    expect(g[at(0, 1, 1)]).toBe(1);
    expect(g[at(0, 5, 1.5)]).toBe(2);
    expect(g[at(1, 1, 1)]).toBe(3);
    expect(g[at(1, 5, 1)]).toBe(0); // nothing upstairs there
    expect(g[at(0, -0.2, 1)]).toBe(0); // in the margin
    const skipped = roomIdGrid(rooms, storeys.length, f, t, new Set([1]));
    expect(skipped[at(0, 5, 1.5)]).toBe(0);
    expect(skipped[at(0, 1, 1)]).toBe(1);
  });
  it("roomOpenness: open in the middle, about half beside a wall, about a quarter in a corner", () => {
    const { rooms, storeys } = probeRooms([room("a", sq(0, 0, 6, 6))], FLOORS);
    const f = probeFrame(rooms),
      t = probeTile(f),
      ids = roomIdGrid(rooms, 1, f, t),
      open = roomOpenness(rooms, 1, f, t, ids);
    const at = (x, y) => {
      const i = Math.floor(((x - f.minX) / f.sizeX) * t.w),
        j = Math.floor(((-y - f.minZ) / f.sizeZ) * t.h);
      return j * t.w + i;
    };
    expect(open[at(3, 3)]).toBeCloseTo(1);
    expect(open[at(3, 0.05)]).toBeGreaterThan(0.4);
    expect(open[at(3, 0.05)]).toBeLessThan(0.65);
    expect(open[at(0.05, 0.05)]).toBeLessThan(open[at(3, 0.05)]);
    expect(open[at(0.05, 0.05)]).toBeLessThan(0.4);
    expect(open[at(-0.2, 3)]).toBe(0); // outside: unused
    expect(storeys.length).toBe(1);
  });
});

describe("probe rebuild triggers", () => {
  const inputs = (o = {}) => ({
    rooms: "R",
    sky: 1,
    lamps: "",
    light: "0",
    ...o,
  });
  it("probeDue: rooms first, then sky, lamps, light levels; nothing when unchanged", () => {
    expect(probeDue(null, inputs())).toBe("rooms");
    expect(probeDue(inputs(), inputs())).toBe(null);
    expect(probeDue(inputs(), inputs({ rooms: "R2", sky: 2 }))).toBe("rooms");
    expect(probeDue(inputs(), inputs({ sky: 2, lamps: "x" }))).toBe("sky");
    expect(probeDue(inputs(), inputs({ lamps: "x" }))).toBe("lamps");
    expect(probeDue(inputs(), inputs({ light: "1" }))).toBe("light");
  });
  it("probeWait: rooms and sky at once, lamps and light levels throttled", () => {
    expect(probeWait("rooms", 1000, 1100)).toBe(0);
    expect(probeWait("sky", 1000, 1100)).toBe(0);
    expect(probeWait("lamps", 1000, 1500)).toBe(PROBE_THROTTLE_MS - 500);
    expect(probeWait("light", 1000, 1000 + PROBE_THROTTLE_MS + 1)).toBe(0);
  });
  it("lightStep / lampKey: 10 % steps, lamps that are off or hidden do not count", () => {
    expect(lightStep(1)).toBe(0);
    expect(lightStep(1.04)).toBe(0);
    expect(lightStep(1.1)).toBe(1);
    expect(lightStep(0)).toBe(lightStep(0.00001));
    const L = (i, x = 0, visible = true) =>
      Object.assign(new THREE.PointLight(0xffaa00, i), { visible }).translateX(
        x,
      );
    expect(lampKey([L(0), L(2, 0, false)])).toBe("");
    expect(lampKey([L(2.2)])).toBe(lampKey([L(2.24)])); // within a step
    expect(lampKey([L(2)])).not.toBe(lampKey([L(3)]));
    expect(lampKey([L(2)])).not.toBe(lampKey([L(2, 1)])); // moved (a pool light reassigned)
  });
});

describe("LightProbes passes", () => {
  const renderer = { capabilities: { textureTypeReadable: () => true } };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  let probes;
  afterEach(() => {
    if (probes) probes.dispose();
    probes = null;
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
  const capture = (cam) => {
    probes._cube.__x = cam.position.x;
  };
  const inputs = (o = {}) => ({
    rooms: "R",
    sky: 1,
    lamps: "",
    light: "0",
    ...o,
  });

  it("one room a frame, swapped in at the end; nothing while idle", async () => {
    const due = vi.fn(),
      U = makeProbeUniforms();
    probes = new LightProbes(renderer, U, due);
    probes.setRooms(setup());
    expect(U.fpProbe.value.toArray().slice(0, 3)).toEqual([
      2,
      probes._tile.w,
      0,
    ]); // storeys, tile, off until the first pass
    expect(probes.request(inputs(), 0)).toBe("rooms");
    expect(probes.step(capture, 0)).toBe(true);
    expect(probes.step(capture, 0)).toBe(false); // the read-back runs
    await flush();
    expect(U.fpProbe.value.z).toBe(0); // not yet: one room of three
    expect(probes.step(capture, 1)).toBe(true);
    await flush();
    expect(probes.step(capture, 2)).toBe(true);
    await flush();
    expect(probes.stats).toEqual({ captures: 3, passes: 1 });
    expect(U.fpProbe.value.z).toBe(1);
    expect(due).toHaveBeenCalled();
    // the coefficients of room k sit in row tile.h + k
    const t = probes._tex,
      W = t.image.width,
      row = (k) =>
        THREE.DataUtils.fromHalfFloat(
          t.image.data[(probes._tile.h + k) * W * 4],
        );
    expect(row(0)).toBeCloseTo(2, 2);
    expect(row(1)).toBeCloseTo(5, 2);
    expect(row(2)).toBeCloseTo(1, 2);
    // idle: same inputs, no capture
    expect(probes.request(inputs(), 10)).toBe(null);
    expect(probes.step(capture, 10)).toBe(false);
    expect(probes.stats.captures).toBe(3);
  });
  it("lamp changes wait for the throttle; the sky rebuilds at once; skipped rooms are not captured", async () => {
    probes = new LightProbes(renderer, makeProbeUniforms(), () => {});
    const s = setup();
    probes.setRooms({ ...s, skip: new Set([1]) });
    probes.request(inputs(), 0);
    for (let i = 0; i < 3; i++) {
      probes.step(capture, 0);
      await flush();
    }
    expect(probes.stats).toEqual({ captures: 2, passes: 1 }); // the baked room b skipped
    expect(probes.request(inputs({ lamps: "on" }), 500)).toBe("lamps");
    expect(probes.step(capture, 600)).toBe(false); // throttled
    expect(probes.step(capture, PROBE_THROTTLE_MS + 1)).toBe(true);
    await flush();
    probes.step(capture, PROBE_THROTTLE_MS + 2);
    await flush();
    expect(probes.stats).toEqual({ captures: 4, passes: 2 });
    expect(
      probes.request(inputs({ lamps: "on", sky: 2 }), PROBE_THROTTLE_MS + 3),
    ).toBe("sky");
    expect(probes.step(capture, PROBE_THROTTLE_MS + 3)).toBe(true); // at once
  });
  it("a change during a pass makes one more pass after it; new rooms drop the pass", async () => {
    probes = new LightProbes(renderer, makeProbeUniforms(), () => {});
    probes.setRooms(setup());
    probes.request(inputs(), 0);
    probes.step(capture, 0);
    await flush();
    expect(probes.request(inputs({ sky: 2 }), 1)).toBe("sky");
    probes.step(capture, 1);
    await flush();
    probes.step(capture, 2);
    await flush();
    expect(probes.stats.passes).toBe(1);
    expect(probes.active).toBe(true); // the sky change is due
    probes.step(capture, 3);
    probes.setRooms(setup()); // aborted: its read-back is ignored
    await flush();
    expect(probes.stats.passes).toBe(1);
    expect(probes.uniforms.fpProbe.value.z).toBe(0);
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
  it("standard: no probe lookup, cache key as before", () => {
    const m = new THREE.MeshStandardMaterial();
    patchCloudShadow(m, makeCloudUniforms());
    const key = m.customProgramCacheKey();
    expect(
      setTierVariant(m, { pcss: false, contact: false, probe: false }),
    ).toBe(false);
    expect(m.customProgramCacheKey()).toBe(key);
    expect(compile(m).fragmentShader).not.toContain("fpProbe");
  });
  it("high: the room lookup after three's light functions, the irradiance swap after the IBL, own cache key", () => {
    const m = new THREE.MeshStandardMaterial(),
      U = makeCloudUniforms();
    patchCloudShadow(m, U);
    const key = m.customProgramCacheKey();
    expect(
      setTierVariant(m, { pcss: false, contact: false, probe: true }),
    ).toBe(true);
    expect(tierKey(m)).toBe("l");
    expect(m.customProgramCacheKey()).toBe(`${key}l`);
    const fs = compile(m).fragmentShader;
    expect(fs.indexOf("int fpProbeRoom(")).toBeGreaterThan(
      fs.indexOf("#include <lights_pars_begin>"),
    );
    expect(fs).toMatch(
      /#include <lights_fragment_maps>\s*#if defined\( RE_IndirectDiffuse \) && defined\( STANDARD \)/,
    );
    expect(fs).toContain(
      "iblIrradiance = mix( iblIrradiance, fpE, fpProbe.z );",
    );
    expect(compile(m).uniforms.fpProbeMap).toBe(U.fpProbeMap);
    expect(
      setTierVariant(m, { pcss: false, contact: false, probe: false }),
    ).toBe(true);
    expect(m.customProgramCacheKey()).toBe(key);
  });
  it("Lambert / Phong materials (no sky environment) get no probe", () => {
    const m = new THREE.MeshLambertMaterial();
    patchCloudShadow(m, makeCloudUniforms());
    expect(
      setTierVariant(m, { pcss: false, contact: false, probe: true }),
    ).toBe(false);
    expect(tierKey(m)).toBe("");
  });
});
