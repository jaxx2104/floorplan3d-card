// Headless check of the GLB underlay:
// - demo with ?model=1: model loads, level groups follow the floor chips, roof is cut away
// - a missing model shows a notice instead of breaking the card
//   node scripts/model-check.mjs [--shard k/n] [--only group,group] [--jobs N] [--list]
// Without --shard / --only the section groups run as parallel shards (--jobs, default 3).
import fs from "node:fs";
import path from "node:path";
import { openDemo, root } from "./lib/demo-browser.mjs";
import { Sections, parseArgs, selectGroups } from "./lib/sections.mjs";
import { transformPoint } from "../src/bindings.ts";
import { alignModelPoint } from "../src/views.ts";
import { fitOutline, HOUSE_OUTLINE } from "../src/load-outline.ts";
import { matchExposure } from "../src/render-recipe.ts";
import { ENV_DAY } from "../src/view/env-light.ts";

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " – " + detail : ""}`);
  if (!ok) failures.push(name);
};
// wait until the 400 ms camera tween has finished (fixed sleeps flake under load)
const settle = async (page, card) => {
  await page
    .waitForFunction(`!${card}._view._tween`, { timeout: 5000 })
    .catch(() => {});
  await idle(page);
};
const card = 'document.querySelector("floorplan3d-card-impl")';
// Instead of fixed sleeps after camera moves, renders and state changes: two frames, then until the
// view and card are idle (no camera tween, frame drawn, no occlusion pass, rebuild, surface job or
// pending single tap), at most 5 s.
const idle = (page) =>
  page.evaluate(`new Promise((done) => {
  const t0 = performance.now();
  let n = 0;
  const tick = () => {
    const c = ${card}, v = c && c._view;
    const ok = ++n > 2 && (!v || (!v._tween && !v.dirty && !c._pending && !c._surfJob && !(c._taps && c._taps.pending.size)));
    if (ok || performance.now() - t0 > 5000) done(ok); else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})`);
// move the camera and wait until it is drawn there (the sprites read the frame's depth: nothing else to wait for)
const camAndOcclusion = async (page, cam) => {
  await page.evaluate(
    `${card}._view.setCamera(${typeof cam === "string" ? cam : JSON.stringify(cam)}, { instant: true })`,
  );
  await page
    .waitForFunction(
      `(() => { const v = ${card}._view; return !v._tween && !v.dirty; })()`,
      { timeout: 5000 },
    )
    .catch(() => console.log("     (the camera move was not drawn in 5 s)"));
};
// A press held past the long press (LONG_PRESS_MS, 500 ms): held until the card's own gesture says its long-press
// timer has fired (g.long: the timing is the card's, nothing timed here), then released and idle.
const holdAt = async (page, p) => {
  await page.mouse.move(p[0], p[1]);
  await page.mouse.down();
  await waitTrue(
    page,
    `(() => { const g = ${card}._objectInput._gesture; return !!g && g.long; })()`,
    "the long press",
    10000,
  );
  await page.mouse.up();
  await idle(page);
};
// n animation frames, nothing forced: the window of a "nothing happens" check, counted in frames (not ms), taken
// once the pending work it is about is clear
const rafs = (page, n) =>
  page.evaluate(
    `new Promise((done) => { let i = 0; const f = () => (++i >= ${n} ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); })`,
  );
// n rendered frames: the view marked dirty on each of n animation frames
const renderFrames = (page, n) =>
  page.evaluate(`new Promise((done) => { let i = 0;
  const f = () => { if (i++ >= ${n}) { done(); return; } const v = ${card}._view; if (v) v.dirty = true; requestAnimationFrame(f); };
  requestAnimationFrame(f); })`);
// Lamps that got a real light draw no wash (the real light lights that wall or floor itself); washes stand in only
// for lit lamps left without one. The demo's lamps all fit the pool, so the wash checks take these lamps out of
// it, as a lamp whose hints give no real light (part.pool false, like a light strip without hints.max).
const noRealLight = (ids) =>
  `(() => { const c = ${card}; for (const id of ${JSON.stringify(ids)}) c._objects.parts.get(id).part.pool = false; c._updateObjects(); })()`;
// until a page predicate holds (instead of a fixed sleep) -> true, or false after timeout (logged)
const waitTrue = (page, expr, label, timeout = 30000) =>
  page.waitForFunction(expr, { timeout, polling: 50 }).then(
    () => true,
    () => {
      console.log(`     (timed out waiting for ${label})`);
      return false;
    },
  );
let allErrors = [];
const sections = new Sections();
// The sections run at quality 'standard' (the cheap tier: no bloom, coarser probes; the same light as 'high') unless
// their query sets one. The default tier ('high') has its own section here (quality-default) and the tier checks in
// perf-check.
const addSection = sections.add.bind(sections);
sections.add = (name, opts, fn) =>
  addSection(
    name,
    opts.query && !("quality" in opts.query)
      ? { ...opts, query: { quality: "standard", ...opts.query } }
      : opts,
    fn,
  );
let s; // the optional runs at the end (own browsers)

function rewriteGlbJson(buf, edit) {
  const jsonLen = buf.readUInt32LE(12);
  const json = edit(JSON.parse(buf.toString("utf8", 20, 20 + jsonLen)));
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const rest = buf.subarray(20 + jsonLen); // BIN chunk unchanged
  const head = Buffer.alloc(20);
  head.write("glTF", 0, "latin1");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + j.length + rest.length, 8);
  head.writeUInt32LE(j.length, 12);
  head.write("JSON", 16, "latin1");
  return Buffer.concat([head, j, rest]);
}

// 1. model in the demo
sections.add(
  "model",
  {
    group: "model",
    query: { model: "1", view: "3d" },
    viewport: { width: 1400, height: 560 },
  },
  async (s) => {
    const { page } = s;
    await page.waitForFunction(`!!${card}._view.model`, { timeout: 30000 });
    await idle(page);
    const st = () =>
      page.evaluate(`(() => { const v = ${card}._view; const vis = (id) => v.modelManifest().levels.find((l) => l.id === id)?.node.visible; return {
    level0: vis('level0'), level1: vis('level1'), exterior: vis('exterior'), roof: vis('roof'),
    cut: v.modelClip.constant, floors: v.modelManifest().levels.map((l) => l.id) }; })()`);
    const sh = (name) =>
      page.screenshot({ path: path.join(root, "screenshots", name) });
    fs.mkdirSync(path.join(root, "screenshots"), { recursive: true });
    let v = await st();
    check(
      "model loaded with level groups",
      JSON.stringify(v.floors) === '["level0","level1","exterior","roof"]',
      JSON.stringify(v.floors),
    );
    const chipList = () =>
      page.evaluate(
        `[...${card}.shadowRoot.querySelectorAll('.chip')].map((b) => b.textContent)`,
      );
    check(
      "chips are the model's views in order",
      JSON.stringify(await chipList()) ===
        '["Exterior","Ground floor","First floor"]',
      JSON.stringify(await chipList()),
    );
    const chip = async (id) => {
      await page.evaluate(
        `${card}.shadowRoot.querySelector('.chip[data-view=${id}]').click()`,
      );
      await idle(page);
    };
    // devices by the level of their model room (roomless ones by HA floor): shown / hidden / faded
    const devs = () =>
      page.evaluate(`(() => { const c = ${card}, v = c._view; const lvl = new Map(v.modelManifest().rooms.map((r) => [r.id, r.level]));
    const out = {};
    for (const m of c._markers) {
      const p = c._positions.get(m.id), o = v.markerObjects.get(m.id);
      if (!p || !o) continue;
      const room = p.auto === false || p.live ? null : (c._modelRooms.find((r) => r.area_id === m.areaId) || {}).modelId;
      const k = room ? lvl.get(room) : p.live ? 'mower' : 'pin:' + p.floorId;
      const e = out[k] = out[k] || { shown: 0, hidden: 0, faded: 0 };
      if (o.obj.visible) e.shown++; else e.hidden++;
      if (o.faded) e.faded++;
    }
    return out; })()`);
    const noneFaded = (d) => Object.values(d).every((e) => e.faded === 0);
    await chip("ground");
    v = await st();
    check(
      "Ground floor view: level0 + exterior shown, level1 + roof hidden, tagged model not cut",
      v.level0 === true &&
        v.level1 === false &&
        v.exterior === true &&
        v.roof === false &&
        v.cut > 1000,
      JSON.stringify(v),
    );
    let d = await devs();
    check(
      "Ground floor view: ground-floor devices shown, first-floor devices hidden, outdoor shown",
      d.level0.shown > 0 &&
        d.level0.hidden === 0 &&
        d.level1.shown === 0 &&
        d.level1.hidden > 0 &&
        d.exterior.hidden === 0 &&
        noneFaded(d),
      JSON.stringify(d),
    );
    await settle(page, card);
    await sh("look-day.png");
    await sh("model-ground.png");

    // render fixes: depth range, glass shadows, depth kept when ghosted, markers behind walls
    const depth = await page.evaluate(
      `(() => { const c = ${card}._view.persp; return { near: c.near, far: c.far }; })()`,
    );
    check(
      "depth range: near >= 0.2, far within 50..500 after load",
      depth.near >= 0.2 && depth.far >= 50 && depth.far <= 500,
      JSON.stringify(depth),
    );
    // a 200 m terrain: the far plane must still reach its farthest corner from the exterior view at max distance
    await chip("exterior");
    const terrain =
      await page.evaluate(`(async () => { const c = ${card}, v = c._view;
    const sofa = v.model.root.getObjectByName('sofa_body'); // borrow the bundle's three classes
    const three = { Vector3: v.persp.position.constructor };
    const g = sofa.geometry.clone(); // a 200 x 0.1 x 200 m box centred on the origin
    g.computeBoundingBox();
    const bb = g.boundingBox, cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2;
    g.translate(-cx, -cy, -cz).scale(200 / (bb.max.x - bb.min.x), 0.1 / (bb.max.y - bb.min.y), 200 / (bb.max.z - bb.min.z));
    const m = new sofa.constructor(g, sofa.material.clone());
    m.name = 'test_terrain'; m.userData.fp = { layer: 'terrain' }; m.position.set(6, -0.3, -4.5);
    // drawn: an animation frame with no tween and no frame due (instead of fixed waits)
    const drawn = () => new Promise((r) => { const f = () => (!v._tween && !v.dirty ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    v.model.root.add(m); c._loadModel(); await drawn();
    const cam = v.getCamera(), t = cam.target, p = cam.position, d = Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
    v.setCamera({ target: t, position: p.map((x, i) => t[i] + ((x - t[i]) * 130) / d) }, { instant: true });
    await drawn();
    v.persp.updateMatrixWorld();
    let far = 0; m.updateMatrixWorld(true);
    for (const [x, z] of [[-100, -100], [100, -100], [100, 100], [-100, 100]]) {
      const w = new three.Vector3(x, 0, z).applyMatrix4(m.matrixWorld).applyMatrix4(v.persp.matrixWorldInverse);
      far = Math.max(far, -w.z);
    }
    const out = { cornerDepth: far, near: v.persp.near, far: v.persp.far, dist: 130 };
    v.model.root.remove(m); g.dispose(); m.material.dispose(); c._loadModel(); v.setCamera(cam, { instant: true });
    await drawn();
    return out; })()`);
    check(
      "far plane covers a 200 m terrain from 130 m away",
      terrain.cornerDepth < terrain.far && terrain.far <= 500 * 1.05,
      JSON.stringify(terrain),
    );
    await chip("ground");
    const shadows =
      await page.evaluate(`(() => { const r = ${card}._view.model.root; const pane = r.getObjectByName('window_pane_living');
    const body = r.getObjectByName('sofa_body');
    let clip = 0; r.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if (m.clippingPlanes && m.clippingPlanes.length) clip++; });
    return { pane: pane && [pane.castShadow, pane.receiveShadow], sofa: body && body.castShadow, clip, normalBias: ${card}._view.sun.shadow.normalBias }; })()`);
    check(
      "glass pane casts no shadow (still receives), furniture casts",
      !!shadows.pane &&
        shadows.pane[0] === false &&
        shadows.pane[1] === true &&
        shadows.sofa === true,
      JSON.stringify(shadows),
    );
    check(
      "tagged model: no clipping planes on its materials; sun normalBias 0.02",
      shadows.clip === 0 && shadows.normalBias === 0.02,
      JSON.stringify(shadows),
    );
    const ghost =
      await page.evaluate(`(async () => { const c = ${card}, v = c._view; const m = v.model.root.getObjectByName('sofa_body').material;
    const pane = v.model.root.getObjectByName('window_pane_living').material;
    const drawn = () => new Promise((r) => { const f = () => (!v._tween && !v.dirty ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    c._config = { ...c._config, model_opacity: 0.6 }; c._loadModel(); await drawn();
    const out = { depthWrite: m.depthWrite, alphaHash: m.alphaHash, transparent: m.transparent, opacity: m.opacity, paneOpacity: pane.opacity, paneTransparent: pane.transparent };
    c._config = { ...c._config, model_opacity: 1 }; c._loadModel(); await drawn();
    out.back = { alphaHash: m.alphaHash, opacity: m.opacity, depthWrite: m.depthWrite };
    return out; })()`);
    check(
      "opacity 0.6: opaque material keeps depthWrite, glass untouched; 1 restores",
      ghost.depthWrite === true &&
        ghost.transparent === true &&
        ghost.opacity === 0.6 &&
        ghost.paneTransparent === true &&
        Math.abs(ghost.paneOpacity - 0.35) < 1e-6 &&
        ghost.back.opacity === 1 &&
        ghost.back.depthWrite === true,
      JSON.stringify(ghost),
    );
    // a ground-floor marker seen from outside the south facade, through the wall
    const occ = await page.evaluate(`(() => { const c = ${card}, v = c._view;
    for (const [id, m] of v.markerObjects) {
      const p = m.obj.position;
      if (!m.obj.visible || m.floorId !== 'ground' || p.y < 0.3 || p.y > 2.0 || -p.z < 1 || -p.z > 4.5 || p.x < 0.5 || p.x > 11.5) continue;
      return { id, pos: p.toArray() };
    }
    return null; })()`);
    if (occ) {
      const camBefore = await page.evaluate(`${card}._view.getCamera()`);
      await camAndOcclusion(page, {
        position: [occ.pos[0], occ.pos[1] + 2, occ.pos[2] + 12],
        target: occ.pos,
      });
      const cls = (id) =>
        page.evaluate(`${card}._view.markerHidden(${JSON.stringify(id)})`);
      check(
        "a marker behind the south wall is hidden from a camera outside",
        await cls(occ.id),
        JSON.stringify(occ),
      );
      // [opacity where the model hides it, a tap at its dot lands on it]
      const style = (id) =>
        page.evaluate(
          `(() => { const c = ${card}, r = c._markerRect(${JSON.stringify(id)}), m = r && c._markerAt(r.x + r.width / 2, r.y + r.height / 2);
          return [c._markerView(${JSON.stringify(id)}).hiddenAlpha, !!m && m.id === ${JSON.stringify(id)}]; })()`,
        );
      check(
        "hidden marker: faint, not clickable in view mode",
        JSON.stringify(await style(occ.id)) === "[0.25,false]",
        JSON.stringify(await style(occ.id)),
      );
      await camAndOcclusion(page, {
        position: [occ.pos[0], occ.pos[1] + 14, occ.pos[2] + 3],
        target: occ.pos,
      });
      check(
        "same marker seen from above (no wall in between) is not hidden",
        !(await cls(occ.id)),
      );
      await page.evaluate(
        `${card}._view.setCamera(${JSON.stringify(camBefore)}, { instant: true })`,
      );
      await idle(page);
    } else {
      check(
        "found a ground-floor marker near the south facade for the occlusion check",
        false,
      );
    }
    await chip("first");
    v = await st();
    check(
      "First floor view: both storeys stack, exterior shown, roof hidden",
      v.level0 && v.level1 && v.exterior && !v.roof,
      JSON.stringify(v),
    );
    d = await devs();
    check(
      "First floor view: ground-floor devices hidden (not faded), first-floor and outdoor devices shown",
      d.level0.shown === 0 &&
        d.level0.hidden > 0 &&
        d.level1.shown > 0 &&
        d.level1.hidden === 0 &&
        d.exterior.hidden === 0 &&
        noneFaded(d),
      JSON.stringify(d),
    );
    // pins take the room / zone under them (the floor lamp stands in the living room), the mower is outdoors
    check(
      "First floor view: a ground-floor pin in a ground-floor room is hidden",
      d["pin:ground"] && d["pin:ground"].shown === 0,
      JSON.stringify(d["pin:ground"]),
    );
    check(
      "First floor view: the live mower is shown (exterior visible)",
      !d.mower || d.mower.shown === 1,
      JSON.stringify(d.mower),
    );
    await sh("model-first.png");
    const shownMarkers = () =>
      page.evaluate(
        `[...${card}._view.markerObjects.values()].filter((m) => m.obj.visible).length`,
      );
    const allMarkers = await page.evaluate(`${card}._view.markerObjects.size`);
    await chip("exterior");
    v = await st();
    check(
      "Exterior view: every level shown uncut",
      v.level0 && v.level1 && v.exterior && v.roof && v.cut > 1000,
      JSON.stringify(v),
    );
    const faded = () =>
      page.evaluate(
        `[...${card}._view.markerObjects.values()].filter((m) => m.faded).length`,
      );
    check(
      "Exterior view (overview): every device shown, none faded",
      (await faded()) === 0 && (await shownMarkers()) === allMarkers,
      `${await shownMarkers()}/${allMarkers}`,
    );
    check(
      "Exterior view (overview): no room labels",
      (await page.evaluate(
        `${card}._view.sprites.labels('room', true).length`,
      )) === 0,
    );
    await page.screenshot({
      path: path.join(root, "screenshots", "model-exterior.png"),
    });
    await page.evaluate(`${card}._setFloor('first')`);
    await idle(page);
    check(
      "_setFloor prefers the storey view over the overview linked to the same floor",
      (await page.evaluate(`${card}._viewId`)) === "first",
      await page.evaluate(`${card}._viewId`),
    );
    await chip("ground");
    check("single floor: no faded markers", (await faded()) === 0);
    check(
      "no notice",
      await page.evaluate(`${card}.shadowRoot.querySelector('.notice').hidden`),
    );

    const look =
      await page.evaluate(`(() => { const v = ${card}._view; return { tm: v.renderer.toneMapping, sm: v.renderer.shadowMap.enabled,
    sr: v.sun.shadow.camera.right, pr: v.renderer.getPixelRatio(),
    fills: (() => { let n = 0; v.staticGroup.traverse((o) => { if (o.isMesh && o.userData.roomId) n++; }); return n; })(),
    labels: ${card}._view.sprites.labels('room', true).length, tagged: v.isTagged(),
    hasModel: ${card}._stage.classList.contains('has-model'), dayHidden: ${card}.shadowRoot.querySelector('button.daynight').hidden }; })()`);
    check("AgX tone mapping with a model", look.tm === 6, String(look.tm));
    check(
      "shadows on, shadow camera fitted to the model",
      look.sm === true && look.sr < 40,
      `${look.sm} ${look.sr}`,
    );
    check("pixel ratio capped", look.pr <= 1.5, String(look.pr));
    check(
      "no room fills; ground view labels its own rooms with sizes",
      look.fills === 0 &&
        look.labels > 0 &&
        (
          await page.evaluate(`${card}._view.sprites.labels('room', true)[0]`)
        ).includes(" m"),
      JSON.stringify(look),
    );
    check(
      "stage has has-model, day/night button shown",
      look.hasModel && !look.dayHidden,
    );
    // framing uses the room polygons even though no fills/outlines/walls are rendered with a model
    await page.evaluate(
      `${card}._setFloor('ground'); ${card}._view.setMode('3d'); ${card}._view.fit({ instant: true })`,
    );
    await idle(page);
    const dist = () =>
      page.evaluate(
        `(() => { const v = ${card}._view; return v.persp.position.distanceTo(v.controls.target); })()`,
      );
    const ext = await page.evaluate(
      `(() => { let a = 1e9, b = -1e9, c = 1e9, d = -1e9; for (const { room } of ${card}._view._rooms) for (const [x, y] of room.polygon) { a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, y); d = Math.max(d, y); } return Math.max(b - a, d - c); })()`,
    );
    const d0 = await dist();
    check(
      "model + rooms: camera frames the rooms",
      ext > 0 && d0 < 2.5 * ext,
      `dist ${d0.toFixed(1)} ext ${ext.toFixed(1)}`,
    );
    // chip switch keeps the camera; Reset view frames again
    const camAt = () =>
      page.evaluate(
        `${card}._view.persp.position.toArray().map((x) => x.toFixed(2)).join()`,
      );
    await page.evaluate(
      `${card}._view.setCamera({ position: [30, 30, 30], target: [0, 0, 0] }, { instant: true })`,
    );
    const c0 = await camAt();
    await page.evaluate(
      `${card}.shadowRoot.querySelector('.chip[data-view=first]').click()`,
    );
    await settle(page, card);
    check(
      "chip switch keeps the camera",
      (await camAt()) === c0,
      `${c0} -> ${await camAt()}`,
    );
    await page.evaluate(
      `${card}.shadowRoot.querySelector('button.reset').click()`,
    );
    await settle(page, card);
    check("Reset view moves the camera", (await camAt()) !== c0);
    await page.evaluate(
      `${card}.saveViewPatch('first', { camera: { position: [20, 25, 20], target: [5, 0, -4] } })`,
    );
    await idle(page);
    await page.evaluate(
      `${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`,
    );
    await page.evaluate(
      `${card}.shadowRoot.querySelector('.chip[data-view=first]').click()`,
    );
    await idle(page);
    await settle(page, card);
    check(
      "saved view camera restored on chip switch",
      (await camAt()) === "20.00,25.00,20.00",
      await camAt(),
    );
    await page.evaluate(`${card}.saveViewPatch('first', { camera: null })`);
    await idle(page);
    await page.evaluate(`${card}._setFloor('ground')`);
    await settle(page, card);

    const lights = () =>
      page.evaluate(
        `({ sun: ${card}._view.sun.intensity, hemi: ${card}._view.hemi.intensity, env: ${card}._view.scene.environmentIntensity, cast: ${card}._view.sun.castShadow })`,
      );
    const day = await lights();
    await page.evaluate(
      `${card}.shadowRoot.querySelector('button.daynight').click()`,
    );
    await page.evaluate(
      `${card}.shadowRoot.querySelector('button.daynight').click()`,
    );
    await idle(page);
    const night = await lights();
    check(
      "night: sun off, the night sky's environment dimmer than the day's, no hemisphere light",
      night.sun === 0 &&
        night.cast === true &&
        night.hemi === 0 &&
        night.env > 0 &&
        night.env < ENV_DAY,
      JSON.stringify(night),
    );
    check(
      "button icon is the moon at night",
      (await page.evaluate(
        `${card}.shadowRoot.querySelector('button.daynight ha-icon').getAttribute('icon')`,
      )) === "mdi:weather-night",
    );
    await sh("look-night.png");
    await page.evaluate(
      `${card}.shadowRoot.querySelector('button.daynight').click()`,
    );
    await idle(page);
    check(
      "auto without sun.sun is day",
      JSON.stringify(await lights()) === JSON.stringify(day) && day.sun > 0,
      JSON.stringify(day),
    );

    // sky: auto follows sun.sun, button cycles auto -> day -> night -> auto, mode persists
    const mode = () => page.evaluate(`${card}._skyMode`);
    const tint = (e, a) => page.evaluate(`window.__setDemoSun(${e}, ${a})`);
    check("sky mode starts auto", (await mode()) === "auto");
    await tint(-20, 180);
    await idle(page);
    const sNight = await lights();
    check(
      "auto: sun at -20 deg -> sun 0, the night sky's environment, no hemisphere light",
      sNight.hemi === 0 && sNight.env < ENV_DAY && sNight.sun === 0,
      JSON.stringify(sNight),
    );
    await tint(30, 180);
    await idle(page);
    const sDay = await lights();
    check(
      "auto: sun at +30 deg -> sun 2.6, the day sky's environment, no hemisphere light",
      sDay.hemi === 0 &&
        Math.abs(sDay.env - ENV_DAY) < 1e-6 &&
        Math.abs(sDay.sun - 2.6) < 0.001,
      JSON.stringify(sDay),
    );
    const shadowsBefore = await page.evaluate(`${card}._view.stats.shadow`);
    await tint(30.2, 180.2);
    await idle(page);
    check(
      "a sun move under 1 deg does not redraw shadows",
      (await page.evaluate(`${card}._view.stats.shadow`)) === shadowsBefore,
    );
    await tint(45, 220);
    await idle(page);
    check(
      "a larger sun move redraws shadows",
      (await page.evaluate(`${card}._view.stats.shadow`)) > shadowsBefore,
    );
    const btn = `${card}.shadowRoot.querySelector('button.daynight')`;
    const seq = [];
    for (let i = 0; i < 3; i++) {
      await page.evaluate(`${btn}.click()`);
      seq.push(await mode());
    }
    check(
      "button cycles auto -> day -> night -> auto",
      seq.join() === "day,night,auto",
      seq.join(),
    );
    await page.evaluate(`${btn}.click()`);
    check(
      "mode persists in localStorage",
      (await page.evaluate(`localStorage.getItem('floorplan3d.sky')`)) ===
        "day",
    );
    await page.evaluate(`${btn}.click()`);
    await page.evaluate(`${btn}.click()`);
    await tint(60, 180);
    await idle(page);
    check(
      "auto again after the cycle: sun at +60 deg is day",
      (await page.evaluate(`${card}._skyMode`)) === "auto" &&
        (await lights()).sun > 2.5,
    );
    await tint(-3, 180);
    await idle(page);
    const horizon = await page.evaluate(
      `({ y: ${card}._view.sun.position.y - ${card}._view.sun.target.position.y, i: ${card}._view.sun.intensity })`,
    );
    check(
      "sun below the horizon lights nothing and never from below",
      horizon.i < 0.3 && horizon.y > 0,
      JSON.stringify(horizon),
    );

    // sun / moon on a dome around the house + compass ring, faint moonlight, no shader recompiles per update
    const bodies = () =>
      page.evaluate(`(() => { const v = ${card}._view, cam = v.camera, d = v._dome;
    const o = (s) => { if (!s || !s.visible) return null; const p = s.position.clone().project(cam);
      const rel = (s.userData.domePos || s.position).clone().sub(d.centre); return { ndc: [p.x, p.y, p.z].map((x) => Math.round(x * 100) / 100), inView: Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z >= -1 && p.z <= 1,
        el: Math.asin(rel.y / rel.length()) * 180 / Math.PI, az: (Math.atan2(rel.x, rel.z) * 180 / Math.PI + 360) % 360, r: rel.length() }; };
    const mp = v.skySprites.moon && (v.skySprites.moon.userData.domePos || v.skySprites.moon.position).clone().sub(d.centre);
    return { sun: o(v.skySprites.sun), moon: o(v.skySprites.moon), moonEl: mp && mp.length() ? Math.asin(mp.y / mp.length()) * 180 / Math.PI : null,
      moonKeptOut: !!v.skySprites.moon && v.skySprites.moon.userData.clear === 0, ring: !!v.skyRing && v.skyRing.visible, dome: d && d.radius,
      moonLight: v.moonLight.intensity, north: v.model.north || 0, programs: v.renderer.info.programs.length,
      lights: v.scene.children.filter((x) => x.isLight).length }; })()`);
    await page.evaluate("window.__demoNow = Date.UTC(2024, 3, 24, 0, 30)"); // full moon, up at 52 N 5 E
    await page.evaluate(
      `${card}.shadowRoot.querySelector('.chip[data-view=exterior]').click()`,
    );
    await settle(page, card);
    await tint(25, 200);
    await idle(page);
    let b = await bodies();
    // north 0: azimuth 200 (from north, clockwise) = south-south-west = +z, a bit -x: atan2(x, z) ~ -20 deg -> 340
    check(
      "sky: sun 25 deg / 200 deg on the dome (elevation 25, south-ish), ring shown",
      !!b.sun &&
        Math.abs(b.sun.el - 25) < 0.5 &&
        Math.abs(b.sun.r - b.dome) < 0.01 &&
        (b.north !== 0 || Math.abs(b.sun.az - 340) < 1) &&
        b.ring &&
        b.dome >= 12,
      JSON.stringify(b),
    );
    check(
      "sky: sun inside the camera frustum in the exterior view",
      !!b.sun && b.sun.inView,
      JSON.stringify(b),
    );
    await sh("sky-3d.png");
    await page.evaluate(`${card}._setMode('top')`);
    await settle(page, card);
    await idle(page);
    b = await bodies();
    check(
      "sky: sun and ring visible in top view",
      !!b.sun && b.sun.inView && b.ring,
      JSON.stringify(b),
    );
    await sh("sky-top.png");
    await page.evaluate(`${card}._setMode('3d')`);
    await settle(page, card);
    await tint(-20, 0);
    await idle(page);
    b = await bodies();
    const progs = b.programs,
      lightCount = b.lights;
    check(
      "sky: sun at -20 deg -> sun hidden, moon up, faint moonlight",
      !b.sun &&
        !!b.moon &&
        b.moon.el > 0 &&
        b.moonLight > 0.15 &&
        b.moonLight <= 0.2,
      JSON.stringify(b),
    );
    await tint(-1, 270);
    await idle(page);
    check(
      "sky: sun at -1 deg still shown (down to -2)",
      !!(await bodies()).sun,
    );
    for (const [e, a] of [
      [-15, 10],
      [-25, 30],
      [20, 120],
      [-20, 0],
    ]) {
      await tint(e, a);
      await idle(page);
    }
    await page.evaluate("window.__demoNow = Date.UTC(2024, 3, 24, 2, 30)");
    await tint(-21, 5);
    await idle(page);
    b = await bodies();
    check(
      "sky: no shader recompile / light change per sun or moon update",
      b.programs === progs && b.lights === lightCount,
      `${progs} -> ${b.programs}, lights ${lightCount} -> ${b.lights}`,
    );
    await page.evaluate(`${btn}.click()`);
    await page.evaluate(`${btn}.click()`); // night
    await idle(page);
    b = await bodies();
    check(
      "sky: manual Night -> moon at 35 deg (hidden where it would cover the rooms), sun hidden, moonlight 0.17",
      (await mode()) === "night" &&
        (!!b.moon || b.moonKeptOut) &&
        Math.abs(b.moonEl - 35) < 0.5 &&
        !b.sun &&
        Math.abs(b.moonLight - 0.17) < 0.001,
      JSON.stringify(b),
    );
    await sh("look-moon.png");
    await page.evaluate(
      `${card}.setConfig({ ...${card}._config, sky_bodies: false })`,
    );
    await idle(page);
    b = await bodies();
    check(
      "sky: sky_bodies false hides sun, moon and ring",
      !b.sun && !b.moon && !b.ring,
      JSON.stringify(b),
    );
    await page.evaluate(`${btn}.click()`); // auto
    await tint(30, 180);
    await idle(page);
    b = await bodies();
    check(
      "sky: sky_bodies false stays hidden in auto",
      !b.sun && !b.moon && !b.ring,
      JSON.stringify(b),
    );
    await page.evaluate(
      `${card}.setConfig({ ...${card}._config, sky_bodies: true })`,
    );
    await idle(page);
    b = await bodies();
    check(
      "sky: sky_bodies true shows the sun and ring again",
      !!b.sun && b.ring,
      JSON.stringify(b),
    );
    await page.evaluate("delete window.__demoNow");
    allErrors.push(...s.errors);
  },
);

// 1w. weather: clouds on the dome, sun / shadow / fill follow the cloud coverage, slow drift without recompiles
// 1b. render recipe (fp.render of the demo house): exposure, fov, lamp shadow pool, Model tab line; render: default ignores it
const renderState = (page) =>
  page.evaluate(`(() => { const c = ${card}, v = c._view, l = c._objects;
  return { exposure: v.renderer.toneMappingExposure, fov: v.persp.fov, from: v.renderFrom, shadows: l.shadowSlots,
    points: l.pool.points.length, cast: l.pool.points.filter((x) => x.castShadow).length, cap: v.shadowCap(), units: v.renderer.capabilities.maxTextures, recipeMap: v.render.lampShadows.mapSize,
    mapSize: l.pool.points[0].shadow.mapSize.x, bias: l.pool.points[0].shadow.bias, sunBias: v.sun.shadow.bias, far: v.persp.far }; })()`);
sections.add(
  "render-recipe",
  {
    group: "look",
    query: { model: "1", view: "3d" },
    viewport: { width: 1400, height: 560 },
  },
  async (s) => {
    const { page } = s;
    await page.waitForFunction(
      `!!${card}._view.model && !!${card}._objects.model`,
      { timeout: 30000 },
    );
    await idle(page);
    const r = await renderState(page);
    check(
      "render recipe: exposure 1.1 (ACES) from the model as AgX's matched exposure, fov 38",
      r.exposure === matchExposure("ACESFilmic", 1.1, "AgX") &&
        r.fov === 38 &&
        r.from &&
        r.from.keys === 11,
      JSON.stringify(r),
    );
    check(
      "render recipe: lamp shadow slots = min(6, device max, texture units - 9), pool = slots + 4",
      r.shadows === Math.max(0, Math.min(6, r.cap.max, r.units - 9)) &&
        r.points === r.shadows + 4 &&
        r.cast === r.shadows,
      JSON.stringify(r),
    );
    check(
      "render recipe: lamp map size at most 1024 and the device cap",
      r.recipeMap === Math.min(1024, r.cap.mapSize),
      JSON.stringify(r),
    );
    check(
      "render recipe: lamp / sun shadow bias from the recipe (test mode map size)",
      r.bias === -0.0008 && r.sunBias === -0.0003 && r.mapSize === 256,
      JSON.stringify(r),
    );
  },
);
sections.add(
  "render-default",
  {
    group: "look",
    query: { model: "1", view: "3d", render: "default" },
    viewport: { width: 1400, height: 560 },
  },
  async (s) => {
    const { page } = s;
    await page.waitForFunction(
      `!!${card}._view.model && !!${card}._objects.model`,
      { timeout: 30000 },
    );
    await idle(page);
    const r = await renderState(page);
    check(
      "render: default ignores the recipe (exposure 1.25 ACES as AgX's matched exposure, fov 35, 4 lamp shadows)",
      r.exposure === matchExposure("ACESFilmic", 1.25, "AgX") &&
        r.fov === 35 &&
        r.from === null &&
        r.shadows === 4 &&
        r.points === 8,
      JSON.stringify(r),
    );
  },
);

sections.add(
  "weather",
  {
    group: "look",
    query: { model: "1", view: "3d" },
    viewport: { width: 1400, height: 560 },
  },
  async (s) => {
    const { page } = s;
    await page.waitForFunction(`!!${card}._view.model`, { timeout: 30000 });
    await page.evaluate("window.__demoMowerPaused = true");
    await page.evaluate(
      `${card}.shadowRoot.querySelector('.chip[data-view=exterior]').click()`,
    );
    await settle(page, card);
    await page.evaluate("window.__setDemoSun(30, 200)");
    const wx = async (c, cond = "partlycloudy") => {
      await page.evaluate(
        `window.__setDemoWeather(${c}, ${JSON.stringify(cond)})`,
      );
      await idle(page);
    };
    const sky = () =>
      page.evaluate(`(() => { const v = ${card}._view, U = v._cloudU;
    return { shadows: v.weather.shown, strength: U.fpCloudStrength.value, cover: U.fpCloudCover.value, roomShade: U.fpRoomShade.value, offset: U.fpCloudOffset.value.toArray(),
      sun: v.sun.intensity, hemi: v.hemi.intensity, shadow: v.sun.shadow.intensity, radius: v.sun.shadow.radius, tierRadius: v.look.tier().sunShadowRadius,
      disc: v.skySprites.sun ? v.skySprites.sun.material.opacity : null, programs: v.renderer.info.programs.length, frames: v.stats.cloudFrames }; })()`);
    await wx(0, "sunny");
    const clear = await sky();
    check(
      "weather 0 %: no cloud shadows, full sun, hard shadow",
      clear.shadows === 0 &&
        clear.strength === 0 &&
        clear.sun > 2.5 &&
        clear.shadow === 1 &&
        clear.disc === 1,
      JSON.stringify(clear),
    );
    await wx(60);
    const part = await sky();
    check(
      "weather 60 %: cloud shadows on ~60 % of the ground, the sun keeps its strength between them, rooms x0.55, shadow 0.61",
      part.shadows === 1 &&
        Math.abs(part.cover - 0.4) < 0.001 &&
        Math.abs(part.strength - 0.9) < 0.001 &&
        part.sun === clear.sun &&
        Math.abs(part.roomShade - 0.55) < 0.001 &&
        Math.abs(part.shadow - 0.61) < 0.001 &&
        part.hemi === 0 &&
        Math.abs(part.disc - 0.52) < 0.001,
      JSON.stringify(part),
    );
    await wx(62);
    check(
      "weather: a change under 5 points is not applied",
      (await sky()).cover === part.cover,
    );
    await wx(100, "cloudy");
    const over = await sky();
    check(
      "weather 100 %: all in shade, rooms x0.25, shadow 0.35",
      over.cover === 0 &&
        Math.abs(over.roomShade - 0.25) < 0.001 &&
        Math.abs(over.shadow - 0.35) < 0.001 &&
        // the tier's PCF spread (QualityTier.sunShadowRadius) x the cloud factor
        over.radius === 4 * over.tierRadius,
      JSON.stringify(over),
    );
    await wx(null, "cloudy");
    check(
      "weather: condition only (cloudy) -> 85 %",
      Math.abs((await sky()).cover - 0.15) < 0.001,
    );
    // rendered pixels under a cloud everywhere vs nowhere: the surroundings darken (3D), the rooms' insides
    // do not (top view: inside the room hulls only floors and furniture show, the facade is out of sight)
    await wx(60);
    const shadePx = () =>
      page.evaluate(`(() => { const v = ${card}._view, r = v.renderer, U = v._cloudU, gl = r.getContext();
    const grab = () => { r.render(v.scene, v.camera); const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, d = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d); return { w, h, d }; };
    const keep = U.fpCloudCover.value;
    U.fpCloudCover.value = 2; const a = grab(); // no cloud anywhere (the rooms keep their average shade)
    U.fpCloudCover.value = -1; const b = grab(); // a cloud everywhere
    U.fpCloudCover.value = keep;
    const hulls = v._roomHull() || [], cw = r.domElement.clientWidth, ch = r.domElement.clientHeight, sx = cw / a.w, sy = ch / a.h;
    // inward distance to a convex ccw hull (y up): min over edges of the distance on the inner side
    const inset = (hh, p) => { let m = Infinity; for (let i = 0; i < hh.length; i++) { const q = hh[i], e = hh[(i + 1) % hh.length], ex = e[0] - q[0], ey = e[1] - q[1], l = Math.hypot(ex, ey) || 1;
      m = Math.min(m, (ex * (p[1] - q[1]) - ey * (p[0] - q[0])) / l); } return m; };
    let inN = 0, inChanged = 0, outN = 0, outChanged = 0;
    for (let y = 0; y < a.h; y += 3) for (let x = 0; x < a.w; x += 3) {
      const i = (y * a.w + x) * 4, diff = (a.d[i] + a.d[i + 1] + a.d[i + 2] - b.d[i] - b.d[i + 1] - b.d[i + 2]) / 3;
      const p = [(x + 0.5) * sx - cw / 2, (y + 0.5) * sy - ch / 2]; // GL rows run bottom-up: y up from the centre
      const depth = Math.max(-Infinity, ...hulls.map((hh) => inset(hh, p)));
      if (depth > 8) { inN++; if (Math.abs(diff) > 3) inChanged++; } else if (depth < -8) { outN++; if (diff > 3) outChanged++; }
    }
    return { rooms: (v._rooms || []).length, inN, inChanged: inN ? +(inChanged / inN).toFixed(3) : 0, outN, outChanged: outN ? +(outChanged / outN).toFixed(3) : 0 }; })()`);
    const shade3d = await shadePx();
    check(
      "cloud shadows (rendered, 3D): the surroundings darken under a cloud",
      shade3d.outN > 100 && shade3d.outChanged > 0.01,
      JSON.stringify(shade3d),
    );
    await page.evaluate(`${card}._setMode('top')`);
    await settle(page, card);
    const shadeTop = await shadePx();
    check(
      "cloud shadows (rendered, top view): the rooms stay as they were",
      shadeTop.rooms > 0 && shadeTop.inN > 100 && shadeTop.inChanged < 0.02,
      JSON.stringify(shadeTop),
    );
    await page.evaluate(`${card}._setMode('3d')`);
    await settle(page, card);
    // sun disc: never over the rooms on screen from 6 sides, and shown at full keep-out opacity where clear of them
    const keep =
      await page.evaluate(`(() => { const v = ${card}._view, d = v._dome, saved = v.getCamera(), out = [];
    for (const az of [0, 60, 120, 180, 240, 300]) {
      const a = az * Math.PI / 180, r = d.radius * 2;
      v.setCamera({ position: [d.centre.x + Math.sin(a) * r, d.centre.y + r * 0.6, d.centre.z - Math.cos(a) * r], target: d.centre.toArray() }, { instant: true });
      v._placeSkyBodies();
      const s = v.skySprites.sun, hull = v._roomHull(), q = s ? v._skyScreen(hull, s.userData.domePos, s.scale.x * 0.35 * d.radius / s.position.distanceTo(v.camera.position) * s.userData.domePos.distanceTo(v.camera.position) / d.radius) : null;
      const q0 = s ? v._skyScreen(hull, s.userData.domePos, 0) : null;
      out.push({ az, shown: !!(s && s.visible && s.material.opacity > 0), over: !!(s && s.visible && s.material.opacity > 0 && q0.dist <= 0), clear: !!(q && q.dist >= q.r), full: !!(s && s.visible && s.userData.clear === 1) });
    }
    v.setCamera(saved, { instant: true }); v._placeSkyBodies(); return out; })()`);
    check(
      "sky keep-out: the sun disc never over the rooms (6 sides)",
      keep.every((x) => !x.over),
      JSON.stringify(keep),
    );
    check(
      "sky keep-out: the sun disc clear of the rooms is shown at full opacity",
      keep.some((x) => x.clear) && keep.every((x) => !x.clear || x.full),
      JSON.stringify(keep),
    );
    await page.evaluate(
      `(() => { const v = ${card}._view; if (v.test) v.test.drift = true; })()`,
    ); // test mode holds the clouds still
    await page.evaluate(`(() => { const r = ${card}._view.renderer, seen = new Set(r.info.programs.map((p) => p.id)), f = r.render.bind(r);
    window.__newPrograms = []; r.render = (sc, cam) => { f(sc, cam); for (const p of r.info.programs) if (!seen.has(p.id)) { seen.add(p.id); window.__newPrograms.push(p.id); } }; })()`);
    // n drift frames (rain / snow / cloud shadows), counted (the frame-rate caps are driftTick's, unit-tested in
    // test/frame-interval.test.js) -> { frames, ok } (timeout: ok false)
    const drift = (n, timeout = 30000) =>
      page.evaluate(`new Promise((done) => { const v = ${card}._view, t0 = performance.now(), k0 = v.stats.cloudFrames;
      const f = () => { const frames = v.stats.cloudFrames - k0;
        if (frames >= ${n} || performance.now() - t0 > ${timeout}) done({ frames, ok: frames >= ${n} });
        else requestAnimationFrame(f); };
      requestAnimationFrame(f); })`);
    await drift(2); // the drift has started (its first frames) before the programs are counted
    await page.evaluate("window.__newPrograms.length = 0");
    const p0 = await sky();
    const dr = await drift(12);
    const p1 = await sky();
    const created = await page.evaluate("window.__newPrograms.length");
    check(
      "cloud shadows drift (12 drift frames): no new shader programs, they moved",
      created === 0 &&
        dr.ok &&
        p1.frames > p0.frames &&
        p0.offset.some((x, i) => Math.abs(x - p1.offset[i]) > 1e-4),
      `created ${created}, ${JSON.stringify(dr)}`,
    );
    await page.screenshot({
      path: path.join(root, "screenshots", "weather-cloudy.png"),
    });
    await page.evaluate(
      `Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })`,
    );
    await idle(page);
    // held: the drift clock reset (weather.frameAt 0) and no drift frame over a 60-frame window
    const held = () => page.evaluate(`${card}._view.weather.frameAt === 0`);
    const h0 = (await sky()).frames;
    await rafs(page, 60);
    check(
      "tab hidden: no drift frames",
      (await sky()).frames === h0 && (await held()),
    );
    await page.evaluate("delete document.visibilityState");
    await page.evaluate(`${card}._view.setOnScreen(false)`);
    await idle(page);
    const o0 = (await sky()).frames;
    await rafs(page, 60);
    check(
      "card off screen: no drift frames",
      (await sky()).frames === o0 && (await held()),
    );
    await page.evaluate(`${card}._view.setOnScreen(true)`);
    await page.evaluate(`${card}._setMode('top')`);
    await settle(page, card);
    const top = await sky();
    check(
      "top view: the cloud shadows stay (they lie on the model)",
      top.shadows === 1 && top.strength > 0,
      JSON.stringify(top),
    );
    await page.screenshot({
      path: path.join(root, "screenshots", "weather-top.png"),
    });
    await page.evaluate(`${card}._setMode('3d')`);
    await settle(page, card);
    await page.evaluate("window.__setDemoSun(-20, 0)");
    await idle(page);
    const night = await sky();
    check(
      "night: the sun is down, the shade stays on the moonlight only (lamps untouched by construction)",
      night.sun === 0 && night.shadows === 1,
      JSON.stringify(night),
    );
    await page.evaluate("window.__setDemoSun(30, 200)");
    // rain / snow: around the house, never over the rooms (no drop over a room footprint, nothing drawn
    // over the rooms on screen), animated by uniforms only at <= 30 frames a second
    const fall = () =>
      page.evaluate(`(() => { const v = ${card}._view, P = v._precip, polys = (v._rooms || []).map((x) => x.room.polygon);
    const inPoly = (pl, x, y) => { let c = false; for (let i = 0, j = pl.length - 1; i < pl.length; j = i++) { const [xi, yi] = pl[i], [xj, yj] = pl[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
    const info = (l) => { if (!l) return null; const a = l.geometry.getAttribute('aDrop'); let inRoom = 0; for (let i = 0; i < a.count; i++) if (polys.some((pl) => inPoly(pl, a.getX(i), -a.getY(i)))) inRoom++;
      return { visible: l.visible, drops: l.userData.count, inRoom }; };
    return { falling: !!v.weather.falling, rain: info(P.rain), snow: info(P.snow), frames: v.stats.cloudFrames, programs: v.renderer.info.programs.length }; })()`);
    await wx(90, "pouring");
    await waitTrue(
      page,
      `!!${card}._view.weather.falling && !!${card}._view._precip.rain && ${card}._view._precip.rain.visible`,
      "the rain",
    );
    const pour = await fall();
    check(
      "pouring: rain falls, no drop over a room",
      pour.falling &&
        pour.rain &&
        pour.rain.visible &&
        pour.rain.drops === 1600 &&
        pour.rain.inRoom === 0 &&
        !(pour.snow && pour.snow.visible),
      JSON.stringify(pour),
    );
    const rainPx =
      await page.evaluate(`(() => { const v = ${card}._view, r = v.renderer, gl = r.getContext(), l = v._precip.rain;
    v._placeSkyBodies();
    const grab = () => { r.render(v.scene, v.camera); const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, d = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d); return { w, h, d }; };
    l.visible = false; const a = grab(); l.visible = true; const b = grab();
    const hulls = v._roomHull() || [], cw = r.domElement.clientWidth, ch = r.domElement.clientHeight, sx = cw / a.w, sy = ch / a.h;
    const inside = (hh, p) => { for (let i = 0; i < hh.length; i++) { const q = hh[i], e = hh[(i + 1) % hh.length]; if ((e[0] - q[0]) * (p[1] - q[1]) - (e[1] - q[1]) * (p[0] - q[0]) < 0) return false; } return true; };
    let inN = 0, inChanged = 0, outN = 0, outChanged = 0;
    for (let y = 0; y < a.h; y += 2) for (let x = 0; x < a.w; x += 2) {
      const i = (y * a.w + x) * 4, diff = Math.abs(a.d[i] - b.d[i]) + Math.abs(a.d[i + 1] - b.d[i + 1]) + Math.abs(a.d[i + 2] - b.d[i + 2]);
      const p = [(x + 0.5) * sx - cw / 2, (y + 0.5) * sy - ch / 2];
      if (hulls.some((hh) => inside(hh, p))) { inN++; if (diff > 6) inChanged++; } else { outN++; if (diff > 6) outChanged++; }
    }
    return { inN, inChanged, outN, outChanged }; })()`);
    // the mask is a 256 px texture: a hull edge may leak a pixel or two, so allow 0.2 % of the room pixels
    check(
      "rain (rendered, 3D): streaks around the house, none over the rooms on screen",
      rainPx.outChanged > 200 &&
        rainPx.inN > 100 &&
        rainPx.inChanged / rainPx.inN < 0.002,
      JSON.stringify(rainPx),
    );
    await page.evaluate(`(() => { const r = ${card}._view.renderer, seen = new Set(r.info.programs.map((p) => p.id)), f = r.render.bind(r);
    window.__newPrograms = []; r.render = (sc, cam) => { f(sc, cam); for (const p of r.info.programs) if (!seen.has(p.id)) { seen.add(p.id); window.__newPrograms.push(p.id); } }; })()`);
    const rdr = await drift(8),
      rnew = await page.evaluate("window.__newPrograms.length");
    // animates: drift frames keep coming (counted, not timed: the software-GL CI runner draws about 5 fps; the
    // frame-rate cap is unit-tested, test/frame-interval.test.js)
    check(
      "rain animates (8 drift frames), no new shader programs",
      rdr.ok && rnew === 0,
      `${JSON.stringify(rdr)}, ${rnew} new programs`,
    );
    await page.screenshot({
      path: path.join(root, "screenshots", "weather-rain.png"),
    });
    await wx(90, "snowy");
    await waitTrue(
      page,
      `!!${card}._view._precip.snow && ${card}._view._precip.snow.visible && !(${card}._view._precip.rain && ${card}._view._precip.rain.visible)`,
      "the snow",
    );
    const snow = await fall();
    check(
      "snowy: snow falls (no rain), no flake over a room",
      snow.falling &&
        snow.snow &&
        snow.snow.visible &&
        snow.snow.inRoom === 0 &&
        !(snow.rain && snow.rain.visible),
      JSON.stringify(snow),
    );
    await page.screenshot({
      path: path.join(root, "screenshots", "weather-snow.png"),
    });
    await wx(0, "sunny");
    await waitTrue(
      page,
      `!${card}._view.weather.falling`,
      "the rain / snow to stop",
    );
    const dry = await fall();
    check(
      "sunny: nothing falls, the frame rate drops back",
      !dry.falling &&
        !(dry.rain && dry.rain.visible) &&
        !(dry.snow && dry.snow.visible),
      JSON.stringify(dry),
    );
    await wx(90, "pouring");
    await page.evaluate(
      `${card}.setConfig({ ...${card}._config, clouds: false })`,
    );
    await idle(page);
    const off = await fall();
    check(
      "clouds: false stops the rain too",
      !off.falling && !(off.rain && off.rain.visible),
      JSON.stringify(off),
    );
    await page.evaluate(
      `${card}.setConfig({ ...${card}._config, clouds: true })`,
    );
    await wx(60);
    await page.evaluate(
      `${card}.setConfig({ ...${card}._config, clouds: false })`,
    );
    await idle(page);
    let c = await sky();
    check(
      "clouds: false turns the shadows off, the light still follows the weather",
      c.shadows === 0 &&
        c.strength === 0 &&
        c.roomShade === 1 &&
        Math.abs(c.sun / clear.sun - 0.55) < 0.001,
      JSON.stringify(c),
    );
    await page.evaluate(
      `${card}.setConfig({ ...${card}._config, clouds: true, sky_bodies: false })`,
    );
    await idle(page);
    check(
      "sky_bodies: false turns the cloud shadows off too",
      (await sky()).shadows === 0,
    );
    await page.evaluate(
      `${card}.setConfig({ ...${card}._config, sky_bodies: true, weather: 'none' })`,
    );
    await idle(page);
    c = await sky();
    check(
      "weather: none -> clear sky",
      c.shadows === 0 && Math.abs(c.sun - clear.sun) < 0.001,
      JSON.stringify(c),
    );
    allErrors.push(...s.errors);
  },
);

// 1u. uplights: the demo's wall uplights aim straight up; a shared (bad) target in their group is ignored
sections.add(
  "uplights",
  {
    group: "look",
    query: { model: "1", view: "3d" },
    viewport: { width: 1400, height: 560 },
  },
  async (s) => {
    const { page } = s;
    await page.waitForFunction(`!!${card}._view.model`, { timeout: 30000 });
    await page.evaluate("window.__setDemoSun(-20, 0)"); // night: lamps on
    await waitTrue(
      page,
      `["wall_uplight_1", "wall_uplight_2"].every((id) => { const s = ${card}._objects._slots.get(id); return !!s && s.light.intensity > 0; })`,
      "the uplights on at night",
      15000,
    );
    await idle(page);
    const aims = () =>
      page.evaluate(`(() => { const c = ${card}, L = c._objects, v = c._view;
    const out = {}; for (const [id, slot] of L._slots) { const l = slot.light; if (!l.isSpotLight) continue;
      const a = L.anchorOf(id); out[id] = { at: l.position.toArray().map((x) => +x.toFixed(3)), d: l.target.position.clone().sub(l.position).toArray().map((x) => +x.toFixed(3)),
        own: a.distanceTo(l.position) < 1e-6, on: l.intensity > 0 }; }
    return { out, warnings: v.modelManifest().warnings, bad: Object.fromEntries(L.badTargets || []) }; })()`);
    let a = await aims();
    const ups = ["wall_uplight_1", "wall_uplight_2"];
    check(
      "demo uplights: spots aimed straight up from their own lamps, no model warning",
      ups.every(
        (id) =>
          a.out[id] &&
          a.out[id].on &&
          a.out[id].own &&
          a.out[id].d[0] === 0 &&
          a.out[id].d[2] === 0 &&
          a.out[id].d[1] > 1.9,
      ) && !a.warnings.some((w) => /spot target/.test(w)),
      JSON.stringify(a),
    );
    const bad = path.join(root, "screenshots", "uplights-bad.glb");
    fs.writeFileSync(
      bad,
      rewriteGlbJson(
        fs.readFileSync(path.join(root, "demo", "house.glb")),
        (json) => {
          for (const n of json.nodes || [])
            if (
              n.extras &&
              n.extras.fp &&
              /^wall_uplight_/.test(n.extras.fp.id)
            )
              n.extras.fp.hints = {
                ...n.extras.fp.hints,
                target: [6.25, 0, 0.5],
              };
          return json;
        },
      ),
    );
    await page.evaluate(
      `${card}.setConfig({ ...${card}._config, model: '/screenshots/uplights-bad.glb' })`,
    );
    await page
      .waitForFunction(
        `(${card}._view.modelManifest()?.warnings || []).some((w) => /spot target/.test(w))`,
        { timeout: 15000 },
      )
      .catch(() => {});
    await idle(page);
    a = await aims();
    check(
      "shared bad target: Model warning names both uplights",
      a.warnings.includes(
        "spot target looks wrong (shared / too far): wall_uplight_1, wall_uplight_2",
      ),
      JSON.stringify(a.warnings),
    );
    check(
      "shared bad target ignored: each spot aims up from its own lamp",
      ups.every(
        (id) =>
          a.out[id] &&
          a.out[id].own &&
          a.out[id].d[0] === 0 &&
          a.out[id].d[2] === 0 &&
          a.out[id].d[1] > 1.9,
      ) &&
        a.out.wall_uplight_1.at[0] !== a.out.wall_uplight_2.at[0] &&
        a.bad.wall_uplight_1 === "shared",
      JSON.stringify(a),
    );
    fs.unlinkSync(bad);
    allErrors.push(...s.errors);
  },
);

// 1a. static meshes merged at load (per owner + material), merge: false keeps every part, node: rules keep theirs
sections.add(
  "merge",
  {
    group: "objects",
    query: { model: "1", view: "3d" },
    viewport: { width: 1400, height: 560 },
  },
  async (s) => {
    const { page } = s;
    await page.waitForFunction(
      `!!${card}._view.model && !!${card}._view.mergeStats`,
      { timeout: 30000 },
    );
    const stats = () =>
      page
        .evaluate(`JSON.stringify(${card}._view.mergeStats)`)
        .then(JSON.parse);
    // shader programs created since the last read: per render, the ids new in renderer.info.programs
    await page.evaluate(`(() => { const r = ${card}._view.renderer, seen = new Set(r.info.programs.map((p) => p.id)), f = r.render.bind(r);
    window.__newPrograms = []; window.__progInfo = new Map();
    r.render = (sc, cam) => { f(sc, cam); for (const p of r.info.programs) if (!seen.has(p.id)) { seen.add(p.id); window.__newPrograms.push(p.id); window.__progInfo.set(p.id, (p.name ? p.name + ':' : '') + String(p.cacheKey).split(',')[0]); } }; })()`);
    // created: new programs; transient: created but already released (compiled for a passing state);
    // otherNew: new programs used by materials outside the model; transientKinds: material type (and name) of each transient
    const programs = () =>
      page.evaluate(`(() => { const v = ${card}._view, r = v.renderer, other = new Set(), live = new Set(r.info.programs.map((p) => p.id));
    v.scene.traverse((o) => { if (!o.material) return; let inModel = false; for (let n = o; n; n = n.parent) if (n === v.modelGroup) inModel = true;
      if (!inModel) for (const m of [].concat(o.material)) { const p = r.properties.get(m).currentProgram; if (p) other.add(p.id); } });
    const created = window.__newPrograms.splice(0);
    return { live: live.size, created: created.length, transient: created.filter((id) => !live.has(id)).length, otherNew: created.filter((id) => other.has(id)).length, transientKinds: created.filter((id) => !live.has(id)).map((id) => window.__progInfo.get(id)) }; })()`);
    // the demo mower driven step by step (its 500 ms timer held): each step moves the marker. A step is done
    // once a frame has drawn it and the card is idle.
    await page.evaluate("window.__demoMowerPaused = true");
    const mowerStep = async () => {
      await page.evaluate(
        `(() => { window.__frames0 = ${card}._view.stats.frames; window.__demoMowerStep(); })()`,
      );
      await waitTrue(
        page,
        `${card}._view.stats.frames > window.__frames0`,
        "a frame after the mower step",
        10000,
      );
      await idle(page);
    };
    for (let i = 0; i < 2; i++) await mowerStep(); // as before: the first moves happen before the count starts
    await programs();
    for (let i = 0; i < 20; i++) await mowerStep();
    const moving = await programs();
    check(
      "mower moving (20 steps): no new shader programs",
      moving.created === 0,
      JSON.stringify(moving),
    );
    const on = await stats();
    check(
      "merge: fewer meshes and draw calls, same triangles",
      on.enabled &&
        on.after.meshes < on.before.meshes &&
        on.after.calls < on.before.calls &&
        on.after.triangles === on.before.triangles &&
        on.merged > 0,
      JSON.stringify(on),
    );
    const placed =
      await page.evaluate(`(() => { const v = ${card}._view, m = v.model.manifest, bad = [], inObj = [];
    v.model.root.traverse((o) => {
      if (!/^fp_merged_/.test(o.name)) return;
      const p = o.parent, ok = p === v.model.root || m.byNode.has(p) || !!(p.userData.fp && p.userData.fp.layer) || !!p.name;
      if (!ok || !o.matrix.equals(new o.matrix.constructor())) bad.push(o.parent.name);
    });
    for (const e of m.objects) e.node.traverse((o) => { if (/^fp_merged_/.test(o.name)) inObj.push(e.id); });
    const owners = []; v.model.root.traverse((o) => { if (/^fp_merged_/.test(o.name)) owners.push(m.ownerOf(o) ? m.ownerOf(o).id : null); });
    return { bad, inObj, owners: owners.length, tagged: owners.filter(Boolean).length }; })()`);
    check(
      "merged meshes sit under their owner at identity, none inside objects, owners resolve",
      placed.bad.length === 0 &&
        placed.inObj.length === 0 &&
        placed.owners > 0 &&
        placed.tagged === placed.owners,
      JSON.stringify(placed),
    );
    check(
      "node index rebuilt over the merged tree",
      await page.evaluate(
        `(() => { const c = ${card}; return !!c._index && c._index.nodes.some((n) => /fp_merged_/.test(n.path)); })()`,
      ),
    );
    // the owner and material of a merged mesh: find one of its source meshes with merge off
    const probe =
      await page.evaluate(`(() => { let o = null; ${card}._view.model.root.traverse((x) => { if (!o && /^fp_merged_/.test(x.name)) o = x; });
    return { owner: o.parent.name, mat: o.material.name }; })()`);
    // settle first (idle first, then rendered-frame streaks until two streaks of 10 frames in a row compile nothing: counted in
    // frames, so a loaded runner only makes it slower, not shorter)
    await idle(page);
    for (let i = 0, quiet = 0; i < 30 && quiet < 2; i++) {
      await renderFrames(page, 10);
      await idle(page);
      quiet = (await programs()).created ? 0 : quiet + 1;
    }
    await page.evaluate(
      `${card}.setConfig({ ...${card}._config, merge: false })`,
    );
    await page.waitForFunction(
      `!!${card}._view.mergeStats && !${card}._view.mergeStats.enabled`,
      { timeout: 10000 },
    );
    await idle(page);
    const reload = await programs();
    check(
      "merge reload: only the model's own shaders compile, once (no look / light-pool round trip)",
      reload.transient === 0 && reload.otherNew === 0,
      JSON.stringify(reload),
    );
    const off = await stats();
    check(
      "merge: false reloads with every mesh and the old draw-call count",
      off.after.meshes === on.before.meshes &&
        off.after.calls === on.before.calls &&
        off.merged === 0,
      JSON.stringify(off),
    );
    const targets =
      await page.evaluate(`(() => { const c = ${card}; const t = [];
    c._view.model.root.traverse((x) => { if (x.isMesh && x.parent && x.parent.name === ${JSON.stringify(probe.owner)} && x.material.name === ${JSON.stringify(probe.mat)} && !x.children.length) t.push(x); });
    return t.map((m) => c._index && c._index.nodes.find((i) => i.node === m)).filter(Boolean).slice(0, 2).map((n) => ({ path: n.path })); })()`);
    const target = targets[0] || null;
    check(
      "found a merge candidate mesh with merge off",
      !!target,
      JSON.stringify(probe),
    );
    if (target) {
      const views = { ground: { rules: [{ hide: "node:" + target.path }] } };
      await page.evaluate(
        `${card}.setConfig({ ...${card}._config, merge: true, views: ${JSON.stringify(views)} })`,
      );
      await page.waitForFunction(
        `!!${card}._view.mergeStats && ${card}._view.mergeStats.enabled`,
        { timeout: 10000 },
      );
      await idle(page);
      await page.evaluate(
        `${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`,
      );
      await idle(page);
      const kept =
        await page.evaluate(`(() => { const c = ${card}; const n = c._index.nodes.find((i) => i.path === ${JSON.stringify(target.path)});
      return n ? { mesh: !!n.node.isMesh, visible: n.node.visible, merged: !!n.node.userData.merged } : null; })()`);
      check(
        "a mesh named by a node: rule is not merged and the rule still hides it",
        !!kept && kept.mesh && !kept.merged && kept.visible === false,
        JSON.stringify(kept),
      );
      const again = await stats();
      check(
        "merging again with the rule: still fewer draw calls than merge off",
        again.after.calls < off.after.calls,
        JSON.stringify(again),
      );
    }
    if (targets[1]) {
      // a layout rule (e.g. an imported layout) for a part that was merged away: the model loads once more around it
      const sel = "node:" + targets[1].path;
      const model0 = await page.evaluate(
        `(window.__m0 = ${card}._view.model, true)`,
      );
      await page.evaluate(
        `(() => { const c = ${card}, l = c._layout; c._layout = ({ ...l, views: { ...(l.views || {}), first: { ...((l.views || {}).first || {}), rules: [{ hide: ${JSON.stringify(sel)} }] } } }); })()`,
      );
      await page
        .waitForFunction(
          `${card}._view.model && ${card}._view.model !== window.__m0 && !!${card}._view.mergeStats`,
          { timeout: 10000 },
        )
        .catch(() => {});
      await idle(page);
      const re =
        await page.evaluate(`(() => { const c = ${card}, ms = c._view.mergeStats; const n = c._index && c._index.nodes.find((i) => i.path === ${JSON.stringify(targets[1].path)});
      return { reloaded: c._view.model !== window.__m0, keep: !!ms && ms.keep.includes(${JSON.stringify(sel)}), mesh: !!n && !!n.node.isMesh && !n.node.userData.merged }; })()`);
      check(
        "a later layout node: rule on a merged part reloads the model once and keeps that part",
        model0 && re.reloaded && re.keep && re.mesh,
        JSON.stringify(re),
      );
      await page.evaluate(
        `(window.__m1 = ${card}._view.model, window.__gen1 = ${card}._loadGen, ${card}._schedule())`,
      );
      // the scheduled update has run (idle: nothing pending) and started no load (a fresh load bumps _loadGen at once)
      await idle(page);
      await renderFrames(page, 3);
      await idle(page);
      check(
        "no second reload",
        await page.evaluate(
          `${card}._view.model === window.__m1 && ${card}._loadGen === window.__gen1`,
        ),
      );
    }
    allErrors.push(...s.errors);
  },
);

// 1b. model objects: tap toggles, hold opens the popup, a drag never toggles (the demo model's hall ceiling lamp)
sections.add(
  "objects-tap",
  {
    group: "objects",
    query: { model: "1", view: "3d" },
    viewport: { width: 1400, height: 560 },
  },
  async (s) => {
    const { page } = s;
    await page.waitForFunction(`!!${card}._view.model && !!${card}._hass`, {
      timeout: 30000,
    });
    await page.evaluate(
      `${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`,
    );
    await settle(page, card);
    const injected = await page.evaluate(
      `(() => { const o = ${card}._objects.objectAt('lamp_hall'); return o ? o.obj.node.name : null; })()`,
    );
    check(
      "the demo model has the hall ceiling lamp object",
      !!injected,
      String(injected),
    );
    await idle(page);
    const at = () =>
      page.evaluate(`(() => { const c = ${card}; const a = c._objects.anchors().find((x) => x.id === 'lamp_hall');
    return a && c._view.projectWorld(a.world); })()`);
    const hall = () =>
      page.evaluate(`${card}._hass.states['light.demo_hall'].state`);
    const calls = () => page.evaluate("(window.__serviceCalls || []).length");
    let p = await at();
    check("lamp anchor projects onto the screen", !!p, JSON.stringify(p));
    const before = await hall();
    await page.mouse.click(p[0] + 12, p[1] + 8); // within 30 px
    await idle(page);
    check(
      "tap near the lamp toggles its light",
      (await hall()) !== before,
      `${before} -> ${await hall()}`,
    );
    check(
      "the bound light has no marker of its own",
      !(await page.evaluate(
        `${card}._markers.some((m) => m.entityId === 'light.demo_hall')`,
      )),
    );
    const n0 = await calls();
    p = await at();
    await page.mouse.move(p[0], p[1]);
    await page.mouse.down();
    await page.mouse.move(p[0] + 40, p[1] + 10, { steps: 5 });
    await page.mouse.up();
    await idle(page);
    check(
      "a drag that starts on the lamp (orbit) never toggles",
      (await calls()) === n0,
    );
    await settle(page, card);
    p = await at();
    await holdAt(page, p);
    // the tile card comes from (the demo's stand-in for) HA's card helpers, a moment after the popup
    await page
      .waitForFunction(
        `!!${card}.shadowRoot.querySelector('.fp-popup .fp-pop-row.ha .fp-demo-tile')`,
        { timeout: 10000 },
      )
      .catch(() => {});
    const pop = () =>
      page.evaluate(`(() => { const el = ${card}.shadowRoot.querySelector('.fp-popup');
    return el && { title: el.querySelector('.fp-pop-title').textContent, rows: [...el.querySelectorAll('.fp-pop-row')].map((r) => r.className.replace('fp-pop-row ', '')),
      features: [...el.querySelectorAll('.fp-demo-tile [data-feature]')].map((f) => f.dataset.feature),
      vis: el.style.visibility, t: el.style.transform }; })()`);
    let pp = await pop();
    check(
      "hold opens the popup (a tile with brightness) without toggling",
      !!pp &&
        pp.title === "Hall ceiling lamp" &&
        pp.rows.join() === "tile ha" &&
        pp.features.join() === "light-brightness" &&
        pp.vis !== "hidden" &&
        (await calls()) === n0,
      JSON.stringify(pp),
    );
    const head =
      await page.evaluate(`(() => { const b = ${card}.shadowRoot.querySelector('.fp-popup .fp-pop-badges');
    return b && { status: (b.querySelector('.fp-status') || {}).dataset?.status || null, logo: !!b.querySelector('.fp-logo') }; })()`);
    check(
      "popup header shows the status dot (no logo by default)",
      !!head &&
        head.status === ((await hall()) === "on" ? "green" : "grey") &&
        !head.logo,
      JSON.stringify(head),
    );
    await page.screenshot({
      path: path.join(root, "screenshots", "object-popup.png"),
    });
    await page.evaluate(
      `(() => { const r = ${card}.shadowRoot.querySelector('.fp-popup [data-feature=light-brightness]'); r.value = '100'; r.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    );
    const last = await page.evaluate(
      "JSON.stringify(window.__serviceCalls[window.__serviceCalls.length - 1])",
    );
    check(
      "the tile's brightness feature sends light.turn_on",
      last ===
        JSON.stringify([
          "light",
          "turn_on",
          { entity_id: "light.demo_hall", brightness_pct: 100 },
        ]),
      last,
    );
    const st1 = await hall();
    await page.evaluate(
      `${card}.shadowRoot.querySelector('.fp-popup .fp-demo-tile .icon').click()`,
    );
    await idle(page);
    pp = await pop();
    check(
      "the tile's icon toggles and the popup stays open",
      (await hall()) !== st1 && !!pp,
      `${st1} -> ${await hall()}`,
    );
    await page.keyboard.press("Escape");
    await idle(page);
    check("Esc closes the popup", !(await pop()));
    // the tap that closes the popup does not also act (tap on the lamp itself)
    p = await at();
    await holdAt(page, p);
    const n2 = await calls();
    await page.mouse.click(p[0], p[1]);
    await idle(page);
    check(
      "a tap that closes the popup does not toggle",
      !(await pop()) && (await calls()) === n2,
    );
    // popup hidden while its anchor is off-screen
    p = await at();
    await holdAt(page, p);
    const cam0 = await page.evaluate(`${card}._view.getCamera()`);
    await page.evaluate(`(() => { const v = ${card}._view; const c = v.getCamera();
    const d = [c.target[0] - c.position[0], c.target[1] - c.position[1], c.target[2] - c.position[2]];
    v.setCamera({ position: c.position, target: [c.position[0] - d[0], c.position[1] - d[1], c.position[2] - d[2]] }, { instant: true }); })()`);
    await idle(page);
    pp = await pop();
    check(
      "popup hidden while its anchor is behind the camera",
      !!pp && pp.vis === "hidden",
      JSON.stringify(pp),
    );
    await page.keyboard.press("Escape");
    await page.evaluate(
      `${card}._view.setCamera(${JSON.stringify(cam0)}, { instant: true })`,
    );
    await idle(page);
    // popup closes on outside tap and on view change
    p = await at();
    await holdAt(page, p);
    await page.mouse.click(30, 520);
    await idle(page);
    check("outside tap closes the popup", !(await pop()));
    p = await at();
    await holdAt(page, p);
    await page.evaluate(
      `${card}.shadowRoot.querySelector('.chip[data-view=exterior]').click()`,
    );
    await idle(page);
    check("view change closes the popup", !(await pop()));
    allErrors.push(...s.errors);
  },
);

// 1b2. HA-style actions from the card YAML: navigate on tap, perform-action on hold, double tap on one
// object never delays single taps on another, missing target -> message, confirmation, popup links, markers
// 1c. light popup: an HA tile with the features of the bound light (smart bulb: brightness, colour temperature; colour via more-info)
sections.add(
  "light-popup",
  {
    group: "objects",
    query: { model: "1", view: "3d" },
    viewport: { width: 1400, height: 560 },
  },
  async (s) => {
    const { page } = s;
    await page.waitForFunction(`!!${card}._view.model && !!${card}._hass`, {
      timeout: 30000,
    });
    await page.evaluate(
      `${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`,
    );
    await settle(page, card);
    await idle(page);
    const sr = `${card}.shadowRoot`;
    const lamp = "light.demo_kitchen";
    // the model lists only the toggle (fp.ui.popup) for this lamp: the light's capabilities still add rows
    await page.evaluate(
      `${card}._objects.objectAt('lamp_kitchen').obj.ui = { popup: ['toggle'] }`,
    );
    const open = async () => {
      await page.evaluate(
        `(() => { const c = ${card}; const a = c._objects.anchors().find((x) => x.id === 'lamp_kitchen'); c._popup.open(c._objects.objectAt('lamp_kitchen').obj, a.world); })()`,
      );
      await idle(page);
    };
    const rows = () =>
      page.evaluate(
        `[...${sr}.querySelectorAll('.fp-popup .fp-pop-row')].map((r) => r.className.replace('fp-pop-row ', ''))`,
      );
    const lastCall = () =>
      page.evaluate(
        "JSON.stringify(window.__serviceCalls[window.__serviceCalls.length - 1])",
      );
    const nCalls = () => page.evaluate("(window.__serviceCalls || []).length");
    const tile = `${sr}.querySelector('.fp-popup fp-demo-tile')`;
    const feats = () =>
      page.evaluate(
        `[...${sr}.querySelectorAll('.fp-popup .fp-demo-tile [data-feature]')].map((f) => f.dataset.feature).join()`,
      );
    const tileReady = () =>
      page.waitForFunction(`!!${tile}`, { timeout: 10000 }).catch(() => {});
    await open();
    await tileReady();
    const r0 = await rows();
    const f0 = await feats();
    check(
      "model list [toggle] + smart bulb: one HA tile with brightness and colour temperature",
      r0.join() === "tile ha" && f0 === "light-brightness,light-color-temp",
      `${r0.join()} / ${f0}`,
    );
    check(
      "the tile card has the card's hass",
      await page.evaluate(`${tile}.hass === ${card}._hass`),
    );
    await page.screenshot({
      path: path.join(root, "screenshots", "light-popup.png"),
    });
    // a pointer down / up on the tile's slider never reaches the stage (OrbitControls, taps)
    const kel = await page.evaluate(
      `(() => { const b = ${sr}.querySelector('.fp-popup [data-feature=light-color-temp]').getBoundingClientRect(); return { x: b.left + b.width * 0.7, y: b.top + b.height / 2 }; })()`,
    );
    await page.evaluate(
      `window.__stagePointer = 0; ${sr}.querySelector('.stage').addEventListener('pointerdown', () => { window.__stagePointer++; })`,
    );
    await page.mouse.move(kel.x, kel.y);
    await page.mouse.down();
    await page.mouse.move(kel.x + 4, kel.y, { steps: 3 });
    await page.mouse.up();
    await idle(page);
    check(
      "a gesture on the tile did not reach the stage; popup still open",
      (await page.evaluate("window.__stagePointer")) === 0 &&
        (await rows()).length === 1,
    );
    // colour temperature: the feature's service call
    await page.evaluate(
      `(() => { const r = ${sr}.querySelector('.fp-popup [data-feature=light-color-temp]'); r.value = '4500'; r.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    );
    check(
      "colour temperature feature: one color_temp_kelvin call",
      (await lastCall()) ===
        JSON.stringify([
          "light",
          "turn_on",
          { entity_id: lamp, color_temp_kelvin: 4500 },
        ]),
      await lastCall(),
    );
    // brightness: the call, then the tile follows the state (hass forwarded on updates)
    await page.evaluate(
      `(() => { const r = ${sr}.querySelector('.fp-popup [data-feature=light-brightness]'); r.value = '30'; r.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    );
    await idle(page);
    check(
      "brightness feature sends brightness_pct; the tile shows the new state",
      (await lastCall()) ===
        JSON.stringify([
          "light",
          "turn_on",
          { entity_id: lamp, brightness_pct: 30 },
        ]) &&
        /30 %/.test(
          await page.evaluate(`${tile}.querySelector('.state').textContent`),
        ),
      await lastCall(),
    );
    // colour and effects: HA's more-info from the tile's name
    const n0 = await nCalls();
    await page.evaluate(`${tile}.querySelector('.name').click()`);
    await idle(page);
    check(
      "the tile's name opens more-info (colour, effects)",
      (await nCalls()) === n0 &&
        (await page.evaluate("document.querySelector('#log').textContent")) ===
          `more-info: ${lamp}`,
      await page.evaluate("document.querySelector('#log').textContent"),
    );
    await page.keyboard.press("Escape");
    await idle(page);
    // layout list [toggle] is respected (layout.objects.<id>.ui.popup)
    const setPopup = (ui) =>
      page.evaluate(
        `(() => { const c = ${card}, l = c._layout, o = { ...(l.objects || {}) }; o.lamp_kitchen = { ...(o.lamp_kitchen || {}), ui: ${JSON.stringify(ui)} }; if (!${JSON.stringify(ui)}) delete o.lamp_kitchen.ui; c._layout = { ...l, objects: o }; })()`,
      );
    await setPopup({ popup: ["toggle"] });
    await idle(page);
    await open();
    await tileReady();
    check(
      "with the layout list only the tile remains, without features",
      (await rows()).join() === "tile ha" && (await feats()) === "",
      `${(await rows()).join()} / ${await feats()}`,
    );
    await page.keyboard.press("Escape");
    await idle(page);
    await setPopup(null);
    await idle(page);
  },
);

sections.add(
  "actions",
  {
    group: "objects",
    query: { model: "1", view: "3d" },
    viewport: { width: 1400, height: 560 },
  },
  async (s) => {
    const { page } = s;
    await page.waitForFunction(`!!${card}._view.model && !!${card}._hass`, {
      timeout: 30000,
    });
    await page.evaluate(
      `${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`,
    );
    await settle(page, card);
    await page.evaluate(`(() => {
    window.__locs = [];
    window.addEventListener('location-changed', () => window.__locs.push(location.pathname + location.search));
  })()`);
    const origin = await page.evaluate("location.pathname + location.search");
    const setActions = async (actions) => {
      await page.evaluate(
        `(() => { const c = ${card}; c.setConfig({ ...c._config, actions: ${JSON.stringify(actions)} }); })()`,
      );
      await page.waitForFunction(
        `!!${card}._view.model && ${card}._objects.parts.size > 0`,
        { timeout: 30000 },
      );
      await settle(page, card);
    };
    const at = (id) =>
      page.evaluate(
        `(() => { const c = ${card}, a = c._objects.anchorOf(${JSON.stringify(id)}); return a && c._view.projectWorld(a); })()`,
      );
    const calls = () => page.evaluate("(window.__serviceCalls || []).length");
    const lastCall = () =>
      page.evaluate(
        "JSON.stringify((window.__serviceCalls || []).slice(-1)[0] || null)",
      );
    const hold = async (p) => {
      await holdAt(page, p);
    };

    await setActions({
      "object:lamp_hall": {
        tap_action: { action: "navigate", navigation_path: "/fp-test/nav" },
        hold_action: {
          action: "perform-action",
          perform_action: "light.turn_on",
          data: { brightness: 42 },
          target: { entity_id: "light.demo_hall" },
        },
      },
    });
    let p = await at("lamp_hall");
    check("actions: the hall lamp projects on screen", !!p, JSON.stringify(p));
    let n0 = await calls();
    await page.mouse.click(p[0], p[1]);
    await idle(page);
    const locs = await page.evaluate("window.__locs.slice()");
    check(
      "actions: tap with navigate pushes the path and fires location-changed",
      locs.at(-1) === "/fp-test/nav" && (await calls()) === n0,
      JSON.stringify(locs),
    );
    await page.evaluate(
      `history.replaceState(null, '', ${JSON.stringify(origin)})`,
    );
    p = await at("lamp_hall");
    await hold(p);
    check(
      "actions: hold with perform-action calls the service with data and target",
      (await lastCall()) ===
        JSON.stringify([
          "light",
          "turn_on",
          { brightness: 42 },
          { entity_id: "light.demo_hall" },
        ]) &&
        !(await page.evaluate(
          `!!${card}.shadowRoot.querySelector('.fp-popup')`,
        )),
      await lastCall(),
    );

    // a malformed perform_action: no call, a visible message; no target is fine (HA allows target-less actions)
    await setActions({
      "object:lamp_hall": {
        hold_action: { action: "perform-action", perform_action: "turn_on" },
      },
    });
    n0 = await calls();
    p = await at("lamp_hall");
    await hold(p);
    // HA toasts (hass-notification) as the demo's stand-in records them; read and cleared
    const toastText = () =>
      page.evaluate(
        "(() => { const n = window.__notifications || []; window.__notifications = []; return n.at(-1) ?? null; })()",
      );
    let toast = await toastText();
    check(
      "actions: a malformed perform_action -> no call, an HA toast",
      (await calls()) === n0 && /domain\.action/.test(toast || ""),
      String(toast),
    );
    await setActions({
      "object:lamp_hall": {
        hold_action: {
          action: "perform-action",
          perform_action: "script.good_night",
        },
      },
    });
    p = await at("lamp_hall");
    await hold(p);
    check(
      "actions: perform-action without a target calls the service",
      (await lastCall()) === JSON.stringify(["script", "good_night", {}]),
      await lastCall(),
    );
    // a rejected service call: a message, no unhandled rejection
    await page.evaluate(`(() => { const c = ${card}; window.__demoMowerPaused = true; window.__realHass = c._hass;
    c._hass = { ...c._hass, callService: () => Promise.reject(new Error('Service not found')) }; })()`);
    p = await at("lamp_hall");
    await hold(p);
    toast = await toastText();
    check(
      "actions: a failing service call shows its error as an HA toast",
      toast === "Service not found",
      String(toast),
    );
    await page.evaluate(
      `(() => { const c = ${card}; window.__demoMowerPaused = false; if (c._hass.callService !== window.__realHass.callService) c._hass = window.__realHass; })()`,
    );

    // double tap on the living lamp; the hall lamp's single taps stay immediate
    await setActions({
      "object:lamp_living": {
        double_tap_action: {
          action: "perform-action",
          perform_action: "light.turn_off",
          target: { entity_id: "light.demo_living" },
        },
      },
    });
    const pl = await at("lamp_living"),
      ph = await at("lamp_hall");
    check("actions: both lamps project on screen", !!pl && !!ph);
    const since = async (k) =>
      page.evaluate(
        `window.__serviceCalls.slice(${k}).map((c, i) => ({ c, t: window.__serviceCallTimes[${k} + i] }))`,
      );
    const hallOf = (x) => x.c[2] && x.c[2].entity_id === "light.demo_hall",
      livingOf = (x) => x.c[2] && x.c[2].entity_id === "light.demo_living";
    // The double-tap window (DOUBLE_TAP_MS, unit-tested on TapSequencer in test/actions.test.js) held open through
    // the card's tap sequencer while two taps must land inside it, so no check races the runner's clock.
    const tapMs = await page.evaluate(`${card}._taps.ms`);
    const holdTaps = (on) =>
      page.evaluate(`${card}._taps.ms = ${on ? 600000 : tapMs}`);
    let k = await calls();
    await holdTaps(true);
    await page.mouse.click(pl[0], pl[1]); // pending: waits for a second tap
    await page.mouse.click(ph[0], ph[1]); // other object: immediate
    const early = await since(k);
    const pendingLiving = await page.evaluate(
      `${card}._taps.pending.has('object:lamp_living')`,
    );
    check(
      "actions: a single tap on another object is not delayed by a pending double tap",
      early.some(hallOf) && !early.some(livingOf) && pendingLiving,
      JSON.stringify({ early: early.map((x) => x.c[2]), pendingLiving }),
    );
    // the held tap dropped, the window back to the card's own: a single tap runs once it is out (waited for)
    await page.evaluate(`${card}._taps.cancel()`);
    await holdTaps(false);
    k = await calls();
    await page.mouse.click(pl[0], pl[1]);
    await waitTrue(
      page,
      `!${card}._taps.pending.size`,
      "the double-tap window",
      10000,
    );
    await idle(page);
    let later = (await since(k)).map((x) => x.c);
    check(
      "actions: the pending single tap runs after the double-tap window (toggle)",
      later.some(
        (c) => c[1] === "toggle" && c[2].entity_id === "light.demo_living",
      ),
      JSON.stringify(later),
    );
    k = await calls();
    await holdTaps(true);
    await page.mouse.click(pl[0], pl[1]);
    await page.mouse.click(pl[0], pl[1]); // the second tap inside the (held) window
    await holdTaps(false);
    await idle(page);
    later = (await since(k)).map((x) => x.c);
    check(
      "actions: a double tap runs the double_tap_action only",
      later.length === 1 &&
        later[0][1] === "turn_off" &&
        later[0][3].entity_id === "light.demo_living",
      JSON.stringify(later),
    );

    // confirmation: handed to HA with the action (HA's dialog; the demo's stand-in asks __demoConfirm)
    await setActions({
      "object:lamp_hall": {
        tap_action: {
          action: "toggle",
          confirmation: { text: "Toggle the hall?" },
        },
      },
    });
    await page.evaluate(`(() => { window.__confirmOk = false; window.__confirmText = null;
    window.__demoConfirm = (t) => { window.__confirmText = t; return window.__confirmOk; }; })()`);
    n0 = await calls();
    p = await at("lamp_hall");
    await page.mouse.click(p[0], p[1]);
    await idle(page);
    const sent = await page.evaluate(
      "JSON.stringify((window.__hassActions || []).at(-1) || null)",
    );
    check(
      "actions: confirmation goes to HA in the hass-action config, cancel calls nothing",
      (await page.evaluate("window.__confirmText")) === "Toggle the hall?" &&
        /"confirmation":\{"text":"Toggle the hall\?"\}/.test(sent) &&
        /"entity":"light\.demo_hall"/.test(sent) &&
        (await calls()) === n0,
      sent,
    );
    await page.evaluate("window.__confirmOk = true");
    await page.mouse.click(p[0], p[1]);
    await idle(page);
    check(
      "actions: a confirmed action runs",
      (await calls()) === n0 + 1,
      await lastCall(),
    );
    await page.evaluate("delete window.__demoConfirm");

    // popup links: history from the YAML popup list
    await setActions({
      "object:lamp_hall": {
        popup: [
          "toggle",
          "history",
          { label: "Lights view", navigate: "/fp-test/lights" },
        ],
      },
    });
    p = await at("lamp_hall");
    await hold(p);
    const links = await page.evaluate(
      `[...${card}.shadowRoot.querySelectorAll('.fp-popup .fp-pop-row.link')].map((r) => r.textContent.trim())`,
    );
    check(
      "actions: popup shows the link rows at the bottom",
      links.join() === "History,Lights view",
      JSON.stringify(links),
    );
    await page.screenshot({
      path: path.join(root, "screenshots", "object-popup-links.png"),
    });
    await page.evaluate(
      `${card}.shadowRoot.querySelector('.fp-popup .fp-pop-link').click()`,
    );
    await idle(page);
    check(
      "actions: the History link navigates to /history?entity_id=…",
      (await page.evaluate("window.__locs.at(-1)")) ===
        "/history?entity_id=light.demo_hall",
      await page.evaluate("window.__locs.at(-1)"),
    );
    await page.evaluate(
      `history.replaceState(null, '', ${JSON.stringify(origin)})`,
    );
    await page.keyboard.press("Escape");

    // markers: YAML keyed by entity id (a marker away from model objects: objects win a tap under the finger)
    const mk =
      await page.evaluate(`(() => { const c = ${card}; const m = c._markers.find((x) => { const r = c._markerRect(x.id); if (!r) return false;
    const px = r.x + r.width / 2, py = r.y + r.height / 2, t = c._markerAt(px, py);
    // reachable under the pointer (markers behind model walls take no taps)
    return t && t.id === x.id && !c._objectHit(px, py, 30); });
    if (!m) return null; const r = c._markerRect(m.id); return { e: m.entityId, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (mk) {
      await setActions({
        [mk.e]: {
          tap_action: {
            action: "navigate",
            navigation_path: "/fp-test/marker",
          },
        },
      });
      const r = await page.evaluate(
        `(() => { const c = ${card}; const m = c._markers.find((x) => x.entityId === ${JSON.stringify(mk.e)}); const b = c._markerRect(m.id); return [b.x + b.width / 2, b.y + b.height / 2]; })()`,
      );
      await page.mouse.click(r[0], r[1]);
      await idle(page);
      check(
        "actions: a marker tap runs its YAML tap_action (navigate)",
        (await page.evaluate("window.__locs.at(-1)")) === "/fp-test/marker",
        `${mk.e}: ${await page.evaluate("window.__locs.at(-1)")}`,
      );
      await page.evaluate(
        `history.replaceState(null, '', ${JSON.stringify(origin)})`,
      );
    } else
      check("actions: a visible marker exists for the marker check", false);
    await setActions(undefined);
    allErrors.push(...s.errors);
  },
);

// 1c. mower object: the model node follows the live position, the mower marker is gone (the demo model's mower)
sections.add(
  "mower-object",
  {
    group: "lamps",
    query: { model: "1", view: "3d" },
    viewport: { width: 1400, height: 560 },
  },
  async (s) => {
    const { page } = s;
    await page.waitForFunction(`!!${card}._view.model && !!${card}._hass`, {
      timeout: 30000,
    });
    await settle(page, card);
    await page
      .waitForFunction(
        `!!${card}._objects.objectAt('mower') && !!${card}._objects.mowerBound() && !!${card}._mowerLive`,
        { timeout: 5000 },
      )
      .catch(() => {});
    check(
      "the demo model's mower object is bound to lawn_mower.demo",
      await page.evaluate(
        `${card}._bindings.get('mower').entity === 'lawn_mower.demo'`,
      ),
    );
    const pos = () =>
      page.evaluate(`(() => { const c = ${card}; const o = c._objects.objectAt('mower');
    const w = o.obj.node.getWorldPosition(new c._view.camera.position.constructor());
    const g = o.part.glow && o.part.glow.material; return { x: w.x, z: w.z, marker: !!c._mowerMarkerId, live: !!c._mowerLive && !!c._mowerLive.x, em: g ? g.emissive.g : -1 }; })()`);
    // the demo mower held and moved by its step hook (not by its 500 ms timer), then until the node has moved
    await page.evaluate("window.__demoMowerPaused = true");
    const a = await pos();
    await page.evaluate("window.__demoMowerStep(); window.__demoMowerStep()");
    await waitTrue(
      page,
      `(() => { const c = ${card}, o = c._objects.objectAt('mower'), w = o.obj.node.getWorldPosition(new c._view.camera.position.constructor());
      return Math.hypot(w.x - ${a.x}, w.z - ${a.z}) > 0.01; })()`,
      "the mower node to move",
      15000,
    );
    const b = await pos();
    check(
      "mower node moves with the live position",
      Math.hypot(a.x - b.x, a.z - b.z) > 0.01,
      JSON.stringify([a, b]),
    );
    check("the mower marker is replaced by the object", !a.marker && !b.marker);
    check("mower glow takes the mowing colour", b.em > 0.1, JSON.stringify(b));
    // warning over the mower: error = red, stuck (mowing, no movement for N min, fake clock) = yellow, docked = none
    await page.evaluate("window.__demoMowerPaused = true");
    const setMs = (state) =>
      page.evaluate(`(() => { const c = ${card}, st = c._hass.states, s = st['lawn_mower.demo'];
    c.hass = { ...c._hass, states: { ...st, 'lawn_mower.demo': { ...s, state: ${JSON.stringify(state)} } } }; })()`);
    const warn = () =>
      page.evaluate(
        `(() => { const w = ${card}._view.warning; return w ? { kind: w.kind, visible: w.sprite.visible } : null; })()`,
      );
    await setMs("error");
    await idle(page);
    const w1 = await warn();
    check(
      "mower error shows the red warning",
      !!w1 && w1.kind === "error" && w1.visible,
      JSON.stringify(w1),
    );
    // an eave over the mower (a copy of the lawn under it, 2.4 m up): mower ground and warning stay on the lawn
    const eave =
      await page.evaluate(`(() => { const c = ${card}, v = c._view, L = c._mowerLive, fl = L.floorId;
    const clear = () => { v._surfMeshes = null; v._ground.clear(); v._mowerGround.clear(); };
    const cx = (Math.floor(L.x / 0.5) + 0.5) * 0.5, cy = (Math.floor(L.y / 0.5) + 0.5) * 0.5;
    const before = v.mowerGround(L.x, L.y, fl);
    const hit = before == null ? null : v.surfaceRays([cx, before + 0.5, -cy], [[0, -1, 0]], 1)[0];
    if (!hit) return { err: 'no lawn under the mower', before };
    const lawn = hit.object, e = lawn.clone();
    lawn.parent.add(e);
    const w = e.getWorldPosition(e.position.clone()); w.y += 2.4;
    e.position.copy(lawn.parent.worldToLocal(w));
    e.updateMatrixWorld(true);
    clear();
    const top = v._groundRay(cx, cy), after = v.mowerGround(L.x, L.y, fl);
    c._updateMowerWarning();
    const warnY = v.warning && v.warning.sprite.position.y;
    e.parent.remove(e); clear(); c._updateMowerWarning();
    return { before, after, top: top && top.y, warnY };
  })()`);
    check(
      "an eave over the mower: the bounded ray keeps the lawn height (roof ignored), the warning stays low",
      !eave.err &&
        eave.top > eave.before + 2 &&
        Math.abs(eave.after - eave.before) < 0.01 &&
        Math.abs(eave.warnY - (eave.before + 0.6)) < 0.01,
      JSON.stringify(eave),
    );
    const f0 = await page.evaluate(`${card}._view.stats.frames`);
    // the pulse renders by itself: two frames come without any input (waited for, not timed)
    check(
      "the warning pulses (frames only while shown)",
      await waitTrue(
        page,
        `${card}._view.stats.frames - ${f0} >= 2`,
        "two pulse frames",
        10000,
      ),
    );
    await setMs("mowing");
    await idle(page);
    check("no warning while mowing normally", (await warn()) === null);
    await page.evaluate(
      `(() => { const real = Date.now; window.__realNow = real; Date.now = () => real() + 6 * 60000; })()`,
    );
    await page.evaluate(`${card}._updateMowerWarning()`);
    const w2 = await warn();
    check(
      "mowing without movement shows the yellow stuck warning",
      !!w2 && w2.kind === "stuck" && w2.visible,
      JSON.stringify(w2),
    );
    await setMs("docked");
    await idle(page);
    check("docked: no warning", (await warn()) === null);
    const f1 = await page.evaluate(`${card}._view.stats.frames`);
    await rafs(page, 80); // a frame-count window (about the 1.3 s it was at 60 Hz)
    check(
      "no frames rendered while idle without a warning (80 animation frames)",
      (await page.evaluate(`${card}._view.stats.frames`)) - f1 <= 1,
    );
    await page.evaluate(
      "Date.now = window.__realNow; window.__demoMowerPaused = false",
    );
    await setMs("mowing");
    // the demo model's climate unit shows its temperature as a label
    await page
      .waitForFunction(
        `${card}._view.sprites.labels('object', true).some((t) => t.includes('21.5'))`,
        { timeout: 10000 },
      )
      .catch(() => {});
    const lbl = await page.evaluate(
      `${card}._view.sprites.labels('object', true).find((t) => t.includes('21.5')) || null`,
    );
    check("climate object shows a temperature label", !!lbl, String(lbl));
    allErrors.push(...s.errors);
  },
);

// 1d. the demo model's objects: automatic binding, glow + pool lights, light / shadow budget, the facade group
// and its controller, dock / charger looks, lights: off, idle updates (no budget or shadow work)
sections.add(
  "demo-objects",
  {
    group: "lamps",
    query: { model: "1", view: "3d" },
    viewport: { width: 1400, height: 560 },
  },
  async (s) => {
    const { page } = s;
    await page.waitForFunction(
      `!!${card}._view.model && !!${card}._hass && ${card}._objects.parts.size > 0`,
      { timeout: 30000 },
    );
    await page.evaluate("window.__demoMowerPaused = true");
    await page.evaluate(
      `${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`,
    );
    await settle(page, card);
    const BOUND = {
      lamp_living: "light.demo_living",
      lamp_hall: "light.demo_hall",
      lamp_kitchen: "light.demo_kitchen",
      kitchen_strip: "light.demo_strip",
      facade_1: "light.demo_facade",
      facade_2: "light.demo_facade",
      facade_3: "light.demo_facade",
      terrace_spot: "light.demo_terrace",
      wall_uplight_1: "light.demo_facade",
      wall_uplight_2: "light.demo_facade",
      climate_living: "climate.demo_living",
      mower: "lawn_mower.demo",
      dock: "lawn_mower.demo",
      ev_charger: "sensor.demo_charger",
    };
    const binds = await page.evaluate(
      `Object.fromEntries([...${card}._bindings].map(([id, b]) => [id, b.entity]))`,
    );
    check(
      "demo objects: all 14 bind automatically from suggest.entity",
      Object.keys(binds).length === 14 &&
        Object.entries(BOUND).every(([id, e]) => binds[id] === e),
      JSON.stringify(binds),
    );
    const markerEnts = await page.evaluate(
      `${card}._markers.map((m) => m.entityId)`,
    );
    const leaked = Object.values(BOUND).filter((e) => markerEnts.includes(e));
    check(
      "demo objects: bound entities have no markers of their own",
      leaked.length === 0,
      leaked.join(),
    );
    check(
      "demo objects: the facade group controller (not bound to an object) keeps its marker",
      markerEnts.includes("switch.demo_facade"),
    );
    const ids = Object.keys(BOUND);
    const look = () =>
      page.evaluate(`(() => { const c = ${card}, l = c._objects, all = [...l.pool.points, ...l.pool.spots];
    const lit = all.filter((x) => x.intensity > 0);
    const near = (id) => { const a = l.anchorOf(id); return a ? lit.filter((x) => x.position.distanceTo(a) < 0.05).map((x) => +x.intensity.toFixed(3)) : null; };
    const glow = (id) => { const o = l.objectAt(id), g = o && o.part.glow; if (!g) return -1; const m = [].concat(g.material)[0]; return +(m.emissiveIntensity * Math.max(m.emissive.r, m.emissive.g, m.emissive.b)).toFixed(3); };
    const ids = ${JSON.stringify(ids)};
    const ts = l.anchorOf('terrace_spot'), spot = l.pool.spots.find((x) => x.intensity > 0 && ts && x.position.distanceTo(ts) < 0.05);
    return { lit: lit.length, shadows: lit.filter((x) => x.castShadow).length, slots: [...l._slots.keys()],
      near: Object.fromEntries(ids.map((id) => [id, near(id)])), glow: Object.fromEntries(ids.map((id) => [id, glow(id)])),
      spotTarget: spot ? spot.target.position.toArray() : null,
      facadeLit: lit.filter((x) => ['facade_1', 'facade_2', 'facade_3'].some((id) => x.position.distanceTo(l.anchorOf(id)) < 0.05)).length }; })()`);
    let L = await look();
    check(
      "lamp on: glow emissive and a pool light with intensity > 0 at the lamp",
      L.glow.lamp_living > 0 &&
        L.near.lamp_living.length === 1 &&
        L.near.lamp_living[0] > 0,
      JSON.stringify({ g: L.glow.lamp_living, n: L.near.lamp_living }),
    );
    check(
      "lamp off: no glow, no pool light",
      L.glow.lamp_hall === 0 && L.near.lamp_hall.length === 0,
      JSON.stringify({ g: L.glow.lamp_hall, n: L.near.lamp_hall }),
    );
    check(
      "at most 12 pool lights lit, at most 4 of them casting shadows",
      L.lit > 0 && L.lit <= 12 && L.shadows <= 4,
      JSON.stringify({ lit: L.lit, shadows: L.shadows }),
    );
    check(
      "facade group on: a pool light at each of the three fixtures (small group lights each lamp), all three glow",
      L.facadeLit === 3 &&
        L.slots.filter((x) => x.startsWith("facade_")).length === 3 &&
        ["facade_1", "facade_2", "facade_3"].every((id) => L.glow[id] > 0),
      JSON.stringify({ f: L.facadeLit, slots: L.slots }),
    );
    const paving = await page.evaluate(
      `(() => { const r = {}; ${card}._view.model.root.traverse((o) => { if (o.isMesh && /^(exterior_floor_5|driveway_floor_1)$/.test(o.name)) { const m = [].concat(o.material)[0]; r[o.name] = { po: !!m.polygonOffset, f: m.polygonOffsetFactor, ro: o.renderOrder, map: !!m.map }; } }); return r; })()`,
    );
    check(
      "coplanar paving: the textured sheet gets polygonOffset -2 and renders later, the plain one is untouched",
      !!paving.exterior_floor_5 &&
        paving.exterior_floor_5.map &&
        paving.exterior_floor_5.po &&
        paving.exterior_floor_5.f === -2 &&
        paving.exterior_floor_5.ro === 1 &&
        !!paving.driveway_floor_1 &&
        !paving.driveway_floor_1.po,
      JSON.stringify(paving),
    );
    check(
      "terrace spot: a lit spot light aimed at its hints.target",
      L.near.terrace_spot.length === 1 &&
        !!L.spotTarget &&
        Math.hypot(
          L.spotTarget[0] - 2.5,
          L.spotTarget[1],
          L.spotTarget[2] - 1.5,
        ) < 0.05,
      JSON.stringify({ n: L.near.terrace_spot, t: L.spotTarget }),
    );
    check(
      "light strip: glows, no real light (no hints.max)",
      L.glow.kitchen_strip > 0 && L.near.kitchen_strip.length === 0,
      JSON.stringify({ g: L.glow.kitchen_strip, n: L.near.kitchen_strip }),
    );
    check(
      "EV charger charging: LED lit, power label",
      L.glow.ev_charger > 0 &&
        (await page.evaluate(
          `${card}._view.sprites.labels('object', true).some((t) => t.includes('7.4 kW'))`,
        )),
      JSON.stringify(L.glow.ev_charger),
    );
    check(
      "dock LED dark while the mower mows",
      L.glow.dock === 0,
      String(L.glow.dock),
    );
    const setState = (e, state, attrs) =>
      page.evaluate(`(() => { const c = ${card}, st = c._hass.states, s = st[${JSON.stringify(e)}];
    c.hass = { ...c._hass, states: { ...st, [${JSON.stringify(e)}]: { ...s, state: ${JSON.stringify(state)}, attributes: { ...s.attributes, ...${JSON.stringify(attrs || {})} } } } }; })()`);
    await setState("lawn_mower.demo", "docked");
    await idle(page);
    check(
      "dock LED lit once the mower is docked",
      (await look()).glow.dock > 0,
    );
    await setState("lawn_mower.demo", "mowing");
    // brightness: the pool light follows (its candela x bri / 255)
    const living0 = (await look()).near.lamp_living,
      bri0 = await page.evaluate(
        `${card}._hass.states['light.demo_living'].attributes.brightness`,
      );
    await page.evaluate(
      `${card}._hass.callService('light', 'turn_on', { entity_id: 'light.demo_living', brightness: 51 })`,
    );
    await idle(page);
    L = await look();
    check(
      "brightness 51 -> the lamp's pool light at 51 / brightness before of its light",
      L.near.lamp_living.length === 1 &&
        living0 &&
        living0.length === 1 &&
        Math.abs(L.near.lamp_living[0] - (living0[0] * 51) / bri0) < 0.01,
      JSON.stringify({ now: L.near.lamp_living, before: living0, bri0 }),
    );
    // a tap on the lamp toggles its entity (the mock records callService)
    const lampAt = (id) =>
      page.evaluate(
        `(() => { const c = ${card}, a = c._objects.anchorOf(${JSON.stringify(id)}); return a && c._view.projectWorld(a); })()`,
      );
    let p = await lampAt("lamp_living");
    const calls0 = await page.evaluate("(window.__serviceCalls || []).length");
    if (p) await page.mouse.click(p[0], p[1]);
    await idle(page);
    const lastCall = await page.evaluate(
      "JSON.stringify((window.__serviceCalls || []).slice(-1)[0] || null)",
    );
    check(
      "a tap on the living lamp calls light.toggle for light.demo_living",
      !!p &&
        (await page.evaluate("(window.__serviceCalls || []).length")) ===
          calls0 + 1 &&
        lastCall ===
          JSON.stringify([
            "light",
            "toggle",
            { entity_id: "light.demo_living" },
          ]),
      lastCall,
    );
    check(
      "toggled off: its glow and pool light are gone",
      await look().then(
        (x) => x.glow.lamp_living === 0 && x.near.lamp_living.length === 0,
      ),
    );
    await page.evaluate(
      `${card}._hass.callService('light', 'toggle', { entity_id: 'light.demo_living' })`,
    );
    await idle(page);
    // group controller off: the fixtures go dark, the popup says why
    await page.evaluate(
      `${card}._hass.callService('switch', 'toggle', { entity_id: 'switch.demo_facade' })`,
    );
    await idle(page);
    L = await look();
    check(
      "group controller off: facade fixtures dark, no pool light (own light still on)",
      ["facade_1", "facade_2", "facade_3"].every((id) => L.glow[id] === 0) &&
        L.facadeLit === 0 &&
        (await page.evaluate(
          `${card}._hass.states['light.demo_facade'].state`,
        )) === "on",
      JSON.stringify(L.glow),
    );
    await page.evaluate(`${card}._runObjectAction('facade_2', 'hold')`);
    await idle(page);
    const popText = await page.evaluate(
      `(${card}.shadowRoot.querySelector('.fp-popup') || {}).textContent || ''`,
    );
    check(
      "popup of a dark facade lamp says the group switch is off",
      popText.includes("Facade switch is off"),
      popText.replace(/\s+/g, " ").slice(0, 160),
    );
    await page.screenshot({
      path: path.join(root, "screenshots", "object-group-popup.png"),
    });
    await page.keyboard.press("Escape");
    await page.evaluate(
      `${card}._hass.callService('switch', 'toggle', { entity_id: 'switch.demo_facade' })`,
    );
    await idle(page);
    check(
      "group controller on again: the facade lights up",
      (await look()).facadeLit === 3,
    );
    // shadow maps per light: a lamp without a shadow slot toggling redraws no map; one with a slot redraws only its own
    const shadowFlags = () =>
      page.evaluate(`(() => { const c = ${card}, l = c._objects, v = c._view;
    return { n: v.stats.shadowLights, auto: [v.sun, ...l.pool.points.slice(0, 4)].map((x) => x.shadow.autoUpdate) }; })()`);
    let sf0 = await shadowFlags();
    check(
      "pool shadow lights and the sun redraw on demand only (shadow.autoUpdate false)",
      sf0.auto.every((x) => x === false),
      JSON.stringify(sf0.auto),
    );
    await page.evaluate(
      `${card}._hass.callService('switch', 'toggle', { entity_id: 'switch.demo_facade' })`,
    );
    await idle(page);
    await page.evaluate(
      `${card}._hass.callService('switch', 'toggle', { entity_id: 'switch.demo_facade' })`,
    );
    await idle(page);
    let sf1 = await shadowFlags();
    check(
      "facade group (no shadow slot) off and on: no shadow map redrawn",
      sf1.n === sf0.n,
      JSON.stringify({ sf0: sf0.n, sf1: sf1.n }),
    );
    await page.evaluate(
      `${card}._hass.callService('light', 'toggle', { entity_id: 'light.demo_hall' })`,
    );
    await idle(page);
    sf1 = await shadowFlags();
    check(
      "hall lamp on: at most its own shadow map (lit ones keep their slots)",
      sf1.n - sf0.n <= 1,
      JSON.stringify({ sf0: sf0.n, sf1: sf1.n }),
    );
    await page.evaluate(
      `${card}._hass.callService('light', 'toggle', { entity_id: 'light.demo_hall' })`,
    );
    await idle(page);
    check("hall lamp off: nothing redrawn", (await shadowFlags()).n === sf1.n);
    // a lamp behind walls / the roof (Exterior view: every level shown) is not toggled by a tap on its
    // screen position (occlusion-aware hit test)
    await page.evaluate(
      `${card}.shadowRoot.querySelector('.chip[data-view=exterior]').click()`,
    );
    await settle(page, card);
    const cam0 = await page.evaluate(`${card}._view.getCamera()`);
    const hiddenAt =
      await page.evaluate(`(() => { const c = ${card}, v = c._view, l = c._objects, a = l.anchorOf('lamp_living'), node = l.objectAt('lamp_living').obj.node;
    for (let k = 0; k < 24; k++) {
      const t = (k / 24) * Math.PI * 2, pos = [a.x + Math.cos(t) * 14, a.y + 4, a.z + Math.sin(t) * 14];
      v.setCamera({ position: pos, target: a.toArray() }, { instant: true });
      v.controls.update();
      v.camera.updateMatrixWorld();
      const p = v.projectWorld(a);
      if (p && v.pointHidden(a, node)) return p;
    }
    return null; })()`);
    await settle(page, card);
    const callsBefore = await page.evaluate(
      "(window.__serviceCalls || []).length",
    );
    if (hiddenAt) await page.mouse.click(hiddenAt[0], hiddenAt[1]);
    await idle(page);
    const tapCalls = await page.evaluate(
      `(window.__serviceCalls || []).slice(${callsBefore})`,
    );
    check(
      "exterior view: a tap on the living lamp hidden by the floor above / roof does not toggle it",
      !!hiddenAt &&
        !tapCalls.some((c) => c[2] && c[2].entity_id === "light.demo_living"),
      JSON.stringify({ hiddenAt, tapCalls }),
    );
    for (const c of tapCalls)
      if (c[1] === "toggle")
        await page.evaluate(
          `${card}._hass.callService(${JSON.stringify(c[0])}, 'toggle', ${JSON.stringify(c[2])})`,
        ); // undo another object's toggle
    await page.keyboard.press("Escape");
    await page.evaluate(
      `${card}._view.setCamera(${JSON.stringify(cam0)}, { instant: true })`,
    );
    await page.evaluate(
      `${card}.shadowRoot.querySelector('.chip[data-view=ground]').click()`,
    );
    await settle(page, card);
    await page.screenshot({
      path: path.join(root, "screenshots", "objects-lit.png"),
    });
    // night: the lamps carry the scene
    await page.evaluate("window.__setDemoSun(-20, 200)");
    await idle(page);
    await page.screenshot({
      path: path.join(root, "screenshots", "objects-night.png"),
    });
    sf0 = await shadowFlags();
    await page.evaluate("window.__setDemoSun(-25, 230)");
    await idle(page);
    sf1 = await shadowFlags();
    check(
      "sun below the horizon moving 30 deg: its shadow map is not redrawn",
      sf1.n === sf0.n,
      JSON.stringify({ sf0: sf0.n, sf1: sf1.n }),
    );
    await page.evaluate("window.__setDemoSun(20, 230)");
    await idle(page);
    check(
      "sunrise: the sun shadow map is redrawn",
      (await shadowFlags()).n > sf1.n,
    );
    await page.evaluate("window.__setDemoSun(-20, 200)");
    await idle(page);
    // lights: off -> emissive only
    await page.evaluate(
      `${card}.setConfig({ ...${card}._config, lights: 'off' })`,
    );
    await page.waitForFunction(
      `!!${card}._view.model && ${card}._objects.parts.size > 0`,
      { timeout: 30000 },
    );
    await idle(page);
    L = await look();
    check(
      "lights: off -> every pool light at intensity 0, lamps still glow",
      L.lit === 0 && L.glow.lamp_living > 0,
      JSON.stringify({ lit: L.lit, g: L.glow.lamp_living }),
    );
    const sceneLights = () =>
      page.evaluate(`(() => { const c = ${card}, pool = new Set([...c._objects.pool.points, ...c._objects.pool.spots]); let n = 0, labels = 0;
    c._view.scene.traverseVisible((o) => { if (pool.has(o)) n++; });
    c._view.objectsGroup.traverseVisible((o) => { if (o.isBillboard) labels++; });
    return { pool: n, labels }; })()`);
    const SL = await sceneLights();
    check(
      "lights: off -> no pool light in the scene (sub-group hidden), object labels still shown",
      SL.pool === 0 && SL.labels > 0,
      JSON.stringify(SL),
    );
    await page.evaluate(
      `${card}.setConfig({ ...${card}._config, lights: 'auto' })`,
    );
    await idle(page);
    const poolSize = await page.evaluate(
      `${card}._objects.pool.points.length + ${card}._objects.pool.spots.length`,
    ); // shadow slots (render recipe, device cap) + 4 points + 4 spots
    check(
      "lights: auto again -> pool lights back",
      (await look()).lit > 0 && (await sceneLights()).pool === poolSize,
      String(poolSize),
    );
    allErrors.push(...s.errors);
  },
);

// 1w. wall washes for every lit lamp, tap hints, marker shapes
// 3b. docked: mower and dock are one object (one tap dot; a tap on the dock opens the mower popup with the dock row);
// mowing: two objects again
sections.add(
  "mower-dock-one",
  {
    group: "lamps",
    query: { model: "1", view: "3d" },
    viewport: { width: 1400, height: 560 },
  },
  async (s) => {
    const { page } = s;
    await page.waitForFunction(
      `!!${card}._view.model && !!${card}._hass && ${card}._objects.parts.size > 0 && ${card}._bindings && ${card}._bindings.has('dock')`,
      { timeout: 30000 },
    );
    await page.evaluate("window.__demoMowerPaused = true");
    await page.evaluate(
      `${card}.shadowRoot.querySelector('.chip[data-view=exterior]').click()`,
    );
    await settle(page, card);
    await page.evaluate(`${card}._layout.tap_hints = 'always'`); // every dot drawn
    const setState = (state, attrs) =>
      page.evaluate(`(() => { const c = ${card}, st = c._hass.states, s = st['lawn_mower.demo'];
    c.hass = { ...c._hass, states: { ...st, 'lawn_mower.demo': { ...s, state: ${JSON.stringify(state)}, attributes: { ...s.attributes, ...${JSON.stringify(attrs || {})} } } } }; })()`);
    const st = () =>
      page.evaluate(`(() => { const c = ${card}, l = c._objects; c._syncHints();
    const at = (id) => { const a = l.anchors().find((x) => x.id === id); return a ? c._view.projectWorld(a.world) : null; };
    const d = at('dock'), m = at('mower');
    return { group: c._dockGroup(), dots: c._hints.items.map((x) => x.id), dockHit: d ? c._objectHit(d[0], d[1], 6) : 'no-dock', mowerHit: m ? c._objectHit(m[0], m[1], 6) : 'no-mower', d, m }; })()`);
    await setState("mowing");
    await idle(page);
    const mow = await st();
    check(
      "mowing: mower and dock are two objects (two dots, own taps)",
      !mow.group &&
        mow.dots.includes("dock") &&
        mow.dots.includes("mower") &&
        mow.dockHit !== "mower",
      JSON.stringify(mow),
    );
    await setState("docked", { battery_level: 87 });
    await idle(page);
    const dk = await st();
    check(
      "docked: one object (the dock has no dot of its own)",
      !!dk.group &&
        dk.group.dock === "dock" &&
        !dk.dots.includes("dock") &&
        dk.dots.includes("mower"),
      JSON.stringify(dk),
    );
    check(
      "docked: a tap on the dock is a tap on the mower",
      dk.dockHit === "mower" && dk.mowerHit === "mower",
      JSON.stringify(dk),
    );
    // a real tap where the dock is: the mower popup with the dock row
    await page.evaluate(`${card}._popup.close()`);
    await page.mouse.click(dk.d[0], dk.d[1]);
    await page
      .waitForFunction(`!!${card}._popup.el`, { timeout: 10000 })
      .catch(() => {});
    const pop = await page.evaluate(
      `(() => { const c = ${card}, el = c._popup.el; return el ? { id: c._popup._id, rows: [...el.querySelectorAll('.fp-pop-row')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()) } : null; })()`,
    );
    check(
      'docked: tapping the dock opens the mower popup with "Dock Docked · 87 %"',
      !!pop &&
        pop.id === "mower" &&
        pop.rows.some((t) => /^Dock\s*Docked · 87 %$/.test(t)),
      JSON.stringify(pop),
    );
    await page.evaluate(`${card}._popup.close()`);
    await setState("mowing");
    await idle(page);
    const back = await st();
    check(
      "mowing again: two objects",
      !back.group && back.dots.includes("dock"),
      JSON.stringify(back),
    );
  },
);

sections.add(
  "washes",
  {
    group: "lamps",
    query: { model: "1", view: "3d" },
    viewport: { width: 1400, height: 560 },
  },
  async (s) => {
    const { page } = s;
    await page.waitForFunction(
      `!!${card}._view.model && ${card}._objects.parts.size > 0`,
      { timeout: 20000 },
    );
    await page.evaluate("window.__setDemoSun(-25, 0)"); // night
    await idle(page);
    const W = () =>
      page.evaluate(`(() => { const c = ${card}, l = c._objects; return { shown: [...l.washes.meshes].filter((m) => m.visible).length,
    walls: [...l.parts].filter(([, p]) => p.wash && p.wash.placements.some((pl, i) => pl.surface === 'wall' && p.wash.meshes[i].visible)).map(([id]) => id),
    quads: Object.fromEntries([...l.parts].filter(([, p]) => p.wash).map(([id, p]) => [id, p.wash.meshes.filter((m) => m.visible).length])),
    made: l.washes.stats.created, programs: c._view.renderer.info.programs.length, real: [...l._slots.keys()] }; })()`);
    const lamps = [
      "facade_1",
      "facade_2",
      "facade_3",
      "wall_uplight_1",
      "wall_uplight_2",
    ];
    let w = await W();
    check(
      "washes: the lit facade lamps and uplights have real lights and draw no wash",
      lamps.every((id) => w.real.includes(id)) &&
        Object.entries(w.quads).every(
          ([id, n]) => n === 0 || !w.real.includes(id),
        ) &&
        lamps.every((id) => !w.quads[id]),
      JSON.stringify(w),
    );
    // the point light keeps 0.15 m off the wall it faces (no hot spot on the wall / door behind it): checked
    // while the facade lamps (the lamps next to a wall) still have their real lights
    const gap =
      await page.evaluate(`(() => { const l = ${card}._objects; let worst = Infinity; for (const [id, s] of l._slots) {
    const p = l.parts.get(id), h = p.wallHit && p.wallHit.hit; if (!h || s.light.isSpotLight) continue;
    const d = (s.light.position.x - h.point[0]) * h.normal[0] + (s.light.position.y - h.point[1]) * h.normal[1] + (s.light.position.z - h.point[2]) * h.normal[2];
    worst = Math.min(worst, d); } return worst; })()`);
    check(
      "real point lights stay >= 0.15 m off their wall",
      gap !== Infinity && gap >= 0.149,
      String(gap),
    );
    // without their real lights the same lamps wash the south wall instead
    await page.evaluate(noRealLight(lamps));
    await idle(page);
    w = await W();
    check(
      "washes: lit facade lamps and uplights without a real light wash the south wall",
      ["facade_1", "facade_3", "wall_uplight_1", "wall_uplight_2"].every((id) =>
        w.walls.includes(id),
      ),
      JSON.stringify(w),
    );
    const progs = w.programs,
      made = w.made;
    for (let i = 0; i < 4; i++) {
      await page.evaluate(
        `${card}._hass.callService('switch', 'toggle', { entity_id: 'switch.demo_facade' })`,
      );
      await page.evaluate(
        `${card}._hass.callService('light', 'toggle', { entity_id: 'light.demo_terrace' })`,
      );
      await idle(page);
    }
    w = await W();
    check(
      "washes: toggling lamps compiles no shader and makes no new wash",
      w.programs === progs && w.made === made,
      JSON.stringify({ progs, made, w }),
    );
    await page.evaluate(
      `${card}._hass.callService('switch', 'turn_off', { entity_id: 'switch.demo_facade' })`,
    );
    await idle(page);
    w = await W();
    check(
      "washes: controller off hides the facade washes",
      !w.walls.some((id) => id.startsWith("facade_")),
      JSON.stringify(w.walls),
    );
    // Light on wall: tag facade = both -> two quads (down + up) per lit facade lamp, no new shader program
    await page.evaluate(
      `${card}._hass.callService('switch', 'turn_on', { entity_id: 'switch.demo_facade' })`,
    );
    await page.evaluate(
      `${card}._layout = ({ ...${card}._layout, tags: { ...${card}._layout.tags, facade: { ...(${card}._layout.tags || {}).facade, wash: 'both' } } })`,
    );
    await idle(page);
    w = await W();
    // facade_2 has no wall within reach and nothing under it (no wash at all, as before)
    check(
      "Light on wall: tag facade = both -> 2 wash quads per lit facade lamp",
      ["facade_1", "facade_3"].every((id) => w.quads[id] === 2),
      JSON.stringify(w.quads),
    );
    const progsBoth = w.programs;
    for (let i = 0; i < 4; i++) {
      await page.evaluate(
        `${card}._hass.callService('switch', 'toggle', { entity_id: 'switch.demo_facade' })`,
      );
      await idle(page);
    }
    w = await W();
    check(
      "Light on wall: both keeps the shader programs constant (toggling too)",
      w.programs === progs && w.programs === progsBoth,
      JSON.stringify({ progs, progsBoth, now: w.programs }),
    );
    // the object's own setting wins over its tag
    await page.evaluate(
      `${card}._layout = ({ ...${card}._layout, objects: { ...${card}._layout.objects, facade_2: { ...((${card}._layout.objects || {}).facade_2 || {}), wash: 'none' } } })`,
    );
    await idle(page);
    w = await W();
    check(
      "Light on wall: object none beats tag both",
      w.quads.facade_2 === 0 && w.quads.facade_1 === 2,
      JSON.stringify(w.quads),
    );
    await page.evaluate(
      `${card}._layout = ({ ...${card}._layout, objects: { ...${card}._layout.objects, facade_2: (({ wash, ...r }) => r)((${card}._layout.objects || {}).facade_2 || {}) } })`,
    );
    await idle(page);
    await page.screenshot({
      path: path.join(root, "screenshots", "washes-both-night.png"),
    });
    // glare: a large glow mesh (the 3 m kitchen strip) glows less per level than a small bulb
    await page.evaluate(
      `${card}._hass.callService('light', 'turn_on', { entity_id: 'light.demo_strip', brightness: 255 })`,
    );
    await page.evaluate(
      `${card}._hass.callService('light', 'turn_on', { entity_id: 'light.demo_living', brightness: 255 })`,
    );
    await idle(page);
    const glare =
      await page.evaluate(`(() => { const l = ${card}._objects, k = (id) => { const p = l.parts.get(id), m = p.part.glow.material;
    return (Array.isArray(m) ? m[0] : m).emissiveIntensity / (3 * p.result.level); }; return { strip: k('kitchen_strip'), bulb: k('lamp_living') }; })()`);
    check(
      "glare: the large strip glow gets a lower emissive intensity than the small bulb",
      glare.bulb === 1 && glare.strip < 0.5,
      JSON.stringify(glare),
    );
    await page.evaluate(
      `${card}._hass.callService('switch', 'turn_off', { entity_id: 'switch.demo_facade' })`,
    ); // as the tap hint checks expect
    await idle(page);
    // tap hints: always -> dots; facade hollow while its controller is off; a tap says why
    await page.evaluate(
      `${card}._layout = ({ ...${card}._layout, tap_hints: 'always' })`,
    );
    await idle(page);
    const H = () =>
      page.evaluate(`(() => { const h = ${card}._hints; return { vis: h.group.visible, items: h.items.map((i) => i.id + ':' + (i.ok ? 1 : 0)),
    filled: h.layers.filled.geometry.drawRange.count, hollow: h.layers.hollow.geometry.drawRange.count, programs: ${card}._view.renderer.info.programs.length }; })()`);
    let h = await H();
    check(
      "tap hints: a dot per tappable object, facade hollow (controller off)",
      h.vis &&
        h.items.includes("facade_1:0") &&
        h.items.includes("lamp_living:1") &&
        h.hollow >= 3 &&
        h.filled > 0,
      JSON.stringify(h),
    );
    await page.evaluate(`${card}._runObjectAction('facade_1', 'tap')`);
    await idle(page);
    const toast = await page.evaluate(
      "(window.__notifications || []).at(-1) || ''",
    );
    check(
      'tap hints: tapping an unreachable lamp says "Turn on first: …" and toggles nothing',
      toast.startsWith("Turn on first") &&
        (await page.evaluate(
          `${card}._hass.states['light.demo_facade'].state`,
        )) === "on",
      toast,
    );
    await page.evaluate(
      `${card}._hass.callService('switch', 'turn_on', { entity_id: 'switch.demo_facade' })`,
    );
    await idle(page);
    h = await H();
    check(
      "tap hints: controller on -> facade dots filled",
      h.items.includes("facade_1:1"),
      JSON.stringify(h.items),
    );
    await page.evaluate(
      `${card}._layout = ({ ...${card}._layout, tap_hints: 'off' })`,
    );
    await idle(page);
    check("tap hints: off hides them", !(await H()).vis);
    // marker shapes
    const shapes =
      await page.evaluate(`(() => { const out = {}; for (const f of ${card}._faces.values()) {
    const k = 'kind-' + f.kind; out[k] = (out[k] || 0) + 1; } return out; })()`);
    check(
      "markers: shapes by role (control circles, value squares, binary, info)",
      shapes["kind-control"] > 0 &&
        shapes["kind-value"] > 0 &&
        shapes["kind-binary"] > 0,
      JSON.stringify(shapes),
    );
    // keep_objects: the terrace zone hidden with "Hide surfaces, keep devices" keeps facade_1 (nested in it) lit and tappable
    const vid = await page.evaluate(`${card}.currentView().id`);
    await page.evaluate(
      `${card}.saveViewPatch(${JSON.stringify(vid)}, { rules: [...(${card}._layout.views?.[${JSON.stringify(vid)}]?.rules || []), { hide: 'zone:terrace', keep_objects: true }] })`,
    );
    await idle(page);
    const keep =
      await page.evaluate(`(() => { const c = ${card}, idx = c._index, l = c._objects;
    const z = idx.nodes.findIndex((n) => n.tag && n.tag.kind === 'zone' && n.tag.id === 'terrace');
    const lampNode = l.objectAt('facade_1').obj.node;
    let inZone = false; for (let o = lampNode; o; o = o.parent) if (o === idx.nodes[z].node) inZone = true;
    const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
    const surfaces = []; idx.nodes[z].node.traverse((o) => { if (o.isMesh) { let obj = false; for (let p = o; p && p !== idx.nodes[z].node; p = p.parent) if (p.userData && p.userData.fp && p.userData.fp.kind === 'object') obj = true; if (!obj) surfaces.push(shown(o) && o.layers.mask !== 0); } });
    return { inZone, lampShown: shown(lampNode), lit: !!l.objectAt('facade_1').result.lit, surfaces, wash: l.parts.get('facade_1').wash.meshes.some((m) => m.visible) }; })()`);
    check(
      "keep_objects: hidden terrace zone keeps its nested facade lamp shown and lit, its surfaces hidden",
      keep.inZone &&
        keep.lampShown &&
        keep.lit &&
        keep.wash &&
        keep.surfaces.length > 0 &&
        keep.surfaces.every((x) => !x),
      JSON.stringify(keep),
    );
    const fa = await page.evaluate(
      `(() => { const c = ${card}; const a = c._objects.anchors().find((x) => x.id === 'facade_1'); return a && c._view.projectWorld(a.world); })()`,
    );
    const facadeBefore = await page.evaluate(
      `${card}._hass.states['light.demo_facade'].state`,
    );
    if (fa) await page.mouse.click(fa[0], fa[1]);
    if (fa)
      await waitTrue(
        page,
        `${card}._hass.states["light.demo_facade"].state !== ${JSON.stringify(facadeBefore)}`,
        "the facade lamp toggled",
        5000,
      ); // the tap waits out the 250 ms double-tap window, then toggles
    const facadeAfter = await page.evaluate(
      `${card}._hass.states['light.demo_facade'].state`,
    );
    check(
      "keep_objects: the kept facade lamp is tappable (tap toggles it)",
      !!fa && facadeAfter !== facadeBefore,
      `${JSON.stringify(fa)} ${facadeBefore} -> ${facadeAfter}`,
    );
    await page.evaluate(
      `${card}._hass.callService('light', 'turn_on', { entity_id: 'light.demo_facade' })`,
    );
    await page.screenshot({
      path: path.join(root, "screenshots", "keep-objects-night.png"),
    });
    allErrors.push(...s.errors);
  },
);

// 1q. the default render quality is 'auto', at 'high' in test mode (no quality in the card YAML); in both tiers a lamp with a real light
// draws no floor pool decal (the real light lights the floor under it; the pool on top blew it out)
sections.add(
  "quality-default",
  {
    group: "lamps",
    query: { model: "1", view: "3d", quality: undefined },
    viewport: { width: 1400, height: 560 },
  },
  async (s) => {
    const { page } = s;
    await page.waitForFunction(
      `!!${card}._view.model && ${card}._objects.parts.size > 0`,
      { timeout: 30000 },
    );
    await page.evaluate("window.__setDemoSun(-25, 0)"); // night
    await idle(page);
    await idle(page);
    const look = () =>
      page.evaluate(`(() => { const c = ${card}, v = c._view, l = c._objects;
    const kitchen = l._slots.get('lamp_kitchen');
    const pools = [...l.parts].filter(([, p]) => p.wash).flatMap(([id, p]) => p.wash.placements.map((pl, i) => ({ id, variant: pl.variant, real: l._slots.has(id), shown: p.wash.meshes[i].visible })));
    return { option: v.look.renderOpt.quality, quality: v.look.quality(), tm: v.renderer.toneMapping, env: !!(v.look._env && v.look._env.enabled !== false),
      kitchen: kitchen ? +kitchen.light.intensity.toFixed(2) : null, hemi: +v.hemi.intensity.toFixed(3),
      real: [...l._slots.keys()], realWashes: pools.filter((x) => x.real && x.shown).map((x) => x.id + ':' + x.variant), walls: pools.filter((x) => x.variant !== 'pool' && x.shown).length }; })()`);
    let hi = await look();
    check(
      "default quality is auto at high: AgX, physical lamps (800 lm kitchen lamp = 15.92), no hemisphere light",
      hi.option === "auto" &&
        hi.quality === "high" &&
        hi.tm === 6 &&
        hi.kitchen === 15.92 &&
        hi.hemi === 0,
      JSON.stringify(hi),
    );
    check(
      "high: lamps with a real light draw no wash (no floor pool, no wall wash)",
      hi.real.length > 0 && hi.realWashes.length === 0,
      JSON.stringify(hi),
    );
    // lamps left without a real light keep their washes (see noRealLight)
    await page.evaluate(noRealLight(["facade_1", "facade_3"]));
    await idle(page);
    hi = await look();
    check(
      "high: lit lamps without a real light wash their wall",
      hi.realWashes.length === 0 && hi.walls > 0,
      JSON.stringify(hi),
    );
    await page.evaluate(
      `${card}._view.setRenderOption({ quality: 'standard' })`,
    );
    await renderFrames(page, 2);
    await idle(page);
    const std = await look();
    check(
      "quality standard: the same light as high (AgX, physical lamps, sky environment, no hemisphere light), no wash from a lamp with a real light, washes from lamps without",
      std.quality === "standard" &&
        std.tm === 6 &&
        std.env &&
        std.kitchen === 15.92 &&
        std.hemi === 0 &&
        std.realWashes.length === 0 &&
        std.walls > 0,
      JSON.stringify(std),
    );
    allErrors.push(...s.errors);
  },
);

// 2. missing model
sections.add(
  "missing-model",
  { group: "load", query: { model: "/demo/missing.glb" } },
  async (s) => {
    await s.page.waitForFunction(
      `!${card}.shadowRoot.querySelector('.notice').hidden`,
      { timeout: 10000 },
    );
    const text = await s.page.evaluate(
      `${card}.shadowRoot.querySelector('.notice').textContent`,
    );
    check("missing model shows a notice", text.includes("missing.glb"), text);
    check(
      "card still renders markers",
      (await s.page.evaluate(`${card}._view.markerObjects.size`)) > 0,
    );
    allErrors.push(
      ...s.errors.filter(
        (e) => !e.includes("missing.glb") && !e.includes("404"),
      ),
    );
  },
);

// 2h. devices on model surfaces: auto-placed wall sensor on the wall, ceiling light under the ceiling, pins untouched
sections.add(
  "surfaces",
  {
    group: "mower",
    query: { model: "1", view: "3d", height: "560px" },
    viewport: { width: 1500, height: 680 },
  },
  async (s) => {
    const { page } = s;
    await page.waitForFunction(`!!${card}._view.model`, { timeout: 30000 });
    await page
      .waitForFunction(
        `(() => { const c = ${card}; return !!c._surf && !c._surfJob && c._positions.get('device:living_climate').base; })()`,
        { timeout: 5000 },
      )
      .catch(() => {});
    // the wall sensor: moved off its computed point, 5 cm (< 0.1 m) off a wall, its 3D marker there too
    const wallInfo =
      await page.evaluate(`(() => { const c = ${card}, v = c._view, p = c._positions.get('device:living_climate');
    const e = v.floorElevation(p.floorId), w = [p.x, e + p.z, -p.y];
    const dirs = []; for (let i = 0; i < 8; i++) dirs.push([Math.cos(i * Math.PI / 4), 0, Math.sin(i * Math.PI / 4)]);
    const hits = v.surfaceRays(w, dirs, 2.5).filter((h) => Math.abs(h.normal[1]) < 0.3);
    const o = v.markerObjects.get('device:living_climate');
    return { p, d: Math.min(...hits.map((h) => h.distance)), obj: o && o.obj.position.toArray(), w }; })()`);
    check(
      "surface: auto-placed wall sensor sits within 0.1 m of the model wall (moved from its computed point)",
      !!wallInfo.p.base &&
        wallInfo.d <= 0.1 &&
        Math.hypot(
          wallInfo.p.x - wallInfo.p.base.x,
          wallInfo.p.y - wallInfo.p.base.y,
        ) > 0.01 &&
        wallInfo.obj &&
        wallInfo.obj.every((v, i) => Math.abs(v - wallInfo.w[i]) < 1e-6),
      JSON.stringify(wallInfo),
    );
    const ceil = await page.evaluate(
      `(() => { const p = ${card}._positions.get('device:living_ceiling'); return { p, ok: !!p.base && p.z < p.base.z + 0.001 }; })()`,
    );
    check(
      "surface: ceiling light 5 cm below the model ceiling",
      ceil.ok,
      JSON.stringify(ceil.p),
    );
    const lamp = await page
      .evaluate(`JSON.stringify(${card}._positions.get('device:floor_lamp'))`)
      .then(JSON.parse);
    check(
      "surface: a pinned marker is never auto moved",
      lamp.auto === false &&
        !lamp.base &&
        lamp.x === 0.6 &&
        lamp.y === 4.3 &&
        lamp.z === 1.5,
      JSON.stringify(lamp),
    );
    // no work on a plain state update: cache hit, same positions
    const again =
      await page.evaluate(`(() => { const c = ${card}, before = c._positions.get('device:living_climate'), n = c._surf.map.size;
    c._buildMarkers(); const after = c._positions.get('device:living_climate');
    return { same: before.x === after.x && before.y === after.y && before.z === after.z, n, n2: c._surf.map.size, job: !!c._surfJob }; })()`);
    check(
      "surface: a marker rebuild reuses the cached spots (no new rays, no job)",
      again.same && again.n === again.n2 && !again.job,
      JSON.stringify(again),
    );

    allErrors.push(...s.errors);
  },
);

// 2i. mower on the lawn: marker and model at the model's ground (any HA floor elevation), shown with the outdoors
sections.add(
  "mower-lawn",
  {
    group: "mower",
    query: { model: "1", view: "3d" },
    viewport: { width: 1400, height: 700 },
  },
  async (s) => {
    const { page } = s;
    // wait for a state; a timeout is reported (and fails the check that asserts it)
    const until = (expr, label, timeout = 8000) =>
      page.waitForFunction(expr, { timeout }).then(
        () => true,
        () => {
          console.log(`     (timed out waiting for ${label})`);
          return false;
        },
      );
    const ev = (expr) => page.evaluate(expr);
    await until(
      `!!${card}._view.model && !!${card}._objects.model`,
      "the model",
      15000,
    );
    // the user's case: the garden's HA floor at 7 m
    await ev(`(() => { const c = ${card}, l = c._layout; c._layout = ({ ...l, floors: [...(l.floors || []), { id: 'garden_f', name: 'Garden', elevation: 7, height: 2.7 }],
    mower: { ...l.mower, floor_id: 'garden_f' } }); })()`);
    check(
      "mower floor at 7 m",
      await until(`${card}._mowerFloor() === 'garden_f'`, "the 7 m floor"),
    );
    // the demo model's mower object stands on the lawn
    const mowerY = `(() => { const o = ${card}._objects.objectAt('mower'); return o && o.obj.node ? o.obj.node.getWorldPosition(o.obj.node.position.clone()).y : null; })()`;
    check(
      "mower model on the lawn with the floor at 7 m",
      await until(
        `(() => { const y = ${mowerY}; return y !== null && y < 1; })()`,
        "the mower model on the lawn",
      ),
      String(await ev(mowerY)),
    );
    // without the model's mower object: the live marker, on the lawn too
    await ev(
      `(() => { const c = ${card}; c._layout = ({ ...c._layout, objects: { ...(c._layout.objects || {}), mower: { hidden: true } } }); })()`,
    );
    const markerY = `(() => { const c = ${card}, o = c._mowerMarkerId && c._view.markerObjects.get(c._mowerMarkerId); return o ? o.obj.position.y : null; })()`;
    check(
      "mower marker on the lawn with the floor at 7 m",
      await until(
        `(() => { const y = ${markerY}; return y !== null && y < 1.5; })()`,
        "the mower marker",
      ),
      String(await ev(markerY)),
    );
    const markerShown = `(() => { const c = ${card}; const o = c._view.cssObjects.find((x) => x.kind === 'marker' && x.id === c._mowerMarkerId); return !!o && o.obj.visible; })()`;
    check("mower marker shown with the exterior", await ev(markerShown));
    // a view without the exterior hides the marker
    await ev(
      `(() => { const c = ${card}, l = c._layout; c._layout = ({ ...l, views: { ...(l.views || {}), indoor: { added: true, label: 'Indoor', rules: [{ hide: 'all' }, { show: 'level:level0' }] } } }); })()`,
    );
    await until(
      `!!${card}._views && ${card}._views.some((v) => v.id === 'indoor')`,
      "the indoor view",
    );
    await ev(`${card}._setView('indoor', { instant: true })`);
    check(
      "indoor view hides the mower marker",
      await until(`!${markerShown}`, "the indoor view to hide the mower"),
    );
    await ev(`${card}._setView('ground', { instant: true })`);
    check(
      "ground view shows it again",
      await until(markerShown, "the marker in the ground view"),
    );
    allErrors.push(...s.errors);
  },
);

// 2j. the mower's device (lawn_mower.robo bound to the model's mower object, the position from the demo's gps
// tracker): mowed share from the progress sensor, device rows in the popup, offline / rain chips, error code
sections.add(
  "mower-device",
  {
    group: "mower",
    query: { model: "1", view: "3d" },
    viewport: { width: 1400, height: 700 },
  },
  async (s) => {
    const { page } = s;
    const ev = (expr) => page.evaluate(expr);
    const until = (expr, label, timeout = 10000) =>
      page.waitForFunction(expr, { timeout }).then(
        () => true,
        () => {
          console.log(`     (timed out waiting for ${label})`);
          return false;
        },
      );
    await until(`!!${card}._view.model`, "the model", 20000);
    await ev("window.__demoMowerPaused = true");
    await ev(`(() => { const c = ${card}, l = c._layout; const { error_entity, stuck_minutes, ...m } = l.mower;
    c._layout = ({ ...l, objects: { ...(l.objects || {}), mower: { entity: 'lawn_mower.robo' } }, mower: m }); })()`);
    await until(
      `${card}._mowerStateEntity() === 'lawn_mower.robo' && !!${card}._mowerLive && ${card}._mowerLive.x !== undefined`,
      "the bound mower with a position",
    );
    check(
      "mowed share from the progress sensor",
      /^39 %$/.test((await ev(`${card}.mapInfo()`)).mowed),
    );
    // popup rows of the device (the model's mower object)
    const rows =
      await ev(`(() => { const c = ${card}, o = c._objects.objectAt('mower'); if (!o) return null; c._popup.open(o.obj, null);
    const t = [...c.shadowRoot.querySelectorAll('.fp-popup .fp-pop-row')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()); c._popup.close(); return t; })()`);
    const has = (re) => !!rows && rows.some((t) => re.test(t));
    check(
      "mower popup: device rows",
      has(/^Mower status\s*Working/) &&
        has(/^Battery\s*82 %/) &&
        has(/^Rain\s*Dry/) &&
        has(/^Wifi\s*-61 dBm/) &&
        has(/^Zone A area\s*210 m²/) &&
        has(/^Time left\s*≈ 61 min/) &&
        has(/^Error code\s*0 \(OK\)/),
      JSON.stringify(rows),
    );
    // offline: chip, no warning, stuck paused; rain: rainy chip
    await ev(`window.__setDemoStates({ 'binary_sensor.robo_online': 'off' })`);
    check(
      "offline chip next to the mower",
      await until(
        `(() => { const ch = ${card}._view.mower.mowerChip; return !!ch && ch.kind === 'offline' && ch.text.includes('offline') && ch.obj.visible; })()`,
        "the offline chip",
      ),
    );
    const off = await ev(
      `(() => { const c = ${card}, o = c._objects.objectAt('mower'); c._popup.open(o.obj, null); const t = c.shadowRoot.querySelector('.fp-popup').textContent; c._popup.close(); return t; })()`,
    );
    check(
      "popup: offline since",
      /Offline\s*since \d+ min/.test(off),
      off.slice(0, 200),
    );
    check(
      "offline: the mower model is dimmed (shared dimmed materials)",
      await until(
        `(() => { const n = ${card}._objects._dimNode; let d = 0; if (n) n.traverse((o) => { if (o.isMesh && o.userData.fpUndim) d++; }); return d > 0; })()`,
        "the dimmed mower",
      ),
    );
    await ev(
      `window.__setDemoStates({ 'binary_sensor.robo_online': 'on', 'sensor.robo_rain_sensor': 'Wet' })`,
    );
    check(
      "rain chip (weather-rainy) while wet",
      await until(
        `(() => { const ch = ${card}._view.mower.mowerChip; return !!ch && ch.kind === 'rain' && ch.icon === 'mdi:weather-rainy'; })()`,
        "the rain chip",
      ),
    );
    await ev(
      `window.__setDemoStates({ 'sensor.robo_rain_sensor': 'Dry countdown', 'sensor.robo_rain_sensor_countdown': '12' })`,
    );
    check(
      "drying chip with minutes left",
      await until(
        `(() => { const ch = ${card}._view.mower.mowerChip; return !!ch && ch.kind === 'drying' && ch.text.includes('12 min') && ch.icon === 'mdi:weather-partly-rainy'; })()`,
        "the drying chip",
      ),
    );
    await ev(`window.__setDemoStates({ 'sensor.robo_rain_sensor': 'Dry' })`);
    check(
      "chip gone when dry and online",
      await until(`!${card}._view.mower.mowerChip`, "no chip"),
    );
    // error code auto-detected (0 = OK, 12 = error)
    await ev(`window.__setDemoStates({ 'sensor.robo_errorcode': '12' })`);
    check(
      "error code sensor auto-detected: 12 is an error",
      await until(
        `(() => { const w = ${card}._warning; return !!w && w.kind === 'error'; })()`,
        "the error",
      ),
      JSON.stringify(await ev(`${card}._warningText()`)),
    );
    check(
      'popup text "Error code 12"',
      (await ev(`JSON.stringify(${card}._warningText())`)).includes(
        "Error code 12",
      ),
    );
    await ev(`window.__setDemoStates({ 'sensor.robo_errorcode': '0' })`);
    check(
      "error code 0: no warning",
      await until(`!${card}._warning`, "no warning"),
    );
    check(
      "online again: the mower model back to its materials",
      await until(
        `(() => { let d = 0; const m = ${card}._objects._mower(); if (m) m.p.obj.node.traverse((o) => { if (o.isMesh && o.userData.fpUndim) d++; }); return d === 0; })()`,
        "the undimmed mower",
      ),
    );
    allErrors.push(...s.errors);
  },
);

// 2c. no model: today's look
sections.add(
  "no-model",
  { group: "load", query: { view: "3d" } },
  async (s) => {
    const { page } = s;
    const r =
      await page.evaluate(`(() => { const v = ${card}._view; return { tm: v.renderer.toneMapping, sm: v.renderer.shadowMap.enabled, pr: v.renderer.getPixelRatio(),
    labels: ${card}._view.sprites.labels('room', true).length, dayHidden: ${card}.shadowRoot.querySelector('button.daynight').hidden }; })()`);
    check(
      "no model: NoToneMapping, no shadows",
      r.tm === 0 && r.sm === false,
      JSON.stringify(r),
    );
    check(
      "no model: room labels present, day/night hidden, pixel ratio capped",
      r.labels > 0 && r.dayHidden && r.pr <= 1.5,
      JSON.stringify(r),
    );
    await page.evaluate(`${card}._setFloor('all')`);
    await idle(page);
    check(
      'no model: "All" does not fade markers',
      (await page.evaluate(
        `[...${card}._view.markerObjects.values()].filter((m) => m.faded).length`,
      )) === 0,
    );
    allErrors.push(...s.errors);
  },
);

// 3. export snippet round trip
// 5. final review fixes: no occlusion / shadow work for irrelevant state updates (I1), mower and
// pins in an exterior-only view (I2), model view cameras follow the model alignment (I3)
{
  const camsName = `house-cams-${process.pid}.glb`;
  const cams = path.join(root, "screenshots", camsName);
  const modelCam = { position: [14, 12, 10], target: [6, 0, -4] };
  const modelTop = { center: [6, 4], zoom: 1.2 };
  const before = () => {
    fs.mkdirSync(path.join(root, "screenshots"), { recursive: true });
    fs.writeFileSync(
      cams,
      rewriteGlbJson(
        fs.readFileSync(path.join(root, "demo", "house.glb")),
        (json) => {
          for (const n of json.nodes || []) {
            const fp = n.extras && n.extras.fp;
            if (fp && fp.views)
              fp.views = fp.views.map((v) =>
                v.id === "ground"
                  ? { ...v, camera: modelCam, camera_top: modelTop }
                  : v,
              );
          }
          return json;
        },
      ),
    );
  };
  sections.add(
    "review",
    {
      group: "review",
      query: { model: `/screenshots/${camsName}`, view: "3d" },
      viewport: { width: 1400, height: 560 },
      before,
    },
    async (s) => {
      try {
        const { page } = s;
        await page.waitForFunction(`!!${card}._view.model`, { timeout: 30000 });
        await settle(page, card);
        // these checks are about the live mower marker: hide the model's mower object, so the marker is back
        await page.evaluate(
          `(() => { const c = ${card}; c._layout = ({ ...c._layout, objects: { ...(c._layout.objects || {}), mower: { hidden: true } } }); })()`,
        );
        await page
          .waitForFunction(`!!${card}._mowerMarkerId`, { timeout: 5000 })
          .catch(() => {});
        // I1: 10 hass updates (a sensor value, a light's brightness) with the camera still and the mower parked
        await page.evaluate("window.__demoMowerPaused = true");
        await idle(page); // a mower update in flight lands before the counters reset
        await page.evaluate(
          `(() => { const v = ${card}._view; v.stats.shadow = 0; })()`,
        );
        for (let i = 0; i < 10; i++) {
          await page.evaluate(`(() => { const c = ${card}, st = c.hass.states;
        const t = st['sensor.kitchen_temperature'], l = st['light.kitchen'];
        c.hass = { ...c.hass, states: { ...st, 'sensor.kitchen_temperature': { ...t, state: String(20 + ${i}) },
          'light.kitchen': { ...l, attributes: { ...l.attributes, brightness: ${100 + i * 10} } } } }; })()`);
          await idle(page);
        }
        // nothing relevant changed: once idle (nothing pending), a 30-frame window for late work
        await idle(page);
        await rafs(page, 30);
        let stats = await page.evaluate(`${card}._view.stats`);
        check(
          "10 state updates, nothing relevant changed: 0 shadow map renders",
          stats.shadow === 0,
          JSON.stringify(stats),
        );
        check(
          "the state updates still reached the markers",
          await page.evaluate(
            `[...${card}._faces.values()].some((f) => f.value.startsWith('29') || f.inner.startsWith('29'))`,
          ),
        );
        // a moving mower: its marker moves, no sprite is painted again (same picture), no shadow render
        const mpos = () =>
          page.evaluate(
            `(() => { const c = ${card}; const o = c._view.markerObjects.get(c._mowerMarkerId); return o ? o.obj.position.toArray().map((x) => x.toFixed(2)).join() : null; })()`,
          );
        const p0 = await mpos();
        const paints0 = await page.evaluate(
          `${card}._view.sprites.layer.stats.paints`,
        );
        await page.evaluate(
          `(() => { const v = ${card}._view; v.stats.shadow = 0; })()`,
        );
        // five mower steps (the 500 ms timer held), each drawn and idle
        for (let i = 0; i < 5; i++) {
          await page.evaluate("window.__demoMowerStep()");
          await idle(page);
        }
        await idle(page);
        stats = await page.evaluate(`${card}._view.stats`);
        const p1 = await mpos();
        const paints1 = await page.evaluate(
          `${card}._view.sprites.layer.stats.paints`,
        );
        check(
          "moving mower: marker moves, no sprite painted again, no shadow render",
          p0 !== p1 && stats.shadow === 0 && paints1 === paints0,
          `${p0} -> ${p1} ${JSON.stringify({ shadow: stats.shadow, paints0, paints1 })}`,
        );
        // the shadow map still updates when something relevant changes (a view switch)
        await page.evaluate(
          `${card}.shadowRoot.querySelector('.chip[data-view=first]').click()`,
        );
        await waitTrue(
          page,
          `${card}._view.stats.shadow > 0`,
          "the shadow map after the view switch",
          10000,
        );
        stats = await page.evaluate(`${card}._view.stats`);
        check(
          "a view switch re-renders the shadow map",
          stats.shadow > 0,
          JSON.stringify(stats),
        );

        // I2: an added Garden view (hide all, show role:exterior) shows the mower and a pin in the garden zone
        await page.evaluate(`(() => { const c = ${card}, l = c._layout;
      c._layout = ({ ...l, views: { ...(l.views || {}), garden: { added: true, label: 'Garden', rules: [{ hide: 'all' }, { show: 'role:exterior' }] } },
        pins: { ...l.pins, 'device:kettle_plug': { x: 14, y: -5, z: 1, floor_id: 'ground' }, 'device:tv': { x: 9, y: 2, z: 1, floor_id: 'ground' } } }); })()`);
        await idle(page);
        await page.evaluate(`${card}._setView('garden')`);
        await idle(page);
        const vis = (id) =>
          page.evaluate(
            `(() => { const c = ${card}; const o = c._view.markerObjects.get(${id}); return o ? o.obj.visible : null; })()`,
          );
        const gv = {
          mower: await vis(`c._mowerMarkerId`),
          gardenPin: await vis(`'device:kettle_plug'`),
          kitchenPin: await vis(`'device:tv'`),
          chip: await page.evaluate(
            `!!${card}.shadowRoot.querySelector('.chip.on[data-view=garden]')`,
          ),
        };
        check(
          "Garden view: mower and the pin in the garden zone shown, a pin in the (hidden) kitchen not",
          gv.mower === true &&
            gv.gardenPin === true &&
            gv.kitchenPin === false &&
            gv.chip,
          JSON.stringify(gv),
        );

        // I3: model view cameras (3D and top centre) follow the model alignment; identity first
        const near = (a, b, tol = 0.02) =>
          a.every((x, i) => Math.abs(x - b[i]) < tol);
        const camNow = () => page.evaluate(`${card}._view.getCamera()`);
        await page.evaluate(`${card}._setView('ground', { instant: true })`);
        await idle(page);
        let cam = await camNow();
        check(
          "model view camera at identity alignment",
          near(cam.position, modelCam.position) &&
            near(cam.target, modelCam.target),
          JSON.stringify(cam),
        );
        const align = { position: [2, 1, 0.5], rotation: 90, scale: 1.5 };
        await page.evaluate(
          `${card}.setConfig({ ...${card}._config, model_position: ${JSON.stringify(align.position)}, model_rotation: ${align.rotation}, model_scale: ${align.scale} })`,
        );
        await idle(page);
        await page.evaluate(`${card}._setView('exterior', { instant: true })`);
        await page.evaluate(`${card}._setView('ground', { instant: true })`);
        await idle(page);
        cam = await camNow();
        const want = {
          position: alignModelPoint(modelCam.position, align),
          target: alignModelPoint(modelCam.target, align),
        };
        check(
          "model view camera follows the model alignment",
          near(cam.position, want.position) && near(cam.target, want.target),
          JSON.stringify({ cam, want }),
        );
        await page.evaluate(`${card}._setMode('top')`);
        await idle(page);
        await page.evaluate(`${card}._setView('ground', { instant: true })`);
        await idle(page);
        const top = await page.evaluate(`${card}._view.getTopCamera()`);
        const wantC = transformPoint(modelTop.center, align);
        check(
          "model camera_top centre (and zoom / scale) follows the alignment",
          near(top.center, wantC) &&
            Math.abs(top.zoom - modelTop.zoom / align.scale) < 0.01,
          JSON.stringify({ top, wantC }),
        );
        await page.evaluate(`${card}._setMode('3d')`);
        await idle(page);

        allErrors.push(...s.errors);
      } finally {
        fs.rmSync(cams, { force: true });
      }
    },
  );
}

// 6. model loading: progress text, local model cache (second load without the glb download), the
// plan drawing shown while loading, IndexedDB fallback without Cache Storage
sections.add(
  "model-cache",
  { group: "review", query: { model: "1", view: "3d" } },
  async (s) => {
    const { page } = s;
    const gets = [];
    const onReq = (r) => {
      if (r.url().includes("/demo/house.glb")) gets.push(r.method());
    };
    page.on("request", onReq);
    try {
      await page.evaluate((q) => window.__demoReset(q), {
        test: "1",
        model: "1",
        view: "3d",
        quality: "standard",
      }); // loaded again, now watched
      await page.waitForFunction(
        `!!${card}._view.model && ${card}._loadUI.readyAt !== null`,
        { timeout: 20000 },
      );
      let shown = null;
      let st = await page.evaluate(
        `(() => { const c = ${card}, ui = c._loadUI; return { log: ui.log, barHidden: ui.bar.hidden, cached: c._modelFromCache }; })()`,
      );
      check(
        'progress: download, then "Preparing model…", then gone',
        st.log.some((t) => /^Downloading [\d.]+ \/ [\d.]+ MB$/.test(t)) &&
          st.log.includes("Preparing model…") &&
          st.barHidden,
        JSON.stringify(st),
      );
      check(
        "first load downloads the glb",
        gets.includes("GET") && st.cached === false,
        JSON.stringify(gets),
      );
      const outline = await page.evaluate(
        `localStorage.getItem('fp3d-outline:/demo/house.glb')`,
      );
      const stored = outline && JSON.parse(outline);
      check(
        "after a load the room outlines are remembered per model",
        Array.isArray(stored) &&
          stored.length > 2 &&
          stored.every((p) => p.length >= 3) &&
          outline.length < 20480,
        String(outline).slice(0, 120),
      );
      // the drawing fades out for 320 ms after the load, then is removed: waited for, not read at once
      const gone = await page
        .waitForFunction(
          `!${card}.shadowRoot.querySelector('.fp-loadplan') && !${card}._stage.querySelector('.fp-loadplan')`,
          { timeout: 5000 },
        )
        .then(
          () => true,
          () => false,
        );
      check("after the load the drawing overlay is gone", gone);
      // the same demo again, caches kept; the model's HEAD held until the drawing has been checked (released
      // below), so the drawing shows however fast the load would be
      gets.length = 0;
      await page.setRequestInterception(true);
      const heldHeads = [];
      let releaseHeads = false;
      const delay = (r) => {
        if (r.isInterceptResolutionHandled()) return;
        if (
          !releaseHeads &&
          r.url().includes("/demo/house.glb") &&
          r.method() === "HEAD"
        )
          heldHeads.push(r);
        else r.continue();
      };
      page.on("request", delay);
      try {
        await page.evaluate(
          (q) => window.__demoReset(q, { keepCaches: true }),
          { test: "1", model: "1", view: "3d", quality: "standard" },
        );
        await page.waitForFunction(
          `!!${card}.shadowRoot.querySelector('.fp-loadplan .draw')`,
          { timeout: 20000 },
        );
        await page.evaluate(`(() => { // record how the camera moves once the model is there
        const v = ${card}._view, rec = window.__camRec = { moves: [], tween: false };
        const mv = v._moveCamera.bind(v);
        v._moveCamera = (pos, target, instant) => { rec.moves.push({ instant: !!instant || !v._framed, model: !!v.model }); return mv(pos, target, instant); };
        const tick = () => { if (v.model && v._tween) rec.tween = true; if (!rec.stop) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      })()`);
        shown = await page.evaluate(
          `(() => { const e = ${card}.shadowRoot.querySelector('.fp-loadplan'); const d = e.querySelector('.draw').getAttribute('d'); return { d, vis: getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 50, text: e.querySelector('.txt').textContent, parent: e.parentElement.className }; })()`,
        );
        const lock =
          await page.evaluate(`(() => { const c = ${card}, e = c.shadowRoot.querySelector('.fp-loadplan'); let leaked = 0;
        const f = () => { leaked++; };
        c._stage.addEventListener('pointerdown', f); c._stage.addEventListener('click', f);
        const r = e.getBoundingClientRect(), o = { bubbles: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        e.dispatchEvent(new PointerEvent('pointerdown', o)); e.dispatchEvent(new MouseEvent('click', o));
        c._stage.removeEventListener('pointerdown', f); c._stage.removeEventListener('click', f);
        const top = c.shadowRoot.elementFromPoint(o.clientX, o.clientY);
        return { leaked, controls: c._view.controls.enabled, onDrawing: !!top && !!top.closest('.fp-loadplan') }; })()`);
        check(
          "while loading: the drawing swallows pointer input and the orbit controls are off",
          lock.leaked === 0 && lock.controls === false && lock.onDrawing,
          JSON.stringify(lock),
        );
        releaseHeads = true;
        for (const r of heldHeads.splice(0)) r.continue();
        await page.waitForFunction(
          `!!${card}._view.model && ${card}._loadUI.readyAt !== null`,
          { timeout: 20000 },
        );
      } finally {
        page.off("request", delay);
        await page.setRequestInterception(false);
      }
      st = await page.evaluate(
        `(() => { const c = ${card}, ui = c._loadUI; return { log: ui.log, cached: c._modelFromCache }; })()`,
      );
      check(
        "second load: the model from the cache, no glb download",
        st.cached === true && !gets.includes("GET"),
        JSON.stringify({ gets, cached: st.cached }),
      );
      const house = fitOutline(HOUSE_OUTLINE).d;
      check(
        "second load: the drawing is visible over the stage with a non-empty path",
        shown &&
          shown.vis &&
          /^M[\d. ]+L/.test(shown.d) &&
          /stage/.test(shown.parent),
        JSON.stringify(shown),
      );
      check(
        "second load: the remembered outline is drawn, not the house fallback",
        shown && shown.d && house !== shown.d,
        JSON.stringify({
          d: shown && shown.d.slice(0, 60),
          house: house && house.slice(0, 60),
        }),
      );
      const cam = await page.evaluate(
        `(() => { window.__camRec.stop = true; return window.__camRec; })()`,
      );
      check(
        "first camera pose after a load is applied instantly (no fly-in)",
        cam.moves.filter((m) => m.model).every((m) => m.instant) &&
          !cam.tween &&
          cam.moves.length > 0,
        JSON.stringify(cam),
      );
      check(
        "second load: the progress text is under the drawing",
        shown && shown.text.length > 0,
        JSON.stringify(shown),
      );
      check(
        'second load: no download progress, only "Preparing model…"',
        !st.log.some((t) => t.startsWith("Downloading")) &&
          st.log.includes("Preparing model…"),
        JSON.stringify(st.log),
      );
      await page
        .waitForFunction(`!${card}.shadowRoot.querySelector('.fp-loadplan')`, {
          timeout: 5000,
        })
        .catch(() => {});
      const after = await page.evaluate(
        `(() => { const c = ${card}, v = c._view; return { gone: !${card}.shadowRoot.querySelector('.fp-loadplan'), controls: v.controls.enabled, tween: !!v._tween }; })()`,
      );
      check(
        "drawing faded out and removed, controls enabled, no camera animation running",
        after.gone && after.controls && !after.tween,
        JSON.stringify(after),
      );
      // plain http on the LAN: no Cache Storage -> the model blob in IndexedDB
      const idb = await page.evaluate(`(async () => {
      const c = ${card};
      const own = Object.getOwnPropertyDescriptor(window, 'caches');
      Object.defineProperty(window, 'caches', { value: undefined, configurable: true });
      let n = 0;
      const buf = new Uint8Array([103, 108, 84, 70, 2, 0, 0, 0]).buffer;
      const fetchFn = async () => { n++; return new Response(buf, { headers: { 'content-length': '8' } }); };
      const base = location.origin + '/models/idb-test.glb';
      const a = await c._modelBytes(base, 'v1::', fetchFn), c1 = c._modelFromCache;
      const b = await c._modelBytes(base, 'v1::', fetchFn), c2 = c._modelFromCache;
      await c._modelBytes(base, 'v2::', fetchFn); // a new version: fetched again
      if (own) Object.defineProperty(window, 'caches', own); else delete window.caches;
      return { n, c1, c2, same: a.byteLength === 8 && b.byteLength === 8 };
    })()`);
      check(
        "no Cache Storage: model cached in IndexedDB, new version fetched again",
        idb.n === 2 && idb.c1 === false && idb.c2 === true && idb.same,
        JSON.stringify(idb),
      );
      // a stalled download: aborted after the timeout (60 s; shortened here), the error shown, controls enabled again
      const stall = await page.evaluate(`(async () => {
      const c = ${card}, v = c._view, ui = c._loadUI;
      window.__fpModelTimeoutMs = 300;
      let aborted = false;
      const fetchFn = ({ signal }) => new Promise((res, rej) => signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }));
      ui.loading(); // the drawing is up as during a real load
      const err = await v.setModel({ id: 'stall', name: 'stall.glb', data: () => c._modelBytes(location.origin + '/stall.glb', null, fetchFn) });
      ui.done(!!v.model && !err, err || '');
      window.__fpModelTimeoutMs = undefined;
      return { err, aborted, bar: ui.bar.hidden ? null : ui.bar.textContent, controls: v.controls.enabled };
    })()`);
      check(
        "stalled download: timed out, aborted, error shown, controls enabled",
        /timed out/.test(stall.err || "") &&
          stall.aborted &&
          /timed out/.test(stall.bar || "") &&
          stall.controls,
        JSON.stringify(stall),
      );
      // a cached copy that does not parse: evicted and fetched once more
      const bad = await page.evaluate(`(async () => {
      const c = ${card}, v = c._view;
      const base = location.origin + '/models/bad-test.glb';
      await c._modelBytes(base, 'b1', async () => new Response(new Uint8Array([1, 2, 3, 4]))); // junk stored in the cache
      let n = 0;
      const good = async () => { n++; return fetch('/demo/house.glb'); };
      c._modelEvicted = 0;
      const err = await v.setModel({ id: 'bad-then-good', name: 'bad.glb', data: () => { c._modelSrc = { base, version: 'b1', fetchFn: good }; return c._modelBytes(base, 'b1', good); }, dataFresh: () => c._modelFresh() });
      return { err, model: !!v.model, evicted: c._modelEvicted, fetched: n, cachedAfter: c._modelFromCache };
    })()`);
      check(
        "cached model that fails to parse: evicted, fetched once, loads",
        bad.err === null &&
          bad.model &&
          bad.evicted === 1 &&
          bad.fetched === 1 &&
          bad.cachedAfter === false,
        JSON.stringify(bad),
      );
      allErrors.push(...s.errors.filter((e) => !/stall\.glb|bad\.glb/.test(e))); // the deliberate failures above
    } finally {
      page.off("request", onReq);
    }
  },
);

// CI runs one group per shard (--shard k/7). Locally (3 shards): lamps + look + review | objects + load |
// model + mower
sections.order([
  "lamps",
  "objects",
  "model",
  "look",
  "load",
  "mower",
  "review",
]);
const args = parseArgs(process.argv.slice(2));
if (args.list) {
  for (const g of sections.groups)
    console.log(`${g.name}: ${g.sections.map((x) => x.name).join(", ")}`);
  process.exit(0);
}
if (!args.shard && !args.only && args.jobs > 1)
  process.exit(await sections.runShards(import.meta.filename, args.jobs));
// every shard writes screenshots, so create the folder before any section runs
fs.mkdirSync(path.join(root, "screenshots"), { recursive: true });
await sections.run(selectGroups(sections.groups, args), {
  onError: (name, e) => {
    console.log(`FAIL ${name} threw: ${e && e.stack ? e.stack : e}`);
    failures.push(name);
  },
});
const optional = !args.only && (!args.shard || args.shard[0] === 1);

// The optional runs load a local file through the demo server (copied under screenshots/, served as /screenshots/...).
const served = (file, name) => {
  fs.copyFileSync(file, path.join(root, "screenshots", name));
  return `/screenshots/${name}`;
};

// 4. optional: a real model, screenshots only (REAL_MODEL=/path/to/house.glb)
if (optional && process.env.REAL_MODEL) {
  s = await openDemo(
    {
      view: "3d",
      height: "700px",
      model: served(process.env.REAL_MODEL, "real-model.glb"),
    },
    { width: 1500, height: 820 },
  );
  try {
    const { page } = s;
    await page.waitForFunction(`!!${card}._view.model`, { timeout: 60000 });
    await idle(page);
    const ids = await page.evaluate(
      `${card}._floors.map((f) => f.id).concat('all')`,
    );
    for (const id of ids) {
      await page.evaluate(`${card}._setFloor(${JSON.stringify(id)})`);
      await settle(page, card);
      await page.screenshot({
        path: path.join(root, "screenshots", `real-${id}-day.png`),
      });
      console.log("screenshot", `screenshots/real-${id}-day.png`);
    }
    await page.evaluate(
      `${card}.shadowRoot.querySelector('button.daynight').click()`,
    );
    await settle(page, card);
    await page.screenshot({
      path: path.join(
        root,
        "screenshots",
        `real-${ids[ids.length - 1]}-night.png`,
      ),
    });
    console.log(
      "screenshot",
      `screenshots/real-${ids[ids.length - 1]}-night.png`,
    );
    allErrors.push(...s.errors);
  } finally {
    await s.close();
  }
}

// 5. optional: the user's own model (USER_MODEL=/path/to/house.glb): merge stats printed, never fails
if (optional && process.env.USER_MODEL) {
  const url = served(process.env.USER_MODEL, "user-model.glb");
  for (const merge of [true, false]) {
    let u;
    try {
      const t0 = Date.now();
      u = await openDemo(
        {
          view: "3d",
          height: "700px",
          model: url,
          ...(merge ? {} : { merge: "0" }),
        },
        { width: 1500, height: 820 },
      );
      const { page } = u;
      await page.waitForFunction(
        `!!${card}._view.model && !!${card}._view.mergeStats`,
        { timeout: 120000 },
      );
      const ms = Date.now() - t0;
      await idle(page);
      const st = await page
        .evaluate(`JSON.stringify(${card}._view.mergeStats)`)
        .then(JSON.parse);
      const info = await page.evaluate(`(() => { const v = ${card}._view;
        v.dirty = true; return { nodes: ${card}._index ? ${card}._index.nodes.length : null, frameCalls: v.renderer.info.render.calls }; })()`);
      console.log(
        `user model (merge ${merge ? "on" : "off"}): meshes ${st.before.meshes} -> ${st.after.meshes}, draw calls ${st.before.calls} -> ${st.after.calls},` +
          ` triangles ${st.before.triangles} -> ${st.after.triangles}, groups ${st.groups}, merged ${st.merged}; load ${ms} ms (page included); index nodes ${info.nodes}`,
      );
      if (u.errors.length)
        console.log("user model page errors:\n" + u.errors.join("\n"));
      await page.screenshot({
        path: path.join(
          root,
          "screenshots",
          `user-model-merge-${merge ? "on" : "off"}.png`,
        ),
      });
    } catch (e) {
      console.log("user model check could not run:", e.message);
    } finally {
      if (u) await u.close();
    }
  }
}

if (allErrors.length) console.error("page errors:\n" + allErrors.join("\n"));
if (failures.length || allErrors.length) process.exit(1);
console.log("all model checks passed");
process.exit(0);
