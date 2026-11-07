// Golden tests of the layout contract (src/schema/layout.ts): every fixture under test/fixtures/layouts
// (layouts the card wrote, hand edits) parses to its golden result.
// The expected results live in test/fixtures/layouts/golden; UPDATE_GOLDEN=1 rewrites them.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "bun:test";
import { parseLayout, emptyLayout } from "../src/schema/layout.ts";
import { DEMO_LAYOUT } from "../demo/layout.js";

const dir = path.join(import.meta.dirname, "fixtures", "layouts");
const goldenDir = path.join(dir, "golden");
const fixtures = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort();
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));

describe("layout fixtures", () => {
  it("there are fixtures of every kind", () => {
    expect(fixtures).toEqual(
      expect.arrayContaining([
        "demo-v1.json",
        "edited-v1.json",
        "hand-edited-v1.json",
      ]),
    );
  });

  for (const f of fixtures) {
    describe(f, () => {
      const raw = read(f);
      const p = parseLayout(raw);

      it("matches its golden parse (value, warnings, unknown fields)", () => {
        const got = {
          warnings: p.warnings,
          unknown: p.unknown,
          value: p.value,
        };
        const file = path.join(goldenDir, f);
        if (process.env.UPDATE_GOLDEN) {
          fs.mkdirSync(goldenDir, { recursive: true });
          fs.writeFileSync(file, JSON.stringify(got, null, 2) + "\n");
        }
        expect(JSON.parse(JSON.stringify(got))).toEqual(
          JSON.parse(fs.readFileSync(file, "utf8")),
        );
      });

      it("does not touch its input", () => {
        expect(raw).toEqual(read(f));
      });
    });
  }
});

describe("what the fixtures pin down", () => {
  it("the layouts the card wrote load without a warning", () => {
    for (const f of ["demo-v1.json", "claude-md-v1.json", "edited-v1.json"])
      expect([f, parseLayout(read(f)).warnings]).toEqual([f, []]);
    expect(parseLayout(DEMO_LAYOUT).warnings).toEqual([]);
  });

  it("v1 setPin without a height (z NaN -> null) loads as a pin without z", () => {
    const l = parseLayout(read("edited-v1.json")).value;
    expect(l.pins["device:kitchen_temp"]).toEqual({
      x: 8,
      y: 1,
      floor_id: "ground",
    });
  });

  it("hand edits: what does not fit is dropped and reported by path, the rest kept", () => {
    const p = parseLayout(read("hand-edited-v1.json"));
    const paths = p.warnings.map((w) => w.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "rooms[2].polygon[1]",
        "rooms[2].polygon[2]",
        "rooms[1].doors[1]",
        "rooms[3]",
        "floors[0].elevation",
        "floors[1].id",
        "pins.device:b.x",
        "pins.device:c",
        "pins.device:d.floor_id",
        "hidden[1]",
        "hidden[2]",
        "objects.a.wash",
        "objects.b",
        "badges",
        "room_labels",
        "views.v.rules",
        "mower.stuck_minutes",
      ]),
    );
    const l = p.value;
    expect(l.rooms.map((r) => r.id)).toEqual([
      "ok",
      "",
      "bad_points",
      "no_polygon",
    ]);
    expect(l.rooms[1].polygon[3]).toEqual([4, 3]); // [x, y, extra]: the point
    expect(l.rooms[2].polygon).toEqual([
      [0, 0],
      [3, 3],
      [0, 3],
    ]);
    expect(l.rooms[3].polygon).toEqual([]);
    expect(l.floors).toEqual([{ id: "ground" }]);
    expect(Object.keys(l.pins)).toEqual(["device:a", "device:d"]);
    expect(l.hidden).toEqual(["device:x"]);
    expect(l.objects).toEqual({ a: { entity: "light.a" } });
    expect(l.views).toEqual({ v: { label: "V" } });
    expect(l.mower).toEqual({
      entity: "lawn_mower.m",
      track_show: "always",
      overlay: { width: "9" }, // no longer a known field: kept as written
    });
    expect(l.my_extension).toEqual({ keep: ["me"] });
    expect(p.unknown).toEqual(["mower.overlay", "my_extension"]);
  });

  it("not a layout at all: an empty layout, said so", () => {
    expect(parseLayout(null)).toEqual({
      value: emptyLayout(),
      warnings: [],
      unknown: [],
    });
    expect(parseLayout(undefined).warnings).toEqual([]);
    const p = parseLayout([1, 2]);
    expect(p.value).toEqual(emptyLayout());
    expect(p.warnings).toHaveLength(1);
  });

  it("the empty layout", () => {
    expect(emptyLayout()).toEqual({
      floors: [],
      rooms: [],
      pins: {},
      hidden: [],
      mower: null,
      model: null,
    });
    expect(emptyLayout()).not.toBe(emptyLayout());
  });
});

describe("parseLayout repairs", () => {
  const paths = (input) => parseLayout(input).warnings.map((w) => w.path);

  it("a top-level section of the wrong type falls back to its default, with a warning", () => {
    const l = parseLayout({
      mower: "x",
      model: 5,
      floors: "x",
      hidden: {},
      view_order: "a",
      tap_hints: 7,
    });
    expect(l.value).toMatchObject({
      mower: null,
      model: null,
      floors: [],
      hidden: [],
    });
    expect("view_order" in l.value || "tap_hints" in l.value).toBe(false);
    expect(l.warnings.map((w) => w.path).sort()).toEqual([
      "floors",
      "hidden",
      "model",
      "mower",
      "tap_hints",
      "view_order",
    ]);
  });

  it("pin fields of the wrong shape are dropped, the pin kept", () => {
    const l = parseLayout({
      pins: {
        a: { x: 1, y: 2, z: "1", floor_id: "g" },
        b: { x: 1, y: 2, offset: [1, 2] },
      },
    });
    expect(l.value.pins).toEqual({
      a: { x: 1, y: 2, floor_id: "g" },
      b: { x: 1, y: 2 },
    });
    expect(l.warnings.map((w) => w.path)).toEqual([
      "pins.a.z",
      "pins.b.offset",
    ]);
  });

  it("drops non-object objects", () => {
    const l = parseLayout({ objects: [1, 2] }).value;
    expect("objects" in l).toBe(false);
    expect(parseLayout({ objects: { a: {} } }).value.objects).toEqual({
      a: {},
    });
  });

  it("mower and model fields no fixture has survive a save and load", () => {
    const input = {
      mower: {
        entity: "lawn_mower.m",
        source: "xy",
        ground: "floor",
        track_attr: "path",
        track_show: true,
        track_color: "#ff0000",
        track_width: 2,
        track_opacity: 0.5,
        auto: false,
        overlay: {
          entity: "image.m",
          hide_icon: true,
          zone: "auto",
          mowed_tolerance: 30,
          nomow_tolerance: 20,
        },
      },
      model: { url: "/local/x.glb", uploaded: 123 },
      views: { a: { cut: null } },
    };
    const first = parseLayout(input);
    expect(first.warnings).toEqual([]);
    expect(first.value).toMatchObject(input);
    expect(
      paths({ mower: { track_width: "3", track_color: [1, 2, 3] } }),
    ).toEqual(["mower.track_width", "mower.track_color"]);
  });

  it("fills defaults and repairs bad fields", () => {
    expect(parseLayout(null).value).toEqual(emptyLayout());
    expect(
      parseLayout({ rooms: "x", pins: null, floors: [{ id: "g" }], extra: 1 })
        .value,
    ).toMatchObject({
      rooms: [],
      pins: {},
      floors: [{ id: "g" }],
      hidden: [],
      extra: 1,
    });
  });
});
