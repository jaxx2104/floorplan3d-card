import { describe, it, expect } from "bun:test";
import {
  ShelfPacker,
  growAtlas,
  cellKey,
  cellUv,
  pickAt,
  drawOrder,
  hashKey,
} from "../src/sprite-atlas.ts";
import {
  markerDraw,
  markerKey,
  markerLayout,
  markerParts,
  markerSprite,
  markerColors,
} from "../src/marker-sprite.ts";
import { labelSprite, chipSprite } from "../src/label-sprite.ts";

// a layout / paint environment without a canvas: 6 px per character
const env = (o = {}) => ({
  dpr: 1,
  model: false,
  compact: false,
  font: "sans-serif",
  color: (css, fb) => fb,
  measure: (t) => t.length * 6,
  icon: () => null,
  image: () => null,
  ...o,
});
const face = (o = {}) => ({
  shape: "circle",
  kind: "control",
  light: false,
  active: false,
  alert: null,
  unavailable: false,
  offline: false,
  stateColor: "",
  lightColor: "",
  icon: "state:device:a",
  inner: "",
  value: "",
  picture: null,
  logo: null,
  status: null,
  battery: null,
  selected: false,
  ...o,
});

describe("atlas packing", () => {
  it("fills rows left to right with a gutter, a taller cell opens a new row", () => {
    const p = new ShelfPacker(100, 100, 2);
    expect(p.add(30, 20)).toEqual({ x: 0, y: 0, w: 30, h: 20 });
    expect(p.add(30, 20)).toEqual({ x: 32, y: 0, w: 30, h: 20 });
    expect(p.add(30, 40)).toEqual({ x: 0, y: 22, w: 30, h: 40 }); // taller: below
    expect(p.add(30, 10)).toEqual({ x: 64, y: 0, w: 30, h: 10 }); // fits the first row
  });

  it("reports a full atlas; reset starts over (at a new size)", () => {
    const p = new ShelfPacker(64, 64, 0);
    expect(p.add(64, 64)).not.toBeNull();
    expect(p.add(1, 1)).toBeNull();
    expect(p.add(100, 10)).toBeNull(); // wider than the atlas
    p.reset(128, 64);
    expect(p.add(100, 10)).toEqual({ x: 0, y: 0, w: 100, h: 10 });
  });

  it("rounds cells up to whole texels", () => {
    const p = new ShelfPacker(64, 64, 2);
    expect(p.add(10.2, 7.5)).toEqual({ x: 0, y: 0, w: 11, h: 8 });
    expect(p.add(1, 1).x).toBe(13);
  });

  it("grows width first, then height, up to the limit", () => {
    expect(growAtlas(1024, 1024, 4096)).toEqual([2048, 1024]);
    expect(growAtlas(2048, 1024, 4096)).toEqual([2048, 2048]);
    expect(growAtlas(4096, 4096, 4096)).toBeNull();
  });

  it("uv of a cell, v down", () => {
    expect(cellUv({ x: 256, y: 512, w: 256, h: 128 }, 1024, 1024)).toEqual([
      0.25, 0.5, 0.5, 0.625,
    ]);
  });

  it("the cell key joins the size class and the versions of what the picture depends on", () => {
    const spec = { key: "k", deps: ["icon:a", "img:b"] };
    const v = { "icon:a": 1, "img:b": 0 };
    const k = cellKey(spec, { model: false, compact: false }, (d) => v[d]);
    expect(
      cellKey(spec, { model: true, compact: false }, (d) => v[d]),
    ).not.toBe(k);
    expect(
      cellKey(spec, { model: false, compact: true }, (d) => v[d]),
    ).not.toBe(k);
    v["icon:a"] = 2; // the icon resolved / changed
    expect(
      cellKey(spec, { model: false, compact: false }, (d) => v[d]),
    ).not.toBe(k);
    expect(hashKey("abc")).toBe(hashKey("abc"));
    expect(hashKey("abc")).not.toBe(hashKey("abd"));
  });
});

describe("picking", () => {
  const item = (id, x, y, depth, o = {}) => ({
    id,
    x,
    y,
    depth,
    scale: 1,
    hits: [{ x: -15, y: -15, w: 30, h: 30 }],
    ...o,
  });

  it("maps a point to the marker ids under it, the nearest (drawn on top) first", () => {
    const items = [item("far", 100, 100, 20), item("near", 110, 100, 5)];
    expect(pickAt(items, 105, 100)).toEqual(["near", "far"]);
    expect(pickAt(items, 88, 100)).toEqual(["far"]);
    expect(pickAt(items, 200, 100)).toEqual([]);
  });

  it("tappable rects only (the value pill counts, badges do not), scaled with hover", () => {
    const it2 = item("a", 0, 0, 1, {
      hits: [
        { x: -10, y: -10, w: 20, h: 20 },
        { x: -12, y: 12, w: 24, h: 14 },
      ],
    });
    expect(pickAt([it2], 0, 20)).toEqual(["a"]); // on the pill
    expect(pickAt([it2], 11, -11)).toEqual([]); // where the logo sits
    expect(pickAt([{ ...it2, scale: 1.12 }], 0, -11)).toEqual(["a"]);
    expect(pickAt([it2], 0, -11)).toEqual([]);
  });

  it("draw order: farthest first, ties as given", () => {
    expect(drawOrder([5, 20, 5, 1])).toEqual([1, 0, 2, 3]);
  });
});

describe("marker instance state (markerDraw)", () => {
  const base = {
    faded: false,
    quiet: false,
    alert: false,
    hover: false,
  };
  it("view mode: full, a quarter where the model hides it, hidden ones take no tap", () => {
    expect(markerDraw(base)).toEqual({
      alpha: 1,
      hiddenAlpha: 0.25,
      scale: 1,
      pickable: true,
    });
  });
  it("faded (other floors of All), hover", () => {
    const d = markerDraw({ ...base, faded: true, hover: true });
    expect(d.alpha).toBe(0.3);
    expect(d.hiddenAlpha).toBe(0.25);
    expect(d.scale).toBe(1.12);
  });
  it("night quiet hides markers but alerts", () => {
    expect(markerDraw({ ...base, quiet: true }).alpha).toBe(0);
    expect(markerDraw({ ...base, quiet: true }).pickable).toBe(false);
    expect(markerDraw({ ...base, quiet: true, alert: true }).alpha).toBe(1);
  });
});

describe("marker sprite", () => {
  it("dot sizes per size class (content + border)", () => {
    expect(markerParts(face(), env()).dot.w).toBe(31);
    expect(markerParts(face(), env({ model: true })).dot.w).toBe(25);
    expect(markerParts(face(), env({ compact: true })).dot.w).toBe(23);
  });

  it("the anchor is the dot's centre; hits are the dot and the value pill", () => {
    const l = markerLayout(face({ value: "21.4 °C" }), env());
    expect(l.hits).toHaveLength(2);
    const [dot, pill] = l.hits;
    expect(dot.x + dot.w / 2).toBeCloseTo(0);
    expect(dot.y + dot.h / 2).toBeCloseTo(0);
    expect(pill.y).toBeCloseTo(dot.y + dot.h + 2); // 2 px below the dot
    expect(pill.w).toBe(7 * 6 + 10);
    // the cell holds every part with the anchor inside it
    expect(l.ax).toBeGreaterThan(dot.w / 2);
    expect(l.w - l.ax).toBeGreaterThan(dot.w / 2);
  });

  it("a value marker widens with its text; badges grow the cell, not the hits", () => {
    const v = markerParts(
      face({ kind: "value", shape: "square", inner: "21.4°C" }),
      env(),
    );
    expect(v.dot.w).toBe(13 + 2 + 36 + 4 + 6 + 3);
    const plain = markerLayout(face(), env());
    const badged = markerLayout(
      face({ logo: "https://x/l.png", status: "green", battery: 12 }),
      env(),
    );
    expect(badged.h).toBeGreaterThan(plain.h);
    expect(badged.hits).toEqual(plain.hits);
  });

  it("the key changes with everything that changes the picture", () => {
    const k = markerKey(face());
    for (const o of [
      { active: true },
      { value: "1 W" },
      { icon: "state:device:b" },
      { selected: true },
      { battery: 10 },
      { stateColor: "var(--state-light-active-color)" },
      { unavailable: true },
      { picture: "/api/image/a?token=1" },
    ])
      expect(markerKey(face(o))).not.toBe(k);
    expect(markerKey(face())).toBe(k);
    const s = markerSprite(face({ picture: "/p.png", logo: "/l.png" }));
    expect(s.deps).toEqual(["icon:state:device:a", "img:/p.png", "img:/l.png"]);
  });

  it("colours: plain, active (state colour), a light's own colour, alerts", () => {
    const e = env({
      color: (css, fb) => (css === "var(--x)" ? "rgb(1, 1, 1)" : fb),
    });
    expect(markerColors(face(), e).bg).toBe("#ffffff");
    expect(
      markerColors(face({ active: true, stateColor: "var(--x)" }), e).bg,
    ).toBe("rgb(1, 1, 1)");
    expect(markerColors(face({ active: true }), e).bg).toBe("#03a9f4");
    expect(
      markerColors(
        face({ active: true, light: true, lightColor: "var(--x)" }),
        e,
      ).bg,
    ).toBe("rgb(1, 1, 1)");
    expect(markerColors(face({ alert: "yellow" }), e).fg).toBe("#212121");
  });

  it("labels: centred, an object label above its point, the chip right of the mower", () => {
    const room = labelSprite("Kitchen").layout(env());
    expect(room.ax).toBe(Math.round(room.w / 2));
    expect(room.ay).toBe(Math.round(room.h / 2));
    expect(room.hits).toEqual([]);
    const obj = labelSprite("7.4 kW", { anchorY: 1.2 }).layout(env());
    expect(obj.ay).toBeGreaterThan(obj.h);
    const chip = chipSprite("rain", "mdi:weather-rainy", "Rain").layout(env());
    expect(chip.ax).toBeLessThan(chip.w / 2); // the chip sits right of and above the point
    expect(chip.ay).toBeGreaterThan(chip.h / 2);
    expect(chipSprite("rain", "mdi:weather-rainy", "Rain").deps).toEqual([
      "icon:name:mdi:weather-rainy",
    ]);
  });
});
