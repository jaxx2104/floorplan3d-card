// The card's esbuild options, shared by scripts/build.mjs and the entry size guard (test/entry-size.test.js).
// A small entry (dist/floorplan3d-card.js, the HA resource) and content-hashed chunks in dist/chunks/
// that it imports on demand: the card with three.js on first show, edit mode on the first Edit, the
// visual editor. The entry name is stable, the chunks can be cached forever.
export const cardOptions = {
  entryPoints: { 'floorplan3d-card': 'src/floorplan3d-card.ts' },
  bundle: true,
  format: 'esm',
  target: 'es2020',
  outdir: 'dist',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  metafile: true,
  minify: true,
};

// The entry's limit (minified bytes): it loads on every HA page, dashboards without the card included.
export const ENTRY_MAX_BYTES = 15 * 1024;
