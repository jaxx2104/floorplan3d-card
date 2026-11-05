// Object popup: a small panel next to a model object with its controls (toggle, brightness,
// colour, the group chain) and read-only values. popupRows() is the pure part (unit-tested).
import type * as THREE from "three";
import { typeOf } from "./types.ts";
import { controllersOf } from "./logic.ts";
import { toggleCall, popupLinks } from "../actions.ts";
import { applyBadges } from "../badge-dom.ts";
import type { ChainState, Controller, ObjectBinding } from "./logic.ts";
import type { ModelObject } from "./types.ts";
import type { PopupLink, PopupSource } from "../actions.ts";
import type { BadgeInfo } from "../badges.ts";
import type { HassEntity } from "../types/ha.ts";
import type { ActionConfig, LayoutTag } from "../types/layout.ts";

export { toggleCall };

type States = Record<string, HassEntity>;
type Groups = Record<string, LayoutTag | null | undefined>;
type ValueKind =
  "state" | "battery" | "power" | "energy" | "temperature" | "mode";
/** One popup row; entity: what its control acts on. */
export type PopupRow =
  | { kind: "toggle" | "chain"; entity: string; label: string; value: boolean }
  | { kind: "brightness"; entity: string; label: string; value: number }
  | {
      kind: "color";
      entity: string;
      label: string;
      value: number[] | null;
      hs: number[] | null;
    }
  | {
      kind: "color_temp";
      entity: string;
      label: string;
      value: number | null;
      min: number;
      max: number;
    }
  | {
      kind: "effect";
      entity: string;
      label: string;
      value: string | null;
      options: string[];
    }
  | { kind: "start_dock"; entity: string; label: string; value: string }
  | { kind: ValueKind; entity?: string; label: string; value: unknown }
  | { kind: "reason"; entity?: undefined; label: string }
  | { kind: "info"; entity?: undefined; label: string; value: unknown }
  | (PopupLink & { entity?: undefined });
type ObjLike = Pick<ModelObject, "type"> &
  Partial<Pick<ModelObject, "ui" | "group" | "label">>;

/** What the card hands the popup for the open object. */
export interface PopupData {
  obj: ObjLike;
  chain: ChainState | null;
  states?: States;
  groups?: Groups;
  popup?: unknown[] | null;
  popupSource?: PopupSource | null;
  badge?: BadgeInfo | null;
  dark?: boolean;
  extra?: { label: string; value: unknown }[];
}
export interface PopupOptions {
  onAction?: (
    domain: string,
    service: string,
    data: Record<string, unknown>,
  ) => void;
  onLink?: (action: ActionConfig) => void;
  project?: (world: THREE.Vector3) => readonly number[] | null;
  resolve?: (id: string) => PopupData | null;
  anchor?: ((id: string) => THREE.Vector3 | null | undefined) | null;
}

const KINDS = new Set([
  "toggle",
  "brightness",
  "color",
  "color_temp",
  "effect",
  "state",
  "battery",
  "power",
  "energy",
  "temperature",
  "mode",
  "start_dock",
]);
const COLOR_MODES = new Set<unknown>(["hs", "rgb", "xy", "rgbw", "rgbww"]);
export const PRESETS = [10, 30, 60, 100]; // brightness preset buttons (%)
export const WHEEL = 132; // colour wheel canvas size (css px)
const MUSIC = /music|sound|audio|rhythm|mic/i;
// Rows a bound light adds to a type / model popup list, in this order (the rest keep their listed order after them)
const LIGHT_ORDER = ["toggle", "brightness", "color", "color_temp", "effect"];
const LABELS: Record<string, string> = {
  toggle: "On / off",
  brightness: "Brightness",
  color: "Colour",
  color_temp: "Colour temperature",
  effect: "Effect",
  state: "State",
  battery: "Battery",
  power: "Power",
  energy: "Energy",
  temperature: "Temperature",
  mode: "Mode",
  start_dock: "Mower",
};

const domainOf = (e: string): string => String(e).split(".")[0];
// Start / Dock buttons: the service per domain (a robot vacuum can stand in for the mower)
const START_DOCK: Record<string, { start: string; dock: string } | undefined> =
  {
    lawn_mower: { start: "start_mowing", dock: "dock" },
    vacuum: { start: "start", dock: "return_to_base" },
  };
const bad = (s: HassEntity | null | undefined): boolean =>
  !s || s.state === "unavailable" || s.state === "unknown";
const nameOf = (states: States, e: string): string =>
  (states[e] && states[e].attributes && states[e].attributes.friendly_name) ||
  e;
const withUnit = (v: unknown, u: unknown): string =>
  u ? `${v} ${u}` : String(v);

// The entity a toggle / more-info acts on: the object's own entity, else its first tag controller.
// With states: an unavailable own entity (a bulb behind an off relay) falls back to a usable controller.
export function actionTarget(
  obj: Pick<ObjLike, "group"> | null | undefined,
  binding: Partial<ObjectBinding> | null | undefined,
  groups: Groups = {},
  states: States | null = null,
): string | null {
  if (binding && binding.hidden) return null;
  const ctrls = controllersOf(obj, binding, groups).map((c) => c.entity);
  const own = (binding && binding.entity) || null;
  if (own && states && bad(states[own])) {
    const ok = ctrls.find((c) => !bad(states[c]));
    if (ok) return ok;
  }
  return own || ctrls[0] || null;
}

/** Effect names for the select: music-like ones (music, sound, audio, rhythm, mic) first, the rest in their order. */
export function effectOrder(list: unknown): string[] {
  const all = (Array.isArray(list) ? list : []).filter(
    (x): x is string => typeof x === "string" && !!x,
  );
  return [
    ...all.filter((x) => MUSIC.test(x)),
    ...all.filter((x) => !MUSIC.test(x)),
  ];
}

/** Colour wheel: [hue 0..360, saturation 0..100] of a point dx, dy (px from the centre, y down) on a wheel of radius r. */
export function wheelHs(dx: number, dy: number, r: number): [number, number] {
  const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  return [
    Math.round(h * 10) / 10,
    Math.round(Math.min(1, Math.hypot(dx, dy) / r) * 1000) / 10,
  ];
}

/** Inverse of wheelHs: [dx, dy] of hue / saturation. */
export function wheelPoint(h: number, s: number, r: number): [number, number] {
  const a = (h * Math.PI) / 180,
    d = (Math.min(100, Math.max(0, s)) / 100) * r;
  return [Math.cos(a) * d, Math.sin(a) * d];
}

/** [hue, saturation] of an [r, g, b] colour (HSV saturation, value ignored). */
export function rgbToHs([r, g, b]: readonly number[]): [number, number] {
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b),
    d = mx - mn;
  let h = 0;
  if (d)
    h =
      mx === r
        ? ((g - b) / d) % 6
        : mx === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
  return [
    Math.round(((h * 60 + 360) % 360) * 10) / 10,
    mx ? Math.round((d / mx) * 1000) / 10 : 0,
  ];
}

function hsToRgb(h: number, s: number, v = 1): number[] {
  const c = v * s,
    x = c * (1 - Math.abs(((h / 60) % 2) - 1)),
    m = v - c;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [r + m, g + m, b + m].map((n) => Math.round(n * 255));
}

function readValue(kind: string, e: string, s: HassEntity): unknown {
  const a: HassEntity["attributes"] = s.attributes || {};
  const unit = a.unit_of_measurement;
  switch (kind) {
    case "state":
      return withUnit(s.state, unit);
    case "battery": {
      const v = a.battery_level ?? a.battery;
      if (v !== undefined && v !== null) return `${v} %`;
      return a.device_class === "battery" ? withUnit(s.state, unit) : null;
    }
    case "power": {
      if (unit === "W" || unit === "kW") return withUnit(s.state, unit);
      const v = a.current_power_w ?? a.power;
      return v !== undefined && v !== null ? `${v} W` : null;
    }
    case "energy": {
      if (unit === "kWh" || unit === "Wh") return withUnit(s.state, unit);
      const v = a.energy ?? a.total_energy_kwh;
      return v !== undefined && v !== null ? `${v} kWh` : null;
    }
    case "temperature": {
      const v = a.current_temperature;
      if (v !== undefined && v !== null)
        return a.temperature_unit ? `${v} ${a.temperature_unit}` : `${v}°`;
      return unit === "°C" || unit === "°F" ? withUnit(s.state, unit) : null;
    }
    case "mode":
      return domainOf(e) === "climate"
        ? s.state
        : (a.mode ?? a.preset_mode ?? null);
    default:
      return null;
  }
}

/**
 * Popup rows for an object: the popup list (resolved from fp.ui / layout / YAML; default fp.ui.popup or the
 * type default), plus the group chain, then link rows (history / logbook / statistics / custom) at the bottom.
 * groups (tag settings) tell the controllers apart from the object's own entity.
 * Unavailable / unbound: a single state row "unavailable" (and the links).
 * source (resolveActions().popupSource): 'type' or 'model' make the list automatic: the bound light's
 * capabilities (brightness, colour, colour temperature, effect) are added after the listed rows;
 * 'layout' / 'yaml' (or none) lists are respected exactly.
 */
export function popupRows(
  obj: ObjLike,
  chain: Partial<ChainState> | null | undefined,
  states: States = {},
  groups: Groups = {},
  popup: unknown[] | null = null,
  source: PopupSource | null = null,
): PopupRow[] {
  const ui: unknown[] = Array.isArray(popup)
    ? popup
    : obj.ui && Array.isArray(obj.ui.popup)
      ? obj.ui.popup
      : typeOf(obj.type).defaults.popup || [];
  const firstEntity =
    chain && chain.entities ? chain.entities[0] || null : null;
  const unavailable: PopupRow[] = [
    { kind: "state", label: "State", value: "unavailable" },
    ...popupLinks(ui, firstEntity),
  ];
  const entities = chain && chain.entities;
  if (!chain || !entities || !entities.some((e) => !bad(states[e])))
    return unavailable;
  // controllers: from the chain (tags), else the legacy fp.group lookup
  const ctrls = (chain.controllers || controllersOf(obj, null, groups)).filter(
    (c) => entities.includes(c.entity),
  );
  const isCtrl = (e: string): boolean => ctrls.some((c) => c.entity === e);
  const own = entities.find((e) => !isCtrl(e)) || null;
  const ctrl = ctrls.length ? ctrls[0].entity : null;
  const ownBad = !!own && bad(states[own]);
  // an unavailable own entity: only the (usable) controller row and the reason
  const main = ownBad ? null : own || ctrl;
  const light =
    entities.find((e) => e.startsWith("light.") && !bad(states[e])) || null;
  const ls = light ? states[light] : null;
  const modes: unknown[] | null =
    ls && Array.isArray(ls.attributes.supported_color_modes)
      ? ls.attributes.supported_color_modes
      : null;
  const want: string[] = [];
  for (const k of ui) {
    const kind = k === "start" || k === "dock" ? "start_dock" : k;
    if (typeof kind === "string" && KINDS.has(kind) && !want.includes(kind))
      want.push(kind);
  }
  if (ls && (source === "type" || source === "model")) {
    const has = (m: string): boolean => !!modes && modes.includes(m);
    const add = [
      !(modes && modes.every((m) => m === "onoff")) && "brightness",
      modes && modes.some((m) => COLOR_MODES.has(m)) && "color",
      has("color_temp") && "color_temp",
      Array.isArray(ls.attributes.effect_list) &&
        ls.attributes.effect_list.length &&
        "effect",
    ];
    for (const k of add) if (k && !want.includes(k)) want.push(k);
    const rank = (k: string): number => {
      const i = LIGHT_ORDER.indexOf(k);
      return i < 0 ? LIGHT_ORDER.length : i;
    };
    want.sort((a, b) => rank(a) - rank(b)); // stable: the other rows keep their order
  }
  const rows: PopupRow[] = [];
  // light rows below: light!, the entity of ls
  for (const kind of main ? want : []) {
    if (!main) break; // narrowing only: the loop runs only with main
    const label = LABELS[kind];
    if (kind === "toggle")
      rows.push({
        kind,
        entity: main,
        label,
        value: states[main].state === "on",
      });
    else if (kind === "brightness") {
      if (!ls || (modes && modes.every((m) => m === "onoff"))) continue;
      const b = ls.attributes.brightness;
      rows.push({
        kind,
        entity: light!,
        label,
        value:
          ls.state === "on" && typeof b === "number"
            ? b
            : ls.state === "on"
              ? 255
              : 0,
      });
    } else if (kind === "color") {
      if (!ls || !modes || !modes.some((m) => COLOR_MODES.has(m))) continue; // modes come from ls
      const a = ls.attributes,
        rgb = Array.isArray(a.rgb_color) ? a.rgb_color.slice(0, 3) : null;
      const hs =
        Array.isArray(a.hs_color) && a.hs_color.length >= 2
          ? a.hs_color.slice(0, 2)
          : rgb
            ? rgbToHs(rgb)
            : null;
      // the marker only while the light shows a colour (not in colour temperature mode)
      rows.push({
        kind,
        entity: light!,
        label,
        value: rgb,
        hs:
          ls.state === "on" && COLOR_MODES.has(a.color_mode as string)
            ? hs
            : null,
      });
    } else if (kind === "color_temp") {
      if (!ls || !modes || !modes.includes("color_temp")) continue; // modes come from ls
      const a = ls.attributes,
        num = (v: unknown, d: number): number =>
          typeof v === "number" && v > 0 ? v : d;
      const k = a.color_temp_kelvin;
      rows.push({
        kind,
        entity: light!,
        label,
        value: typeof k === "number" ? k : null,
        min: num(a.min_color_temp_kelvin, 2000),
        max: num(a.max_color_temp_kelvin, 6500),
      });
    } else if (kind === "effect") {
      const list = effectOrder(ls!.attributes.effect_list); // as before: a listed effect row needs a light
      if (!list.length) continue;
      rows.push({
        kind,
        entity: light!,
        label,
        value:
          typeof ls!.attributes.effect === "string"
            ? ls!.attributes.effect
            : null,
        options: list,
      });
    } else if (kind === "start_dock") {
      if (START_DOCK[domainOf(main)])
        rows.push({ kind, entity: main, label, value: states[main].state });
    } else {
      const value = readValue(kind, main, states[main]);
      if (value !== null && value !== undefined)
        rows.push({ kind: kind as ValueKind, entity: main, label, value }); // KINDS left: value kinds
    }
  }
  // a row per controller: the tag's label (layout.tags[name].label) when set, else the entity's name
  const labelOf = (c: Controller): string => {
    const g = groups[c.tag];
    return (
      (g && typeof g.label === "string" && g.label) || nameOf(states, c.entity)
    );
  };
  for (const c of ctrls)
    if (c.entity !== main)
      rows.push({
        kind: "chain",
        entity: c.entity,
        label: labelOf(c),
        value: !bad(states[c.entity]) && states[c.entity].state === "on",
      });
  let reason: string | null = null;
  const off = ctrls.find(
    (c) => !bad(states[c.entity]) && states[c.entity].state !== "on",
  );
  if (off) reason = `${labelOf(off)} is off`;
  else if (ownBad)
    reason = `${nameOf(states, own!)} is unavailable`; // ownBad implies own
  else if (!chain.lit && chain.reason) {
    reason = chain.reason;
    for (const e of entities)
      if (reason.startsWith(e + " "))
        reason = nameOf(states, e) + reason.slice(e.length);
  }
  if (reason) rows.push({ kind: "reason", label: reason });
  rows.push(...popupLinks(ui, own || ctrl));
  return rows;
}

// Row layout key: a change rebuilds the rows; the label is part of it for link and info rows, so a
// label never stays next to another row's value (the per-row update only writes values).
export function rowsKey(rows: readonly PopupRow[]): string {
  return rows
    .map(
      (r) =>
        `${r.kind}:${r.entity || ""}${r.kind === "color_temp" ? `:${r.min}-${r.max}` : r.kind === "effect" ? `:${r.options.join("/")}` : ""}${r.kind === "link" || r.kind === "info" ? `:${r.label}` : ""}`,
    )
    .join("|");
}

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};
const esc = (s: unknown): string => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
const STOP = [
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointercancel",
  "click",
  "dblclick",
  "contextmenu",
  "mousedown",
  "mouseup",
  "touchstart",
  "touchend",
  "touchmove",
  "wheel",
  "keydown",
];

/**
 * The DOM popup. root: the stage (position: relative). opts:
 *   onAction(domain, service, data), onLink(action) (a link row: an HA action { action, ... }),
 *   project(world: Vector3) -> [clientX, clientY] | null,
 *   resolve(id) -> { obj, chain, states, groups, popup? } | null (current data for the open object).
 */
export class ObjectPopup {
  root: HTMLElement;
  onLink: NonNullable<PopupOptions["onLink"]>;
  anchorOf: PopupOptions["anchor"];
  onAction: NonNullable<PopupOptions["onAction"]>;
  project: NonNullable<PopupOptions["project"]>;
  resolve: NonNullable<PopupOptions["resolve"]>;
  el: HTMLDivElement | null;
  _id: string | null;
  _anchor: THREE.Vector3 | null;
  _key: string | null;
  _sliding: boolean;
  _drag: { canvas: HTMLCanvasElement; hs: [number, number] } | null;
  closedBy: Event | null;
  _onOutside: (e: PointerEvent) => void;
  _onRelease: () => void;
  _onKey: (e: KeyboardEvent) => void;
  _links?: ActionConfig[];
  _badge?: BadgeInfo | null;
  _dark?: boolean;
  _effTimer?: ReturnType<typeof setTimeout>;

  constructor(
    root: HTMLElement,
    { onAction, onLink, project, resolve, anchor }: PopupOptions = {},
  ) {
    this.root = root;
    this.onLink = onLink || (() => {});
    this.anchorOf = anchor || null; // (id) -> world Vector3, re-read on every reposition
    this.onAction = onAction || (() => {});
    this.project = project || (() => null);
    this.resolve = resolve || (() => null);
    this.el = null;
    this._id = null;
    this._anchor = null;
    this._key = null;
    this._sliding = false;
    this._drag = null; // colour wheel gesture { canvas, hs }
    this.closedBy = null; // the outside pointerdown that closed the popup (that gesture must not act)
    this._onOutside = (e) => {
      if (!this.el || e.composedPath().includes(this.el)) return;
      this.closedBy = e;
      this.close();
    };
    this._onRelease = () => {
      setTimeout(() => {
        this._sliding = false;
      }, 0);
    }; // after the change event
    this._onKey = (e) => {
      if (e.key === "Escape") this.close();
    };
  }

  get isOpen() {
    return !!this.el;
  }
  get objectId() {
    return this._id;
  }

  open(
    obj: { id: string; label?: string },
    anchorWorld: THREE.Vector3 | null | undefined,
  ): void {
    this.close();
    this._id = obj.id;
    this._anchor =
      anchorWorld && anchorWorld.clone
        ? anchorWorld.clone()
        : (anchorWorld ?? null);
    const el = document.createElement("div");
    el.className = "fp-popup";
    el.innerHTML = `<div class="fp-pop-head"><span class="fp-pop-badges"></span><span class="fp-pop-title"></span><button class="fp-pop-x" title="Close">×</button></div><div class="fp-pop-rows"></div>`;
    el.querySelector(".fp-pop-title")!.textContent = obj.label || obj.id; // in the markup above
    for (const t of STOP) el.addEventListener(t, (e) => e.stopPropagation()); // no HA long-press / orbit / marker
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    }); // window never sees it (stopped)
    el.addEventListener("click", (e) => this._click(e));
    el.addEventListener("change", (e) => this._change(e));
    el.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLInputElement).type === "range") this._sliding = true;
      else this._wheelDown(e);
    });
    el.addEventListener("pointermove", (e) => this._wheelMove(e));
    el.addEventListener("pointerup", (e) => this._wheelUp(e));
    el.addEventListener("pointercancel", () => this._wheelEnd());
    el.addEventListener("input", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.type === "range" && t.dataset.kelvin) this._kelvinText(t);
    });
    el.querySelector(".fp-pop-x")!.addEventListener("click", () =>
      this.close(),
    );
    this.el = el;
    this.root.append(el);
    window.addEventListener("pointerdown", this._onOutside, true);
    window.addEventListener("pointerup", this._onRelease, true); // a slider released outside the popup
    window.addEventListener("pointercancel", this._onRelease, true);
    window.addEventListener("keydown", this._onKey);
    this.update();
    this.position();
  }

  _rows(): PopupRow[] | null {
    const r = this._id ? this.resolve(this._id) : null;
    if (!r) return null;
    this._links = [];
    this._badge = r.badge || null;
    this._dark = !!r.dark;
    const rows = popupRows(
      r.obj,
      r.chain,
      r.states || {},
      r.groups || {},
      r.popup || null,
      r.popupSource || null,
    );
    // read-only rows from the card (e.g. the mower's Stripes / Mowed), above the links
    if (Array.isArray(r.extra) && r.extra.length) {
      const at = rows.findIndex((x) => x.kind === "link");
      rows.splice(
        at < 0 ? rows.length : at,
        0,
        ...r.extra.map((x) => ({
          kind: "info" as const,
          label: x.label,
          value: x.value,
        })),
      );
    }
    for (const row of rows)
      if (row.kind === "link") this._links.push(row.action);
    return rows;
  }

  // Re-read the object's rows; same row layout: values only (a slider being dragged keeps its value).
  update(): void {
    if (!this.el) return;
    const rows = this._rows();
    if (!rows) {
      this.close();
      return;
    }
    // the popup's own markup (open)
    applyBadges(
      this.el.querySelector<HTMLElement>(".fp-pop-badges")!,
      this._badge || null,
      !!this._dark,
    );
    const key = rowsKey(rows);
    const box = this.el.querySelector<HTMLElement>(".fp-pop-rows")!;
    if (key !== this._key) {
      this._key = key;
      box.innerHTML = rows.map((r) => this._rowHtml(r)).join("");
      for (const c of box.querySelectorAll<HTMLCanvasElement>(
        "canvas.fp-wheel",
      ))
        drawWheel(c);
    }
    rows.forEach((r, i) => {
      const row = box.children[i] as HTMLElement | undefined;
      // the elements below come from _rowHtml for the same row kinds (same key)
      if (!row) return;
      row.dataset.entity = r.entity || "";
      if (r.kind === "toggle" || r.kind === "chain") {
        const b = row.querySelector(".fp-switch")!;
        b.classList.toggle("on", !!r.value);
        b.setAttribute("aria-checked", String(!!r.value));
        if (r.kind === "chain")
          row.querySelector(".fp-pop-label")!.textContent = r.label;
      } else if (r.kind === "brightness") {
        const input = row.querySelector("input")!;
        if (!this._sliding) input.value = String(Math.max(1, r.value));
        row.classList.toggle("off", !r.value);
      } else if (r.kind === "color") {
        const dot = row.querySelector<HTMLElement>(".fp-wheel-dot");
        if (!this._drag) this._moveDot(dot, r.hs);
      } else if (r.kind === "color_temp") {
        const input = row.querySelector("input")!;
        if (!this._sliding)
          input.value = String(
            r.value === null ? Math.round((r.min + r.max) / 2) : r.value,
          );
        if (!this._sliding)
          row.querySelector(".fp-pop-value")!.textContent =
            r.value === null ? "" : `${r.value} K`;
      } else if (r.kind === "effect") {
        const sel = row.querySelector("select")!;
        if ((sel.getRootNode() as Document | ShadowRoot).activeElement !== sel)
          sel.value = r.value && r.options.includes(r.value) ? r.value : "";
      } else if (r.kind === "reason") {
        row.textContent = r.label;
      } else if (r.kind !== "start_dock" && r.kind !== "link") {
        row.querySelector(".fp-pop-value")!.textContent = r.value as string; // the DOM stringifies values
      }
    });
  }

  _rowHtml(r: PopupRow): string {
    const label = `<span class="fp-pop-label">${esc(r.label)}</span>`;
    switch (r.kind) {
      case "toggle":
      case "chain":
        return `<div class="fp-pop-row ${r.kind}">${label}<button class="fp-switch" role="switch" data-act="toggle"><span></span></button></div>`;
      case "brightness":
        return (
          `<div class="fp-pop-row brightness">${label}<input type="range" min="1" max="255" step="1">` +
          `<span class="fp-presets">${PRESETS.map((p) => `<button data-act="pct" data-pct="${p}">${p}%</button>`).join("")}</span></div>`
        );
      case "color":
        return (
          `<div class="fp-pop-row color"><span class="fp-wheel-box"><canvas class="fp-wheel" style="width:${WHEEL}px;height:${WHEEL}px" title="Colour"></canvas><span class="fp-wheel-dot" hidden></span></span>` +
          '<button class="fp-swatch white" data-act="white" title="Warm white"></button></div>'
        );
      case "color_temp":
        return `<div class="fp-pop-row color_temp">${label}<span class="fp-pop-value"></span><input class="fp-kelvin" type="range" data-kelvin="1" min="${r.min}" max="${r.max}" step="50"></div>`;
      case "effect":
        return `<div class="fp-pop-row effect">${label}<select><option value="" disabled>Choose…</option>${r.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}</select></div>`;
      case "start_dock":
        return `<div class="fp-pop-row start_dock">${label}<span class="fp-pop-btns"><button data-act="start">Start</button><button data-act="dock">Dock</button></span></div>`;
      case "reason":
        return `<div class="fp-pop-row reason">${esc(r.label)}</div>`;
      case "link":
        return `<div class="fp-pop-row link"><button class="fp-pop-link" data-act="link">${esc(r.label)}</button></div>`;
      default:
        return `<div class="fp-pop-row value">${label}<span class="fp-pop-value"></span></div>`;
    }
  }

  _click(e: MouseEvent): void {
    const t = e.target as Element;
    const b = t.closest ? t.closest<HTMLElement>("[data-act]") : null;
    const row = b && b.closest<HTMLElement>(".fp-pop-row");
    if (b && b.dataset.act === "link") {
      const links = [...this.el!.querySelectorAll(".fp-pop-row.link")]; // events come from this.el
      const a = (this._links || [])[links.indexOf(row!)];
      if (a) this.onLink(a);
      return;
    }
    const entity = row && row.dataset.entity;
    if (!b || !entity) return;
    const act = b.dataset.act;
    if (act === "toggle") this.onAction(...toggleCall(entity));
    else if (act === "pct")
      this.onAction("light", "turn_on", {
        entity_id: entity,
        brightness_pct: Number(b.dataset.pct),
      });
    else if (act === "white")
      this.onAction("light", "turn_on", {
        entity_id: entity,
        color_temp_kelvin: 2700,
      });
    else if (
      (act === "start" || act === "dock") &&
      START_DOCK[domainOf(entity)]
    )
      this.onAction(domainOf(entity), START_DOCK[domainOf(entity)]![act], {
        entity_id: entity,
      });
  }

  // brightness: one call when the slider is released ('change'), not per 'input' step
  _change(e: Event): void {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    const row = target.closest
      ? target.closest<HTMLElement>(".fp-pop-row")
      : null;
    const entity = row && row.dataset.entity;
    if (target.tagName === "SELECT") {
      // arrow keys fire a change per step: the last value wins after a short pause
      clearTimeout(this._effTimer);
      const val = target.value;
      if (entity && val)
        this._effTimer = setTimeout(
          () =>
            this.onAction("light", "turn_on", {
              entity_id: entity,
              effect: val,
            }),
          400,
        );
      return;
    }
    if (target.type !== "range") return;
    this._sliding = false;
    if (!entity) return;
    if (target.dataset.kelvin)
      this.onAction("light", "turn_on", {
        entity_id: entity,
        color_temp_kelvin: Math.round(Number(target.value)),
      });
    else
      this.onAction("light", "turn_on", {
        entity_id: entity,
        brightness: Math.round(Number(target.value)),
      });
  }

  _kelvinText(input: HTMLInputElement): void {
    const v =
      input.parentElement && input.parentElement.querySelector(".fp-pop-value");
    if (v) v.textContent = `${Math.round(Number(input.value))} K`;
  }

  // Colour wheel: the marker follows the pointer; the single light.turn_on goes out on release.
  _hsAt(canvas: HTMLCanvasElement, e: PointerEvent): [number, number] {
    const b = canvas.getBoundingClientRect(),
      r = b.width / 2;
    return wheelHs(e.clientX - b.left - r, e.clientY - b.top - r, r);
  }

  _moveDot(dot: HTMLElement | null, hs: readonly number[] | null): void {
    if (!dot) return;
    dot.hidden = !hs;
    if (!hs) return;
    const [x, y] = wheelPoint(hs[0], hs[1], WHEEL / 2);
    dot.style.left = `${WHEEL / 2 + x}px`;
    dot.style.top = `${WHEEL / 2 + y}px`;
    dot.style.background = `rgb(${hsToRgb(hs[0], hs[1] / 100).join(",")})`;
  }

  _wheelDown(e: PointerEvent): void {
    const t = e.target as HTMLElement | null;
    const c =
      t && t.classList && t.classList.contains("fp-wheel")
        ? (t as HTMLCanvasElement)
        : null;
    if (!c) return;
    try {
      c.setPointerCapture(e.pointerId);
    } catch (_) {
      /* synthetic events have no active pointer */
    }
    this._drag = { canvas: c, hs: this._hsAt(c, e) };
    this._moveDot(
      c.parentElement!.querySelector<HTMLElement>(".fp-wheel-dot"),
      this._drag.hs,
    ); // the wheel sits in its box
  }

  _wheelMove(e: PointerEvent): void {
    const d = this._drag;
    if (!d) return;
    d.hs = this._hsAt(d.canvas, e);
    this._moveDot(
      d.canvas.parentElement!.querySelector<HTMLElement>(".fp-wheel-dot"),
      d.hs,
    );
  }

  _wheelUp(e: PointerEvent): void {
    const d = this._drag;
    if (!d) return;
    if (!d.canvas.isConnected) {
      this._wheelEnd();
      return;
    } // the rows were rebuilt mid-drag
    d.hs = this._hsAt(d.canvas, e);
    const row = d.canvas.closest<HTMLElement>(".fp-pop-row"),
      entity = row && row.dataset.entity;
    this._wheelEnd();
    if (entity)
      this.onAction("light", "turn_on", { entity_id: entity, hs_color: d.hs });
  }

  _wheelEnd(): void {
    this._drag = null;
  }

  // Next to the object's anchor (called after every render), kept inside the stage; hidden while
  // the anchor is off-screen or behind the camera.
  position(): void {
    if (!this.el) return;
    const world =
      (this.anchorOf && this._id !== null && this.anchorOf(this._id)) ||
      this._anchor;
    const p = world ? this.project(world) : null;
    const r = this.root.getBoundingClientRect();
    const ax = p ? p[0] - r.left : 0,
      ay = p ? p[1] - r.top : 0;
    if (!p || ax < 0 || ay < 0 || ax > r.width || ay > r.height) {
      this.el.style.visibility = "hidden";
      return;
    }
    this.el.style.maxHeight = `${Math.max(60, r.height - 16)}px`;
    const w = this.el.offsetWidth,
      h = this.el.offsetHeight,
      gap = 18,
      pad = 8;
    let x = ax + gap;
    if (x + w > r.width - pad) x = ax - gap - w; // no room on the right: left of the object
    x = Math.max(pad, Math.min(x, r.width - w - pad));
    const y = Math.max(pad, Math.min(ay - h / 2, r.height - h - pad));
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.el.style.visibility = "";
  }

  close(): void {
    if (!this.el) return;
    window.removeEventListener("pointerdown", this._onOutside, true);
    window.removeEventListener("pointerup", this._onRelease, true);
    window.removeEventListener("pointercancel", this._onRelease, true);
    window.removeEventListener("keydown", this._onKey);
    clearTimeout(this._effTimer);
    this.el.remove();
    this.el = null;
    this._id = null;
    this._anchor = null;
    this._key = null;
    this._sliding = false;
    this._drag = null;
  }
}

// Hue around, saturation from the centre (value full); the canvas is drawn at device resolution.
function drawWheel(canvas: HTMLCanvasElement): void {
  const dpr = Math.max(
    1,
    Math.min(
      3,
      (typeof window !== "undefined" && window.devicePixelRatio) || 1,
    ),
  );
  const n = Math.round(WHEEL * dpr),
    r = n / 2;
  canvas.width = n;
  canvas.height = n;
  const g = canvas.getContext("2d");
  if (!g) return;
  const img = g.createImageData(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x + 0.5 - r,
        dy = y + 0.5 - r,
        d = Math.hypot(dx, dy);
      if (d > r) continue;
      const [h, s] = wheelHs(dx, dy, r),
        i = (y * n + x) * 4;
      const [R, G, B] = hsToRgb(h, s / 100);
      img.data[i] = R;
      img.data[i + 1] = G;
      img.data[i + 2] = B;
      img.data[i + 3] = Math.round(255 * Math.min(1, r - d + 0.5)); // soft edge
    }
  }
  g.putImageData(img, 0, 0);
}
