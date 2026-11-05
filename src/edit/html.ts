// Template parts shared by the edit panel's tabs (lit-html): sliders, entity inputs with their
// integration logo, datalists, select options, and the click wrapper every panel button goes through.

import { html, nothing } from "lit/html.js";
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
  !!(ed.card._built && ed.card._built.theme && ed.card._built.theme.dark);

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

export interface EntityInputOpts {
  name: string;
  /** row id (Objects tab) */
  id?: string;
  list: string;
  value: string;
  placeholder?: string;
  title?: string;
  onChange: (v: string) => void;
}

// An entity input (datalist) with the logo of the typed entity's integration in front; saved on change.
export function entityInput(ed: EditMode, o: EntityInputOpts): TemplateResult {
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

// <datalist> of entities: value = entity id, label = "<name> · <Integration>"
export function entityList(
  ed: EditMode,
  id: string,
  ids: readonly string[],
): TemplateResult {
  return html`<datalist id=${id}>${ids.map((x) => html`<option value=${x} label=${entityOptionLabel(ed.hass, x)}></option>`)}</datalist>`;
}
