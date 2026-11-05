# Views and rooms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The floor buttons become views owned by the house model (any number, linked to HA floors), each with per-element show/hide choices (tree + click in 3D), a saved camera, devices that follow visible rooms, no metres to type, rooms picked from the model, and room labels with sizes.

**Architecture:** Three new pure modules carry the logic: `src/views.js` (selectors, node index, view sources and merging, visibility resolution, device-in-view state), `src/outline.js` (room outline from a mesh's top faces) and helpers in `src/bindings.js`/`src/layout.js` (measured elevations, room labels). `src/view.js` gets small, generic hooks (visible floor set, apply node visibility, marker states, cut height, camera get/set, mesh triangles). The card resolves views and drives the view; `src/edit-mode.js` gets a Views tab and a Pick flow.

**Tech Stack:** Vanilla JS, Three.js 0.169, vitest, puppeteer-core headless checks.

**Spec:** `docs/superpowers/specs/2026-10-02-views-and-rooms-design.md` (with `docs/model-builder-guide.md`, `docs/prototype-findings.md`).

## Global Constraints

- Views source order: model `views` (root `extras.fp.views`) → generated (one per `storey`/`basement` level + `all`) when the model has none → without a model: one view per HA floor + `all` (today's behaviour, unchanged).
- View fields: `id`, `label`, `rules` (ordered `{show: selector}` / `{hide: selector}`), `camera` (`{position:[x,y,z], target:[x,y,z]}` world), `floors` (linked HA floor ids), `cut` (untagged models only), plus layout-only `hidden`, `added`.
- Override order: model/generated → `layout.views[id]` (label, cut, camera, floors, hidden replace; rules appended) → card YAML `views[id]` (same, rules appended last).
- Selectors: `all`, `level:<id>`, `role:<storey|basement|exterior|roof>`, `room:<id>`, `zone:<id>`, `object:<id>`, `type:<t>`, `group:<g>`, `layer:<name>`, `node:<path>` (`*` one segment, `**` any). Unknown kinds → ignored.
- Model view `{show, hide}` → rules: if `show` non-empty: `[{hide:'all'}, ...show→{show}, ...hide→{hide}]`, else `hide→{hide}`.
- Resolution per node: last rule matching the node itself decides; else inherit parent's resolved value (root default visible); effective three.js `visible` = own resolved OR any descendant resolved visible.
- Primary level of a view = highest-order `storey`/`basement` level whose node is effectively visible. Default `floors` = `[floor of primary level]` (or `[]`).
- Device in view: area linked to a model room/zone → shown iff that room's node is effectively visible; faded iff shown and its level is a storey/basement with lower order than the primary level; otherwise (drawn room, pin, no room) → shown iff the marker's floor is in the view's floors (`all` view: always); never faded.
- Untagged model = no level with tag source `extras`/`name`. `cut` default `true` for untagged, ignored for tagged. Cut height = max elevation of the view's floors + max(wallHeight, 0.3); `all` view or no floors → no cut.
- Measured elevations (levels without `fp.elevation`): storeys/basements sorted by `order` then `minY`; the lowest storey (not basement) with `minY <= 0.5` → elevation 0; every other → `round(minY / 0.05) * 0.05`; height = next storey's elevation − own, top storey 2.7.
- Room labels: `room_labels: name | size | none` (default `size`): rectangle (4 points, axis-aligned within 0.01) → `"<name> · <w> × <h> m"` (one decimal); else `"<name> · <area> m²"` (one decimal).
- Pick outline: top triangles (world normal within 25° of up) whose centroid height is within 0.05 m of the hit; boundary edges used once; loops; pick the smallest loop containing the hit; drop collinear points (0.02 m); snap 0.05 m; fewer than 3 points → `null`.
- No model: everything behaves exactly as v0.2.1.
- Version → `0.3.0` (package.json, integration manifest, `VERSION`).
- Code style: 2-space indent, single quotes, semicolons; commits with trailers as separate `-m` paragraphs.

## Review Focus

1. **User's current untagged legacy model** (`floor:ground`, `floor:attic`, `roof`, `site`, one HA floor): generated views Ground/Attic/All appear, cut defaults on, hiding the ceiling group by node path works. → Task 2 unit test "legacy generated views"; Task 8 headless legacy case.
2. **A model view hides a level that holds rooms with devices** → those devices disappear from that view and reappear in others. → Task 2 unit test "device follows visible room"; Task 8 headless.
3. **Re-export changes node paths** (untagged `node:` rules no longer match) → rules kept and shown "not in this model", no crash. → Task 1 unit test "unmatched selectors"; Task 6 UI greying.
4. **No model loaded** → chips, markers, floors, labels exactly as before. → Task 5 headless "no model unchanged" (existing checks keep passing).
5. **Pick on a merged mesh spanning several rooms** → outline shown for confirmation, "Draw instead" cancels. → Task 3 unit test "two separate slabs pick the containing loop"; Task 7 headless confirm/cancel.

---

## File Structure

| File                                                                                                                                      | Responsibility                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/views.js` (new)                                                                                                                      | selectors, node index, view sources/merge, visibility resolution, primary level, default floors, device-in-view state, legacy show-mode migration |
| `src/outline.js` (new)                                                                                                                    | outline polygon from triangles (pure)                                                                                                             |
| `src/manifest.js` (modify)                                                                                                                | read root `fp.views` (validated) into `manifest.views`                                                                                            |
| `src/bindings.js` (modify)                                                                                                                | `measuredElevations(levels)`                                                                                                                      |
| `src/layout.js` (modify)                                                                                                                  | `roomLabel(name, polygon, mode)`                                                                                                                  |
| `src/view.js` (modify)                                                                                                                    | visible floor set, `applyModelVisibility`, `setMarkerStates`, `setCut`, `getCamera`/`setCamera`, `meshTriangles`, `pickModel` returns hit         |
| `src/floorplan3d-card.js` (modify)                                                                                                        | resolve views, chips from views, `_setView`, markers state, cameras, labels, YAML `views`, `room_labels`                                          |
| `src/edit-mode.js` (modify)                                                                                                               | Views tab, click-in-3D menu, Model tab "belongs to floor", Rooms tab Pick + Advanced floors                                                       |
| `scripts/make-demo-model.mjs`, `demo/house.glb`, `scripts/model-check.mjs`                                                                | demo model with views/layers, headless checks                                                                                                     |
| `docs/model-builder-guide.md`, `README.md`                                                                                                | views/layers/ceilings/room-floor rules, usage                                                                                                     |
| tests: `test/views.test.js`, `test/outline.test.js`, additions to `test/manifest.test.js`, `test/bindings.test.js`, `test/layout.test.js` | unit tests                                                                                                                                        |

---

### Task 1: Manifest views and the selector engine

**Files:**

- Modify: `src/manifest.js` (inside `buildManifest`, after `tops` is computed)
- Create: `src/views.js` (selectors + node index + resolution)
- Test: `test/manifest.test.js` (add), `test/views.test.js` (new)

**Interfaces:**

- Produces:
  - `manifest.views: Array<{ id, label, show: string[], hide: string[], camera: {position:[n,n,n], target:[n,n,n]} | null }>` (invalid entries dropped with a warning)
  - `parseSelector(s: string): { kind: string, value: string | null } | null`
  - `nodeIndex(adapter, manifest): { nodes: NodeInfo[] }` where `NodeInfo = { node, parent: number, children: number[], path: string, name: string, layers: string[], tag: { kind, id, role, type, group } | null, levelId: string | null }` (index 0.. in depth-first order; roots have `parent: -1`)
  - `matches(sel, info): boolean`
  - `resolveVisibility(index, rules, defaultVisible = true): boolean[]` — effective visible flag per node
  - `unmatchedSelectors(index, rules): string[]`

- [ ] **Step 1: Failing tests**

`test/manifest.test.js` (append):

```js
describe('manifest views', () => {
  it('reads valid root views and drops invalid ones', () => {
    const root = { name: 'Scene', extras: { fp: { views: [
      { id: 'ground', label: 'Ground floor', show: ['level:ground'], hide: ['role:roof'], camera: { position: [1, 2, 3], target: [0, 0, 0] } },
      { id: 'Bad Id', label: 'x' },
      { id: 'all', show: 'oops' },
    ] } }, children: [{ name: 'ground', extras: fp({ kind: 'level', id: 'ground' }) }] };
    const m = buildManifest(tree([root]));
    expect(m.views).toEqual([
      { id: 'ground', label: 'Ground floor', show: ['level:ground'], hide: ['role:roof'], camera: { position: [1, 2, 3], target: [0, 0, 0] } },
      { id: 'all', label: 'all', show: [], hide: [], camera: null },
    ]);
    expect(m.warnings.join('\n')).toMatch(/view "Bad Id": invalid id/);
  });
  it('has no views by default', () => {
    expect(buildManifest(tree([{ name: 'floor:ground' }])).views).toEqual([]);
  });
});
```

(Use the existing `tree` and `fp` helpers in that file. `show`/`hide` that are not arrays of strings become `[]`; a `camera` without two 3-number arrays becomes `null`.)

`test/views.test.js` (new):

```js
import { describe, it, expect } from 'vitest';
import { parseSelector, nodeIndex, matches, resolveVisibility, unmatchedSelectors } from '../src/views.js';
import { buildManifest } from '../src/manifest.js';

const tree = (roots) => {
  const parent = new Map();
  const walk = (n) => (n.children || []).forEach((c) => { parent.set(c, n); walk(c); });
  roots.forEach(walk);
  return { roots: () => roots, children: (n) => n.children || [], name: (n) => n.name || '', extras: (n) => n.extras || {}, parent: (n) => parent.get(n) || null };
};
const fp = (o) => ({ fp: o });
const sq = [[0, 0], [4, 0], [4, 3]];
const lamp = { name: 'lamp', extras: fp({ kind: 'object', id: 'l1', type: 'light', group: 'facade' }) };
const sofa = { name: 'Sofa', extras: fp({ layer: 'furniture' }) };
const kitchen = { name: 'kitchen', extras: fp({ kind: 'room', id: 'kitchen', outline: sq }), children: [sofa, { name: 'slab' }] };
const ceiling = { name: 'Ceiling', extras: fp({ layer: ['ceiling'] }) };
const ground = { name: 'ground', extras: fp({ kind: 'level', id: 'ground', order: 0 }), children: [kitchen, lamp] };
const attic = { name: 'attic', extras: fp({ kind: 'level', id: 'attic', order: 1 }), children: [ceiling] };
const ext = { name: 'exterior', extras: fp({ kind: 'level', id: 'exterior', role: 'exterior' }), children: [{ name: 'lawn', extras: fp({ kind: 'zone', id: 'lawn', outline: sq }) }] };
const roof = { name: 'roof' };
const adapter = tree([ground, attic, ext, roof]);
const idx = nodeIndex(adapter, buildManifest(adapter));
const at = (name) => idx.nodes.findIndex((n) => n.name === name);

describe('parseSelector', () => {
  it('parses known kinds', () => {
    expect(parseSelector('all')).toEqual({ kind: 'all', value: null });
    expect(parseSelector('level:ground')).toEqual({ kind: 'level', value: 'ground' });
    expect(parseSelector('node:ground/**/Sofa')).toEqual({ kind: 'node', value: 'ground/**/Sofa' });
    expect(parseSelector('nope:x')).toBeNull();
    expect(parseSelector('')).toBeNull();
  });
});

describe('nodeIndex / matches', () => {
  it('indexes tags, layers, paths and levels', () => {
    const k = idx.nodes[at('kitchen')];
    expect(k).toMatchObject({ path: 'ground/kitchen', levelId: 'ground', tag: { kind: 'room', id: 'kitchen' } });
    expect(idx.nodes[at('Sofa')].layers).toEqual(['furniture']);
    expect(idx.nodes[at('Ceiling')].layers).toEqual(['ceiling']);
    expect(idx.nodes[at('roof')].tag).toMatchObject({ kind: 'level', id: 'roof', role: 'roof' });
  });
  it('matches every selector kind', () => {
    const m = (s, name) => matches(parseSelector(s), idx.nodes[at(name)]);
    expect(m('level:ground', 'ground')).toBe(true);
    expect(m('role:exterior', 'exterior')).toBe(true);
    expect(m('room:kitchen', 'kitchen')).toBe(true);
    expect(m('zone:lawn', 'lawn')).toBe(true);
    expect(m('object:l1', 'lamp')).toBe(true);
    expect(m('type:light', 'lamp')).toBe(true);
    expect(m('group:facade', 'lamp')).toBe(true);
    expect(m('layer:furniture', 'Sofa')).toBe(true);
    expect(m('node:ground/kitchen/Sofa', 'Sofa')).toBe(true);
    expect(m('node:ground/*/Sofa', 'Sofa')).toBe(true);
    expect(m('node:**/Sofa', 'Sofa')).toBe(true);
    expect(m('node:ground/*', 'Sofa')).toBe(false);
    expect(m('all', 'roof')).toBe(true);
    expect(m('room:kitchen', 'Sofa')).toBe(false); // selectors match the node itself, not descendants
  });
});

describe('resolveVisibility', () => {
  const vis = (rules) => { const v = resolveVisibility(idx, rules); return (name) => v[at(name)]; };
  it('defaults to visible and inherits', () => {
    const v = vis([]);
    expect(v('Sofa')).toBe(true);
  });
  it('last matching rule wins; children inherit', () => {
    const v = vis([{ hide: 'level:attic' }, { hide: 'role:roof' }]);
    expect([v('ground'), v('attic'), v('Ceiling'), v('roof')]).toEqual([true, false, false, false]);
    expect(vis([{ hide: 'level:attic' }, { show: 'level:attic' }])('attic')).toBe(true);
  });
  it('a shown descendant keeps its ancestors visible but not its siblings', () => {
    const v = vis([{ hide: 'level:ground' }, { show: 'room:kitchen' }]);
    expect([v('ground'), v('kitchen'), v('slab'), v('lamp')]).toEqual([true, true, true, false]);
  });
  it('hide all + show list (model views)', () => {
    const v = vis([{ hide: 'all' }, { show: 'level:ground' }, { show: 'role:exterior' }]);
    expect([v('ground'), v('kitchen'), v('attic'), v('lawn'), v('roof')]).toEqual([true, true, false, true, false]);
  });
  it('layer rules reach nested nodes', () => {
    expect(vis([{ hide: 'layer:furniture' }])('Sofa')).toBe(false);
  });
  it('reports selectors that match nothing', () => {
    expect(unmatchedSelectors(idx, [{ hide: 'node:old/path' }, { hide: 'level:ground' }, { hide: 'bad' }])).toEqual(['node:old/path', 'bad']);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/manifest.test.js test/views.test.js` → FAIL (no `views`, module missing).

- [ ] **Step 3: Implement**

In `src/manifest.js`, add `m.views = []` to the result object and, right after `tops` is decided (before walking), read views from the single untagged wrapper or, if none, from the first root that carries `extras.fp.views`:

```js
  const viewHolder = adapter.roots().find((r) => { const e = adapter.extras(r); return e && e.fp && Array.isArray(e.fp.views); });
  const isNum3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
  for (const v of viewHolder ? adapter.extras(viewHolder).fp.views : []) {
    if (!v || typeof v.id !== 'string' || !ID_RE.test(v.id)) { m.warnings.push(`view "${v && v.id}": invalid id`); continue; }
    if (m.views.some((x) => x.id === v.id)) { m.warnings.push(`view "${v.id}": duplicate id`); continue; }
    const cam = v.camera && isNum3(v.camera.position) && isNum3(v.camera.target) ? { position: v.camera.position, target: v.camera.target } : null;
    m.views.push({ id: v.id, label: typeof v.label === 'string' ? v.label : v.id, show: strs(v.show), hide: strs(v.hide), camera: cam });
  }
```

Note: a root holding only `views` (no `kind`) is not a level; `readTag` returns `{...fp, source:'extras'}` for any object `fp`, so make `buildManifest` treat an `fp` without `kind` as "no tag" (layer-only nodes like `{ layer: 'furniture' }` must not become errors): in the walk, `if (tag && tag.kind === undefined) tag = null;` before `add(...)`. Add a manifest test: `{ name:'Sofa', extras: fp({ layer:'furniture' }) }` produces no errors.

Create `src/views.js`:

```js
// Views: what each floor button shows. Pure: works on a node index built through the same adapter
// as the manifest, so it is testable without three.js.

const KINDS = ['all', 'level', 'role', 'room', 'zone', 'object', 'type', 'group', 'layer', 'node'];

export function parseSelector(s) {
  if (typeof s !== 'string' || !s) return null;
  if (s === 'all') return { kind: 'all', value: null };
  const i = s.indexOf(':');
  if (i < 1) return null;
  const kind = s.slice(0, i), value = s.slice(i + 1);
  return KINDS.includes(kind) && value ? { kind, value } : null;
}

function globRe(pattern) {
  const esc = (t) => t.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const body = pattern.split('/').map((seg) => (seg === '**' ? '.*' : esc(seg).replace(/\*/g, '[^/]*'))).join('/')
    .replace(/\.\*\//g, '(?:.*/)?');
  return new RegExp('^' + body + '$');
}

export function nodeIndex(adapter, manifest) {
  const nodes = [];
  const walk = (node, parent, parentPath, levelId) => {
    const name = adapter.name(node);
    const path = parentPath ? `${parentPath}/${name}` : name;
    const entry = manifest.byNode.get(node) || null;
    const fp = (adapter.extras(node) || {}).fp || {};
    const layers = Array.isArray(fp.layer) ? fp.layer.filter((x) => typeof x === 'string') : typeof fp.layer === 'string' ? [fp.layer] : [];
    const tag = entry ? { kind: entry.kind, id: entry.id, role: entry.role || null, type: entry.type || null, group: entry.group || null } : null;
    const lvl = entry && entry.kind === 'level' ? entry.id : levelId;
    const i = nodes.length;
    nodes.push({ node, parent, children: [], path, name, layers, tag, levelId: lvl });
    if (parent >= 0) nodes[parent].children.push(i);
    for (const c of adapter.children(node)) walk(c, i, path, lvl);
  };
  for (const r of adapter.roots()) walk(r, -1, '', null);
  return { nodes };
}

export function matches(sel, info) {
  if (!sel) return false;
  const t = info.tag;
  switch (sel.kind) {
    case 'all': return true;
    case 'level': return !!t && t.kind === 'level' && t.id === sel.value;
    case 'role': return !!t && t.kind === 'level' && t.role === sel.value;
    case 'room': return !!t && t.kind === 'room' && t.id === sel.value;
    case 'zone': return !!t && t.kind === 'zone' && t.id === sel.value;
    case 'object': return !!t && t.kind === 'object' && t.id === sel.value;
    case 'type': return !!t && t.kind === 'object' && t.type === sel.value;
    case 'group': return !!t && t.kind === 'object' && t.group === sel.value;
    case 'layer': return info.layers.includes(sel.value);
    case 'node': return globRe(sel.value).test(info.path);
    default: return false;
  }
}

const ruleSel = (r) => parseSelector(r && (r.show ?? r.hide));

export function resolveVisibility(index, rules, defaultVisible = true) {
  const parsed = (rules || []).map((r) => ({ sel: ruleSel(r), show: r && r.show !== undefined }));
  const own = index.nodes.map((info) => {
    let v;
    for (const r of parsed) if (r.sel && matches(r.sel, info)) v = r.show;
    return v;
  });
  const resolved = new Array(index.nodes.length);
  index.nodes.forEach((info, i) => {
    const inherited = info.parent >= 0 ? resolved[info.parent] : defaultVisible;
    resolved[i] = own[i] !== undefined ? own[i] : inherited;
  });
  // a visible descendant keeps its ancestors on (their other children still use their own value)
  const effective = resolved.slice();
  for (let i = index.nodes.length - 1; i >= 0; i--) {
    if (effective[i]) for (let p = index.nodes[i].parent; p >= 0 && !effective[p]; p = index.nodes[p].parent) effective[p] = true;
  }
  return effective;
}

export function unmatchedSelectors(index, rules) {
  const out = [];
  for (const r of rules || []) {
    const s = r && (r.show ?? r.hide);
    const sel = parseSelector(s);
    if (!sel || !index.nodes.some((n) => matches(sel, n))) out.push(s);
  }
  return [...new Set(out)];
}
```

- [ ] **Step 4: Run** `npx vitest run test/manifest.test.js test/views.test.js` → PASS; then `npx vitest run`, `npx eslint .`.
- [ ] **Step 5: Commit** `Views engine: model views in the manifest, selectors, node index, visibility resolution`.

---

### Task 2: View sources, merging, primary level, devices in view, measured elevations

**Files:**

- Modify: `src/views.js`, `src/bindings.js` (`measuredElevations`)
- Test: `test/views.test.js`, `test/bindings.test.js`

**Interfaces:**

- Consumes: Task 1 (`nodeIndex`, `resolveVisibility`, `parseSelector`), manifest levels (`id, label, role, order, minY?`).
- Produces:
  - `modelViewRules(v: {show, hide}): Rule[]`
  - `generatedViews(levels): View[]` — storeys/basements sorted by order (then minY): `{ id: level.id, label: level.label, rules: [{hide:'all'}, ...{show:'level:<lower or same>'}, {show:'role:exterior'}] }` plus `{ id: 'all', label: 'All', rules: [] }`
  - `migrateShowModes(savedLevels): { all: Rule[], floorViews: Rule[] }` — `hidden` → `{hide:'level:id'}` in all; `always` → `{show:'level:id'}` in all; `all-only` → `{hide:'level:id'}` in floor views (not `all`); `only` → ignored (stacking views already handle it)
  - `resolveViews({ manifest, haFloors, layoutViews, yamlViews, savedLevels }): View[]` where `View = { id, label, rules, camera, floors: string[] | null, cut: boolean | null, source: 'model'|'generated'|'floors'|'added', hidden: boolean }` (floors `null` = use default)
  - `primaryLevel(index, effective, levels): string | null`
  - `defaultFloors(primaryLevelId, levelFloor: Record<levelId, floorId|null>): string[]`
  - `markerState({ roomId, roomLevelId, markerFloorId }, ctx: { visibleRooms: Set<roomId>, primaryOrder: number|null, levelOrder: Record<levelId, number>, viewFloors: Set<floorId>, isAll: boolean }): { shown: boolean, faded: boolean }`
  - `measuredElevations(levels): Record<levelId, { elevation, height }>` (in `src/bindings.js`)

- [ ] **Step 1: Failing tests** (append to `test/views.test.js`):

```js
import { modelViewRules, generatedViews, migrateShowModes, resolveViews, primaryLevel, defaultFloors, markerState } from '../src/views.js';

describe('view sources', () => {
  const levels = [
    { id: 'attic', label: 'Attic', role: 'storey', order: 1 },
    { id: 'ground', label: 'Ground floor', role: 'storey', order: 0 },
    { id: 'exterior', label: 'Exterior', role: 'exterior', order: null },
    { id: 'roof', label: 'roof', role: 'roof', order: null },
  ];
  it('model view {show, hide} → rules', () => {
    expect(modelViewRules({ show: ['level:ground'], hide: ['role:roof'] })).toEqual([{ hide: 'all' }, { show: 'level:ground' }, { hide: 'role:roof' }]);
    expect(modelViewRules({ show: [], hide: ['role:roof'] })).toEqual([{ hide: 'role:roof' }]);
  });
  it('generated views stack storeys and keep the exterior (legacy generated views)', () => {
    expect(generatedViews(levels)).toEqual([
      { id: 'ground', label: 'Ground floor', rules: [{ hide: 'all' }, { show: 'level:ground' }, { show: 'role:exterior' }] },
      { id: 'attic', label: 'Attic', rules: [{ hide: 'all' }, { show: 'level:ground' }, { show: 'level:attic' }, { show: 'role:exterior' }] },
      { id: 'all', label: 'All', rules: [] },
    ]);
  });
  it('migrates legacy level show modes', () => {
    expect(migrateShowModes({ roof: { show: 'hidden' }, attic: { show: 'all-only' }, site: { show: 'always' }, ground: { floor: 'f' } }))
      .toEqual({ all: [{ hide: 'level:roof' }, { show: 'level:site' }], floorViews: [{ hide: 'level:attic' }] });
  });
  it('merges model → layout → yaml, with added and hidden views', () => {
    const manifest = { levels, views: [{ id: 'ground', label: 'Ground', show: ['level:ground'], hide: [], camera: null }, { id: 'all', label: 'Everything', show: [], hide: [], camera: null }] };
    const v = resolveViews({
      manifest, haFloors: [{ id: 'floor1', name: 'Floor1' }],
      layoutViews: { ground: { rules: [{ hide: 'layer:ceiling' }], camera: { position: [1, 1, 1], target: [0, 0, 0] }, floors: ['floor1'] }, all: { hidden: true }, night: { added: true, label: 'Night', rules: [{ show: 'role:exterior' }] } },
      yamlViews: { ground: { label: 'GF', rules: [{ hide: 'type:light' }] } },
      savedLevels: {},
    });
    expect(v.map((x) => [x.id, x.label, x.source, x.hidden])).toEqual([['ground', 'GF', 'model', false], ['all', 'Everything', 'model', true], ['night', 'Night', 'added', false]]);
    expect(v[0].rules).toEqual([{ hide: 'all' }, { show: 'level:ground' }, { hide: 'layer:ceiling' }, { hide: 'type:light' }]);
    expect(v[0].floors).toEqual(['floor1']);
    expect(v[0].camera).toEqual({ position: [1, 1, 1], target: [0, 0, 0] });
  });
  it('without a model: one view per HA floor plus all', () => {
    const v = resolveViews({ manifest: null, haFloors: [{ id: 'f1', name: 'F1' }, { id: 'f2', name: 'F2' }], layoutViews: {}, yamlViews: {}, savedLevels: {} });
    expect(v.map((x) => [x.id, x.label, x.source, x.floors])).toEqual([['f1', 'F1', 'floors', ['f1']], ['f2', 'F2', 'floors', ['f2']], ['all', 'All', 'floors', null]]);
  });
  it('generated views get migrated show-mode rules', () => {
    const v = resolveViews({ manifest: { levels, views: [] }, haFloors: [], layoutViews: {}, yamlViews: {}, savedLevels: { attic: { show: 'all-only' } } });
    expect(v.find((x) => x.id === 'ground').rules.at(-1)).toEqual({ hide: 'level:attic' });
    expect(v.find((x) => x.id === 'all').rules).toEqual([]);
  });
});

describe('primary level, floors, devices', () => {
  const lv = [{ id: 'ground', role: 'storey', order: 0 }, { id: 'attic', role: 'storey', order: 1 }, { id: 'exterior', role: 'exterior', order: null }];
  it('primary = highest visible storey; default floors follow it', () => {
    const v = resolveVisibility(idx, [{ hide: 'all' }, { show: 'level:ground' }, { show: 'level:attic' }]);
    expect(primaryLevel(idx, v, lv)).toBe('attic');
    expect(defaultFloors('attic', { attic: 'mansard', ground: 'floor1' })).toEqual(['mansard']);
    expect(defaultFloors(null, {})).toEqual([]);
  });
  it('device follows its visible room, fades below the primary level, falls back to linked floors', () => {
    const ctx = { visibleRooms: new Set(['kitchen', 'lawn']), primaryOrder: 1, levelOrder: { ground: 0, attic: 1 }, viewFloors: new Set(['mansard']), isAll: false };
    expect(markerState({ roomId: 'kitchen', roomLevelId: 'ground', markerFloorId: 'floor1' }, ctx)).toEqual({ shown: true, faded: true });
    expect(markerState({ roomId: 'lawn', roomLevelId: 'exterior', markerFloorId: 'floor1' }, ctx)).toEqual({ shown: true, faded: false });
    expect(markerState({ roomId: 'bath', roomLevelId: 'ground', markerFloorId: 'floor1' }, ctx)).toEqual({ shown: false, faded: false });
    expect(markerState({ roomId: null, roomLevelId: null, markerFloorId: 'mansard' }, ctx)).toEqual({ shown: true, faded: false });
    expect(markerState({ roomId: null, roomLevelId: null, markerFloorId: 'floor1' }, ctx)).toEqual({ shown: false, faded: false });
    expect(markerState({ roomId: null, roomLevelId: null, markerFloorId: 'floor1' }, { ...ctx, isAll: true })).toEqual({ shown: true, faded: false });
  });
});
```

Append to `test/bindings.test.js`:

```js
import { measuredElevations } from '../src/bindings.js';
describe('measuredElevations', () => {
  it('ground at 0, others from their lowest point, heights from the next storey', () => {
    expect(measuredElevations([
      { id: 'ground', role: 'storey', order: null, minY: -0.3, elevation: null },
      { id: 'attic', role: 'storey', order: null, minY: 2.89, elevation: null },
      { id: 'site', role: 'exterior', order: null, minY: -0.25, elevation: null },
    ])).toEqual({ ground: { elevation: 0, height: 2.9 }, attic: { elevation: 2.9, height: 2.7 } });
  });
  it('keeps tagged elevations out', () => {
    expect(measuredElevations([{ id: 'g', role: 'storey', order: 0, minY: 0, elevation: 0 }])).toEqual({});
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/views.test.js test/bindings.test.js` → FAIL.

- [ ] **Step 3: Implement** in `src/views.js`:

```js
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.minY ?? 0) - (b.minY ?? 0);
const isStorey = (l) => l.role === 'storey' || l.role === 'basement';

export function modelViewRules(v) {
  const show = (v.show || []).map((s) => ({ show: s }));
  const hide = (v.hide || []).map((s) => ({ hide: s }));
  return show.length ? [{ hide: 'all' }, ...show, ...hide] : hide;
}

export function generatedViews(levels) {
  const storeys = levels.filter(isStorey).sort(byOrder);
  const out = storeys.map((l, i) => ({
    id: l.id, label: l.label || l.id,
    rules: [{ hide: 'all' }, ...storeys.slice(0, i + 1).map((s) => ({ show: 'level:' + s.id })), { show: 'role:exterior' }],
  }));
  out.push({ id: 'all', label: 'All', rules: [] });
  return out;
}

export function migrateShowModes(savedLevels) {
  const all = [], floorViews = [];
  for (const [id, b] of Object.entries(savedLevels || {})) {
    if (!b || typeof b !== 'object') continue;
    if (b.show === 'hidden') all.push({ hide: 'level:' + id });
    else if (b.show === 'always') all.push({ show: 'level:' + id });
    else if (b.show === 'all-only') floorViews.push({ hide: 'level:' + id });
  }
  return { all, floorViews };
}

const isCam = (c) => c && Array.isArray(c.position) && Array.isArray(c.target);
const obj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});

export function resolveViews({ manifest, haFloors, layoutViews, yamlViews, savedLevels }) {
  let base;
  if (!manifest) {
    base = [...haFloors.map((f) => ({ id: f.id, label: f.name, rules: [], floors: [f.id], source: 'floors' })),
      { id: 'all', label: 'All', rules: [], floors: null, source: 'floors' }];
  } else if (manifest.views && manifest.views.length) {
    base = manifest.views.map((v) => ({ id: v.id, label: v.label, rules: modelViewRules(v), camera: v.camera, floors: null, source: 'model' }));
  } else {
    const mig = migrateShowModes(savedLevels);
    base = generatedViews(manifest.levels).map((v) => ({
      ...v, floors: null, source: 'generated',
      rules: [...v.rules, ...(v.id === 'all' ? mig.all : [...mig.all, ...mig.floorViews])],
    }));
  }
  const lv = obj(layoutViews), yv = obj(yamlViews);
  const added = Object.entries(lv).filter(([id, v]) => obj(v).added && !base.some((b) => b.id === id))
    .map(([id, v]) => ({ id, label: obj(v).label || id, rules: [], floors: null, source: 'added' }));
  return [...base, ...added].map((b) => {
    const l = obj(lv[b.id]), y = obj(yv[b.id]);
    const pick = (k, d) => (y[k] !== undefined ? y[k] : l[k] !== undefined ? l[k] : d);
    const rules = [...b.rules, ...(Array.isArray(l.rules) ? l.rules : []), ...(Array.isArray(y.rules) ? y.rules : [])];
    const camera = isCam(y.camera) ? y.camera : isCam(l.camera) ? l.camera : (b.camera || null);
    const floors = Array.isArray(y.floors) ? y.floors : Array.isArray(l.floors) ? l.floors : b.floors;
    return { id: b.id, label: pick('label', b.label), rules, camera, floors, cut: pick('cut', null), source: b.source, hidden: !!pick('hidden', false) };
  });
}

export function primaryLevel(index, effective, levels) {
  const visible = new Set(index.nodes.filter((n, i) => effective[i] && n.tag && n.tag.kind === 'level').map((n) => n.tag.id));
  const storeys = levels.filter((l) => isStorey(l) && visible.has(l.id)).sort(byOrder);
  return storeys.length ? storeys[storeys.length - 1].id : null;
}

export function defaultFloors(primaryLevelId, levelFloor) {
  const f = primaryLevelId && levelFloor[primaryLevelId];
  return f ? [f] : [];
}

export function markerState({ roomId, roomLevelId, markerFloorId }, ctx) {
  if (roomId) {
    const shown = ctx.visibleRooms.has(roomId);
    const order = ctx.levelOrder[roomLevelId];
    const faded = shown && ctx.primaryOrder !== null && order !== undefined && order < ctx.primaryOrder;
    return { shown, faded };
  }
  return { shown: ctx.isAll || ctx.viewFloors.has(markerFloorId), faded: false };
}
```

In `src/bindings.js`:

```js
// Elevation/height for levels the model did not tag with numbers, measured from their geometry.
export function measuredElevations(levels) {
  const storeys = levels.filter((l) => (l.role === 'storey' || l.role === 'basement')).slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.minY ?? 0) - (b.minY ?? 0));
  const snap = (v) => Math.round(v / 0.05) * 0.05;
  const elev = new Map();
  const ground = storeys.find((l) => l.role === 'storey' && (l.minY ?? 0) <= 0.5);
  for (const l of storeys) elev.set(l.id, l === ground ? 0 : snap(l.minY ?? 0));
  const out = {};
  storeys.forEach((l, i) => {
    if (Number.isFinite(l.elevation)) return;
    const e = Math.round(elev.get(l.id) * 1000) / 1000;
    const next = storeys[i + 1];
    out[l.id] = { elevation: e, height: next ? Math.round((elev.get(next.id) - e) * 1000) / 1000 : 2.7 };
  });
  return out;
}
```

(Rounding note: `snap(2.89)` = 2.9; the test expects `ground.height` 2.9 and `attic.elevation` 2.9.)

- [ ] **Step 4: Run** the two test files → PASS; full `npx vitest run`; `npx eslint .`.
- [ ] **Step 5: Commit** `Views: sources and overrides, generated views, legacy show-mode migration, devices follow visible rooms, measured elevations`.

---

### Task 3: Outline from mesh triangles and room labels

**Files:**

- Create: `src/outline.js`
- Modify: `src/layout.js` (`roomLabel`)
- Test: `test/outline.test.js` (new), `test/layout.test.js` (append)

**Interfaces:**

- Produces: `outlineFromTriangles(tris: number[] (x,y,z per vertex, 9 per triangle, world), hit: [x, y, z]): [x, y][] | null` (plan coords: plan x = world x, plan y = −world z); `roomLabel(name: string, polygon: [x,y][], mode: 'name'|'size'|'none'): string`.

- [ ] **Step 1: Failing tests**

`test/outline.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { outlineFromTriangles } from '../src/outline.js';
import { pointInPolygon, signedArea } from '../src/placement.js';

// a horizontal quad at height y from plan rect (x0..x1, y0..y1) → two triangles (world z = -plan y), CCW from above
const quad = (x0, y0, x1, y1, y = 0) => [x0, y, -y0, x1, y, -y0, x1, y, -y1, x0, y, -y0, x1, y, -y1, x0, y, -y1];
const wall = (x0, y0, x1) => [x0, 0, -y0, x1, 0, -y0, x1, 2.7, -y0]; // vertical triangle, ignored
const norm = (p) => p.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
const area = (p) => Math.abs(signedArea(p));

describe('outlineFromTriangles', () => {
  it('rectangle from two triangles', () => {
    const out = outlineFromTriangles([...quad(0, 0, 4, 3), ...wall(0, 0, 4)], [2, 0, -1.5]);
    expect(out).toHaveLength(4);
    expect(area(out)).toBeCloseTo(12);
  });
  it('L-shape made of quads sharing whole edges', () => {
    // vertices must coincide on shared edges; T-junctions are not traced (the pick then falls back to the rectangle)
    const out = outlineFromTriangles([...quad(0, 0, 2, 2), ...quad(2, 0, 4, 2), ...quad(0, 2, 2, 5)], [1, 0, -1]);
    expect(out).toHaveLength(6);
    expect(area(out)).toBeCloseTo(8 + 6);
  });
  it('two separate slabs: picks the loop containing the hit', () => {
    const out = outlineFromTriangles([...quad(0, 0, 4, 3), ...quad(6, 0, 9, 3)], [7, 0, -1]);
    expect(pointInPolygon([7, 1], out)).toBe(true);
    expect(area(out)).toBeCloseTo(9);
  });
  it('ignores faces at another height', () => {
    const out = outlineFromTriangles([...quad(0, 0, 4, 3, 0), ...quad(0, 0, 10, 10, 2.9)], [1, 0, -1]);
    expect(area(out)).toBeCloseTo(12);
  });
  it('snaps to 5 cm and drops collinear points', () => {
    const out = outlineFromTriangles([...quad(0, 0, 2.02, 3), ...quad(2.02, 0, 4.01, 3)], [1, 0, -1]);
    expect(norm(out).every(([x, y]) => Math.abs(x * 20 - Math.round(x * 20)) < 1e-6 && Math.abs(y * 20 - Math.round(y * 20)) < 1e-6)).toBe(true);
    expect(out).toHaveLength(4);
  });
  it('returns null when nothing is under the hit', () => {
    expect(outlineFromTriangles(quad(0, 0, 4, 3), [10, 0, -10])).toBeNull();
    expect(outlineFromTriangles([], [0, 0, 0])).toBeNull();
  });
});
```

`test/layout.test.js` (append):

```js
import { roomLabel } from '../src/layout.js';
describe('roomLabel', () => {
  it('rectangles show width × depth, others the area', () => {
    expect(roomLabel('Kitchen', [[0, 0], [2.65, 0], [2.65, 3.75], [0, 3.75]], 'size')).toBe('Kitchen · 2.7 × 3.8 m');
    expect(roomLabel('Hall', [[0, 0], [4, 0], [4, 2], [2, 2], [2, 5], [0, 5]], 'size')).toBe('Hall · 14.0 m²');
    expect(roomLabel('Hall', [[0, 0], [4, 0], [4, 2]], 'name')).toBe('Hall');
    expect(roomLabel('Hall', [[0, 0], [4, 0], [4, 2]], 'none')).toBe('');
    expect(roomLabel('', [[0, 0], [1, 0], [1, 1], [0, 1]], 'size')).toBe('1.0 × 1.0 m');
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/outline.js`:

```js
// Room outline from a mesh's upward-facing triangles at the clicked height (pick a room from the model).
import { pointInPolygon, signedArea } from './placement.js';

const COS_UP = Math.cos((25 * Math.PI) / 180);
const key = (x, z) => Math.round(x * 1000) + ',' + Math.round(z * 1000);

export function outlineFromTriangles(tris, hit) {
  const pts = new Map(); // key -> [x, z]
  const edgeCount = new Map(); // "a|b" -> count
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const a = [tris[i], tris[i + 1], tris[i + 2]], b = [tris[i + 3], tris[i + 4], tris[i + 5]], c = [tris[i + 6], tris[i + 7], tris[i + 8]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!len || Math.abs(ny / len) < COS_UP) continue;
    if (Math.abs((a[1] + b[1] + c[1]) / 3 - hit[1]) > 0.05) continue;
    const ks = [a, b, c].map((p) => { const k = key(p[0], p[2]); pts.set(k, [p[0], p[2]]); return k; });
    for (const [p, q] of [[ks[0], ks[1]], [ks[1], ks[2]], [ks[2], ks[0]]]) {
      const e = p < q ? p + '|' + q : q + '|' + p;
      edgeCount.set(e, (edgeCount.get(e) || 0) + 1);
    }
  }
  const adj = new Map();
  for (const [e, n] of edgeCount) {
    if (n !== 1) continue;
    const [p, q] = e.split('|');
    if (!adj.has(p)) adj.set(p, []);
    if (!adj.has(q)) adj.set(q, []);
    adj.get(p).push(q); adj.get(q).push(p);
  }
  const used = new Set();
  const loops = [];
  for (const start of adj.keys()) {
    if (used.has(start)) continue;
    const loop = [start]; used.add(start);
    let prev = null, cur = start;
    for (;;) {
      const next = (adj.get(cur) || []).find((n) => n !== prev && (n === start ? loop.length > 2 : !used.has(n)));
      if (!next || next === start) break;
      loop.push(next); used.add(next); prev = cur; cur = next;
    }
    if (loop.length >= 3) loops.push(loop.map((k) => { const [x, z] = pts.get(k); return [x, -z]; }));
  }
  const target = [hit[0], -hit[2]];
  const candidates = loops.filter((l) => pointInPolygon(target, l)).sort((a, b) => Math.abs(signedArea(a)) - Math.abs(signedArea(b)));
  if (!candidates.length) return null;
  const snapped = candidates[0].map(([x, y]) => [Math.round(x / 0.05) * 0.05, Math.round(y / 0.05) * 0.05].map((v) => Math.round(v * 1000) / 1000));
  const out = [];
  for (let i = 0; i < snapped.length; i++) {
    const p = out.length ? out[out.length - 1] : snapped[snapped.length - 1];
    const c = snapped[i], n = snapped[(i + 1) % snapped.length];
    if (Math.hypot(c[0] - p[0], c[1] - p[1]) < 1e-6) continue;
    const dx = n[0] - p[0], dy = n[1] - p[1], l = Math.hypot(dx, dy) || 1;
    if (Math.abs((c[0] - p[0]) * dy - (c[1] - p[1]) * dx) / l < 0.02) continue; // collinear
    out.push(c);
  }
  return out.length >= 3 ? out : null;
}
```

In `src/layout.js` (and import nothing new; `signedArea` comes from `./placement.js`, already imported there or add it):

```js
// Room label text: name plus size (bounding width × depth for rectangles, area otherwise).
export function roomLabel(name, polygon, mode = 'size') {
  if (mode === 'none') return '';
  if (mode === 'name' || !polygon || polygon.length < 3) return name || '';
  const xs = polygon.map((p) => p[0]), ys = polygon.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  const axis = polygon.length === 4 && polygon.every((p, i) => {
    const q = polygon[(i + 1) % 4];
    return Math.abs(p[0] - q[0]) < 0.01 || Math.abs(p[1] - q[1]) < 0.01;
  });
  const one = (v) => (Math.round(v * 10) / 10).toFixed(1); // toFixed alone rounds 2.65 down to 2.6
  const size = axis ? `${one(w)} × ${one(h)} m` : `${one(Math.abs(signedArea(polygon)))} m²`;
  return name ? `${name} · ${size}` : size;
}
```

- [ ] **Step 4: Run** → PASS; full suite; lint.
- [ ] **Step 5: Commit** `Pick-outline extraction from mesh triangles; room labels with size`.

---

### Task 4: View hooks in `src/view.js`

**Files:** Modify `src/view.js`. (No unit tests: WebGL; verified by Task 8 headless checks. Keep existing behaviour when the new hooks are not called.)

**Interfaces (produce):**

- `setVisibleFloors(ids: string[] | 'all')`; `setVisibleFloor(id)` becomes `setVisibleFloors(id === 'all' ? 'all' : [id])` and keeps `this.visibleFloor` (first id or `'all'`) for existing callers; `_shows(floorId)` checks the set.
- `applyModelVisibility(index, flags: boolean[] | null)`: when flags given, sets `index.nodes[i].node.visible = flags[i]` for every node and records `this._modelVisibility = { index, flags }`; `_applyFloorVisibility` then skips its `levelVisible` loop. `null` → back to level rules.
- `setMarkerStates(states: Map<markerId, {shown, faded}> | null)`: when set, marker CSS objects and their glows use `shown` instead of floor visibility, and the `fp-faded` class uses `faded` (replacing the current "top floor" fading for markers).
- `setCut(height: number | null)`: when called, overrides the computed clip: `modelClip.constant = height ?? 1e6`; `setCut(undefined)` restores today's automatic behaviour.
- `getCamera(): { position: [x,y,z], target: [x,y,z] }` (perspective, world, rounded to 0.01).
- `setCamera(cam, { instant = false } = {})`: 3D mode only; reuses the existing tween (same easing/400 ms); ortho ignores.
- `meshTriangles(mesh): number[]` — world-space triangle vertices (applies `matrixWorld`; handles indexed and non-indexed geometry).
- `pickModel(x, y)` additionally returns `hit: { point: [x, y, z], object }` on the returned entry/untagged object (do not mutate manifest entries: return `{ ...owner, hit }`).
- On model load, record `level.minY` for every manifest level (already done for legacy tie-break; ensure it is set for all levels).

- [ ] **Step 1:** Implement the hooks above. Code sketch for the two less obvious ones:

```js
  meshTriangles(mesh) {
    const g = mesh.geometry;
    if (!g || !g.attributes.position) return [];
    mesh.updateMatrixWorld(true);
    const pos = g.attributes.position, idx = g.index, out = [], v = new THREE.Vector3();
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(mesh.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
    return out;
  }

  getCamera() {
    const r = (a) => a.toArray().map((x) => Math.round(x * 100) / 100);
    return { position: r(this.persp.position), target: r(this.controls.target) };
  }
```

`setCamera` starts the tween from the current position/target to the given ones (or sets them directly when `instant` or `!this._framed`), exactly like `fit()` does today; factor the tween start into a private `_moveCamera(position, target, instant)` used by both.

- [ ] **Step 2: Verify** `npm run build`, `npx eslint .`, `npx vitest run`, and that the existing headless checks still pass: `node scripts/screenshot.mjs && node scripts/edit-check.mjs && node scripts/model-check.mjs`.
- [ ] **Step 3: Commit** `View: visible floor sets, model visibility flags, marker states, cut override, camera get/set, mesh triangles`.

---

### Task 5: Card — views, chips, devices, cameras, elevations, labels

**Files:** Modify `src/floorplan3d-card.js` (+ `src/layout.js` call sites if needed).

**Interfaces:**

- Consumes: Tasks 1–4.
- Produces on the card (used by Task 6/7/8): `this._views: View[]` (resolved, incl. hidden), `this._viewId`, `currentView(): View`, `viewIndex(): index | null`, `_setView(id, { instant })`, `_viewState: { effective: boolean[], primary, floors: string[] }`, `saveViewPatch(id, patch)` (merges into `layout.views[id]` and commits).

- [ ] **Step 1: Resolve views.** After `modelBindings()` in `_update`, compute (only when manifest, layout.views, config.views, HA floors or level bindings change — cache key like `modelKey`):
  - `index = nodeIndex(threeAdapter(view.model.root), manifest)` (cache per manifest),
  - `this._views = resolveViews({ manifest, haFloors: mergeFloors(h, {floors: []}), layoutViews: layout.views, yamlViews: config.views, savedLevels: layout.model?.levels })`,
  - for the active view: `effective = resolveVisibility(index, view.rules)`, `primary = primaryLevel(index, effective, manifest.levels)`, `floors = view.floors ?? (view.id === 'all' && view.source !== 'model' ? allFloorIds : defaultFloors(primary, levelFloor))` where `levelFloor` = `{ levelId: mb.levels[levelId].floor }`.
  - Without a model: `this._views = resolveViews({ manifest: null, ... })` and chips/markers keep today's code path (no `applyModelVisibility`, no marker states).
- [ ] **Step 2: Chips** come from `this._views.filter((v) => !v.hidden)` (button `data-view`, label `v.label`); editing no longer hides "All" when views are model-owned. Default view: `config.view_id` if present, else `config.floor` if it is a view id, else the first visible view. Clicking a chip → `_setView(id)`.
- [ ] **Step 3: `_setView(id)`**: store `_viewId`; `view.setVisibleFloors(floors.length ? floors : (id === 'all' ? 'all' : []))`; `view.applyModelVisibility(index, effective)`; cut: `view.setCut(isUntagged && (view.cut ?? true) && floors.length ? maxElev(floors) + Math.max(wallHeight, 0.3) : null)` for untagged; tagged → `view.setCut(null)`; camera: `view.camera ? this._view.setCamera(view.camera, { instant }) : this._view.fit({ instant })`; then recompute marker states (Step 4) and `_syncToolbar()`.
- [ ] **Step 4: Marker states**: for each marker with a position: `roomId` = the model room id whose area is the marker's area (`this._modelRooms` entry `modelId`, via `area_id`), `roomLevelId` = that manifest room's `level`; `markerFloorId` = position `floorId`. `visibleRooms` = manifest rooms whose node index is effectively visible. `levelOrder` from manifest levels (`order ?? index in generatedViews order`). Call `this._view.setMarkerStates(map)` after `_buildMarkers` and on view change. (Mower/live markers: treat like pins.)
- [ ] **Step 5: Measured elevations**: in `_buildStructure`, pass levels to `levelFloorOverrides` with `elevation/height` filled from `measuredElevations(manifest.levels)` for levels that lack them (do not mutate manifest entries: map to copies).
- [ ] **Step 6: Labels**: room labels use `roomLabel(name, room.polygon, config.room_labels || 'size')` (name = existing label text). Card editor schema (`src/card-editor.js`) gains `room_labels` select (`name`, `size`, `none`).
- [ ] **Step 7: Saved patches**: `saveViewPatch(id, patch)` → `this._commit({ ...layout, views: { ...(layout.views||{}), [id]: { ...(layout.views?.[id]||{}), ...patch } } })`. Rules patches replace the stored `rules` array (Task 6 builds it).
- [ ] **Step 8: Verify** build, lint, vitest, `node scripts/screenshot.mjs` (no model unchanged), `node scripts/model-check.mjs` (update expectations that referred to HA-floor chips with a model: chips are now the demo model's generated views `level0`/`level1`/`all` labels; adjust the checks minimally and say which). Commit `Card: model-owned views linked to HA floors, devices follow visible rooms, saved cameras, measured elevations, room size labels`.

---

### Task 6: Edit mode — Views tab, click-in-3D menu, Model/Rooms tab changes

**Files:** Modify `src/edit-mode.js`, `src/floorplan3d-card.js` (STYLE only).

**Interfaces:**

- Consumes: card `this._views`, `currentView()`, `viewIndex()`, `_setView`, `saveViewPatch`, `_viewState`; view `pickModel` (with `hit`), `highlightModelNode`; `unmatchedSelectors`, `parseSelector`.
- Produces (DOM hooks for Task 8): tab button `Views` (`data-act="tab" data-id="views"`); `select[data-field="vw-view"]`; `input[data-field="vw-label"]`; `input[data-field="vw-floor"][data-id=<floorId>]` (checkboxes); buttons `data-act="vw-add"`, `vw-hide`, `vw-up`, `vw-down`, `vw-save-cam`, `vw-reset-cam`, `vw-reset`; `input[data-field="vw-cut"]`; tree rows `li[data-sel="<selector>"]` with an eye `button[data-act="vw-eye"][data-sel=…]` cycling default → hide → show → default; unmatched selectors listed under "Not in this model" with remove buttons `data-act="vw-rm"`; floating menu `.fp-pickmenu` with buttons `data-act="vw-hide-here"`, `vw-show-here`, `vw-hide-all`, `vw-reveal`.

- [ ] **Step 1: Views tab rendering** (`_viewsTab()`):
  - View select (all views incl. hidden, hidden ones marked "(hidden)"), label input, linked floors (checkbox per HA floor; unchecked all = "no floor"), Add view (id `view_<n>`, label "View <n>", `added: true`, copies current view's layout rules), Hide/Unhide (model/generated views: `hidden` flag; added views: delete the entry), Up/Down (store order in `layout.view_order: string[]`; `resolveViews` output is sorted by it in the card — add this sort in the card, not in `resolveViews`).
  - Camera: "Save current view as start" → `saveViewPatch(id, { camera: this.card._view.getCamera() })`; "Reset camera" → `camera: null`.
  - "Cut at wall height" checkbox only when the model is untagged.
  - Element tree from `viewIndex()`: levels (tag level) → their rooms/zones → objects under each; then "Layers" (distinct `layers` across nodes, selector `layer:<name>`); then "Model groups" for untagged parts: nodes without a tag whose depth ≤ 2 below a level (or root) and that have children (selector `node:<path>`). Each row: name, resolved state icon (visible/hidden from `_viewState.effective`), eye button. Rules for the view = layout rules only (model rules are shown as the default state); clicking the eye replaces any existing layout rule for that selector and appends the new one (`{hide}` / `{show}`) or removes it (back to default).
  - "Not in this model": `unmatchedSelectors(index, layoutRules)` with remove buttons.
  - "Reset this view": `saveViewPatch(id, { rules: [], camera: null })`.
- [ ] **Step 2: Click in 3D** on the Views tab: `pickModel` → selector: tagged owner → `level:/room:/zone:/object:` by kind; untagged → nearest ancestor of `hit.object` that has a name and children (walk up from the mesh's parent), selector `node:<path>` (path built like `nodeIndex`: names from the model root). Highlight it and show `.fp-pickmenu` near the click (absolute in the stage, clamped inside). Actions: hide/show here (patch current view's rules), hide on all views (patch every visible view), reveal (scroll the tree row into view and flash it). Escape or a click elsewhere closes the menu.
- [ ] **Step 3: Model tab**: the level select becomes "belongs to HA floor": options `auto`, each floor (`floor:<id>`), `none` (`{ floor: null, show: 'hidden' }` is no longer written; write `{ floor: id }` or `{ floor: null }`; `auto` deletes). Existing saved show modes stay readable (migrated by Task 2).
- [ ] **Step 4: Rooms tab**: the floors table (elevation/height inputs) moves into `<details class="advanced"><summary>Advanced (no model)</summary>…</details>`, rendered only when no model is loaded.
- [ ] **Step 5: STYLE** for the tree (indent per depth, eye button, hidden rows dimmed), `.fp-pickmenu` (card background, shadow, buttons stacked), `li.flash` animation.
- [ ] **Step 6: Verify** build, lint, vitest; commit `Edit mode: Views tab (views, linked floors, element tree, cameras, cut), click-in-3D hide/show, belongs-to-floor, advanced floors`.

---

### Task 7: Pick a room from the model

**Files:** Modify `src/edit-mode.js` (Rooms tab + click handling), `src/floorplan3d-card.js` (STYLE if needed).

**Interfaces:** Consumes `outlineFromTriangles`, view `pickModel` (with `hit`), `meshTriangles`, `E.newRoomId`, `E.upsertRoom`, `setModelProps`.

- [ ] **Step 1:** Rooms tab: for each missing area add a `Pick` button (`data-act="pick" data-id=<areaId>`) next to Draw (only when a model is loaded). Pick mode sets `this.picking = { areaId }`, stage class `drawing` (crosshair), panel shows "Click on this room's floor in the model" + Cancel (`data-act="pick-cancel"`).
- [ ] **Step 2:** On click in pick mode: `owner = view.pickModel(x, y)`; if none → message "Click on a room's floor". If `owner.kind` is `room`/`zone` → `setModelProps({ rooms: { ...rooms, [owner.id]: { area: areaId } } })`, message "Linked <label> to <area>", exit pick mode. Otherwise `poly = outlineFromTriangles(view.meshTriangles(owner.hit.object), owner.hit.point)`; if `null` → fall back to the mesh's plan bounding rectangle (from `new THREE.Box3().setFromObject(mesh)` — do this in the view: add `view.meshPlanRect(mesh)` returning `[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]`) and note "Used the floor piece's rectangle".
- [ ] **Step 3:** Confirm: show the polygon as an overlay (`refreshOverlay` preview fill/line) and panel buttons "Use this outline" (`data-act="pick-use"`) / "Draw instead" (`data-act="pick-draw"`, starts `startDrawing(areaId)`). Use → create `{ id: newRoomId, area_id, polygon, doors: [], outdoor: false, floor_id: currentView floors[0] }` via `upsertRoom`, select it.
- [ ] **Step 4: Verify** build, lint, vitest; commit `Rooms: pick a room's outline from the model (tagged rooms link, untagged floors traced)`.

---

### Task 8: Demo model with views and layers, headless checks, docs, v0.3.0

**Files:** `scripts/make-demo-model.mjs`, `demo/house.glb`, `scripts/model-check.mjs`, `scripts/edit-check.mjs` (only if needed), `docs/model-builder-guide.md`, `README.md`, versions.

- [ ] **Step 1: Demo model**: add root `userData.fp = { views: [ {id:'exterior', label:'Exterior', show:['all']}, {id:'ground', label:'Ground floor', show:['level:level0','role:exterior'], hide:['role:roof']}, {id:'first', label:'First floor', show:['level:level0','level:level1','role:exterior'], hide:['role:roof']} ] }` (on the wrapper/root group the exporter writes as the scene's top node — make it a single wrapper group `house` containing all levels so the manifest finds it); tag furniture boxes with `layer: 'furniture'`, add a thin ceiling slab per storey as `layer: 'ceiling'` inside the storey above. Regenerate; `node tools/check-model.mjs demo/house.glb` → OK.
- [ ] **Step 2: Headless checks** (model-check, uploading `demo/house.glb` in edit mode):
  - chips show `Exterior`, `Ground floor`, `First floor` (model views) in that order;
  - Ground floor view: `level1` node invisible, `level0` visible, roof invisible; a ground-floor device marker shown; a first-floor device marker hidden;
  - First floor view: ground-floor devices faded (`fp-faded`), first-floor devices not faded;
  - Exterior view: all levels visible, every room marker shown;
  - Views tab: eye on `layer:furniture` → furniture nodes hidden only in the current view (switch view → visible again); stored rule in `layout.views.<id>.rules`;
  - click in 3D on a furniture box → menu → "Hide in this view" → that box's group hidden; "Reveal in tree" scrolls to its row;
  - "Save current view as start" → change camera, switch views and back → camera restored (distance within 0.1 m);
  - linked floors: uncheck the floor of Ground floor → its devices without model rooms disappear;
  - untagged copy (strip extras and rename to legacy names via `rewriteGlbJson`): generated views Ground/…/All, `cut` checkbox present and checked, elevation inputs absent in Rooms tab;
  - pick: Rooms tab "Pick" on a missing area, click the demo kitchen floor → outline area within 0.5 m² of the kitchen polygon area → "Use" creates a room; "Draw instead" enters drawing; on a tagged room floor → links the model room instead;
  - room labels contain `×` or `m²` in edit mode;
  - no model page: chips are HA floors + All exactly as before (existing checks).
- [ ] **Step 3: Docs**: guide — `views` on the root (format, selectors, example from the spec §8), `layer` values, ceilings in the storey above, one floor mesh per room, keep ids stable (views too); README — Views (model-owned, linked to HA floors, Views tab, click to hide, save camera), Pick room, `room_labels` option, YAML `views:` example.
- [ ] **Step 4: Version** 0.3.0 (package.json, integration manifest, `VERSION`), `npm install --package-lock-only`.
- [ ] **Step 5: Verify everything**: eslint, vitest, build, model-check, edit-check, screenshot, pytest (venv `<venv>/bin/python -m pytest -q`).
- [ ] **Step 6: Commit** `Demo model with views and layers, headless checks for views and picking, docs, v0.3.0`.

---

## Self-review notes

- Spec §1 views/sources/overrides/linking/device rule → Tasks 1, 2, 5; §2 selectors/resolution/storage/migration → Tasks 1, 2, 5, 6; §3 Views tab + click → Task 6; §4 no metres → Tasks 2 (`measuredElevations`), 5, 6 (advanced section); §5 camera → Tasks 4, 5, 6; §6 pick → Tasks 3, 4, 7; §7 labels → Tasks 3, 5; §8 guide → Task 8; §9 error handling → unmatched selectors (Task 1/6), pick fallback (Task 7), YAML unknown ids ignored (Task 2 merge only touches known ids + added); §10 testing → each task + Task 8.
- Names consistent across tasks: `parseSelector`, `nodeIndex`, `matches`, `resolveVisibility`, `unmatchedSelectors`, `modelViewRules`, `generatedViews`, `migrateShowModes`, `resolveViews`, `primaryLevel`, `defaultFloors`, `markerState`, `measuredElevations`, `outlineFromTriangles`, `roomLabel`, `setVisibleFloors`, `applyModelVisibility`, `setMarkerStates`, `setCut`, `getCamera`, `setCamera`, `meshTriangles`, `meshPlanRect`, `_setView`, `saveViewPatch`, `currentView`, `viewIndex`.
