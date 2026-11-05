// Golden tests of the stored layout contract (src/schema/layout.ts): every fixture under
// test/fixtures/layouts (old versions, hand edits, newer cards) parses, migrates and round-trips.
// The expected results live in test/fixtures/layouts/golden; UPDATE_GOLDEN=1 rewrites them.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "bun:test";
import {
  LAYOUT_VERSION,
  parseLayout,
  serializeLayout,
  emptyLayout,
} from "../src/schema/layout.ts";
import { parseImport } from "../src/editor.ts";
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
        "legacy-v1.json",
        "hand-edited-v1.json",
        "future-v3.json",
      ]),
    );
  });

  for (const f of fixtures) {
    describe(f, () => {
      const raw = read(f);
      const p = parseLayout(raw);

      it("matches its golden parse (value, warnings, unknown fields)", () => {
        const got = {
          from: p.from,
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

      it("migrates to the current version (a newer one is kept)", () => {
        expect(p.value.version).toBe(
          Math.max(LAYOUT_VERSION, raw.version || 1),
        );
      });

      it("round-trips: parse(serialize(parse(x))) == parse(x), without new warnings", () => {
        const stored = JSON.parse(JSON.stringify(serializeLayout(p.value)));
        const again = parseLayout(stored);
        expect(again.value).toEqual(p.value);
        expect(again.warnings.filter((w) => w.path !== "version")).toEqual([]);
        expect(again.unknown).toEqual(p.unknown);
        expect(serializeLayout(again.value)).toEqual(stored);
      });

      it("does not touch its input", () => {
        expect(raw).toEqual(read(f));
      });
    });
  }
});

describe("what the fixtures pin down", () => {
  it("the layouts the card wrote load without a warning", () => {
    for (const f of [
      "demo-v1.json",
      "claude-md-v1.json",
      "edited-v1.json",
      "legacy-v1.json",
    ])
      expect([f, parseLayout(read(f)).warnings]).toEqual([f, []]);
    expect(parseLayout(DEMO_LAYOUT).warnings).toEqual([]);
  });

  it("v1 -> v2: legacy aliases folded into their current form", () => {
    const l = parseLayout(read("legacy-v1.json")).value;
    expect(l.version).toBe(2);
    expect("groups" in l).toBe(false);
    expect(l.tags).toEqual({
      facade: { entity: "switch.facade" },
      garden: { entity: "switch.garden_new" },
    }); // tags win
    expect("floor_map" in l.model).toBe(false);
    expect(l.model.levels).toEqual({
      level0: { floor: "ground" },
      level1: { floor: "first" },
      roof: { show: "always" },
    }); // saved levels win
    expect(l.mower.image).toEqual({
      entity: "camera.sunseeker_live_map",
      colors: [[255, 59, 48]],
      tolerance: 40,
      min_pixels: 4,
    });
    const o = l.mower.overlay;
    expect([o.bg_colors, o.mowed_colors, o.nomow_colors]).toEqual([
      [[47, 93, 44]],
      [[127, 194, 111]],
      [[140, 140, 140]],
    ]); // a list wins over the single colour
    expect(
      ["bg_color", "mowed_color", "nomow_color"].filter((k) => k in o),
    ).toEqual([]);
    expect(l.mower.stuck_minutes).toBe(10); // "10" read as a number
    expect(l.pins["device:no_z"]).toEqual({ x: 1, y: 1, floor_id: "ground" }); // z: null (v1 NaN) read as absent
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
        "mower.overlay.width",
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
      overlay: {},
    });
    expect(l.my_extension).toEqual({ keep: ["me"] });
    expect(p.unknown).toEqual(["my_extension"]);
  });

  it("a newer card's layout loads as far as known, keeps its version and its fields", () => {
    const raw = read("future-v3.json");
    const p = parseLayout(raw);
    expect(p.from).toBe(3);
    expect(p.warnings).toEqual([
      {
        path: "version",
        message: expect.stringMatching(/newer than this card/),
      },
    ]);
    expect(p.value.version).toBe(3);
    expect(p.value.rooms[0].walls).toEqual({ thickness: 0.2 });
    expect(p.value.pins["device:a"].anchor).toBe("ceiling");
    expect(serializeLayout(p.value)).toEqual(raw);
    expect(p.unknown).toEqual([
      "rooms[0].walls",
      "pins.device:a.anchor",
      "lighting",
    ]);
  });

  it("not a layout at all: an empty layout, said so", () => {
    expect(parseLayout(null)).toEqual({
      value: emptyLayout(),
      warnings: [],
      unknown: [],
      from: 1,
    });
    expect(parseLayout(undefined).warnings).toEqual([]);
    const p = parseLayout([1, 2]);
    expect(p.value).toEqual(emptyLayout());
    expect(p.warnings).toHaveLength(1);
    expect(parseLayout({ version: "x" }).warnings[0].path).toBe("version");
  });

  it("the empty layout", () => {
    expect(emptyLayout()).toEqual({
      version: LAYOUT_VERSION,
      floors: [],
      rooms: [],
      pins: {},
      hidden: [],
      mower: null,
      model: null,
    });
    expect(emptyLayout()).not.toBe(emptyLayout());
  });

  it("serializeLayout: plain JSON, no undefined fields, the version stamped", () => {
    const l = {
      ...emptyLayout(),
      version: 1,
      objects: undefined,
      rooms: [{ id: "a", polygon: [], area_id: undefined }],
    };
    const s = serializeLayout(l);
    expect(s).toEqual({
      version: LAYOUT_VERSION,
      floors: [],
      rooms: [{ id: "a", polygon: [] }],
      pins: {},
      hidden: [],
      mower: null,
      model: null,
    });
    expect("objects" in s).toBe(false);
  });

  it("every file the card can export, it can import again", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const f of [
      "demo-v1.json",
      "claude-md-v1.json",
      "edited-v1.json",
      "legacy-v1.json",
    ]) {
      const once = parseImport(JSON.stringify(read(f)));
      const twice = parseImport(JSON.stringify(serializeLayout(once)));
      expect(twice).toEqual(once);
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("the importer reports what it dropped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseImport(JSON.stringify({ rooms: [], hidden: [1] }));
    expect(warn).toHaveBeenCalledWith(
      "floorplan3d: import hidden[0]: expected a string, got 1",
    );
    warn.mockRestore();
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

  it("a version that is not a positive integer is reported and read as v1", () => {
    for (const version of [1.5, 0, "x"]) {
      const l = parseLayout({ version });
      expect(l.value.version).toBe(LAYOUT_VERSION);
      expect(l.warnings.map((w) => w.path)).toContain("version");
    }
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

  it("drops non-object objects / groups", () => {
    const l = parseLayout({ objects: [1, 2], groups: "x" }).value;
    expect("objects" in l).toBe(false);
    expect("groups" in l).toBe(false);
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
    const again = parseLayout(
      JSON.parse(JSON.stringify(serializeLayout(first.value))),
    );
    expect(again.warnings).toEqual([]);
    expect(again.value).toEqual(first.value);
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
      version: 2,
      rooms: [],
      pins: {},
      floors: [{ id: "g" }],
      hidden: [],
      extra: 1,
    });
  });
});
