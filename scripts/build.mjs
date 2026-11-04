import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { cardOptions } from './lib/card-build.mjs';

const watch = process.argv.includes('--watch');
const FRONTEND = 'custom_components/floorplan3d/frontend';

// Drops the chunks of earlier builds from dir/chunks (keep: the file names of this build).
function pruneChunks(dir, keep) {
  const chunks = path.join(dir, 'chunks');
  if (!fs.existsSync(chunks)) return;
  for (const f of fs.readdirSync(chunks)) if (!keep.has(f)) fs.rmSync(path.join(chunks, f), { force: true });
}

// the companion integration serves its own copy of the card: the entry and the chunks of this build
const copyToIntegration = {
  name: 'copy-to-integration',
  setup(build) {
    build.onEnd((r) => {
      if (r.errors.length) return;
      const files = Object.keys(r.metafile.outputs).filter((f) => f.endsWith('.js')).map((f) => path.relative('dist', f));
      const chunks = new Set(files.filter((f) => f.startsWith('chunks' + path.sep)).map((f) => path.basename(f)));
      pruneChunks('dist', chunks);
      fs.rmSync(path.join(FRONTEND, 'chunks'), { recursive: true, force: true });
      fs.mkdirSync(path.join(FRONTEND, 'chunks'), { recursive: true });
      for (const f of files) fs.copyFileSync(path.join('dist', f), path.join(FRONTEND, f));
    });
  },
};

const builds = [
  { ...cardOptions, minify: !watch, plugins: [copyToIntegration] },
  // demo-only helpers (mock hass, ha-icon stand-in)
  { entryPoints: ['demo/demo.js'], outfile: 'dist/demo.js' },
];

for (const b of builds) {
  const opts = { bundle: true, format: 'esm', target: 'es2020', sourcemap: watch, logLevel: 'info', ...b };
  if (watch) await (await esbuild.context(opts)).watch();
  else await esbuild.build(opts);
}
