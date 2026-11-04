// Objects tab: model objects by level and room with their entity, label, actions, wash and tags.

import * as E from '../../editor.js';
import { objectTags, layoutTags } from '../../objects/logic.js';
import { actionTarget } from '../../objects/popup.js';
import { typeOf } from '../../objects/types.js';
import { resolveWash, WASH_DIRS } from '../../objects/wash.js';
import { resolveActions, validateAction } from '../../actions.js';
import { entOption, logoBox, esc } from '../html.js';
import { defineTab } from './tab.js';
import type { ActHandler, FieldEl, FieldHandler } from './tab.js';
import type { EditMode } from '../../edit-mode.js';
import type { ManifestLevel, ManifestObject, ObjectBinding } from '../host.js';
import type { LayoutObject } from '../../types/layout.js';

// actions.js is still JS: its destructured defaults are inferred as the only option types
const resolveActionsFor = resolveActions as unknown as (opts: Record<string, unknown>) => Record<string, { action: string } | null | undefined>;

/** A saved action (layout.objects[id].ui.<which>_action). */
interface UiAction { action: string; target?: { entity_id?: string }; [key: string]: unknown }

export function objectsAvailable(ed: EditMode): boolean {
  const mb = ed.view.model && ed.card.modelBindings();
  return !!(mb && mb.manifest.objects && mb.manifest.objects.length);
}

// Objects tab: model objects by level -> room (rooms collapsed), each with its entity binding.
export function objectsTab(ed: EditMode): string {
  const mb = ed.card.modelBindings();
  if (!mb) return ''; // the tab shows only with a model's objects (objectsAvailable)
  const objs = (mb && mb.manifest.objects) || [];
  const states = ed.hass.states;
  const bindings: Map<string, ObjectBinding> = ed.card._bindings || new Map();
  const ids = Object.keys(states).sort();
  const DOMAINS: Record<string, string[]> = {
    light: ['light', 'switch'], light_strip: ['light', 'switch'], mower: ['lawn_mower'], dock: ['lawn_mower', 'binary_sensor'],
    ev_charger: ['sensor', 'switch', 'binary_sensor'], climate: ['climate'], cover: ['cover'],
  };
  const ICONS: Record<string, string> = {
    light: 'mdi:lightbulb', light_strip: 'mdi:led-strip-variant', mower: 'mdi:robot-mower', dock: 'mdi:home-lightning-bolt',
    ev_charger: 'mdi:ev-station', climate: 'mdi:thermostat', cover: 'mdi:curtains',
  };
  const listFor = (type: string) => {
    const d = DOMAINS[type];
    return d ? ids.filter((id) => d.includes(id.split('.')[0])) : ids;
  };
  const types = [...new Set(objs.map((o) => (DOMAINS[o.type] ? o.type : 'other')))];
  const datalists = types.map((t) => `<datalist id="fp-obj-${t}">${listFor(t).map((x) => entOption(ed, x)).join('')}</datalist>`).join('');
  const lo: Record<string, LayoutObject> = ed.layout.objects || {};
  const lgAll = layoutTags(ed.layout);
  // "Light on wall" (the wash): object > tag > model; the default option names what applies without a setting
  const WASH_LABEL: Record<string, string> = { down: 'Down', up: 'Up', both: 'Up and down', none: 'None', point: 'Around the lamp', spot: 'Where it aims', model: 'from the model' };
  const washSelect = (field: string, id: string, cur: string | undefined, def: string) => `<label class="owash">Light on wall <select data-field="${field}" data-id="${esc(id)}">
      <option value="">Default (${esc(WASH_LABEL[def] || def)})</option>${WASH_DIRS.map((d) => `<option value="${d}"${cur === d ? ' selected' : ''}>${WASH_LABEL[d]}</option>`).join('')}</select></label>`;
  const rowHtml = (o: ManifestObject) => {
    const b: ObjectBinding = bindings.get(o.id) || {};
    const t = DOMAINS[o.type] ? o.type : 'other';
    const saved: LayoutObject = lo[o.id] || {};
    const explicit = saved.entity !== undefined;
    const sug = (o.suggest || {}).entity;
    let badge = '', value = '', ph = 'auto: none';
    if (explicit) {
      value = saved.entity === null ? 'none' : saved.entity ?? ''; // explicit: defined
      if (b.missing) badge = '<span class="badge warn">entity not found</span>';
    } else if (b.entity && b.from === 'mower') {
      badge = '<span class="badge">auto</span>'; ph = `auto: ${b.entity} (from Mower tab)`;
    } else if (b.entity) { badge = '<span class="badge">auto</span>'; ph = b.entity; } else if (sug) {
      badge = '<span class="badge warn">entity not found</span>';
      ph = `auto: ${sug}`;
    }
    const sel = ed.objSel === o.id;
    // Test only where a tap could toggle something (not hidden, own entity or a known group controller)
    const testable = !b.hidden && !!actionTarget(o, b, ed.card._groups || {});
    return `<li class="obj${sel ? ' sel' : ''}${b.hidden ? ' hid' : ''}" data-obj="${esc(o.id)}">
        <div class="orow"><input type="checkbox" class="opick" data-field="obj-pick" data-id="${esc(o.id)}" ${ed.objPicked.has(o.id) ? 'checked' : ''} title="Select for Add tag / Remove tag" aria-label="Select"><ha-icon icon="${ICONS[t] || 'mdi:cube-outline'}"></ha-icon>${logoBox(ed, b.entity)}<span class="name">${esc(ed.card.objectLabel(o))}</span>${badge}
          ${testable ? `<button data-act="obj-test" data-id="${esc(o.id)}" title="Toggle it like a tap in the view">Test</button>` : ''}
          <label class="check"><input type="checkbox" data-field="obj-hidden" data-id="${esc(o.id)}" ${b.hidden ? 'checked' : ''}> Hide</label></div>
        <input class="olabel" data-field="obj-label" data-id="${esc(o.id)}" value="${esc(saved.label || '')}" placeholder="${esc(o.label || o.id)}" title="Label (empty: the model's)" aria-label="Label">
        <input list="fp-obj-${t}" data-field="obj-entity" data-id="${esc(o.id)}" value="${esc(value)}" placeholder="${esc(ph)}" title="Empty: automatic; type none to leave it unbound">
        ${o.type === 'light' || o.type === 'light_strip' ? washSelect('obj-wash', o.id, saved.wash, resolveWash(o.hints, undefined, tagsOf(o), lgAll)) : ''}
        ${tagChips(o)}${objActionsHtml(ed, o, saved.ui)}</li>`;
  };
  // tags: chips (x removes), + adds (datalist of known tags)
  const tagsOf = (o: ManifestObject): string[] => objectTags(o, lo[o.id], (bindings.get(o.id) || {}).entity, ed.hass); // from the layout: fresh right after an edit
  const allTags = [...new Set([...objs.flatMap(tagsOf), ...Object.keys(layoutTags(ed.layout))])].sort((a, b) => a.localeCompare(b));
  const tagChips = (o: ManifestObject) => `<div class="otags">${tagsOf(o).map((t) => `<span class="otag">${esc(t)}<button class="link" data-act="tag-rm"
      data-id="${esc(o.id)}" data-tag="${esc(t)}" title="Remove the tag" aria-label="Remove ${esc(t)}">×</button></span>`).join('')}
      <input class="tagadd" list="fp-tag-names" data-field="tag-add" data-id="${esc(o.id)}" placeholder="+ tag" title="Add a tag (Enter)" aria-label="Add a tag"></div>`;
  const filter = ed.objTagFilter && allTags.includes(ed.objTagFilter) ? ed.objTagFilter : '';
  const shownObjs = filter ? objs.filter((o) => tagsOf(o).includes(filter)) : objs;
  for (const id of [...ed.objPicked]) if (!objs.some((o) => o.id === id)) ed.objPicked.delete(id);
  const levelOf = new Map<string | undefined, ManifestLevel>(mb.manifest.levels.map((l) => [l.id, l]));
  const roomOf = new Map(mb.manifest.rooms.map((r) => [r.id, r]));
  const order = [...new Set([...mb.manifest.levels.map((l) => l.id), ...objs.map((o) => o.level)])];
  let out = datalists + `<datalist id="fp-tag-names">${allTags.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`
    + '<p class="hint">Bind each model object to a Home Assistant entity. Empty means automatic; "none" leaves it unbound. Click an object in the plan to find its row. Tap / Hold / Double tap pick its actions (card YAML <code>actions:</code> overrides these). Tags group objects (model group and HA labels by default).</p>';
  out += `<div class="otagbar"><label>Tag <select data-field="obj-tag-filter"><option value="">All objects</option>${allTags.map((x) => `<option value="${esc(x)}"${x === filter ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>`;
  const nPick = ed.objPicked.size;
  out += `<span class="dim">${nPick} selected</span><input class="tagadd" list="fp-tag-names" data-field="tag-bulk" placeholder="tag" aria-label="Tag for the selection" value="${esc(ed.objTagBulk || '')}">
      <button data-act="tag-bulk-add" ${nPick ? '' : 'disabled'}>Add tag</button><button data-act="tag-bulk-rm" ${nPick ? '' : 'disabled'}>Remove tag</button>
      ${filter ? `<button class="link" data-act="tag-pick-all">Select all ${shownObjs.length}</button>` : ''}${nPick ? '<button class="link" data-act="tag-pick-none">Clear</button>' : ''}</div>`;
  out += '<ul class="otree">';
  for (const lid of order) {
    const inLevel = shownObjs.filter((o) => o.level === lid);
    if (!inLevel.length) continue;
    const lv = levelOf.get(lid);
    out += `<li class="room lvl"><span class="name">${esc(lv ? lv.label : lid || 'No level')}</span></li>`;
    const roomIds = [...new Set(inLevel.map((o) => o.room || ''))];
    for (const rid of roomIds) {
      const list = inLevel.filter((o) => (o.room || '') === rid);
      const key = `${lid}/${rid}`;
      const open = !!filter || ed.objExpanded.has(key) || list.some((o) => o.id === ed.objSel);
      const r = roomOf.get(rid);
      out += `<li class="room" style="--d:1"><button class="link expand" data-act="obj-expand" data-key="${esc(key)}">${open ? '\u25be' : '\u25b8'}</button>
          <span class="name">${esc(r ? r.label : rid ? rid : 'No room')}</span><span class="dim">${list.length}</span></li>`;
      if (open) out += list.map(rowHtml).join('');
    }
  }
  out += '</ul>';
  if (allTags.length) {
    const lg = layoutTags(ed.layout);
    const gl = ids.filter((id) => /^(light|switch|input_boolean)\./.test(id));
    out += `<div class="sub">Tags</div><p class="hint">A tag's controller must be on too: an object is lit only while its own entity and the controllers of all its tags are on. Objects sharing a controller tag share the real-light budget. Views and card YAML <code>actions:</code> accept <code>tag:&lt;name&gt;</code>. Light on wall: the wash a lit lamp throws on the wall next to it (an object's own setting wins over its tags', a tag's over the model's).</p>
        <datalist id="fp-grp-ents">${gl.map((x) => entOption(ed, x)).join('')}</datalist>`;
    out += allTags.map((g) => {
      const e = (lg[g] && lg[g].entity) || '', gl2 = (lg[g] && lg[g].label) || '';
      const n = objs.filter((o) => tagsOf(o).includes(g)).length;
      const missing = e && !states[e] ? ' <span class="badge warn">entity not found</span>' : '';
      return `<label class="grp" data-grp="${esc(g)}">${esc(gl2 || g)} <span class="dim">${n}</span>${missing} <input list="fp-grp-ents" data-field="grp-entity" data-id="${esc(g)}"
        value="${esc(e)}" placeholder="no controller" title="Empty or none: no controller">
        <input class="glabel" data-field="grp-label" data-id="${esc(g)}" value="${esc(gl2)}" placeholder="label: ${esc(g)}" title="Label in popups (empty: the controller's name)"></label>
        ${objs.some((o) => (o.type === 'light' || o.type === 'light_strip') && tagsOf(o).includes(g)) ? washSelect('grp-wash', g, lg[g] && lg[g].wash, 'model') : ''}`;
    }).join('');
  }
  return out;
}

// Objects tab: current and default tags of an object (default = fp.group + HA labels of its entity).
export function objTags(ed: EditMode, id: string): { cur: string[]; def: string[] } {
  const mb = ed.card.modelBindings();
  const o = mb && mb.manifest.objects.find((x) => x.id === id);
  const b: ObjectBinding = (ed.card._bindings && ed.card._bindings.get(id)) || {};
  if (!o) return { cur: [], def: [] };
  return { cur: objectTags(o, (ed.layout.objects || {})[id], b.entity, ed.hass), def: objectTags(o, null, b.entity, ed.hass) };
}

// Objects tab: Tap / Hold / Double tap selects (Default = the model / type action) with the fields each needs.
export function objActionsHtml(ed: EditMode, o: ManifestObject, ui: Record<string, unknown> | undefined = {}): string {
  const def = resolveActionsFor({ modelUi: o.ui, kind: 'object', id: o.id, typeDefaults: typeOf(o.type).defaults });
  const KINDS = ['toggle', 'more-info', 'popup', 'navigate', 'url', 'perform-action', 'none'];
  const FIELDS: Record<string, [string, string][]> = {
    navigate: [['navigation_path', '/lovelace/0']], url: [['url_path', 'https://… or /local/…']],
    'perform-action': [['perform_action', 'light.turn_on'], ['target', 'target entity_id']],
  };
  const id = esc(o.id);
  let sels = '', fields = '', warn = '';
  for (const [w, label] of [['tap', 'Tap'], ['hold', 'Hold'], ['double_tap', 'Double tap']]) {
    const cur = ((ui || {})[`${w}_action`] || null) as UiAction | null; // saved by setObjAction
    const dw = def[w];
    const d = dw ? dw.action : 'none';
    sels += `<label class="act">${label}<select data-field="obj-act" data-id="${id}" data-which="${w}">
        <option value="">Default (${esc(d)})</option>${KINDS.map((k) => `<option value="${k}"${cur && cur.action === k ? ' selected' : ''}>${k}</option>`).join('')}</select></label>`;
    if (cur) for (const [key, ph] of FIELDS[cur.action] || []) {
      const v = key === 'target' ? (cur.target && cur.target.entity_id) || '' : cur[key] || '';
      fields += `<input data-field="obj-act-field" data-id="${id}" data-which="${w}" data-key="${key}" value="${esc(v)}" placeholder="${esc(`${label}: ${ph}`)}">`;
    }
    const msg = cur && validateAction(cur);
    if (msg) warn += `<div class="badge warn">${esc(label)}: ${esc(msg)}</div>`;
  }
  // Popup rows: Automatic (type / model list plus the light's capabilities) or only on / off
  if (o.type === 'light' || o.type === 'light_strip') {
    const pl = (ui || {}).popup;
    const only = Array.isArray(pl) && pl.length === 1 && pl[0] === 'toggle';
    const custom = Array.isArray(pl) && !only; // a list written in the layout / model: kept until changed
    sels += `<label class="act">Popup<select data-field="obj-popup" data-id="${id}">
        <option value="">Automatic</option><option value="toggle"${only ? ' selected' : ''}>Only on / off</option>${custom ? '<option value="custom" selected>Custom (from layout)</option>' : ''}</select></label>`;
  }
  return `<div class="oacts">${sels}</div>${fields}${warn}`;
}

export function setObjAction(ed: EditMode, el: FieldEl) {
  const id = el.dataset.id || '', which = el.dataset.which || '';
  const cur = ((((ed.layout.objects || {})[id] || {}).ui || {})[`${which}_action`] || null) as UiAction | null; // saved by this function
  if (el.dataset.field === 'obj-act') {
    const v = el.value;
    ed.commit(E.setObjectUi(ed.layout, id, which, v ? (cur && cur.action === v ? cur : { action: v }) : null));
    return;
  }
  if (!cur) return;
  const key = el.dataset.key || '', v = el.value.trim();
  const next: UiAction = { ...cur };
  if (key === 'target') {
    if (v) next.target = { entity_id: v };
    else delete next.target;
  } else if (v) next[key] = v;
  else delete next[key];
  ed.commit(E.setObjectUi(ed.layout, id, which, next));
}

// A click on an object in 3D (Objects tab): open its room, select and show its row.
export function selectObject(ed: EditMode, id: string) {
  const mb = ed.card.modelBindings();
  const o = mb && mb.manifest.objects.find((x) => x.id === id);
  if (!o) return;
  ed.objSel = id;
  ed.objExpanded.add(`${o.level}/${o.room || ''}`);
  ed.render();
  const row = [...ed.panel.querySelectorAll<HTMLElement>('li.obj')].find((x) => x.dataset.obj === id);
  if (row) {
    row.scrollIntoView({ block: 'nearest' });
    row.classList.add('flash');
  }
}

function bulkTag(ed: EditMode, btn: HTMLElement) {
  const tag = (ed.objTagBulk || '').trim();
  if (!tag) { ed.message = { text: 'Type a tag first.', warn: true }; ed.render(); return; }
  const ids = [...ed.objPicked];
  const cur = (x: string) => objTags(ed, x).cur, def = (x: string) => objTags(ed, x).def;
  ed.commit(btn.dataset.act === 'tag-bulk-add' ? E.addTagToObjects(ed.layout, ids, tag, cur, def) : E.removeTagFromObjects(ed.layout, ids, tag, cur, def));
  ed.render();
}

const acts: Record<string, ActHandler> = {
  'tag-rm': (ed, btn) => {
    const id = btn.dataset.id || '';
    const t = objTags(ed, id);
    ed.commit(E.setObjectTags(ed.layout, id, t.cur.filter((x) => x !== btn.dataset.tag), t.def));
    ed.render();
  },
  'tag-bulk-add': bulkTag,
  'tag-bulk-rm': bulkTag,
  'tag-pick-all': (ed) => {
    const mb = ed.card.modelBindings();
    for (const o of (mb && mb.manifest.objects) || []) if (objTags(ed, o.id).cur.includes(ed.objTagFilter)) ed.objPicked.add(o.id);
    ed.render();
  },
  'tag-pick-none': (ed) => {
    ed.objPicked.clear();
    ed.render();
  },
  'obj-expand': (ed, btn) => {
    const key = btn.dataset.key || '';
    if (ed.objExpanded.has(key)) ed.objExpanded.delete(key);
    else ed.objExpanded.add(key);
    ed.render();
  },
  'obj-test': (ed, btn) => {
    if (!ed.card.testObject(btn.dataset.id || '')) ed.message = { text: 'Nothing to toggle: bind a working entity first.', warn: true };
    ed.render();
  },
};

const objAction: FieldHandler = (ed, el) => {
  setObjAction(ed, el);
  ed.render();
};

// every field of an object row carries its object / tag id in data-id
const idOf = (el: FieldEl): string => el.dataset.id || '';

const fields: Record<string, FieldHandler> = {
  'obj-entity': (ed, el) => {
    const v = el.value.trim();
    ed.commit(E.setObject(ed.layout, idOf(el), { entity: v === '' ? undefined : v.toLowerCase() === 'none' ? null : v }));
    ed.render();
  },
  'obj-popup': (ed, el) => {
    if (el.value !== 'custom') ed.commit(E.setObjectUi(ed.layout, idOf(el), 'popup', el.value ? ['toggle'] : null));
    ed.render();
  },
  'obj-act': objAction,
  'obj-act-field': objAction,
  'obj-hidden': (ed, el) => {
    ed.commit(E.setObject(ed.layout, idOf(el), { hidden: el.checked }));
    ed.render();
  },
  'obj-label': (ed, el) => {
    ed.commit(E.setObject(ed.layout, idOf(el), { label: el.value }));
    ed.render();
  },
  'grp-label': (ed, el) => {
    ed.commit(E.setTag(ed.layout, idOf(el), { label: el.value }));
    ed.render();
  },
  'obj-wash': (ed, el) => {
    ed.commit(E.setObject(ed.layout, idOf(el), { wash: el.value || undefined }));
    ed.render();
  },
  'grp-wash': (ed, el) => {
    ed.commit(E.setTag(ed.layout, idOf(el), { wash: el.value }));
    ed.render();
  },
  'grp-entity': (ed, el) => {
    ed.commit(E.setTag(ed.layout, idOf(el), { entity: el.value.trim() }));
    ed.render();
  },
  'tag-add': (ed, el) => {
    const v = el.value.trim();
    if (!v) return;
    const t = objTags(ed, idOf(el));
    if (!t.cur.includes(v)) ed.commit(E.setObjectTags(ed.layout, idOf(el), [...t.cur, v], t.def));
    ed.render();
  },
  'tag-bulk': (ed, el) => {
    ed.objTagBulk = el.value;
  },
  'obj-pick': (ed, el) => {
    if (el.checked) ed.objPicked.add(idOf(el));
    else ed.objPicked.delete(idOf(el));
    ed.render();
  },
  'obj-tag-filter': (ed, el) => {
    ed.objTagFilter = el.value;
    ed.render();
  },
};

export const objectsTabDef = defineTab({ id: 'objects', html: objectsTab, acts, fields });

