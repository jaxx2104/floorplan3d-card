// The entry HA loads on every page stays small: no three.js, no card code, under ENTRY_MAX_BYTES
// minified; the card is a chunk it imports on demand (scripts/lib/card-build.mjs).
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
  it("the card is a dynamic chunk with three", () => {
    const impl = chunkOf("src/card-impl.ts");
    expect(impl, "chunk").toMatch(/^dist\/chunks\/[\w-]+-[a-z0-9]+\.js$/);
    const dyn = outputs[ENTRY].imports
      .filter((i) => i.kind === "dynamic-import")
      .map((i) => i.path);
    expect(dyn).toEqual([impl]);
    expect(
      inputsOf(staticClosure(impl)).some((k) =>
        k.includes("node_modules/three/"),
      ),
    ).toBe(true);
  });
});
