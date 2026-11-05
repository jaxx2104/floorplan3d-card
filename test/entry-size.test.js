// The entry HA loads on every page stays small: no three.js, no card code, under ENTRY_MAX_BYTES
// minified; the card and edit mode are chunks it imports on demand (scripts/lib/card-build.mjs).
import { describe, it, expect, beforeAll } from "bun:test";
import { cardOptions, ENTRY_MAX_BYTES } from "../scripts/lib/card-build.mjs";

let outputs;
beforeAll(async () => {
  const r = await Bun.build({ ...cardOptions, outdir: undefined });
  // Bun's metafile names outputs relative to outdir ('./chunks/x.js'): as paths from the root (dist/chunks/x.js)
  const dist = (f) => "dist/" + f.replace(/^\.\//, "");
  outputs = Object.fromEntries(
    Object.entries(r.metafile.outputs)
      .filter(([f]) => f.endsWith(".js"))
      .map(([f, o]) => [
        dist(f),
        { ...o, imports: o.imports.map((i) => ({ ...i, path: dist(i.path) })) },
      ]),
  );
});

const ENTRY = "dist/floorplan3d-card.js";
const chunkOf = (src) =>
  Object.keys(outputs).find((f) => outputs[f].entryPoint === src);
// the files that load with f (its static imports, transitively)
const staticClosure = (f, seen = new Set()) => {
  if (seen.has(f)) return seen;
  seen.add(f);
  for (const i of outputs[f].imports)
    if (i.kind === "import-statement") staticClosure(i.path, seen);
  return seen;
};
const inputsOf = (files) =>
  [...files].flatMap((f) => Object.keys(outputs[f].inputs));

describe("entry size guard", () => {
  it(`the entry is at most ${ENTRY_MAX_BYTES} bytes minified`, () => {
    expect(outputs[ENTRY], "entry output").toBeTruthy();
    expect(outputs[ENTRY].bytes).toBeLessThanOrEqual(ENTRY_MAX_BYTES);
  });
  it("the entry and what it imports statically contain neither three nor card code", () => {
    const inputs = inputsOf(staticClosure(ENTRY));
    expect(inputs.filter((k) => k.includes("node_modules/"))).toEqual([]);
    expect(inputs.filter((k) => k.startsWith("src/")).sort()).toEqual([
      "src/floorplan3d-card.ts",
    ]);
  });
  it("the card, edit mode and the visual editor are dynamic chunks", () => {
    const impl = chunkOf("src/card-impl.ts"),
      edit = chunkOf("src/edit-mode.ts"),
      editor = chunkOf("src/card-editor.ts");
    for (const f of [impl, edit, editor])
      expect(f, "chunk").toMatch(/^dist\/chunks\/[\w-]+-[a-z0-9]+\.js$/);
    const dyn = outputs[ENTRY].imports
      .filter((i) => i.kind === "dynamic-import")
      .map((i) => i.path)
      .sort();
    expect(dyn).toEqual([impl, editor].sort());
    // three loads with the card; edit mode only on the first Edit
    expect(
      inputsOf(staticClosure(impl)).some((k) =>
        k.includes("node_modules/three/"),
      ),
    ).toBe(true);
    expect(staticClosure(impl).has(edit)).toBe(false);
    expect(inputsOf(staticClosure(impl))).not.toContain("src/edit-mode.ts");
    expect(
      outputs[impl].imports.some(
        (i) => i.kind === "dynamic-import" && i.path === edit,
      ),
    ).toBe(true);
  });
  it("the path tracer (quality still) is its own chunk, in neither the entry nor the card chunk", () => {
    const impl = chunkOf("src/card-impl.ts"),
      tracer = chunkOf("src/path-tracer.ts");
    expect(tracer, "chunk").toMatch(
      /^dist\/chunks\/path-tracer-[a-z0-9]+\.js$/,
    );
    const isLib = (k) =>
      /node_modules\/(three-gpu-pathtracer|three-mesh-bvh)\//.test(k);
    for (const f of [staticClosure(ENTRY), staticClosure(impl)]) {
      expect(inputsOf(f).filter(isLib)).toEqual([]);
      expect(inputsOf(f)).not.toContain("src/path-tracer.ts");
      expect(f.has(tracer)).toBe(false);
    }
    expect(
      Object.keys(outputs[tracer].inputs).some((k) =>
        k.includes("node_modules/three-gpu-pathtracer/"),
      ),
    ).toBe(true);
    expect(
      Object.keys(outputs[tracer].inputs).some((k) =>
        k.includes("node_modules/three-mesh-bvh/"),
      ),
    ).toBe(true);
    // the card imports it on demand
    expect(
      outputs[impl].imports.some(
        (i) => i.kind === "dynamic-import" && i.path === tracer,
      ),
    ).toBe(true);
  });
  it("lit (the edit panel) is in the edit chunk only", () => {
    const isLit = (k) =>
      /node_modules\/(lit|lit-html|lit-element|@lit\/[^/]+)\//.test(k);
    const edit = chunkOf("src/edit-mode.ts");
    const withLit = Object.keys(outputs).filter((f) =>
      Object.keys(outputs[f].inputs).some(isLit),
    );
    expect(withLit).toEqual([edit]);
    expect(
      Object.keys(outputs[edit].inputs).some((k) =>
        k.includes("node_modules/lit-html/"),
      ),
    ).toBe(true);
  });
});
