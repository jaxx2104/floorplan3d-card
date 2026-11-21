#!/usr/bin/env node
// Compresses the geometry of a house model with EXT_meshopt_compression, for a smaller download.
//   node tools/compress-model.mjs in.glb out.glb          writes out.glb, prints the sizes
//   node tools/compress-model.mjs in.glb out.glb --check  also decodes it back and prints the largest errors
// Only buffer views change: nodes, meshes, materials, extras and images stay exactly as they are. Indexed
// triangle lists get their vertices and triangles reordered first (the same triangles over the same vertex
// data, in the order meshopt's delta coding packs best).
// Float attributes go through the EXPONENTIAL filter, so they decode to float32 again (no
// KHR_mesh_quantization, no dequantization transforms on the nodes): the card's merge and picking see the
// same kind of data as an uncompressed file. Lossy only below the bits chosen per attribute (FLOAT_BITS).
import fs from "node:fs";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { MeshoptDecoder } from "meshoptimizer/decoder";

const EXT = "EXT_meshopt_compression";
// Mantissa bits of the EXPONENTIAL filter per attribute, and how exponents are shared. Positions and UVs
// share one exponent per component across a block (a fixed grid, like quantization): 16 bits keep a 2 m
// part to 0.1 mm, the 100 m site to 4 mm; 14 bits keep a lightmap UV to 1/16 of a 2048 px texel. Normals
// share one per vector: 8 bits are within 0.25 degrees.
const FLOAT_BITS = {
  POSITION: [16, "SharedComponent"],
  NORMAL: [8, "SharedVector"],
  TANGENT: [8, "SharedVector"],
  TEXCOORD: [14, "SharedComponent"],
};
const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

function readGlb(buf) {
  if (buf.toString("latin1", 0, 4) !== "glTF" || buf.readUInt32LE(4) !== 2)
    throw new Error("not a glTF 2.0 binary");
  let off = 12,
    json = null,
    bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off),
      type = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8"));
    else if (type === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  if (!json) throw new Error("no JSON chunk");
  return { json, bin };
}

function writeGlb(json, bin) {
  const pad = (b, fill) => {
    const n = (4 - (b.length % 4)) % 4;
    return n ? Buffer.concat([b, Buffer.alloc(n, fill)]) : b;
  };
  const j = pad(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const b = pad(bin, 0);
  const head = Buffer.alloc(12);
  head.write("glTF", 0, "latin1");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8);
  const chunk = (len, type) => {
    const c = Buffer.alloc(8);
    c.writeUInt32LE(len, 0);
    c.writeUInt32LE(type, 4);
    return c;
  };
  return Buffer.concat([
    head,
    chunk(j.length, 0x4e4f534a),
    j,
    chunk(b.length, 0x004e4942),
    b,
  ]);
}

const filterOf = (semantic) =>
  FLOAT_BITS[semantic.replace(/_\d+$/, "")] || null;

// How each buffer view is used: { kind: "attr", accessor, semantic } | { kind: "index", accessor } |
// "other" (images, animation, sparse, shared views: copied as they are).
function viewUses(json) {
  const uses = new Map();
  const mark = (view, use) => {
    if (view === undefined) return;
    uses.set(view, uses.has(view) ? "other" : use);
  };
  const accessorUse = new Map();
  for (const mesh of json.meshes || [])
    for (const p of mesh.primitives || []) {
      for (const [semantic, a] of Object.entries(p.attributes || {}))
        accessorUse.set(
          a,
          accessorUse.has(a) && accessorUse.get(a).semantic !== semantic
            ? null
            : { kind: "attr", semantic },
        );
      if (p.indices !== undefined) {
        const triangles = (p.mode ?? 4) === 4;
        const prev = accessorUse.get(p.indices);
        accessorUse.set(
          p.indices,
          prev && (prev.kind !== "index" || prev.triangles !== triangles)
            ? null
            : { kind: "index", triangles },
        );
      }
      for (const t of p.targets || [])
        for (const a of Object.values(t)) accessorUse.set(a, null);
    }
  (json.accessors || []).forEach((acc, i) => {
    if (acc.sparse) {
      mark(acc.sparse.indices.bufferView, "other");
      mark(acc.sparse.values.bufferView, "other");
    }
    const u = accessorUse.get(i);
    mark(
      acc.bufferView,
      u && !(acc.byteOffset > 0) && !acc.sparse
        ? { ...u, accessor: i }
        : "other",
    );
  });
  for (const img of json.images || []) mark(img.bufferView, "other");
  return uses;
}

function encodeView(json, bin, view, use) {
  const acc = json.accessors[use.accessor];
  const comp = COMPONENT_SIZE[acc.componentType],
    n = TYPE_COUNT[acc.type];
  const size = comp * n,
    count = acc.count;
  if (view.byteStride && view.byteStride !== size) return null;
  if (view.buffer !== 0 || view.byteLength < size * count) return null;
  const src = new Uint8Array(
    bin.buffer,
    bin.byteOffset + (view.byteOffset || 0),
    size * count,
  ).slice();
  if (use.kind === "index") {
    if (acc.type !== "SCALAR" || (comp !== 2 && comp !== 4)) return null;
    const mode = use.triangles && count % 3 === 0 ? "TRIANGLES" : "INDICES";
    return {
      data: MeshoptEncoder.encodeGltfBuffer(src, count, size, mode),
      mode,
      stride: size,
      count,
      filter: null,
    };
  }
  if (size % 4 !== 0 || size > 256) return null;
  const f =
    acc.componentType === 5126 && !acc.normalized
      ? filterOf(use.semantic)
      : null;
  if (f) {
    const floats = new Float32Array(src.buffer, 0, count * n);
    const filtered = MeshoptEncoder.encodeFilterExp(
      floats,
      count,
      size,
      f[0],
      f[1],
    );
    return {
      data: MeshoptEncoder.encodeGltfBuffer(
        filtered,
        count,
        size,
        "ATTRIBUTES",
      ),
      mode: "ATTRIBUTES",
      stride: size,
      count,
      filter: "EXPONENTIAL",
    };
  }
  return {
    data: MeshoptEncoder.encodeGltfBuffer(src, count, size, "ATTRIBUTES"),
    mode: "ATTRIBUTES",
    stride: size,
    count,
    filter: null,
  };
}

// Groups of primitives whose vertices can be reordered together: indexed triangle lists over the same
// attribute accessors (a mesh with several materials shares one vertex set), used by no other primitive,
// each with its own index accessor (the reorder rewrites them in place).
function reorderable(json, uses) {
  const count = new Map();
  const add = (a) => count.set(a, (count.get(a) || 0) + 1);
  const groups = new Map();
  for (const mesh of json.meshes || [])
    for (const p of mesh.primitives || []) {
      for (const a of Object.values(p.attributes || {})) add(a);
      if (p.indices !== undefined) add(p.indices);
      const key = JSON.stringify(Object.entries(p.attributes || {}).sort());
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
  const simpleView = (a) => {
    const u = uses.get(json.accessors[a].bufferView);
    return u && u !== "other";
  };
  return [...groups.values()].filter(
    (prims) =>
      prims.every(
        (p) =>
          (p.mode ?? 4) === 4 &&
          p.indices !== undefined &&
          !p.targets &&
          count.get(p.indices) === 1 &&
          simpleView(p.indices) &&
          json.accessors[p.indices].count % 3 === 0,
      ) &&
      Object.values(prims[0].attributes).every(
        (a) => count.get(a) === prims.length && simpleView(a),
      ),
  );
}

const viewBytes = (json, buf, a) => {
  const acc = json.accessors[a],
    view = json.bufferViews[acc.bufferView];
  const size = COMPONENT_SIZE[acc.componentType] * TYPE_COUNT[acc.type];
  return {
    bytes: buf.subarray(
      view.byteOffset || 0,
      (view.byteOffset || 0) + size * acc.count,
    ),
    size,
    acc,
  };
};
const readIndices = (json, buf, a) => {
  const { bytes, acc } = viewBytes(json, buf, a);
  const src =
    acc.componentType === 5125
      ? new Uint32Array(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
        )
      : acc.componentType === 5123
        ? new Uint16Array(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.length,
            ),
          )
        : new Uint8Array(bytes);
  return Uint32Array.from(src);
};

// Reorders the vertices of each reorderable group for the vertex cache and fetch locality (what makes
// meshopt's delta coding work), in `work` (a copy of the BIN chunk). The vertex count stays: unused
// vertices go to the end, so accessor min / max and counts do not change. Returns, per primitive, the
// new -> old vertex map (for checkModel).
function reorderVertices(json, work, uses) {
  const maps = new Map();
  for (const prims of reorderable(json, uses)) {
    const attrs = prims[0].attributes;
    const vertices =
      json.accessors[attrs.POSITION ?? Object.values(attrs)[0]].count;
    const lists = prims.map((p) => readIndices(json, work, p.indices));
    if (lists.some((l) => l.some((i) => i >= vertices))) continue;
    const idx = new Uint32Array(lists.reduce((n, l) => n + l.length, 0));
    let at = 0;
    for (const l of lists) {
      idx.set(l, at);
      at += l.length;
    }
    const [remap] = MeshoptEncoder.reorderMesh(idx, true, false); // idx is rewritten to the new order
    let next = 0;
    for (const r of remap) if (r !== 0xffffffff) next = Math.max(next, r + 1);
    const back = new Uint32Array(vertices);
    for (let v = 0; v < vertices; v++) {
      if (remap[v] === 0xffffffff) remap[v] = next++;
      back[remap[v]] = v;
    }
    for (const a of Object.values(attrs)) {
      const { bytes, size } = viewBytes(json, work, a);
      const old = Buffer.from(bytes);
      for (let v = 0; v < vertices; v++)
        old.copy(bytes, remap[v] * size, v * size, (v + 1) * size);
    }
    at = 0;
    prims.forEach((p, k) => {
      const ia = viewBytes(json, work, p.indices);
      const part = idx.subarray(at, at + lists[k].length);
      at += lists[k].length;
      const T =
        ia.acc.componentType === 5125
          ? Uint32Array
          : ia.acc.componentType === 5123
            ? Uint16Array
            : Uint8Array;
      ia.bytes.set(new Uint8Array(T.from(part).buffer));
      maps.set(p, back);
    });
  }
  return maps;
}

function packModel(json, work, uses) {
  const parts = [];
  let packed = 0,
    fallback = 0;
  const push = (data) => {
    const at = packed;
    parts.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    packed += data.byteLength;
    const n = (4 - (packed % 4)) % 4;
    if (n) {
      parts.push(Buffer.alloc(n));
      packed += n;
    }
    return at;
  };
  const views = json.bufferViews.map((view, i) => {
    const use = uses.get(i);
    const enc =
      use && use !== "other" ? encodeView(json, work, view, use) : null;
    if (!enc)
      return {
        ...view,
        byteOffset: push(
          work.subarray(
            view.byteOffset || 0,
            (view.byteOffset || 0) + view.byteLength,
          ),
        ),
      };
    const ext = {
      buffer: 0,
      byteOffset: push(enc.data),
      byteLength: enc.data.byteLength,
      byteStride: enc.stride,
      mode: enc.mode,
      count: enc.count,
    };
    if (enc.filter) ext.filter = enc.filter;
    const out = {
      ...view,
      buffer: 1,
      byteOffset: fallback,
      extensions: { ...view.extensions, [EXT]: ext },
    };
    if (enc.mode === "ATTRIBUTES") out.byteStride = enc.stride;
    fallback += view.byteLength + ((4 - (view.byteLength % 4)) % 4);
    return out;
  });
  const out = structuredClone(json);
  out.bufferViews = views;
  out.buffers = [
    { ...json.buffers[0], byteLength: packed },
    { byteLength: fallback, extensions: { [EXT]: { fallback: true } } },
  ];
  out.extensionsUsed = [...new Set([...(json.extensionsUsed || []), EXT])];
  out.extensionsRequired = [
    ...new Set([...(json.extensionsRequired || []), EXT]),
  ];
  return writeGlb(out, Buffer.concat(parts));
}

// Triangles as sorted, rotation-canonical keys (winding kept): equal lists = the same mesh.
function triangleKeys(idx, toOld) {
  const keys = [];
  for (let t = 0; t < idx.length; t += 3) {
    let a = idx[t],
      b = idx[t + 1],
      c = idx[t + 2];
    if (toOld) [a, b, c] = [toOld[a], toOld[b], toOld[c]];
    while (a > b || a > c) [a, b, c] = [b, c, a];
    keys.push(`${a},${b},${c}`);
  }
  return keys.sort();
}

// The check: (1) each reordered primitive draws the same triangles over the same vertices as before;
// (2) every compressed view decodes back to the reordered data (indices up to the triangle rotation the
// TRIANGLES mode allows, floats within the filter's error). Returns the largest error per semantic.
async function checkModel(json, bin, work, maps, output) {
  await MeshoptDecoder.ready;
  const worst = {};
  const note = (k, e) => (worst[k] = Math.max(worst[k] || 0, e));
  const seen = new Set();
  for (const [p, back] of maps) {
    const same =
      triangleKeys(readIndices(json, bin, p.indices)).join() ===
      triangleKeys(readIndices(json, work, p.indices), back).join();
    let moved = same;
    for (const a of Object.values(p.attributes)) {
      if (seen.has(a)) continue;
      seen.add(a);
      const o = viewBytes(json, bin, a),
        w = viewBytes(json, work, a);
      for (let v = 0; v < back.length && moved; v++)
        moved = o.bytes
          .subarray(back[v] * o.size, (back[v] + 1) * o.size)
          .equals(w.bytes.subarray(v * w.size, (v + 1) * w.size));
    }
    if (!moved) note("reorder", Infinity);
  }
  const b = readGlb(output);
  const uses = viewUses(json);
  b.json.bufferViews.forEach((view, i) => {
    const ext = view.extensions && view.extensions[EXT];
    if (!ext) return;
    const target = new Uint8Array(ext.count * ext.byteStride);
    const src = new Uint8Array(
      b.bin.buffer,
      b.bin.byteOffset + ext.byteOffset,
      ext.byteLength,
    );
    MeshoptDecoder.decodeGltfBuffer(
      target,
      ext.count,
      ext.byteStride,
      src,
      ext.mode,
      ext.filter || "NONE",
    );
    const v0 = json.bufferViews[i];
    const orig = Buffer.from(
      work.subarray(v0.byteOffset || 0, (v0.byteOffset || 0) + target.length),
    );
    const use = uses.get(i);
    if (use.kind === "index") {
      const T = ext.byteStride === 4 ? Uint32Array : Uint16Array;
      const x = new T(target.buffer),
        y = new T(
          orig.buffer.slice(orig.byteOffset, orig.byteOffset + orig.length),
        );
      const eq =
        ext.mode === "TRIANGLES"
          ? triangleKeys(x).join() === triangleKeys(y).join()
          : Buffer.from(target).equals(orig);
      note("indices", eq ? 0 : Infinity);
    } else if (ext.filter === "EXPONENTIAL") {
      const x = new Float32Array(target.buffer),
        y = new Float32Array(
          orig.buffer.slice(orig.byteOffset, orig.byteOffset + orig.length),
        );
      let e = 0;
      for (let k = 0; k < x.length; k++) e = Math.max(e, Math.abs(x[k] - y[k]));
      note(use.semantic, e);
    } else note(use.semantic, Buffer.from(target).equals(orig) ? 0 : Infinity);
  });
  return worst;
}

export async function compressModel(input, { check = false } = {}) {
  await MeshoptEncoder.ready;
  const { json, bin } = readGlb(input);
  if ((json.extensionsUsed || []).includes(EXT))
    throw new Error(`already uses ${EXT}`);
  if (!bin || (json.buffers || []).length !== 1)
    throw new Error("expects one embedded buffer");
  const uses = viewUses(json);
  const work = Buffer.from(bin);
  const maps = reorderVertices(json, work, uses);
  const output = packModel(json, work, uses);
  return {
    output,
    errors: check ? await checkModel(json, bin, work, maps, output) : null,
    reordered: maps.size,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [inPath, outPath] = process.argv
    .slice(2)
    .filter((s) => !s.startsWith("--"));
  if (!inPath || !outPath) {
    console.error(
      "usage: node tools/compress-model.mjs in.glb out.glb [--check]",
    );
    process.exit(2);
  }
  const input = fs.readFileSync(inPath);
  const { output, errors, reordered } = await compressModel(input, {
    check: process.argv.includes("--check"),
  });
  fs.writeFileSync(outPath, output);
  const mb = (n) => (n / 1e6).toFixed(2) + " MB";
  console.log(
    `${inPath} ${mb(input.length)} -> ${outPath} ${mb(output.length)} (${reordered} primitives reordered)`,
  );
  if (errors) {
    for (const [k, v] of Object.entries(errors))
      console.log(
        `  ${k}: ${v === Infinity ? "MISMATCH" : v === 0 ? "exact" : "max error " + v.toExponential(2)}`,
      );
    if (Object.values(errors).includes(Infinity)) process.exit(1);
  }
}
