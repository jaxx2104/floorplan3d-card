// Views tab: the edited view, its floors, camera, section and per-part visibility rules.

import { ruleState, ruleKeepsObjects, setRuleState, nextEyeState, viewTree, nextViewId, unmatchedSelectors, SECTION_DIRS, sectionDir, sectionPos, sectionAt, sectionRange, zoomToFor } from '../../views.ts';
import { cancelPivot } from '../tools/pivot.ts';
import { closeMenu } from '../tools/view-menu.ts';
import { esc, sliderHtml } from '../html.ts';
import { defineTab } from './tab.ts';
import type { ActHandler, FieldEl, FieldHandler } from './tab.ts';
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

export function viewsTab(ed: EditMode): string {
  const card = ed.card;
  const views = card._views || [];
  const v = vwView(ed);
  if (!v) return '<p class="hint">No views yet.</p>';
  const st = card._stateFor(v);
  const lv: LayoutView = (ed.layout.views || {})[v.id] || {};
  const i = views.indexOf(v);
  const visible = views.filter((x) => !x.hidden).length;
  const opts = views.map((x) => `<option value="${esc(x.id)}" ${x.id === v.id ? 'selected' : ''}>${esc(x.label)}${x.hidden ? ' (hidden)' : ''}</option>`).join('');
  const hideLabel = v.source === 'added' ? 'Delete view' : v.hidden ? 'Unhide' : 'Hide';
  const top = card._mode === 'top';
  let out = `<p class="hint">Each view is a button on the card. Choose what it shows: click a part of the model, or use the eyes below.</p>
      <label>View <select data-field="vw-view">${opts}</select></label>
      <label>Label <input data-field="vw-label" value="${esc(v.label)}"></label>
      <div class="row"><button data-act="vw-add">Add view</button>
        <button data-act="vw-hide" ${!v.hidden && v.source !== 'added' && visible <= 1 ? 'disabled' : ''} class="${v.source === 'added' ? 'danger' : ''}">${hideLabel}</button>
        <button data-act="vw-up" ${i <= 0 ? 'disabled' : ''} title="Move left">Up</button>
        <button data-act="vw-down" ${i < 0 || i >= views.length - 1 ? 'disabled' : ''} title="Move right">Down</button></div>
      <div class="sub">Linked HA floors</div>
      <div class="floor-links">${ed.floors.map((f) => `<label class="check"><input type="checkbox" data-field="vw-floor" data-id="${esc(f.id)}" ${st.floors.includes(f.id) ? 'checked' : ''}> ${esc(f.name)}</label>`).join('')}</div>
      <p class="hint">Devices on linked floors show in this view. None checked: the view belongs to no floor (e.g. a garden view).</p>
      <div class="sub">Camera${top ? ' (top view)' : ''}</div>
      <p class="hint">${top ? (v.camera_top ? 'Top view opens with a saved centre and zoom.' : 'Top view keeps the current position.')
  : v.camera ? 'Opens with a saved camera.' : 'Opens framing the house.'}</p>
      <div class="row"><button data-act="vw-save-cam" ${v.hidden ? 'disabled' : ''}>Save current view as start</button>
        <button data-act="vw-reset-cam" ${(top ? lv.camera_top : lv.camera) ? '' : 'disabled'}>Reset camera</button></div>
      <div class="row">${ed.pivoting ? '<button data-act="vw-pivot-cancel">Cancel</button>'
  : `<button data-act="vw-pivot" ${v.hidden || v.id !== card._viewId ? 'disabled' : ''} title="Click a point: the camera rotates and zooms around it">Set rotation centre</button>`}</div>
      ${ed.pivoting ? '<p class="hint">Click where the rotation centre should be (Esc cancels).</p>' : ''}
      <label>Zoom towards <select data-field="vw-zoom-to">${[['', `Card default (${zoomToFor(null, card._config)})`], ['center', 'Centre'], ['cursor', 'Cursor']]
  .map(([val, label]) => `<option value="${val}" ${(lv.zoom_to || '') === val ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
  out += sectionHtml(ed, v, lv);
  if (ed.view.model && !ed.view.isTagged()) {
    out += `<label class="check"><input type="checkbox" data-field="vw-cut" ${(v.cut ?? v.id !== 'all') ? 'checked' : ''}> Cut at storey height</label>`;
  }
  const idx = card.viewIndex();
  const tree = treeRows(ed);
  const rules = layoutRules(ed, v.id);
  if (idx && tree && ed.view.model) {
    const eff = st.effective;
    // fully shown = the node and everything below it visible (nodes are in pre-order)
    const full: boolean[] = new Array(idx.nodes.length);
    for (let k = idx.nodes.length - 1; k >= 0; k--) full[k] = !eff || (!!eff[k] && idx.nodes[k].children.every((c) => full[c]));
    const yamlViews = (card._config.views || {}) as Record<string, { rules?: unknown } | undefined>; // YAML: checked below
    const yamlRules = (yamlViews[v.id] || {}).rules;
    const yamlSels = new Set((Array.isArray(yamlRules) ? yamlRules as ({ show?: unknown; hide?: unknown } | null)[] : []).map((r) => r && (r.show ?? r.hide)));
    const eyeTitle: Record<string, string> = { default: 'Default (from the model); click: show', shown: 'Shown here; click: hide', hidden: 'Hidden here; click: back to default' };
    const eyeIcon: Record<string, string> = { default: 'mdi:eye-outline', shown: 'mdi:eye', hidden: 'mdi:eye-off' };
    const row = (r: TreeRow, cls = '') => {
      const on = eff ? r.nodes.some((n) => eff[n]) : true;
      const part = on && !r.nodes.every((n) => full[n]);
      const state = ruleState(rules, r.sel);
      const picked = ed.vwPick && ed.vwPick.sel === r.sel ? ' picked' : '';
      const vis = part ? ['Partly shown', 'mdi:circle-half-full'] : on ? ['Visible', 'mdi:cube-outline'] : ['Hidden', 'mdi:cube-off-outline'];
      const open = ed.vwExpanded.has(r.sel);
      const toggle = r.children && !r.sel.startsWith('level:')
        ? `<button class="link expand" data-act="vw-expand" data-sel="${esc(r.sel)}" title="${open ? 'Hide' : 'Show'} its ${r.children} object(s)">${open ? '\u25be' : '\u25b8'}</button>` : '';
      return `<li data-sel="${esc(r.sel)}" class="${cls}${on ? '' : ' off'}${part ? ' part' : ''}${picked}" style="--d:${r.depth}" title="${esc(r.path || r.sel)}">
          <span class="state" title="${vis[0]} in this view"><ha-icon icon="${vis[1]}"></ha-icon></span>
          <span class="name">${esc(r.label)}${part ? ' <span class="dim">partly</span>' : ''}</span>${toggle}
          ${state === 'hidden' && ruleKeepsObjects(rules, r.sel) ? '<span class="yaml kept" title="Its surfaces are hidden; the model objects inside stay visible">devices kept</span>' : ''}
          ${yamlSels.has(r.sel) ? '<span class="yaml" title="The card YAML has a rule for this part; it wins over this setting">YAML</span>' : ''}
          <button class="eye ${state}" data-act="vw-eye" data-sel="${esc(r.sel)}" title="${eyeTitle[state]}"><ha-icon icon="${eyeIcon[state]}"></ha-icon></button></li>`;
    };
    const shownRows = tree.tree.filter((r) => !r.parent || r.parent.startsWith('level:') || ed.vwExpanded.has(r.parent));
    out += '<div class="sub">Model</div>';
    out += tree.tree.length ? '<ul class="vtree">' + shownRows.map((r) => row(r, r.sel.startsWith('level:') ? 'lvl' : '')).join('') + '</ul>'
      : '<p class="dim">No tagged levels or rooms.</p>';
    if (tree.layers.length) out += '<div class="sub">Layers</div><ul class="vtree">' + tree.layers.map((r) => row(r)).join('') + '</ul>';
    if (tree.groups.length) out += '<div class="sub">Model groups</div><ul class="vtree">' + tree.groups.map((r) => row(r)).join('') + '</ul>';
    const gone = unmatchedSelectors(idx, rules);
    if (gone.length) {
      out += '<div class="sub">Not in this model</div><ul class="vtree">' + gone.map((s) => `<li class="gone" data-sel="${esc(s)}"><span class="name">${esc(s)}</span>
          <button class="link" data-act="vw-rm" data-sel="${esc(s)}">Remove</button></li>`).join('') + '</ul>';
    }
  } else if (!ed.view.model) {
    out += '<p class="hint">Upload a model (Model tab) to choose which parts each view shows.</p>';
  }
  out += `<div class="row"><button data-act="vw-reset" class="danger" ${rules.length || lv.camera || lv.camera_top ? '' : 'disabled'}>Reset this view</button></div>`;
  return out;
}

// "Side section" block: direction + position of the cut (layout.views[id].section, card world).
export function sectionHtml(ed: EditMode, v: ResolvedView, lv: LayoutView): string {
  const box = ed.view.model && ed.view.sectionBox();
  if (!box) return '';
  const plane = ed.card.sectionPlaneNow(v);
  if (!plane) return '';
  const dir = sectionDir(plane.normal);
  const [lo, hi] = sliderRange(ed, dir.normal, box);
  const pos = Math.min(hi, Math.max(lo, sectionPos(plane)));
  const opts = SECTION_DIRS.map((d) => `<option value="${d.id}" ${d.id === dir.id ? 'selected' : ''}>${d.label}</option>`).join('');
  const src = lv.section ? 'Saved for this view.' : v.modelSection ? 'From the model.' : 'Default: through the middle of the house.';
  return `<div class="sub">Side section</div>
      <p class="hint">The Section button (box cutter) cuts the house here and looks at the cut face. ${src}</p>
      <label>Direction <select data-field="vw-sec-dir">${opts}</select></label>
      ${sliderHtml('vw-sec-pos', `Position (${dir.normal[0] ? 'east' : 'north'})`, lo, hi, 0.05, pos, 'm')}
      <div class="row"><button data-act="vw-sec-reset" ${lv.section ? '' : 'disabled'}>Reset section</button></div>`;
}

// slider range: the model box along the axis, on the 0.05 m grid
export function sliderRange(ed: EditMode, normal: readonly number[], box: Box3Like): number[] {
  const [a, b] = sectionRange(normal, box);
  return [Math.floor(a / 0.05) * 0.05, Math.ceil(b / 0.05) * 0.05].map((x) => Math.round(x * 100) / 100);
}

export function sectionFromPanel(ed: EditMode, v: ResolvedView, pos: number): SectionPlaneConfig {
  const sel = ed.panel.querySelector<HTMLSelectElement>('[data-field="vw-sec-dir"]');
  const dir = SECTION_DIRS.find((d) => d.id === (sel && sel.value)) || SECTION_DIRS[0];
  return sectionAt(dir.normal, Math.round(pos * 100) / 100);
}

export function nodePos(ed: EditMode, idx: ModelIndex, node: Object3D): number {
  if (!ed._posCache || ed._posCache.idx !== idx) ed._posCache = { idx, map: new Map(idx.nodes.map((n, i) => [n.node, i])) };
  const p = ed._posCache.map.get(node);
  return p === undefined ? -1 : p;
}

// Panel buttons of the Views tab: each acts on the edited view (none: nothing happens). They commit or
// render themselves (the rebuild after a commit renders the panel once), so none asks for a render.
// (the same wrapper serves buttons and form fields: el is what the handler was given)
function onView(fn: (ed: EditMode, v: ResolvedView, el: FieldEl) => void): FieldHandler & ActHandler {
  return (ed: EditMode, el: HTMLElement) => {
    const v = vwView(ed);
    if (v) fn(ed, v, el as FieldEl);
  };
}
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

const acts: Record<string, ActHandler> = {
  'vw-add': onView((ed, v) => {
    const card = ed.card;
    const { id, n } = nextViewId([...(card._views || []).map((x) => x.id), ...Object.keys(ed.layout.views || {})]);
    // a copy of the current view: all its rules (model / generated base + saved), so it looks the same
    const views = { ...ed.layout.views, [id]: { added: true, label: `View ${n}`, rules: (v.rules || []).map((r) => ({ ...r })) } };
    ed.vwSel = null;
    ed.commit({ ...ed.layout, views });
    after(() => card._setView(id));
  }),
  'vw-hide': onView((ed, v) => {
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
  }),
  'vw-up': onView((ed, v) => move(ed, v, -1)),
  'vw-down': onView((ed, v) => move(ed, v, 1)),
  'vw-save-cam': onView((ed, v) => {
    const card = ed.card;
    card.leaveSection();
    if (card._mode === 'top') {
      ed.message = { text: `Saved the current top view as the start of "${v.label}".` };
      card.saveViewPatch(v.id, { camera_top: ed.view.getTopCamera() });
    } else {
      ed.message = { text: `Saved the current camera as the start of "${v.label}".` };
      card.saveViewPatch(v.id, { camera: ed.view.getCamera() });
    }
    ed.render();
  }),
  'vw-pivot': onView((ed) => {
    ed.card.leaveSection();
    ed.pivoting = true;
    ed._syncStageClasses();
    ed.render();
  }),
  'vw-pivot-cancel': onView((ed) => cancelPivot(ed)),
  'vw-expand': onView((ed, v, btn) => {
    const sel = btn.dataset.sel || '';
    if (ed.vwExpanded.has(sel)) ed.vwExpanded.delete(sel);
    else ed.vwExpanded.add(sel);
    ed.render();
  }),
  'vw-sec-reset': onView((ed, v) => ed.card.saveViewPatch(v.id, { section: null })),
  'vw-reset-cam': onView((ed, v) => resetView(ed, v, ed.card._mode === 'top' ? { camera_top: null } : { camera: null })),
  'vw-reset': onView((ed, v) => resetView(ed, v, { rules: [], camera: null, camera_top: null })),
  'vw-eye': onView((ed, v, btn) => {
    const sel = btn.dataset.sel || '';
    setRule(ed, v.id, sel, nextEyeState(ruleState(layoutRules(ed, v.id), sel)));
  }),
  'vw-rm': onView((ed, v, btn) => setRule(ed, v.id, btn.dataset.sel || '', 'default')),
};

const fields: Record<string, FieldHandler> = {
  'vw-view': (ed, el) => {
    const card = ed.card;
    const v = (card._views || []).find((x) => x.id === el.value);
    if (!v) return;
    ed.vwPick = null;
    ed.view.highlightModelNode(null);
    if (v.hidden) { ed.vwSel = v.id; ed.render(); return; }
    ed.vwSel = null;
    if (v.id === card._viewId) ed.render();
    else card._setView(v.id);
  },
  'vw-sec-pos': onView((ed, v, el) => ed.card.saveViewPatch(v.id, { section: sectionFromPanel(ed, v, Number(el.value)) })),
  'vw-sec-dir': onView((ed, v, el) => {
    const card = ed.card;
    // a new axis: start in the middle of the model along it
    const box = ed.view.sectionBox();
    const dir = SECTION_DIRS.find((d) => d.id === el.value);
    if (!box || !dir) return;
    const [lo, hi] = sliderRange(ed, dir.normal, box);
    const old = card.sectionPlaneNow(v);
    const same = old && !!sectionDir(old.normal).normal[0] === !!dir.normal[0];
    const section = sectionAt(dir.normal, same ? sectionPos(old) : Math.round(((lo + hi) / 2) * 20) / 20);
    card.previewSection(v.id, section, { aim: true });
    card.saveViewPatch(v.id, { section }); // drops the preview: the saved plane takes over
  }),
  'vw-label': onView((ed, v, el) => ed.card.saveViewPatch(v.id, { label: el.value.trim() || undefined })),
  'vw-cut': onView((ed, v, el) => ed.card.saveViewPatch(v.id, { cut: el.checked })),
  'vw-zoom-to': onView((ed, v, el) => ed.card.saveViewPatch(v.id, { zoom_to: el.value || undefined })),
  'vw-floor': onView((ed, v, el) => {
    const cur = ed.card._stateFor(v).floors;
    const floors = ed.floors.map((x) => x.id).filter((id) => (id === el.dataset.id ? el.checked : cur.includes(id)));
    ed.card.saveViewPatch(v.id, { floors });
  }),
};

// the section position slider previews the cut while dragged (saved on change)
const inputs: Record<string, FieldHandler> = {
  'vw-sec-pos': onView((ed, v, el) => ed.card.previewSection(v.id, sectionFromPanel(ed, v, Number(el.value)))),
};

export const viewsTabDef = defineTab({ id: 'views', html: viewsTab, acts, fields, inputs });

