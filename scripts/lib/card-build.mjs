// The card's Bun.build options, shared by scripts/build.mjs and the entry size guard (test/entry-size.test.js).
// A small entry (dist/floorplan3d-card.js, the HA resource) and content-hashed chunks in dist/chunks/
// that it imports on demand: the card with three.js on first show, edit mode on the first Edit, the
// visual editor. The entry name is stable, the chunks can be cached forever.
export const cardOptions = {
  entrypoints: ["src/floorplan3d-card.ts"],
  target: "browser",
  format: "esm",
  outdir: "dist",
  splitting: true,
  naming: { entry: "[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
  // plain import() calls: no modulepreload helper chunk that the entry would load on every HA page
  modulePreload: false,
  metafile: true,
  minify: true,
  ...productionBuild(),
};

// The production builds of dependencies (lit), whose "development" export condition Bun picks unless
// NODE_ENV is production. Shared with the demo bundle.
export function productionBuild() {
  return { define: { "process.env.NODE_ENV": '"production"' } };
}

// The entry's limit (minified bytes): it loads on every HA page, dashboards without the card included.
export const ENTRY_MAX_BYTES = 15 * 1024;
