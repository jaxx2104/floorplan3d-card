// Objects tab: model objects by level and room with their entity, label, actions, wash and tags.

import * as E from "../../editor.ts";
import { objectTags, layoutTags } from "../../objects/logic.ts";
import { actionTarget } from "../../objects/popup.ts";
import { typeOf } from "../../objects/types.ts";
import { resolveWash, washSetting, WASH_DIRS } from "../../objects/wash.ts";
import { resolveActions, validateAction } from "../../actions.ts";
import { html, nothing } from "lit/html.js";
import { classMap } from "lit/directives/class-map.js";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import {
  act,
  checkField,
  entityInput,
  entityList,
  field,
  flash,
  logoBox,
  options,
  selectField,
} from "../html.ts";
import type { TemplateResult } from "lit/html.js";
import type { TabDef } from "./tab.ts";
import type { View } from "../html.ts";
import type { EditMode } from "../../edit-mode.ts";
import type { ManifestLevel, ManifestObject } from "../../types/manifest.ts";
import type { ObjectBinding } from "../../objects/logic.ts";
import type { LayoutObject } from "../../types/layout.ts";

/** A saved action (layout.objects[id].ui.<which>_action). */
interface UiAction {
  action: string;
  target?: { entity_id?: string };
  [key: string]: unknown;
}

export function objectsAvailable(ed: EditMode): boolean {
  const mb = ed.view.model && ed.card.modelBindings();
  return !!(mb && mb.manifest.objects && mb.manifest.objects.length);
}

const DOMAINS: Record<string, string[]> = {
  light: ["light", "switch"],
  light_strip: ["light", "switch"],
  mower: ["lawn_mower"],
  dock: ["lawn_mower", "binary_sensor"],
  ev_charger: ["sensor", "switch", "binary_sensor"],
  climate: ["climate"],
  cover: ["cover"],
};
const ICONS: Record<string, string> = {
  light: "mdi:lightbulb",
  light_strip: "mdi:led-strip-variant",
  mower: "mdi:robot-mower",
  dock: "mdi:home-lightning-bolt",
  ev_charger: "mdi:ev-station",
  climate: "mdi:thermostat",
  cover: "mdi:curtains",
};
// "Light on wall" (the wash): object > tag > model; the default option names what applies without a setting
const WASH_LABEL: Record<string, string> = {
  down: "Down",
  up: "Up",
  both: "Up and down",
  none: "None",
  point: "Around the lamp",
  spot: "Where it aims",
  model: "from the model",
};
const isLight = (o: ManifestObject) =>
  o.type === "light" || o.type === "light_strip";

function washSelect(
  ed: EditMode,
  name: string,
  id: string,
  cur: string | undefined,
  def: string,
  onChange: (v: string) => void,
): TemplateResult {
  return selectField(ed, {
    name,
    id,
    cls: "owash",
    label: "Light on wall",
    value: cur || "",
    options: [
      ["", `Default (${WASH_LABEL[def] || def})`],
      ...WASH_DIRS.map((d): [string, string] => [d, WASH_LABEL[d]]),
    ],
    onChange,
  });
}

// Objects tab: model objects by level -> room (rooms collapsed), each with its entity binding.
export function objectsTab(ed: EditMode): View {
  const mb = ed.card.modelBindings();
  if (!mb) return nothing; // the tab shows only with a model's objects (objectsAvailable)
  const objs = mb.manifest.objects || [];
  const states = ed.hass.states;
  const bindings: Map<string, ObjectBinding> = ed.card._bindings || new Map();
  const ids = Object.keys(states).sort();
  const listFor = (type: string) => {
    const d = DOMAINS[type];
    return d ? ids.filter((id) => d.includes(id.split(".")[0])) : ids;
  };
  const types = [
    ...new Set(objs.map((o) => (DOMAINS[o.type] ? o.type : "other"))),
  ];
  const lo: Record<string, LayoutObject> = ed.layout.objects || {};
  const lgAll = layoutTags(ed.layout);
  // tags: chips (x removes), + adds (datalist of known tags)
  const tagsOf = (o: ManifestObject): string[] =>
    objectTags(o, lo[o.id], (bindings.get(o.id) || {}).entity, ed.hass); // from the layout: fresh right after an edit
  const allTags = [
    ...new Set([...objs.flatMap(tagsOf), ...Object.keys(lgAll)]),
  ].sort((x, y) => x.localeCompare(y));
  const rowView = (o: ManifestObject) => {
    const b: Partial<ObjectBinding> = bindings.get(o.id) || {};
    const t = DOMAINS[o.type] ? o.type : "other";
    const saved: LayoutObject = lo[o.id] || {};
    const explicit = saved.entity !== undefined;
    const sug = (o.suggest || {}).entity;
    let badge: View = nothing,
      value = "",
      ph = "auto: none";
    if (explicit) {
      value = saved.entity === null ? "none" : (saved.entity ?? ""); // explicit: defined
      if (b.missing)
        badge = html`<span class="badge warn">entity not found</span>`;
    } else if (b.entity && b.from === "mower") {
      badge = html`<span class="badge">auto</span>`;
      ph = `auto: ${b.entity} (from Mower tab)`;
    } else if (b.entity) {
      badge = html`<span class="badge">auto</span>`;
      ph = b.entity;
    } else if (sug) {
      badge = html`<span class="badge warn">entity not found</span>`;
      ph = `auto: ${sug}`;
    }
    // Test only where a tap could toggle something (not hidden, own entity or a known group controller)
    const testable = !b.hidden && !!actionTarget(o, b, ed.card._groups || {});
    return html`<li class=${classMap({ obj: true, sel: ed.objSel === o.id, hid: !!b.hidden })} data-obj=${o.id}>
        <div class="orow"><input type="checkbox" class="opick" name="obj-pick" data-id=${o.id} .checked=${live(ed.objPicked.has(o.id))} title="Select for Add tag / Remove tag" aria-label="Select"
          @change=${(e: Event) => pickObject(ed, o.id, field(e).checked)}><ha-icon icon=${ICONS[t] || "mdi:cube-outline"}></ha-icon>${logoBox(ed, b.entity)}<span class="name">${ed.card.objectLabel(o)}</span>${badge}
          ${testable ? html`<button name="obj-test" data-id=${o.id} title="Toggle it like a tap in the view" @click=${act(ed, () => testObject(ed, o.id))}>Test</button>` : nothing}
          ${checkField(ed, { name: "obj-hidden", id: o.id, label: "Hide", checked: !!b.hidden, onChange: (v) => setObj(ed, o.id, { hidden: v }) })}</div>
        <input class="olabel" name="obj-label" data-id=${o.id} .value=${saved.label || ""} placeholder=${o.label || o.id} title="Label (empty: the model's)" aria-label="Label"
          @change=${(e: Event) => setObj(ed, o.id, { label: field(e).value })}>
        ${entityInput(ed, { name: "obj-entity", id: o.id, list: `fp-obj-${t}`, domains: DOMAINS[t], label: explicit ? "Entity" : `Entity (${ph})`, none: "No entity", value, placeholder: ph, title: "Empty: automatic; type none to leave it unbound", onChange: (v) => setObjEntity(ed, o.id, v) })}
        ${isLight(o) ? washSelect(ed, "obj-wash", o.id, saved.wash, resolveWash(o.hints, undefined, tagsOf(o), lgAll), (v) => setObj(ed, o.id, { wash: washSetting(v) ?? undefined })) : nothing}
        <div class="otags">${tagsOf(o).map(
          (
            g,
          ) => html`<span class="otag">${g}<button class="link" name="tag-rm" data-id=${o.id} data-tag=${g} title="Remove the tag" aria-label="Remove ${g}"
          @click=${act(ed, () => removeTag(ed, o.id, g))}>×</button></span>`,
        )}
          <input class="tagadd" list="fp-tag-names" name="tag-add" data-id=${o.id} placeholder="+ tag" title="Add a tag (Enter)" aria-label="Add a tag" @change=${(e: Event) => addTag(ed, o.id, field(e))}></div>
        ${objActionsView(ed, o, saved.ui)}</li>`;
  };
  const filter =
    ed.objTagFilter && allTags.includes(ed.objTagFilter) ? ed.objTagFilter : "";
  const shownObjs = filter
    ? objs.filter((o) => tagsOf(o).includes(filter))
    : objs;
  for (const id of [...ed.objPicked])
    if (!objs.some((o) => o.id === id)) ed.objPicked.delete(id);
  const levelOf = new Map<string | null, ManifestLevel>(
    mb.manifest.levels.map((l) => [l.id, l]),
  );
  const roomOf = new Map(mb.manifest.rooms.map((r) => [r.id, r]));
  const order = [
    ...new Set([
      ...mb.manifest.levels.map((l) => l.id),
      ...objs.map((o) => o.level),
    ]),
  ];
  // the tree as keyed rows: level headers, room headers (expand), the objects of open rooms
  type Row = { key: string; view: () => TemplateResult };
  const rows: Row[] = [];
  for (const lid of order) {
    const inLevel = shownObjs.filter((o) => o.level === lid);
    if (!inLevel.length) continue;
    const lv = levelOf.get(lid);
    rows.push({
      key: `level:${lid}`,
      view: () =>
        html`<li class="room lvl"><span class="name">${lv ? lv.label : lid || "No level"}</span></li>`,
    });
    for (const rid of [...new Set(inLevel.map((o) => o.room || ""))]) {
      const list = inLevel.filter((o) => (o.room || "") === rid);
      const key = `${lid}/${rid}`;
      const open =
        !!filter ||
        ed.objExpanded.has(key) ||
        list.some((o) => o.id === ed.objSel);
      const r = roomOf.get(rid);
      rows.push({
        key: `room:${key}`,
        view: () => html`<li class="room" style="--d:1"><button class="link expand" name="obj-expand" data-key=${key} @click=${act(ed, () => toggleExpand(ed, key))}>${open ? "▾" : "▸"}</button>
          <span class="name">${r ? r.label : rid ? rid : "No room"}</span><span class="dim">${list.length}</span></li>`,
      });
      if (open)
        for (const o of list)
          rows.push({ key: `obj:${o.id}`, view: () => rowView(o) });
    }
  }
  const nPick = ed.objPicked.size;
  return html`${types.map((t) => entityList(ed, `fp-obj-${t}`, listFor(t)))}<datalist id="fp-tag-names">${allTags.map((x) => html`<option value=${x}></option>`)}</datalist>
      <p class="hint">Bind each model object to a Home Assistant entity. Empty means automatic; No entity ("none" in the plain input) leaves it unbound. Click an object in the plan to find its row. Tap / Hold / Double tap pick its actions (card YAML <code>actions:</code> overrides these). Tags group objects (model group and HA labels by default).</p>
      <div class="otagbar"><label>Tag <select name="obj-tag-filter" .value=${live(filter)} @change=${(
        e: Event,
      ) => {
        ed.objTagFilter = field(e).value;
        ed.render();
      }}>
        ${options([["", "All objects"], ...allTags.map((x): [string, string] => [x, x])], filter)}</select></label>
      <span class="dim">${nPick} selected</span><input class="tagadd" list="fp-tag-names" name="tag-bulk" placeholder="tag" aria-label="Tag for the selection" .value=${ed.objTagBulk || ""}
        @change=${(e: Event) => {
          ed.objTagBulk = field(e).value;
        }}>
      <button ?disabled=${!nPick} @click=${act(ed, () => bulkTag(ed, true))}>Add tag</button><button ?disabled=${!nPick} @click=${act(ed, () => bulkTag(ed, false))}>Remove tag</button>
      ${filter ? html`<button class="link" @click=${act(ed, () => pickAll(ed))}>Select all ${shownObjs.length}</button>` : nothing}${nPick ? html`<button class="link" @click=${act(ed, () => ed.objPicked.clear())}>Clear</button>` : nothing}</div>
      <ul class="otree">${repeat(
        rows,
        (r) => r.key,
        (r) => r.view(),
      )}</ul>
      ${allTags.length ? tagsView(ed, objs, allTags, tagsOf) : nothing}`;
}

// Tags: controller entity, popup label and wash per tag.
function tagsView(
  ed: EditMode,
  objs: ManifestObject[],
  allTags: string[],
  tagsOf: (o: ManifestObject) => string[],
): TemplateResult {
  const lg = layoutTags(ed.layout);
  const states = ed.hass.states;
  const gl = Object.keys(states)
    .sort()
    .filter((id) => /^(light|switch|input_boolean)\./.test(id));
  return html`<div class="sub">Tags</div><p class="hint">A tag's controller must be on too: an object is lit only while its own entity and the controllers of all its tags are on. Objects sharing a controller tag share the real-light budget. Views and card YAML <code>actions:</code> accept <code>tag:&lt;name&gt;</code>. Light on wall: the wash a lit lamp throws on the wall next to it (an object's own setting wins over its tags', a tag's over the model's).</p>
      ${entityList(ed, "fp-grp-ents", gl)}
      ${repeat(
        allTags,
        (g) => g,
        (g) => {
          const e = (lg[g] && lg[g].entity) || "",
            gl2 = (lg[g] && lg[g].label) || "";
          const n = objs.filter((o) => tagsOf(o).includes(g)).length;
          return html`<div class="grp" data-grp=${g}>${gl2 || g} <span class="dim">${n}</span>${e && !states[e] ? html` <span class="badge warn">entity not found</span>` : nothing}
        ${entityInput(ed, { name: "grp-entity", id: g, list: "fp-grp-ents", domains: ["light", "switch", "input_boolean"], label: "Controller", value: e, placeholder: "no controller", title: "Empty or none: no controller", onChange: (v) => setTag(ed, g, { entity: v.trim() }) })}
        <input class="glabel" name="grp-label" data-id=${g} .value=${gl2} placeholder="label: ${g}" title="Label in popups (empty: the controller's name)" @change=${(e2: Event) => setTag(ed, g, { label: field(e2).value })}></div>
      ${objs.some((o) => isLight(o) && tagsOf(o).includes(g)) ? washSelect(ed, "grp-wash", g, lg[g] && lg[g].wash, "model", (v) => setTag(ed, g, { wash: washSetting(v) ?? undefined })) : nothing}`;
        },
      )}`;
}

// Objects tab: current and default tags of an object (default = fp.group + HA labels of its entity).
export function objTags(
  ed: EditMode,
  id: string,
): { cur: string[]; def: string[] } {
  const mb = ed.card.modelBindings();
  const o = mb && mb.manifest.objects.find((x) => x.id === id);
  const b: Partial<ObjectBinding> =
    (ed.card._bindings && ed.card._bindings.get(id)) || {};
  if (!o) return { cur: [], def: [] };
  return {
    cur: objectTags(o, (ed.layout.objects || {})[id], b.entity, ed.hass),
    def: objectTags(o, null, b.entity, ed.hass),
  };
}

// Objects tab: Tap / Hold / Double tap selects (Default = the model / type action) with the fields each needs.
export function objActionsView(
  ed: EditMode,
  o: ManifestObject,
  ui: Record<string, unknown> | undefined = {},
): TemplateResult {
  const def = resolveActions({
    modelUi: o.ui,
    kind: "object",
    id: o.id,
    typeDefaults: typeOf(o.type).defaults,
  });
  const KINDS = [
    "toggle",
    "more-info",
    "popup",
    "navigate",
    "url",
    "perform-action",
    "none",
  ];
  const FIELDS: Record<string, [string, string][]> = {
    navigate: [["navigation_path", "/lovelace/0"]],
    url: [["url_path", "https://… or /local/…"]],
    "perform-action": [
      ["perform_action", "light.turn_on"],
      ["target", "target entity_id"],
    ],
  };
  const sels: TemplateResult[] = [],
    fields: TemplateResult[] = [],
    warn: TemplateResult[] = [];
  for (const [w, label] of [
    ["tap", "Tap"],
    ["hold", "Hold"],
    ["double_tap", "Double tap"],
  ] as const) {
    const cur = ((ui || {})[`${w}_action`] || null) as UiAction | null; // saved by setObjAction
    const dw = def[w];
    const d = dw ? dw.action : "none";
    const v = cur ? cur.action : "";
    sels.push(
      selectField(ed, {
        name: "obj-act",
        id: o.id,
        which: w,
        cls: "act",
        label,
        value: v,
        options: [
          ["", `Default (${d})`],
          ...KINDS.map((k): [string, string] => [k, k]),
        ],
        onChange: (x) => setObjAction(ed, o.id, w, x),
      }),
    );
    if (cur)
      for (const [key, ph] of FIELDS[cur.action] || []) {
        const fv =
          key === "target"
            ? (cur.target && cur.target.entity_id) || ""
            : String(cur[key] || "");
        fields.push(html`<input name="obj-act-field" data-id=${o.id} data-which=${w} data-key=${key} .value=${fv} placeholder="${label}: ${ph}"
        @change=${(e: Event) => setObjActionField(ed, o.id, w, key, field(e).value)}>`);
      }
    const msg = cur && validateAction(cur);
    if (msg) warn.push(html`<div class="badge warn">${label}: ${msg}</div>`);
  }
  // Popup rows: Automatic (type / model list plus the light's capabilities) or only on / off
  if (isLight(o)) {
    const pl = (ui || {}).popup;
    const only = Array.isArray(pl) && pl.length === 1 && pl[0] === "toggle";
    const custom = Array.isArray(pl) && !only; // a list written in the layout / model: kept until changed
    const v = only ? "toggle" : custom ? "custom" : "";
    sels.push(
      selectField(ed, {
        name: "obj-popup",
        id: o.id,
        cls: "act",
        label: "Popup",
        value: v,
        options: [
          ["", "Automatic"],
          ["toggle", "Only on / off"],
          ...(custom
            ? [["custom", "Custom (from layout)"] as [string, string]]
            : []),
        ],
        onChange: (x) => setPopup(ed, o.id, x),
      }),
    );
  }
  return html`<div class="oacts">${sels}</div>${fields}${warn}`;
}

export function setObjAction(
  ed: EditMode,
  id: string,
  which: string,
  v: string,
) {
  const cur = ((((ed.layout.objects || {})[id] || {}).ui || {})[
    `${which}_action`
  ] || null) as UiAction | null; // saved by these functions
  ed.commit(
    E.setObjectUi(
      ed.layout,
      id,
      which,
      v ? (cur && cur.action === v ? cur : { action: v }) : null,
    ),
  );
  ed.render();
}

export function setObjActionField(
  ed: EditMode,
  id: string,
  which: string,
  key: string,
  value: string,
) {
  const cur = ((((ed.layout.objects || {})[id] || {}).ui || {})[
    `${which}_action`
  ] || null) as UiAction | null;
  if (!cur) return;
  const v = value.trim();
  const next: UiAction = { ...cur };
  if (key === "target") {
    if (v) next.target = { entity_id: v };
    else delete next.target;
  } else if (v) next[key] = v;
  else delete next[key];
  ed.commit(E.setObjectUi(ed.layout, id, which, next));
  ed.render();
}

// A click on an object in 3D (Objects tab): open its room, select and show its row.
export function selectObject(ed: EditMode, id: string) {
  const mb = ed.card.modelBindings();
  const o = mb && mb.manifest.objects.find((x) => x.id === id);
  if (!o) return;
  ed.objSel = id;
  ed.objExpanded.add(`${o.level}/${o.room || ""}`);
  ed.renderNow();
  const row = [...ed.panel.querySelectorAll<HTMLElement>("li.obj")].find(
    (x) => x.dataset.obj === id,
  );
  if (row) {
    row.scrollIntoView({ block: "nearest" });
    flash(row, 1300);
  }
}

export function bulkTag(ed: EditMode, add: boolean) {
  const tag = (ed.objTagBulk || "").trim();
  if (!tag) {
    ed.message = { text: "Type a tag first.", warn: true };
    return;
  }
  const ids = [...ed.objPicked];
  const cur = (x: string) => objTags(ed, x).cur,
    def = (x: string) => objTags(ed, x).def;
  ed.commit(
    add
      ? E.addTagToObjects(ed.layout, ids, tag, cur, def)
      : E.removeTagFromObjects(ed.layout, ids, tag, cur, def),
  );
}

export function removeTag(ed: EditMode, id: string, tag: string) {
  const t = objTags(ed, id);
  ed.commit(
    E.setObjectTags(
      ed.layout,
      id,
      t.cur.filter((x) => x !== tag),
      t.def,
    ),
  );
}

// Enter / change in a row's "+ tag" input: the tag is added and the input cleared for the next one.
export function addTag(ed: EditMode, id: string, el: HTMLInputElement) {
  const v = el.value.trim();
  el.value = "";
  if (!v) return;
  const t = objTags(ed, id);
  if (!t.cur.includes(v))
    ed.commit(E.setObjectTags(ed.layout, id, [...t.cur, v], t.def));
  ed.render();
}

export function pickAll(ed: EditMode) {
  const mb = ed.card.modelBindings();
  for (const o of (mb && mb.manifest.objects) || [])
    if (objTags(ed, o.id).cur.includes(ed.objTagFilter)) ed.objPicked.add(o.id);
}

export function pickObject(ed: EditMode, id: string, on: boolean) {
  if (on) ed.objPicked.add(id);
  else ed.objPicked.delete(id);
  ed.render();
}

export function toggleExpand(ed: EditMode, key: string) {
  if (ed.objExpanded.has(key)) ed.objExpanded.delete(key);
  else ed.objExpanded.add(key);
}

export function testObject(ed: EditMode, id: string) {
  if (!ed.card.testObject(id))
    ed.message = {
      text: "Nothing to toggle: bind a working entity first.",
      warn: true,
    };
}

export function setObj(ed: EditMode, id: string, patch: Partial<LayoutObject>) {
  ed.commit(E.setObject(ed.layout, id, patch));
  ed.render();
}

export function setObjEntity(ed: EditMode, id: string, value: string) {
  const v = value.trim();
  setObj(ed, id, {
    entity: v === "" ? undefined : v.toLowerCase() === "none" ? null : v,
  });
}

export function setPopup(ed: EditMode, id: string, v: string) {
  if (v !== "custom")
    ed.commit(E.setObjectUi(ed.layout, id, "popup", v ? ["toggle"] : null));
  ed.render();
}

export function setTag(
  ed: EditMode,
  tag: string,
  patch: Parameters<typeof E.setTag>[2],
) {
  ed.commit(E.setTag(ed.layout, tag, patch));
  ed.render();
}

export const objectsTabDef: TabDef = {
  id: "objects",
  label: "Objects",
  view: objectsTab,
};
