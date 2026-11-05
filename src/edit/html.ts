// Template parts shared by the edit panel's tabs (lit-html): sliders, HA's pickers (<ha-selector>: entity,
// area, floor, select, boolean) with native fallbacks where HA's elements are missing (entity inputs with
// their integration logo and datalists, selects, checkboxes), and the click wrapper every panel button goes through.

import { html, nothing } from "lit/html.js";
import { live } from "lit/directives/live.js";
import * as E from "../editor.ts";
import { platformOf, entityOptionLabel, integrationName } from "../badges.ts";
import { logoSrc, logoFailed } from "../badge-dom.ts";
import type { TemplateResult } from "lit/html.js";
import type { EditMode } from "../edit-mode.ts";

export type View = TemplateResult | typeof nothing;

// Clipboard API needs a secure context (HA over plain http has none): fall back to a hidden textarea.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  let ok: boolean;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
export const fmt = (v: number): string =>
  (Math.round(v * 100) / 100).toString();

/** The control an event came from (panel listeners are bound on inputs and selects). */
export const field = (e: Event): HTMLInputElement =>
  e.target as HTMLInputElement;

// A panel button's click: clears the message, runs the handler, then the stage classes and the panel follow
// (the render is coalesced with the one a commit asks for).
export function act(ed: EditMode, fn: () => void): () => void {
  return () => {
    ed.message = null;
    fn();
    ed._syncStageClasses();
    ed.render();
  };
}

// restarts a transient highlight animation on a rendered row (classMap leaves classes it did not set alone)
export function flash(el: HTMLElement, ms: number, cls = "flash") {
  el.classList.remove(cls);
  void el.offsetWidth; // restart the animation
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

// <option>s with the current one selected; pair with .value=${live(cur)} on the <select> (the options
// may not exist yet when the select's value is first set).
export function options(
  list: readonly (readonly [string, string])[],
  cur: string | null | undefined,
): TemplateResult[] {
  return list.map(
    ([v, label]) =>
      html`<option value=${v} ?selected=${v === cur}>${label}</option>`,
  );
}

export interface SliderOpts {
  name: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: unknown;
  unit?: string;
  /** every move (the drag shows the value in the number box either way) */
  onInput?: (v: number) => void;
  /** release, or a number typed / stepped */
  onChange?: (v: number) => void;
}

// Every edit-mode slider: a range plus a number input with the same min / max / step and the unit after it.
// While dragged the number follows through a draft value; a number typed (Enter / change) or stepped with
// the arrow keys (saved 400 ms after the last key) is clamped, rounded and runs the slider's handlers.
export function slider(ed: EditMode, o: SliderOpts): TemplateResult {
  const key = "slider:" + o.name;
  const draft = ed.drafts.get(key);
  const v = draft !== undefined ? Number(draft) : Number(o.value);
  const apply = (num: HTMLInputElement, x: number) => {
    num.value = fmt(x);
    ed.drafts.delete(key);
    if (o.onInput) o.onInput(x);
    if (o.onChange) o.onChange(x);
    ed.render();
  };
  const commit = (num: HTMLInputElement) => {
    clearTimeout(ed._numTimer);
    const x = E.sliderValue(num.value, o.min, o.max, o.step);
    if (x === null) {
      num.value = fmt(v);
      return;
    } // not a number: back to the slider's value
    apply(num, x);
  };
  const onKey = (e: KeyboardEvent) => {
    const num = e.target as HTMLInputElement;
    if (e.key === "Enter") {
      e.preventDefault();
      commit(num);
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const cur = Number(String(num.value).replace(",", "."));
    const x = E.sliderValue(
      (Number.isFinite(cur) ? cur : o.min) +
        (e.key === "ArrowUp" ? o.step : -o.step),
      o.min,
      o.max,
      o.step,
    );
    if (x === null) return;
    num.value = fmt(x);
    clearTimeout(ed._numTimer);
    ed._numTimer = setTimeout(() => apply(num, x), 400);
  };
  return html`<label class="slider"><span class="lab">${o.label}</span><span class="slrow">
    <input type="range" name=${o.name} min=${o.min} max=${o.max} step=${o.step} .value=${String(v)}
      @input=${(e: Event) => {
        const x = Number(field(e).value);
        ed.drafts.set(key, String(x));
        if (o.onInput) o.onInput(x);
        ed.render();
      }}
      @change=${(e: Event) => {
        const x = Number(field(e).value);
        ed.drafts.delete(key);
        if (o.onChange) o.onChange(x);
        ed.render();
      }}>
    <input type="text" inputmode="decimal" pattern="-?[0-9]*[.,]?[0-9]*" class="slnum" data-for=${o.name} min=${o.min} max=${o.max} step=${o.step}
      .value=${fmt(v)} aria-label=${o.label} @change=${(e: Event) => commit(field(e))} @keydown=${onKey}><span class="unit">${o.unit || ""}</span></span></label>`;
  // the unit column also keeps unitless rows aligned
}

const dark = (ed: EditMode): boolean =>
  !!(ed.card._theme && ed.card._theme.dark);

// The integration logo of a platform (none, or its logo failed: nothing). A failed dark logo falls back to the
// light one, a failed light logo is not asked for again (badge-dom keeps the failures, markers share them).
export function logo(ed: EditMode, platform: string | null | undefined): View {
  const d = dark(ed);
  const src = logoSrc(platform, d);
  if (!platform || !src) return nothing;
  return html`<img class="fp-logo" alt="" decoding="async" referrerpolicy="no-referrer" title=${integrationName(platform)} src=${src}
    @error=${() => {
      logoFailed(platform, src);
      ed.render();
    }}>`;
}

// fixed 16 px box in a list row with the entity's integration logo
export function logoBox(
  ed: EditMode,
  eid: string | null | undefined,
): TemplateResult {
  return html`<span class="lg">${logo(ed, eid ? platformOf(ed.hass.entities, eid) : null)}</span>`;
}

/** HA's selector element is there (in HA once loadSelectors ran; never on the demo page). */
export const haSelectors = (): boolean =>
  typeof customElements !== "undefined" && !!customElements.get("ha-selector");

export interface SelectorOpts {
  name: string;
  /** row id (Objects tab ...) */
  id?: string;
  label?: string;
  selector: Record<string, unknown>;
  value: unknown;
  disabled?: boolean;
  title?: string;
  onChange: (v: unknown) => void;
}

// An HA <ha-selector> (entity / area / floor / select / boolean pickers). Its own value-changed stays here.
// Its dropdowns and lists open inside the panel's DOM, so their pointer events never reach the stage.
export function haSelector(ed: EditMode, o: SelectorOpts): TemplateResult {
  return html`<ha-selector class="fp-sel" name=${o.name} data-id=${o.id ?? nothing} title=${o.title ?? nothing} .hass=${ed.hass}
    .selector=${o.selector} .value=${o.value} .label=${o.label} .disabled=${!!o.disabled}
    @value-changed=${(e: CustomEvent<{ value: unknown }>) => {
      e.stopPropagation();
      o.onChange(e.detail ? e.detail.value : undefined);
      ed.render();
    }}></ha-selector>`;
}

const NONE = "__fp_none__"; // HA's select has no empty option value: stands for ""

export interface SelectFieldOpts {
  name: string;
  id?: string;
  /** data-which on the native select (Objects tab actions) */
  which?: string;
  label: string;
  /** the native fallback's <label> class */
  cls?: string;
  value: string;
  options: readonly (readonly [string, string])[];
  disabled?: boolean;
  title?: string;
  onChange: (v: string) => void;
}

// A select: HA's select selector (dropdown), else a native <select> in a <label>.
export function selectField(ed: EditMode, o: SelectFieldOpts): TemplateResult {
  if (haSelectors())
    return html`<div class=${`fp-field ${o.cls || ""}`}>${haSelector(ed, {
      name: o.name,
      id: o.id,
      label: o.label,
      title: o.title,
      disabled: o.disabled,
      value: o.value === "" ? NONE : o.value,
      selector: {
        select: {
          mode: "dropdown",
          options: o.options.map(([value, label]) => ({
            value: value === "" ? NONE : value,
            label,
          })),
        },
      },
      onChange: (v) => {
        const x = typeof v === "string" ? v : "";
        o.onChange(x === NONE ? "" : x);
      },
    })}</div>`;
  return html`<label class=${o.cls || nothing}>${o.label} <select name=${o.name} data-id=${o.id ?? nothing} data-which=${o.which ?? nothing}
    ?disabled=${!!o.disabled} title=${o.title ?? nothing} .value=${live(o.value)} @change=${(e: Event) => o.onChange(field(e).value)}>${options(o.options, o.value)}</select></label>`;
}

export interface CheckFieldOpts {
  name: string;
  id?: string;
  /** data-key on the native checkbox */
  dataKey?: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  /** after the label (e.g. "(card YAML)") */
  note?: View;
  onChange: (v: boolean) => void;
}

// A checkbox: HA's boolean selector (a switch with its label), else a native checkbox in a label.check.
export function checkField(ed: EditMode, o: CheckFieldOpts): TemplateResult {
  if (haSelectors())
    return html`<div class="fp-field check">${haSelector(ed, {
      name: o.name,
      id: o.id,
      label: o.label,
      disabled: o.disabled,
      value: o.checked,
      selector: { boolean: {} },
      onChange: (v) => o.onChange(!!v),
    })}${o.note ?? nothing}</div>`;
  return html`<label class="check"><input type="checkbox" name=${o.name} data-id=${o.id ?? nothing} data-key=${o.dataKey ?? nothing}
    .checked=${live(o.checked)} ?disabled=${!!o.disabled} @change=${(e: Event) => o.onChange(field(e).checked)}> ${o.label}${o.note ?? nothing}</label>`;
}

/** The floor picker: HA's floor selector when every layout floor is an HA floor, else a select of the layout floors. */
export function floorField(
  ed: EditMode,
  o: Omit<SelectFieldOpts, "options">,
): TemplateResult {
  const ha = ed.hass.floors || {};
  const floors = ed.floors;
  if (haSelectors() && floors.length && floors.every((f) => ha[f.id]))
    return html`<div class="fp-field">${haSelector(ed, {
      name: o.name,
      id: o.id,
      label: o.label,
      value: o.value || undefined,
      selector: { floor: {} },
      onChange: (v) => {
        if (typeof v === "string" && v) o.onChange(v);
      },
    })}</div>`;
  return selectField(ed, {
    ...o,
    options: floors.map((f): [string, string] => [f.id, f.name]),
  });
}

export interface EntityInputOpts {
  name: string;
  /** row id (Objects tab) */
  id?: string;
  /** the native input's datalist id */
  list: string;
  /** HA's entity picker: only these domains */
  domains?: readonly string[];
  /** the label of HA's picker (the native input sits in the caller's <label>) */
  label?: string;
  value: string;
  placeholder?: string;
  title?: string;
  /** a "none" value (no entity, unlike empty = automatic): HA's picker gets a switch with this label */
  none?: string;
  onChange: (v: string) => void;
}

// An entity picker: HA's entity selector (domains filter), else an input (datalist) with the logo of the
// typed entity's integration in front; saved on change.
export function entityInput(ed: EditMode, o: EntityInputOpts): TemplateResult {
  if (haSelectors()) {
    const isNone = !!o.none && o.value === "none";
    const pick = haSelector(ed, {
      name: o.name,
      id: o.id,
      label: o.label,
      title: o.title,
      value: isNone ? undefined : o.value || undefined,
      disabled: isNone,
      selector: {
        entity: o.domains ? { filter: { domain: [...o.domains] } } : {},
      },
      onChange: (v) => o.onChange(typeof v === "string" ? v : ""),
    });
    return html`<span class="entin ha">${pick}${
      o.none
        ? checkField(ed, {
            name: `${o.name}-none`,
            id: o.id,
            label: o.none,
            checked: isNone,
            onChange: (v) => o.onChange(v ? "none" : ""),
          })
        : nothing
    }</span>`;
  }
  const key = `ent:${o.name}:${o.id ?? ""}`;
  const draft = ed.drafts.get(key);
  const cur = (draft ?? o.value).trim();
  return html`<span class="entin">${logoBox(ed, cur)}<input list=${o.list} name=${o.name} data-id=${o.id ?? nothing} .value=${o.value}
    placeholder=${o.placeholder ?? nothing} title=${o.title ?? nothing}
    @input=${(e: Event) => {
      ed.drafts.set(key, field(e).value);
      ed.render();
    }}
    @change=${(e: Event) => {
      ed.drafts.delete(key);
      o.onChange(field(e).value);
      ed.render();
    }}></span>`;
}

// A labelled entity picker: HA's carries the label itself, the native input sits in a <label>.
export function entityField(
  ed: EditMode,
  label: string,
  o: EntityInputOpts,
): TemplateResult {
  return haSelectors()
    ? html`<div class="fp-field">${entityInput(ed, { ...o, label })}</div>`
    : html`<label>${label} ${entityInput(ed, o)}</label>`;
}

// <datalist> of entities: value = entity id, label = "<name> · <Integration>"
export function entityList(
  ed: EditMode,
  id: string,
  ids: readonly string[],
): View {
  if (haSelectors()) return nothing; // HA's pickers list the entities themselves
  return html`<datalist id=${id}>${ids.map((x) => html`<option value=${x} label=${entityOptionLabel(ed.hass, x)}></option>`)}</datalist>`;
}
