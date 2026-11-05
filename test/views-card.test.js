import { describe, it, expect } from "bun:test";
import {
  nodeIndex,
  resolveVisibility,
  levelOrders,
  isOverview,
  floorLevels,
  deviceState,
  defaultViewId,
  viewCut,
} from "../src/views.ts";
import { buildManifest } from "../src/manifest.ts";
import { tree, fp } from "./helpers/manifest.js";

const sq = [
  [0, 0],
  [4, 0],
  [4, 3],
];
const ground = {
  name: "ground",
  extras: fp({ kind: "level", id: "ground", role: "storey", order: 0 }),
  children: [
    {
      name: "kitchen",
      extras: fp({ kind: "room", id: "kitchen", outline: sq }),
    },
  ],
};
const attic = {
  name: "attic",
  extras: fp({ kind: "level", id: "attic", role: "storey", order: 1 }),
};
const ext = {
  name: "exterior",
  extras: fp({ kind: "level", id: "exterior", role: "exterior" }),
};
const roof = {
  name: "roof",
  extras: fp({ kind: "level", id: "roof", role: "roof" }),
};
const adapter = tree([ground, attic, ext, roof]);
const manifest = buildManifest(adapter);
const idx = nodeIndex(adapter, manifest);
const levels = [
  { id: "attic", role: "storey", order: 1 },
  { id: "ground", role: "storey", order: 0 },
  { id: "exterior", role: "exterior" },
  { id: "roof", role: "roof" },
];

describe("levelOrders / floorLevels", () => {
  it("orders storeys bottom-up and skips other roles", () => {
    expect(levelOrders(levels)).toEqual({ ground: 0, attic: 1 });
  });
  it("maps an HA floor to its lowest storey level", () => {
    const order = { ground: 0, attic: 1 };
    expect(
      floorLevels({ ground: "f0", attic: "f0", exterior: "f0" }, order),
    ).toEqual({ f0: "ground" });
    expect(
      floorLevels({ ground: "f0", attic: "f1", exterior: null }, order),
    ).toEqual({ f0: "ground", f1: "attic" });
  });
});

describe("isOverview", () => {
  it("is true only when every storey level and the roof are visible", () => {
    expect(
      isOverview(
        idx,
        resolveVisibility(idx, [{ hide: "role:roof" }]),
        manifest.levels,
      ),
    ).toBe(false);
    expect(isOverview(idx, resolveVisibility(idx, []), manifest.levels)).toBe(
      true,
    );
    expect(
      isOverview(
        idx,
        resolveVisibility(idx, [{ hide: "level:attic" }]),
        manifest.levels,
      ),
    ).toBe(false);
    expect(
      isOverview(
        idx,
        resolveVisibility(idx, [{ hide: "level:exterior" }]),
        manifest.levels,
      ),
    ).toBe(true);
  });
});

describe("deviceState", () => {
  const base = {
    levelOrder: { ground: 0, attic: 1 },
    primaryOrder: 1,
    visibleRooms: new Set(["kitchen", "bed", "lawn"]),
    viewFloors: new Set(["f1"]),
  };
  it("overview: shows what markerState shows, never faded", () => {
    const ctx = { ...base, overview: true };
    expect(
      deviceState(
        { roomId: "kitchen", roomLevelId: "ground", markerFloorId: "f0" },
        ctx,
      ),
    ).toEqual({ shown: true, faded: false });
    expect(
      deviceState(
        { roomId: null, markerFloorId: "f0", floorLevelId: "ground" },
        ctx,
      ),
    ).toEqual({ shown: true, faded: false });
  });
  it("storey view: devices below the primary storey are hidden", () => {
    const ctx = { ...base, overview: false };
    expect(
      deviceState(
        { roomId: "kitchen", roomLevelId: "ground", markerFloorId: "f0" },
        ctx,
      ),
    ).toEqual({ shown: false, faded: false });
    expect(
      deviceState(
        { roomId: "bed", roomLevelId: "attic", markerFloorId: "f1" },
        ctx,
      ),
    ).toEqual({ shown: true, faded: false });
  });
  it("storey view: exterior devices stay shown", () => {
    const ctx = { ...base, overview: false };
    expect(
      deviceState(
        { roomId: "lawn", roomLevelId: "exterior", markerFloorId: "f0" },
        ctx,
      ),
    ).toEqual({ shown: true, faded: false });
  });
  it("roomless markers use the level of their HA floor", () => {
    const ctx = { ...base, overview: false, viewFloors: new Set(["f0", "f1"]) };
    expect(
      deviceState(
        { roomId: null, markerFloorId: "f0", floorLevelId: "ground" },
        ctx,
      ),
    ).toEqual({ shown: false, faded: false });
    expect(
      deviceState(
        { roomId: null, markerFloorId: "f1", floorLevelId: "attic" },
        ctx,
      ),
    ).toEqual({ shown: true, faded: false });
    expect(
      deviceState(
        { roomId: null, markerFloorId: "f0", floorLevelId: undefined },
        ctx,
      ),
    ).toEqual({ shown: true, faded: false });
    expect(
      deviceState(
        { roomId: null, markerFloorId: "f2", floorLevelId: undefined },
        ctx,
      ),
    ).toEqual({ shown: false, faded: false });
  });
});

describe("defaultViewId", () => {
  const views = [
    { id: "level0" },
    { id: "level1" },
    { id: "secret", hidden: true },
    { id: "all" },
  ];
  const floorsOf = (v) =>
    ({ level0: ["ground"], level1: ["first"], all: ["ground", "first"] })[
      v.id
    ] || [];
  it("view_id, then floor as view id, then floor linked to a view, then fallback, then first", () => {
    expect(
      defaultViewId(views, { viewId: "level1", floor: "all" }, floorsOf),
    ).toBe("level1");
    expect(
      defaultViewId(views, { viewId: "secret", floor: "all" }, floorsOf),
    ).toBe("all");
    expect(defaultViewId(views, { floor: "first" }, floorsOf)).toBe("level1");
    expect(defaultViewId(views, { fallback: "level1" }, floorsOf)).toBe(
      "level1",
    );
    expect(defaultViewId(views, {}, floorsOf)).toBe("level0");
    expect(defaultViewId([{ id: "x", hidden: true }], {}, floorsOf)).toBe(null);
  });
});

describe("viewCut", () => {
  it("cuts untagged models at the top of the highest linked storey (elevation + storey height)", () => {
    expect(
      viewCut(
        { id: "ground", cut: null },
        {
          tagged: false,
          floors: [
            { elevation: 0, height: 3 },
            { elevation: 3, height: 2.6 },
          ],
        },
      ),
    ).toBeCloseTo(5.6);
    expect(
      viewCut(
        { id: "ground", cut: null },
        { tagged: false, floors: [{ elevation: 0, height: 2.7 }] },
      ),
    ).toBeCloseTo(2.7);
    expect(
      viewCut(
        { id: "ground", cut: null },
        { tagged: false, floors: [{ elevation: 0 }] },
      ),
    ).toBeCloseTo(2.7); // top storey default
  });
  it("ignores wall_height (it only applies to drawn walls)", () => {
    expect(
      viewCut(
        { id: "ground", cut: null },
        {
          tagged: false,
          floors: [{ elevation: 0, height: 2.7 }],
          wallHeight: 1,
        },
      ),
    ).toBeCloseTo(2.7);
  });
  it("no cut for tagged models, cut: false, no floors, or the default All view", () => {
    const floors = [
      { elevation: 0, height: 3 },
      { elevation: 3, height: 2.6 },
    ];
    expect(viewCut({ id: "ground", cut: null }, { tagged: true, floors })).toBe(
      null,
    );
    expect(
      viewCut({ id: "ground", cut: false }, { tagged: false, floors }),
    ).toBe(null);
    expect(
      viewCut({ id: "ground", cut: null }, { tagged: false, floors: [] }),
    ).toBe(null);
    expect(
      viewCut(
        { id: "ground", cut: null },
        { tagged: false, floors: [{ elevation: NaN }] },
      ),
    ).toBe(null);
    expect(viewCut({ id: "all", cut: null }, { tagged: false, floors })).toBe(
      null,
    );
    expect(
      viewCut({ id: "all", cut: true }, { tagged: false, floors }),
    ).toBeCloseTo(5.6);
  });
});
