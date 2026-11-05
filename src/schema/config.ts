// The card YAML contract (Lovelace `type: custom:floorplan3d-card`). parseCardConfig never throws:
// a value of the wrong type is dropped (the option's default applies) and reported, numbers given as
// strings are read as numbers. Options with structured values owned by another module (render,
// bokeh, views, actions ...) are typed here but validated by that module (owned()).
// The types in src/types/config.ts are derived from this schema.

import {
  anyObject,
  array,
  boolean,
  literal,
  map,
  nullable,
  numeric,
  object,
  optional,
  record,
  refine,
  run,
  string,
  union,
  withDefault,
  INVALID,
  type Infer,
  type Issue,
  type Schema,
} from "./core.ts";
import type { RenderCardOption } from "../types/config.ts";

const opt = optional;

/** Passed on as written; the module that owns the option normalises it (and warns). */
const owned = <T = unknown>(): Schema<T> => ({
  expected: "a value",
  parse: (v) => v as T,
});

/** An option the card no longer has: any value is reported (`why`) and dropped. */
const removed = (why: string): Schema<never> => ({
  expected: "nothing",
  parse: (_v, path, ctx) => {
    ctx.warnings.push({ path, message: why });
    return INVALID;
  },
});

/** A string; a number in YAML (`layout_key: 2`) is read as its text. */
const text = (): Schema<string> => union(string(), map(numeric(), String));
/** CSS length: a number means pixels. */
const cssLength = (): Schema<string> =>
  union(
    string(),
    map(numeric(), (n) => `${n}px`),
  );

export const DEFAULT_HEIGHT = "520px";

export const cardConfigSchema = object({
  type: withDefault(string(), () => "custom:floorplan3d-card"),
  /** Storage key of the layout (several cards can share one, or keep their own). */
  layout_key: withDefault(text(), () => "default"),
  height: withDefault(cssLength(), () => DEFAULT_HEIGHT),
  group_by: withDefault(literal("device", "entity"), () => "device" as const),
  /** Cut-away display height of the walls (metres). */
  wall_height: withDefault(
    refine(numeric(), (n) => n > 0, "a positive number"),
    () => 1.0,
  ),
  /** Start mode. */
  view: withDefault(literal("3d", "top"), () => "3d" as const),
  /** Start floor (HA floor id). */
  floor: opt(string()),
  view_id: opt(string()),
  zoom_to: opt(literal("center", "cursor")),
  room_labels: opt(literal("size", "name", "none")),
  /** Model URL (instead of an uploaded model) and its alignment. */
  model: opt(string()),
  model_position: opt(
    refine(array(numeric()), (a) => a.length === 3, "[x, y, z]"),
  ),
  model_rotation: opt(numeric()),
  model_scale: opt(numeric()),
  model_opacity: opt(numeric()),
  /** Older level -> HA floor map for a URL model ({ levelId: floorId | 'always' | 'hidden' }). */
  model_floors: opt(record(string())),
  /** Merge static model parts (default true). */
  merge: opt(boolean()),
  /** Weather entity; 'none' / false: no weather. Unset: the first weather entity. */
  weather: opt(union(string(), literal(false))),
  /** Cloud shadows, rain and snow (default true). */
  clouds: opt(boolean()),
  occlusion: opt(boolean()),
  sky_bodies: opt(boolean()),
  lights: opt(literal("auto", "off")),
  night_markers: opt(literal("show", "hide")),
  /** Degrees a second. */
  idle_orbit: opt(numeric()),
  /** Seconds. */
  idle_reset: opt(numeric()),
  time_zone: opt(string()),
  debug: opt(boolean()),
  badges: opt(
    object({
      integration: opt(boolean()),
      status: opt(boolean()),
      battery: opt(boolean()),
    }),
  ),
  /** Per-view overrides (views.ts). */
  views: opt(nullable(anyObject())),
  /** Per-entity / per-object actions (actions.ts). */
  actions: opt(owned()),
  /** 'model' | 'default' (the render recipe), or the object form (render-recipe.ts normRenderOption). */
  render: opt(owned<RenderCardOption>()),
  max_fps: opt(owned()),
  /** Removed: the probe grids and contact shadows shade corners and contact in every quality tier. */
  ao: opt(removed("no longer used")),
  bokeh: opt(owned()),
  grade: opt(owned()),
  background: opt(owned()),
  furniture: opt(owned()),
  city_lights: opt(owned()),
  surround_light: opt(owned()),
  sway: opt(owned()),
});

export type ResolvedCardConfig = Infer<typeof cardConfigSchema>;

export interface ConfigParse {
  value: ResolvedCardConfig;
  warnings: Issue[];
}

// The YAML as HA hands it to setConfig -> the options with their defaults. Never throws.
export function parseCardConfig(input: unknown): ConfigParse {
  const r = run(cardConfigSchema, input);
  return {
    value: r.value ?? run(cardConfigSchema, {}).value!,
    warnings: r.warnings,
  }; // {} fits (all defaults)
}

const warned = new Set<string>();
/** Console warnings for the YAML problems, each once per page. */
export function logConfigWarnings(p: Pick<ConfigParse, "warnings">): void {
  for (const w of p.warnings) {
    const msg = `floorplan3d: card YAML ${w.path}: ${w.message}; ignored`;
    if (warned.has(msg)) continue;
    warned.add(msg);
    console.warn(msg);
  }
}
