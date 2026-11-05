// HA-style actions (tap_action / hold_action / double_tap_action) for model objects and markers.
// Pure: resolution (type defaults < model fp.ui < layout ui < card YAML `actions:`), field checks,
// popup link rows and the double-tap sequencer. HA's frontend runs the actions (card/action-runner.ts).

import type { ActionConfig, ObjectUi } from "./types/layout.ts";

export type ActionKind =
  | "toggle"
  | "more-info"
  | "navigate"
  | "url"
  | "perform-action"
  | "assist"
  | "popup"
  | "none";
export type ActionWhich = "tap" | "hold" | "double_tap";
export type PopupSource = "type" | "model" | "layout" | "yaml";

export const KINDS: readonly ActionKind[] = [
  "toggle",
  "more-info",
  "navigate",
  "url",
  "perform-action",
  "assist",
  "popup",
  "none",
];
const KIND_SET = new Set<unknown>(KINDS);
export const WHICH: readonly ActionWhich[] = ["tap", "hold", "double_tap"];
export const DOUBLE_TAP_MS = 250;

const plain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** One action in HA's shape { action, ... }; a bare string is the action name; legacy call-service accepted. Invalid: null. */
export function normAction(v: unknown): ActionConfig | null {
  if (typeof v === "string") return KIND_SET.has(v) ? { action: v } : null;
  if (!plain(v)) return null;
  if (
    v.action === "call-service" ||
    (v.action === "perform-action" &&
      (v.service !== undefined || v.service_data !== undefined))
  ) {
    const { service, service_data: sd, ...rest } = v;
    const out: ActionConfig = { ...rest, action: "perform-action" };
    if (service !== undefined && out.perform_action === undefined)
      out.perform_action = service;
    if (sd !== undefined && out.data === undefined) out.data = sd;
    return out;
  }
  return KIND_SET.has(v.action) ? { ...v, action: v.action as string } : null; // KIND_SET holds strings only
}

// The actions one ui-like source sets: `<which>_action`, else the legacy `<which>` key.
interface SourceActions {
  tap?: ActionConfig;
  hold?: ActionConfig;
  double_tap?: ActionConfig;
  popup?: unknown[];
}

function fromSource(ui: unknown): SourceActions {
  const out: SourceActions = {};
  if (!plain(ui)) return out;
  for (const w of WHICH) {
    const a = normAction(
      ui[`${w}_action`] !== undefined ? ui[`${w}_action`] : ui[w],
    );
    if (a) out[w] = a;
  }
  if (Array.isArray(ui.popup)) out.popup = ui.popup;
  return out;
}

/**
 * { tap, hold, double_tap, popup, popupSource }: each action normalised ({ action, ... }); double_tap null when there
 * is none (or it is `none`): taps on that target are then never delayed. Later sources win:
 * type defaults < model fp.ui < layout.objects[id].ui < YAML `actions:` (device:<id> < tag:<name> < <entity_id> < object:<id>).
 * popupSource: where the popup list came from ('type' | 'model' | 'layout' | 'yaml'); type / model lists are
 * extended by the bound light's capabilities (popupRows), layout / YAML lists are taken as written.
 * tags: the object's tags in order (a later tag wins over an earlier one).
 */
export interface ResolveActionsInput {
  modelUi?: ObjectUi | Record<string, unknown> | null;
  layoutUi?: ObjectUi | null;
  yaml?: unknown;
  kind?: "object" | "marker" | string;
  id?: string;
  entityId?: string | null;
  deviceId?: string | null;
  typeDefaults?: ObjectUi | null;
  tags?: readonly string[] | null;
}

export interface ResolvedActions {
  tap: ActionConfig;
  hold: ActionConfig;
  double_tap: ActionConfig | null;
  popup: unknown[];
  popupSource: PopupSource;
}

export function resolveActions({
  modelUi,
  layoutUi,
  yaml,
  kind = "object",
  id,
  entityId,
  deviceId,
  typeDefaults,
  tags,
}: ResolveActionsInput = {}): ResolvedActions {
  const y = plain(yaml) ? yaml : {};
  const tagKeys =
    kind === "object" && Array.isArray(tags) ? tags.map((t) => `tag:${t}`) : [];
  const keys = [
    deviceId && `device:${deviceId}`,
    ...tagKeys,
    entityId,
    kind === "object" && id && `object:${id}`,
  ].filter((k): k is string => !!k);
  const names: PopupSource[] = [
    "type",
    "model",
    "layout",
    ...keys.map((): PopupSource => "yaml"),
  ];
  const sources = [
    typeDefaults,
    modelUi,
    layoutUi,
    ...keys.map((k) => y[k]),
  ].map(fromSource);
  const out: ResolvedActions = {
    tap: { action: "none" },
    hold: { action: "none" },
    double_tap: null,
    popup: ["state"],
    popupSource: "type",
  };
  sources.forEach((s, i) => {
    Object.assign(out, s);
    if (s.popup) out.popupSource = names[i];
  });
  if (out.double_tap && out.double_tap.action === "none") out.double_tap = null;
  return out;
}

// url_path: http(s) or a path on the HA host; never javascript: / data: and the like
const safeUrl = (u: string): boolean =>
  /^https?:\/\//i.test(u) || (u.startsWith("/") && !u.startsWith("//"));

/** A message for an action missing a required field, else null (entity-based actions are checked at run time). */
export function validateAction(
  a: ActionConfig | null | undefined,
): string | null {
  if (!a) return null;
  switch (a.action) {
    case "navigate":
      return a.navigation_path ? null : "navigate needs navigation_path";
    case "url":
      if (!a.url_path) return "url needs url_path";
      return safeUrl(String(a.url_path))
        ? null
        : "url_path must start with http://, https:// or /";
    case "perform-action": {
      const s = a.perform_action;
      if (!s) return "perform-action needs perform_action (domain.action)";
      if (typeof s !== "string" || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(s))
        return `perform_action "${s}" is not domain.action`;
      return null;
    }
    default:
      return null;
  }
}

/** The detail of HA's `hass-action` event for one action. */
export interface HassActionDetail {
  config: { entity?: string; tap_action: ActionConfig };
  action: "tap";
}

/**
 * HA's frontend (handleAction) runs the action, confirmation dialog and haptics included. It toggles
 * config.entity and opens more-info for the action's entity, else config.entity: the action's own
 * entity wins over the target here, so both act on it. Always sent as a tap (the card detects the gesture).
 */
export function hassActionDetail(
  a: ActionConfig,
  entity?: string | null,
): HassActionDetail {
  const e = (typeof a.entity === "string" && a.entity) || entity || null;
  return {
    config: { ...(e ? { entity: e } : {}), tap_action: a },
    action: "tap",
  };
}

export interface PopupLink {
  kind: "link";
  label: string;
  action: ActionConfig;
}

const ENTITY_LINKS: Record<string, (e: string) => Omit<PopupLink, "kind">> = {
  history: (e) => ({
    label: "History",
    action: {
      action: "navigate",
      navigation_path: `/history?entity_id=${encodeURIComponent(e)}`,
    },
  }),
  logbook: (e) => ({
    label: "Logbook",
    action: {
      action: "navigate",
      navigation_path: `/logbook?entity_id=${encodeURIComponent(e)}`,
    },
  }),
  // HA's more-info dialog shows the history / statistics graph
  statistics: (e) => ({
    label: "Statistics",
    action: { action: "more-info", entity: e },
  }),
};

/** Link rows of a popup list: history / logbook / statistics (need entity) and custom { label, navigate | url }. */
export function popupLinks(
  list: unknown,
  entity: string | null | undefined,
): PopupLink[] {
  const rows: PopupLink[] = [];
  for (const k of Array.isArray(list) ? list : []) {
    if (typeof k === "string" && ENTITY_LINKS[k]) {
      if (entity) rows.push({ kind: "link", ...ENTITY_LINKS[k](entity) });
    } else if (plain(k) && k.label && (k.navigate || k.url)) {
      rows.push({
        kind: "link",
        label: String(k.label),
        action: k.navigate
          ? { action: "navigate", navigation_path: String(k.navigate) }
          : { action: "url", url_path: String(k.url) },
      });
    }
  }
  return rows;
}

/**
 * Single vs double tap per target key. Without a double tap action the single tap runs at once;
 * with one it waits DOUBLE_TAP_MS for a second tap. Pending keys are independent.
 */
export class TapSequencer {
  ms: number;
  pending: Map<string, ReturnType<typeof setTimeout>>;

  constructor(ms = DOUBLE_TAP_MS) {
    this.ms = ms;
    this.pending = new Map(); // key -> timer
  }

  tap(
    key: string,
    hasDouble: boolean,
    onSingle: () => void,
    onDouble: () => void,
  ): void {
    if (!hasDouble) {
      onSingle();
      return;
    }
    const t = this.pending.get(key);
    if (t !== undefined) {
      clearTimeout(t);
      this.pending.delete(key);
      onDouble();
      return;
    }
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        onSingle();
      }, this.ms),
    );
  }

  cancel(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}
