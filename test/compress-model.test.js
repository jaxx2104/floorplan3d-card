// tools/compress-model.mjs: the compressed model loads in GLTFLoader (with the card's MeshoptDecoder) as the
// same scene: nodes, extras, materials and geometry kept, float attributes still float32.
import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { compressModel } from "../tools/compress-model.mjs";

const input = fs.readFileSync(new URL("../demo/house.glb", import.meta.url));
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const load = (buf) =>
  new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(ab(buf), "");
// meshes in traversal order: path of names, extras, material names, triangle count, world box
function meshes(root) {
  root.updateMatrixWorld(true);
  const out = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    out.push({
      name: o.name,
      extras: o.userData,
      material: [].concat(o.material).map((m) => m.name),
      triangles: (g.index ? g.index.count : g.attributes.position.count) / 3,
      vertices: g.attributes.position.count,
      attributes: Object.keys(g.attributes).sort(),
      box: new THREE.Box3().setFromObject(o),
      geometry: g,
    });
  });
  return out;
}

let result, a, b;
beforeAll(async () => {
  result = await compressModel(input, { check: true });
  a = meshes((await load(input)).scene);
  b = meshes((await load(result.output)).scene);
});

describe("compress-model", () => {
  it("is smaller and decodes back within the filter's error", () => {
    expect(result.output.length).toBeLessThan(input.length);
    for (const [k, e] of Object.entries(result.errors))
      expect(e, k).toBeLessThan(k === "indices" ? 1e-9 : 5e-3);
  });

  it("keeps every mesh with its name, extras, materials and size", () => {
    expect(b.length).toBe(a.length);
    a.forEach((m, i) => {
      const n = b[i];
      expect(n.name).toBe(m.name);
      expect(n.extras).toEqual(m.extras);
      expect(n.material).toEqual(m.material);
      expect(n.triangles).toBe(m.triangles);
      expect(n.vertices).toBe(m.vertices);
      expect(n.attributes).toEqual(m.attributes);
      for (const k of ["min", "max"])
        for (const c of ["x", "y", "z"])
          expect(Math.abs(n.box[k][c] - m.box[k][c])).toBeLessThan(5e-3);
    });
  });

  it("decodes to plain float32 attributes the merge can bake", () => {
    for (const m of b)
      for (const [k, attr] of Object.entries(m.geometry.attributes)) {
        expect(attr.isInterleavedBufferAttribute, k).toBeFalsy();
        expect(attr.array, k).toBeInstanceOf(Float32Array);
        expect(attr.normalized, k).toBe(false);
      }
  });

  it("refuses a model that is compressed already", async () => {
    await expect(compressModel(result.output)).rejects.toThrow(
      "EXT_meshopt_compression",
    );
  });
});
