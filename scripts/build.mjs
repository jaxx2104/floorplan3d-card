import fs from 'node:fs';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const builds = [
  // the card itself, a single ES module for /config/www
  { entryPoints: ['src/floorplan3d-card.ts'], outfile: 'dist/floorplan3d-card.js', minify: !watch },
  // demo-only helpers (mock hass, ha-icon stand-in)
  { entryPoints: ['demo/demo.js'], outfile: 'dist/demo.js' },
];

// the companion integration serves its own copy of the card
const copyToIntegration = {
  name: 'copy-to-integration',
  setup(build) {
    build.onEnd((r) => {
      if (r.errors.length) return;
      fs.mkdirSync('custom_components/floorplan3d/frontend', { recursive: true });
      fs.copyFileSync('dist/floorplan3d-card.js', 'custom_components/floorplan3d/frontend/floorplan3d-card.js');
    });
  },
};
builds[0].plugins = [copyToIntegration];

for (const b of builds) {
  const opts = { bundle: true, format: 'esm', target: 'es2020', sourcemap: watch, logLevel: 'info', ...b };
  if (watch) await (await esbuild.context(opts)).watch();
  else await esbuild.build(opts);
}
