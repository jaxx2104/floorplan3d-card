import { describe, it, expect } from "bun:test";
import * as THREE from "three";
import {
  planckXy,
  kelvinRgb,
  kelvinSrgb,
  physicalColor,
  lumensToCandela,
  lampIntensity,
  DEFAULT_KELVIN,
  DEFAULT_LUMENS,
  LAMP_EXPOSURE,
} from "../src/photometry.ts";
import { lightColor } from "../src/objects/logic.ts";
import { ObjectLayer } from "../src/objects/layer.ts";
import { replaceLights } from "../src/objects/model-lamps.ts";
import { hintDefaults } from "../src/objects/types.ts";
import {
  emissiveLevel,
  blooms,
  unrealStrength,
  BLOOM_MIN_EMISSIVE,
  BLOOM_STRENGTH,
} from "../src/bloom.ts";

describe("kelvin -> rgb (Planckian locus)", () => {
  it("xy on the locus at reference temperatures", () => {
    const near = (v, want) => expect(Math.abs(v - want)).toBeLessThan(0.002); // the cubic fit's accuracy
    const a = planckXy(2856); // CIE illuminant A
    near(a[0], 0.4476);
    near(a[1], 0.4074);
    const d = planckXy(6504); // the blackbody next to D65
    near(d[0], 0.3135);
    near(d[1], 0.3237);
  });
  it("warm lamps are red-orange, hot ones blue-white; the brightest channel is 1", () => {
    const w = kelvinRgb(2700);
    expect(w[0]).toBe(1);
    expect(w[1]).toBeGreaterThan(w[2]);
    expect(w[2]).toBeLessThan(0.3);
    const c = kelvinRgb(10000);
    expect(c[2]).toBe(1);
    expect(c[0]).toBeLessThan(1);
    const n = kelvinRgb(6500);
    for (const v of n) expect(v).toBeGreaterThan(0.85); // near white
  });
  it("blue rises and red falls with temperature", () => {
    let prev = kelvinRgb(1800);
    for (const k of [2200, 2700, 3000, 4000, 5000, 6500, 8000, 12000]) {
      const c = kelvinRgb(k);
      expect(c[2] / c[0]).toBeGreaterThan(prev[2] / prev[0]);
      prev = c;
    }
  });
  it("clamps outside the fit and falls back for nonsense", () => {
    expect(kelvinRgb(500)).toEqual(kelvinRgb(1667));
    expect(kelvinRgb(1e6)).toEqual(kelvinRgb(25000));
    expect(kelvinRgb(NaN)).toEqual(kelvinRgb(DEFAULT_KELVIN));
  });
  it("sRGB 0..255 for the layer", () => {
    const s = kelvinSrgb(2700);
    expect(s[0]).toBe(255);
    expect(s.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)).toBe(
      true,
    );
    // matches three's own sRGB encoding
    const c = new THREE.Color().setRGB(...kelvinRgb(3000));
    expect(kelvinSrgb(3000)).toEqual(
      c.getStyle(THREE.SRGBColorSpace).match(/\d+/g).map(Number),
    );
  });
});

describe("physicalColor", () => {
  const col = (attributes) => physicalColor({ attributes }, lightColor);
  it("colour temperature mode: HA's rgb_color, else HA's conversion of the kelvin (both tiers agree)", () => {
    expect(
      col({
        color_mode: "color_temp",
        color_temp_kelvin: 3000,
        rgb_color: [255, 177, 110],
      }),
    ).toEqual([255, 177, 110]);
    const k = { color_mode: "color_temp", color_temp_kelvin: 4000 }; // no rgb_color (a mock, an old integration)
    expect(col(k)).toEqual(lightColor({ attributes: k }));
    expect(col(k)).not.toEqual(kelvinSrgb(4000));
  });
  it("colour modes keep the reported colour", () => {
    expect(
      col({
        color_mode: "rgb",
        rgb_color: [10, 20, 30],
        color_temp_kelvin: 3000,
      }),
    ).toEqual([10, 20, 30]);
    expect(col({ color_mode: "hs", hs_color: [240, 100] })).toEqual(
      lightColor({ attributes: { hs_color: [240, 100] } }),
    );
    expect(col({ rgb_color: [1, 2, 3] })).toEqual([1, 2, 3]);
  });
  it("brightness-only / on-off lamps: a warm white bulb", () => {
    expect(col({ color_mode: "brightness", brightness: 200 })).toEqual(
      kelvinSrgb(DEFAULT_KELVIN),
    );
    expect(physicalColor(null, lightColor)).toEqual(kelvinSrgb(DEFAULT_KELVIN));
  });
});

describe("lumens -> candela", () => {
  it("a point lamp spreads over 4 pi sr, a spot over pi sr", () => {
    expect(lumensToCandela(800)).toBeCloseTo(63.66, 2);
    expect(lumensToCandela(800, "point")).toBeCloseTo(800 / (4 * Math.PI));
    expect(lumensToCandela(300, "spot")).toBeCloseTo(300 / Math.PI);
    expect(lumensToCandela(-5)).toBe(0);
    expect(lumensToCandela("x")).toBe(0);
  });
  it("scales with brightness, defaults per beam, exposure into scene units", () => {
    expect(lampIntensity(null, 1, "point")).toBeCloseTo(
      (DEFAULT_LUMENS.point / (4 * Math.PI)) * LAMP_EXPOSURE,
    );
    expect(lampIntensity(null, 0.5, "point")).toBeCloseTo(
      lampIntensity(null, 1, "point") / 2,
    );
    expect(lampIntensity(null, 1, "spot")).toBeCloseTo(
      (DEFAULT_LUMENS.spot / Math.PI) * LAMP_EXPOSURE,
    );
    expect(lampIntensity(1600, 1, "point")).toBeCloseTo(
      2 * lampIntensity(800, 1, "point"),
    );
    expect(lampIntensity(800, 2, "point")).toBeCloseTo(
      lampIntensity(800, 1, "point"),
    ); // level clamped
    expect(lampIntensity(800, 0, "point")).toBe(0);
  });
  it("the model lamp's candela (KHR_lights_punctual) comes before lumens", () => {
    expect(lampIntensity(800, 1, "point", 40)).toBeCloseTo(40 * LAMP_EXPOSURE);
    expect(lampIntensity(null, 0.5, "spot", 40)).toBeCloseTo(
      20 * LAMP_EXPOSURE,
    );
    expect(lampIntensity(800, 1, "point", null)).toBeCloseTo(
      lampIntensity(800, 1, "point"),
    );
    expect(lampIntensity(800, 1, "point", NaN)).toBeCloseTo(
      lampIntensity(800, 1, "point"),
    ); // invalid: the flux
  });
});

describe("ObjectLayer physical lamps", () => {
  const fakeView = () => ({
    objectsGroup: new THREE.Group(),
    floorElevation: () => 0,
    markDirty() {},
    requestShadowUpdate() {},
  });
  const model = (hints) => {
    const root = new THREE.Group(),
      level = new THREE.Group(),
      node = new THREE.Group();
    root.add(level);
    level.add(node);
    node.position.set(1, 2, 0);
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.06, 0.06),
      new THREE.MeshStandardMaterial(),
    );
    glow.name = "glow";
    node.add(glow);
    return {
      id: "m",
      root,
      manifest: {
        levels: [{ id: "ground", node: level }],
        objects: [
          {
            id: "a",
            type: "light",
            level: "ground",
            group: null,
            glow: null,
            hints,
            node,
            suggest: {},
          },
        ],
      },
    };
  };
  const bind = new Map([
    ["a", { entity: "light.a", auto: true, missing: false, hidden: false }],
  ]);
  const ctx = { visibleLevel: () => true, lightsOn: true };
  const states = {
    "light.a": {
      state: "on",
      attributes: {
        brightness: 255,
        color_mode: "color_temp",
        color_temp_kelvin: 2700,
        rgb_color: [255, 166, 87],
      },
    },
  };
  const lamp = (layer) => layer.pool.points.find((l) => l.intensity > 0);

  it("every tier: candela, inverse square, HA's colour (hints.max and decay no longer set the light)", () => {
    const layer = new ObjectLayer(fakeView());
    layer.setModel(model({ max: 20, distance: 8, decay: 1.5 }));
    layer.setBindings(bind, {});
    layer.update(states, ctx);
    expect(lamp(layer).intensity).toBeCloseTo(lampIntensity(null, 1, "point"));
    expect(lamp(layer).decay).toBe(2);
    // colour temperature mode: HA's rgb_color
    expect(lamp(layer).color.getHex()).toBe(
      new THREE.Color()
        .setRGB(255 / 255, 166 / 255, 87 / 255, THREE.SRGBColorSpace)
        .getHex(),
    );
    expect(layer).not.toHaveProperty("setPhysical");
  });
  it("hints.lumens overrides the default flux", () => {
    const layer = new ObjectLayer(fakeView());
    layer.setModel(model({ lumens: 1600 }));
    layer.setBindings(bind, {});
    layer.update(states, ctx);
    expect(lamp(layer).intensity).toBeCloseTo(lampIntensity(1600, 1, "point"));
  });
  it("a model lamp (KHR_lights_punctual): its place, aim, cone and candela; lumens only as the fallback", () => {
    const m = model({ lumens: 1600 });
    const node = m.manifest.objects[0].node;
    const spot = new THREE.SpotLight(
      0xffffff,
      120,
      6,
      THREE.MathUtils.degToRad(30),
      0.25,
    );
    spot.position.set(0.5, -0.2, 0);
    spot.rotation.x = -Math.PI / 2; // -Z (the glTF light axis) down
    spot.name = "bulb";
    node.add(spot);
    expect(replaceLights(m.root)).toBe(1);
    expect(spot.parent).toBe(null);
    const marker = node.children.find((c) => c.name === "bulb");
    expect(marker.isLight).toBe(undefined);
    expect(marker.userData.fpLamp).toEqual({
      beam: "spot",
      candela: 120,
      range: 6,
      angle: expect.closeTo(30, 6),
      penumbra: 0.25,
    });
    const layer = new ObjectLayer(fakeView());
    layer.setModel(m);
    layer.setBindings(bind, {});
    layer.update(states, ctx);
    const l = layer.pool.spots.find((x) => x.intensity > 0);
    expect(l).toBeTruthy();
    expect(l.intensity).toBeCloseTo(120 * LAMP_EXPOSURE);
    expect(l.angle).toBeCloseTo(THREE.MathUtils.degToRad(30));
    expect(l.penumbra).toBeCloseTo(0.25);
    expect(l.distance).toBe(6);
    expect(l.position.toArray().map((v) => +v.toFixed(3) + 0)).toEqual([
      1.5, 1.8, 0,
    ]);
    expect(l.target.position.toArray().map((v) => +v.toFixed(3) + 0)).toEqual([
      1.5, 0.8, 0,
    ]);
    // hints still win where given
    const h = hintDefaults(
      { beam: "point", distance: 2 },
      marker.userData.fpLamp,
    );
    expect(h).toMatchObject({ beam: "point", distance: 2, candela: 120 });
    expect(hintDefaults({}, null).candela).toBe(null);
  });
});

describe("selective bloom: what blooms", () => {
  const mesh = (m) => new THREE.Mesh(new THREE.BoxGeometry(), m);
  it("only materials with an emissive radiance above the floor", () => {
    expect(emissiveLevel(new THREE.MeshStandardMaterial())).toBe(0);
    expect(emissiveLevel(new THREE.MeshBasicMaterial())).toBe(0);
    expect(
      emissiveLevel(
        new THREE.MeshStandardMaterial({
          emissive: 0xff8000,
          emissiveIntensity: 2,
        }),
      ),
    ).toBeCloseTo(2);
    expect(
      blooms(
        mesh(
          new THREE.MeshStandardMaterial({
            emissive: 0xffffff,
            emissiveIntensity: BLOOM_MIN_EMISSIVE / 2,
          }),
        ),
      ),
    ).toBe(false);
    expect(
      blooms(
        mesh(
          new THREE.MeshStandardMaterial({
            emissive: 0xffffff,
            emissiveIntensity: 1,
          }),
        ),
      ),
    ).toBe(true);
    expect(
      blooms(
        mesh([
          new THREE.MeshStandardMaterial(),
          new THREE.MeshStandardMaterial({ emissive: 0x00ff00 }),
        ]),
      ),
    ).toBe(true);
    expect(
      blooms(
        mesh(
          new THREE.MeshStandardMaterial({
            emissive: 0xffffff,
            visible: false,
          }),
        ),
      ),
    ).toBe(false);
    expect(blooms(new THREE.Sprite())).toBe(false);
  });
});

describe("selective bloom: UnrealBloomPass strength", () => {
  it("its composite of five equal mips (3 x strength x their weights) is BLOOM_STRENGTH x one of them", () => {
    // the weights mix(factor, 1.2 - factor, radius) of the factors 1, 0.8, 0.6, 0.4, 0.2 sum to 3 at any radius
    for (const radius of [0, 0.5, 1])
      expect(3 * unrealStrength(radius) * 3).toBeCloseTo(BLOOM_STRENGTH);
  });
});
