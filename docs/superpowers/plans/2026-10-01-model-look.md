# Model look and level switching — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a house model is loaded, the card looks like the design prototype: levels are switched as whole nodes (no horizontal cut for tagged models), ACES tone mapping with sun/hemisphere light and soft shadows, a Day/Night toggle, the model's own floors visible (no grey room fills over it), a 3/4 camera with smooth transitions, and quiet markers that follow their level.

**Architecture:** Visibility rules stay pure (`src/bindings.js`: `resolveLevels` defaults; `levelVisible` moves there with a floor-elevation lookup). `src/view.js` gets a "model look" switch (renderer, lights, shadows), daylight state, camera tween, structure flags (fills/outlines/labels) and marker fading. The card wires flags, a Day/Night toolbar button and re-renders structure when edit mode toggles. Plans without a model keep today's flat look.

**Tech Stack:** Vanilla JS custom element, Three.js 0.169, vitest, puppeteer-core headless checks.

**Spec:** `docs/superpowers/specs/2026-10-01-model-contract-design.md` (section 2 defaults are amended by this plan, see Task 3). Source of the rules: the design session's notes (summarised in Global Constraints).

## Global Constraints

- Applies only when a model is loaded (`view.model` set). Without a model: today's look exactly (NoToneMapping, hemisphere 2.2, sun 1.4, no shadows, room fills/labels/walls as now).
- Level show modes: `with` (default for storeys/basements: shown when the selected floor is the level's floor **or any floor above it**, compared by floor elevation), `only` (only on its own floor), `always`, `all-only`, `hidden`. In "All" every non-hidden level shows.
- Defaults: storeys/basements `with` their floor (matching as today); `exterior` → `always` (it keeps a floor id for its zones: the lowest above-ground storey's floor); `roof` → `all-only`.
- Tagged models (any level whose tag source is `extras` or `name`): no horizontal clip (`modelClip.constant = 1e6`). Legacy/untagged models keep today's cut at `floorElevation + max(wallHeight, 0.3)`.
- Renderer with a model: `ACESFilmicToneMapping`, `toneMappingExposure = 1.25`, output sRGB, `shadowMap.enabled = true`, `PCFSoftShadowMap`. Pixel ratio cap `1.5` always.
- Lights with a model: hemisphere sky `0xcfdcff`, ground `0x7a6248`; day: hemisphere `1.1`, sun `2.6`; night: hemisphere sky `0x6f86c6`, ground `0x2a2622`, intensity `1.4`, sun reused as moonlight (colour `0xa8bcff`, intensity `0.9`, no shadows). Sun casts shadows: map `2048×2048`, bias `-0.0005`, shadow camera fitted to the model's bounding box. Model meshes `castShadow = receiveShadow = true`. Without a model, night: hemisphere `0.6`, sun `0`.
- With a model: no room floor fills, no cut-away walls; room outlines and room labels only in edit mode.
- Camera with a model in 3D: direction `normalize(0.42, 0.616, 0.69)` (about 38° elevation, from the south-south-east). Transitions between views: 400 ms ease-in-out tween of camera position and orbit target; the very first framing is instant.
- Markers: single floor view shows only that floor's markers (as today). In "All", markers not on the top floor (highest elevation among floors) get class `fp-faded` (opacity 0.3). Over a model, marker dots are 22 px with 85 % opaque background (stage class `has-model`).
- Day/Night: toolbar toggle button (☀ / ☾), default day, per card instance (not saved).
- Code style: 2-space indent, single quotes, semicolons; commit trailers as separate `-m` paragraphs.

## Review Focus

1. **A plan without a model must look and behave exactly as before** (tone mapping, lights, fills, labels, walls, camera direction). → Task 2 unit-level check of `setLook(false)` state; Task 3 headless "no model unchanged".
2. **Legacy model (`floor:` names) keeps the cut**, tagged model does not. → Task 3 headless both cases.
3. **Stacked visibility with a basement and an upper floor**: selecting the ground floor shows basement + ground, hides first floor; selecting the first floor shows all three storeys; roof only in All. → Task 1 unit tests.
4. **Toggling edit mode with a model** shows outlines/labels and hides them again; no fills ever over the model. → Task 3 headless.
5. **Shadows performance:** shadows only with a model; sun shadow camera bounded to the model (not 1 km). → Task 2 check of shadow camera extents in headless.

---

### Task 1: Visibility rules (pure) and the "only" mode

**Files:**

- Modify: `src/bindings.js` (SHOW list, `resolveLevels` exterior default, `levelFloorOverrides` accepts `only`; add exported `levelVisible`)
- Modify: `src/view.js` (remove its own `levelVisible` export; import from bindings; callers pass an elevation lookup)
- Modify: `src/edit-mode.js` (level select gets an "only on <floor>" option per floor)
- Test: `test/bindings.test.js`, `test/view-model.test.js` (move `levelVisible` tests into bindings tests)

**Interfaces:**

- Produces: `levelVisible(assign: {show, floor} | undefined, visibleFloor: string, elevationOf: (floorId) => number | undefined): boolean`
  - `undefined` assign → `true`; `hidden` → false; `always` → true; `all-only` → `visibleFloor === 'all'`; `only` → `visibleFloor === 'all' || visibleFloor === assign.floor`; `with` → `visibleFloor === 'all' || visibleFloor === assign.floor || (elev(assign.floor) !== undefined && elev(visibleFloor) !== undefined && elev(assign.floor) < elev(visibleFloor))`.
- `resolveLevels`: exterior default becomes `{ show: 'always', floor: groundFloor, auto: true }` (floor kept so its zones produce rooms); `null` groundFloor → `{ show: 'always', floor: null, auto: true }`. Saved `{ show: 'only', floor }` accepted like `with` (floor must exist, else stale fallback).
- `levelFloorOverrides`: treat `only` like `with`.
- Edit-mode level select values: `floor:<id>` (label `with <Floor name> and floors above`), `only:<id>` (label `only on <Floor name>`), `always`, `all-only`, `hidden`, `auto`; saving `only:<id>` stores `{ show: 'only', floor: id }`; the selected value for a resolved `{show:'only', floor}` is `only:<floor>`.

- [ ] **Step 1: Write failing tests** in `test/bindings.test.js`:

```js
import { levelVisible } from '../src/bindings.js';

describe('levelVisible (stacking)', () => {
  const elev = (id) => ({ basement: -3, ground: 0, first: 3 })[id];
  const w = (floor) => ({ show: 'with', floor });
  it('shows a storey on its floor and on floors above', () => {
    expect(levelVisible(w('ground'), 'ground', elev)).toBe(true);
    expect(levelVisible(w('ground'), 'first', elev)).toBe(true);
    expect(levelVisible(w('first'), 'ground', elev)).toBe(false);
    expect(levelVisible(w('basement'), 'ground', elev)).toBe(true);
    expect(levelVisible(w('first'), 'all', elev)).toBe(true);
  });
  it('only / always / all-only / hidden / unknown', () => {
    expect(levelVisible({ show: 'only', floor: 'ground' }, 'first', elev)).toBe(false);
    expect(levelVisible({ show: 'only', floor: 'ground' }, 'ground', elev)).toBe(true);
    expect(levelVisible({ show: 'always', floor: 'ground' }, 'basement', elev)).toBe(true);
    expect(levelVisible({ show: 'all-only', floor: null }, 'first', elev)).toBe(false);
    expect(levelVisible({ show: 'all-only', floor: null }, 'all', elev)).toBe(true);
    expect(levelVisible({ show: 'hidden', floor: 'ground' }, 'all', elev)).toBe(false);
    expect(levelVisible(undefined, 'ground', elev)).toBe(true);
  });
  it('falls back to equality when elevations are unknown', () => {
    expect(levelVisible(w('x'), 'y', () => undefined)).toBe(false);
    expect(levelVisible(w('x'), 'x', () => undefined)).toBe(true);
  });
});
```

Also update the existing `resolveLevels` expectations: exterior now `{ show: 'always', floor: <ground floor> }` (the "matches exact ids…" test: `r.exterior` → `toMatchObject({ show: 'always', floor: 'floor1' })`), and add: saved `{ show: 'only', floor: 'floor2' }` resolves to `{ show: 'only', floor: 'floor2', auto: false }`; saved `{ show: 'only', floor: 'gone' }` → stale default. In `levelFloorOverrides` add a case with `show: 'only'` producing an override.

- [ ] **Step 2: Run** `npx vitest run test/bindings.test.js` → FAIL (levelVisible not exported from bindings; exterior expectation).
- [ ] **Step 3: Implement** in `src/bindings.js` (SHOW gains `'only'`; in the saved-binding branch treat `only` like `with` but keep `show: 'only'`; exterior default as above; `levelFloorOverrides` condition `a.show !== 'with' && a.show !== 'only'`; add `levelVisible` as specified). In `src/view.js` delete the local `levelVisible`, `import { levelVisible } from './bindings.js'`, and in `_applyFloorVisibility` call `levelVisible(assign[l.id], this.visibleFloor, (id) => this.floors.find((f) => f.id === id)?.elevation)`. Move the old view-model `levelVisible` tests out of `test/view-model.test.js` (keep `fallbackOutline` tests).
- [ ] **Step 4: Edit-mode select** in `_modelBindingsHtml` (src/edit-mode.js): build options `auto`, then per floor `floor:<id>` ("with <name> and floors above") and `only:<id>` ("only on <name>"), then `always`, `all-only`, `hidden`; selected value: `a.auto ? 'auto' : a.show === 'with' ? 'floor:' + a.floor : a.show === 'only' ? 'only:' + a.floor : a.show`. In `_onPanelChange` `md-level`: `only:<id>` → `{ show: 'only', floor: id }`.
- [ ] **Step 5: Run** `npx vitest run`, `npx eslint .`, `npm run build` → green (headless scripts are updated in Task 3; don't run them).
- [ ] **Step 6: Commit** `Level visibility: stack lower storeys, exterior always, "only on its floor" mode`.

---

### Task 2: Model look in the view

**Files:**

- Modify: `src/view.js`

**Interfaces:**

- Consumes: Task 1 `levelVisible`.
- Produces on `FloorplanView`:
  - `setDaylight(day: boolean)` and `this.daylight` (default `true`)
  - `_applyLook()` (private): applies renderer/light/shadow settings for `!!this.model` and `this.daylight`; called from `setModel` onLoad (after the model is added), `_disposeModel`, `setTheme`, `setDaylight`
  - `setStructure(floors, rooms, { wallHeight = 1.0, walls = true, fills = true, outlines = true, labels = true } = {})`: `fills=false` skips room floor meshes; `outlines=false` skips the LineLoops; `labels=false` skips room label CSS2D objects
  - `fit({ model = false, instant = false } = {})`: tweens unless `instant`
  - `isTagged()` → `true` when the manifest has a level whose `source` is `'extras'` or `'name'`
  - marker fading in `_applyFloorVisibility`

- [ ] **Step 1: Pixel ratio** → `Math.min(window.devicePixelRatio || 1, 1.5)`.
- [ ] **Step 2: Keep references to the lights**: `this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2.2)`, `this.sun = new THREE.DirectionalLight(0xffffff, 1.4)` (position as today), `this.scene.add(this.sun.target)`. Set `this.daylight = true`.
- [ ] **Step 3: `_applyLook()`**:
  - With model: `renderer.toneMapping = THREE.ACESFilmicToneMapping`, `toneMappingExposure = 1.25`, `renderer.shadowMap.enabled = true`, `renderer.shadowMap.type = THREE.PCFSoftShadowMap`; `hemi.color.setHex(0xcfdcff)`, `hemi.groundColor.setHex(0x7a6248)`, `hemi.intensity = daylight ? 1.1 : 0.12`, `sun.intensity = daylight ? 2.6 : 0`, `sun.castShadow = daylight`; shadow: `sun.shadow.mapSize.set(2048, 2048)`, `sun.shadow.bias = -0.0005`; fit the shadow camera to the model: compute `Box3` of `this.modelGroup`, set `sun.target.position` to its centre, `sun.position = centre + (-0.4, 1, 0.35).normalize() * (radius * 2.5)`, orthographic shadow camera `left/right/top/bottom = ±radius*1.1`, `near = 0.5`, `far = radius * 5`, `updateProjectionMatrix()`. Traverse model meshes once on load: `castShadow = receiveShadow = true`.
  - Without model: `NoToneMapping`, exposure 1, `shadowMap.enabled = false`, `hemi.color 0xffffff`, `groundColor 0x8a8a8a`, `hemi.intensity = daylight ? 2.2 : 0.6`, `sun.intensity = daylight ? 1.4 : 0`, `sun.castShadow = false`, sun position as in the constructor.
  - Changing `shadowMap.enabled` or `toneMapping` requires `material.needsUpdate` on scene materials: traverse `this.scene` and set `needsUpdate = true` on every material. Then `this.dirty = true`.
  - Remove the `this.renderer.toneMapping = THREE.NoToneMapping;` line from `setTheme` and call `_applyLook()` there instead.
- [ ] **Step 4: Clip only for untagged models**: in `_applyFloorVisibility`, `const cut = this.visibleFloor === 'all' || this.isTagged() ? 1e6 : …(today)…`.
- [ ] **Step 5: Structure flags** in `setStructure`: honour `fills`, `outlines`, `labels` as specified (walls flag unchanged).
- [ ] **Step 6: Marker fading**: in `_applyFloorVisibility`, after visibility, `const top = this.floors.length ? this.floors.reduce((a, b) => (b.elevation > a.elevation ? b : a)).id : null;` and for each css object of kind `marker`: `c.obj.element.classList.toggle('fp-faded', this.visibleFloor === 'all' && c.floorId !== top)`.
- [ ] **Step 7: Camera**: in `fit()`, with a model loaded in 3D mode use direction `new THREE.Vector3(0.42, 0.616, 0.69).normalize()` instead of today's; compute the final position/target as today, then if `instant` or the view has never been framed (`!this._framed`) set them directly and `this._framed = true`; otherwise tween over 400 ms: store `from` (camera position + controls target) and `to`, and in the render loop (start()) advance `t = min(1, (now - t0) / 400)`, eased `t < .5 ? 4t³ : 1 - (-2t + 2)³ / 2`, lerp both, `controls.update()`, `dirty = true` until `t === 1`. Ortho (top) mode: no tween (jump), as today. A user drag during a tween cancels it (on controls `start` event set `this._tween = null`).
- [ ] **Step 8: Verify** `npx vitest run`, `npx eslint .`, `npm run build`; then a quick manual headless sanity check with `node scripts/screenshot.mjs` (no model; must still pass with no page errors).
- [ ] **Step 9: Commit** `View: model look (ACES, sun and shadows, day/night), no cut for tagged models, 3/4 camera with tween, faded markers in All`.

---

### Task 3: Card wiring, Day/Night button, headless checks, docs

**Files:**

- Modify: `src/floorplan3d-card.js` (toolbar button, structure flags, `has-model` class, rebuild on edit toggle, CSS)
- Modify: `scripts/model-check.mjs`, `scripts/edit-check.mjs` (only if needed), `README.md`, `docs/superpowers/specs/2026-10-01-model-contract-design.md` (section 2 defaults), `docs/model-builder-guide.md` (walls/ceiling rule)

**Interfaces:**

- Consumes: Task 2 view API.
- Produces: toolbar button `button.daynight` (title "Day / night", text ☀ when day, ☾ when night); `this._daylight` (default true).

- [ ] **Step 1: Structure flags**: in `_buildStructure`, pass `{ wallHeight, walls: !this._view.model, fills: !this._view.model, outlines: !this._view.model || !!this._editing, labels: !this._view.model || !!this._editing }`. In `_toggleEdit`, force a structure rebuild (`this._built.rooms = undefined; this._schedule();`).
- [ ] **Step 2: `has-model` class**: after a model load result (in `_loadModel` `.then`) and in `_buildStructure`, `this._stage.classList.toggle('has-model', !!this._view.model)`. CSS: `.has-model .fp-dot { width: 22px; height: 22px; --mdc-icon-size: 14px; background: color-mix(in srgb, var(--card-background-color, #fff) 85%, transparent); }` and `.fp-marker.fp-faded { opacity: .3; }`.
- [ ] **Step 3: Day/Night button** next to the 3D/Top segment: `<button class="daynight" title="Day / night">☀</button>`; click → `this._daylight = !this._daylight; this._view.setDaylight(this._daylight); btn.textContent = this._daylight ? '☀' : '☾'`. Show it only when a model is loaded (`hidden` otherwise; update in `_syncToolbar` and after model load). Style like `button.edit`.
- [ ] **Step 4: First framing instant**: the card's first `fit()` calls (`_resize` first fit and first-load fit) pass `{ instant: true }`; floor/mode changes use the default tween.
- [ ] **Step 5: Headless checks** in `scripts/model-check.mjs`:
  - update existing expectations: exterior → `always:ground`;
  - tagged demo model: on floor `ground`: `level0` visible, `level1` hidden, `exterior` visible, `roof` hidden; on floor `first`: `level0` and `level1` visible, roof hidden; on `all`: all visible; `modelClip.constant > 1000` on a single floor;
  - legacy model (existing legacy case): `modelClip.constant` equals ground elevation + wall height (1) on the ground floor;
  - with a model: `renderer.toneMapping === THREE.ACESFilmicToneMapping` (compare to the constant value `4`), `renderer.shadowMap.enabled === true`, `_view.sun.shadow.camera.right < 200`, no room fill meshes (`staticGroup` contains no Mesh with `userData.roomId`), no `.fp-room-label` elements unless editing; enter edit mode → labels present; leave → gone;
  - Day/Night button: click → `_view.sun.intensity === 0` and `_view.hemi.intensity < 0.2`; click again → day values;
  - in "All": at least one marker has class `fp-faded`; on a single floor none does;
  - without a model (fresh demo page, no `?model`): `toneMapping === 0` (NoToneMapping), `shadowMap.enabled === false`, room labels present, `button.daynight` hidden;
  - `renderer.getPixelRatio() <= 1.5`.
  - Save screenshots `screenshots/look-day.png`, `screenshots/look-night.png` (demo model, 3D, ground floor).
- [ ] **Step 6: Real-model screenshots** (do not commit them; they're for the controller): if `<path to your house.glb>` exists, add an optional block at the end of `scripts/model-check.mjs` that only runs when the env var `REAL_MODEL` is set to a path: upload it, select each floor chip and save `screenshots/real-<floor>-day.png` plus one night shot. Run it once with `REAL_MODEL=<path to your house.glb>`.
- [ ] **Step 7: Docs**:
  - spec section 2: replace the level default text with the Global Constraints' modes and defaults (stacking `with`, `only`, exterior `always`, roof `all-only`) and add "Tagged models are never cut; legacy models keep the cut at wall height."
  - guide: under Structure rules add "Walls stay at full storey height; each storey's ceiling/slab belongs to the storey above, so hiding the upper level opens the view into the rooms."
  - README: mention Day/Night and that floors stack (upper floors hidden, lower ones shown) when a model is loaded.
- [ ] **Step 8: Verify** `npx eslint .`, `npx vitest run`, `npm run build`, `node scripts/model-check.mjs`, `node scripts/edit-check.mjs`, `node scripts/screenshot.mjs`, pytest (venv at `<venv>/bin/python -m pytest -q`).
- [ ] **Step 9: Commit** `Card: day/night toggle, model-aware structure and markers, headless checks, docs`.
