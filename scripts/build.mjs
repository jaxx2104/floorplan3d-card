import fs from "node:fs";
import path from "node:path";
import { cardOptions, productionBuild } from "./lib/card-build.mjs";

const watch = process.argv.includes("--watch");
const FRONTEND = "custom_components/floorplan3d/frontend";

// Drops the chunks of earlier builds from dir/chunks (keep: the file names of this build).
function pruneChunks(dir, keep) {
  const chunks = path.join(dir, "chunks");
  if (!fs.existsSync(chunks)) return;
  for (const f of fs.readdirSync(chunks))
    if (!keep.has(f)) fs.rmSync(path.join(chunks, f), { force: true });
}

// the companion integration serves its own copy of the card: the entry and the chunks of this build
function copyToIntegration(outputs) {
  const files = outputs.map((o) => path.relative("dist", o.path));
  pruneChunks(
    "dist",
    new Set(
      files
        .filter((f) => f.startsWith("chunks" + path.sep))
        .map((f) => path.basename(f)),
    ),
  );
  fs.rmSync(path.join(FRONTEND, "chunks"), { recursive: true, force: true });
  fs.mkdirSync(path.join(FRONTEND, "chunks"), { recursive: true });
  for (const f of files)
    if (f.endsWith(".js"))
      fs.copyFileSync(path.join("dist", f), path.join(FRONTEND, f));
}

const builds = [
  { ...cardOptions, minify: !watch, after: copyToIntegration },
  // demo-only helpers (mock hass, ha-icon stand-in)
  {
    entrypoints: ["demo/demo.js"],
    outdir: "dist",
    naming: "[name].[ext]",
    ...productionBuild(),
  },
];

const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

async function buildAll() {
  let ok = true;
  for (const { after, ...b } of builds) {
    const t0 = performance.now();
    const r = await Bun.build({
      target: "browser",
      format: "esm",
      sourcemap: watch ? "linked" : "none",
      throw: false,
      ...b,
    });
    for (const log of r.logs) console.error(log);
    if (!r.success) {
      ok = false;
      continue;
    }
    after?.(r.outputs);
    for (const o of r.outputs
      .filter((o) => o.kind !== "sourcemap")
      .sort((a, b) => b.size - a.size))
      console.log(
        `  ${path.relative(".", o.path).padEnd(40)} ${kb(o.size).padStart(9)}`,
      );
    console.log(`  done in ${Math.round(performance.now() - t0)} ms\n`);
  }
  return ok;
}

if (!(await buildAll()) && !watch) process.exit(1);
if (watch) {
  // Bun.build has no watch mode: rebuild on source changes, debounced
  let timer = null;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(buildAll, 50);
  };
  for (const dir of ["src", "demo"])
    fs.watch(dir, { recursive: true }, rebuild);
  console.log("watching src/ and demo/");
}
