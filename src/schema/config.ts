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

/** CSS length: a number means pixels. */
const cssLength = (): Schema<string> =>
  union(
    string(),
    map(numeric(), (n) => `${n}px`),
  );

export const DEFAULT_HEIGHT = "520px";

export const cardConfigSchema = object({
  type: withDefault(string(), () => "custom:floorplan3d-card"),
  /** The layout: rooms, pins, hidden devices, mower ... (src/schema/layout.ts parses it). */
  layout: opt(owned()),
  /** Removed: the layout is written in the YAML (layout:), nothing is stored. */
  layout_key: opt(removed("the layout is the YAML's layout: now")),
  height: withDefault(cssLength(), () => DEFAULT_HEIGHT),
  group_by: opt(removed("markers are one per device")),
  /** Removed with the drawn walls: a model is cut at the top of its storey. */
  wall_height: opt(
    removed("no walls are drawn; a model is cut at its storey height"),
  ),
  /** Start mode. */
  view: withDefault(literal("3d", "top"), () => "3d" as const),
  /** Start floor (HA floor id). */
  floor: opt(string()),
  view_id: opt(string()),
  zoom_to: opt(removed("no longer used")),
  room_labels: opt(literal("size", "name", "none")),
  /** Model URL (instead of an uploaded model) and its alignment. */
  model: opt(string()),
  model_position: opt(
    refine(array(numeric()), (a) => a.length === 3, "[x, y, z]"),
  ),
  model_rotation: opt(numeric()),
  model_scale: opt(numeric()),
  model_opacity: opt(numeric()),
  /** Removed: level -> HA floor bindings are the layout's model.levels. */
  model_floors: opt(removed("use layout: model: levels")),
  /** Merge static model parts (default true). */
  merge: opt(boolean()),
  /** Weather entity; 'none' / false: no weather. Unset: the first weather entity. */
  weather: opt(union(string(), literal(false))),
  /** Cloud shadows, rain and snow (default true). */
  clouds: opt(boolean()),
  occlusion: opt(removed("markers behind the model are always dimmed")),
  sky_bodies: opt(boolean()),
  lights: opt(literal("auto", "off")),
  night_markers: opt(literal("show", "hide")),
  idle_orbit: opt(removed("no longer used")),
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
