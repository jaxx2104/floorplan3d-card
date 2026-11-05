// Device badges (pure): integration logo, status dot, low battery. No DOM here.
import { isActive } from "./registry.ts";
import type { Hass, HassEntity, HassEntityRegistryEntry } from "./types/ha.ts";

export interface BadgeOptions {
  integration: boolean;
  status: boolean;
  battery: boolean;
}
export type StatusKind = "red" | "yellow" | "green" | "grey";
export interface BadgeInfo {
  platform: string | null;
  status: StatusKind | null;
  battery: number | null;
  sig: string;
}
type Entities = Record<string, HassEntityRegistryEntry>;
type States = Record<string, HassEntity>;

export const LOW_BATTERY = 20;
export const BADGE_DEFAULTS: Readonly<BadgeOptions> = {
  integration: false,
  status: true,
  battery: true,
};

// Layout toggles, then the card YAML `badges:` per key.
export function badgeOptions(
  layoutBadges: unknown,
  yamlBadges: unknown,
): BadgeOptions {
  const out: BadgeOptions = { ...BADGE_DEFAULTS };
  for (const src of [layoutBadges, yamlBadges]) {
    if (!src || typeof src !== "object") continue;
    const rec = src as Record<string, unknown>;
    for (const k of Object.keys(BADGE_DEFAULTS) as (keyof BadgeOptions)[]) {
      const v = rec[k];
      if (typeof v === "boolean") out[k] = v;
    }
  }
  return out;
}

// device_id -> entity ids, built once per hass.entities object.
const indexCache = new WeakMap<Entities, Map<string, string[]>>();
export function deviceIndex(
  entities: Entities | null | undefined,
): Map<string, string[]> {
  if (!entities || typeof entities !== "object") return new Map();
  let idx = indexCache.get(entities);
  if (idx) return idx;
  idx = new Map<string, string[]>();
  for (const [eid, e] of Object.entries(entities)) {
    if (!e || !e.device_id) continue;
    if (!idx.has(e.device_id)) idx.set(e.device_id, []);
    idx.get(e.device_id)!.push(eid); // set just above
  }
  indexCache.set(entities, idx);
  return idx;
}

export function platformOf(
  entities: Entities | null | undefined,
  eid: string,
): string | null {
  const e = entities && entities[eid];
  return e && typeof e.platform === "string" && e.platform ? e.platform : null;
}

const INTEGRATION_NAMES: Record<string, string> = {
  sonoff: "Sonoff",
  tuya: "Tuya",
  smartthings: "SmartThings",
  hue: "Philips Hue",
  zha: "Zigbee (ZHA)",
  mqtt: "MQTT",
  esphome: "ESPHome",
  shelly: "Shelly",
  template: "Template",
  group: "Group",
};

// Readable integration name from a platform id (small map, else "my_thing" -> "My Thing").
export function integrationName(platform: unknown): string {
  if (!platform || typeof platform !== "string") return "";
  if (INTEGRATION_NAMES[platform]) return INTEGRATION_NAMES[platform];
  return platform
    .split("_")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

// <datalist> option label: "<friendly name> · <Integration>" (just the name without a platform).
export function entityOptionLabel(
  hass: Hass | null | undefined,
  eid: string,
): string {
  const st = hass && hass.states && hass.states[eid];
  const name = (st && st.attributes && st.attributes.friendly_name) || eid;
  const plat = platformOf(hass && hass.entities, eid);
  return plat ? `${name} · ${integrationName(plat)}` : String(name);
}

export function brandUrl(platform: string, dark = false): string {
  return `https://brands.home-assistant.io/_/${encodeURIComponent(platform)}/${dark ? "dark_icon" : "icon"}.png`;
}

// Lowest numeric battery % of the device's battery sensors, or null.
export function batteryLevel(
  eids: readonly string[] | null | undefined,
  states: States = {},
): number | null {
  let low: number | null = null;
  for (const eid of eids || []) {
    if (!eid.startsWith("sensor.")) continue;
    const st = states[eid];
    if (!st || !st.attributes || st.attributes.device_class !== "battery")
      continue;
    const n = Number(st.state);
    if (st.state === "" || st.state === null || !Number.isFinite(n)) continue;
    if (low === null || n < low) low = n;
  }
  return low;
}

export function problemOn(
  eids: readonly string[] | null | undefined,
  states: States = {},
): boolean {
  return (eids || []).some((eid) => {
    if (!eid.startsWith("binary_sensor.")) return false;
    const st = states[eid];
    return (
      !!st &&
      st.state === "on" &&
      st.attributes &&
      st.attributes.device_class === "problem"
    );
  });
}

const BAD = new Set(["unavailable", "unknown"]);
// 'red' | 'yellow' | 'green' | 'grey' for a primary entity state.
export function statusKind(
  st: HassEntity | null | undefined,
  { lowBattery = false, problem = false } = {},
): StatusKind {
  if (!st || BAD.has(st.state)) return "red";
  if (lowBattery || problem) return "yellow";
  const domain = String(st.entity_id || "").split(".")[0];
  if (domain === "sensor")
    return st.state !== "" && st.state !== null && st.state !== undefined
      ? "green"
      : "grey";
  return isActive(st) ? "green" : "grey";
}

// All badge inputs for a device / entity: { platform, status, battery (low % or null), sig }.
export function badgeInfo(
  hass: Pick<Hass, "states" | "entities">,
  { entityId, deviceId }: { entityId: string; deviceId?: string | null },
  opts: Readonly<BadgeOptions> = BADGE_DEFAULTS,
): BadgeInfo {
  const states = hass.states || {};
  const eids = deviceId
    ? deviceIndex(hass.entities).get(deviceId) || [entityId]
    : [entityId];
  const level = opts.status || opts.battery ? batteryLevel(eids, states) : null;
  const low = level !== null && level < LOW_BATTERY;
  const platform = opts.integration
    ? platformOf(hass.entities, entityId)
    : null;
  const status = opts.status
    ? statusKind(states[entityId], {
        lowBattery: low,
        problem: problemOn(eids, states),
      })
    : null;
  const battery =
    opts.battery && low && level !== null ? Math.round(level) : null;
  return {
    platform,
    status,
    battery,
    sig: `${platform || ""}|${status || ""}|${battery ?? ""}`,
  };
}
