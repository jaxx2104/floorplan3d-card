# Model contract v2, part 1: manifest, levels and rooms from the model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The card reads `fp` tags from an uploaded (or YAML) `.glb`, lets the user assign model levels to HA floors and model rooms/zones to HA areas in the Model tab (or by clicking the model), builds rooms from the model's outlines, survives re-exports by id, and ships a `tools/check-model.mjs` validator.

**Architecture:** Two new pure modules: `src/manifest.js` walks any node tree through an adapter (three.js nodes in the card, glTF JSON in the validator) and returns levels/rooms/zones/objects plus errors and warnings; `src/bindings.js` resolves saved bindings + defaults into level→floor and room→area assignments and turns model rooms into ordinary layout rooms. `src/view.js` keeps the manifest on the loaded model, applies level visibility and picks nodes; the card feeds model rooms into the existing structure/marker pipeline; the Model tab edits `layout.model.levels` / `layout.model.rooms`.

**Tech Stack:** Vanilla JS custom element, Three.js 0.169 (GLTFLoader keeps glTF `extras` in `userData`), esbuild, vitest (+ jsdom where DOM is needed), Node 22+ for the CLI, puppeteer-core headless checks (`scripts/model-check.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-01-model-contract-design.md` (sections 1–4, 8; types/objects, environment and built-in objects are later plans). Builder-facing guide: `docs/model-builder-guide.md`.

## Global Constraints

- Coordinates: metres, glTF Y up, plan x = east, plan y = north = -Z; world = `(x, elevation + z, -y)`.
- `fp` ids: `[a-z0-9_-]{1,64}`, unique per kind; bindings are keyed by id.
- Kinds: `level` | `room` | `zone` | `object`. Level roles: `storey` (default) | `basement` | `exterior` | `roof`.
- Name fallback: `fp:<kind>:<id>` / `fp:<type>:<id>`; legacy top-level `floor:<id>`, `roof`, `site` keep working. Extras win over names.
- Level show modes: `with` (default) | `always` | `hidden` | `all-only`. Defaults: exact id match → storeys/basements by `order` onto HA floors by elevation (order 0 aligned with the floor at elevation 0) → `exterior` with the lowest storey's floor → `roof` `all-only`.
- Room area default: saved area if it exists in HA → `suggest.area` if it exists → area whose id equals the room id → unassigned.
- Model rooms are not stored; they are recomputed from manifest + bindings + alignment. A model room wins over a drawn room for the same area.
- Legacy `layout.model.floor_map` and YAML `model_floors` are read as level bindings.
- Validator: `node tools/check-model.mjs house.glb [--json]`, no dependencies, exit code 1 on errors; warns on meshes over 60 m inside `storey`/`basement` levels, textures over 2048 px, files over 20 MB.
- Nothing in the card may throw on a malformed tag; bad tags become errors/warnings in the report.
- Existing code style: 2-space indent, single quotes, no semicolon-free style changes, comments only where they explain why. Run `npx eslint .` before each commit.

## Review Focus

1. A model with **no tags at all** (or only legacy `floor:` names) must keep working exactly as v0.1.5: whole model shown, cut at the floor, legacy groups mapped. → Task 1 test "legacy names", Task 5 headless "untagged model".
2. **Duplicate or invalid ids / malformed outlines** in a hand-made model must not break the card: first id wins, bad outline ignored, errors listed. → Task 1 tests "duplicates", "bad outline".
3. **Basement + single HA floor**: a model with basement (order -1) and ground (order 0) on an HA with only `floor1` (level 0) must put _ground_ on floor1, not the basement. → Task 2 test "order 0 aligns with elevation 0".
4. **HA area or floor deleted after binding**: saved binding pointing at a missing area/floor falls back to defaults, no crash, row shows the problem. → Task 2 tests "stale floor", "stale area".
5. **Rotated / moved model**: room outlines must follow the alignment sliders so devices stay inside the visible rooms. → Task 2 test "transformPoint rotation", Task 5 headless "rotation moves rooms".

---

## File Structure

| File                                                                                                               | Responsibility                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/manifest.js` (new)                                                                                            | Read tags, walk a node tree via an adapter, validate, summarise. No three.js import.                                             |
| `src/bindings.js` (new)                                                                                            | Pure: migrate legacy bindings, resolve levels/rooms, transform outlines, build model rooms, floor overrides, binding diff.       |
| `tools/check-model.mjs` (new)                                                                                      | CLI validator: parse GLB, manifest, GLB-only checks (mesh size, texture size, file size). Exports `checkGlb(buffer)`.            |
| `src/view.js` (modify)                                                                                             | Keep `model.manifest`; fallback outlines; `setModelLevels`; `pickModel`; `highlightModelNode`; drop `floorNodes` logic.          |
| `src/floorplan3d-card.js` (modify)                                                                                 | Resolve bindings, combine model + drawn rooms, floor overrides, rebuild on manifest/binding change. Drop `modelFloorAssignment`. |
| `src/edit-mode.js` (modify)                                                                                        | Model tab: levels/rooms tables, report, regeneration summary, click-to-pick; Rooms tab shows model-covered areas.                |
| `src/layout.js` (modify)                                                                                           | Remove `modelFloorMap` (replaced by `resolveLevels`).                                                                            |
| `scripts/make-demo-model.mjs`, `demo/house.glb` (modify)                                                           | Demo model v2 with tags.                                                                                                         |
| `scripts/model-check.mjs` (modify)                                                                                 | Headless checks for the new flow.                                                                                                |
| `test/manifest.test.js`, `test/bindings.test.js`, `test/check-model.test.js` (new); `test/layout.test.js` (modify) | Unit tests.                                                                                                                      |
| `README.md`, `docs/model-builder-guide.md`, `package.json` (modify)                                                | Docs, `check-model` script.                                                                                                      |

---

### Task 1: Manifest reader (`src/manifest.js`)

**Files:**

- Create: `src/manifest.js`
- Test: `test/manifest.test.js`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `KINDS: string[]`, `ROLES: string[]`, `ID_RE: RegExp`
  - `readTag(name: string, extras: object, opts?: { topLevel?: boolean }): Tag | null`
  - `buildManifest(adapter: Adapter): Manifest` where
    `Adapter = { roots(): N[], children(n): N[], name(n): string, extras(n): object, parent(n): N | null }` and
    `Manifest = { levels: Level[], rooms: Room[], objects: Obj[], errors: string[], warnings: string[], byNode: Map<N, Entry>, ownerOf(n): Entry | null }`
    - `Level = { kind: 'level', id, label, role, order, elevation: number|null, height: number|null, node, path, source }`
    - `Room = { kind: 'room'|'zone', id, label, level: string|null, outline: [x,y][]|null, doors: [x,y][], suggest: object, node, path, source }`
    - `Obj = { kind: 'object', id, type, label, level, room, group, glow, anchor, hints, suggest, ui, node, path, source }`
  - `threeAdapter(root: THREE.Object3D): Adapter`, `gltfAdapter(json: object): Adapter` (nodes are indices)
  - `summarize(m: Manifest): { levels: number, rooms: number, zones: number, objects: Record<type, number> }`

- [ ] **Step 1: Write the failing tests**

```js
// test/manifest.test.js
import { describe, it, expect } from 'vitest';
import { readTag, buildManifest, gltfAdapter, summarize } from '../src/manifest.js';

// tiny tree helper: { name, extras, children }
const tree = (roots) => {
  const parent = new Map();
  const walk = (n) => (n.children || []).forEach((c) => { parent.set(c, n); walk(c); });
  roots.forEach(walk);
  return {
    roots: () => roots, children: (n) => n.children || [], name: (n) => n.name || '',
    extras: (n) => n.extras || {}, parent: (n) => parent.get(n) || null,
  };
};
const fp = (o) => ({ fp: o });
const sq = [[0, 0], [4, 0], [4, 3], [0, 3]];

describe('readTag', () => {
  it('prefers extras over the name', () => {
    expect(readTag('fp:light:x', fp({ kind: 'room', id: 'k' }))).toMatchObject({ kind: 'room', id: 'k', source: 'extras' });
  });
  it('reads name fallbacks', () => {
    expect(readTag('fp:level:ground', {})).toMatchObject({ kind: 'level', id: 'ground', source: 'name' });
    expect(readTag('fp:light:terrace_1', {})).toMatchObject({ kind: 'object', type: 'light', id: 'terrace_1' });
  });
  it('reads legacy names only at the top level', () => {
    expect(readTag('floor:floor1', {}, { topLevel: true })).toMatchObject({ kind: 'level', id: 'floor1', role: 'storey', source: 'legacy' });
    expect(readTag('roof', {}, { topLevel: true })).toMatchObject({ kind: 'level', role: 'roof' });
    expect(readTag('site', {}, { topLevel: true })).toMatchObject({ kind: 'level', id: 'site', role: 'exterior' });
    expect(readTag('floor:x', {})).toBeNull();
    expect(readTag('Mesh_12', {})).toBeNull();
  });
});

describe('buildManifest', () => {
  const lamp = { name: 'lamp', extras: fp({ kind: 'object', id: 'kitchen_1', type: 'light', hints: { beam: 'down' } }) };
  const kitchen = { name: 'kitchen', extras: fp({ kind: 'room', id: 'kitchen', outline: sq, doors: [[2, 0]], suggest: { area: 'kitchen' } }), children: [lamp, { name: 'slab' }] };
  const ground = { name: 'ground', extras: fp({ kind: 'level', id: 'ground', order: 0, elevation: 0, height: 2.7 }), children: [kitchen] };
  const garden = { name: 'garden', extras: fp({ kind: 'zone', id: 'garden', outline: [[-5, -5], [10, -5], [10, 10]] }) };
  const exterior = { name: 'exterior', extras: fp({ kind: 'level', id: 'exterior', role: 'exterior' }), children: [garden] };
  const roof = { name: 'roof' };

  it('collects levels, rooms, zones and objects with their parents', () => {
    const m = buildManifest(tree([ground, exterior, roof]));
    expect(m.levels.map((l) => [l.id, l.role, l.order])).toEqual([['ground', 'storey', 0], ['exterior', 'exterior', null], ['roof', 'roof', null]]);
    expect(m.rooms.map((r) => [r.kind, r.id, r.level])).toEqual([['room', 'kitchen', 'ground'], ['zone', 'garden', 'exterior']]);
    expect(m.objects[0]).toMatchObject({ id: 'kitchen_1', type: 'light', level: 'ground', room: 'kitchen', hints: { beam: 'down' } });
    expect(m.rooms[0]).toMatchObject({ outline: sq, doors: [[2, 0]], suggest: { area: 'kitchen' }, path: 'ground/kitchen' });
    expect(m.errors).toEqual([]);
  });

  it('finds the owner of a nested node', () => {
    const m = buildManifest(tree([ground]));
    expect(m.ownerOf(kitchen.children[1]).id).toBe('kitchen');
    expect(m.ownerOf(lamp).id).toBe('kitchen_1');
    expect(m.ownerOf({ name: 'stray' })).toBeNull();
  });

  it('looks through a single untagged wrapper', () => {
    const m = buildManifest(tree([{ name: 'Scene', children: [ground, roof] }]));
    expect(m.levels.map((l) => l.id)).toEqual(['ground', 'roof']);
  });

  it('keeps the first of duplicate ids and reports the rest', () => {
    const a = { name: 'a', extras: fp({ kind: 'level', id: 'ground' }) };
    const b = { name: 'b', extras: fp({ kind: 'level', id: 'ground' }) };
    const m = buildManifest(tree([a, b]));
    expect(m.levels).toHaveLength(1);
    expect(m.levels[0].node).toBe(a);
    expect(m.errors[0]).toMatch(/duplicate level id "ground"/);
  });

  it('reports invalid ids, unknown kinds and roles, rooms outside levels', () => {
    const m = buildManifest(tree([
      { name: 'x', extras: fp({ kind: 'level', id: 'Bad Id' }) },
      { name: 'y', extras: fp({ kind: 'thing', id: 'y' }) },
      { name: 'z', extras: fp({ kind: 'level', id: 'z', role: 'cellar' }) },
      { name: 'r', extras: fp({ kind: 'room', id: 'loose', outline: sq }) },
    ]));
    expect(m.errors.join('\n')).toMatch(/invalid id "Bad Id"/);
    expect(m.errors.join('\n')).toMatch(/unknown kind "thing"/);
    expect(m.errors.join('\n')).toMatch(/room "loose" is not inside a level/);
    expect(m.warnings.join('\n')).toMatch(/unknown role "cellar"/);
    expect(m.levels.find((l) => l.id === 'z').role).toBe('storey');
  });

  it('drops a malformed outline with a warning', () => {
    const lvl = { name: 'l', extras: fp({ kind: 'level', id: 'l' }), children: [
      { name: 'r', extras: fp({ kind: 'room', id: 'r', outline: [[0, 0], ['a', 1]] }) },
    ] };
    const m = buildManifest(tree([lvl]));
    expect(m.rooms[0].outline).toBeNull();
    expect(m.warnings.join('\n')).toMatch(/room "r": outline needs at least 3 \[x, y\] points/);
  });

  it('treats an untagged legacy model as before', () => {
    const m = buildManifest(tree([{ name: 'floor:ground' }, { name: 'roof' }, { name: 'site' }, { name: 'Lamp' }]));
    expect(m.levels.map((l) => [l.id, l.role])).toEqual([['ground', 'storey'], ['roof', 'roof'], ['site', 'exterior']]);
    expect(m.errors).toEqual([]);
  });

  it('summarizes', () => {
    expect(summarize(buildManifest(tree([ground, exterior])))).toEqual({ levels: 2, rooms: 1, zones: 1, objects: { light: 1 } });
  });
});

describe('gltfAdapter', () => {
  it('walks glTF JSON nodes by index', () => {
    const json = {
      scene: 0, scenes: [{ nodes: [0] }],
      nodes: [
        { name: 'ground', extras: fp({ kind: 'level', id: 'ground' }), children: [1] },
        { name: 'kitchen', extras: fp({ kind: 'room', id: 'kitchen', outline: sq }) },
      ],
    };
    const m = buildManifest(gltfAdapter(json));
    expect(m.rooms[0]).toMatchObject({ id: 'kitchen', level: 'ground', node: 1 });
    expect(m.ownerOf(1).id).toBe('kitchen');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/manifest.test.js`
Expected: FAIL, "Failed to resolve import ../src/manifest.js".

- [ ] **Step 3: Implement `src/manifest.js`**

```js
// Reads the fp tags of a house model (docs/model-builder-guide.md). Works on any node tree
// through an adapter, so the card (three.js nodes) and tools/check-model.mjs (glTF JSON) share it.

export const KINDS = ['level', 'room', 'zone', 'object'];
export const ROLES = ['storey', 'basement', 'exterior', 'roof'];
export const ID_RE = /^[a-z0-9_-]{1,64}$/;

const isPoint = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const num = (v) => (Number.isFinite(v) ? v : null);

// Tag of one node: extras.fp, else an "fp:<kind|type>:<id>" name, else (top level only) the
// legacy names "floor:<id>", "roof" and "site".
export function readTag(name, extras, { topLevel = false } = {}) {
  const fp = extras && extras.fp;
  if (fp && typeof fp === 'object' && !Array.isArray(fp)) return { ...fp, source: 'extras' };
  const m = /^fp:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(name || '');
  if (m) {
    const k = m[1].toLowerCase();
    return KINDS.includes(k) ? { kind: k, id: m[2], source: 'name' } : { kind: 'object', type: k, id: m[2], source: 'name' };
  }
  if (topLevel) {
    const f = /^floor[:_](.+)$/.exec(name || '');
    if (f) return { kind: 'level', id: f[1], role: 'storey', source: 'legacy' };
    if (name === 'roof') return { kind: 'level', id: 'roof', role: 'roof', source: 'legacy' };
    if (name === 'site') return { kind: 'level', id: 'site', role: 'exterior', source: 'legacy' };
  }
  return null;
}

export function buildManifest(adapter) {
  const m = { levels: [], rooms: [], objects: [], errors: [], warnings: [], byNode: new Map() };
  const seen = { level: new Set(), room: new Set(), zone: new Set(), object: new Set() };
  m.ownerOf = (node) => {
    for (let n = node; n !== null && n !== undefined; n = adapter.parent(n)) {
      if (m.byNode.has(n)) return m.byNode.get(n);
    }
    return null;
  };

  let tops = adapter.roots();
  if (tops.length === 1 && !readTag(adapter.name(tops[0]), adapter.extras(tops[0]), { topLevel: true })) {
    tops = adapter.children(tops[0]); // a single untagged wrapper (e.g. "Scene")
  }

  const add = (node, tag, ctx, path) => {
    const where = `${tag.kind} "${tag.id}"`;
    if (!KINDS.includes(tag.kind)) { m.errors.push(`${path}: unknown kind "${tag.kind}"`); return null; }
    if (typeof tag.id !== 'string' || (tag.source !== 'legacy' && !ID_RE.test(tag.id))) {
      m.errors.push(`${path}: invalid id "${tag.id}" (use a-z, 0-9, _ and -, at most 64)`);
      return null;
    }
    if (seen[tag.kind].has(tag.id)) { m.errors.push(`${path}: duplicate ${tag.kind} id "${tag.id}"`); return null; }
    seen[tag.kind].add(tag.id);
    const base = { kind: tag.kind, id: tag.id, label: tag.label || tag.id, node, path, source: tag.source };
    let entry;
    if (tag.kind === 'level') {
      let role = tag.role || 'storey';
      if (!ROLES.includes(role)) { m.warnings.push(`${where}: unknown role "${role}", using storey`); role = 'storey'; }
      if (ctx.level) m.warnings.push(`${where} is inside level "${ctx.level}"; levels should be top-level`);
      entry = { ...base, role, order: num(tag.order), elevation: num(tag.elevation), height: num(tag.height) };
      m.levels.push(entry);
    } else if (tag.kind === 'room' || tag.kind === 'zone') {
      if (!ctx.level) m.errors.push(`${where} is not inside a level`);
      let outline = null;
      if (tag.outline !== undefined) {
        if (Array.isArray(tag.outline) && tag.outline.length >= 3 && tag.outline.every(isPoint)) outline = tag.outline.map((p) => [p[0], p[1]]);
        else m.warnings.push(`${where}: outline needs at least 3 [x, y] points`);
      }
      const doors = Array.isArray(tag.doors) ? tag.doors.filter(isPoint).map((p) => [p[0], p[1]]) : [];
      entry = { ...base, level: ctx.level, outline, doors, suggest: tag.suggest || {} };
      m.rooms.push(entry);
    } else {
      if (!ctx.level) m.errors.push(`${where} is not inside a level`);
      entry = {
        ...base, type: tag.type || 'generic', level: ctx.level, room: ctx.room, group: tag.group || null,
        glow: tag.glow || null, anchor: isPoint(tag.anchor) ? tag.anchor : null, hints: tag.hints || {},
        suggest: tag.suggest || {}, ui: tag.ui || {},
      };
      m.objects.push(entry);
    }
    m.byNode.set(node, entry);
    return entry;
  };

  const walk = (node, ctx, parentPath, topLevel) => {
    const name = adapter.name(node);
    const path = parentPath ? `${parentPath}/${name}` : name;
    const tag = readTag(name, adapter.extras(node), { topLevel });
    let next = ctx;
    if (tag) {
      const e = add(node, tag, ctx, path);
      if (e && e.kind === 'level') next = { level: e.id, room: null };
      else if (e && (e.kind === 'room' || e.kind === 'zone')) next = { ...ctx, room: e.id };
    }
    for (const c of adapter.children(node)) walk(c, next, path, false);
  };
  for (const t of tops) walk(t, { level: null, room: null }, '', true);
  return m;
}

export function threeAdapter(root) {
  return {
    roots: () => root.children,
    children: (n) => n.children,
    name: (n) => (n.userData && n.userData.name) || n.name || '', // GLTFLoader strips ':' from n.name
    extras: (n) => n.userData || {},
    parent: (n) => (n.parent && n.parent !== root ? n.parent : null),
  };
}

export function gltfAdapter(json) {
  const nodes = json.nodes || [];
  const parent = new Map();
  nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));
  const scene = (json.scenes || [])[json.scene ?? 0] || { nodes: [] };
  return {
    roots: () => scene.nodes || [],
    children: (i) => nodes[i].children || [],
    name: (i) => nodes[i].name || '',
    extras: (i) => nodes[i].extras || {},
    parent: (i) => (parent.has(i) ? parent.get(i) : null),
  };
}

export function summarize(m) {
  const objects = {};
  for (const o of m.objects) objects[o.type] = (objects[o.type] || 0) + 1;
  return {
    levels: m.levels.length,
    rooms: m.rooms.filter((r) => r.kind === 'room').length,
    zones: m.rooms.filter((r) => r.kind === 'zone').length,
    objects,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/manifest.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Lint and commit**

```bash
npx eslint . && git add src/manifest.js test/manifest.test.js
git commit -m "Manifest reader for fp-tagged models (levels, rooms, zones, objects)"
```

---

### Task 2: Bindings (`src/bindings.js`)

**Files:**

- Create: `src/bindings.js`
- Test: `test/bindings.test.js`

**Interfaces:**

- Consumes: `Level`, `Room` shapes from Task 1.
- Produces:
  - `levelsFromFloorMap(map: Record<id, string>): Record<id, LevelBinding>` (legacy `floor_map` / YAML `model_floors`)
  - `migrateModel(model): model` (moves `floor_map` into `levels`, removes `floor_map`)
  - `resolveLevels(levels: Level[], floors: {id, elevation}[], saved: Record<id, LevelBinding>): Record<id, { show: 'with'|'always'|'hidden'|'all-only', floor: string|null, auto: boolean, stale?: boolean }>`
  - `resolveRoomAreas(rooms: Room[], areaIds: string[], saved: Record<id, {area: string|null}>): Record<id, { area: string|null, auto: boolean, stale?: boolean }>`
  - `transformPoint([x, y], align: { position?: [x,y,z], rotation?: deg, scale?: number }): [x, y]`
  - `modelRooms(rooms: Room[], levelAssign, roomAreas, align): LayoutRoom[]` (`{ id: 'm:<id>', modelId, area_id, floor_id, polygon, doors, outdoor, label, fromModel: true }`)
  - `combineRooms(drawn: LayoutRoom[], fromModel: LayoutRoom[]): LayoutRoom[]`
  - `levelFloorOverrides(levels: Level[], levelAssign, align): { id, elevation, height }[]`
  - `bindingDiff(manifest, model): { levels: { kept, added, missing }, rooms: { kept, added, missing } }` (arrays of ids)
  - `LevelBinding = { floor?: string, show?: 'with'|'always'|'hidden'|'all-only' }`

- [ ] **Step 1: Write the failing tests**

```js
// test/bindings.test.js
import { describe, it, expect } from 'vitest';
import {
  levelsFromFloorMap, migrateModel, resolveLevels, resolveRoomAreas, transformPoint, modelRooms,
  combineRooms, levelFloorOverrides, bindingDiff,
} from '../src/bindings.js';

const L = (id, role = 'storey', order = null, extra = {}) => ({ kind: 'level', id, role, order, elevation: null, height: null, ...extra });
const floors = [{ id: 'floor1', elevation: 0 }, { id: 'floor2', elevation: 3 }];

describe('legacy bindings', () => {
  it('reads floor_map / model_floors', () => {
    expect(levelsFromFloorMap({ ground: 'floor1', attic: 'always', x: 'hidden' }))
      .toEqual({ ground: { floor: 'floor1' }, attic: { show: 'always' }, x: { show: 'hidden' } });
  });
  it('migrates layout.model.floor_map into levels', () => {
    expect(migrateModel({ version: 'v', floor_map: { ground: 'floor1' } })).toEqual({ version: 'v', levels: { ground: { floor: 'floor1' } } });
    const m = { version: 'v', levels: { a: { floor: 'floor1' } } };
    expect(migrateModel(m)).toBe(m);
    expect(migrateModel(null)).toBeNull();
  });
});

describe('resolveLevels', () => {
  it('matches exact ids, then storeys bottom-up, exterior with the lowest, roof all-only', () => {
    const r = resolveLevels([L('floor2'), L('ground', 'storey', 0), L('exterior', 'exterior'), L('roof', 'roof')], floors, {});
    expect(r.floor2).toMatchObject({ show: 'with', floor: 'floor2', auto: true });
    expect(r.ground).toMatchObject({ show: 'with', floor: 'floor1' });
    expect(r.exterior).toMatchObject({ show: 'with', floor: 'floor1' });
    expect(r.roof).toMatchObject({ show: 'all-only', floor: null });
  });

  it('order 0 aligns with the floor at elevation 0 (basement on a one-floor HA)', () => {
    const r = resolveLevels([L('basement', 'basement', -1), L('ground', 'storey', 0)], [{ id: 'floor1', elevation: 0 }], {});
    expect(r.ground.floor).toBe('floor1');
    expect(r.basement).toMatchObject({ show: 'always', floor: null });
  });

  it('honours saved bindings and show modes', () => {
    const r = resolveLevels([L('ground', 'storey', 0), L('exterior', 'exterior')], floors,
      { ground: { floor: 'floor2' }, exterior: { show: 'hidden' } });
    expect(r.ground).toMatchObject({ show: 'with', floor: 'floor2', auto: false });
    expect(r.exterior).toMatchObject({ show: 'hidden', auto: false });
  });

  it('falls back to defaults when a saved floor no longer exists', () => {
    const r = resolveLevels([L('ground', 'storey', 0)], floors, { ground: { floor: 'deleted' } });
    expect(r.ground).toMatchObject({ show: 'with', floor: 'floor1', auto: true, stale: true });
  });

  it('leftover storeys are always shown', () => {
    const r = resolveLevels([L('a', 'storey', 0), L('b', 'storey', 1), L('c', 'storey', 2)], floors, {});
    expect([r.a.floor, r.b.floor, r.c.show]).toEqual(['floor1', 'floor2', 'always']);
  });
});

describe('resolveRoomAreas', () => {
  const rooms = [{ id: 'kitchen', suggest: {} }, { id: 'room_a', suggest: { area: 'guest_room' } }, { id: 'wc', suggest: {} }];
  it('saved, then suggest, then id, else unassigned', () => {
    const r = resolveRoomAreas(rooms, ['kitchen', 'guest_room', 'bathroom'], { wc: { area: 'bathroom' } });
    expect(r).toEqual({
      kitchen: { area: 'kitchen', auto: true },
      room_a: { area: 'guest_room', auto: true },
      wc: { area: 'bathroom', auto: false },
    });
    expect(resolveRoomAreas([{ id: 'x', suggest: {} }], [], {}).x).toEqual({ area: null, auto: true });
  });
  it('explicit "no area" sticks; a deleted area is stale', () => {
    expect(resolveRoomAreas(rooms.slice(0, 1), ['kitchen'], { kitchen: { area: null } }).kitchen).toEqual({ area: null, auto: false });
    expect(resolveRoomAreas(rooms.slice(0, 1), ['kitchen'], { kitchen: { area: 'gone' } }).kitchen).toEqual({ area: 'kitchen', auto: true, stale: true });
  });
});

describe('transformPoint', () => {
  it('scales, rotates counter-clockwise, then moves', () => {
    expect(transformPoint([1, 0], {})).toEqual([1, 0]);
    const [x, y] = transformPoint([1, 0], { rotation: 90, scale: 2, position: [10, 20, 0] });
    expect(x).toBeCloseTo(10);
    expect(y).toBeCloseTo(22);
  });
});

describe('modelRooms / combineRooms', () => {
  const rooms = [
    { kind: 'room', id: 'kitchen', label: 'Kitchen', level: 'ground', outline: [[0, 0], [4, 0], [4, 3]], doors: [[2, 0]] },
    { kind: 'zone', id: 'garden', label: 'Garden', level: 'exterior', outline: [[0, 0], [9, 0], [9, 9]], doors: [] },
    { kind: 'room', id: 'loft', label: 'Loft', level: 'attic', outline: [[0, 0], [1, 0], [1, 1]], doors: [] },
    { kind: 'room', id: 'noline', label: 'X', level: 'ground', outline: null, doors: [] },
  ];
  const levelAssign = { ground: { show: 'with', floor: 'floor1' }, exterior: { show: 'with', floor: 'floor1' }, attic: { show: 'always', floor: null } };
  const areas = { kitchen: { area: 'kitchen' }, garden: { area: null }, loft: { area: 'loft' }, noline: { area: 'x' } };

  it('turns outlined rooms on a floor into layout rooms, transformed by the alignment', () => {
    const out = modelRooms(rooms, levelAssign, areas, { position: [1, 1, 0] });
    expect(out.map((r) => r.id)).toEqual(['m:kitchen', 'm:garden']);
    expect(out[0]).toMatchObject({ modelId: 'kitchen', area_id: 'kitchen', floor_id: 'floor1', outdoor: false, label: 'Kitchen', fromModel: true });
    expect(out[0].polygon[1]).toEqual([5, 1]);
    expect(out[0].doors).toEqual([[3, 1]]);
    expect(out[1]).toMatchObject({ outdoor: true, area_id: null });
  });

  it('model rooms win over drawn rooms for the same area', () => {
    const drawn = [{ id: 'r1', area_id: 'kitchen' }, { id: 'r2', area_id: 'hall' }];
    const fromModel = [{ id: 'm:kitchen', area_id: 'kitchen' }, { id: 'm:garden', area_id: null }];
    expect(combineRooms(drawn, fromModel).map((r) => r.id)).toEqual(['m:kitchen', 'm:garden', 'r2']);
  });
});

describe('levelFloorOverrides', () => {
  it('takes elevation and height of the level bound to a floor', () => {
    const lv = [L('ground', 'storey', 0, { elevation: 0, height: 2.89 }), L('first', 'storey', 1, { elevation: 3.25, height: 2.5 }), L('ext', 'exterior', null, { elevation: 0 })];
    const as = { ground: { show: 'with', floor: 'floor1' }, first: { show: 'with', floor: 'floor2' }, ext: { show: 'with', floor: 'floor1' } };
    expect(levelFloorOverrides(lv, as, { position: [0, 0, 0.1], scale: 1 })).toEqual([
      { id: 'floor1', elevation: 0.1, height: 2.89 }, { id: 'floor2', elevation: 3.35, height: 2.5 },
    ]);
  });
});

describe('bindingDiff', () => {
  it('reports kept, added and missing ids', () => {
    const manifest = { levels: [{ id: 'ground' }, { id: 'attic' }], rooms: [{ id: 'kitchen' }] };
    const model = { levels: { ground: { floor: 'f' }, old: { floor: 'f' } }, rooms: { kitchen: { area: 'k' }, gone: { area: 'g' } } };
    expect(bindingDiff(manifest, model)).toEqual({
      levels: { kept: ['ground'], added: ['attic'], missing: ['old'] },
      rooms: { kept: ['kitchen'], added: [], missing: ['gone'] },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/bindings.test.js`
Expected: FAIL, "Failed to resolve import ../src/bindings.js".

- [ ] **Step 3: Implement `src/bindings.js`**

```js
// Bindings between a model's manifest and Home Assistant: which HA floor shows each level,
// which HA area each room/zone is. Saved choices live in layout.model.levels / .rooms; anything
// not saved is derived here, so re-exports and HA changes never need manual repair.

const SHOW = ['with', 'always', 'hidden', 'all-only'];

export function levelsFromFloorMap(map) {
  const out = {};
  for (const [id, v] of Object.entries(map || {})) out[id] = v === 'always' || v === 'hidden' ? { show: v } : { floor: v };
  return out;
}

export function migrateModel(model) {
  if (!model || !model.floor_map) return model;
  const { floor_map: fm, ...rest } = model;
  return { ...rest, levels: { ...levelsFromFloorMap(fm), ...(model.levels || {}) } };
}

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

export function resolveLevels(levels, floors, saved = {}) {
  const ids = new Set(floors.map((f) => f.id));
  const out = {};
  const stale = new Set();
  for (const l of levels) {
    const s = saved[l.id];
    if (!s) continue;
    if (s.show && SHOW.includes(s.show) && s.show !== 'with') {
      out[l.id] = { show: s.show, floor: ids.has(s.floor) ? s.floor : null, auto: false };
    } else if (ids.has(s.floor)) {
      out[l.id] = { show: 'with', floor: s.floor, auto: false };
    } else {
      stale.add(l.id); // saved floor was deleted in HA: fall back to the defaults below
    }
  }
  for (const l of levels) if (!out[l.id] && ids.has(l.id)) out[l.id] = { show: 'with', floor: l.id, auto: true };

  const used = new Set(Object.values(out).map((v) => v.floor).filter(Boolean));
  const storeys = levels.filter((l) => !out[l.id] && (l.role === 'storey' || l.role === 'basement')).sort(byOrder);
  const free = floors.filter((f) => !used.has(f.id)).sort((a, b) => a.elevation - b.elevation);
  // align the model's order 0 with HA's floor at elevation 0 (a basement must not take the ground floor)
  const k = storeys.findIndex((l) => (l.order ?? null) === 0);
  const j = free.findIndex((f) => f.elevation === 0);
  const shift = k >= 0 && j >= 0 ? j - k : 0;
  storeys.forEach((l, i) => {
    const f = free[i + shift];
    out[l.id] = f ? { show: 'with', floor: f.id, auto: true } : { show: 'always', floor: null, auto: true };
  });

  // the exterior goes with the lowest above-ground storey's floor (not a basement)
  const storeyFloors = levels.filter((l) => (l.role === 'storey' || l.role === 'basement') && out[l.id] && out[l.id].floor)
    .map((l) => floors.find((f) => f.id === out[l.id].floor));
  const byElev = (a, b) => a.elevation - b.elevation;
  const ground = storeyFloors.filter((f) => f.elevation >= 0).sort(byElev)[0] || storeyFloors.sort(byElev)[0]
    || floors.slice().sort(byElev)[0];
  const groundFloor = ground ? ground.id : null;
  for (const l of levels) {
    if (out[l.id]) continue;
    if (l.role === 'roof') out[l.id] = { show: 'all-only', floor: null, auto: true };
    else if (l.role === 'exterior') out[l.id] = groundFloor ? { show: 'with', floor: groundFloor, auto: true } : { show: 'always', floor: null, auto: true };
    else out[l.id] = { show: 'always', floor: null, auto: true };
  }
  for (const id of stale) out[id] = { ...out[id], stale: true };
  return out;
}

export function resolveRoomAreas(rooms, areaIds, saved = {}) {
  const areas = new Set(areaIds);
  const out = {};
  for (const r of rooms) {
    const s = saved[r.id];
    if (s && 'area' in s && (s.area === null || areas.has(s.area))) { out[r.id] = { area: s.area, auto: false }; continue; }
    const sug = r.suggest && r.suggest.area;
    const area = sug && areas.has(sug) ? sug : areas.has(r.id) ? r.id : null;
    out[r.id] = s && 'area' in s ? { area, auto: true, stale: true } : { area, auto: true };
  }
  return out;
}

export function transformPoint([x, y], { position = [0, 0, 0], rotation = 0, scale = 1 } = {}) {
  const a = (rotation * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const px = x * scale, py = y * scale;
  return [px * c - py * s + (position[0] || 0), px * s + py * c + (position[1] || 0)];
}

export function modelRooms(rooms, levelAssign, roomAreas, align) {
  const out = [];
  for (const r of rooms) {
    const lv = levelAssign[r.level];
    if (!r.outline || !lv || !lv.floor) continue; // levels without an HA floor carry no rooms
    out.push({
      id: 'm:' + r.id, modelId: r.id, label: r.label,
      area_id: roomAreas[r.id] ? roomAreas[r.id].area : null,
      floor_id: lv.floor,
      polygon: r.outline.map((p) => transformPoint(p, align)),
      doors: (r.doors || []).map((p) => transformPoint(p, align)),
      outdoor: r.kind === 'zone',
      fromModel: true,
    });
  }
  return out;
}

export function combineRooms(drawn, fromModel) {
  const covered = new Set(fromModel.map((r) => r.area_id).filter(Boolean));
  return [...fromModel, ...(drawn || []).filter((r) => !covered.has(r.area_id))];
}

export function levelFloorOverrides(levels, levelAssign, { position = [0, 0, 0], scale = 1 } = {}) {
  const out = [];
  const done = new Set();
  for (const l of levels) {
    const a = levelAssign[l.id];
    if (l.role === 'exterior' || l.role === 'roof' || !a || a.show !== 'with' || !a.floor || done.has(a.floor)) continue;
    if (l.elevation === null || l.elevation === undefined) continue;
    done.add(a.floor);
    const o = { id: a.floor, elevation: Math.round((l.elevation * scale + (position[2] || 0)) * 1000) / 1000 };
    if (l.height) o.height = Math.round(l.height * scale * 1000) / 1000;
    out.push(o);
  }
  return out;
}

export function bindingDiff(manifest, model) {
  const one = (entries, saved) => {
    const ids = new Set(entries.map((e) => e.id));
    const keys = Object.keys(saved || {});
    return {
      kept: [...ids].filter((id) => keys.includes(id)),
      added: [...ids].filter((id) => !keys.includes(id)),
      missing: keys.filter((id) => !ids.has(id)),
    };
  };
  return { levels: one(manifest.levels, model && model.levels), rooms: one(manifest.rooms, model && model.rooms) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/bindings.test.js`
Expected: PASS (14 tests).

- [ ] **Step 5: Lint and commit**

```bash
npx eslint . && git add src/bindings.js test/bindings.test.js
git commit -m "Bindings: resolve model levels to HA floors and rooms to areas, model rooms"
```

---

### Task 3: Validator CLI (`tools/check-model.mjs`)

**Files:**

- Create: `tools/check-model.mjs`
- Test: `test/check-model.test.js`
- Modify: `package.json` (script `check-model`), `eslint.config.js` (node globals for `tools/*.mjs`)

**Interfaces:**

- Consumes: `buildManifest`, `gltfAdapter`, `summarize` (Task 1).
- Produces: `checkGlb(buffer: Buffer | Uint8Array): { ok: boolean, errors: string[], warnings: string[], summary, levels: {id, role, order, elevation}[], rooms: {kind, id, level, area}[] }` and the CLI `node tools/check-model.mjs <file.glb> [--json]` (exit 1 when `errors.length`).

- [ ] **Step 1: Write the failing tests**

```js
// test/check-model.test.js
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkGlb } from '../tools/check-model.mjs';

// minimal GLB: JSON chunk (+ optional BIN chunk)
function glb(json, bin = null) {
  const pad = (b, c) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, c)]);
  const j = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const chunks = [Buffer.concat([u32(j.length), Buffer.from('JSON'), j])];
  if (bin) { const b = pad(bin, 0); chunks.push(Buffer.concat([u32(b.length), Buffer.from('BIN\0'), b])); }
  const body = Buffer.concat(chunks);
  return Buffer.concat([Buffer.from('glTF'), u32(2), u32(12 + body.length), body]);
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
const fp = (o) => ({ fp: o });
const sq = [[0, 0], [4, 0], [4, 3]];

// a mesh with POSITION bounds [-100..100] x [0..0] x [-100..100]
const bigPlane = {
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [{ componentType: 5126, count: 3, type: 'VEC3', min: [-100, 0, -100], max: [100, 0, 100] }],
};

describe('checkGlb', () => {
  it('passes a well-tagged model and summarises it', () => {
    const r = checkGlb(glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 2] }], nodes: [
      { name: 'ground', extras: fp({ kind: 'level', id: 'ground', order: 0, elevation: 0, height: 2.7 }), children: [1] },
      { name: 'kitchen', extras: fp({ kind: 'room', id: 'kitchen', outline: sq }) },
      { name: 'roof', extras: fp({ kind: 'level', id: 'roof', role: 'roof' }) },
    ] }));
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ levels: 2, rooms: 1, zones: 0, objects: {} });
    expect(r.levels[0]).toEqual({ id: 'ground', role: 'storey', order: 0, elevation: 0 });
  });

  it('warns about huge meshes inside storeys but not inside exterior', () => {
    const r = checkGlb(glb({ ...bigPlane, asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 2] }], nodes: [
      { name: 'ground', extras: fp({ kind: 'level', id: 'ground' }), children: [1] },
      { name: 'plane', mesh: 0 },
      { name: 'exterior', extras: fp({ kind: 'level', id: 'exterior', role: 'exterior' }), children: [3] },
      { name: 'lawn', mesh: 0 },
    ] }));
    expect(r.warnings.filter((w) => /larger than 60 m/.test(w))).toEqual([expect.stringMatching(/ground\/plane/)]);
  });

  it('applies node scale when measuring meshes', () => {
    const r = checkGlb(glb({ ...bigPlane, asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [
      { name: 'ground', extras: fp({ kind: 'level', id: 'ground' }), scale: [0.01, 0.01, 0.01], children: [1] },
      { name: 'plane', mesh: 0 },
    ] }));
    expect(r.warnings.join('\n')).not.toMatch(/larger than 60 m/);
  });

  it('reports errors, untagged models and missing roles', () => {
    const r = checkGlb(glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [
      { name: 'a', extras: fp({ kind: 'level', id: 'dup' }) }, { name: 'b', extras: fp({ kind: 'level', id: 'dup' }) },
    ] }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/duplicate level id "dup"/);
    expect(r.warnings.join('\n')).toMatch(/no level with role "exterior"/);
    expect(r.warnings.join('\n')).toMatch(/no level with role "roof"/);
    const u = checkGlb(glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Mesh' }] }));
    expect(u.warnings.join('\n')).toMatch(/no fp tags/);
  });

  it('measures embedded PNG textures', () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(4096, 16);
    png.writeUInt32BE(1024, 20);
    const r = checkGlb(glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [],
      buffers: [{ byteLength: 24 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 24 }],
      images: [{ bufferView: 0, mimeType: 'image/png', name: 'grass' }] }, png));
    expect(r.warnings.join('\n')).toMatch(/texture "grass" is 4096 × 1024/);
  });

  it('rejects a file that is not a GLB', () => {
    expect(checkGlb(Buffer.from('hello world, not a model'))).toMatchObject({ ok: false, errors: [expect.stringMatching(/not a binary glTF/)] });
  });
});

describe('CLI', () => {
  it('prints a report and exits 1 on errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
    const file = path.join(dir, 'bad.glb');
    fs.writeFileSync(file, glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [
      { name: 'a', extras: fp({ kind: 'level', id: 'x' }) }, { name: 'b', extras: fp({ kind: 'level', id: 'x' }) }] }));
    let code = 0, out = '';
    try { execFileSync('node', ['tools/check-model.mjs', file], { encoding: 'utf8' }); } catch (e) { code = e.status; out = e.stdout; }
    expect(code).toBe(1);
    expect(out).toMatch(/ERROR .*duplicate level id "x"/);
    const json = JSON.parse(execFileSync('node', ['tools/check-model.mjs', file, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).toString() || '{}');
    expect(json.ok).toBe(false);
  });
});
```

`--json` always exits 0 and reports `ok` in the JSON (scripts read `ok`); the text mode exits 1 on errors. `execFileSync` throws on a non-zero exit, which the first CLI call relies on and the `--json` call must not hit.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/check-model.test.js`
Expected: FAIL, "Failed to resolve import ../tools/check-model.mjs".

- [ ] **Step 3: Implement `tools/check-model.mjs`**

```js
#!/usr/bin/env node
// Checks a house model against docs/model-builder-guide.md before it is uploaded to the card.
//   node tools/check-model.mjs house.glb          human-readable report, exit 1 on errors
//   node tools/check-model.mjs house.glb --json   JSON report, always exit 0 (read "ok")
// No dependencies: reads the GLB's JSON chunk, accessor bounds and embedded image headers.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildManifest, gltfAdapter, summarize } from '../src/manifest.js';

const MAX_MESH_M = 60;
const MAX_TEXTURE_PX = 2048;
const MAX_FILE_MB = 20;

function parseGlb(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF' || buf.readUInt32LE(4) !== 2) return null;
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  let bin = null;
  const binStart = 20 + jsonLen;
  if (buf.length >= binStart + 8 && buf.toString('latin1', binStart + 4, binStart + 8) === 'BIN\0') {
    bin = buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart));
  }
  return { json, bin };
}

// 4x4 column-major matrices
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function local(n) {
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
const apply = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

function meshSize(json, meshIndex, world) {
  let min = [Infinity, Infinity], max = [-Infinity, -Infinity];
  for (const p of json.meshes[meshIndex].primitives || []) {
    const acc = json.accessors[p.attributes && p.attributes.POSITION];
    if (!acc || !acc.min || !acc.max) continue;
    for (const cx of [acc.min[0], acc.max[0]]) for (const cy of [acc.min[1], acc.max[1]]) for (const cz of [acc.min[2], acc.max[2]]) {
      const [x, , z] = apply(world, [cx, cy, cz]);
      min = [Math.min(min[0], x), Math.min(min[1], z)];
      max = [Math.max(max[0], x), Math.max(max[1], z)];
    }
  }
  return Number.isFinite(min[0]) ? Math.max(max[0] - min[0], max[1] - min[1]) : 0;
}

function imageSize(bytes, mime) {
  if (mime === 'image/png' && bytes.length >= 24) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (mime === 'image/jpeg') {
    for (let i = 2; i + 9 < bytes.length;) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5)];
      i += 2 + bytes.readUInt16BE(i + 2);
    }
  }
  return null;
}

export function checkGlb(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let parsed;
  try { parsed = parseGlb(buf); } catch (e) { parsed = null; }
  if (!parsed) return { ok: false, errors: ['not a binary glTF 2.0 (.glb) file'], warnings: [], summary: null, levels: [], rooms: [] };
  const { json, bin } = parsed;
  const m = buildManifest(gltfAdapter(json));
  const errors = [...m.errors], warnings = [...m.warnings];

  if (!m.levels.length && !m.rooms.length && !m.objects.length) warnings.push('no fp tags found: the card will show the model whole (see docs/model-builder-guide.md)');
  else {
    for (const role of ['exterior', 'roof']) if (!m.levels.some((l) => l.role === role)) warnings.push(`no level with role "${role}"`);
    for (const r of m.rooms) if (!r.outline) warnings.push(`${r.kind} "${r.id}" has no outline; the card uses its bounding box`);
  }

  // meshes larger than a plot inside storeys and basements
  const nodes = json.nodes || [];
  const storeyNodes = new Set(m.levels.filter((l) => l.role === 'storey' || l.role === 'basement').map((l) => l.node));
  const scene = (json.scenes || [])[json.scene ?? 0] || { nodes: [] };
  const walk = (i, parentWorld, inStorey, path) => {
    const n = nodes[i];
    const world = mul(parentWorld, local(n));
    const p = path ? `${path}/${n.name || i}` : (n.name || String(i));
    const storey = inStorey || storeyNodes.has(i);
    if (storey && n.mesh !== undefined) {
      const size = meshSize(json, n.mesh, world);
      if (size > MAX_MESH_M) warnings.push(`mesh ${p} is larger than ${MAX_MESH_M} m (${size.toFixed(0)} m) inside a storey; move ground planes and roads to the exterior level`);
    }
    for (const c of n.children || []) walk(c, world, storey, p);
  };
  for (const i of scene.nodes || []) walk(i, IDENT, false, '');

  (json.images || []).forEach((img, i) => {
    const bv = json.bufferViews && json.bufferViews[img.bufferView];
    if (!bv || !bin) return;
    const bytes = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    const size = imageSize(Buffer.from(bytes), img.mimeType);
    if (size && Math.max(...size) > MAX_TEXTURE_PX) warnings.push(`texture "${img.name || i}" is ${size[0]} × ${size[1]} px; keep textures at ${MAX_TEXTURE_PX} px or less`);
  });
  if (buf.length > MAX_FILE_MB * 1024 * 1024) warnings.push(`file is ${(buf.length / 1048576).toFixed(1)} MB; keep it under ${MAX_FILE_MB} MB`);

  return {
    ok: errors.length === 0, errors, warnings, summary: summarize(m),
    levels: m.levels.map((l) => ({ id: l.id, role: l.role, order: l.order, elevation: l.elevation })),
    rooms: m.rooms.map((r) => ({ kind: r.kind, id: r.id, level: r.level, area: (r.suggest && r.suggest.area) || null })),
  };
}

function main(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node tools/check-model.mjs house.glb [--json]');
    return 2;
  }
  const r = checkGlb(fs.readFileSync(file));
  if (argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
    return 0;
  }
  if (r.summary) {
    const objs = Object.entries(r.summary.objects).map(([t, n]) => `${n} ${t}`).join(', ') || 'none';
    console.log(`${file}: ${r.summary.levels} levels, ${r.summary.rooms} rooms, ${r.summary.zones} zones, objects: ${objs}`);
    for (const l of r.levels) console.log(`  level ${l.id} (${l.role}${l.order !== null ? ', order ' + l.order : ''}${l.elevation !== null ? ', elevation ' + l.elevation : ''})`);
  }
  for (const e of r.errors) console.log('ERROR ' + e);
  for (const w of r.warnings) console.log('warning ' + w);
  console.log(r.ok ? 'OK' : `${r.errors.length} error(s)`);
  return r.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
```

- [ ] **Step 4: Add the npm script and lint config**

In `package.json` `scripts` add `"check-model": "node tools/check-model.mjs"`.
In `eslint.config.js` change the node-globals entry to `files: ['scripts/**', 'test/**', 'tools/*.mjs', '*.config.js']` (keep `tools/export-glb.js` browser-only).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/check-model.test.js && npx eslint .`
Expected: PASS (7 tests), lint clean.

- [ ] **Step 6: Commit**

```bash
git add tools/check-model.mjs test/check-model.test.js package.json eslint.config.js
git commit -m "tools/check-model.mjs: validate a house model against the builder guide"
```

---

### Task 4: View — manifest, level visibility, picking

**Files:**

- Modify: `src/view.js` (model load at `setModel` onLoad ~line 210–235; `modelFloors`/`modelFloorGroups`/`setModelFloorMap` ~249–267; `_applyFloorVisibility` ~499–515)
- Test: `test/view-model.test.js` (new, jsdom-free: exercises the pure helpers exported from view)

**Interfaces:**

- Consumes: `buildManifest`, `threeAdapter` (Task 1).
- Produces on `FloorplanView`:
  - `this.model = { id, root, manifest }` (no more `floorNodes`)
  - `setModelLevels(assign: Record<levelId, {show, floor}>)`: stores and applies visibility
  - `pickModel(clientX, clientY): Entry | { kind: 'untagged', node, path } | null`: nearest tagged ancestor of the first visible, unclipped hit
  - `highlightModelNode(node | null)`: primary-coloured box helper around the node
  - exported helper `levelVisible(assign, visibleFloor): boolean` (pure, tested)
  - exported helper `fallbackOutline(box: {min:{x,z}, max:{x,z}}): [x,y][]`

- [ ] **Step 1: Write the failing tests**

```js
// test/view-model.test.js
import { describe, it, expect } from 'vitest';
import { levelVisible, fallbackOutline } from '../src/view.js';

describe('levelVisible', () => {
  it('follows the show mode', () => {
    expect(levelVisible({ show: 'with', floor: 'f1' }, 'f1')).toBe(true);
    expect(levelVisible({ show: 'with', floor: 'f1' }, 'f2')).toBe(false);
    expect(levelVisible({ show: 'with', floor: 'f1' }, 'all')).toBe(true);
    expect(levelVisible({ show: 'always', floor: null }, 'f2')).toBe(true);
    expect(levelVisible({ show: 'hidden', floor: null }, 'all')).toBe(false);
    expect(levelVisible({ show: 'all-only', floor: null }, 'f1')).toBe(false);
    expect(levelVisible({ show: 'all-only', floor: null }, 'all')).toBe(true);
    expect(levelVisible(undefined, 'f1')).toBe(true); // unknown: show
  });
});

describe('fallbackOutline', () => {
  it('is the plan rectangle of a world box (north = -z)', () => {
    expect(fallbackOutline({ min: { x: 1, z: -5 }, max: { x: 4, z: -2 } })).toEqual([[1, 2], [4, 2], [4, 5], [1, 5]]);
  });
});
```

(three.js imports work under vitest's node environment; `view.js` only touches `document`/`window` inside the class, so importing the helpers is safe. If the import fails because of `window`, move the two helpers into `src/bindings.js` instead and import them from there in `view.js`; keep the test names.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/view-model.test.js`
Expected: FAIL, "levelVisible is not exported".

- [ ] **Step 3: Implement in `src/view.js`**

Add the import and helpers near the top (after the existing imports):

```js
import { buildManifest, threeAdapter } from './manifest.js';

// Visibility of a model level for the selected floor ('all' or a floor id).
export function levelVisible(assign, visibleFloor) {
  if (!assign) return true;
  if (assign.show === 'hidden') return false;
  if (assign.show === 'always') return true;
  if (assign.show === 'all-only') return visibleFloor === 'all';
  return visibleFloor === 'all' || visibleFloor === assign.floor;
}

// Plan rectangle of a world-space box (used for rooms tagged without an outline).
export function fallbackOutline(box) {
  return [[box.min.x, -box.max.z], [box.max.x, -box.max.z], [box.max.x, -box.min.z], [box.min.x, -box.min.z]];
}
```

In `setModel`'s `onLoad`, replace the whole `nameOf` / `isFloor` / `floorNodes` block and the `this.model = { id, root, floorNodes };` line with:

```js
        const manifest = buildManifest(threeAdapter(root));
        // rooms tagged without an outline: use their footprint (root is not placed yet, so world = model space)
        root.updateMatrixWorld(true);
        for (const r of manifest.rooms) {
          if (r.outline) continue;
          const box = new THREE.Box3().setFromObject(r.node);
          if (box.isEmpty()) continue;
          r.outline = fallbackOutline(box);
          r.outlineFallback = true;
        }
```

and further down (where `this.model` is assigned):

```js
        this.model = { id, root, manifest };
```

Replace `modelFloors()`, `modelFloorGroups()` and `setModelFloorMap()` with:

```js
  modelManifest() {
    return this.model ? this.model.manifest : null;
  }

  // level id -> { show, floor } from the card's bindings
  setModelLevels(assign) {
    this.modelLevels = assign || {};
    this._applyFloorVisibility();
    this.dirty = true;
  }

  // The tagged part under a screen point: nearest tagged ancestor of the first visible hit below
  // the cut; untagged meshes come back as { kind: 'untagged' } so the UI can say so.
  pickModel(clientX, clientY) {
    if (!this.model) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const shown = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
    const hit = this.raycaster.intersectObject(this.model.root, true)
      .find((h) => h.object.isMesh && shown(h.object) && h.point.y <= this.modelClip.constant + 1e-6);
    if (!hit) return null;
    const owner = this.model.manifest.ownerOf(hit.object);
    if (owner) return owner;
    const names = [];
    for (let p = hit.object; p && p !== this.model.root; p = p.parent) names.unshift((p.userData && p.userData.name) || p.name || '?');
    return { kind: 'untagged', node: hit.object, path: names.join('/') };
  }

  highlightModelNode(node) {
    if (this.pickHelper) {
      this.scene.remove(this.pickHelper);
      this.pickHelper.geometry.dispose();
      this.pickHelper.material.dispose();
      this.pickHelper = null;
    }
    if (node) {
      this.pickHelper = new THREE.BoxHelper(node, this.theme.primary || 0x03a9f4);
      this.pickHelper.material.depthTest = false;
      this.pickHelper.renderOrder = 11;
      this.scene.add(this.pickHelper);
    }
    this.dirty = true;
  }
```

In `_applyFloorVisibility`, replace the `floorNodes` loop:

```js
    if (this.model) {
      const assign = this.modelLevels || {};
      for (const l of this.model.manifest.levels) l.node.visible = levelVisible(assign[l.id], this.visibleFloor);
      // everything above the cut-away height of the selected floor is clipped (roof, upper floors)
      const cut = this.visibleFloor === 'all' ? 1e6 : this.floorElevation(this.visibleFloor) + Math.max(this.wallHeight, 0.3);
      this.modelClip.constant = cut;
      if (this.pickHelper) this.pickHelper.update();
    }
```

In `_disposeModel()` add `this.highlightModelNode(null);` before clearing the group. Update the comment on the `this.model = null;` field in the constructor to `// { id, root, manifest }`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/view-model.test.js && npx eslint .`
Expected: PASS. (The card still calls the removed `modelFloorAssignment` path until Task 5; do not run the headless checks yet.)

- [ ] **Step 5: Commit**

```bash
git add src/view.js test/view-model.test.js
git commit -m "View: keep the model manifest, level visibility from bindings, pick and highlight parts"
```

---

### Task 5: Card — rooms and floors from the model

**Files:**

- Modify: `src/floorplan3d-card.js` (imports; `_loadModel` ~216–252; remove `modelFloorAssignment`/`_applyModelFloorMap` ~254–266; `_update` ~395–440; `_buildStructure` ~553–583; `_buildMarkers` ~585)
- Modify: `src/layout.js` (remove `modelFloorMap`), `test/layout.test.js` (remove its `describe('modelFloorMap')` block and import)
- Modify: `src/storage.js` `normalise` (migrate `model.floor_map`)
- Test: `test/storage.test.js` (one new case)

**Interfaces:**

- Consumes: Task 2 functions; `view.modelManifest()`, `view.setModelLevels()` (Task 4).
- Produces on the card (used by Task 6):
  - `modelBindings(): { manifest, levels: <resolveLevels result>, rooms: <resolveRoomAreas result>, diff } | null`
  - `_modelRooms: LayoutRoom[]` (current model rooms), `_allRooms(): LayoutRoom[]`
  - `_modelAlign(): { position, rotation, scale }`

- [ ] **Step 1: Write the failing storage test**

Add to `test/storage.test.js` inside `describe('normalise')`:

```js
  it('migrates the v0.1.4 model floor_map into level bindings', () => {
    expect(normalise({ model: { version: 'v', floor_map: { ground: 'floor1', attic: 'always' } } }).model)
      .toEqual({ version: 'v', levels: { ground: { floor: 'floor1' }, attic: { show: 'always' } } });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/storage.test.js`
Expected: FAIL (model still has `floor_map`).

- [ ] **Step 3: Migrate in `src/storage.js`**

```js
import { migrateModel } from './bindings.js';
```

and in `normalise` return object add `model: migrateModel(l.model || null),` after `hidden: …`. Run `npx vitest run test/storage.test.js` → PASS.

- [ ] **Step 4: Remove `modelFloorMap`**

Delete `export function modelFloorMap…` from `src/layout.js` and the `modelFloorMap` import plus its `describe('modelFloorMap', …)` block from `test/layout.test.js`.

- [ ] **Step 5: Wire bindings into the card**

Imports:

```js
import { mergeFloors, roomFloorId, markerPositions, lightGlow } from './layout.js';
import {
  resolveLevels, resolveRoomAreas, modelRooms, combineRooms, levelFloorOverrides, bindingDiff, levelsFromFloorMap,
} from './bindings.js';
```

Replace `modelFloorAssignment()` and `_applyModelFloorMap()` with:

```js
  _modelAlign() {
    const c = this._config;
    if (c.model) {
      return {
        position: Array.isArray(c.model_position) ? c.model_position.map(Number) : [0, 0, 0],
        rotation: Number(c.model_rotation) || 0, scale: Number(c.model_scale) || 1,
      };
    }
    const m = (this._layout && this._layout.model) || {};
    return { position: m.position || [0, 0, 0], rotation: m.rotation || 0, scale: m.scale || 1 };
  }

  // Saved level/room bindings (layout.model; YAML model_floors for URL models) resolved
  // against the loaded model and the current HA floors and areas.
  modelBindings() {
    const manifest = this._view && this._view.modelManifest();
    if (!manifest || !this._hass) return null;
    const saved = (this._layout && this._layout.model) || {};
    const savedLevels = { ...(this._config.model ? levelsFromFloorMap(this._config.model_floors) : {}), ...(saved.levels || {}) };
    const haFloors = mergeFloors(this._hass, { floors: [] });
    return {
      manifest,
      levels: resolveLevels(manifest.levels, haFloors, savedLevels),
      rooms: resolveRoomAreas(manifest.rooms, Object.keys(this._hass.areas || {}), saved.rooms || {}),
      diff: bindingDiff(manifest, saved),
    };
  }

  _allRooms() {
    return combineRooms(this._layout.rooms || [], this._modelRooms || []);
  }
```

In `_loadModel`, delete both `this._applyModelFloorMap();` calls and, inside the `.then`, replace the first-load fit condition with
`if (!err && firstLoad && this._view.model && !this._allRooms().length) this._view.fit();` and add `this._schedule();` (the manifest arrived: rebuild).

In `_update`, replace the structure condition and the model block:

```js
    const mb = this.modelBindings();
    const modelKey = mb ? JSON.stringify([mb.levels, mb.rooms, this._modelAlign()]) : '';
    if (structure || l.rooms !== b.rooms || l.floors !== b.lfloors || h.floors !== b.floors || h.areas !== b.areas
      || (mb && mb.manifest) !== b.manifest || modelKey !== b.modelKey) {
      b.manifest = mb && mb.manifest;
      b.modelKey = modelKey;
      this._buildStructure(mb);
      markers = true;
    }
```

and replace the existing `if (l.model !== b.model) { … } else if (markers) { this._applyModelFloorMap(); }` with:

```js
    if (l.model !== b.model) {
      b.model = l.model;
      this._loadModel();
    }
```

`_buildStructure(mb)`:

```js
  _buildStructure(mb) {
    const h = this._hass, b = this._built;
    b.rooms = this._layout.rooms;
    b.lfloors = this._layout.floors;
    b.floors = h.floors;
    b.areas = h.areas;
    const align = this._modelAlign();
    // a level bound to an HA floor gives that floor its elevation and height (user overrides win)
    const overrides = mb ? levelFloorOverrides(mb.manifest.levels, mb.levels, align) : [];
    this._floors = mergeFloors(h, { ...this._layout, floors: [...overrides, ...(this._layout.floors || [])] });
    this._modelRooms = mb ? modelRooms(mb.manifest.rooms, mb.levels, mb.rooms, align) : [];
    if (mb) this._view.setModelLevels(mb.levels);
    const rooms = this._allRooms().map((room) => ({
      room,
      floorId: roomFloorId(room, h, this._floors),
      label: room.name || (room.area_id ? areaName(h, room.area_id) : room.label || ''),
    }));
    // … rest unchanged from here (setStructure, floor selection, empty notice, toolbar, first fit)
```

`mergeFloors` builds its map from `layout.floors` with later entries winning, so user overrides listed after `overrides` win.

In `_buildMarkers`, replace `markerPositions(this._markers, this._layout, h, this._floors)` with
`markerPositions(this._markers, { ...this._layout, rooms: this._allRooms() }, h, this._floors)`.

Model walls: `wallSegments` runs over all rooms of a floor, so model rooms get cut-away walls too. With a model loaded those duplicate the model's own walls; pass `{ wallHeight, walls: !this._view.model }` to `setStructure` and in `src/view.js` `setStructure(floors, rooms, { wallHeight = 1.0, walls = true } = {})` skip the `for (const w of wallSegments(...))` loop when `walls` is false.

- [ ] **Step 6: Run unit tests and lint**

Run: `npx vitest run && npx eslint .`
Expected: all PASS (the removed `modelFloorMap` tests are gone; Tasks 1–4 tests pass).

- [ ] **Step 7: Commit**

```bash
git add src/floorplan3d-card.js src/layout.js src/storage.js src/view.js test/layout.test.js test/storage.test.js
git commit -m "Card: rooms, walls and floor heights from the model's levels and outlines"
```

---

### Task 6: Model tab — levels, rooms, report, click-to-pick

**Files:**

- Modify: `src/edit-mode.js` (`_modelTab` ~749; remove `_modelFloorsHtml` ~790 and the `md-floor` branch ~952; `_click` ~126; `setModelProps` (create `layout.model` when missing); `_roomsTab` area rows; `_onPanelClick`/`_onPanelChange`)
- Modify: `src/floorplan3d-card.js` STYLE (row highlight)

**Interfaces:**

- Consumes: `card.modelBindings()`, `card._modelRooms`, `view.pickModel()`, `view.highlightModelNode()` (Tasks 4–5).
- Produces (UI, `data-*` hooks used by Task 7's headless checks):
  - selects `data-field="md-level" data-id="<levelId>"`, values `floor:<haFloorId>` | `always` | `all-only` | `hidden`
  - selects `data-field="md-room" data-id="<roomId>"`, values `<areaId>` | `` (no area)
  - buttons `data-act="md-forget" data-kind="levels|rooms" data-id="<id>"` for missing bindings
  - rows `tr[data-pick="<kind>:<id>"]`, class `sel` on the picked row
  - `this.modelPick = { kind, id } | { kind: 'untagged', path } | null`

- [ ] **Step 1: Let `setModelProps` create the bindings object**

```js
  setModelProps(patch, rerender = true) {
    const cur = this.layout.model || {};
    this.card._commit({ ...this.layout, model: { ...cur, ...patch } });
    if (rerender) this.render();
  }
```

(`_loadModel` only downloads when `layout.model.version` is set, so a bindings-only object for a YAML model is harmless.)

- [ ] **Step 2: Render levels, rooms and the report**

Replace the `if (c.model) { return … }` early return in `_modelTab()` so a YAML model gets the note _and_ the binding tables:

```js
    if (c.model) {
      return `<p class="note warn">This card shows <b>${esc(c.model)}</b> from its YAML (<code>model:</code>).
        Remove <code>model</code> and the <code>model_*</code> options from the card YAML to upload and align the model here.</p>`
        + this._modelBindingsHtml();
    }
```

and in the uploaded-model branch replace `const floorInfo = this._modelFloorsHtml();` with `const floorInfo = this._modelBindingsHtml();`. Delete `_modelFloorsHtml()`. Add:

```js
  // Levels -> HA floors, rooms/zones -> HA areas, plus what changed since the last upload.
  _modelBindingsHtml() {
    const mb = this.card.modelBindings();
    if (!mb) return '<p class="dim">Loading model…</p>';
    const { manifest, levels, rooms, diff } = mb;
    const s = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const objCount = manifest.objects.length;
    let out = `<div class="sub">In the model</div><p class="hint">${s(manifest.levels.length, 'level')},
      ${s(manifest.rooms.filter((r) => r.kind === 'room').length, 'room')}, ${s(manifest.rooms.filter((r) => r.kind === 'zone').length, 'zone')},
      ${s(objCount, 'object')}${objCount ? ' (object controls come in a later version)' : ''}. Click a part of the model to find it here.</p>`;
    if (manifest.errors.length || manifest.warnings.length) {
      out += `<details class="report"><summary>${manifest.errors.length} error(s), ${manifest.warnings.length} warning(s)</summary><ul class="plain">`
        + manifest.errors.map((e) => `<li class="bad">${esc(e)}</li>`).join('')
        + manifest.warnings.map((w) => `<li class="dim">${esc(w)}</li>`).join('') + '</ul></details>';
    }
    const added = diff.levels.added.length + diff.rooms.added.length;
    const missing = diff.levels.missing.length + diff.rooms.missing.length;
    if ((added || missing) && (this.layout.model && (this.layout.model.levels || this.layout.model.rooms))) {
      out += `<p class="note warn">Since the last setup: ${added} new part(s) (assigned automatically below, marked auto)
        and ${missing} part(s) no longer in the model (kept below in case they come back).</p>`;
    }
    const sel = (k, id) => (this.modelPick && this.modelPick.kind !== 'untagged' && this.modelPick.id === id && k.includes(this.modelPick.kind) ? 'sel' : '');

    if (manifest.levels.length) {
      const opts = (v) => [
        ...this.floors.map((f) => [`floor:${f.id}`, 'with ' + f.name]),
        ['always', 'always shown'], ['all-only', 'only in "All"'], ['hidden', 'hidden'],
      ].map(([val, label]) => `<option value="${esc(val)}" ${val === v ? 'selected' : ''}>${esc(label)}</option>`).join('');
      out += '<div class="sub">Levels</div><table class="floors">' + manifest.levels.map((l) => {
        const a = levels[l.id];
        const v = a.show === 'with' ? `floor:${a.floor}` : a.show;
        return `<tr data-pick="level:${esc(l.id)}" class="${sel(['level'], l.id)}"><td title="${esc(l.role)}">${esc(l.label)}</td>
          <td><select data-field="md-level" data-id="${esc(l.id)}">${opts(v)}</select></td>
          <td class="dim">${a.stale ? '<span class="bad">floor deleted</span>' : a.auto ? 'auto' : ''}</td></tr>`;
      }).join('') + '</table>';
    }

    if (manifest.rooms.length) {
      const areas = Object.values(this.hass.areas || {}).sort((a, b) => a.name.localeCompare(b.name));
      const opts = (v) => `<option value="" ${v ? '' : 'selected'}>— no area —</option>`
        + areas.map((a) => `<option value="${esc(a.area_id)}" ${a.area_id === v ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
      out += '<div class="sub">Rooms and zones</div><table class="floors">' + manifest.rooms.map((r) => {
        const a = rooms[r.id];
        const note = a.stale ? '<span class="bad">area deleted</span>' : !levels[r.level] || !levels[r.level].floor
          ? 'level not on a floor' : r.outlineFallback ? 'no outline' : a.auto ? 'auto' : '';
        return `<tr data-pick="${r.kind}:${esc(r.id)}" class="${sel(['room', 'zone'], r.id)}"><td title="${esc(r.kind)} in ${esc(r.level || '?')}">${esc(r.label)}</td>
          <td><select data-field="md-room" data-id="${esc(r.id)}">${opts(a.area)}</select></td><td class="dim">${note}</td></tr>`;
      }).join('') + '</table>'
        + '<p class="hint">Rooms from the model replace rooms drawn for the same area. <a href="/config/areas/dashboard" target="_top">Create areas in Home Assistant</a>.</p>';
    }

    const gone = [...diff.levels.missing.map((id) => ['levels', id]), ...diff.rooms.missing.map((id) => ['rooms', id])];
    if (gone.length) {
      out += '<div class="sub">No longer in the model</div><ul class="plain">' + gone.map(([k, id]) =>
        `<li><code>${esc(id)}</code> <button class="link" data-act="md-forget" data-kind="${k}" data-id="${esc(id)}">Forget</button></li>`).join('') + '</ul>';
    }
    if (this.modelPick && this.modelPick.kind === 'untagged') {
      out += `<p class="note warn">“${esc(this.modelPick.path)}” is not tagged in the model, so it can't be assigned.
        Ask the model builder to tag it (docs/model-builder-guide.md).</p>`;
    }
    return out;
  }
```

- [ ] **Step 3: Handle changes, forget and picking**

In `_onPanelChange`, replace the `md-floor` branch with:

```js
    } else if (f === 'md-level') {
      const v = el.value;
      const b = v.startsWith('floor:') ? { floor: v.slice(6) } : { show: v };
      const m = this.layout.model || {};
      this.setModelProps({ levels: { ...(m.levels || {}), [el.dataset.id]: b } });
    } else if (f === 'md-room') {
      const m = this.layout.model || {};
      this.setModelProps({ rooms: { ...(m.rooms || {}), [el.dataset.id]: { area: el.value || null } } });
```

In `_onPanelClick` add:

```js
      case 'md-forget': {
        const m = this.layout.model || {};
        const k = btn.dataset.kind;
        const next = { ...(m[k] || {}) };
        delete next[id];
        this.setModelProps({ [k]: next });
        return;
      }
```

At the top of `_click(e)` (after the calibrating block) add:

```js
    if (this.tab === 'model' && this.view.model && !this.drawing) {
      const owner = this.view.pickModel(e.clientX, e.clientY);
      this.modelPick = owner ? (owner.kind === 'untagged' ? { kind: 'untagged', path: owner.path } : { kind: owner.kind, id: owner.id }) : null;
      this.view.highlightModelNode(owner ? owner.node : null);
      this.render();
      const row = this.panel.querySelector('tr.sel');
      if (row) row.scrollIntoView({ block: 'nearest' });
      return;
    }
```

Markers must not swallow picking clicks: in `_syncStageClasses()` add
`this.card._stage.classList.toggle('picking', this.tab === 'model' && !!this.view.model);` and call `this._syncStageClasses()` at the end of the `case 'tab':` branch.

In `exit()` add `this.modelPick = null; this.view.highlightModelNode(null);`. When switching away from the Model tab (`case 'tab':`) also clear the highlight: `if (id !== 'model') { this.modelPick = null; this.view.highlightModelNode(null); }`.

- [ ] **Step 4: Rooms tab shows areas covered by the model**

In `_roomsTab()`, the area loop currently reads:

```js
      for (const a of list) {
        const r = rooms.find((x) => x.area_id === a.area_id);
        out += `<li class="${r && r.id === this.selectedRoom ? 'sel' : ''}">…`;
      }
```

Insert, as the first statements inside that loop (before `const r = …`):

```js
        const mr = (this.card._modelRooms || []).find((x) => x.area_id === a.area_id);
        if (mr) {
          out += `<li><span class="name">${esc(a.name)}</span><span class="pill ok">model</span>
            <button data-act="tab" data-id="model">Model</button></li>`;
          continue;
        }
```

- [ ] **Step 5: Style the picked row**

In `src/floorplan3d-card.js` STYLE add:

```css
  .panel tr.sel td { background: rgba(3,169,244,.12); }
  .stage.picking .fp-marker, .stage.picking .fp-handle { pointer-events: none; opacity: .45; }
  .panel details.report { margin: 6px 0; font-size: 12px; }
  .panel details.report summary { cursor: pointer; color: var(--secondary-text-color); }
```

- [ ] **Step 6: Build, lint, unit tests**

Run: `npm run build && npx eslint . && npx vitest run`
Expected: build ok, lint clean, all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/edit-mode.js src/floorplan3d-card.js
git commit -m "Model tab: assign levels and rooms, report, regeneration notice, click to pick"
```

---

### Task 7: Demo model v2, headless checks, docs

**Files:**

- Modify: `scripts/make-demo-model.mjs`, regenerate `demo/house.glb`
- Modify: `scripts/model-check.mjs` (replace `modelFloors()` / `modelFloorAssignment()` / `md-floor` checks)
- Modify: `README.md` (Model section), `docs/model-builder-guide.md` (validator now exists), `package.json` version → `0.2.0`, `custom_components/floorplan3d/manifest.json` version → `0.2.0`, `src/floorplan3d-card.js` `VERSION` → `'0.2.0'`

**Interfaces:**

- Consumes: everything above. Demo HA floors are `ground` (level 0) and `first` (level 1); demo areas include `kitchen`, `living_room`, `garden`, `terrace`.

- [ ] **Step 1: Tag the demo model**

In `scripts/make-demo-model.mjs` set tags (GLTFExporter writes `userData` to `extras`):

```js
// after creating each floor group g for id ('ground' | 'first') with elevation f.elevation / height f.height:
g.name = id === 'ground' ? 'level0' : 'level1';           // ids deliberately differ from HA floor ids
g.userData.fp = { kind: 'level', id: g.name, role: 'storey', order: id === 'ground' ? 0 : 1, elevation: f.elevation, height: f.height };
// for each indoor room r of that floor, wrap its slab in a room group:
const rg = new THREE.Group();
rg.name = r.area_id;
rg.userData.fp = { kind: 'room', id: r.area_id, outline: r.polygon, doors: r.doors || [], suggest: { area: r.area_id } };
rg.add(slab);
g.add(rg);
// exterior level with the outdoor rooms as zones (slab per zone), roof level:
const ext = new THREE.Group();
ext.name = 'exterior';
ext.userData.fp = { kind: 'level', id: 'exterior', role: 'exterior' };
roof.userData.fp = { kind: 'level', id: 'roof', role: 'roof' };
// one object to show the count (bound in a later plan):
lampGroup.userData.fp = { kind: 'object', id: 'terrace_lamp_1', type: 'light', suggest: { domain: 'light', area: 'terrace' } };
```

Keep room slab, walls and furniture geometry as today. Run `node scripts/make-demo-model.mjs` and `node tools/check-model.mjs demo/house.glb`.
Expected: `OK`, `2 storey levels + exterior + roof`, rooms listed, no errors.

- [ ] **Step 2: Rewrite the model checks in `scripts/model-check.mjs`**

Replace every use of `_view.modelFloors()` with `_view.modelManifest().levels.map((l) => l.id)`, `modelFloorAssignment()` with `modelBindings().levels` (compare `.floor`/`.show`), `data-field=md-floor` with `data-field=md-level` (values `floor:<id>` / `always` / `hidden`), and `_layout.model.floor_map` with `_layout.model.levels`. Then add these checks after the upload of `demo/house.glb`:

```js
  const lv = () => page.evaluate(`JSON.stringify(Object.fromEntries(Object.entries(${card}.modelBindings().levels).map(([k, v]) => [k, v.show + ':' + v.floor])))`);
  check('levels map by order, exterior with ground, roof all-only',
    (await lv()) === JSON.stringify({ level0: 'with:ground', level1: 'with:first', exterior: 'with:ground', roof: 'all-only:null' }));
  check('rooms come from the model', await page.evaluate(`${card}._modelRooms.some((r) => r.id === 'm:kitchen' && r.floor_id === 'ground')`));
  check('model room replaces the drawn kitchen', await page.evaluate(`${card}._allRooms().filter((r) => r.area_id === 'kitchen').length === 1`));
  // rotation moves the rooms with the model
  const k0 = await page.evaluate(`JSON.stringify(${card}._modelRooms.find((r) => r.id === 'm:kitchen').polygon[1])`);
  await page.evaluate(`(() => { const s = ${card}.shadowRoot.querySelector('[data-field=md-rotation]'); s.value = '90'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(300);
  check('rotation moves rooms', (await page.evaluate(`JSON.stringify(${card}._modelRooms.find((r) => r.id === 'm:kitchen').polygon[1])`)) !== k0);
  await page.evaluate(`(() => { const s = ${card}.shadowRoot.querySelector('[data-field=md-rotation]'); s.value = '0'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  // assign a room to another area and back to none
  await page.evaluate(`(() => { const s = ${card}.shadowRoot.querySelector('[data-field=md-room][data-id=kitchen]'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(200);
  check('room binding saved', JSON.stringify(await page.evaluate(`${card}._layout.model.rooms`)) === '{"kitchen":{"area":null}}');
  // click to pick: the kitchen floor in top view
  await page.evaluate(`${card}._setMode('top')`);
  await page.evaluate(`${card}._view.fit({ model: true })`);
  await sleep(300);
  const pt = await page.evaluate(`${card}._view.screenPoint(9.5, 2, 0, 'ground')`);
  await page.mouse.click(pt[0], pt[1]);
  await sleep(200);
  check('click picks the room', JSON.stringify(await page.evaluate(`${card}._edit.modelPick`)) === '{"kind":"room","id":"kitchen"}'
    && await page.evaluate(`!!${card}.shadowRoot.querySelector('tr.sel[data-pick="room:kitchen"]')`));
```

Replace the existing "renamed groups" check: rename `"id":"level0"` / `"id":"level1"` to `"id":"lvl_a0"` / `"id":"lvl_a1"` (same length, so a byte replace on the latin1 string keeps the GLB valid) and expect `{ lvl_a0: 'with:ground', lvl_a1: 'with:first', … }`.

Add an "untagged model" check with a stripped copy of the demo model:

```js
function rewriteGlbJson(buf, edit) {
  const jsonLen = buf.readUInt32LE(12);
  const json = edit(JSON.parse(buf.toString('utf8', 20, 20 + jsonLen)));
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const rest = buf.subarray(20 + jsonLen); // BIN chunk unchanged
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + j.length + rest.length, 8);
  head.writeUInt32LE(j.length, 12); head.write('JSON', 16, 'latin1');
  return Buffer.concat([head, j, rest]);
}
const untagged = path.join(root, 'screenshots', 'untagged.glb');
fs.writeFileSync(untagged, rewriteGlbJson(fs.readFileSync(path.join(root, 'demo', 'house.glb')), (json) => {
  for (const n of json.nodes || []) delete n.extras;
  return json;
}));
await upload(untagged);
await page.waitForFunction(`${card}._view.model && ${card}._view.modelManifest().levels.length === 0`, { timeout: 10000 });
fs.unlinkSync(untagged);
check('untagged model loads whole', await page.evaluate(`${card}._view.model.root.visible && ${card}._modelRooms.length === 0`));
```

(Upload the tagged demo model again afterwards for the remaining checks.)

- [ ] **Step 3: Run the headless checks**

Run: `npm run build && node scripts/model-check.mjs && node scripts/edit-check.mjs && node scripts/screenshot.mjs`
Expected: `all model checks passed`, `all edit checks passed`, screenshot saved, no page errors.

- [ ] **Step 4: Docs and version**

- `README.md` → "3D model underlay": tagged models (link to `docs/model-builder-guide.md`), levels and rooms assigned in Edit → Model, click to find a part, `npm run check-model -- house.glb`.
- `docs/model-builder-guide.md` → checklist line: "`node tools/check-model.mjs house.glb` (in the floorplan3d-card repository) reports OK".
- Bump versions to `0.2.0` in `package.json`, the integration manifest and `VERSION`; `npm install --package-lock-only`.

- [ ] **Step 5: Full verification and commit**

Run: `npx eslint . && npx vitest run && python -m pytest -q` (Python venv per README) `&& node scripts/model-check.mjs`
Expected: all green.

```bash
git add -A
git commit -m "Demo model v2 with fp tags, headless checks for model levels and rooms, docs, v0.2.0"
```

---

## Self-review notes

- Spec §1 (tags, name fallback, legacy, untagged) → Task 1; §2 levels/rooms bindings, defaults, `floor_map` migration → Tasks 2, 5; §2 `orphans` → implemented as derived `diff.missing` with "Forget" (bindings stay keyed by id, so a returning id restores them without a separate map; simpler than the spec's stored `orphans`, same behaviour); §2 `objects` / `path:` bindings → plan 2; §3 rooms from the model, model wins, elevation/height from levels → Tasks 2, 5; §4 Model tab lists, picking, untagged hint → Task 6 (object panel → plan 2); §8 validator → Task 3; §9 errors as report, stale bindings → Tasks 1, 2, 6; §10 tests → every task + Task 7.
- Names used across tasks: `buildManifest`, `threeAdapter`, `gltfAdapter`, `summarize`, `resolveLevels`, `resolveRoomAreas`, `modelRooms`, `combineRooms`, `levelFloorOverrides`, `bindingDiff`, `levelsFromFloorMap`, `migrateModel`, `transformPoint`, `levelVisible`, `fallbackOutline`, `modelManifest`, `setModelLevels`, `pickModel`, `highlightModelNode`, `modelBindings`, `_allRooms`, `_modelRooms`, `_modelAlign`, `modelPick`: consistent.
