# Lights and Objects (v0.4.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Model objects (lamps, mower, dock, charger, climate) become live controls: lamps are real lights with glowing bulbs and a shadow budget, night is dark with the sun from `sun.sun`, tap/hold/popup on objects, an Objects edit tab, and magnetic drag / attach for device markers.

**Architecture:** A new `src/objects/` layer: `logic.js` holds pure, unit-tested functions (binding, chain, colour, intensity, light budget, night factor, sun vector, screen hit test); `layer.js` (`ObjectLayer`) owns the Three.js side (glow materials, a fixed pool of real lights, per-type updates) and is driven by the card with `hass`; `types.js` has one small `prepare/update` pair per type; `popup.js` is the DOM popup. `view.js` only exposes the scene/camera hooks the layer needs; `floorplan3d-card.js` wires hass, taps and markers; `edit-mode.js` gets the Objects tab and the magnetic drag.

**Tech Stack:** Vanilla custom element, Three.js 0.169 (PointLight, SpotLight, MeshStandardMaterial emissive), CSS2DRenderer, esbuild, vitest, eslint, puppeteer-core headless checks.

**Spec:** `docs/superpowers/specs/2026-10-02-lights-and-objects-design.md`

## Global Constraints

- The tool must stay light and easy to understand: few options, good defaults, everything works from the model's `fp` data without setup.
- New card options only: `lights: auto | off` (default `auto`). Day/night choice is per device in localStorage (try/catch).
- Real light pool: 8 PointLight + 4 SpotLight, created once; never add/remove lights or toggle `castShadow` after creation (no shader recompiles). Shadows: at most 4, `mapSize 512`, `bias -0.004`, `camera.near 0.15`.
- Emissive: `emissiveIntensity = bri/255 × 3`; light intensity `bri/255 × hints.max`. Colours via `setRGB(r/255, g/255, b/255, THREE.SRGBColorSpace)`.
- Night: hemisphere 0.14 (sky `#c4d6ff`, ground `#2a2520`), sun 0, background `#0e0f10`; day: hemisphere 0.9, sun 2.6 warm `#fff0dc`, background `#2a2d30`. Night factor `smoothstep(+6°, −6°, elevation)`. Moonlight removed.
- Hit radius 52 px touch / 30 px mouse; hold 500 ms; tap = pointer moved < 5 px.
- Without a model, everything behaves exactly as v0.3.1.
- Public repo: generic names only, no personal names/paths/real entity ids in code, tests or docs.
- Commits end with the two trailer lines (Co-Authored-By / Claude-Session) given by the controller.

## Review Focus

1. HA state updates every few seconds: only changed objects update; light budget/shadows recompute only when lit set, view or section changes (not every update).
2. An object whose entity is `unavailable` or missing: dark, no errors, popup says "unavailable".
3. A light group with 20 fixtures turning on at once: one real light for the group, the rest emissive; frame time stays flat.
4. Model replaced/removed while a popup is open or a light is in the pool: popup closes, pool lights reset to 0, no stale references.
5. Touch on a wall tablet: a tap near two lamps picks the nearest; a tap that starts an orbit (moved ≥ 5 px) never toggles.

---

### Task 1: Pure logic (`src/objects/logic.js`)

**Files:**

- Create: `src/objects/logic.js`
- Test: `test/objects-logic.test.js`

**Interfaces:**

- Produces:
  - `bindObjects(objects, layoutObjects, states)` → `Map<objectId, { entity: string|null, auto: boolean, missing: boolean, hidden: boolean }>`
  - `chainState(obj, binding, groups, states)` → `{ lit: boolean, unavailable: boolean, source: stateObj|null, entities: string[], reason: string|null }`
  - `lightColor(stateObj|null)` → `[r, g, b]` (0–255, sRGB)
  - `lightLevel(stateObj|null)` → number 0..1
  - `lightBudget(fixtures, { points = 8, spots = 4, shadows = 4 } = {})` → `{ real: Map<id, { kind: 'point'|'spot', factor: number }>, shadows: Set<id> }`
  - `nightFactor(elevationDeg)` → 0..1
  - `sunVector(azimuthDeg, elevationDeg, northDeg, alignRotationDeg)` → `[x, y, z]` unit vector in world space pointing towards the sun
  - `screenNearest(points, x, y, radius)` → id or null

- [ ] **Step 1: Write the failing tests** (`test/objects-logic.test.js`)

```js
import { describe, it, expect } from 'vitest';
import { bindObjects, chainState, lightColor, lightLevel, lightBudget, nightFactor, sunVector, screenNearest } from '../src/objects/logic.js';

const st = (entity_id, state, attributes = {}) => ({ entity_id, state, attributes });

describe('bindObjects', () => {
  const objects = [
    { id: 'a', suggest: { entity: 'light.a' } },
    { id: 'b', suggest: { entity: 'light.missing' } },
    { id: 'c', suggest: {} },
  ];
  const states = { 'light.a': st('light.a', 'on'), 'light.x': st('light.x', 'off') };
  it('auto-binds suggest.entity when it exists', () => {
    const b = bindObjects(objects, {}, states);
    expect(b.get('a')).toEqual({ entity: 'light.a', auto: true, missing: false, hidden: false });
    expect(b.get('b')).toEqual({ entity: null, auto: true, missing: true, hidden: false });
    expect(b.get('c')).toEqual({ entity: null, auto: true, missing: false, hidden: false });
  });
  it('layout entry overrides and can hide', () => {
    const b = bindObjects(objects, { a: { entity: 'light.x' }, c: { hidden: true } }, states);
    expect(b.get('a')).toEqual({ entity: 'light.x', auto: false, missing: false, hidden: false });
    expect(b.get('c').hidden).toBe(true);
  });
  it('explicit entity that no longer exists is missing', () => {
    expect(bindObjects(objects, { a: { entity: 'light.gone' } }, states).get('a').missing).toBe(true);
  });
});

describe('chainState', () => {
  const states = {
    'light.f': st('light.f', 'on', { brightness: 128 }),
    'switch.g': st('switch.g', 'off'),
    'switch.on': st('switch.on', 'on'),
    'light.u': st('light.u', 'unavailable'),
  };
  it('own entity only', () => {
    const r = chainState({ group: null }, { entity: 'light.f' }, {}, states);
    expect(r.lit).toBe(true); expect(r.source.entity_id).toBe('light.f'); expect(r.reason).toBe(null);
  });
  it('group controller off makes it dark with a reason', () => {
    const r = chainState({ group: 'facade' }, { entity: 'light.f' }, { facade: { entity: 'switch.g' } }, states);
    expect(r.lit).toBe(false); expect(r.reason).toBe('group switch is off'); expect(r.entities).toEqual(['light.f', 'switch.g']);
  });
  it('group controller only (no own entity)', () => {
    const r = chainState({ group: 'facade' }, { entity: null }, { facade: { entity: 'switch.on' } }, states);
    expect(r.lit).toBe(true); expect(r.source).toBe(null);
  });
  it('unavailable is dark and flagged', () => {
    const r = chainState({ group: null }, { entity: 'light.u' }, {}, states);
    expect(r.lit).toBe(false); expect(r.unavailable).toBe(true);
  });
  it('no entity at all is dark without reason', () => {
    expect(chainState({ group: null }, { entity: null }, {}, states)).toMatchObject({ lit: false, reason: null });
  });
});

describe('lightColor / lightLevel', () => {
  it('rgb_color wins', () => expect(lightColor(st('light.a', 'on', { rgb_color: [255, 0, 0], hs_color: [120, 100] }))).toEqual([255, 0, 0]));
  it('hs_color converts', () => expect(lightColor(st('light.a', 'on', { hs_color: [120, 100] }))).toEqual([0, 255, 0]));
  it('kelvin converts to warm for 2700', () => { const [r, g, b] = lightColor(st('light.a', 'on', { color_temp_kelvin: 2700 })); expect(r).toBe(255); expect(b).toBeLessThan(g); });
  it('default warm white', () => expect(lightColor(st('switch.a', 'on'))).toEqual([255, 191, 128]));
  it('level from brightness, 1 when on without brightness, 0 when off', () => {
    expect(lightLevel(st('light.a', 'on', { brightness: 51 }))).toBeCloseTo(0.2);
    expect(lightLevel(st('switch.a', 'on'))).toBe(1);
    expect(lightLevel(st('light.a', 'off', { brightness: 200 }))).toBe(0);
    expect(lightLevel(null)).toBe(0);
  });
});

describe('lightBudget', () => {
  const f = (id, o = {}) => ({ id, lit: true, visible: true, group: null, max: 5, beam: 'point', castShadow: true, ...o });
  it('largest max first, pools respected, unlit and invisible skipped', () => {
    const fx = [f('a', { max: 34 }), f('b', { max: 5 }), f('c', { lit: false, max: 99 }), f('d', { visible: false, max: 99 }), f('s', { beam: 'spot', max: 10 })];
    const r = lightBudget(fx, { points: 1, spots: 1, shadows: 4 });
    expect([...r.real.keys()].sort()).toEqual(['a', 's']);
    expect(r.real.get('s').kind).toBe('spot');
  });
  it('one real light per group (middle fixture, factor 1.5), groups never cast shadows', () => {
    const fx = ['g1', 'g2', 'g3'].map((id) => f(id, { group: 'facade', max: 5 }));
    const r = lightBudget(fx);
    expect([...r.real.keys()]).toEqual(['g2']);
    expect(r.real.get('g2').factor).toBe(1.5);
    expect(r.shadows.size).toBe(0);
  });
  it('at most N shadows, only castShadow !== false singles', () => {
    const fx = [1, 2, 3, 4, 5, 6].map((i) => f('p' + i, { max: i })).concat([f('n', { max: 100, castShadow: false })]);
    const r = lightBudget(fx);
    expect(r.shadows.size).toBe(4);
    expect(r.shadows.has('n')).toBe(false);
    expect(r.shadows.has('p6')).toBe(true);
  });
});

describe('nightFactor / sunVector', () => {
  it('smoothstep between +6 and -6 degrees', () => {
    expect(nightFactor(30)).toBe(0); expect(nightFactor(-20)).toBe(1); expect(nightFactor(0)).toBeCloseTo(0.5);
  });
  it('east sun with north 0 points to +x', () => {
    const [x, y, z] = sunVector(90, 0, 0, 0); expect(x).toBeCloseTo(1); expect(y).toBeCloseTo(0); expect(z).toBeCloseTo(0);
  });
  it('south sun at 45° elevation points to +z (south) and up', () => {
    const [x, y, z] = sunVector(180, 45, 0, 0); expect(x).toBeCloseTo(0); expect(y).toBeCloseTo(Math.SQRT1_2); expect(z).toBeCloseTo(Math.SQRT1_2);
  });
  it('north -26.4: true north lies west of model north', () => {
    const [x, , z] = sunVector(0, 0, -26.4, 0); expect(x).toBeLessThan(0); expect(z).toBeLessThan(0);
  });
  it('model alignment rotation (deg, CCW) rotates the vector', () => {
    const [x, , z] = sunVector(90, 0, 0, 90); expect(x).toBeCloseTo(0); expect(z).toBeCloseTo(-1);
  });
});

describe('screenNearest', () => {
  const pts = [{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 130, y: 100 }];
  it('nearest within radius', () => { expect(screenNearest(pts, 118, 100, 30)).toBe('b'); expect(screenNearest(pts, 300, 300, 52)).toBe(null); });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/objects-logic.test.js` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`src/objects/logic.js`)

```js
// Pure logic for model objects: binding, chains, colour, budget, sun. No Three.js here.
const ON = new Set(['on', 'open', 'home', 'charging', 'heat', 'cool', 'mowing']);
const isOn = (s) => !!s && ON.has(s.state);
const bad = (s) => !s || s.state === 'unavailable' || s.state === 'unknown';

export function bindObjects(objects, layoutObjects = {}, states = {}) {
  const out = new Map();
  for (const o of objects) {
    const saved = layoutObjects[o.id] || {};
    const hidden = !!saved.hidden;
    if (saved.entity !== undefined) {
      const entity = saved.entity || null;
      out.set(o.id, { entity: entity && states[entity] ? entity : null, auto: false, missing: !!entity && !states[entity], hidden });
      continue;
    }
    const s = (o.suggest || {}).entity;
    out.set(o.id, { entity: s && states[s] ? s : null, auto: true, missing: !!s && !states[s], hidden });
  }
  return out;
}

export function chainState(obj, binding, groups = {}, states = {}) {
  const ctrl = obj.group && groups[obj.group] && groups[obj.group].entity;
  const entities = [binding && binding.entity, ctrl].filter(Boolean);
  if (!entities.length) return { lit: false, unavailable: false, source: null, entities, reason: null };
  const sts = entities.map((e) => states[e]);
  const unavailable = sts.some(bad);
  const lit = !unavailable && sts.every(isOn);
  let reason = null;
  if (!lit && !unavailable && ctrl && !isOn(states[ctrl]) && entities[0] !== ctrl) reason = 'group switch is off';
  const source = sts.find((s, i) => s && entities[i].startsWith('light.')) || null;
  return { lit, unavailable, source, entities, reason };
}

function hsvToRgb(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)].map((x) => Math.round(x * 255));
}

function kelvinToRgb(k) {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((x) => Math.round(Math.min(255, Math.max(0, x))));
}

export function lightColor(s) {
  const a = (s && s.attributes) || {};
  if (Array.isArray(a.rgb_color)) return a.rgb_color.slice(0, 3);
  if (Array.isArray(a.hs_color)) return hsvToRgb(a.hs_color[0], a.hs_color[1] / 100, 1);
  if (a.color_temp_kelvin) return kelvinToRgb(a.color_temp_kelvin);
  return hsvToRgb(30, 0.5, 1); // warm white
}

export function lightLevel(s) {
  if (!isOn(s)) return 0;
  const b = s.attributes && s.attributes.brightness;
  return typeof b === 'number' ? Math.max(0, Math.min(1, b / 255)) : 1;
}

export function lightBudget(fixtures, { points = 8, spots = 4, shadows = 4 } = {}) {
  const cand = [];
  const groups = new Map();
  for (const f of fixtures) {
    if (!f.lit || !f.visible) continue;
    if (f.group) { if (!groups.has(f.group)) groups.set(f.group, []); groups.get(f.group).push(f); } else cand.push({ f, factor: 1 });
  }
  for (const list of groups.values()) {
    const sorted = list.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    cand.push({ f: sorted[Math.floor((sorted.length - 1) / 2)], factor: 1.5, grouped: true });
  }
  cand.sort((a, b) => (b.f.max || 0) - (a.f.max || 0));
  const real = new Map(), shadowSet = new Set();
  let p = 0, s = 0;
  for (const c of cand) {
    const kind = c.f.beam === 'spot' ? 'spot' : 'point';
    if (kind === 'spot' ? s >= spots : p >= points) continue;
    if (kind === 'spot') s++; else p++;
    real.set(c.f.id, { kind, factor: c.factor });
    if (!c.grouped && c.f.castShadow !== false && shadowSet.size < shadows) shadowSet.add(c.f.id);
  }
  return { real, shadows: shadowSet };
}

export function nightFactor(elevation) {
  const t = Math.max(0, Math.min(1, (6 - elevation) / 12));
  return t * t * (3 - 2 * t);
}

// Bearing clockwise from model north = HA azimuth + fp.north; plan (x east, y north) → world (x, ·, −y);
// then the model alignment rotation (degrees, counter-clockwise seen from above).
export function sunVector(azimuth, elevation, north = 0, alignRotation = 0) {
  const d = Math.PI / 180;
  const b = (azimuth + north) * d, e = elevation * d;
  let px = Math.sin(b) * Math.cos(e), py = Math.cos(b) * Math.cos(e);
  const r = alignRotation * d;
  [px, py] = [px * Math.cos(r) - py * Math.sin(r), px * Math.sin(r) + py * Math.cos(r)];
  return [px, Math.sin(e), -py];
}

export function screenNearest(points, x, y, radius) {
  let best = null, bd = radius;
  for (const p of points) { const d = Math.hypot(p.x - x, p.y - y); if (d <= bd) { bd = d; best = p.id; } }
  return best;
}
```

- [ ] **Step 4: Run tests** — `npx vitest run test/objects-logic.test.js` → PASS. If a vector-sign test fails, fix the implementation (not the test): the tests encode the spec (east = +x, south = +z, true north west of model north for north −26.4, CCW alignment).
- [ ] **Step 5: Lint + commit** — `npx eslint .`; commit `Objects: pure logic for binding, chains, colour, light budget, night and sun`.

---

### Task 2: Object layer, lamps and the light pool

**Files:**

- Create: `src/objects/layer.js`, `src/objects/types.js`
- Modify: `src/view.js` (hooks below), `src/floorplan3d-card.js` (wiring, hide markers of bound devices, `lights` option), `src/card-editor.js` (`lights` select)
- Test: `test/objects-types.test.js` (pure parts of types: glow lookup by name, hint defaults), headless checks in Task 8

**Interfaces:**

- Consumes: Task 1 functions; manifest `objects` entries `{ id, type, label, level, room, group, glow, anchor, hints, suggest, ui, node }` (node via `manifest.byNode` inverse — add `entry.node` in `src/manifest.js` if missing, through the adapter's node).
- Produces:
  - `class ObjectLayer { constructor(view); setModel(model|null); setBindings(bindings: Map, groups); update(states, { visibleLevel: (levelId)=>boolean, lightsOn: boolean }); anchors(): Array<{ id, world: THREE.Vector3 }>; objectAt(id); dispose() }`
  - `types.js`: `TYPES = { light, light_strip, mower, dock, ev_charger, climate, generic }`, each `{ prepare(obj, ctx) → part, update(part, s, ctx), defaults: { tap, hold, popup } }`; `hintDefaults(hints)` → `{ beam: 'point', max: 5, distance: 0, decay: 2, angle: 24, penumbra: 0.6, target: null, castShadow: true, ...valid hints }`; `findGlow(node, name)` → first mesh named `name` (userData.name or name) under node, else null.
  - view hooks: `view.objectsGroup` (THREE.Group added to the scene for pool lights/targets), `view.markDirty()`, `view.requestShadowUpdate()`.
  - card: `this._objects` (ObjectLayer), `this._bindings` (Map from Task 1), option `lights` (`auto`|`off`).

- [ ] **Step 1: Tests first** for `hintDefaults` (invalid values → defaults; `beam: 'down'`/`'up'` treated as point; angle clamp 5–80°) and `findGlow` (on a plain object tree `{ name, userData, children, isMesh }`).
- [ ] **Step 2: `types.js` light / light_strip / generic**:
  - `prepare`: find the glow mesh (`findGlow(node, obj.glow || 'glow')`); clone its material once (`mat.clone()`, keep `userData.baseEmissive`), set `emissive` black, `emissiveIntensity 0`; remember the anchor = glow world centre (or `obj.anchor` transformed, or the node's bounding-box centre). Wall lamp offset: if `hints.beam` is `down`/`point` and the glow mesh is within 0.1 m of a vertical surface (skip if unsure — use `hints.offset` `[x,y,z]` when given), else no offset.
  - `update(part, chain, ctx)`: `level = chain.lit ? lightLevel(chain.source || {state:'on', attributes:{}}) : 0` (relay without `light.*` source = 1); colour `lightColor(chain.source)`; `mat.emissive.setRGB(r/255,g/255,b/255, SRGBColorSpace)`; `mat.emissiveIntensity = level * 3`; return `{ lit: level > 0, level, color }` for the budget.
  - generic: no visual change.
- [ ] **Step 3: `layer.js`**:
  - Pool: 8 `PointLight(0xffffff, 0, 0, 2)` and 4 `SpotLight(0xffffff, 0, 7, 24°, 0.6, 1.4)` (+ their targets) created in the constructor and added to `view.objectsGroup`. Shadows: pool point lights 0–3 have `castShadow = true` permanently (`shadow.mapSize 512`, `bias -0.004`, `camera.near 0.15`); points 4–7 and spots never cast. (Shadow casters = the first 4 point slots; `lightBudget` shadow picks are assigned to those slots; non-shadow picks fill slots 4–7 first, then 0–3 if free with intensity but they will cast — acceptable only when there are fewer than 4 shadow picks.)
  - `update(states, ctx)`: for each object compute chain → type update; collect fixtures `{ id, lit, visible: ctx.visibleLevel(obj.level), group, max: hints.max, beam, castShadow }`; if the lit/visible signature changed (or a fixture's colour/level changed for a pooled light), run `lightBudget` and assign pool slots: position at the fixture anchor (+ offset), colour, `intensity = level × hints.max × factor`, distance/decay/angle/penumbra from hints, spot target from `hints.target` (glTF world → card world via the model root matrixWorld) or straight down. Unused slots: intensity 0. Call `view.requestShadowUpdate()` only when slot assignment or a shadow light's position/intensity changed; `view.markDirty()` when anything changed.
  - `ctx.lightsOn === false` (`lights: off`): all pool intensities 0, emissive still applied.
  - `setModel(null)`/`dispose()`: restore cloned materials, pool intensities 0, forget parts.
- [ ] **Step 4: Card wiring**: after the model loads, `this._objects.setModel(...)`; on every hass update compute `bindObjects(manifest.objects, layout.objects, hass.states)` only when `hass.states` entity set or `layout.objects` changed (signature of keys) and call `this._objects.update(hass.states, { visibleLevel, lightsOn })` — `visibleLevel(levelId)` from the current view's effective visibility (level node visible). Remove the glow sprites for lights bound to an object; keep sprites for lights without one. Hide markers whose device's primary entity is bound (spec §1).
- [ ] **Step 5: View hooks** (`objectsGroup`, `markDirty`, `requestShadowUpdate` = set `renderer.shadowMap.needsUpdate = true` and dirty).
- [ ] **Step 6: Verify** eslint, vitest, build, model-check, edit-check, screenshot (existing checks must pass; the demo model has no lamps yet — Task 8 adds them). Commit `Objects: lamps glow and light the house from a fixed light pool with a shadow budget`.

---

### Task 3: Day, night and the sun

**Files:** Modify `src/view.js` (`_applyLook`, `_fitShadow`), `src/floorplan3d-card.js` (toolbar button cycle, sun from hass), `README.md`. Test: `test/objects-logic.test.js` already covers the math; headless in Task 8.

**Interfaces:**

- Consumes: `nightFactor`, `sunVector` (Task 1).
- Produces: `view.setSky({ night: 0..1, sunDir: [x,y,z] | null })`; card `this._skyMode` in `'auto'|'day'|'night'` persisted at localStorage key `floorplan3d.sky` (try/catch).

- [ ] **Step 1:** `setSky`: with a model, hemisphere intensity `lerp(0.9, 0.14, night)`, colours sky `#c4d6ff` / ground `#2a2520` (both day and night), sun intensity `lerp(2.6, 0, night)` colour `#fff0dc`, `sun.castShadow = night < 1`, background `lerp(#2a2d30, #0e0f10, night)` (only when the card's background is the model background, i.e. keep today's theme background handling for no-model), sun position = shadow-box centre + `sunDir × distance` when `sunDir` is given (else today's fixed bearing from `fp.north`). Remove the moonlight branch. Without a model: unchanged (`setDaylight` path).
- [ ] **Step 2:** card: toolbar button cycles `auto → day → night → auto` with icons `mdi:theme-light-dark` / `mdi:white-balance-sunny` / `mdi:weather-night` and title "Day / night: auto|day|night". Auto: read `hass.states['sun.sun']` attributes `elevation`, `azimuth`; `night = nightFactor(elevation)`; `sunDir = sunVector(azimuth, elevation, manifestNorth, layout.model.rotation || 0)`; call `setSky` only when night changed by > 0.01 or the sun moved > 1° since the last call. Day: `{ night: 0, sunDir: null }`; Night: `{ night: 1, sunDir: null }`. No `sun.sun` → day.
- [ ] **Step 3:** README: day/night button and Auto behaviour. Verify, commit `Sky: dark night and the sun from sun.sun with a smooth dusk`.

---

### Task 4: Tap, hold and the popup

**Files:** Create `src/objects/popup.js`; modify `src/floorplan3d-card.js` (pointer handling), STYLE; Test: `test/objects-popup.test.js` (row building is pure).

**Interfaces:**

- Consumes: `screenNearest` (Task 1), `ObjectLayer.anchors()`, `TYPES[type].defaults`, `chainState`.
- Produces: `popupRows(obj, chain, states)` → array of `{ kind, entity?, label, value? }`; `class ObjectPopup { constructor(root, { onAction }); open(obj, anchorWorld); update(states); close(); get isOpen }`.

- [ ] **Step 1:** Tests for `popupRows`: defaults per type (light: toggle, brightness, color; generic: state), `fp.ui.popup` override, grouped fixture adds one `chain` row per controller and a `reason` row when dark, unavailable → single `state` row "unavailable".
- [ ] **Step 2:** Pointer handling in the card (view mode, and edit mode only when the Objects tab is open): on pointerdown remember position/time; on pointerup with movement < 5 px: project `anchors()` of visible bound objects with `view.screenPoint`, `id = screenNearest(points, x, y, e.pointerType === 'touch' ? 52 : 30)`; if an object is hit it wins over markers. Hold (500 ms without moving ≥ 5 px) → hold action. Actions: `toggle` → `callService(domain, 'toggle', { entity_id })` on the object's own entity, or the group controller if it has no own entity; `more-info` → existing `hass-more-info` event; `popup` → `ObjectPopup.open`; `none`.
- [ ] **Step 3:** Popup DOM: a small absolutely positioned panel in the stage (HA card colours via CSS vars), title = object label, rows: toggle (switch), brightness (range 1–255 → `light.turn_on` with `brightness`), color (8 swatches + white → `light.turn_on` `rgb_color` / `color_temp_kelvin: 2700`), state/battery/power/energy/temperature/mode (read-only values from the bound entity's state/attributes), start_dock (mower: `lawn_mower.start_mowing` / `lawn_mower.dock`), chain rows (controller name + toggle) and reason text. Repositions on every render (anchor projected), closes on outside pointerdown, Esc, view change, model change.
- [ ] **Step 4:** Verify, commit `Objects: tap to toggle, hold for a popup with brightness, colour and the group chain`.

---

### Task 5: Mower, dock, charger, climate

**Files:** Modify `src/objects/types.js`, `src/floorplan3d-card.js` (mower position feed), Test: `test/objects-types.test.js` (state → colour/label mapping).

**Interfaces:**

- Consumes: the card's existing live mower position (`readSource` + calibration in `src/mower.js`, used where `_mowerMarkerId` is updated), Task 2 layer.
- Produces: `layer.setMowerPose({ x, y, floorId, heading } | null)`; `statusColor(type, state)` → `[r,g,b]|null`; `objectLabel(type, states, entity)` → string|null.

- [ ] **Step 1:** Tests for `statusColor` (mower: mowing green `[76,175,80]`, returning amber `[255,179,0]`, error red `[244,67,54]`, docked/paused dim `null`; ev_charger: charging green, ready/available blue `[33,150,243]`, error red, else `null`) and `objectLabel` (ev_charger charging → power `"7.2 kW"` from a `sensor.*power*` attribute or the entity state with unit; climate → `"21.5 °C"` from `current_temperature`).
- [ ] **Step 2:** mower: when a mower object is bound and a live position exists, move the mower node to the plan position (world `(x, floorElevation, −y)` relative to the model root parent: set the node's world position via its parent's inverse matrix), heading from the last movement vector (only when moved > 0.05 m), status colour on its glow mesh; the card stops showing the mower marker when the mower object exists.
- [ ] **Step 3:** dock: `hints.led` mesh emissive green when the mower entity's state is `docked`, dim otherwise (mower entity = the bound mower object's entity). ev_charger: LED colour by `statusColor`, plus a CSS2D label with `objectLabel` while charging. climate: CSS2D label with `objectLabel`; glow warm `[255,120,60]` when `hvac_action` is `heating`, cool `[80,160,255]` when `cooling`.
- [ ] **Step 4:** Verify, commit `Objects: mower follows its live position, dock, charger and climate states`.

---

### Task 6: Edit mode — Objects tab

**Files:** Modify `src/edit-mode.js`, `src/floorplan3d-card.js` (STYLE), `src/editor.js` (pure layout helpers), Test: `test/editor.test.js`.

**Interfaces:**

- Consumes: bindings (Task 1), `ObjectLayer`, `saveLayout` path via `this.commit(...)`.
- Produces: `E.setObject(layout, id, patch)` (merge into `layout.objects[id]`, `patch.entity === undefined` removes the key to return to auto), `E.setGroup(layout, name, patch)`.

- [ ] **Step 1:** Tests for `setObject` / `setGroup` (immutability, back to auto, hidden toggle).
- [ ] **Step 2:** Objects tab (between Devices and Mower): objects grouped by level → room (collapsed rooms by default, like the Views tree); row: label, type icon, entity input with datalist of matching domains (light.* for light types, lawn_mower.* for mower, …) showing "auto" when auto-bound and "entity not found" when missing, Test button (toggle via the same action path as a tap), hide checkbox. Groups section: each `group` name with an optional controller entity input. Clicking an object in 3D (Objects tab open) selects and scrolls to its row (use `screenNearest` hit as in Task 4).
- [ ] **Step 3:** Verify, commit `Edit: Objects tab to bind model objects and group controllers`.

---

### Task 7: Magnetic drag and attach

**Files:** Modify `src/edit-mode.js` (marker drag), `src/view.js` (surface raycast helper), `src/floorplan3d-card.js` (attached marker positions), `src/editor.js`, Test: `test/editor.test.js`, `test/objects-logic.test.js` (`snapPin`).

**Interfaces:**

- Produces: `view.surfaceAt(clientX, clientY)` → `{ point: Vector3, normal: Vector3, object, owner }` (visible model meshes only, section/cut respected) or null; pure `snapPin(hit, floorElevation, floorId)` → `{ x, y, z, floor_id }` (plan coords, z = hit.y + normal.y×0.05 − floorElevation, x/y from hit + normal×0.05); `E.attachPin(layout, markerId, objectId, offset)`; card: markers with `pins[id].attach` positioned at the object's anchor + offset every time positions are computed (and when the mower object moves).

- [ ] **Step 1:** Tests for `snapPin` (wall hit offsets 5 cm along the normal; ceiling hit gives z just below the ceiling) and `attachPin` (keeps `on_model`, stores `attach` and `offset`).
- [ ] **Step 2:** Drag: while dragging a marker (Devices tab), if Alt is not held and `surfaceAt` hits, place the marker at `snapPin(...)` (floor = HA floor bound to the hit owner's level; fallback current floor); if the hit owner is a model object, highlight it (`highlightModelNode`) and on drop store `attachPin(layout, id, objectId, offsetFromAnchor)`; else store the snapped pin with `on_model: true`. Alt → today's free drag. Selected attached marker shows "Detach" (removes `attach`, keeps the current position as a normal pin).
- [ ] **Step 3:** Verify, commit `Edit: markers stick to model surfaces and attach to model objects`.

---

### Task 8: Demo model objects, headless checks, docs, v0.4.0

**Files:** `scripts/make-demo-model.mjs`, `demo/house.glb`, `demo/mock-hass.js` (lights `light.demo_*`, a `switch.demo_facade`, `sun.sun` with settable elevation/azimuth, a charger sensor, a climate entity), `scripts/model-check.mjs`, `docs/model-builder-guide.md`, `README.md`, versions (package.json, manifest.json, `VERSION` in `src/floorplan3d-card.js`, `npm install --package-lock-only`).

- [ ] **Step 1:** Demo model: in the ground level add 3 ceiling lamps (`type: light`, `glow: 'glow'` child sphere r 0.05, `hints: { beam: 'point', max: 20, distance: 8, decay: 2 }`, `suggest.entity: 'light.demo_living'` etc.), a facade group of 3 (`group: 'facade'`, `hints.beam: 'down'`, `max: 5`, `castShadow: false`, all `suggest.entity: 'light.demo_facade'`), one spot (`beam: 'spot'`, `target`), a light_strip; in the exterior a mower (`suggest.entity: 'lawn_mower.demo'`), dock (`hints.led: 'led'`), ev_charger and in a room a climate object. `node tools/check-model.mjs demo/house.glb` → OK.
- [ ] **Step 2:** Headless checks: lamps bound automatically (Objects tab shows entities, none "not found"); light on → glow emissiveIntensity > 0 and a pool light with intensity > 0 near it; ≤ 12 pool lights with intensity > 0 and ≤ 4 shadow casters lit; facade group on → exactly one pool light for the group; group controller off → fixtures dark and popup reason text; tap on a lamp toggles its entity (mock `callService` records); hold opens the popup, brightness slider calls `light.turn_on`; `sun.sun` elevation −20 → hemisphere ≈ 0.14 and sun 0, +30 → 0.9 and 2.6; mower object node moves when the fake mower moves and the mower marker is gone; markers of bound lamps hidden; drag a marker onto a wall → pin z between 0.5 and 2.6 and x/y on the wall ±0.1; drag onto a lamp → `attach` stored and marker follows when the model is realigned; `lights: off` → all pool intensities 0; ten hass updates with no change → no budget recompute and no shadow update (instrument with counters on the layer).
- [ ] **Step 3:** Docs: guide — objects section updated to what the card reads (`hints` keys `beam`, `max`, `distance`, `decay`, `angle`, `penumbra`, `target`, `castShadow`, `led`, `offset`; `glow`; `group`; `suggest.entity`; `ui`), one glow mesh per fixture, wall-lamp light 12 cm in front, decal offset 2–5 mm. README — lamps and objects, day/night auto, tap/hold/popup, Objects tab, magnetic drag/attach, `lights` option.
- [ ] **Step 4:** Version 0.4.0. Verify eslint, vitest, build, check-model, model-check, edit-check, screenshot, pytest (`<venv>/bin/python -m pytest -q` if available). Commit `Demo objects, headless checks for lamps, sky, taps and drag, docs, v0.4.0`.

---

## Self-review notes

- Spec §1 → T1 (binding, chain), T2 (markers hidden), T6 (edit); §2 → T2 (light, strip, generic), T5 (mower, dock, charger, climate); §3 → T1 (budget), T2 (pool, shadows, `lights`); §4 → T1 (math), T3; §5 → T1 (`screenNearest`), T4; §6 → T6, T7; §7 → T8; §8 → T1 (missing/unavailable), T2 (no glow, invalid hints, pool overflow); §9 → each task + T8.
- Names: `bindObjects`, `chainState`, `lightColor`, `lightLevel`, `lightBudget`, `nightFactor`, `sunVector`, `screenNearest`, `ObjectLayer`, `TYPES`, `hintDefaults`, `findGlow`, `setSky`, `popupRows`, `ObjectPopup`, `statusColor`, `objectLabel`, `setMowerPose`, `surfaceAt`, `snapPin`, `E.setObject`, `E.setGroup`, `E.attachPin`.
