// Views tab: the edited view, its floors, camera, section and per-part visibility rules.

import { ruleState, ruleKeepsObjects, setRuleState, nextEyeState, viewTree, nextViewId, unmatchedSelectors, SECTION_DIRS, sectionDir, sectionPos, sectionAt, sectionRange, zoomToFor } from '../../views.ts';
import { cancelPivot } from '../tools/pivot.ts';
import { closeMenu } from '../tools/view-menu.ts';
import { html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';
import { act, field, options, slider } from '../html.ts';
import type { TemplateResult } from 'lit';
import type { TabDef } from './tab.ts';
import type { View } from '../html.ts';
import type { EditMode } from '../../edit-mode.ts';
import type { Box3Like, ResolvedView, RuleState } from '../../views.ts';
import type { Object3D } from 'three';
import type { ModelIndex } from '../../view/model.ts';
import type { LayoutView, SectionPlaneConfig, ViewRule } from '../../types/layout.ts';

/** A row of the Views tab's model tree (views.js viewTree). */
export interface TreeRow {
  sel: string;
  label: string;
  nodes: number[];
  depth: number;
  parent?: string | null;
  children?: number;
  path?: string;
}
export interface TreeRows {
  tree: TreeRow[];
  layers: TreeRow[];
  groups: TreeRow[];
  /** node position -> selector of the row listing it */
  rowOf: Map<number, string>;
}

// ---------- views ----------
// The view the Views tab edits: a hidden view picked in its select, else the active chip.
export function vwView(ed: EditMode): ResolvedView | null | undefined {
  const vs = ed.card._views || [];
  // (kept while the view is visible: a hide is committed before the view list catches up)
  const v = ed.vwSel && vs.find((x) => x.id === ed.vwSel);
  if (v && v.hidden) return v;
  return ed.card.currentView();
}

// the card switched views (chip or select)
export function onViewChanged(ed: EditMode) {
  ed.vwSel = null;
  closeMenu(ed);
  if (ed.tab === 'views') ed.render();
}

export function layoutRules(ed: EditMode, id: string): ViewRule[] {
  const v = (ed.layout.views || {})[id];
  return v && Array.isArray(v.rules) ? v.rules : [];
}

export function setRule(ed: EditMode, id: string, sel: string, state: RuleState, opts?: { keepObjects?: boolean }) {
  ed.card.saveViewPatch(id, { rules: setRuleState(layoutRules(ed, id), sel, state, opts) });
}

// Tree rows for the loaded model, with the manifest's labels (cached per node index).
export function treeRows(ed: EditMode): TreeRows | null {
  const idx = ed.card.viewIndex();
  const mb = ed.card._mb;
  if (!idx || !mb) return null;
  const objs = ed.layout && ed.layout.objects; // custom object labels (Objects tab)
  if (ed._treeCache && ed._treeCache.idx === idx && ed._treeCache.objs === objs) return ed._treeCache.tree;
  const labels: Record<string, string> = {};
  for (const l of mb.manifest.levels) labels['level:' + l.id] = l.label;
  for (const r of mb.manifest.rooms) labels[r.kind + ':' + r.id] = r.label;
  for (const o of mb.manifest.objects || []) labels['object:' + o.id] = ed.card.objectLabel(o);
  const rows: Omit<TreeRows, 'rowOf'> = viewTree(idx, labels);
  const rowOf = new Map<number, string>(); // node position -> selector of the row listing it
  for (const r of [...rows.tree, ...rows.groups]) for (const i of r.nodes) if (!rowOf.has(i)) rowOf.set(i, r.sel);
  const tree: TreeRows = Object.assign(rows, { rowOf });

  ed._treeCache = { idx, objs, tree };
  return tree;
}

export function viewsTab(ed: EditMode): TemplateResult {
  const card = ed.card;
  const views = card._views || [];
  const v = vwView(ed);
  if (!v) return html`<p class="hint">No views yet.</p>`;
  const st = card._stateFor(v);
  const lv: LayoutView = (ed.layout.views || {})[v.id] || {};
  const i = views.indexOf(v);
  const visible = views.filter((x) => !x.hidden).length;
  const hideLabel = v.source === 'added' ? 'Delete view' : v.hidden ? 'Unhide' : 'Hide';
  const top = card._mode === 'top';
  const zoom = lv.zoom_to || '';
  const rules = layoutRules(ed, v.id);
  const on = (fn: (v: ResolvedView) => void) => act(ed, () => fn(v)); // buttons act on the edited view
  return html`<p class="hint">Each view is a button on the card. Choose what it shows: click a part of the model, or use the eyes below.</p>
      <label>View <select name="vw-view" .value=${live(v.id)} @change=${(e: Event) => chooseView(ed, field(e).value)}>
        ${options(views.map((x): [string, string] => [x.id, `${x.label}${x.hidden ? ' (hidden)' : ''}`]), v.id)}</select></label>
      <label>Label <input name="vw-label" .value=${v.label} @change=${(e: Event) => card.saveViewPatch(v.id, { label: field(e).value.trim() || undefined })}></label>
      <div class="row"><button @click=${on(() => addView(ed, v))}>Add view</button>
        <button ?disabled=${!v.hidden && v.source !== 'added' && visible <= 1} class=${classMap({ danger: v.source === 'added' })} @click=${on(() => hideView(ed, v))}>${hideLabel}</button>
        <button ?disabled=${i <= 0} title="Move left" @click=${on(() => move(ed, v, -1))}>Up</button>
        <button ?disabled=${i < 0 || i >= views.length - 1} title="Move right" @click=${on(() => move(ed, v, 1))}>Down</button></div>
      <div class="sub">Linked HA floors</div>
      <div class="floor-links">${repeat(ed.floors, (f) => f.id, (f) => html`<label class="check"><input type="checkbox" name="vw-floor" data-id=${f.id} .checked=${live(st.floors.includes(f.id))}
        @change=${(e: Event) => linkFloor(ed, v, f.id, field(e).checked)}> ${f.name}</label>`)}</div>
      <p class="hint">Devices on linked floors show in this view. None checked: the view belongs to no floor (e.g. a garden view).</p>
      <div class="sub">Camera${top ? ' (top view)' : ''}</div>
      <p class="hint">${top ? (v.camera_top ? 'Top view opens with a saved centre and zoom.' : 'Top view keeps the current position.')
    : v.camera ? 'Opens with a saved camera.' : 'Opens framing the house.'}</p>
      <div class="row"><button name="vw-save-cam" ?disabled=${!!v.hidden} @click=${on(() => saveCamera(ed, v))}>Save current view as start</button>
        <button name="vw-reset-cam" ?disabled=${!(top ? lv.camera_top : lv.camera)} @click=${on(() => resetView(ed, v, card._mode === 'top' ? { camera_top: null } : { camera: null }))}>Reset camera</button></div>
      <div class="row">${ed.pivoting ? html`<button @click=${act(ed, () => cancelPivot(ed))}>Cancel</button>`
    : html`<button ?disabled=${!!v.hidden || v.id !== card._viewId} title="Click a point: the camera rotates and zooms around it" @click=${act(ed, () => startPivot(ed))}>Set rotation centre</button>`}</div>
      ${ed.pivoting ? html`<p class="hint">Click where the rotation centre should be (Esc cancels).</p>` : nothing}
      <label>Zoom towards <select name="vw-zoom-to" .value=${live(zoom)} @change=${(e: Event) => card.saveViewPatch(v.id, { zoom_to: field(e).value || undefined })}>
        ${options([['', `Card default (${zoomToFor(null, card._config)})`], ['center', 'Centre'], ['cursor', 'Cursor']], zoom)}</select></label>
      ${sectionView(ed, v, lv)}
      ${ed.view.model && !ed.view.isTagged() ? html`<label class="check"><input type="checkbox" name="vw-cut" .checked=${live(v.cut ?? v.id !== 'all')}
        @change=${(e: Event) => card.saveViewPatch(v.id, { cut: field(e).checked })}> Cut at storey height</label>` : nothing}
      ${modelTreeView(ed, v, st.effective, rules)}
      <div class="row"><button class="danger" ?disabled=${!(rules.length || lv.camera || lv.camera_top)} @click=${on(() => resetView(ed, v, { rules: [], camera: null, camera_top: null }))}>Reset this view</button></div>`;
}

// The model's parts (tree, layers, groups) with their visibility in the view and the eye (rule) of each.
function modelTreeView(ed: EditMode, v: ResolvedView, eff: readonly boolean[] | null | undefined, rules: ViewRule[]): View {
  const card = ed.card;
  const idx = card.viewIndex();
  const tree = treeRows(ed);
  if (!ed.view.model) return html`<p class="hint">Upload a model (Model tab) to choose which parts each view shows.</p>`;
  if (!idx || !tree) return nothing;
  // fully shown = the node and everything below it visible (nodes are in pre-order)
  const full: boolean[] = new Array(idx.nodes.length);
  for (let k = idx.nodes.length - 1; k >= 0; k--) full[k] = !eff || (!!eff[k] && idx.nodes[k].children.every((c) => full[c]));
  const yamlViews = (card._config.views || {}) as Record<string, { rules?: unknown } | undefined>; // YAML: checked below
  const yamlRules = (yamlViews[v.id] || {}).rules;
  const yamlSels = new Set((Array.isArray(yamlRules) ? yamlRules as ({ show?: unknown; hide?: unknown } | null)[] : []).map((r) => r && (r.show ?? r.hide)));
  const eyeTitle: Record<string, string> = { default: 'Default (from the model); click: show', shown: 'Shown here; click: hide', hidden: 'Hidden here; click: back to default' };
  const eyeIcon: Record<string, string> = { default: 'mdi:eye-outline', shown: 'mdi:eye', hidden: 'mdi:eye-off' };
  const row = (r: TreeRow) => {
    const shown = eff ? r.nodes.some((n) => eff[n]) : true;
    const part = shown && !r.nodes.every((n) => full[n]);
    const state = ruleState(rules, r.sel);
    const vis = part ? ['Partly shown', 'mdi:circle-half-full'] : shown ? ['Visible', 'mdi:cube-outline'] : ['Hidden', 'mdi:cube-off-outline'];
    const open = ed.vwExpanded.has(r.sel);
    return html`<li data-sel=${r.sel} class=${classMap({ lvl: r.sel.startsWith('level:'), off: !shown, part, picked: !!ed.vwPick && ed.vwPick.sel === r.sel })} style="--d:${r.depth}" title=${r.path || r.sel}>
          <span class="state" title="${vis[0]} in this view"><ha-icon icon=${vis[1]}></ha-icon></span>
          <span class="name">${r.label}${part ? html` <span class="dim">partly</span>` : nothing}</span>${r.children && !r.sel.startsWith('level:')
    ? html`<button class="link expand" title="${open ? 'Hide' : 'Show'} its ${r.children} object(s)" @click=${act(ed, () => toggleExpand(ed, r.sel))}>${open ? '▾' : '▸'}</button>` : nothing}
          ${state === 'hidden' && ruleKeepsObjects(rules, r.sel) ? html`<span class="yaml kept" title="Its surfaces are hidden; the model objects inside stay visible">devices kept</span>` : nothing}
          ${yamlSels.has(r.sel) ? html`<span class="yaml" title="The card YAML has a rule for this part; it wins over this setting">YAML</span>` : nothing}
          <button class="eye ${state}" title=${eyeTitle[state]} @click=${act(ed, () => setRule(ed, v.id, r.sel, nextEyeState(ruleState(layoutRules(ed, v.id), r.sel))))}><ha-icon icon=${eyeIcon[state]}></ha-icon></button></li>`;
  };
  // layer and group rows only differ from tree rows by their list: plain classes
  const list = (rows: TreeRow[]) => html`<ul class="vtree">${repeat(rows, (r) => r.sel, row)}</ul>`;
  const shownRows = tree.tree.filter((r) => !r.parent || r.parent.startsWith('level:') || ed.vwExpanded.has(r.parent));
  const gone = unmatchedSelectors(idx, rules);
  return html`<div class="sub">Model</div>
      ${tree.tree.length ? list(shownRows) : html`<p class="dim">No tagged levels or rooms.</p>`}
      ${tree.layers.length ? html`<div class="sub">Layers</div>${list(tree.layers)}` : nothing}
      ${tree.groups.length ? html`<div class="sub">Model groups</div>${list(tree.groups)}` : nothing}
      ${gone.length ? html`<div class="sub">Not in this model</div><ul class="vtree">${repeat(gone, (x) => x, (x) => html`<li class="gone" data-sel=${x}><span class="name">${x}</span>
          <button class="link" @click=${act(ed, () => setRule(ed, v.id, x, 'default'))}>Remove</button></li>`)}</ul>` : nothing}`;
}

// "Side section" block: direction + position of the cut (layout.views[id].section, card world).
export function sectionView(ed: EditMode, v: ResolvedView, lv: LayoutView): View {
  const box = ed.view.model && ed.view.sectionBox();
  if (!box) return nothing;
  const plane = ed.card.sectionPlaneNow(v);
  if (!plane) return nothing;
  const dir = sectionDir(plane.normal);
  const [lo, hi] = sliderRange(ed, dir.normal, box);
  const pos = Math.min(hi, Math.max(lo, sectionPos(plane)));
  const src = lv.section ? 'Saved for this view.' : v.modelSection ? 'From the model.' : 'Default: through the middle of the house.';
  const at = (x: number): SectionPlaneConfig => sectionAt(dir.normal, Math.round(x * 100) / 100);
  return html`<div class="sub">Side section</div>
      <p class="hint">The Section button (box cutter) cuts the house here and looks at the cut face. ${src}</p>
      <label>Direction <select name="vw-sec-dir" .value=${live(dir.id)} @change=${(e: Event) => setSectionDir(ed, v, field(e).value)}>${options(SECTION_DIRS.map((d) => [d.id, d.label]), dir.id)}</select></label>
      ${slider(ed, { name: 'vw-sec-pos', label: `Position (${dir.normal[0] ? 'east' : 'north'})`, min: lo, max: hi, step: 0.05, value: pos, unit: 'm',
    onInput: (x) => ed.card.previewSection(v.id, at(x)), // previews the cut while dragged
    onChange: (x) => ed.card.saveViewPatch(v.id, { section: at(x) }) })}
      <div class="row"><button ?disabled=${!lv.section} @click=${act(ed, () => ed.card.saveViewPatch(v.id, { section: null }))}>Reset section</button></div>`;
}

// slider range: the model box along the axis, on the 0.05 m grid
export function sliderRange(ed: EditMode, normal: readonly number[], box: Box3Like): number[] {
  const [a, b] = sectionRange(normal, box);
  return [Math.floor(a / 0.05) * 0.05, Math.ceil(b / 0.05) * 0.05].map((x) => Math.round(x * 100) / 100);
}

export function nodePos(ed: EditMode, idx: ModelIndex, node: Object3D): number {
  if (!ed._posCache || ed._posCache.idx !== idx) ed._posCache = { idx, map: new Map(idx.nodes.map((n, i) => [n.node, i])) };
  const p = ed._posCache.map.get(node);
  return p === undefined ? -1 : p;
}

// ---------- handlers: each acts on the edited view. They commit or render themselves (the rebuild after
// a commit renders the panel). ----------
const after = (fn: () => void) => queueMicrotask(fn); // runs after the commit's rebuild (queued first)

function move(ed: EditMode, v: ResolvedView, step: number) {
  const ids = (ed.card._views || []).map((x) => x.id);
  const i = ids.indexOf(v.id), j = i + step;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  ed.commit({ ...ed.layout, view_order: ids });
}

function resetView(ed: EditMode, v: ResolvedView, patch: Record<string, unknown>) {
  const card = ed.card;
  card.saveViewPatch(v.id, patch);
  if (v.id === card._viewId) after(() => card._resetCamera());
}

export function addView(ed: EditMode, v: ResolvedView) {
  const card = ed.card;
  const { id, n } = nextViewId([...(card._views || []).map((x) => x.id), ...Object.keys(ed.layout.views || {})]);
  // a copy of the current view: all its rules (model / generated base + saved), so it looks the same
  const views = { ...ed.layout.views, [id]: { added: true, label: `View ${n}`, rules: (v.rules || []).map((r) => ({ ...r })) } };
  ed.vwSel = null;
  ed.commit({ ...ed.layout, views });
  after(() => card._setView(id));
}

export function hideView(ed: EditMode, v: ResolvedView) {
  const card = ed.card;
  if (v.source === 'added') {
    const views = { ...ed.layout.views };
    delete views[v.id];
    const order = ed.layout.view_order;
    ed.vwSel = null;
    ed.commit({ ...ed.layout, views, ...(Array.isArray(order) ? { view_order: order.filter((x) => x !== v.id) } : {}) });
  } else if (v.hidden) {
    ed.vwSel = null;
    card.saveViewPatch(v.id, { hidden: false });
    after(() => card._setView(v.id));
  } else {
    ed.vwSel = v.id; // keep editing it, so it can be unhidden
    card.saveViewPatch(v.id, { hidden: true });
  }
}

export function saveCamera(ed: EditMode, v: ResolvedView) {
  const card = ed.card;
  card.leaveSection();
  if (card._mode === 'top') {
    ed.message = { text: `Saved the current top view as the start of "${v.label}".` };
    card.saveViewPatch(v.id, { camera_top: ed.view.getTopCamera() });
  } else {
    ed.message = { text: `Saved the current camera as the start of "${v.label}".` };
    card.saveViewPatch(v.id, { camera: ed.view.getCamera() });
  }
}

export function startPivot(ed: EditMode) {
  ed.card.leaveSection();
  ed.pivoting = true;
}

export function toggleExpand(ed: EditMode, sel: string) {
  if (ed.vwExpanded.has(sel)) ed.vwExpanded.delete(sel);
  else ed.vwExpanded.add(sel);
}

export function chooseView(ed: EditMode, id: string) {
  const card = ed.card;
  const v = (card._views || []).find((x) => x.id === id);
  if (!v) return;
  ed.vwPick = null;
  ed.view.highlightModelNode(null);
  if (v.hidden) { ed.vwSel = v.id; ed.render(); return; }
  ed.vwSel = null;
  if (v.id === card._viewId) ed.render();
  else card._setView(v.id);
}

export function linkFloor(ed: EditMode, v: ResolvedView, fid: string, on: boolean) {
  const cur = ed.card._stateFor(v).floors;
  const floors = ed.floors.map((x) => x.id).filter((id) => (id === fid ? on : cur.includes(id)));
  ed.card.saveViewPatch(v.id, { floors });
}

export function setSectionDir(ed: EditMode, v: ResolvedView, dirId: string) {
  const card = ed.card;
  // a new axis: start in the middle of the model along it
  const box = ed.view.sectionBox();
  const dir = SECTION_DIRS.find((d) => d.id === dirId);
  if (!box || !dir) return;
  const [lo, hi] = sliderRange(ed, dir.normal, box);
  const old = card.sectionPlaneNow(v);
  const same = old && !!sectionDir(old.normal).normal[0] === !!dir.normal[0];
  const section = sectionAt(dir.normal, same ? sectionPos(old) : Math.round(((lo + hi) / 2) * 20) / 20);
  card.previewSection(v.id, section, { aim: true });
  card.saveViewPatch(v.id, { section }); // drops the preview: the saved plane takes over
}

export const viewsTabDef: TabDef = { id: 'views', label: 'Views', view: viewsTab };
