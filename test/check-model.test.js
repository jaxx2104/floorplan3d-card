import { describe, it, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkGlb } from "../tools/check-model.mjs";
import { fp } from "./helpers/manifest.js";

// minimal GLB: JSON chunk (+ optional BIN chunk)
function glb(json, bin = null) {
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
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
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

const sq = [
  [0, 0],
  [4, 0],
  [4, 3],
];

// a mesh with POSITION bounds [-100..100] x [0..0] x [-100..100]
const bigPlane = {
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [
    {
      componentType: 5126,
      count: 3,
      type: "VEC3",
      min: [-100, 0, -100],
      max: [100, 0, 100],
    },
  ],
};

describe("checkGlb", () => {
  it("passes a well-tagged model and summarises it", () => {
    const r = checkGlb(
      glb({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0, 2] }],
        nodes: [
          {
            name: "ground",
            extras: fp({
              kind: "level",
              id: "ground",
              order: 0,
              elevation: 0,
              height: 2.7,
            }),
            children: [1],
          },
          {
            name: "kitchen",
            extras: fp({ kind: "room", id: "kitchen", outline: sq }),
          },
          {
            name: "roof",
            extras: fp({ kind: "level", id: "roof", role: "roof" }),
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ levels: 2, rooms: 1, zones: 0, objects: {} });
    expect(r.levels[0]).toEqual({
      id: "ground",
      role: "storey",
      order: 0,
      elevation: 0,
    });
  });

  it("validates the render recipe (fp.render)", () => {
    const r = checkGlb(
      glb({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [
          {
            name: "house",
            extras: fp({
              render: {
                exposure: 9,
                camera: { fov: 40 },
                toneMapping: "Nope",
                bogus: 1,
              },
            }),
            children: [1],
          },
          { name: "ground", extras: fp({ kind: "level", id: "ground" }) },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.render).toEqual({
      keys: 2,
      recipe: { exposure: 4, camera: { fov: 40 } },
    });
    expect(r.warnings).toContain(
      "render.exposure: 9 out of range 0.05..4, clamped",
    );
    expect(r.warnings.some((w) => /render.toneMapping/.test(w))).toBe(true);
  });

  it("warns about a spot target shared by a group or too far from the lamp", () => {
    const up = (id, x) => ({
      name: id,
      translation: [x, 0, 0],
      extras: fp({
        kind: "object",
        id,
        type: "light",
        group: "ups",
        hints: { beam: "up", target: [6, 0.5, 0] },
      }),
    });
    const r = checkGlb(
      glb({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0, 3] }],
        nodes: [
          {
            name: "ground",
            extras: fp({ kind: "level", id: "ground" }),
            children: [1, 2],
          },
          up("up_1", 0),
          up("up_2", 2),
          {
            name: "roof",
            extras: fp({ kind: "level", id: "roof", role: "roof" }),
          },
        ],
      }),
    );
    expect(r.warnings).toContain(
      "spot target looks wrong (shared / too far): up_1, up_2",
    );
  });

  it("warns about huge meshes inside storeys but not inside exterior", () => {
    const r = checkGlb(
      glb({
        ...bigPlane,
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0, 2] }],
        nodes: [
          {
            name: "ground",
            extras: fp({ kind: "level", id: "ground" }),
            children: [1],
          },
          { name: "plane", mesh: 0 },
          {
            name: "exterior",
            extras: fp({ kind: "level", id: "exterior", role: "exterior" }),
            children: [3],
          },
          { name: "lawn", mesh: 0 },
        ],
      }),
    );
    expect(r.warnings.filter((w) => /larger than 60 m/.test(w))).toEqual([
      expect.stringMatching(/ground\/plane/),
    ]);
  });

  it("applies node scale when measuring meshes", () => {
    const r = checkGlb(
      glb({
        ...bigPlane,
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [
          {
            name: "ground",
            extras: fp({ kind: "level", id: "ground" }),
            scale: [0.01, 0.01, 0.01],
            children: [1],
          },
          { name: "plane", mesh: 0 },
        ],
      }),
    );
    expect(r.warnings.join("\n")).not.toMatch(/larger than 60 m/);
  });

  it("reports errors, untagged models and missing roles", () => {
    const r = checkGlb(
      glb({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0, 1] }],
        nodes: [
          { name: "a", extras: fp({ kind: "level", id: "dup" }) },
          { name: "b", extras: fp({ kind: "level", id: "dup" }) },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/duplicate level id "dup"/);
    expect(r.warnings.join("\n")).toMatch(/no level with role "exterior"/);
    expect(r.warnings.join("\n")).toMatch(/no level with role "roof"/);
    const u = checkGlb(
      glb({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: "Mesh" }],
      }),
    );
    expect(u.warnings.join("\n")).toMatch(/no fp tags/);
  });

  it("measures embedded PNG textures", () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(4096, 16);
    png.writeUInt32BE(1024, 20);
    const r = checkGlb(
      glb(
        {
          asset: { version: "2.0" },
          scene: 0,
          scenes: [{ nodes: [] }],
          nodes: [],
          buffers: [{ byteLength: 24 }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 24 }],
          images: [{ bufferView: 0, mimeType: "image/png", name: "grass" }],
        },
        png,
      ),
    );
    expect(r.warnings.join("\n")).toMatch(/texture "grass" is 4096 × 1024/);
  });

  it("reports the material classes and the KHR material extensions", () => {
    const r = checkGlb(
      glb({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0, 1, 2] }],
        nodes: [
          { name: "pane", mesh: 0 },
          { name: "sofa", mesh: 1 },
          { name: "vase", mesh: 2 },
        ],
        meshes: [0, 1, 2].map((i) => ({
          primitives: [{ attributes: { POSITION: 0 }, material: i }],
        })),
        accessors: [bigPlane.accessors[0]],
        materials: [
          { name: "Window glass" },
          { name: "Velvet", extras: { fp_surface: "fabric" } },
          {
            name: "Glass",
            extensions: {
              KHR_materials_transmission: {},
              KHR_materials_ior: {},
            },
          },
        ],
      }),
    );
    expect(r.materials).toEqual({
      count: 3,
      classes: { glass: 1, floor: 0, fabric: 1 },
      fromFile: 1,
      extensions: { KHR_materials_transmission: 1, KHR_materials_ior: 1 },
    });
  });

  it("rejects a file that is not a GLB", () => {
    expect(checkGlb(Buffer.from("hello world, not a model"))).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/not a binary glTF/)],
    });
  });

  it("handles missing child nodes without throwing", () => {
    const r = checkGlb(
      glb({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [
          {
            name: "root",
            extras: fp({ kind: "level", id: "ground" }),
            children: [5],
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /invalid node structure/.test(e))).toBe(true);
  });

  it("does not crash on malformed mesh data (missing meshes array)", () => {
    const r = checkGlb(
      glb({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [
          {
            name: "ground",
            extras: fp({ kind: "level", id: "ground" }),
            children: [1],
          },
          { name: "m", mesh: 3 },
        ],
      }),
    );
    // a dangling mesh index is no model error: the level is still read
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.levels.map((l) => l.id)).toEqual(["ground"]);
  });
});

// resolved from this file, so the suite runs from any working directory
const CLI = path.join(import.meta.dirname, "..", "tools", "check-model.mjs");

describe("CLI", () => {
  it("prints a report and exits 1 on errors", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-"));
    const file = path.join(dir, "bad.glb");
    fs.writeFileSync(
      file,
      glb({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0, 1] }],
        nodes: [
          { name: "a", extras: fp({ kind: "level", id: "x" }) },
          { name: "b", extras: fp({ kind: "level", id: "x" }) },
        ],
      }),
    );
    let code = 0,
      out = "";
    try {
      execFileSync(process.execPath, [CLI, file], {
        encoding: "utf8",
      });
    } catch (e) {
      code = e.status;
      out = e.stdout;
    }
    expect(code).toBe(1);
    expect(out).toMatch(/ERROR .*duplicate level id "x"/);
    const json = JSON.parse(
      execFileSync(process.execPath, [CLI, file, "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).toString() || "{}",
    );
    expect(json.ok).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 on unreadable file in text mode", () => {
    let code = 0,
      out = "";
    try {
      execFileSync(process.execPath, [CLI, "/nonexistent/path.glb"], {
        encoding: "utf8",
      });
    } catch (e) {
      code = e.status;
      out = e.stdout;
    }
    expect(code).toBe(1);
    expect(out).toMatch(/ERROR .*cannot read.*\/nonexistent\/path\.glb/);
  });

  it("exits 0 with JSON ok:false on unreadable file in JSON mode", () => {
    let code;
    let out;
    try {
      out = execFileSync(
        process.execPath,
        [CLI, "/nonexistent/path.glb", "--json"],
        { encoding: "utf8" },
      );
      code = 0;
    } catch (e) {
      code = e.status;
      out = e.stdout || "";
    }
    expect(code).toBe(0);
    const json = JSON.parse(out || "{}");
    expect(json.ok).toBe(false);
    expect(json.errors.some((e) => /cannot read/.test(e))).toBe(true);
  });
});

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
