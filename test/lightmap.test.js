import { describe, it, expect, vi } from "bun:test";
import * as THREE from "three";
import {
  normLightmap,
  lightmapTexCoord,
  uvAttribute,
  bakedRooms,
  insidePolygon,
  BAKED_ROOM_SHARE,
} from "../src/lightmap.ts";
import { prepareLightmaps, applyLightmap } from "../src/view/indirect.ts";
import { checkGlb } from "../tools/check-model.mjs";

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
    expect(BAKED_ROOM_SHARE).toBe(0.5);
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
function glb(json, bin = null) {
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const pad = (b, c) =>
    Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, c)]);
  const j = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const chunks = [Buffer.concat([u32(j.length), Buffer.from("JSON"), j])];
  if (bin) {
    const b = pad(bin, 0);
    chunks.push(Buffer.concat([u32(b.length), Buffer.from("BIN\0"), b]));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([
    Buffer.from("glTF"),
    u32(2),
    u32(12 + body.length),
    body,
  ]);
}
// a PNG header (signature + IHDR) of w x h: enough for the size check
function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

describe("check-model: lightmaps", () => {
  const file = ({
    extras,
    occlusion,
    attrs = { POSITION: 0, TEXCOORD_0: 1, TEXCOORD_1: 2 },
    size = 1024,
  }) => {
    const img = png(size, size);
    return glb(
      {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [
          {
            name: "ground",
            extras: { fp: { kind: "level", id: "ground" } },
            children: [1],
          },
          { name: "wall", mesh: 0 },
        ],
        meshes: [
          { name: "wall", primitives: [{ attributes: attrs, material: 0 }] },
        ],
        accessors: [
          {
            componentType: 5126,
            count: 3,
            type: "VEC3",
            min: [0, 0, 0],
            max: [1, 1, 1],
          },
          { componentType: 5126, count: 3, type: "VEC2" },
          { componentType: 5126, count: 3, type: "VEC2" },
        ],
        materials: [
          {
            name: "wall_baked",
            ...(occlusion
              ? { occlusionTexture: { index: 0, texCoord: 1 } }
              : {}),
            extras,
          },
        ],
        textures: [{ source: 0 }, { source: 0 }],
        images: [{ bufferView: 0, mimeType: "image/png" }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: img.length }],
        buffers: [{ byteLength: img.length }],
      },
      img,
    );
  };
  it("a valid occlusion lightmap on TEXCOORD_1 passes and is reported", () => {
    const r = checkGlb(
      file({ extras: { fp_lightmap: "occlusion" }, occlusion: true }),
    );
    expect(r.errors).toEqual([]);
    expect(r.lightmaps).toEqual([
      {
        material: "wall_baked",
        texture: 0,
        texCoord: 1,
        type: "light",
        size: [1024, 1024],
      },
    ]);
  });
  it("a texture index lightmap, its UV set missing on a mesh: error", () => {
    const r = checkGlb(
      file({
        extras: { fp_lightmap: { texture: 1 } },
        attrs: { POSITION: 0, TEXCOORD_0: 1 },
      }),
    );
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) =>
        /reads TEXCOORD_1, missing on mesh\(es\) wall/.test(e),
      ),
    ).toBe(true);
  });
  it("errors: no occlusionTexture, a missing texture, an invalid spec, a lightmap over 4096 px", () => {
    expect(
      checkGlb(file({ extras: { fp_lightmap: "occlusion" } })).errors.some(
        (e) => /no occlusionTexture/.test(e),
      ),
    ).toBe(true);
    expect(
      checkGlb(file({ extras: { fp_lightmap: { texture: 9 } } })).errors.some(
        (e) => /texture 9 does not exist/.test(e),
      ),
    ).toBe(true);
    expect(
      checkGlb(
        file({ extras: { fp_lightmap: { texture: 1, texCoord: 9 } } }),
      ).errors.some((e) => /texCoord/.test(e)),
    ).toBe(true);
    const big = checkGlb(
      file({
        extras: { fp_lightmap: "occlusion" },
        occlusion: true,
        size: 8192,
      }),
    );
    expect(big.errors.some((e) => /8192 × 8192 px; at most 4096/.test(e))).toBe(
      true,
    );
  });
  it("error: an occlusion lightmap packed into the metallic-roughness texture", () => {
    const buf = file({ extras: { fp_lightmap: "occlusion" }, occlusion: true });
    const json = JSON.parse(
      buf.toString("utf8", 20, 20 + buf.readUInt32LE(12)),
    );
    json.materials[0].pbrMetallicRoughness = {
      metallicRoughnessTexture: { index: 0 },
    };
    const img = png(64, 64);
    json.bufferViews[0].byteLength = json.buffers[0].byteLength = img.length;
    expect(
      checkGlb(glb(json, img)).errors.some((e) =>
        /packed by the exporter/.test(e),
      ),
    ).toBe(true);
  });
  it("warnings: TEXCOORD_0 (needs its own unwrap), unknown keys", () => {
    const r = checkGlb(
      file({
        extras: { fp_lightmap: { texture: 1, texCoord: 0, bogus: true } },
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /TEXCOORD_0/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /fp_lightmap.bogus/.test(w))).toBe(true);
  });
  it("models without lightmaps: an empty list", () => {
    expect(checkGlb(file({ extras: {} })).lightmaps).toEqual([]);
  });
});
