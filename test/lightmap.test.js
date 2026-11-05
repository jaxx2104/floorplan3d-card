import { describe, it, expect, vi } from "bun:test";
import * as THREE from "three";
import {
  normLightmap,
  lightmapTexCoord,
  uvAttribute,
  bakedRooms,
  insidePolygon,
} from "../src/lightmap.ts";
import { prepareLightmaps, applyLightmap } from "../src/view/indirect.ts";

describe("fp_lightmap spec", () => {
  it('"occlusion": the occlusionTexture is the light map, on its own texCoord', () => {
    const { spec, warnings } = normLightmap("occlusion");
    expect(warnings).toEqual([]);
    expect(spec).toEqual({
      texture: "occlusion",
      texCoord: null,
      intensity: 1,
      type: "light",
      colorSpace: "srgb",
    });
    expect(lightmapTexCoord(spec, 1)).toBe(1);
    expect(lightmapTexCoord(spec, null)).toBe(1); // a second UV map by default
    expect(normLightmap(true).spec.texture).toBe("occlusion");
  });
  it("an object: texture index, texCoord, intensity (clamped), type, colour space", () => {
    expect(
      normLightmap({
        texture: 3,
        texCoord: 2,
        intensity: 20,
        type: "ao",
        colorSpace: "linear",
      }).spec,
    ).toEqual({
      texture: 3,
      texCoord: 2,
      intensity: 10,
      type: "ao",
      colorSpace: "linear",
    });
    expect(lightmapTexCoord(normLightmap({ texture: 3 }).spec, 0)).toBe(1);
    expect(
      lightmapTexCoord(
        normLightmap({ texture: "occlusion", texCoord: 2 }).spec,
        1,
      ),
    ).toBe(2);
  });
  it("invalid values: no lightmap (bad texture / texCoord) or a default with a warning", () => {
    expect(normLightmap(undefined)).toEqual({ spec: null, warnings: [] });
    expect(normLightmap(false).spec).toBe(null);
    expect(normLightmap("yes").spec).toBe(null);
    expect(normLightmap({ texture: -1 }).spec).toBe(null);
    expect(normLightmap({ texture: 1, texCoord: 7 }).spec).toBe(null);
    const r = normLightmap({
      texture: 1,
      type: "glow",
      intensity: "x",
      colorSpace: "p3",
      bogus: 1,
    });
    expect(r.spec).toMatchObject({
      texture: 1,
      type: "light",
      intensity: 1,
      colorSpace: "srgb",
    });
    expect(r.warnings.length).toBe(4);
    // the occlusion slot is AO in every tier already
    expect(normLightmap({ type: "ao" }).spec).toBe(null);
  });
  it("uvAttribute: three's names of the glTF UV sets", () => {
    expect(uvAttribute(0)).toBe("uv");
    expect(uvAttribute(1)).toBe("uv1");
  });
});

describe("baked rooms", () => {
  const rooms = [
    {
      polygon: [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
      y0: 0,
      y1: 2.7,
    },
    {
      polygon: [
        [4, 0],
        [8, 0],
        [8, 4],
        [4, 4],
      ],
      y0: 0,
      y1: 2.7,
    },
    {
      polygon: [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
      y0: 3,
      y1: 5.6,
    },
  ];
  const mesh = (x, y, py, baked) => ({ x, y, z: -py, baked });
  it("a room is baked when at least half of its meshes carry a light map", () => {
    const set = bakedRooms(rooms, [
      mesh(1, 1, 1, true),
      mesh(2, 0.1, 2, true),
      mesh(3, 2, 3, false), // room 0: 2 of 3
      mesh(5, 1, 1, true),
      mesh(6, 1, 2, false),
      mesh(7, 1, 3, false), // room 1: 1 of 3
      mesh(1, 4, 1, false), // room 2 (upstairs): none
      mesh(20, 1, 1, true), // outside every room
    ]);
    expect([...set]).toEqual([0]);
    expect(bakedRooms(rooms, []).size).toBe(0);
  });
  it("insidePolygon (plan)", () => {
    expect(insidePolygon(1, 1, rooms[0].polygon)).toBe(true);
    expect(insidePolygon(5, 1, rooms[0].polygon)).toBe(false);
  });
});

describe("lightmaps on the loaded model", () => {
  const geo = (uv1 = true) => {
    const g = new THREE.BoxGeometry(1, 1, 1);
    if (uv1) g.setAttribute("uv1", g.attributes.uv.clone());
    return g;
  };
  const model = (mats) => {
    const root = new THREE.Group();
    for (const [m, uv1] of mats) root.add(new THREE.Mesh(geo(uv1), m));
    return root;
  };
  it("occlusion source: a copy of the aoMap as the light map in high (aoMap off), restored in standard", () => {
    const ao = new THREE.Texture();
    ao.channel = 1;
    const m = new THREE.MeshStandardMaterial({
      aoMap: ao,
      aoMapIntensity: 0.8,
    });
    m.userData.fp_lightmap = "occlusion";
    const [e] = prepareLightmaps(model([[m, true]]), null, () => {});
    expect(e.tex).not.toBe(ao);
    expect(e.tex.channel).toBe(1);
    expect(e.tex.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(applyLightmap(e, true, 0.5)).toBe(true);
    expect(m.lightMap).toBe(e.tex);
    expect(m.aoMap).toBe(null);
    expect(m.lightMapIntensity).toBeCloseTo(0.5); // follows the sky
    expect(applyLightmap(e, true, 0.25)).toBe(false); // no recompile, the brightness follows
    expect(m.lightMapIntensity).toBeCloseTo(0.25);
    expect(applyLightmap(e, false)).toBe(true);
    expect(m.lightMap).toBe(null);
    expect(m.aoMap).toBe(ao);
    expect(m.aoMapIntensity).toBe(0.8);
  });
  it("texture index: loaded through the parser, applied once it arrives", async () => {
    const src = new THREE.Texture();
    const parser = {
      getDependency: vi.fn(async (type, i) =>
        type === "texture" && i === 4 ? src : null,
      ),
    };
    const m = new THREE.MeshStandardMaterial();
    m.userData.fp_lightmap = { texture: 4, type: "ao", intensity: 0.7 };
    const ready = vi.fn();
    const [e] = prepareLightmaps(model([[m, true]]), parser, ready);
    expect(e.tex).toBe(null);
    expect(applyLightmap(e, true)).toBe(false); // nothing to apply yet
    await new Promise((r) => setTimeout(r, 0));
    expect(ready).toHaveBeenCalledTimes(1);
    expect(e.tex.channel).toBe(1);
    expect(applyLightmap(e, true)).toBe(true);
    expect(m.aoMap).toBe(e.tex);
    expect(m.aoMapIntensity).toBe(0.7);
    expect(m.lightMap).toBe(null);
  });
  it("skipped with a warning: a mesh without the UV set, no occlusionTexture, not a PBR material", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ao = new THREE.Texture();
    ao.channel = 1; // the occlusionTexture on TEXCOORD_1
    const a = new THREE.MeshStandardMaterial({ aoMap: ao });
    a.userData.fp_lightmap = "occlusion";
    const b = new THREE.MeshStandardMaterial();
    b.userData.fp_lightmap = "occlusion";
    const c = new THREE.MeshLambertMaterial();
    c.userData.fp_lightmap = { texture: 0 };
    const out = prepareLightmaps(
      model([
        [a, true],
        [a, false],
        [b, true],
        [c, true],
      ]),
      null,
      () => {},
    );
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

// minimal GLB (as check-model.test.js)
