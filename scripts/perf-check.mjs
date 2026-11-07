// Headless checks of the render loop's work, by counters (frames, shadow requests, environment / contact builds,
// probes baked, bloom passes, model material ids, shader programs, path tracer sessions / steps, auto switches),
// state flags and condition waits; no frame-time budget blocks. Section groups (scripts/lib/sections.mjs):
// - quality-standard, quality-high: the same light in both tiers (sky environment light, physical lamps, contact
//   shadows, physical materials, light probe grids, AgX); 'high' adds the selective bloom and a finer probe grid
//   (QualityTier.probeSpacing): what each tier builds at load, nothing while idle (no pending work, a window of animation frames without a frame), an
//   environment rebuild only for a sun step over ENV_ANGLE_DEG, bloom only with an emissive surface in view,
//   contact shadows rebuilt only when the casters change, probes rebaked once (at most twice) per input
//   change (a lamp: its storey's grid only), physical materials made by the loader in both tiers and never replaced (idle, tier change).
// - still: render quality 'still' (idle progressive path tracing).
// - auto: render quality 'auto' (the default): steps down under an artificial frame cost once the view is idle,
//   back up with fast frames after the (shortened) wait, no oscillation.
// - bench (only with --only bench; CI runs it as a non-blocking job): the timing numbers. Frame time of
//   40 forced frames per tier (budget high <= 2.5 x standard + 8 ms), one environment / contact build, one probe's bake,
//   the probes per pass of each tier.
//   bun scripts/perf-check.mjs [--only group,group] [--shard k/n] [--list]
// Without --only every group but bench runs in this process, one after another.
import { Sections, parseArgs, selectGroups } from "./lib/sections.mjs";

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " – " + detail : ""}`);
  if (!ok) failures.push(name);
};
const card = 'document.querySelector("floorplan3d-card-impl")';
const sections = new Sections();

// ---------- page helpers (conditions and animation-frame counts, no fixed sleeps) ----------

// n animation frames
const rafs = (page, n) =>
  page.evaluate(
    `new Promise((done) => { let i = 0; const t = () => (++i >= ${n} ? done() : requestAnimationFrame(t)); requestAnimationFrame(t); })`,
  );
// until expr holds (polled every animation frame); false (and a note) on timeout
const until = (page, expr, label, timeout = 60000) =>
  page.waitForFunction(expr, { timeout }).then(
    () => true,
    () => {
      console.log(`     (timed out waiting for ${label})`);
      return false;
    },
  );
// Nothing to do: no frame due, no camera tween, no card update pending, no environment build / probe pass due or
// running (timers included), no contact rebuild due.
const QUIET = `(() => { const c = ${card}, v = c._view, L = v.look, p = L.indirect.probes, e = L._env, k = L._contact;
  return !c._pending && !v.dirty && !v.cam._tween && !(p && (p.active || p._timer)) && !(e && (e.pending || e._timer)) && !(k && k.stale); })()`;
// QUIET for `streak` animation frames in a row (a frame that starts work breaks the streak). -> true, false on timeout
const waitQuiet = (page, label, streak = 10, timeout = 90000) =>
  page
    .evaluate(
      `new Promise((done) => { const t0 = performance.now(); let n = 0;
    const tick = () => { n = ${QUIET} ? n + 1 : 0; if (n >= ${streak}) done(true); else if (performance.now() - t0 > ${timeout}) done(false); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick); })`,
    )
    .then((ok) => {
      if (!ok)
        console.log(`     (not quiet after ${timeout / 1000} s: ${label})`);
      return ok;
    });
// n frames rendered back to back (dirty every animation frame). timed: each frame's time (the view's frame from its
// start to after the sprites, markers and labels included, with a 1 px readPixels so the GPU work of the scene, the
// bloom, the finish and the sprites counts).
const forced = (page, n, timed = false) =>
  page.evaluate(`new Promise((done) => {
  const v = ${card}._view, gl = v.renderer.getContext(), sp = v.sprites, orig = sp.draw, out = [], px = new Uint8Array(4);
  if (${timed}) { sp.draw = function (depth) { const n = orig.call(this, depth); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return n; }; v.onFrameTime = (ms) => out.push(ms); }
  let i = 0;
  const tick = () => { if (i++ >= ${n} + 5) { sp.draw = orig; v.onFrameTime = null; done(out.slice(5)); return; } v.dirty = true; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})`);
// two rendered frames, then the GL error state
const glError = (page) =>
  page.evaluate(
    `(() => { const v = ${card}._view; v.dirty = true; return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(v.renderer.getContext().getError())))); })()`,
  );
const viewStats = (page) =>
  page.evaluate(`(() => { const v = ${card}._view, s = v.stats, p = v.look.indirect.probes, b = v.look._bloom;
  return { frames: s.frames, env: s.envBuilds, bloom: s.bloomPasses, skipped: b ? b.stats.skipped : 0, contact: s.contactBuilds, shadow: s.shadow, lights: s.shadowLights,
    mats: (() => { let n = 0; const seen = new Set(); v.model && v.model.root.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) if (!seen.has(m)) { seen.add(m); n += m.id; } }); return n; })(), caps: s.probeCaptures, passes: p ? p.stats.passes : 0, probes: p ? p.size : 0,
    grids: p ? p.live.map((g) => g.resolution.x * g.resolution.y * g.resolution.z) : [],
    spacing: p ? p.live.map((g) => +((g.boundingBox.max.x - g.boundingBox.min.x) / g.resolution.x).toFixed(2)) : [], probeOn: p ? p.uniforms.fpProbeOn.value : 0, programs: v.renderer.info.programs.length }; })()`);
// per-key change between two viewStats; a list (probes per grid) counts as 0 unchanged, 1 changed
const diff = (a, b) =>
  Object.fromEntries(
    Object.keys(b).map((k) => [
      k,
      Array.isArray(b[k])
        ? JSON.stringify(b[k]) === JSON.stringify(a[k])
          ? 0
          : 1
        : b[k] - a[k],
    ]),
  );
const surfaces = (page) =>
  page.evaluate(`(() => { const out = { glass: 0, floor: 0, fabric: 0, physical: 0 }, seen = new Set();
  ${card}._view.model.root.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) { if (seen.has(m)) continue; seen.add(m);
    if (m.userData.fpSurface) out[m.userData.fpSurface]++; if (m.isMeshPhysicalMaterial) out.physical++; } });
  return out; })()`);
// the model loaded, the demo mower held still, the sun fixed (sun.sun applied by the card)
async function prepare(page, sun = [40, 200]) {
  await until(page, `!!${card}._view.model`, "the model");
  await page.evaluate("window.__demoMowerPaused = true");
  await page.evaluate(`window.__setDemoSun(${sun[0]}, ${sun[1]})`);
  await until(
    page,
    `(() => { const s = ${card}._sunNow; return !!s && s.elevation === ${sun[0]} && s.azimuth === ${sun[1]}; })()`,
    "the sun applied",
  );
}
// a sun step applied by the card, at least one frame drawn after it
async function sunStep(page, el, az) {
  await page.evaluate(`window.__setDemoSun(${el}, ${az})`);
  await until(
    page,
    `(() => { const s = ${card}._sunNow; return !!s && s.elevation === ${el} && s.azimuth === ${az}; })()`,
    `the sun at ${el} / ${az}`,
  );
  await page.evaluate(`${card}._view.dirty = true`);
  await rafs(page, 2);
}

// ---------- quality-standard / quality-high ----------

const IDLE_RAFS = 90; // the idle window: animation frames with nothing to do (no timer pending either)

async function qualityRun(page, quality) {
  await prepare(page);
  const sky = await waitQuiet(page, "the load (sky build, probe passes)");
  const load = await viewStats(page);
  // idle: nothing due, then a window of animation frames without a frame, and still nothing due
  await rafs(page, IDLE_RAFS);
  const idleQuiet = await page.evaluate(QUIET);
  const idle = diff(load, await viewStats(page));
  // < ENV_ANGLE_DEG (and < the card's 1 degree for setSky): light and environment kept
  await sunStep(page, 40.5, 200.5);
  await waitQuiet(page, "the small sun step");
  const s1 = await viewStats(page);
  const small = diff(load, s1);
  // > ENV_ANGLE_DEG: one rebuild (once the throttle allows), one shadow request, a probe pass
  await sunStep(page, 46, 215);
  await until(
    page,
    `${card}._view.stats.shadow > ${s1.shadow}`,
    "the large sun step's shadow request",
    30000,
  );
  await waitQuiet(page, "the large sun step (sky rebuild, probe pass)");
  const s2 = await viewStats(page);
  const big = diff(s1, s2);
  const env =
    await page.evaluate(`(() => { const v = ${card}._view; let contact = 0;
    v.model.root.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) { if (m.userData.fpContact) contact++; } });
    return { env: !!v.scene.environment, tm: v.renderer.toneMapping, bloom: !!v.look._bloom, hemi: v.hemi.intensity,
      shadowType: v.renderer.shadowMap.type, contact, contactTiles: v.look._contact ? v.look._contact.tiles : 0 }; })()`);
  // forced frames with lamps in view, then with the camera turned away (no emissive surface in view)
  await forced(page, 12);
  const s3 = await viewStats(page);
  const fwd = diff(s2, s3);
  await page.evaluate(`(() => { const v = ${card}._view, p = v.persp.position.clone(), t = v.cam.controls.target.clone(), d = p.clone().sub(t);
    window.__fpCam = [p, t]; v._moveCamera(p.clone().addScaledVector(d, 4), p.clone().addScaledVector(d, 8), true); })()`);
  const s4a = await viewStats(page);
  await forced(page, 10);
  const s4 = await viewStats(page);
  const away = diff(s4a, s4);
  await page.evaluate(
    `(() => { const v = ${card}._view, [p, t] = window.__fpCam; v._moveCamera(p, t, true); })()`,
  );
  await waitQuiet(page, "the camera back");
  const s5 = await viewStats(page);
  const forcedAll = diff(s2, s5); // forced and moved-camera frames: no probe capture, no contact rebuild
  // a lamp turned off: one pass of its storey's grid once the throttle allows, then nothing
  await page.evaluate(`window.__setDemoStates({ 'light.demo_living': 'off' })`);
  await until(
    page,
    `${card}._view.stats.probeCaptures > ${s5.caps}`,
    "the lamp's probe bake",
    30000,
  );
  await page.evaluate(`${card}._view.dirty = true`);
  await waitQuiet(page, "the lamp switched");
  const s6 = await viewStats(page);
  const lamp = diff(s5, s6);
  // a look change that leaves the light as it is (a theme): probes kept
  await page.evaluate(
    `(() => { const v = ${card}._view; v.look._applyLook(); v.dirty = true; })()`,
  );
  await rafs(page, 2);
  await waitQuiet(page, "the look change");
  const s7 = await viewStats(page);
  const look = diff(s6, s7);
  // a change of the shadow casters (the floor chips: another storey shown) rebuilds the contact shadows once
  await page.evaluate(
    `${card}.shadowRoot.querySelectorAll('.chips button.chip')[2].click()`,
  );
  await until(
    page,
    `${card}._view.stats.contactBuilds > ${s7.contact}`,
    "the storey change's contact build",
    30000,
  );
  await rafs(page, 2);
  await waitQuiet(page, "the storey change");
  const s8 = await viewStats(page);
  const storey = diff(s7, s8);
  const surf = await surfaces(page);
  // a tier change and back: the same material objects and classes (the sum of their ids unchanged); no GL errors
  let roundTrip = null;
  if (quality === "high") {
    const r0 = (await viewStats(page)).mats;
    await page.evaluate(
      `${card}._view.setRenderOption({ quality: 'standard' })`,
    );
    const errStd = await glError(page),
      sameStd = (await viewStats(page)).mats === r0,
      surfStd = await surfaces(page);
    await page.evaluate(`${card}._view.setRenderOption({ quality: 'high' })`);
    const errHigh = await glError(page),
      sameHigh = (await viewStats(page)).mats === r0,
      surfHigh = await surfaces(page);
    roundTrip = { sameStd, sameHigh, surfStd, surfHigh, errStd, errHigh };
  }
  const still = await page
    .evaluate(
      `JSON.stringify({ sessions: ${card}._view.stats.stillSessions, steps: ${card}._view.stats.stillSteps, session: !!${card}._view.still.session, chunk: performance.getEntriesByType('resource').some((r) => /path-tracer-/.test(r.name)) })`,
    )
    .then(JSON.parse);
  const r = {
    ...env,
    sky,
    load,
    idle,
    idleQuiet,
    small,
    big,
    fwd,
    away,
    forcedAll,
    lamp,
    look,
    storey,
    surf,
    roundTrip,
    still,
    final: s8, // totals since the load began
    steady: s8.mats - load.mats, // material objects replaced since the load: idle, sun steps, forced and camera frames, lamp, look, storey change
  };
  console.log(
    `     ${quality}: load ${JSON.stringify(load)}; idle ${JSON.stringify(idle)}; small sun step ${JSON.stringify(small)}; large ${JSON.stringify(big)}`,
  );
  console.log(
    `     ${quality}: forced ${JSON.stringify(fwd)}; away ${JSON.stringify(away)}; lamp off ${JSON.stringify(lamp)}; look ${JSON.stringify(look)}; storey ${JSON.stringify(storey)}`,
  );
  return r;
}

// the checks both tiers share
function commonChecks(name, r) {
  check(
    `${name}: the load settles (nothing due or running)`,
    r.sky,
    "see the timeout note",
  );
  check(
    `${name}: idle: no frame, build, pass, capture, swap or new program over ${IDLE_RAFS} animation frames, nothing due after`,
    r.idleQuiet && Object.values(r.idle).every((x) => x === 0),
    JSON.stringify(r.idle),
  );
  // the card's setSky rule (sun > 1 degree) is the tiers' same: the shadow scheduling is too
  check(
    `${name}: shadow requests: none for a sun step under 1 degree, one (one light) for a larger step`,
    r.small.shadow === 0 &&
      r.small.lights === 0 &&
      r.big.shadow === 1 &&
      r.big.lights === 1,
    `small ${r.small.shadow}/${r.small.lights}, large ${r.big.shadow}/${r.big.lights}`,
  );
  check(
    `${name}: no shader program compiled on forced frames`,
    r.fwd.programs === 0 && r.fwd.frames >= 12,
    JSON.stringify(r.fwd),
  );
  check(
    `${name}: no path tracing, its chunk never loaded`,
    r.still.sessions === 0 &&
      r.still.steps === 0 &&
      !r.still.session &&
      !r.still.chunk,
    JSON.stringify(r.still),
  );
}

// physical materials (the loader's plugin): glass, floor and fabric in every tier, never replaced afterwards
function materialChecks(quality, r) {
  check(
    `${quality}: glass, floor and fabric materials physical from the load`,
    r.surf.glass > 0 && r.surf.floor > 0 && r.surf.fabric > 0,
    JSON.stringify(r.surf),
  );
  check(
    `${quality}: the same material objects while idle, per frame, on a lamp, look or storey change`,
    r.steady === 0,
    String(r.steady),
  );
}

// the light both tiers share: sky environment, AgX, no hemisphere light, contact shadows, probe grids at the tier's
// spacing (rebaked once per input change, a lamp its storey's grid only)
function lightChecks(name, r, spacing) {
  check(
    `${name}: sky environment on, AgX tone mapping (6), no hemisphere light`,
    r.env && r.tm === 6 && r.load.env >= 1 && r.hemi === 0,
    JSON.stringify({ env: r.env, tm: r.tm, builds: r.load.env, hemi: r.hemi }),
  );
  check(
    `${name}: no environment rebuild for a sun step under 2 degrees, one for a larger step`,
    r.small.env === 0 && r.big.env === 1,
    `${r.small.env}, ${r.big.env}`,
  );
  check(
    `${name}: three's PCF sun shadows, contact variants, contact tiles built`,
    r.shadowType === 1 && r.contact > 0 && r.contactTiles > 0,
    JSON.stringify({
      shadowType: r.shadowType,
      contact: r.contact,
      tiles: r.contactTiles,
    }),
  );
  check(
    `${name}: no contact rebuild while idle or on forced / camera frames, one on a storey change`,
    r.idle.contact === 0 && r.forcedAll.contact === 0 && r.storey.contact === 1,
    `${r.idle.contact}, ${r.forcedAll.contact}, ${r.storey.contact}`,
  );
  const probes = r.load.probes,
    grids = r.load.grids;
  check(
    `${name}: light probe grids (one per storey) at ${spacing} m, baked at load`,
    probes > 0 &&
      grids.length >= 1 &&
      r.load.spacing.every((d) => Math.abs(d - spacing) <= spacing * 0.25) &&
      r.load.passes >= 1 &&
      r.load.caps >= probes &&
      r.load.probeOn === 1,
    JSON.stringify({
      probes,
      grids,
      spacing: r.load.spacing,
      caps: r.load.caps,
      passes: r.load.passes,
      on: r.load.probeOn,
    }),
  );
  check(
    `${name}: no probe baked while idle, on forced / camera frames or a look change that keeps the light`,
    r.idle.caps === 0 && r.forcedAll.caps === 0 && r.look.caps === 0,
    `${r.idle.caps}, ${r.forcedAll.caps}, ${r.look.caps}`,
  );
  const g0 = Math.min(...grids),
    g1 = Math.max(...grids);
  check(
    `${name}: a sky rebuild rebakes every grid once (at most twice), a lamp switched its storey's grid`,
    r.big.caps >= probes &&
      r.big.caps <= 2 * probes &&
      r.lamp.caps >= g0 &&
      r.lamp.caps <= 2 * g1 &&
      (grids.length < 2 || r.lamp.caps < probes) &&
      r.small.caps <= 2 * probes,
    `sky ${r.big.caps}, lamp ${r.lamp.caps}, small sun step ${r.small.caps} for ${probes} probes in grids ${grids.join(" + ")}`,
  );
}

sections.add(
  "standard",
  {
    group: "quality-standard",
    query: { model: "1", view: "3d", cards: "1", quality: "standard" },
    viewport: { width: 1200, height: 700 },
  },
  async ({ page, errors }) => {
    const r = await qualityRun(page, "standard");
    commonChecks("standard", r);
    lightChecks("standard", r, 1);
    const F = r.final;
    check(
      "standard: no bloom",
      !r.bloom && F.bloom === 0,
      JSON.stringify({ bloom: r.bloom, passes: F.bloom }),
    );
    materialChecks("standard", r);
    if (errors.length)
      check(
        "standard demo without page errors",
        false,
        errors.slice(0, 3).join(" | "),
      );
  },
);

sections.add(
  "high",
  {
    group: "quality-high",
    query: { model: "1", view: "3d", cards: "1", quality: "high" },
    viewport: { width: 1200, height: 700 },
  },
  async ({ page, errors }) => {
    const r = await qualityRun(page, "high");
    commonChecks("high", r);
    lightChecks("high", r, 0.5);
    check(
      "high: bloom on every forced frame with lamps in view",
      r.bloom && r.fwd.frames >= 12 && r.fwd.bloom === r.fwd.frames,
      JSON.stringify({ passes: r.fwd.bloom, frames: r.fwd.frames }),
    );
    check(
      "high: bloom skipped with no emissive surface in view",
      r.away.frames >= 10 &&
        r.away.bloom === 0 &&
        r.away.skipped === r.away.frames,
      `${r.away.bloom} passes, ${r.away.skipped} skipped in ${r.away.frames} frames`,
    );
    materialChecks("high", r);
    const rt = r.roundTrip;
    check(
      "high -> standard -> high: the same materials and classes, no GL error, no shader variant switch",
      !!rt &&
        rt.sameStd &&
        rt.sameHigh &&
        JSON.stringify(rt.surfStd) === JSON.stringify(r.surf) &&
        JSON.stringify(rt.surfHigh) === JSON.stringify(r.surf) &&
        rt.errStd === 0 &&
        rt.errHigh === 0,
      JSON.stringify(rt),
    );
    if (errors.length)
      check(
        "high demo without page errors",
        false,
        errors.slice(0, 3).join(" | "),
      );
  },
);

// ---------- still ----------

// Render quality 'still': idle progressive path tracing (test mode: a few samples a session).
sections.add(
  "still",
  {
    group: "still",
    query: { model: "1", view: "3d", cards: "1", quality: "still" },
    viewport: { width: 1200, height: 700 },
  },
  async ({ page, errors }) => {
    const ev = (expr) => page.evaluate(expr);
    await until(page, `!!${card}._view.model`, "the model");
    await ev("window.__demoMowerPaused = true");
    const st = () =>
      ev(`JSON.stringify((() => { const v = ${card}._view, s = v.still; return { sessions: v.stats.stillSessions, steps: v.stats.stillSteps, draws: v.stats.stillDraws, builds: v.stats.stillBuilds, frames: v.stats.frames,
      active: s.active, done: s.done, hold: s.hold, spp: s.samples, after: Math.round(s.startedAfter), idleMs: s.idleMs, gl: v.renderer.getContext().getError(),
      chunk: performance.getEntriesByType('resource').some((r) => /path-tracer-/.test(r.name)) }; })())`).then(
        JSON.parse,
      );
    const traced = await until(
      page,
      `${card}._view.still.done`,
      "the first session",
      120000,
    );
    const a = await st();
    console.log(`     still: first session ${JSON.stringify(a)}`);
    // Per session, not by count: a late raster frame from the load (any frame ends a session) may have ended a
    // first session, and the next one is the one that finished. The 3 s idle rule itself (startedAfter >= idleMs)
    // is unit-tested on StillTrace (test/still.test.js), not read off real-time waits here.
    check(
      "still: traces once idle, its chunk loaded, drawn only from the fade threshold, done at the test cap, no GL error",
      traced &&
        a.sessions >= 1 &&
        a.builds >= 1 &&
        a.draws > 0 &&
        a.draws < a.steps &&
        a.chunk &&
        a.spp >= 2 &&
        a.done &&
        a.gl === 0,
      JSON.stringify(a),
    );
    // from here no new session can start by the clock (idleMs Infinity holds 'idle'); the done session runs on
    const idleMs = await ev(`${card}._view.still.idleMs`);
    await ev(`${card}._view.still.idleMs = Infinity`);
    await rafs(page, 60);
    const b = await st();
    check(
      "still: nothing runs once the budget is spent (no tile, no frame over 60 animation frames)",
      b.steps === a.steps &&
        b.frames === a.frames &&
        b.sessions === a.sessions &&
        b.active &&
        b.done,
      JSON.stringify(b),
    );
    // a camera move: the very next frame is the raster frame, the session ended
    const moved =
      await ev(`new Promise((done) => { const v = ${card}._view, s0 = v.stats.stillSteps, f0 = v.stats.frames; v.persp.position.x += 0.3; v.persp.position.z += 0.3; v.controls.update();
      requestAnimationFrame(() => requestAnimationFrame(() => done(JSON.stringify({ active: v.still.active, done: v.still.done, steps: v.stats.stillSteps - s0, frames: v.stats.frames - f0 })))); })`).then(
        JSON.parse,
      );
    check(
      "still: a camera move ends the session at once (the next frame is raster)",
      !moved.active && !moved.done && moved.frames >= 1 && moved.steps === 0,
      JSON.stringify(moved),
    );
    await until(
      page,
      `!${card}._view.dirty && ${card}._view.cam.controls.update() === false`,
      "the camera still",
      10000,
    );
    await until(
      page,
      `${card}._view.still.hold === 'idle'`,
      "the idle hold after the move",
      10000,
    );
    const c = await st();
    check(
      "still: after the move no session runs, the idle time counts again",
      c.sessions === a.sessions && !c.active && c.hold === "idle",
      JSON.stringify(c),
    );
    // the idle time back to the card's own: the next session starts by it (a product timer, waited for)
    await ev(`${card}._view.still.idleMs = ${idleMs}`);
    const again = await until(
      page,
      `${card}._view.still.done && ${card}._view.stats.stillSessions > ${a.sessions}`,
      "the second session",
      120000,
    );
    const d = await st();
    check(
      "still: a second idle session after the move reuses the traced scene (no rebuild)",
      again && d.sessions > a.sessions && d.builds === a.builds && d.gl === 0,
      JSON.stringify(d),
    );
    // held off: off screen. The idle time is set to 0 meanwhile, so without the hold a session would start
    // on the next idle animation frame: a window of animation frames proves the hold.
    await ev(
      `(() => { const v = ${card}._view; v.still.idleMs = 0; v.setOnScreen(false); v.dirty = true; })()`,
    );
    await until(
      page,
      `${card}._view.still.hold === 'offscreen'`,
      "the off-screen hold",
    );
    await rafs(page, 30);
    const f = await st();
    check(
      "still: no trace off screen (idle time 0, 30 animation frames)",
      f.sessions === d.sessions && f.hold === "offscreen" && !f.active,
      JSON.stringify({ off: f }),
    );
    // the tier changed to high: the path tracer freed, nothing traced (idle time still 0)
    await ev(
      `(() => { const v = ${card}._view; v.setRenderOption({ quality: 'high' }); v.setOnScreen(true); })()`,
    );
    await until(page, `${card}._view.still.hold === 'tier'`, "the tier hold");
    await rafs(page, 30);
    const g = await ev(
      `JSON.stringify({ session: !!${card}._view.still.session, sessions: ${card}._view.stats.stillSessions, hold: ${card}._view.still.hold })`,
    ).then(JSON.parse);
    check(
      "still -> high: the path tracer freed, no session",
      !g.session && g.sessions === d.sessions && g.hold === "tier",
      JSON.stringify(g),
    );
    // SwiftShader has no parallel shader compile: three warns once when the path tracer compiles (it then compiles at once)
    const errs = errors.filter(
      (m) => !m.includes("KHR_parallel_shader_compile extension not supported"),
    );
    if (errs.length)
      check(
        "still demo without page errors",
        false,
        errs.slice(0, 3).join(" | "),
      );
  },
);

// ---------- auto ----------

// Render quality 'auto' (the default, no ?quality): the controller fed by the real render loop. Test mode holds it
// (no adapting, nothing remembered) until the check turns it on with shorter waits; view.auto.testCostMs adds a busy
// wait to every rendered frame, and a sample is at least the frame's own time, so every sample is >= the cost however
// loaded the machine is. Software GL never renders the demo at the display's refresh, so the way back up is fed fake
// samples (ctl.fixedSampleMs: 16 ms). Phases end on the controller's state (window full, change pending / applied),
// not after fixed times; "no further change" is the controller's own answer for any later time (due(now + 1e9)).
sections.add(
  "auto",
  {
    group: "auto",
    query: { model: "1", view: "3d", cards: "1" },
    viewport: { width: 800, height: 500 },
  },
  async ({ page, errors }) => {
    const ev = (expr) => page.evaluate(expr);
    await until(page, `!!${card}._view.model`, "the model");
    await ev("window.__demoMowerPaused = true");
    await waitQuiet(page, "the load");
    const state = () =>
      ev(`(() => { const v = ${card}._view, a = v.auto.state();
      const p = v.look.indirect.probes;
      return { ...a, tier: v.look.quality(), bloom: !!v.look._bloom, env: !!v.scene.environment, tm: v.renderer.toneMapping, probes: p ? p.size : 0, switches: v.stats.autoSwitches, frames: v.stats.frames,
        later: (v.auto.ctl.due(performance.now() + 1e9) || {}).level || null }; })()`);
    const s0 = await state();
    check(
      "auto: the default; starts at high (the high tier: bloom, sky environment, AgX)",
      s0.level === "high" &&
        s0.tier === "high" &&
        s0.bloom &&
        s0.env &&
        s0.tm === 6 &&
        s0.switches === 0,
      JSON.stringify(s0),
    );
    // continuous rendering (every animation frame renders, as while orbiting) until pred (the controller's state, read
    // in the same animation frame) holds or maxMs; -> that frame's { level, pending, switches, samples, ok }
    const runUntil = (pred, maxMs = 30000) =>
      ev(`new Promise((done) => { const v = ${card}._view, a = v.auto, end = performance.now() + ${maxMs};
      const f = () => { const s = a.state(), x = { level: s.level, pending: s.pending, samples: s.samples, switches: v.stats.autoSwitches };
        const ok = (${pred})(x, a);
        if (ok || performance.now() > end) done({ ...x, ok }); else { v.dirty = true; requestAnimationFrame(f); } };
      v.dirty = true; requestAnimationFrame(f); })`);
    const T = {
      window: 15,
      settleMs: 500,
      cooldownMs: 2000,
      upAfterMs: 5000,
      probeMs: 3000,
    };
    await ev(
      `(() => { const a = ${card}._view.auto; a.adapt = true; Object.assign(a.ctl.tuning, ${JSON.stringify(T)}); a.ctl.reset(performance.now()); })()`,
    );
    await ev(`${card}._view.auto.testCostMs = 70`);
    const during = await runUntil(`(x) => x.pending === 'standard'`);
    check(
      "auto: slow frames under interaction: a step down proposed, not applied while rendering",
      during.ok &&
        during.level === "high" &&
        during.pending === "standard" &&
        during.switches === 0,
      JSON.stringify(during),
    );
    // idle: applied once the camera has been still AUTO_IDLE_MS
    await until(
      page,
      `${card}._view.stats.autoSwitches === 1`,
      "the step down",
      30000,
    );
    await rafs(page, 2);
    const s2 = await state();
    check(
      "auto: once idle, down to standard (no bloom, fewer probes; the same sky environment and AgX)",
      s2.level === "standard" &&
        s2.tier === "standard" &&
        !s2.bloom &&
        s2.env &&
        s2.tm === 6 &&
        s2.probes > 0 &&
        s2.probes < s0.probes &&
        s2.switches === 1,
      JSON.stringify({ ...s2, highProbes: s0.probes }),
    );
    // still slow, a full window of samples at standard: no level below it here (pixel ratio 1)
    const low = await runUntil(`(x) => x.samples >= ${T.window}`);
    await rafs(page, 30);
    const s3 = await state();
    check(
      "auto: stays at the lowest level, no more switches (a full slow window, no change due at any later time)",
      low.ok &&
        s3.level === "standard" &&
        s3.switches === 1 &&
        s3.later === null &&
        !s3.pending,
      JSON.stringify({ low, ...s3 }),
    );
    await ev(
      `(() => { const a = ${card}._view.auto; a.testCostMs = 0; a.ctl.fixedSampleMs = 16; })()`,
    );
    // fast frames: the step up is due once upAfterMs passed at the level; it is applied on an idle frame
    const upDue = await runUntil(
      `(x, a) => x.samples >= ${T.window} && (a.ctl.due(performance.now()) || {}).level === 'high'`,
    );
    await until(
      page,
      `${card}._view.stats.autoSwitches === 2`,
      "the step up",
      30000,
    );
    await rafs(page, 2);
    const s4 = await state();
    console.log(
      `     auto: measured median frame with the cost: standard ${s3.median === null ? "–" : s3.median.toFixed(1)} ms; refresh ${s4.refreshMs.toFixed(1)} ms`,
    );
    check(
      "auto: fast frames again: back up to high after the wait",
      upDue.ok &&
        s4.level === "high" &&
        s4.tier === "high" &&
        s4.bloom &&
        s4.env &&
        s4.probes === s0.probes &&
        s4.switches === 2,
      JSON.stringify({ upDue, ...s4 }),
    );
    const fast = await runUntil(`(x) => x.samples >= ${T.window}`);
    await rafs(page, 30);
    const s5 = await state();
    check(
      "auto: no oscillation while frames stay fast (a full fast window, no change due at any later time)",
      fast.ok &&
        s5.level === "high" &&
        s5.switches === 2 &&
        s5.later === null &&
        !s5.pending,
      JSON.stringify({ fast, ...s5 }),
    );
    const err = await glError(page);
    check(
      "auto: switches without GL errors or page errors",
      err === 0 && !errors.length,
      `${err} ${errors.slice(0, 3).join(" | ")}`,
    );
    const dbg = await ev(
      `${card}._view.auto.state() && localStorage.getItem('floorplan3d.quality')`,
    );
    check("auto: test mode remembers nothing", dbg === null, String(dbg));
  },
);

// ---------- mower-map ----------

// frame time of 40 forced frames per tier (the same view, the sun fixed, settled first), and one build of each kind
const frameTimes = {};
for (const quality of ["standard", "high"])
  sections.add(
    `frame-${quality}`,
    {
      group: "bench",
      query: { model: "1", view: "3d", cards: "1", quality },
      viewport: { width: 1200, height: 700 },
    },
    async ({ page }) => {
      await prepare(page);
      await waitQuiet(page, "the load");
      const times = await forced(page, 40, true);
      const sorted = [...times].sort((a, b) => a - b);
      const r = (frameTimes[quality] = {
        avg: times.reduce((a, b) => a + b, 0) / Math.max(1, times.length),
        p90: sorted[Math.floor(sorted.length * 0.9)] || 0,
      });
      const built = await page.evaluate(
        `(() => { const v = ${card}._view, p = v.look.indirect.probes; return { env: v.stats.envBuilds, probes: p ? p.size : 0, caps: v.stats.probeCaptures }; })()`,
      );
      console.log(
        `     render ms per frame (40 forced frames, 1200 x 700, test mode): ${quality} avg ${r.avg.toFixed(1)} p90 ${r.p90.toFixed(1)}; load: ${built.env} environment build(s), ${built.probes} probes a pass, ${built.caps} baked`,
      );
      if (quality !== "high") return;
      const timed = (body) =>
        page.evaluate(`(() => { const v = ${card}._view, gl = v.renderer.getContext(); ${body}
        const t = performance.now(); run(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); return performance.now() - t; })()`);
      const envMs = await timed(
        `const e = v.look._env; if (!e || !e.built) return null; const run = () => e._build(e.built);`,
      );
      const probeMs = await timed(
        `const p = v.look.indirect.probes; if (!p || !p.spare.length) return null; const run = () => v.look.indirect._capture((s) => p.spare[0].bake(v.renderer, s, { start: 0, count: 1, cubemapSize: 16, near: 0.05, far: 500 }));`,
      );
      const contactMs = await timed(
        `const c = v.look._contact; if (!c) return null; const run = () => c.update(v.scene, v.look._contactFloors());`,
      );
      console.log(
        `     one build: environment ${envMs?.toFixed(1)} ms, one probe's bake ${probeMs?.toFixed(1)} ms, contact shadows ${contactMs?.toFixed(1)} ms`,
      );
      const std = frameTimes.standard;
      // the budget of the whole tier (env, bloom, contact shadows, physical materials, probe grids)
      check(
        "bench: high (bloom, finer probes): frame time <= 2.5 x standard + 8 ms",
        !!std && r.avg <= 2.5 * std.avg + 8,
        `${r.avg.toFixed(1)} vs ${std ? std.avg.toFixed(1) : "–"} ms`,
      );
    },
  );

// group order: what a plain run does first
sections.order(["quality-standard", "quality-high", "still", "auto", "bench"]);
const args = parseArgs(process.argv.slice(2));
if (args.list) {
  for (const g of sections.groups)
    console.log(`${g.name}: ${g.sections.map((x) => x.name).join(", ")}`);
  process.exit(0);
}
// bench only when asked for by name (its timing wants a machine to itself)
const groups = args.only
  ? sections.groups
  : sections.groups.filter((g) => g.name !== "bench");
await sections.run(selectGroups(groups, args), {
  onError: (name, e) => {
    console.log(`FAIL ${name} threw: ${e && e.stack ? e.stack : e}`);
    failures.push(name);
  },
});
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nperf check passed");
process.exit(0);
