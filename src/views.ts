// Views: what each floor button shows. Pure: works on a node index built through the same adapter
// as the manifest, so it is testable without three.js.

import type { Floor, LayoutView, SavedLevelBinding, SectionPlaneConfig, TopCamera, Vec3, ViewCamera, ViewRule } from './types/layout.js';
import type { CardConfig } from './types/config.js';
import type { Manifest, ManifestEntry, ManifestLevel, ManifestView, ModelAdapter } from './types/manifest.js';

export type SelectorKind = 'all' | 'level' | 'role' | 'room' | 'zone' | 'object' | 'type' | 'group' | 'tag' | 'layer' | 'node';
export interface Selector { kind: SelectorKind; value: string | null }

const KINDS: readonly string[] = ['all', 'level', 'role', 'room', 'zone', 'object', 'type', 'group', 'tag', 'layer', 'node'];

/** The tag of an index node (the manifest entry it carries); tags: resolved object tags, written by the card. */
export interface NodeTag {
  kind: ManifestEntry['kind'];
  id: string;
  role: string | null;
  type: string | null;
  group: string | null;
  tags?: string[];
}

/** One node of the model tree: parent / children are positions in index.nodes (-1 = root). */
export interface NodeInfo<N = unknown> {
  node: N;
  parent: number;
  children: number[];
  path: string;
  seg: string;
  name: string;
  dup: number | null;
  layers: string[];
  tag: NodeTag | null;
  levelId: string | null;
}
export interface NodeIndex<N = unknown> { nodes: NodeInfo<N>[] }

/** Visibility per index node, plus non-enumerable detail arrays (see resolveVisibility). */
export type Visibility = boolean[] & { selfHidden?: boolean[]; keptOnly?: boolean[]; kept?: boolean[] };

/** The level fields the view logic reads (tests pass partial levels). */
export type ViewLevel = Pick<ManifestLevel, 'id'> & Partial<Pick<ManifestLevel, 'role' | 'order' | 'minY' | 'label' | 'node'>>;

export type ZoomTo = 'center' | 'cursor';
export type ViewSource = 'floors' | 'model' | 'generated' | 'added';

/** A view after merging model / generated views with layout and card YAML overrides. */
export interface ResolvedView {
  id: string;
  label: string;
  rules: ViewRule[];
  camera: ViewCamera | null;
  cameraFrame: 'model' | 'card';
  camera_topFrame: 'model' | 'card';
  floors: string[] | null;
  cut: boolean | null;
  source: ViewSource;
  hidden: boolean;
  section: SectionPlaneConfig | null;
  modelSection: SectionPlaneConfig | null;
  camera_top: TopCamera | null;
  zoom_to: ZoomTo | null;
}

/** Axis-aligned box in card world. */
export interface Box3Like { min: Vec3 | number[]; max: Vec3 | number[] }

export function parseSelector(s: unknown): Selector | null {
  if (typeof s !== 'string' || !s) return null;
  if (s === 'all') return { kind: 'all', value: null };
  const i = s.indexOf(':');
  if (i < 1) return null;
  const kind = s.slice(0, i), value = s.slice(i + 1);
  return KINDS.includes(kind) && value ? { kind: kind as SelectorKind, value } : null; // checked against KINDS
}

// Path segments escape \\ * / # in names with a backslash; a name shared by several siblings gets
// "#<n>" (0-based among them) so every node path is unique.
export const escapeName = (name: unknown): string => String(name).replace(/[\\*/#]/g, '\\$&');

const globCache = new Map<string, RegExp>();
function globRe(pattern: string): RegExp {
  let re = globCache.get(pattern);
  if (re) return re;
  const reEsc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  // split on unescaped '/', keeping escapes inside segments
  const segs: string[] = [];
  let cur = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) { cur += c + pattern[++i]; continue; }
    if (c === '/') { segs.push(cur); cur = ''; continue; }
    cur += c;
  }
  segs.push(cur);
  const segRe = (seg: string): string => {
    let out = '';
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i];
      if (c === '\\' && i + 1 < seg.length) out += reEsc(c + seg[++i]); // literal (paths keep the escape)
      else if (c === '*') out += '(?:\\\\.|[^/\\\\])*';
      else out += reEsc(c);
    }
    return out;
  };
  const list = segs.filter((seg, i, a) => !(seg === '**' && a[i - 1] === '**'));
  let body = '';
  list.forEach((seg, i) => {
    const last = i === list.length - 1;
    if (seg === '**') body += last ? '.*' : '(?:.*/)?';
    else body += segRe(seg) + (last ? '' : '/');
  });
  re = new RegExp('^' + body + '$');
  globCache.set(pattern, re);
  return re;
}

export function nodeIndex<N>(adapter: ModelAdapter<N>, manifest: Pick<Manifest<N>, 'byNode'>): NodeIndex<N> {
  const nodes: NodeInfo<N>[] = [];
  type Seg = { seg: string; dup: number | null };
  // unique path segment per sibling list; a node stamped with fpSeg (its segment before static meshes
  // were merged away from its sibling list) keeps it, so node: rules stay valid after merging
  const stamped = (n: N): Seg | null => { const e = adapter.extras(n) || {}; return typeof e.fpSeg === 'string' ? { seg: e.fpSeg, dup: Number.isInteger(e.fpDup) ? (e.fpDup as number) : null } : null; };
  const segments = (list: N[]): Seg[] => {
    const names = list.map((n) => (stamped(n) ? null : adapter.name(n)));
    const count = new Map<string, number>(), seen = new Map<string, number>();
    for (const n of names) if (n !== null) count.set(n, (count.get(n) || 0) + 1);
    return names.map((n, i) => {
      if (n === null) return stamped(list[i])!; // null names are the stamped nodes
      if ((count.get(n) ?? 0) < 2) return { seg: escapeName(n), dup: null };
      const k = seen.get(n) || 0;
      seen.set(n, k + 1);
      return { seg: escapeName(n) + '#' + k, dup: k };
    });
  };
  const walk = (node: N, parent: number, parentPath: string, levelId: string | null, { seg, dup }: Seg): void => {
    const name = adapter.name(node);
    const path = parentPath ? `${parentPath}/${seg}` : seg;
    const entry = manifest.byNode.get(node) || null;
    const fp = ((adapter.extras(node) || {}).fp || {}) as { layer?: unknown };
    const layers = Array.isArray(fp.layer) ? fp.layer.filter((x): x is string => typeof x === 'string') : typeof fp.layer === 'string' ? [fp.layer] : [];
    const tag: NodeTag | null = entry ? {
      kind: entry.kind, id: entry.id, role: ('role' in entry && entry.role) || null,
      type: ('type' in entry && entry.type) || null, group: ('group' in entry && entry.group) || null,
    } : null;
    const lvl = entry && entry.kind === 'level' ? entry.id : levelId;
    const i = nodes.length;
    nodes.push({ node, parent, children: [], path, seg, name, dup, layers, tag, levelId: lvl });
    if (parent >= 0) nodes[parent].children.push(i);
    const kids = adapter.children(node);
    const segs = segments(kids);
    kids.forEach((c, k) => walk(c, i, path, lvl, segs[k]));
  };
  const roots = adapter.roots();
  const rootSegs = segments(roots);
  roots.forEach((r, k) => walk(r, -1, '', null, rootSegs[k]));
  return { nodes };
}

export function matches(sel: Selector | null | undefined, info: Pick<NodeInfo, 'tag' | 'layers' | 'path'>): boolean {
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
    // object tags (the card writes the resolved tags into the index: info.tag.tags), else fp.group
    case 'tag': return !!t && t.kind === 'object' && (Array.isArray(t.tags) ? t.tags.includes(sel.value!) : t.group === sel.value); // non-'all' selectors have a value
    case 'layer': return info.layers.includes(sel.value!);
    case 'node': return globRe(sel.value!).test(info.path);
    default: return false;
  }
}

const ruleSel = (r: ViewRule | null | undefined): Selector | null => parseSelector(r && (r.show ?? r.hide));

// selectors that pick model objects themselves (a hide with keep_objects never keeps what they hide)
const OBJECT_SELS = new Set<string>(['object', 'type', 'group', 'tag']);
const flagArray = (arr: boolean[], name: string, values: boolean[]): boolean[] => Object.defineProperty(arr, name, { value: values, enumerable: false });

// Effective visibility per index node. A hide rule with keep_objects: true hides the matched parts' surfaces
// but keeps the model objects inside them (lamps nested in a zone) visible, unless an object-level rule
// (object: / type: / group: / tag:) hides them. Extra (non-enumerable) arrays on the result:
// selfHidden[i]: on only to keep a descendant visible, its own geometry must not render;
// keptOnly[i]: on only because of kept objects (the room / zone itself counts as hidden); kept[i]: a kept object node.
export function resolveVisibility(index: NodeIndex, rules: readonly (ViewRule | null | undefined)[] | null | undefined, defaultVisible = true): Visibility {
  const parsed = (rules || []).map((r) => ({ sel: ruleSel(r), show: !!r && r.show !== undefined, keep: !!r && r.show === undefined && r.keep_objects === true }));
  // a rule applies to the matched node and cascades to its descendants; the latest rule in order wins
  const n = index.nodes.length;
  const resolved = new Array<boolean>(n), kept = new Array<boolean>(n).fill(false);
  const decided = new Array<number>(n); // index of the winning rule, -1 = none
  const inObj = new Array<boolean>(n), objD = new Array<number>(n); // inside an object's subtree; winning object-level rule there
  index.nodes.forEach((info, i) => {
    const par = info.parent;
    let d = par >= 0 ? decided[par] : -1;
    parsed.forEach((r, k) => { if (k > d && r.sel && matches(r.sel, info)) d = k; });
    decided[i] = d;
    resolved[i] = d >= 0 ? parsed[d].show : defaultVisible;
    inObj[i] = (!!info.tag && info.tag.kind === 'object') || (par >= 0 && inObj[par]);
    let od = par >= 0 && inObj[par] ? objD[par] : -1;
    if (inObj[i]) parsed.forEach((r, k) => { if (k > od && r.sel && OBJECT_SELS.has(r.sel.kind) && matches(r.sel, info)) od = k; });
    objD[i] = od;
    if (!resolved[i] && inObj[i] && d >= 0 && parsed[d].keep && !OBJECT_SELS.has(parsed[d].sel!.kind) && !(od >= 0 && !parsed[od].show)) {
      resolved[i] = true;
      kept[i] = true;
    }
  });
  // a visible descendant keeps its ancestors on (their other children still use their own value);
  // first for plainly visible nodes, then for kept objects (ancestors on only for those: keptOnly)
  const effective = resolved.slice();
  const keptOnly = new Array<boolean>(n).fill(false);
  for (const pass of [false, true]) {
    for (let i = n - 1; i >= 0; i--) {
      if (!resolved[i] || kept[i] !== pass) continue;
      for (let p = index.nodes[i].parent; p >= 0 && !effective[p]; p = index.nodes[p].parent) { effective[p] = true; keptOnly[p] = pass; }
    }
  }
  flagArray(effective, 'selfHidden', effective.map((on, i) => on && !resolved[i]));
  flagArray(effective, 'keptOnly', keptOnly);
  flagArray(effective, 'kept', kept);
  return effective as Visibility; // the detail arrays were just defined on it
}

// Node i is shown in its own right (not only for objects kept inside a hidden part): levels, rooms and
// zones count as hidden when only their kept objects are on.
export const shownHere = (effective: Visibility, i: number): boolean => !!effective[i] && !(effective.keptOnly && effective.keptOnly[i]) && !(effective.kept && effective.kept[i]);

export function unmatchedSelectors(index: NodeIndex, rules: readonly (ViewRule | null | undefined)[] | null | undefined): string[] {
  const out: string[] = [];
  for (const r of rules || []) {
    const s = r && (r.show ?? r.hide);
    const sel = parseSelector(s);
    if (typeof s === 'string' && (!sel || !index.nodes.some((n) => matches(sel, n)))) out.push(s);
  }
  return [...new Set(out)];
}

const byOrder = (a: ViewLevel, b: ViewLevel): number => (a.order ?? 0) - (b.order ?? 0) || (a.minY ?? 0) - (b.minY ?? 0);
const isStorey = (l: ViewLevel): boolean => l.role === 'storey' || l.role === 'basement';

export function modelViewRules(v: Partial<Pick<ManifestView, 'show' | 'hide'>>): ViewRule[] {
  const show = (v.show || []).map((s): ViewRule => ({ show: s }));
  const hide = (v.hide || []).map((s): ViewRule => ({ hide: s }));
  return show.length ? [{ hide: 'all' }, ...show, ...hide] : hide;
}

export interface BaseView { id: string; label: string; rules: ViewRule[] }

export function generatedViews(levels: readonly ViewLevel[]): BaseView[] {
  const storeys = levels.filter(isStorey).sort(byOrder);
  const out = storeys.map((l, i): BaseView => ({
    id: l.id, label: l.label || l.id,
    rules: [{ hide: 'all' }, ...storeys.slice(0, i + 1).map((s) => ({ show: 'level:' + s.id })), { show: 'role:exterior' }],
  }));
  out.push({ id: 'all', label: 'All', rules: [] });
  return out;
}

type SavedLevels = Record<string, SavedLevelBinding | null | undefined>;
export interface MigratedRules { all: ViewRule[]; floorViews: ViewRule[] }

export function migrateShowModes(savedLevels: SavedLevels | null | undefined): MigratedRules {
  const all: ViewRule[] = [], floorViews: ViewRule[] = [];
  for (const [id, b] of Object.entries(savedLevels || {})) {
    if (!b || typeof b !== 'object') continue;
    if (b.show === 'hidden') all.push({ hide: 'level:' + id });
    else if (b.show === 'always') all.push({ show: 'level:' + id });
    else if (b.show === 'all-only') floorViews.push({ hide: 'level:' + id });
  }
  return { all, floorViews };
}

// Per-view migrated rules: all-only levels stay visible in their own view; `only` levels are hidden
// in the views of lower storeys.
function migratedRules(viewId: string, mig: MigratedRules, savedLevels: SavedLevels | null | undefined, levels: readonly ViewLevel[]): ViewRule[] {
  if (viewId === 'all') return mig.all;
  const order = new Map(levels.map((l) => [l.id, l.order ?? 0]));
  const own = order.get(viewId) ?? 0;
  const only = Object.entries(savedLevels || {})
    .filter(([id, b]) => b && b.show === 'only' && order.has(id) && own < order.get(id)!)
    .map(([id]): ViewRule => ({ hide: 'level:' + id }));
  return [...mig.all, ...mig.floorViews.filter((r) => r.hide !== 'level:' + viewId), ...only];
}

const isCam = (c: unknown): c is ViewCamera => !!c && Array.isArray((c as ViewCamera).position) && Array.isArray((c as ViewCamera).target);

// ---------- camera: top-view camera, zoom pivot, rotation centre ----------
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

// Top-view camera { center: [x, y] plan metres, zoom > 0 } (copied), or null.
export function normTopCamera(c: unknown): TopCamera | null {
  if (!c || typeof c !== 'object') return null;
  const t = c as { center?: unknown; zoom?: unknown };
  if (!Array.isArray(t.center) || t.center.length !== 2) return null;
  if (!t.center.every(finite) || !finite(t.zoom) || !(t.zoom > 0)) return null;
  return { center: [t.center[0], t.center[1]], zoom: t.zoom };
}

export const ZOOM_TO: readonly ZoomTo[] = ['center', 'cursor'];
const zoomOk = (z: unknown): ZoomTo | null => ((ZOOM_TO as readonly unknown[]).includes(z) ? (z as ZoomTo) : null);

// Zoom pivot: the view's zoom_to, else the card option, else 'center' (zoom and rotate around the target).
export const zoomToFor = (view: { zoom_to?: unknown } | null | undefined, config: Pick<CardConfig, 'zoom_to'> | null | undefined): ZoomTo => zoomOk(view && view.zoom_to) || zoomOk(config && config.zoom_to) || 'center';

const cm = (x: number): number => Math.round(x * 100) / 100 + 0;

// Rotation centre: target moves to point, the camera by the same delta (same angle and distance).
export function pivotCamera(cam: { position: readonly number[]; target: readonly number[] }, point: readonly number[]): { position: number[]; target: number[] } {
  const d = point.map((v, i) => v - cam.target[i]);
  return { position: cam.position.map((v, i) => cm(v + d[i])), target: point.map(cm) };
}

// Ray origin + t·dir (t > 0) on the horizontal plane at height y, or null.
export function rayPlaneY(origin: readonly number[], dir: readonly number[], y: number): number[] | null {
  if (Math.abs(dir[1]) < 1e-9) return null;
  const t = (y - origin[1]) / dir[1];
  if (!(t > 0)) return null;
  return origin.map((v, i) => (i === 1 ? y : v + dir[i] * t));
}

// Stored top zoom: 1 = 10 m half height (TOP_REF_HALF), independent of the fitted frustum.
export const TOP_REF_HALF = 10;
export const orthoZoom = (zoom: number, half: number): number => (zoom * half) / TOP_REF_HALF;
export const topZoom = (ortho: number, half: number): number => (ortho * TOP_REF_HALF) / half;
const obj = (o: unknown): LayoutView => (o && typeof o === 'object' && !Array.isArray(o) ? (o as LayoutView) : {});

const warned = new Set<string>();

interface ViewBase extends BaseView {
  floors: string[] | null;
  source: ViewSource;
  camera?: ViewCamera | null;
  section?: SectionPlaneConfig;
  camera_top?: TopCamera;
}

export interface ResolveViewsInput {
  manifest?: Pick<Manifest, 'views'> & { levels?: ViewLevel[] } | null;
  haFloors?: readonly Pick<Floor, 'id' | 'name'>[] | null;
  layoutViews?: unknown;
  yamlViews?: unknown;
  savedLevels?: SavedLevels | null;
}

export function resolveViews({ manifest, haFloors, layoutViews, yamlViews, savedLevels }: ResolveViewsInput): ResolvedView[] {
  let base: ViewBase[];
  haFloors = haFloors || [];
  const mLevels = (manifest && manifest.levels) || [];
  if (!manifest) {
    base = [...haFloors.map((f): ViewBase => ({ id: f.id, label: f.name, rules: [], floors: [f.id], source: 'floors' })),
      { id: 'all', label: 'All', rules: [], floors: null, source: 'floors' }];
  } else if (manifest.views && manifest.views.length) {
    base = manifest.views.filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i)
      .map((v): ViewBase => ({ id: v.id, label: v.label || v.id, rules: modelViewRules(v), camera: v.camera, floors: null, source: 'model', section: v.section, camera_top: v.camera_top }));
  } else {
    const mig = migrateShowModes(savedLevels);
    base = generatedViews(mLevels).map((v): ViewBase => ({
      ...v, floors: null, source: 'generated',
      rules: [...v.rules, ...migratedRules(v.id, mig, savedLevels, mLevels)],
    }));
  }
  const lv = obj(layoutViews), yv = obj(yamlViews);
  const added = Object.entries(lv).filter(([id, v]) => obj(v).added && !base.some((b) => b.id === id))
    .map(([id, v]): ViewBase => ({ id, label: obj(v).label || id, rules: [], floors: null, source: 'added' }));
  const all: ViewBase[] = [...base, ...added];
  for (const id of Object.keys(yv)) {
    if (!all.some((b) => b.id === id) && !warned.has(id)) {
      warned.add(id);
      console.warn(`floorplan3d: card YAML views.${id} does not match any view; ignored`);
    }
  }
  return all.map((b): ResolvedView => {
    const l = obj(lv[b.id]), y = obj(yv[b.id]);
    const pick = (k: string, d: unknown): unknown => (y[k] !== undefined ? y[k] : l[k] !== undefined ? l[k] : d);
    const rules = [...b.rules, ...(Array.isArray(l.rules) ? l.rules : []), ...(Array.isArray(y.rules) ? y.rules : [])].map((r): ViewRule => ({ ...r }));
    const cam = isCam(y.camera) ? y.camera : isCam(l.camera) ? l.camera : b.camera;
    const camera: ViewCamera | null = isCam(cam) ? { position: [...cam.position], target: [...cam.target] } : null;
    // model cameras are in model world (aligned when used); layout / YAML cameras are card world
    const cameraFrame: ResolvedView['cameraFrame'] = camera && cam === b.camera && b.source === 'model' ? 'model' : 'card';
    const fl = Array.isArray(y.floors) ? y.floors : Array.isArray(l.floors) ? l.floors : b.floors;
    const floors = Array.isArray(fl) ? [...fl] : null;
    const section = normSection(y.section !== undefined ? y.section : l.section);
    const camera_top = normTopCamera(y.camera_top) || normTopCamera(l.camera_top) || normTopCamera(b.camera_top);
    const camera_topFrame: ResolvedView['camera_topFrame'] = camera_top && !normTopCamera(y.camera_top) && !normTopCamera(l.camera_top) && b.source === 'model' ? 'model' : 'card';
    const zoom_to = zoomOk(y.zoom_to) || zoomOk(l.zoom_to);
    // label / cut are taken as written in the layout / YAML (not validated)
    return { id: b.id, label: pick('label', b.label) as string, rules, camera, cameraFrame, camera_topFrame, floors, cut: pick('cut', null) as boolean | null, source: b.source, hidden: !!pick('hidden', false),
      section, modelSection: normSection(b.section), camera_top, zoom_to };
  });
}

export function primaryLevel(index: NodeIndex, effective: Visibility, levels: readonly ViewLevel[]): string | null {
  const visible = new Set(index.nodes.filter((n, i) => shownHere(effective, i) && n.tag && n.tag.kind === 'level').map((n) => n.tag!.id));
  const storeys = levels.filter((l) => isStorey(l) && visible.has(l.id)).sort(byOrder);
  return storeys.length ? storeys[storeys.length - 1].id : null;
}

export function defaultFloors(primaryLevelId: string | null | undefined, levelFloor: Record<string, string | null | undefined>): string[] {
  const f = primaryLevelId && levelFloor[primaryLevelId];
  return f ? [f] : [];
}

/** Where a marker sits: its model room (and that room's level) and its HA floor. */
export interface MarkerPlace {
  roomId?: string | null;
  roomLevelId?: string | null;
  markerFloorId?: string | null;
  floorLevelId?: string | null;
}
export interface MarkerViewCtx {
  levelOrder: Record<string, number>;
  primaryOrder: number | null | undefined;
  visibleRooms: Set<string>;
  viewFloors: Set<string | null | undefined>;
  isAll?: boolean;
  overview?: boolean;
}
export interface MarkerShown { shown: boolean; faded: boolean }

export function markerState({ roomId, roomLevelId, markerFloorId }: MarkerPlace, ctx: MarkerViewCtx): MarkerShown {
  const order = ctx.levelOrder[String(roomLevelId)];
  const fade = (lvlOrder: number | undefined): boolean => lvlOrder !== undefined && ctx.primaryOrder !== null && lvlOrder < (ctx.primaryOrder as number); // undefined compares false, as before
  if (roomId && ctx.visibleRooms.has(roomId)) return { shown: true, faded: fade(order) };
  // no room, or the room is hidden here: fall back to the marker's HA floor linked to the view
  const shown = !!ctx.isAll || ctx.viewFloors.has(markerFloorId);
  return { shown, faded: shown && !!roomId && fade(order) };
}

// Storey/basement levels bottom-up: level id -> 0, 1, 2…; other roles have no order.
export function levelOrders(levels: readonly ViewLevel[] | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  (levels || []).filter(isStorey).sort(byOrder).forEach((l, i) => { out[l.id] = i; });
  return out;
}

// An overview view (Exterior / All) shows every storey/basement level and the roof; a top-storey
// view that hides only the roof is still a storey view (prototype: "Attic shows only attic devices").
export function isOverview(index: NodeIndex, effective: Visibility, levels: readonly ViewLevel[] | null | undefined): boolean {
  const storeys = new Set((levels || []).filter((l) => isStorey(l) || l.role === 'roof').map((l) => l.id));
  return index.nodes.every((n, i) => !(n.tag && n.tag.kind === 'level' && storeys.has(n.tag.id)) || shownHere(effective, i));
}

// HA floor id -> the lowest storey level bound to it (inverse of levelFloor).
export function floorLevels(levelFloor: Record<string, string | null | undefined> | null | undefined, levelOrder: Record<string, number>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [lid, fid] of Object.entries(levelFloor || {})) {
    if (!fid || levelOrder[lid] === undefined) continue;
    if (out[fid] === undefined || levelOrder[lid] < levelOrder[out[fid]]) out[fid] = lid;
  }
  return out;
}

// markerState plus the view rules: an overview view shows everything markerState shows, unfaded;
// a storey view hides devices below its primary storey (roomless ones by their HA floor's level).
export function deviceState({ roomId, roomLevelId, markerFloorId, floorLevelId }: MarkerPlace, ctx: MarkerViewCtx): MarkerShown {
  const s = markerState({ roomId, roomLevelId, markerFloorId }, { ...ctx, isAll: !!ctx.overview });
  if (ctx.overview || !s.shown) return { shown: s.shown, faded: false };
  const ord = ctx.levelOrder[String(roomId ? roomLevelId : floorLevelId)];
  const below = ord !== undefined && ctx.primaryOrder !== null && ctx.primaryOrder !== undefined && ord < ctx.primaryOrder;
  return { shown: !below, faded: false };
}

// Start view: config view_id, else config floor as a view id, else a view linked to that floor
// (only that floor first), else the fallback, else the first visible view.
export function defaultViewId<V extends { id: string; hidden?: boolean }>(
  views: readonly V[] | null | undefined,
  { viewId, floor, fallback }: { viewId?: string | null; floor?: string | null; fallback?: string | null } = {},
  floorsOf: (v: V) => readonly string[] | null | undefined = () => [],
): string | null {
  const vis = (views || []).filter((v) => !v.hidden);
  const has = (id: string | null | undefined): id is string => !!id && vis.some((v) => v.id === id);
  if (has(viewId)) return viewId;
  if (has(floor)) return floor;
  if (floor) {
    const fl = (v: V): readonly string[] => floorsOf(v) || [];
    const v = vis.find((x) => fl(x).length === 1 && fl(x)[0] === floor) || vis.find((x) => fl(x).includes(floor));
    if (v) return v.id;
  }
  if (has(fallback)) return fallback;
  return vis.length ? vis[0].id : null;
}

// Clip height for untagged models: the top of the highest linked storey (its elevation + storey
// height, 2.7 m when unknown). On by default except for the default "All" view; tagged models are
// never cut. wall_height only applies to drawn walls, not to a model.
export const DEFAULT_STOREY_HEIGHT = 2.7;
export function viewCut(
  view: { id: string; cut?: boolean | null },
  { tagged, floors }: { tagged?: boolean; floors?: readonly ({ elevation: number; height?: number | null } | null | undefined)[] | null },
): number | null {
  const on = view.cut ?? view.id !== 'all';
  const list = (floors || []).filter((f): f is { elevation: number; height?: number | null } => !!f && Number.isFinite(f.elevation));
  if (tagged || !on || !list.length) return null;
  const top = list.reduce((a, b) => (b.elevation > a.elevation ? b : a));
  const h = Number(top.height);
  return top.elevation + (Number.isFinite(h) && h > 0 ? h : DEFAULT_STOREY_HEIGHT);
}

// ---------- edit mode: per-view rule edits, element tree, picks, order ----------

type Rules = readonly (ViewRule | null | undefined)[] | null | undefined;
export type RuleState = 'shown' | 'hidden' | 'default';

const selOf = (r: ViewRule | null | undefined): string | undefined => (r ? r.show ?? r.hide : undefined);

// 'shown' | 'hidden' | 'default' for a selector in a rule list (the last rule for it wins).
export function ruleState(rules: Rules, sel: string): RuleState {
  let s: RuleState = 'default';
  for (const r of rules || []) if (r && selOf(r) === sel) s = r.show !== undefined ? 'shown' : 'hidden';
  return s;
}

// True when the selector's last rule is a hide that keeps the model objects inside (keep_objects).
export function ruleKeepsObjects(rules: Rules, sel: string): boolean {
  let k = false;
  for (const r of rules || []) if (r && selOf(r) === sel) k = r.show === undefined && r.keep_objects === true;
  return k;
}

// Drop every rule for the selector, then append the new one ('default' appends nothing).
// opts.keepObjects: a hide that keeps the objects inside visible ("Hide surfaces, keep devices").
export function setRuleState(rules: Rules, sel: string, state: RuleState, { keepObjects = false } = {}): ViewRule[] {
  const out = (rules || []).filter((r) => selOf(r) !== sel).map((r): ViewRule => ({ ...r }));
  if (state === 'shown') out.push({ show: sel });
  else if (state === 'hidden') out.push(keepObjects ? { hide: sel, keep_objects: true } : { hide: sel });
  return out;
}

const NEXT_EYE: Partial<Record<string, RuleState>> = { default: 'shown', shown: 'hidden' };
export const nextEyeState = (s: string): RuleState => NEXT_EYE[s] || 'default';

const TAG_SEL: Partial<Record<string, string>> = { level: 'level', room: 'room', zone: 'zone', object: 'object' };

/** A row of the Views tab. */
export interface ViewTreeRow {
  sel: string;
  label: string;
  depth: number;
  nodes: number[];
  parent: string | null;
  children: number;
  path?: string;
}

// Rows for the Views tab: tree (levels -> rooms/zones -> objects), layers, untagged model groups
// (named nodes with children, at most two levels below a level or the model root).
// Each row: { sel, label, depth, nodes: [index positions], path? }.
export function viewTree(index: NodeIndex, labels: Record<string, string> = {}): { tree: ViewTreeRow[]; layers: ViewTreeRow[]; groups: ViewTreeRow[] } {
  const nodes = index.nodes;
  const rows = new Map<string, ViewTreeRow>(); // sel -> row (several nodes may carry the same tag)
  const row = (sel: string, i: number, depth: number, extra?: Partial<ViewTreeRow>): ViewTreeRow | null => {
    let r = rows.get(sel);
    if (r) { r.nodes.push(i); return null; }
    r = { sel, label: labels[sel] || nodes[i].name || sel, depth, nodes: [i], parent: null, children: 0, ...extra };
    rows.set(sel, r);
    return r;
  };
  const nearest = (i: number, kinds: readonly string[]): number => {
    for (let p = nodes[i].parent; p >= 0; p = nodes[p].parent) if (nodes[p].tag && kinds.includes(nodes[p].tag!.kind)) return p;
    return -1;
  };
  const sel = (n: NodeInfo): string => TAG_SEL[n.tag!.kind]! + ':' + n.tag!.id; // only called for tagged nodes
  const tagged = (kinds: readonly string[]): number[] => nodes.map((n, i) => i).filter((i) => nodes[i].tag && kinds.includes(nodes[i].tag!.kind));
  const levels = tagged(['level']), places = tagged(['room', 'zone']), objects = tagged(['object']);
  const tree: ViewTreeRow[] = [];
  const push = (r: ViewTreeRow | null): void => { if (r) tree.push(r); };
  const objectsUnder = (p: number, depth: number, parent: ViewTreeRow | null): void => objects.filter((o) => nearest(o, ['room', 'zone', 'level']) === p).forEach((o) => {
    const r = row(sel(nodes[o]), o, depth, { parent: parent ? parent.sel : null });
    push(r);
    if (r && parent) parent.children++;
  });
  const placesUnder = (lv: number, depth: number, parent: ViewTreeRow | null): void => places.filter((p) => nearest(p, ['level']) === lv).forEach((p) => {
    const r = row(sel(nodes[p]), p, depth, { parent: parent ? parent.sel : null });
    push(r);
    if (r && parent) parent.children++;
    objectsUnder(p, depth + 1, r);
  });
  for (const lv of levels) {
    const r = row(sel(nodes[lv]), lv, 0);
    if (!r) continue;
    push(r);
    placesUnder(lv, 1, r);
    objectsUnder(lv, 1, r);
  }
  placesUnder(-1, 0, null); // rooms/zones outside any level
  objectsUnder(-1, 0, null);

  const layers: ViewTreeRow[] = [];
  nodes.forEach((n, i) => n.layers.forEach((name) => {
    const r = row('layer:' + name, i, 0);
    if (r) layers.push(r);
  }));

  const depth = new Array<number>(nodes.length);
  const groups: ViewTreeRow[] = [];
  nodes.forEach((n, i) => {
    depth[i] = n.tag && n.tag.kind === 'level' ? 0 : (n.parent >= 0 ? depth[n.parent] : 0) + 1;
    if (!n.tag && n.name && n.children.length && depth[i] <= 2) {
      const r = row('node:' + n.path, i, depth[i] - 1, { path: n.path, label: n.dup === null || n.dup === undefined ? n.name : `${n.name} #${n.dup + 1}` });
      if (r) groups.push(r);
    }
  });
  return { tree, layers, groups };
}

// Selector for a click in 3D: a tagged room/zone/object owner by its tag; otherwise (untagged, or
// inside a level) the nearest named group with children above the hit node, not past the owning
// level; a mesh directly in a level picks the mesh. hitIdx = index position of the hit node.
export function pickSelector(index: NodeIndex, hitIdx: number, owner: Pick<ManifestEntry, 'node' | 'kind' | 'id'> | null | undefined): { sel: string; idx: number } | null {
  const nodes = index.nodes;
  if (!(hitIdx >= 0 && hitIdx < nodes.length)) return null;
  const ownerIdx = owner && owner.node ? nodes.findIndex((n) => n.node === owner.node) : -1;
  if (owner && ownerIdx >= 0 && TAG_SEL[owner.kind] && (owner.kind !== 'level' || ownerIdx === hitIdx)) {
    return { sel: TAG_SEL[owner.kind] + ':' + owner.id, idx: ownerIdx };
  }
  for (let p = nodes[hitIdx].parent; p >= 0 && p !== ownerIdx; p = nodes[p].parent) {
    if (nodes[p].name && nodes[p].children.length) return { sel: 'node:' + nodes[p].path, idx: p };
  }
  return { sel: 'node:' + nodes[hitIdx].path, idx: hitIdx };
}

// Views sorted by a stored id order; ids not in it keep their relative place after the ordered ones.
export function orderViews<V extends { id: string }>(views: readonly V[] | null | undefined, order: unknown): V[] {
  const pos = new Map<unknown, number>((Array.isArray(order) ? order : []).map((id, i) => [id, i]));
  const n = pos.size + 1;
  return (views || []).map((v, i): [V, number] => [v, pos.has(v.id) ? pos.get(v.id)! : n + i]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
}

export function nextViewId(ids: Iterable<string> | null | undefined): { id: string; n: number } {
  const used = new Set(ids || []);
  let n = 1;
  while (used.has('view_' + n)) n++;
  return { id: 'view_' + n, n };
}

// A level's legacy show mode (layout.model.levels[id].show) as layout rules: the same rules the
// migration adds to generated views, put before each view's own layout rules. Used before the
// "belongs to HA floor" dropdown drops the show mode. Returns layoutViews unchanged when there is none.
export function legacyShowRules<L extends Record<string, LayoutView>>(
  layoutViews: L,
  views: readonly Pick<ResolvedView, 'id' | 'source'>[] | null | undefined,
  levelId: string,
  savedLevels: SavedLevels | null | undefined,
  levels: readonly ViewLevel[] | null | undefined,
): L | Record<string, LayoutView> {
  const b = (savedLevels || {})[levelId];
  if (!b || typeof b !== 'object' || !['hidden', 'always', 'all-only', 'only'].includes(b.show as string)) return layoutViews;
  const one = { [levelId]: b };
  const mig = migrateShowModes(one);
  const out: Record<string, LayoutView> = { ...layoutViews };
  let changed = false;
  for (const v of views || []) {
    if (v.source !== 'generated') continue;
    const add = migratedRules(v.id, mig, one, levels || []);
    if (!add.length) continue;
    const cur = obj(out[v.id]);
    out[v.id] = { ...cur, rules: [...add.map((r) => ({ ...r })), ...(Array.isArray(cur.rules) ? cur.rules : [])] };
    changed = true;
  }
  return changed ? out : layoutViews;
}

// ---------- side section: one vertical clipping plane ----------
// A plane is { normal: [x, y, z], constant } in card world (three.js Plane: n·p + constant = 0);
// points with n·p + constant >= 0 are kept, the rest is cut away.

const z0 = (x: number): number => x + 0; // no -0

// A valid section (finite numbers, normal length > 0) with a unit normal, or null.
export function normSection(s: unknown): SectionPlaneConfig | null {
  if (!s || typeof s !== 'object') return null;
  const raw = s as { normal?: unknown; constant?: unknown };
  if (!Array.isArray(raw.normal) || raw.normal.length !== 3) return null;
  const n: unknown[] = raw.normal, c = raw.constant;
  if (!n.every((x): x is number => typeof x === 'number' && Number.isFinite(x)) || typeof c !== 'number' || !Number.isFinite(c)) return null;
  const len = Math.hypot(...n);
  if (!(len > 1e-9)) return null;
  return { normal: [z0(n[0] / len), z0(n[1] / len), z0(n[2] / len)], constant: z0(c / len) };
}

// box: { min: [x, y, z], max: [x, y, z] } (card world)
const centre = (box: Box3Like): number[] => box.min.map((v, i) => (v + box.max[i]) / 2);
export const sectionSide = (plane: SectionPlaneConfig, p: readonly number[]): number => plane.normal[0] * p[0] + plane.normal[1] * p[1] + plane.normal[2] * p[2] + plane.constant;

// The view's cut: layout / YAML section (card world), else the model's (model space; toWorld maps it
// into card world), else normal (-1,0,0) through the box centre x (keeps the west half).
export function sectionPlane(
  view: { section?: unknown; modelSection?: unknown } | null | undefined,
  box: Box3Like,
  toWorld: (p: SectionPlaneConfig) => unknown = (p) => p,
): SectionPlaneConfig {
  const own = normSection(view && view.section);
  if (own) return own;
  const m = normSection(view && view.modelSection);
  if (m) return normSection(toWorld(m)) || m;
  return { normal: [-1, 0, 0], constant: z0(centre(box)[0]) };
}

// Camera on the removed side looking back at the cut face: target = the box centre projected onto
// the plane at 45 % of the box height, distance max(20, 1.3 × diagonal), slightly above the target.
export function sectionCamera(plane: SectionPlaneConfig, box: Box3Like): { position: number[]; target: number[] } {
  const c = centre(box);
  c[1] = box.min[1] + 0.45 * (box.max[1] - box.min[1]);
  const n = plane.normal, d = sectionSide(plane, c);
  const target = c.map((v, i) => v - n[i] * d);
  const diag = Math.hypot(...box.max.map((v, i) => v - box.min[i]));
  const dist = Math.max(20, 1.3 * diag);
  const position = target.map((v, i) => v - n[i] * dist);
  position[1] += 0.11 * dist; // ~6° down: OrbitControls in 3D limit the polar angle to 0.47π (84.6°)
  return { position, target };
}

// Views tab directions (world normals; world z = -plan y).
export interface SectionDir { id: string; label: string; normal: Vec3 }
export const SECTION_DIRS: readonly SectionDir[] = [
  { id: 'west', label: 'Keep west half', normal: [-1, 0, 0] }, // -x + c >= 0: x <= c
  { id: 'east', label: 'Keep east half', normal: [1, 0, 0] },
  { id: 'north', label: 'Keep north half', normal: [0, 0, -1] }, // -z + c >= 0: plan y >= -c
  { id: 'south', label: 'Keep south half', normal: [0, 0, 1] },
];

// Levels whose boxes frame the section (the house without garden / roof overhang).
export const sectionLevels = <L extends ViewLevel>(levels: readonly L[] | null | undefined): L[] => (levels || []).filter(isStorey);

// Union of {min, max} boxes (null entries skipped); null when there is none.
export function unionBox(boxes: readonly (Box3Like | null | undefined)[] | null | undefined): { min: number[]; max: number[] } | null {
  let out: { min: number[]; max: number[] } | null = null;
  for (const b of boxes || []) {
    if (!b) continue;
    if (!out) out = { min: [...b.min], max: [...b.max] };
    else for (let k = 0; k < 3; k++) { out.min[k] = Math.min(out.min[k], b.min[k]); out.max[k] = Math.max(out.max[k], b.max[k]); }
  }
  return out;
}

export function sectionDir(normal: readonly number[]): SectionDir {
  let best = SECTION_DIRS[0], bd = -Infinity;
  for (const d of SECTION_DIRS) {
    const dot = d.normal[0] * normal[0] + d.normal[1] * normal[1] + d.normal[2] * normal[2];
    if (dot > bd) { bd = dot; best = d; }
  }
  return best;
}

// Slider axis: east (x) for east-west normals, north (-z) for north-south ones.
const axisOf = (normal: readonly number[]): Vec3 => (Math.abs(normal[0]) >= Math.abs(normal[2]) ? [1, 0, 0] : [0, 0, -1]);
const dot3 = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Slider position (metres east, or north) of a plane: where it crosses its axis.
export function sectionPos(plane: SectionPlaneConfig): number {
  const u = axisOf(plane.normal), k = dot3(plane.normal, u);
  return Math.abs(k) < 1e-9 ? 0 : z0(-plane.constant / k);
}

// The plane with this normal crossing its axis at pos.
export function sectionAt(normal: readonly number[], pos: number): SectionPlaneConfig {
  const n = normSection({ normal, constant: 0 })!.normal; // callers pass a valid normal (it threw before)
  return { normal: n, constant: z0(-pos * dot3(n, axisOf(n))) };
}

// Slider range: the box along the axis.
export function sectionRange(normal: readonly number[], box: Box3Like): [number, number] {
  return axisOf(normal)[0] ? [box.min[0], box.max[0]] : [z0(-box.max[2]), z0(-box.min[2])];
}

// ---------- roomless markers (pins, live mower) ----------
function inPoly([x, y]: readonly number[], poly: readonly (readonly number[])[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const polyArea = (poly: readonly (readonly number[])[]): number => Math.abs(poly.reduce((a: number, [x, y], i) => { const [x2, y2] = poly[(i + 1) % poly.length]; return a + x * y2 - x2 * y; }, 0)) / 2;

// The model room / zone a plan point lies in: rooms [{id, level, polygon}] (card plan), on the
// marker's HA floor (rooms of levels without a floor match any). Smallest first; one in
// `visible` wins over a smaller hidden one. null when none contains it.
export function roomAt(
  point: readonly number[],
  floorId: string | null | undefined,
  rooms: readonly { id: string; level?: string | null; polygon?: readonly (readonly number[])[] | null }[] | null | undefined,
  levelFloor: Record<string, string | null | undefined> = {},
  visible: Set<string> | null = null,
): string | null {
  let best: { id: string; area: number; vis: boolean } | null = null;
  for (const r of rooms || []) {
    const f = levelFloor[String(r.level)];
    if ((f && f !== floorId) || !Array.isArray(r.polygon) || r.polygon.length < 3 || !inPoly(point, r.polygon)) continue;
    const cand = { id: r.id, area: polyArea(r.polygon), vis: !!visible && visible.has(r.id) };
    if (!best || (cand.vis && !best.vis) || (cand.vis === best.vis && cand.area < best.area)) best = cand;
  }
  return best ? best.id : null;
}

// Live mower: shown where any node of an exterior level is shown; null when the model has none.
export function exteriorShown(index: NodeIndex, effective: Visibility, levels: readonly ViewLevel[] | null | undefined): boolean | null {
  const ext = new Set<string | null>((levels || []).filter((l) => l.role === 'exterior').map((l) => l.id));
  if (!ext.size) return null;
  return index.nodes.some((n, i) => shownHere(effective, i) && ext.has(n.levelId));
}

// Whether the mower's surroundings show (its map and marker): any exterior-role level, or the
// level holding the lawn under the map, with a shown node (per-node flags when a view applies them, else
// the level nodes). null without such levels: the HA floor rule applies.
export function outdoorShown(
  levels: readonly ViewLevel[] | null | undefined,
  index: NodeIndex | null = null,
  flags: Visibility | null = null,
  groundLevel: string | null = null,
): boolean | null {
  const ids = new Set<string | null>((levels || []).filter((l) => l.role === 'exterior').map((l) => l.id));
  if (groundLevel) ids.add(groundLevel);
  if (!ids.size) return null;
  if (index && flags) return index.nodes.some((n, i) => shownHere(flags, i) && ids.has(n.levelId));
  return (levels || []).some((l) => ids.has(l.id) && !!l.node && (l.node as { visible?: boolean }).visible !== false);
}

// ---------- model cameras ----------
// Model world point [x, height, -north] -> card world under the alignment (same as transformPoint on the plan).
export function alignModelPoint([x, y, z]: readonly number[], { position = [0, 0, 0], rotation = 0, scale = 1 }: { position?: readonly number[]; rotation?: number; scale?: number } = {}): Vec3 {
  const a = (rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), k = scale || 1;
  const X = x * k, Y = y * k, Z = z * k;
  return [X * c + Z * s + (position[0] || 0), Y + (position[2] || 0), -X * s + Z * c - (position[1] || 0)];
}

// A view's 3D camera in card world; toWorld maps a model world point (model cameras only).
export function cameraToCard(
  v: Pick<ResolvedView, 'camera' | 'cameraFrame'> | null | undefined,
  toWorld?: ((p: readonly number[]) => Vec3) | null,
): ViewCamera | null {
  if (!v || !v.camera) return null;
  if (v.cameraFrame !== 'model' || !toWorld) return v.camera;
  return { position: toWorld(v.camera.position), target: toWorld(v.camera.target) };
}

// A view's top camera in card world: a model centre through the alignment, zoom / scale.
export function topCameraToCard(
  v: Pick<ResolvedView, 'camera_top' | 'camera_topFrame'> | null | undefined,
  align?: { position?: readonly number[]; rotation?: number; scale?: number } | null,
): TopCamera | null {
  if (!v || !v.camera_top) return null;
  const t = v.camera_top;
  if (v.camera_topFrame !== 'model' || !align) return t;
  const [x, , z] = alignModelPoint([t.center[0], 0, -t.center[1]], align);
  return { center: [x, -z], zoom: t.zoom / ((align.scale || 1)) };
}
