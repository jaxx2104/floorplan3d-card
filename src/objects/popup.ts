// Object popup: a small panel next to a model object with Home Assistant tile cards for its entity
// and the group chain (HA's tile features: brightness, colour temperature, cover / fan / climate /
// lock / media / mower controls; colour, effects and the rest through the tile's more-info), plus
// read-only values, why the object is dark and link rows. popupRows() is the pure part (unit-tested).
import type * as THREE from "three";
import { typeOf } from "./types.ts";
import { controllersOf } from "./logic.ts";
import { popupLinks } from "../actions.ts";
import { applyBadges } from "../badge-dom.ts";
import { createCard } from "../ha-helpers.ts";
import type { ChainState, Controller, ObjectBinding } from "./logic.ts";
import type { ModelObject } from "./types.ts";
import type { PopupLink, PopupSource } from "../actions.ts";
import type { BadgeInfo } from "../badges.ts";
import type { HaCardElement } from "../ha-helpers.ts";
import type { HassEntity } from "../types/ha.ts";
import type { ActionConfig, LayoutTag } from "../types/layout.ts";

type States = Record<string, HassEntity>;
type Groups = Record<string, LayoutTag | null | undefined>;
type ValueKind = "battery" | "power" | "energy" | "temperature" | "mode";
/** A tile card feature config ({ type: "light-brightness" }, ...). */
export interface TileFeature {
  type: string;
  [key: string]: unknown;
}
/** One popup row; entity: what its tile acts on. tile: the object's entity, chain: a tag controller. */
export type PopupRow =
  | {
      kind: "tile" | "chain";
      entity: string;
      label: string;
      value: boolean;
      features: TileFeature[];
    }
  | { kind: ValueKind; entity?: string; label: string; value: unknown }
  | { kind: "state"; entity?: undefined; label: string; value: unknown }
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
  /** forwarded to the tile cards */
  hass?: unknown;
}
export interface PopupOptions {
  onLink?: (action: ActionConfig) => void;
  project?: (world: THREE.Vector3) => readonly number[] | null;
  resolve?: (id: string) => PopupData | null;
  anchor?: ((id: string) => THREE.Vector3 | null | undefined) | null;
}

// Popup list items shown by the entity's tile (the tile shows the state and opens more-info for colour
// and effects; brightness / colour temperature / start-dock are its features)
const TILE_KINDS = new Set([
  "toggle",
  "state",
  "brightness",
  "color",
  "color_temp",
  "effect",
  "start_dock",
]);
const VALUE_KINDS = new Set([
  "battery",
  "power",
  "energy",
  "temperature",
  "mode",
]);
const LABELS: Record<string, string> = {
  battery: "Battery",
  power: "Power",
  energy: "Energy",
  temperature: "Temperature",
  mode: "Mode",
};
// the fallback switch without HA's cards (unit tests): domains homeassistant.toggle handles
const TOGGLES = new Set([
  "light",
  "switch",
  "fan",
  "input_boolean",
  "siren",
  "humidifier",
  "group",
  "automation",
  "cover",
]);

const domainOf = (e: string): string => String(e).split(".")[0];
const bad = (s: HassEntity | null | undefined): boolean =>
  !s || s.state === "unavailable" || s.state === "unknown";
const nameOf = (states: States, e: string): string =>
  (states[e] && states[e].attributes && states[e].attributes.friendly_name) ||
  e;
const withUnit = (v: unknown, u: unknown): string =>
  u ? `${v} ${u}` : String(v);
const flags = (s: HassEntity): number => {
  const f = s.attributes && s.attributes.supported_features;
  return typeof f === "number" ? f : 0;
};

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

/**
 * Tile features for an entity. want: the popup list items (brightness, color_temp, start_dock) taken
 * exactly; null: automatic, every feature the entity supports (lights: brightness unless on / off only,
 * colour temperature; covers: open / close and position; fans: speed; climate: HVAC modes and target
 * temperature; locks; media players: volume; mowers / vacuums: start-pause and dock).
 */
export function tileFeatures(
  entity: string,
  s: HassEntity | null | undefined,
  want: ReadonlySet<string> | null = null,
): TileFeature[] {
  if (!s) return [];
  const a = s.attributes || {},
    sf = flags(s),
    d = domainOf(entity);
  const on = (k: string): boolean => !want || want.has(k);
  const out: TileFeature[] = [];
  if (d === "light") {
    const modes: unknown[] | null = Array.isArray(a.supported_color_modes)
      ? a.supported_color_modes
      : null;
    if (on("brightness") && !(modes && modes.every((m) => m === "onoff")))
      out.push({ type: "light-brightness" });
    if (on("color_temp") && modes && modes.includes("color_temp"))
      out.push({ type: "light-color-temp" });
  } else if (d === "lawn_mower" || d === "vacuum") {
    if (on("start_dock"))
      out.push(
        d === "vacuum"
          ? {
              type: "vacuum-commands",
              commands: ["start_pause", "return_home"],
            }
          : { type: "lawn-mower-commands", commands: ["start_pause", "dock"] },
      );
  } else if (!want) {
    if (d === "cover") {
      out.push({ type: "cover-open-close" });
      if (sf & 4) out.push({ type: "cover-position" }); // SET_POSITION
    } else if (d === "fan" && sf & 1) out.push({ type: "fan-speed" });
    else if (d === "climate") {
      if (Array.isArray(a.hvac_modes) && a.hvac_modes.length)
        out.push({ type: "climate-hvac-modes", hvac_modes: a.hvac_modes });
      if (sf & 1) out.push({ type: "target-temperature" }); // TARGET_TEMPERATURE
    } else if (d === "lock") out.push({ type: "lock-commands" });
    else if (d === "media_player" && sf & 4)
      out.push({ type: "media-player-volume-slider" }); // VOLUME_SET
  }
  return out;
}

function readValue(kind: string, e: string, s: HassEntity): unknown {
  const a: HassEntity["attributes"] = s.attributes || {};
  const unit = a.unit_of_measurement;
  switch (kind) {
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
 * type default) becomes a tile for the object's entity (toggle, state, brightness, color, color_temp,
 * effect, start / dock) and value rows (battery, power, energy, temperature, mode), then a tile per
 * group chain controller, why the object is dark, and link rows (history / logbook / statistics / custom).
 * groups (tag settings) tell the controllers apart from the object's own entity.
 * Unavailable / unbound: a single state row "unavailable" (and the links).
 * source (resolveActions().popupSource): 'type' or 'model' make the list automatic: the entity's tile always,
 * with every feature it supports; 'layout' / 'yaml' (or none) lists are respected exactly (a tile only when
 * a tile item is listed, features only for listed brightness / color_temp / start / dock).
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
  // an unavailable own entity: only the (usable) controller rows and the reason
  const main = ownBad ? null : own || ctrl;
  const auto = source === "type" || source === "model";
  const want: string[] = [];
  for (const k of ui) {
    const kind = k === "start" || k === "dock" ? "start_dock" : k;
    if (typeof kind === "string" && !want.includes(kind)) want.push(kind);
  }
  const rows: PopupRow[] = [];
  if (main && (auto || want.some((k) => TILE_KINDS.has(k))))
    rows.push({
      kind: "tile",
      entity: main,
      label: nameOf(states, main),
      value: states[main].state === "on",
      features: tileFeatures(main, states[main], auto ? null : new Set(want)),
    });
  for (const kind of main ? want : []) {
    if (!main || !VALUE_KINDS.has(kind)) continue;
    const value = readValue(kind, main, states[main]);
    if (value !== null && value !== undefined)
      rows.push({
        kind: kind as ValueKind,
        entity: main,
        label: LABELS[kind],
        value,
      });
  }
  // a tile per controller: the tag's label (layout.tags[name].label) when set, else the entity's name
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
        features: [],
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

/** The tile card config of a tile / chain row (a controller tile carries its tag label as the name). */
export function tileConfig(
  r: Extract<PopupRow, { kind: "tile" | "chain" }>,
): Record<string, unknown> {
  return {
    type: "tile",
    entity: r.entity,
    ...(r.kind === "chain" ? { name: r.label } : {}),
    features: r.features,
    features_position: "bottom",
    vertical: false,
  };
}

// Row layout key: a change rebuilds the rows (and their tile cards); the label is part of it for link,
// info and chain rows (the controller tile's name), so a label never stays next to another row's value.
export function rowsKey(rows: readonly PopupRow[]): string {
  return rows
    .map(
      (r) =>
        `${r.kind}:${r.entity || ""}${r.kind === "tile" || r.kind === "chain" ? `:${JSON.stringify(r.features)}` : ""}${r.kind === "link" || r.kind === "info" || r.kind === "chain" ? `:${r.label}` : ""}`,
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
 *   onLink(action) (an HA action { action, ... }: link rows, the fallback switch and name),
 *   project(world: Vector3) -> [clientX, clientY] | null,
 *   resolve(id) -> { obj, chain, states, groups, popup?, hass? } | null (current data for the open object).
 * Tile rows show HA's tile card (window.loadCardHelpers); until it is there, or without HA, a name
 * (more-info) and an on / off switch or the state.
 */
export class ObjectPopup {
  root: HTMLElement;
  onLink: NonNullable<PopupOptions["onLink"]>;
  anchorOf: PopupOptions["anchor"];
  project: NonNullable<PopupOptions["project"]>;
  resolve: NonNullable<PopupOptions["resolve"]>;
  el: HTMLDivElement | null;
  _id: string | null;
  _anchor: THREE.Vector3 | null;
  _key: string | null;
  /** the HA tile card per row index (null: not loaded / fallback) */
  _cards: (HaCardElement | null)[];
  _hass: unknown;
  closedBy: Event | null;
  _onOutside: (e: PointerEvent) => void;
  _onKey: (e: KeyboardEvent) => void;
  _links?: ActionConfig[];
  _badge?: BadgeInfo | null;
  _dark?: boolean;

  constructor(
    root: HTMLElement,
    { onLink, project, resolve, anchor }: PopupOptions = {},
  ) {
    this.root = root;
    this.onLink = onLink || (() => {});
    this.anchorOf = anchor || null; // (id) -> world Vector3, re-read on every reposition
    this.project = project || (() => null);
    this.resolve = resolve || (() => null);
    this.el = null;
    this._id = null;
    this._anchor = null;
    this._key = null;
    this._cards = [];
    this._hass = null;
    this.closedBy = null; // the outside pointerdown that closed the popup (that gesture must not act)
    this._onOutside = (e) => {
      if (!this.el || e.composedPath().includes(this.el)) return;
      this.closedBy = e;
      this.close();
    };
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
    // no HA long-press / orbit / marker; the tile cards handle their own gestures inside
    for (const t of STOP) el.addEventListener(t, (e) => e.stopPropagation());
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    }); // window never sees it (stopped)
    el.addEventListener("click", (e) => this._click(e));
    el.querySelector(".fp-pop-x")!.addEventListener("click", () =>
      this.close(),
    );
    this.el = el;
    this.root.append(el);
    window.addEventListener("pointerdown", this._onOutside, true);
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
    this._hass = r.hass ?? null;
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

  // Re-read the object's rows; same row layout: values only, and hass to the tile cards.
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
      this._cards = rows.map(() => null);
      box.innerHTML = rows.map((r) => this._rowHtml(r)).join("");
      this._mountTiles(key, rows, box);
    }
    rows.forEach((r, i) => {
      const row = box.children[i] as HTMLElement | undefined;
      // the elements below come from _rowHtml for the same row kinds (same key)
      if (!row) return;
      row.dataset.entity = r.entity || "";
      if (r.kind === "tile" || r.kind === "chain") {
        const card = this._cards[i];
        if (card) {
          card.hass = this._hass;
          return;
        }
        const b = row.querySelector(".fp-switch");
        if (b) {
          b.classList.toggle("on", !!r.value);
          b.setAttribute("aria-checked", String(!!r.value));
        }
        const v = row.querySelector(".fp-pop-value");
        const s = this._stateOf(r.entity);
        if (v) v.textContent = s;
        row.querySelector(".fp-pop-label")!.textContent = r.label;
      } else if (r.kind === "reason") {
        row.textContent = r.label;
      } else if (r.kind !== "link") {
        row.querySelector(".fp-pop-value")!.textContent = r.value as string; // the DOM stringifies values
      }
    });
  }

  _stateOf(entity: string): string {
    const h = this._hass as { states?: States } | null;
    const s = h && h.states ? h.states[entity] : null;
    return s
      ? withUnit(s.state, s.attributes && s.attributes.unit_of_measurement)
      : "";
  }

  // HA's tile card per tile / chain row, in place of the fallback once it is created (same rows only).
  _mountTiles(key: string, rows: readonly PopupRow[], box: HTMLElement): void {
    rows.forEach((r, i) => {
      if (r.kind !== "tile" && r.kind !== "chain") return;
      const row = box.children[i] as HTMLElement | undefined;
      if (!row) return;
      void createCard(tileConfig(r)).then((card) => {
        if (!card || !this.el || this._key !== key || !row.isConnected) return;
        card.hass = this._hass;
        row.replaceChildren(card);
        row.classList.add("ha");
        this._cards[i] = card;
        this.position();
      });
    });
  }

  _rowHtml(r: PopupRow): string {
    const label = `<span class="fp-pop-label">${esc(r.label)}</span>`;
    switch (r.kind) {
      case "tile":
      case "chain": {
        // the fallback: the name opens more-info, a switch (toggle domains) or the state
        const name = `<button class="fp-pop-name fp-pop-label" data-act="more-info">${esc(r.label)}</button>`;
        const end = TOGGLES.has(domainOf(r.entity))
          ? '<button class="fp-switch" role="switch" data-act="toggle"><span></span></button>'
          : '<span class="fp-pop-value"></span>';
        return `<div class="fp-pop-row ${r.kind}">${name}${end}</div>`;
      }
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
    if (b.dataset.act === "toggle") this.onLink({ action: "toggle", entity });
    else if (b.dataset.act === "more-info")
      this.onLink({ action: "more-info", entity });
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
    window.removeEventListener("keydown", this._onKey);
    this.el.remove();
    this.el = null;
    this._id = null;
    this._anchor = null;
    this._key = null;
    this._cards = [];
  }
}
