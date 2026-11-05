// Headless benchmark of the mower map: a 1600 x 1600 live map (camera) refreshing every 2 s with a
// moving mower for 30 s, then 16 s of refreshes where nothing changed, at the default render quality ('high').
// - no main-thread task of the card's own > 50 ms (its own timing: map refresh sections and renders)
// - renders while idle <= refresh-driven ones; no shadow-map updates from the mower moving
// Prints the numbers (main-thread ms per refresh, long tasks) for the release notes.
// Then render quality 'high' (sky environment light, physical lamps, selective bloom, soft sun shadows, contact
// shadows) against 'standard': no environment rebuild while idle or for a sun step under ENV_ANGLE_DEG, one
// (throttled) for a larger step; bloom never in 'standard', in 'high' only on frames with an emissive surface in
// view, nothing while idle; soft / contact shadow variants only in 'high', contact shadows rebuilt only when the
// casters change (not while idle, not per frame), shadow requests as in 'standard'; physical materials (glass,
// floors, fabric) only in 'high', upgraded at load and on a tier change (restored and upgraded again, without GL
// errors), never while idle or per frame; per-room light probes only in 'high', captured one room a frame per pass,
// no capture while idle or on forced / camera frames, one pass (at most two) per input change (a sun step that
// rebuilds the sky, a lamp switched off); frame time (render + bloom + finish, GPU included) in bounds.
// Then render quality 'auto' (the default): starts at high; with an artificial frame cost under continuous
// rendering it steps down to standard, only once the view is idle, once; without the cost it steps back up after
// the (shortened) wait and stays there.
//   bun scripts/perf-check.mjs [--quality-only | --auto-only]
import { openDemo } from "./lib/demo-browser.mjs";

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " – " + detail : ""}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const card = 'document.querySelector("floorplan3d-card-impl")';
const MOVE_S = 30,
  IDLE_S = 16,
  REFRESH_MS = 2000;
const QUALITY_ONLY = process.argv.includes("--quality-only");
const AUTO_ONLY = process.argv.includes("--auto-only");

// One demo per tier, the sun fixed: environment builds while idle / after sun steps, and the time of 40
// forced frames (the view's frame from its start to the label render, after a 1 px readPixels so the GPU work
// of the scene, the bloom and the finish counts).
async function qualityRun(quality) {
  const q = await openDemo(
    { model: "1", view: "3d", cards: "1", quality },
    { width: 1200, height: 700 },
  );
  try {
    const { page } = q;
    const ev = (expr) => page.evaluate(expr);
    await page.waitForFunction(`!!${card}._view.model`, { timeout: 60000 });
    await ev("window.__demoMowerPaused = true");
    await ev("window.__setDemoSun(40, 200)");
    await sleep(3000); // the throttle (2 s) and the first build
    const builds = () => ev(`${card}._view.stats.envBuilds`);
    const bloomPasses = () => ev(`${card}._view.stats.bloomPasses`);
    const contactBuilds = () => ev(`${card}._view.stats.contactBuilds`);
    const shadows = () =>
      ev(
        `(() => { const s = ${card}._view.stats; return { shadow: s.shadow, lights: s.shadowLights }; })()`,
      );
    const swaps = () => ev(`${card}._view.stats.materialSwaps`);
    const probes = () =>
      ev(
        `(() => { const v = ${card}._view, p = v.look.indirect.probes; return { caps: v.stats.probeCaptures, passes: p ? p.stats.passes : 0, rooms: p && p.setup ? p.setup.rooms.length - p.setup.skip.size : 0, on: p ? p.uniforms.fpProbe.value.z : 0 }; })()`,
      );
    // settle: no probe pass running or due and the render loop asleep (frames unchanged for 1 s); slow CI runners
    // are still capturing the load's passes after a fixed wait, and every capture frame renders (bloom included)
    const settle = async () => {
      for (let i = 0, last = -1, quiet = 0; i < 60 && quiet < 2; i++) {
        await sleep(500);
        const s = await ev(
          `(() => { const v = ${card}._view, p = v.look.indirect.probes; return { busy: !!(p && p.active), frames: v.stats.frames }; })()`,
        );
        quiet = !s.busy && s.frames === last ? quiet + 1 : 0;
        last = s.frames;
      }
    };
    await settle();
    const pr0 = await probes(); // the load's pass (after the first sky build)
    const surfaces = () =>
      ev(`(() => { const out = { glass: 0, floor: 0, fabric: 0, physical: 0 }, seen = new Set();
      ${card}._view.model.root.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) { if (seen.has(m)) continue; seen.add(m);
        if (m.userData.fpSurface) out[m.userData.fpSurface]++; if (m.isMeshPhysicalMaterial) out.physical++; } });
      return out; })()`);
    const ms0 = await swaps();
    const b0 = await builds(),
      f0 = await ev(`${card}._view.stats.frames`),
      bp0 = await bloomPasses(),
      cb0 = await contactBuilds(),
      sh0 = await shadows();
    await sleep(8000);
    const b1 = await builds(),
      f1 = await ev(`${card}._view.stats.frames`),
      bp1 = await bloomPasses(),
      cb1 = await contactBuilds(),
      pr1 = await probes();
    await ev("window.__setDemoSun(40.5, 200.5)"); // < 2 degrees: light moves, environment kept
    await sleep(3000);
    const b2 = await builds();
    const pr2 = await probes();
    await ev("window.__setDemoSun(46, 215)"); // > 2 degrees: one rebuild
    await sleep(3000);
    const b3 = await builds(),
      pr3 = await probes();
    const sh1 = await shadows(); // the two sun steps: shadow requests as in standard (the scheduling is the tier's same)
    const env =
      await ev(`(() => { const v = ${card}._view; let pcss = 0, contact = 0;
      v.model.root.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) { if (m.userData.fpPcss) pcss++; if (m.userData.fpContact) contact++; } });
      return { env: !!v.scene.environment, tm: v.renderer.toneMapping, hemi: v.hemi.intensity, bloom: !!v.look._bloom, physical: !!(v.objectLayer && v.objectLayer.physical),
        pcss, contact, contactTiles: v.look._contact ? v.look._contact.tiles : 0 }; })()`);
    const forced = (n) =>
      ev(`new Promise((done) => {
      const v = ${card}._view, gl = v.renderer.getContext(), lr = v.labelRenderer, orig = lr.render, out = [], px = new Uint8Array(4);
      lr.render = function (scene, camera) { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return orig.call(this, scene, camera); };
      v.onFrameTime = (ms) => out.push(ms);
      let i = 0;
      const tick = () => { if (i++ >= ${n} + 5) { lr.render = orig; v.onFrameTime = null; done(out.slice(5)); return; } v.dirty = true; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    })`);
    const frames = () => ev(`${card}._view.stats.frames`);
    const bp2 = await bloomPasses(),
      fr2 = await frames();
    const times = await forced(40);
    const bp3 = await bloomPasses(),
      fr3 = await frames();
    // the camera turned away from the house: no emissive surface in view, the bloom pass is skipped
    await ev(`(() => { const v = ${card}._view, p = v.persp.position.clone(), t = v.cam.controls.target.clone(), d = p.clone().sub(t);
      window.__fpCam = [p, t]; v._moveCamera(p.clone().addScaledVector(d, 4), p.clone().addScaledVector(d, 8), true); })()`);
    const skip0 = await ev(
      `${card}._view.look._bloom ? ${card}._view.look._bloom.stats.skipped : 0`,
    );
    const fr4 = await frames();
    const awayTimes = await forced(10);
    const fr5 = await frames(),
      bp4 = await bloomPasses(),
      skip1 = await ev(
        `${card}._view.look._bloom ? ${card}._view.look._bloom.stats.skipped : 0`,
      );
    await ev(
      `(() => { const v = ${card}._view, [p, t] = window.__fpCam; v._moveCamera(p, t, true); })()`,
    );
    const prForced = (await probes()).caps - pr3.caps; // forced and moved-camera frames capture no probe
    // one environment build, timed the same way (what a sun step costs once)
    const buildMs =
      await ev(`(() => { const v = ${card}._view, e = v.look._env, gl = v.renderer.getContext(); if (!e || !e.built) return null;
      const t = performance.now(); e._build(e.built); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); return performance.now() - t; })()`);
    const cbForced = (await contactBuilds()) - cb1; // forced and moved-camera frames rebuild nothing
    await sleep(3000); // the timed environment build above rebuilds the probes once
    const prBase = await probes();
    // a lamp turned off: one pass once the throttle allows, then nothing while idle
    await ev(`window.__setDemoStates({ 'light.demo_living': 'off' })`);
    await sleep(4000);
    await settle();
    const pr4 = await probes();
    await ev(`${card}._view.look._applyLook()`); // a look change that leaves the light as it is (a theme): probes kept
    await sleep(3000);
    const pr5 = await probes();
    // one capture (a room's six faces), timed with the GPU
    const probeMs =
      await ev(`(() => { const v = ${card}._view, p = v.look.indirect.probes, gl = v.renderer.getContext(); if (!p || !p._cam) return null;
      const t = performance.now(); v.look.indirect._capture(p._cam); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); return performance.now() - t; })()`);
    // a change of the shadow casters (the floor chips: another storey shown) rebuilds the contact shadows once
    const cb2 = await contactBuilds();
    await ev(
      `${card}.shadowRoot.querySelectorAll('.chips button.chip')[2].click()`,
    );
    await sleep(2500);
    const cbChange = (await contactBuilds()) - cb2;
    const contactMs =
      await ev(`(() => { const v = ${card}._view, c = v.look._contact, gl = v.renderer.getContext(); if (!c) return null;
      const t = performance.now(); c.update(v.scene, v.look._contactFloors()); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); return performance.now() - t; })()`);
    const msSteady = (await swaps()) - ms0; // idle, sun steps, forced and camera frames, a storey change
    const surf = await surfaces();
    // a tier change and back: every upgraded material restored, then upgraded again; frames render without GL errors
    let roundTrip = null;
    if (quality === "high") {
      const glErr = () =>
        ev(
          `(() => { const v = ${card}._view; v.dirty = true; return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(v.renderer.getContext().getError())))); })()`,
        );
      const r0 = await swaps();
      await ev(`${card}._view.setRenderOption({ quality: 'standard' })`);
      const errStd = await glErr(),
        down = (await swaps()) - r0,
        surfStd = await surfaces();
      await ev(`${card}._view.setRenderOption({ quality: 'high' })`);
      const errHigh = await glErr(),
        up = (await swaps()) - r0 - down,
        surfHigh = await surfaces();
      roundTrip = { down, up, surfStd, surfHigh, errStd, errHigh };
    }
    const sorted = [...times].sort((a, b) => a - b);
    const probe = {
      load: pr0,
      idle: pr1.caps - pr0.caps,
      small: pr2.caps - pr1.caps,
      big: pr3.caps - pr2.caps,
      forced: prForced,
      lamp: pr4.caps - prBase.caps,
      after: pr5.caps - pr4.caps,
      rooms: pr5.rooms,
      passes: pr5.passes,
      on: pr5.on,
      ms: probeMs,
    };
    const still = await ev(
      `JSON.stringify({ sessions: ${card}._view.stats.stillSessions, steps: ${card}._view.stats.stillSteps, session: !!${card}._view.still.session, chunk: performance.getEntriesByType('resource').some((r) => /path-tracer-/.test(r.name)) })`,
    ).then(JSON.parse);
    return {
      probe,
      buildMs,
      still,
      msLoad: ms0,
      msSteady,
      surf,
      roundTrip,
      idleBuilds: b1 - b0,
      idleFrames: f1 - f0,
      smallStep: b2 - b1,
      bigStep: b3 - b2,
      builds: b3,
      ...env,
      idleContact: cb1 - cb0,
      contactForced: cbForced,
      contactChange: cbChange,
      contactMs,
      contactTotal: await contactBuilds(),
      shadowSteps: sh1.shadow - sh0.shadow,
      shadowLightSteps: sh1.lights - sh0.lights,
      idleBloom: bp1 - bp0,
      bloomForced: bp3 - bp2,
      framesForced: fr3 - fr2,
      bloomAway: bp4 - bp3,
      skippedAway: skip1 - skip0,
      framesAway: fr5 - fr4,
      bloomTotal: bp4,
      awayAvg:
        awayTimes.reduce((a, b) => a + b, 0) / Math.max(1, awayTimes.length),
      avg: times.reduce((a, b) => a + b, 0) / Math.max(1, times.length),
      p90: sorted[Math.floor(sorted.length * 0.9)] || 0,
      errors: q.errors,
    };
  } finally {
    await q.close();
  }
}

async function qualityChecks() {
  const std = await qualityRun("standard"),
    high = await qualityRun("high");
  console.log(
    `     render ms per frame (40 forced frames, 1200 x 700, test mode): standard avg ${std.avg.toFixed(1)} p90 ${std.p90.toFixed(1)}; high avg ${high.avg.toFixed(1)} p90 ${high.p90.toFixed(1)}`,
  );
  console.log(
    `     bloom: high ${high.bloomForced} passes in ${high.framesForced} forced frames; ${high.bloomAway} passes, ${high.skippedAway} skipped in ${high.framesAway} with no emissive in view (frame ${high.awayAvg.toFixed(1)} ms); standard ${std.bloomTotal} passes`,
  );
  console.log(
    `     environment builds: standard ${std.builds}, high ${high.builds} (idle ${high.idleBuilds} over ${high.idleFrames} frames, sun +0.7 deg ${high.smallStep}, sun +16 deg ${high.bigStep}); one build ${high.buildMs?.toFixed(1)} ms`,
  );
  check(
    "standard: no environment, no builds",
    !std.env && std.builds === 0,
    JSON.stringify({ env: std.env, builds: std.builds }),
  );
  check(
    "high: sky environment on, AgX tone mapping (6)",
    high.env && high.tm === 6,
    JSON.stringify({ env: high.env, tm: high.tm }),
  );
  check(
    "high: no environment rebuild while idle",
    high.idleBuilds === 0,
    String(high.idleBuilds),
  );
  check(
    "standard: no bloom, no physical lamps",
    !std.bloom && std.bloomTotal === 0 && !std.physical,
    JSON.stringify({
      bloom: std.bloom,
      passes: std.bloomTotal,
      physical: std.physical,
    }),
  );
  check(
    "high: physical lamps, bloom on every forced frame with lamps in view",
    high.physical &&
      high.bloom &&
      high.framesForced >= 40 &&
      high.bloomForced === high.framesForced,
    JSON.stringify({
      physical: high.physical,
      passes: high.bloomForced,
      frames: high.framesForced,
    }),
  );
  check(
    "high: bloom skipped with no emissive surface in view",
    high.framesAway >= 10 &&
      high.bloomAway === 0 &&
      high.skippedAway === high.framesAway,
    `${high.bloomAway} passes, ${high.skippedAway} skipped in ${high.framesAway} frames`,
  );
  check(
    "high: no bloom pass while idle",
    high.idleBloom === 0 && high.idleFrames === 0,
    `${high.idleBloom} passes over ${high.idleFrames} frames`,
  );
  check(
    "high: no rebuild for a sun step under 2 degrees, one for a larger step",
    high.smallStep === 0 && high.bigStep === 1,
    `${high.smallStep}, ${high.bigStep}`,
  );
  // shared CI runners: the same bound, the ratio is what counts
  console.log(
    `     soft / contact shadows: high ${high.pcss} PCSS and ${high.contact} contact materials, ${high.contactTiles} tiles; contact builds idle ${high.idleContact}, forced frames ${high.contactForced}, storey change ${high.contactChange}; one build ${high.contactMs?.toFixed(1)} ms; standard ${std.pcss} / ${std.contact} materials, ${std.contactTotal} builds`,
  );
  console.log(
    `     shadow requests for two sun steps: standard ${std.shadowSteps} (${std.shadowLightSteps} lights), high ${high.shadowSteps} (${high.shadowLightSteps} lights)`,
  );
  check(
    "standard: no soft-shadow or contact-shadow variant, no contact build",
    std.pcss === 0 &&
      std.contact === 0 &&
      std.contactTotal === 0 &&
      std.contactTiles === 0,
    JSON.stringify({
      pcss: std.pcss,
      contact: std.contact,
      builds: std.contactTotal,
    }),
  );
  check(
    "high: PCSS and contact variants on the model materials, contact tiles built",
    high.pcss > 0 && high.contact > 0 && high.contactTiles > 0,
    JSON.stringify({
      pcss: high.pcss,
      contact: high.contact,
      tiles: high.contactTiles,
    }),
  );
  check(
    "high: no contact rebuild while idle or on forced / camera frames, one on a storey change",
    high.idleContact === 0 &&
      high.contactForced === 0 &&
      high.contactChange === 1,
    `${high.idleContact}, ${high.contactForced}, ${high.contactChange}`,
  );
  check(
    "high: shadow requests for the sun steps as in standard",
    high.shadowSteps === std.shadowSteps &&
      high.shadowLightSteps === std.shadowLightSteps,
    `${high.shadowSteps}/${high.shadowLightSteps} vs ${std.shadowSteps}/${std.shadowLightSteps}`,
  );
  const upgraded = (x) => x.glass + x.floor + x.fabric;
  console.log(
    `     physical materials: high ${JSON.stringify(high.surf)} (upgraded at load ${high.msLoad}, later ${high.msSteady}); tier round trip ${JSON.stringify(high.roundTrip)}; standard ${JSON.stringify(std.surf)}, ${std.msLoad + std.msSteady} swaps`,
  );
  check(
    "standard: no physical material upgrade",
    upgraded(std.surf) === 0 && std.msLoad + std.msSteady === 0,
    JSON.stringify({ surf: std.surf, swaps: std.msLoad + std.msSteady }),
  );
  check(
    "high: glass, floor and fabric materials upgraded once at load",
    high.surf.glass > 0 &&
      high.surf.floor > 0 &&
      high.surf.fabric > 0 &&
      high.msLoad === upgraded(high.surf),
    JSON.stringify({ surf: high.surf, load: high.msLoad }),
  );
  check(
    "high: no material upgrade while idle, per frame or on a storey change",
    high.msSteady === 0,
    String(high.msSteady),
  );
  const rt = high.roundTrip;
  check(
    "high -> standard -> high: restored and upgraded again, no GL error",
    !!rt &&
      rt.down === upgraded(high.surf) &&
      rt.up === rt.down &&
      upgraded(rt.surfStd) === 0 &&
      rt.surfStd.physical === high.surf.physical - upgraded(high.surf) &&
      JSON.stringify(rt.surfHigh) === JSON.stringify(high.surf) &&
      rt.errStd === 0 &&
      rt.errHigh === 0,
    JSON.stringify(rt),
  );
  const P = high.probe,
    Ps = std.probe;
  console.log(
    `     light probes: high ${P.rooms} rooms, ${P.passes} passes; captures at load ${P.load.caps}, idle ${P.idle}, sun +0.7 deg ${P.small}, sun +16 deg ${P.big}, forced / camera frames ${P.forced}, lamp off ${P.lamp}, after it ${P.after}; one capture ${P.ms?.toFixed(1)} ms; standard ${Ps.load.caps + Ps.idle + Ps.big + Ps.lamp} captures`,
  );
  check(
    "standard: no light probes",
    Ps.passes === 0 &&
      Ps.load.caps +
        Ps.idle +
        Ps.small +
        Ps.big +
        Ps.forced +
        Ps.lamp +
        Ps.after ===
        0 &&
      !Ps.on,
    JSON.stringify(Ps),
  );
  check(
    "high: light probes built at load, one room a capture",
    P.rooms > 0 && P.load.passes >= 1 && P.load.caps >= P.rooms && P.on === 1,
    JSON.stringify(P.load),
  );
  check(
    "high: no probe capture while idle, on forced / camera frames or a look change that keeps the light",
    P.idle === 0 && P.forced === 0 && P.after === 0,
    `${P.idle}, ${P.forced}, ${P.after}`,
  );
  check(
    "high: a sky rebuild and a lamp switched each recapture every room once (at most twice)",
    P.big >= P.rooms &&
      P.big <= 2 * P.rooms &&
      P.lamp >= P.rooms &&
      P.lamp <= 2 * P.rooms &&
      P.small <= 2 * P.rooms,
    `sky ${P.big}, lamp ${P.lamp}, small sun step ${P.small} for ${P.rooms} rooms`,
  );
  // the budget of the whole tier (env, bloom, PCSS, contact shadows, physical materials, room probes): the step-1
  // bound (2 x + 8 ms, env light only) left no room on the shared CI runner once probes were in
  check(
    "high (bloom, PCSS, contact, physical materials, probes included): frame time <= 2.5 x standard + 8 ms",
    high.avg <= 2.5 * std.avg + 8,
    `${high.avg.toFixed(1)} vs ${std.avg.toFixed(1)} ms`,
  );
  for (const r of [std, high])
    if (r.errors.length)
      check(
        "quality demo without page errors",
        false,
        r.errors.slice(0, 3).join(" | "),
      );
  for (const [name, r] of [
    ["standard", std],
    ["high", high],
  ]) {
    check(
      `${name}: no path tracing, its chunk never loaded`,
      r.still.sessions === 0 &&
        r.still.steps === 0 &&
        !r.still.session &&
        !r.still.chunk,
      JSON.stringify(r.still),
    );
  }
  await stillChecks();
}

// Render quality 'auto' (the default, no ?quality): the controller fed by the real render loop. Test mode holds it
// (no adapting, nothing remembered) until the check turns it on with shorter waits; view.auto.testCostMs adds a busy
// wait to every rendered frame (a slow GPU / CPU for the controller: the frame interval grows). Software GL never
// renders the demo at the display's refresh, so the way back up is fed fake samples (ctl.fixedSampleMs: 16 ms).
async function autoChecks() {
  const q = await openDemo(
    { model: "1", view: "3d", cards: "1" },
    { width: 800, height: 500 },
  );
  try {
    const { page } = q;
    const ev = (expr) => page.evaluate(expr);
    await page.waitForFunction(`!!${card}._view.model`, { timeout: 60000 });
    await ev("window.__demoMowerPaused = true");
    await sleep(2000);
    const state = () =>
      ev(`(() => { const v = ${card}._view, a = v.auto.state();
      return { ...a, tier: v.look.quality(), bloom: !!v.look._bloom, env: !!v.scene.environment, tm: v.renderer.toneMapping, switches: v.stats.autoSwitches, frames: v.stats.frames }; })()`);
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
    // continuous rendering for ms (every animation frame renders, as while orbiting); level sampled at the end
    const run = (ms) =>
      ev(`new Promise((done) => { const v = ${card}._view, end = performance.now() + ${ms};
      const f = () => { v.dirty = true; if (performance.now() < end) requestAnimationFrame(f); else done(v.auto.level); }; requestAnimationFrame(f); })`);
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
    const during = await run(6000);
    const s1 = await state();
    check(
      "auto: slow frames under interaction: a step down proposed, not applied while rendering",
      during === "high" && s1.pending === "standard" && s1.switches === 0,
      JSON.stringify({ during, ...s1 }),
    );
    await sleep(2500); // idle: applied after AUTO_IDLE_MS
    const s2 = await state();
    check(
      "auto: once idle, down to standard (no bloom, no sky environment, the recipe tone mapping)",
      s2.level === "standard" &&
        s2.tier === "standard" &&
        !s2.bloom &&
        !s2.env &&
        s2.tm !== 6 &&
        s2.switches === 1,
      JSON.stringify(s2),
    );
    await run(3000);
    await sleep(1500); // still slow: no level below standard here (pixel ratio 1)
    const s3 = await state();
    check(
      "auto: stays at the lowest level, no more switches",
      s3.level === "standard" && s3.switches === 1,
      JSON.stringify(s3),
    );
    await ev(
      `(() => { const a = ${card}._view.auto; a.testCostMs = 0; a.ctl.fixedSampleMs = 16; })()`,
    );
    let up = null;
    for (let i = 0; i < 6 && !up; i++) {
      await run(2000);
      await sleep(1500);
      const s = await state();
      if (s.level === "high") up = s;
    }
    const s4 = up || (await state());
    console.log(
      `     auto: measured median frame with the cost: high ${s1.median === null ? "–" : s1.median.toFixed(1)} ms, standard ${s3.median === null ? "–" : s3.median.toFixed(1)} ms; refresh ${s4.refreshMs.toFixed(1)} ms`,
    );
    check(
      "auto: fast frames again: back up to high after the wait",
      s4.level === "high" &&
        s4.tier === "high" &&
        s4.bloom &&
        s4.env &&
        s4.switches === 2,
      JSON.stringify(s4),
    );
    await run(3000);
    await sleep(1500);
    const s5 = await state();
    check(
      "auto: no oscillation while frames stay fast",
      s5.level === "high" && s5.switches === 2,
      JSON.stringify(s5),
    );
    const err = await ev(
      `(() => { const v = ${card}._view; v.dirty = true; return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(v.renderer.getContext().getError())))); })()`,
    );
    check(
      "auto: switches without GL errors or page errors",
      err === 0 && !q.errors.length,
      `${err} ${q.errors.slice(0, 3).join(" | ")}`,
    );
    const dbg = await ev(
      `${card}._view.auto.state() && localStorage.getItem('floorplan3d.quality')`,
    );
    check("auto: test mode remembers nothing", dbg === null, String(dbg));
  } finally {
    await q.close();
  }
}

// Render quality 'still': idle progressive path tracing (test mode: a few samples a session).
async function stillChecks() {
  const q = await openDemo(
    { model: "1", view: "3d", cards: "1", quality: "still" },
    { width: 1200, height: 700 },
  );
  try {
    const { page } = q;
    const ev = (expr) => page.evaluate(expr);
    await page.waitForFunction(`!!${card}._view.model`, { timeout: 60000 });
    await ev("window.__demoMowerPaused = true");
    const st = () =>
      ev(`JSON.stringify((() => { const v = ${card}._view, s = v.still; return { sessions: v.stats.stillSessions, steps: v.stats.stillSteps, draws: v.stats.stillDraws, builds: v.stats.stillBuilds, frames: v.stats.frames,
      active: s.active, done: s.done, hold: s.hold, spp: s.samples, after: Math.round(s.startedAfter), gl: v.renderer.getContext().getError(),
      chunk: performance.getEntriesByType('resource').some((r) => /path-tracer-/.test(r.name)) }; })())`).then(
        JSON.parse,
      );
    const waitFor = (expr, timeout = 120000) =>
      page.waitForFunction(expr, { timeout, polling: 200 }).then(
        () => true,
        () => false,
      );
    const traced = await waitFor(`${card}._view.still.done`);
    const a = await st();
    console.log(`     still: first session ${JSON.stringify(a)}`);
    check(
      "still: traces once idle (>= 3 s after the last frame), its chunk loaded, drawn only from the fade threshold, done at the test cap, no GL error",
      traced &&
        a.sessions === 1 &&
        a.builds === 1 &&
        a.draws > 0 &&
        a.draws < a.steps &&
        a.after >= 2900 &&
        a.chunk &&
        a.spp >= 3 &&
        a.done &&
        a.gl === 0,
      JSON.stringify(a),
    );
    await sleep(1500);
    const b = await st();
    check(
      "still: nothing runs once the budget is spent (no tile, no frame)",
      b.steps === a.steps && b.frames === a.frames && b.sessions === 1,
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
    await waitFor(
      `!${card}._view.dirty && ${card}._view.cam.controls.update() === false`,
      5000,
    );
    await sleep(1500);
    const c = await st();
    check(
      "still: the idle time counts again after the move (no session within 1.5 s)",
      c.sessions === 1 && !c.active,
      JSON.stringify(c),
    );
    const again = await waitFor(
      `${card}._view.still.done && ${card}._view.stats.stillSessions === 2`,
    );
    const d = await st();
    check(
      "still: a second idle session reuses the traced scene (no rebuild)",
      again && d.sessions === 2 && d.builds === 1 && d.gl === 0,
      JSON.stringify(d),
    );
    // held off: edit mode, off screen
    await ev(`${card}._view.setEditing(true); ${card}._view.dirty = true`);
    await sleep(4500);
    const e = await st();
    await ev(
      `${card}._view.setEditing(false); ${card}._view.setOnScreen(false); ${card}._view.dirty = true`,
    );
    await sleep(4500);
    const f = await st();
    await ev(`${card}._view.setOnScreen(true)`);
    check(
      "still: no trace while editing or off screen",
      e.sessions === 2 &&
        e.hold === "edit" &&
        !e.active &&
        f.sessions === 2 &&
        f.hold === "offscreen" &&
        !f.active,
      JSON.stringify({ edit: e, off: f }),
    );
    // the tier changed to high: the path tracer freed, nothing traced
    await ev(`${card}._view.setRenderOption({ quality: 'high' })`);
    await sleep(4500);
    const g = await ev(
      `JSON.stringify({ session: !!${card}._view.still.session, sessions: ${card}._view.stats.stillSessions, hold: ${card}._view.still.hold })`,
    ).then(JSON.parse);
    check(
      "still -> high: the path tracer freed, no session",
      !g.session && g.sessions === 2 && g.hold === "tier",
      JSON.stringify(g),
    );
    // SwiftShader has no parallel shader compile: three warns once when the path tracer compiles (it then compiles at once)
    const errors = q.errors.filter(
      (m) => !m.includes("KHR_parallel_shader_compile extension not supported"),
    );
    if (errors.length)
      check(
        "still demo without page errors",
        false,
        errors.slice(0, 3).join(" | "),
      );
  } finally {
    await q.close();
  }
}

if (QUALITY_ONLY || AUTO_ONLY) {
  if (QUALITY_ONLY) await qualityChecks();
  await autoChecks();
  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log("\nquality perf check passed");
  process.exit(0);
}

const s = await openDemo(
  { model: "1", view: "3d", cards: "1", robotmap: "1600", debug: "1" },
  { width: 1200, height: 700 },
);
try {
  const { page } = s;
  const ev = (expr) => page.evaluate(expr);
  const until = (expr, label, timeout = 20000) =>
    page.waitForFunction(expr, { timeout }).then(
      () => true,
      () => {
        console.log(`     (timed out waiting for ${label})`);
        return false;
      },
    );
  await until(`!!${card}._view.model`, "the model", 60000);
  check(
    "the benchmark runs at the default render quality, high",
    (await ev(`${card}._view.look.renderOpt.quality`)) === "high",
    await ev(`${card}._view.look.renderOpt.quality`),
  );
  await ev("window.__demoMowerPaused = true");
  const n = await ev(
    `window.__robotFrames(${(MOVE_S * 1000) / REFRESH_MS + 2}, 0.3, 0.08)`,
  );
  check("benchmark frames rendered ahead", n > 10, String(n));
  await ev("window.__setRobotFrame(0)");
  await ev(`(() => { const c = ${card}, l = c._layout; c._commit({ ...l, objects: { ...(l.objects || {}), mower: { entity: 'lawn_mower.robo' }, dock: { entity: 'lawn_mower.robo' } },
    mower: { entity: 'lawn_mower.robo', source: 'image', floor_id: l.mower.floor_id, calibration: [],
    overlay: { entity: 'camera.robo_live_map', x: 16.5, y: 1.5, rotation: 0, width: 17, opacity: 0.6, refresh: 2 } } }); })()`);
  check(
    "mower found on the 1600 px map",
    await until(
      `(() => { const r = ${card}._imageResult; return !!${card}._imageBlob && !!r && !r.missing && !r.error; })()`,
      "the first detection",
      60000,
    ),
    JSON.stringify(await ev(`${card}._imageResult`)),
  );
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
  const metric = async () => {
    const m = await page.metrics();
    return m.TaskDuration * 1000;
  };
  // the page's own baseline (render loop ticks, timers) without any refresh, for comparison
  const q0 = await metric();
  await sleep(10000);
  const quiet = ((await metric()) - q0) / (10000 / REFRESH_MS);
  const task0 = await metric();
  const stats0 = await ev(
    `(() => { const v = ${card}._view; return { frames: v.stats.frames, shadow: v.stats.shadow, shadowLights: v.stats.shadowLights }; })()`,
  );
  for (let i = 1; i <= (MOVE_S * 1000) / REFRESH_MS; i++) {
    await ev(`window.__setRobotFrame(${i})`);
    await sleep(REFRESH_MS);
  }
  const stats1 = await ev(
    `(() => { const v = ${card}._view; return { frames: v.stats.frames, shadow: v.stats.shadow, shadowLights: v.stats.shadowLights }; })()`,
  );
  const moving = await ev("JSON.parse(JSON.stringify(window.__bench))");
  const task1 = await metric();
  for (let i = 0; i < (IDLE_S * 1000) / REFRESH_MS; i++) {
    await ev(`window.__setRobotSame(${(MOVE_S * 1000) / REFRESH_MS})`);
    await sleep(REFRESH_MS);
  }
  const stats2 = await ev(
    `(() => { const v = ${card}._view; return { frames: v.stats.frames, shadow: v.stats.shadow, shadowLights: v.stats.shadowLights }; })()`,
  );
  const all = await ev("JSON.parse(JSON.stringify(window.__bench))");
  const task2 = await metric();
  await ev("clearInterval(window.__benchPoll)");

  const ref = moving.refresh;
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const mainAvg = avg(ref.map((r) => r.main)),
    mainMax = Math.max(0, ...ref.map((r) => r.max));
  const rMax = Math.max(0, ...moving.renders),
    rAvg = avg(moving.renders);
  const longs = moving.long.filter((l) => l.ms > 50);
  console.log(
    `     refreshes measured: ${ref.length}; main-thread ms per refresh avg ${mainAvg.toFixed(1)}, longest card section ${mainMax.toFixed(1)} ms`,
  );
  if (ref.length && ref[0].decode !== undefined)
    console.log(
      `     stages (avg): decode ${avg(ref.map((r) => r.decode)).toFixed(1)} ms, worker ${avg(ref.map((r) => r.worker)).toFixed(1)} ms, apply ${avg(ref.map((r) => r.apply)).toFixed(1)} ms`,
    );
  const perRefresh = (task1 - task0) / ((MOVE_S * 1000) / REFRESH_MS),
    perIdle = (task2 - task1) / ((IDLE_S * 1000) / REFRESH_MS);
  console.log(
    `     whole page main-thread busy per 2 s (CDP TaskDuration): ${perRefresh.toFixed(1)} ms moving, ${perIdle.toFixed(1)} ms unchanged picture, ${quiet.toFixed(1)} ms no refresh at all`,
  );
  console.log(
    `     last detection: ${JSON.stringify(await ev(`${card}._imageResult`))}`,
  );
  console.log(
    `     renders: ${moving.renders.length} in ${MOVE_S} s, avg ${rAvg.toFixed(1)} ms, max ${rMax.toFixed(1)} ms`,
  );
  console.log(
    `     page long tasks > 50 ms while moving: ${longs.length}${longs.length ? ` (max ${Math.max(...longs.map((l) => l.ms)).toFixed(0)} ms)` : ""}${moving.noLongtask ? " (no longtask API)" : ""}`,
  );
  const movingFrames = stats1.frames - stats0.frames,
    idleFrames = stats2.frames - stats1.frames;
  console.log(
    `     frames: ${movingFrames} while moving (${MOVE_S} s), ${idleFrames} while idle (${IDLE_S} s); shadow requests ${stats1.shadow - stats0.shadow}`,
  );
  check("refreshes measured", ref.length >= 10, String(ref.length));
  // shared CI runners hiccup: p90 <= 50 ms, max <= 120 ms there (strict 50 ms max locally)
  const sorted = ref.map((r) => r.max).sort((a, b) => a - b);
  const p90 = sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)]
    : 0;
  const maxLimit = process.env.CI ? 120 : 50;
  check(
    `main-thread map sections of the card: p90 <= 50 ms, max <= ${maxLimit} ms`,
    p90 <= 50 && mainMax <= maxLimit,
    `p90 ${p90.toFixed(1)}, max ${mainMax.toFixed(1)}`,
  );
  check(
    "renders while idle <= refresh-driven ones",
    idleFrames * (MOVE_S / IDLE_S) <= movingFrames,
    `${idleFrames} idle vs ${movingFrames} moving`,
  );
  check(
    "the moving mower requests no shadow-map updates",
    stats1.shadow - stats0.shadow === 0,
    String(stats1.shadow - stats0.shadow),
  );
  const dbg = await ev(
    `(() => { const el = ${card}.shadowRoot.querySelector('.fp-debug'); return el ? el.textContent : null; })()`,
  );
  check(
    "debug overlay shows fps, frame ms, long task, map stages",
    !!dbg &&
      /fps/i.test(dbg) &&
      /frame/i.test(dbg) &&
      /decode/.test(dbg) &&
      /worker/.test(dbg),
    String(dbg).slice(0, 300),
  );
  if (process.env.BENCH_JSON)
    console.log(
      JSON.stringify({
        mainAvg,
        mainMax,
        rAvg,
        rMax,
        longs: longs.length,
        movingFrames,
        idleFrames,
        all: all.refresh.length,
      }),
    );
  if (s.errors.length)
    console.log("page errors:", s.errors.slice(0, 5).join(" | "));
} finally {
  await s.close();
}
await qualityChecks();
await autoChecks();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nperf check passed");
