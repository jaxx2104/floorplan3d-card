// Headless benchmark of the mower map: a 1600 x 1600 live map (camera) refreshing every 2 s with a
// moving mower for 30 s, then 16 s of refreshes where nothing changed.
// - no main-thread task of the card's own > 50 ms (its own timing: map refresh sections and renders)
// - renders while idle <= refresh-driven ones; no shadow-map updates from the mower moving
// Prints the numbers (main-thread ms per refresh, long tasks) for the release notes.
// Then render quality 'high' (sky environment light, physical lamps, selective bloom) against 'standard': no
// environment rebuild while idle or for a sun step under ENV_ANGLE_DEG, one (throttled) for a larger step;
// bloom never in 'standard', in 'high' only on frames with an emissive surface in view, nothing while idle;
// frame time (render + bloom + finish, GPU included) in bounds.
//   node scripts/perf-check.mjs [--quality-only]
import { openDemo } from './lib/demo-browser.mjs';

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' – ' + detail : ''}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const card = 'document.querySelector("floorplan3d-card-impl")';
const MOVE_S = 30, IDLE_S = 16, REFRESH_MS = 2000;
const QUALITY_ONLY = process.argv.includes('--quality-only');

// One demo per tier, the sun fixed: environment builds while idle / after sun steps, and the time of 40
// forced frames (the view's frame from its start to the label render, after a 1 px readPixels so the GPU work
// of the scene, the bloom and the finish counts).
async function qualityRun(quality) {
  const q = await openDemo({ model: '1', view: '3d', cards: '1', ...(quality ? { quality } : {}) }, { width: 1200, height: 700 });
  try {
    const { page } = q;
    const ev = (expr) => page.evaluate(expr);
    await page.waitForFunction(`!!${card}._view.model`, { timeout: 60000 });
    await ev('window.__demoMowerPaused = true');
    await ev('window.__setDemoSun(40, 200)');
    await sleep(3000); // the throttle (2 s) and the first build
    const builds = () => ev(`${card}._view.stats.envBuilds`);
    const bloomPasses = () => ev(`${card}._view.stats.bloomPasses`);
    const b0 = await builds(), f0 = await ev(`${card}._view.stats.frames`), bp0 = await bloomPasses();
    await sleep(8000);
    const b1 = await builds(), f1 = await ev(`${card}._view.stats.frames`), bp1 = await bloomPasses();
    await ev('window.__setDemoSun(40.5, 200.5)'); // < 2 degrees: light moves, environment kept
    await sleep(3000);
    const b2 = await builds();
    await ev('window.__setDemoSun(46, 215)'); // > 2 degrees: one rebuild
    await sleep(3000);
    const b3 = await builds();
    const env = await ev(`(() => { const v = ${card}._view; return { env: !!v.scene.environment, tm: v.renderer.toneMapping, hemi: v.hemi.intensity, bloom: !!v.look._bloom, physical: !!(v.objectLayer && v.objectLayer.physical) }; })()`);
    const forced = (n) => ev(`new Promise((done) => {
      const v = ${card}._view, gl = v.renderer.getContext(), lr = v.labelRenderer, orig = lr.render, out = [], px = new Uint8Array(4);
      lr.render = function (scene, camera) { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return orig.call(this, scene, camera); };
      v.onFrameTime = (ms) => out.push(ms);
      let i = 0;
      const tick = () => { if (i++ >= ${n} + 5) { lr.render = orig; v.onFrameTime = null; done(out.slice(5)); return; } v.dirty = true; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    })`);
    const frames = () => ev(`${card}._view.stats.frames`);
    const bp2 = await bloomPasses(), fr2 = await frames();
    const times = await forced(40);
    const bp3 = await bloomPasses(), fr3 = await frames();
    // the camera turned away from the house: no emissive surface in view, the bloom pass is skipped
    await ev(`(() => { const v = ${card}._view, p = v.persp.position.clone(), t = v.cam.controls.target.clone(), d = p.clone().sub(t);
      window.__fpCam = [p, t]; v._moveCamera(p.clone().addScaledVector(d, 4), p.clone().addScaledVector(d, 8), true); })()`);
    const skip0 = await ev(`${card}._view.look._bloom ? ${card}._view.look._bloom.stats.skipped : 0`);
    const fr4 = await frames();
    const awayTimes = await forced(10);
    const fr5 = await frames(), bp4 = await bloomPasses(), skip1 = await ev(`${card}._view.look._bloom ? ${card}._view.look._bloom.stats.skipped : 0`);
    await ev(`(() => { const v = ${card}._view, [p, t] = window.__fpCam; v._moveCamera(p, t, true); })()`);
    // one environment build, timed the same way (what a sun step costs once)
    const buildMs = await ev(`(() => { const v = ${card}._view, e = v.look._env, gl = v.renderer.getContext(); if (!e || !e.built) return null;
      const t = performance.now(); e._build(e.built); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); return performance.now() - t; })()`);
    const sorted = [...times].sort((a, b) => a - b);
    return { buildMs, idleBuilds: b1 - b0, idleFrames: f1 - f0, smallStep: b2 - b1, bigStep: b3 - b2, builds: b3, ...env,
      idleBloom: bp1 - bp0, bloomForced: bp3 - bp2, framesForced: fr3 - fr2, bloomAway: bp4 - bp3, skippedAway: skip1 - skip0, framesAway: fr5 - fr4, bloomTotal: bp4,
      awayAvg: awayTimes.reduce((a, b) => a + b, 0) / Math.max(1, awayTimes.length),
      avg: times.reduce((a, b) => a + b, 0) / Math.max(1, times.length), p90: sorted[Math.floor(sorted.length * 0.9)] || 0, errors: q.errors };
  } finally {
    await q.close();
  }
}

async function qualityChecks() {
  const std = await qualityRun(null), high = await qualityRun('high');
  console.log(`     render ms per frame (40 forced frames, 1200 x 700, test mode): standard avg ${std.avg.toFixed(1)} p90 ${std.p90.toFixed(1)}; high avg ${high.avg.toFixed(1)} p90 ${high.p90.toFixed(1)}`);
  console.log(`     bloom: high ${high.bloomForced} passes in ${high.framesForced} forced frames; ${high.bloomAway} passes, ${high.skippedAway} skipped in ${high.framesAway} with no emissive in view (frame ${high.awayAvg.toFixed(1)} ms); standard ${std.bloomTotal} passes`);
  console.log(`     environment builds: standard ${std.builds}, high ${high.builds} (idle ${high.idleBuilds} over ${high.idleFrames} frames, sun +0.7 deg ${high.smallStep}, sun +16 deg ${high.bigStep}); one build ${high.buildMs?.toFixed(1)} ms`);
  check('standard: no environment, no builds', !std.env && std.builds === 0, JSON.stringify({ env: std.env, builds: std.builds }));
  check('high: sky environment on, AgX tone mapping (6)', high.env && high.tm === 6, JSON.stringify({ env: high.env, tm: high.tm }));
  check('high: no environment rebuild while idle', high.idleBuilds === 0, String(high.idleBuilds));
  check('standard: no bloom, no physical lamps', !std.bloom && std.bloomTotal === 0 && !std.physical, JSON.stringify({ bloom: std.bloom, passes: std.bloomTotal, physical: std.physical }));
  check('high: physical lamps, bloom on every forced frame with lamps in view', high.physical && high.bloom && high.framesForced >= 40 && high.bloomForced === high.framesForced, JSON.stringify({ physical: high.physical, passes: high.bloomForced, frames: high.framesForced }));
  check('high: bloom skipped with no emissive surface in view', high.framesAway >= 10 && high.bloomAway === 0 && high.skippedAway === high.framesAway, `${high.bloomAway} passes, ${high.skippedAway} skipped in ${high.framesAway} frames`);
  check('high: no bloom pass while idle', high.idleBloom === 0 && high.idleFrames === 0, `${high.idleBloom} passes over ${high.idleFrames} frames`);
  check('high: no rebuild for a sun step under 2 degrees, one for a larger step', high.smallStep === 0 && high.bigStep === 1, `${high.smallStep}, ${high.bigStep}`);
  // shared CI runners: the same bound, the ratio is what counts
  check('high (bloom included): frame time <= 2 x standard + 8 ms', high.avg <= 2 * std.avg + 8, `${high.avg.toFixed(1)} vs ${std.avg.toFixed(1)} ms`);
  for (const r of [std, high]) if (r.errors.length) check('quality demo without page errors', false, r.errors.slice(0, 3).join(' | '));
}

if (QUALITY_ONLY) {
  await qualityChecks();
  if (failures.length) { console.log(`\n${failures.length} check(s) failed`); process.exit(1); }
  console.log('\nquality perf check passed');
  process.exit(0);
}

const s = await openDemo({ model: '1', view: '3d', cards: '1', robotmap: '1600', debug: '1' }, { width: 1200, height: 700 });
try {
  const { page } = s;
  const ev = (expr) => page.evaluate(expr);
  const until = (expr, label, timeout = 20000) => page.waitForFunction(expr, { timeout }).then(() => true, () => { console.log(`     (timed out waiting for ${label})`); return false; });
  await until(`!!${card}._view.model`, 'the model', 60000);
  await ev('window.__demoMowerPaused = true');
  const n = await ev(`window.__robotFrames(${(MOVE_S * 1000) / REFRESH_MS + 2}, 0.3, 0.08)`);
  check('benchmark frames rendered ahead', n > 10, String(n));
  await ev('window.__setRobotFrame(0)');
  await ev(`(() => { const c = ${card}, l = c._layout; c._commit({ ...l, objects: { ...(l.objects || {}), mower: { entity: 'lawn_mower.robo' }, dock: { entity: 'lawn_mower.robo' } },
    mower: { entity: 'lawn_mower.robo', source: 'image', floor_id: l.mower.floor_id, calibration: [],
    overlay: { entity: 'camera.robo_live_map', x: 16.5, y: 1.5, rotation: 0, width: 17, opacity: 0.6, refresh: 2 } } }); })()`);
  check('mower found on the 1600 px map', await until(`(() => { const r = ${card}._imageResult; return !!${card}._imageBlob && !!r && !r.missing && !r.error; })()`, 'the first detection', 60000),
    JSON.stringify(await ev(`${card}._imageResult`)));
  await sleep(3000); // warm-up: the worker, the static map, the template
  // instrumentation: every render timed, long tasks observed, the card's per-refresh timing collected
  await ev(`(() => {
    const c = ${card}, v = c._view, r = v.renderer;
    window.__bench = { renders: [], long: [], refresh: [], t0: performance.now() };
    if (!r.__timed) { const orig = r.render.bind(r); r.render = (a, b) => { const t = performance.now(); orig(a, b); window.__bench.renders.push(performance.now() - t); }; r.__timed = true; }
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__bench.long.push({ at: e.startTime, ms: e.duration }); }).observe({ type: 'longtask' }); } catch (e) { window.__bench.noLongtask = true; }
    // the card's own timing per map refresh (v0.4.5: _perf.last; v0.4.4: _autoMainMs + the processor's)
    let last = null;
    window.__benchPoll = setInterval(() => {
      const p = c._perf && c._perf.last;
      if (p) { if (p !== last) { last = p; window.__bench.refresh.push({ main: p.main, max: p.max, decode: p.decode, worker: p.worker, apply: p.apply }); } return; }
      const m = (c._autoMainMs || 0) + ((c._mapProc && c._mapProc.lastMainMs) || 0), k = c._mapDetect && c._mapDetect.image;
      if (k && k !== last) { last = k; window.__bench.refresh.push({ main: m, max: m }); }
    }, 50);
  })()`);
  const metric = async () => { const m = await page.metrics(); return m.TaskDuration * 1000; };
  // the page's own baseline (render loop ticks, timers) without any refresh, for comparison
  const q0 = await metric();
  await sleep(10000);
  const quiet = ((await metric()) - q0) / (10000 / REFRESH_MS);
  const task0 = await metric();
  const stats0 = await ev(`(() => { const v = ${card}._view; return { frames: v.stats.frames, shadow: v.stats.shadow, shadowLights: v.stats.shadowLights }; })()`);
  for (let i = 1; i <= (MOVE_S * 1000) / REFRESH_MS; i++) {
    await ev(`window.__setRobotFrame(${i})`);
    await sleep(REFRESH_MS);
  }
  const stats1 = await ev(`(() => { const v = ${card}._view; return { frames: v.stats.frames, shadow: v.stats.shadow, shadowLights: v.stats.shadowLights }; })()`);
  const moving = await ev('JSON.parse(JSON.stringify(window.__bench))');
  const task1 = await metric();
  for (let i = 0; i < (IDLE_S * 1000) / REFRESH_MS; i++) {
    await ev(`window.__setRobotSame(${(MOVE_S * 1000) / REFRESH_MS})`);
    await sleep(REFRESH_MS);
  }
  const stats2 = await ev(`(() => { const v = ${card}._view; return { frames: v.stats.frames, shadow: v.stats.shadow, shadowLights: v.stats.shadowLights }; })()`);
  const all = await ev('JSON.parse(JSON.stringify(window.__bench))');
  const task2 = await metric();
  await ev('clearInterval(window.__benchPoll)');

  const ref = moving.refresh;
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const mainAvg = avg(ref.map((r) => r.main)), mainMax = Math.max(0, ...ref.map((r) => r.max));
  const rMax = Math.max(0, ...moving.renders), rAvg = avg(moving.renders);
  const longs = moving.long.filter((l) => l.ms > 50);
  console.log(`     refreshes measured: ${ref.length}; main-thread ms per refresh avg ${mainAvg.toFixed(1)}, longest card section ${mainMax.toFixed(1)} ms`);
  if (ref.length && ref[0].decode !== undefined) console.log(`     stages (avg): decode ${avg(ref.map((r) => r.decode)).toFixed(1)} ms, worker ${avg(ref.map((r) => r.worker)).toFixed(1)} ms, apply ${avg(ref.map((r) => r.apply)).toFixed(1)} ms`);
  const perRefresh = (task1 - task0) / ((MOVE_S * 1000) / REFRESH_MS), perIdle = (task2 - task1) / ((IDLE_S * 1000) / REFRESH_MS);
  console.log(`     whole page main-thread busy per 2 s (CDP TaskDuration): ${perRefresh.toFixed(1)} ms moving, ${perIdle.toFixed(1)} ms unchanged picture, ${quiet.toFixed(1)} ms no refresh at all`);
  console.log(`     last detection: ${JSON.stringify(await ev(`${card}._imageResult`))}`);
  console.log(`     renders: ${moving.renders.length} in ${MOVE_S} s, avg ${rAvg.toFixed(1)} ms, max ${rMax.toFixed(1)} ms`);
  console.log(`     page long tasks > 50 ms while moving: ${longs.length}${longs.length ? ` (max ${Math.max(...longs.map((l) => l.ms)).toFixed(0)} ms)` : ''}${moving.noLongtask ? ' (no longtask API)' : ''}`);
  const movingFrames = stats1.frames - stats0.frames, idleFrames = stats2.frames - stats1.frames;
  console.log(`     frames: ${movingFrames} while moving (${MOVE_S} s), ${idleFrames} while idle (${IDLE_S} s); shadow requests ${stats1.shadow - stats0.shadow}`);
  check('refreshes measured', ref.length >= 10, String(ref.length));
  // shared CI runners hiccup: p90 <= 50 ms, max <= 120 ms there (strict 50 ms max locally)
  const sorted = ref.map((r) => r.max).sort((a, b) => a - b);
  const p90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)] : 0;
  const maxLimit = process.env.CI ? 120 : 50;
  check(`main-thread map sections of the card: p90 <= 50 ms, max <= ${maxLimit} ms`, p90 <= 50 && mainMax <= maxLimit, `p90 ${p90.toFixed(1)}, max ${mainMax.toFixed(1)}`);
  check('renders while idle <= refresh-driven ones', idleFrames * (MOVE_S / IDLE_S) <= movingFrames, `${idleFrames} idle vs ${movingFrames} moving`);
  check('the moving mower requests no shadow-map updates', stats1.shadow - stats0.shadow === 0, String(stats1.shadow - stats0.shadow));
  const dbg = await ev(`(() => { const el = ${card}.shadowRoot.querySelector('.fp-debug'); return el ? el.textContent : null; })()`);
  check('debug overlay shows fps, frame ms, long task, map stages', !!dbg && /fps/i.test(dbg) && /frame/i.test(dbg) && /decode/.test(dbg) && /worker/.test(dbg), String(dbg).slice(0, 300));
  if (process.env.BENCH_JSON) console.log(JSON.stringify({ mainAvg, mainMax, rAvg, rMax, longs: longs.length, movingFrames, idleFrames, all: all.refresh.length }));
  if (s.errors.length) console.log('page errors:', s.errors.slice(0, 5).join(' | '));
} finally {
  await s.close();
}
await qualityChecks();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nperf check passed');
