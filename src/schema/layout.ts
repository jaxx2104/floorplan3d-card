// The layout contract: the card YAML's `layout:` (written by hand). parseLayout never throws: it fills
// the defaults, drops what does not fit (warned) and keeps fields it does not know.
// The types in src/types/layout.ts are derived from these schemas.

import {
  array,
  boolean,
  literal,
  map,
  nullable,
  number,
  numeric,
  object,
  optional,
  record,
  string,
  tuple,
  union,
  unknownValue,
  withDefault,
  isPlainObject,
  run,
  type Infer,
  type Issue,
  type Schema,
} from "./core.ts";

const opt = optional;
/** null stored for "not set" (JSON of NaN / an emptied field): read as absent. */
const absentIfNull = <T>(s: Schema<T>): Schema<T | undefined> =>
  map(nullable(s), (v) => v ?? undefined);

/** Plan point in metres: [x east, y north]. */
export const planPoint = tuple(2, "[x, y]");
const vec3 = tuple(3, "[x, y, z]");
const washDir = literal("down", "up", "both", "none");

export const floorSchema = object({
  id: string(),
  name: opt(string()),
  /** Metres above the lowest floor; absent: from the HA floor level (level * 3). */
  elevation: opt(number()),
  height: opt(number()),
});

export const roomSchema = object({
  /** Missing in hand-written files: '' (the importer assigns one). */
  id: withDefault(string(), () => ""),
  area_id: opt(nullable(string())),
  floor_id: opt(nullable(string())),
  /** Corners, counter-clockwise or clockwise; fewer than 3 points: not drawn. */
  polygon: withDefault(array(planPoint), () => []),
  /** Door positions near an edge (a gap is cut into that wall). */
  doors: opt(array(planPoint)),
  outdoor: opt(boolean()),
});

export const pinSchema = object({
  x: number(),
  y: number(),
  z: opt(absentIfNull(number())),
  floor_id: opt(string()),
  /** Placed on the model: follows its alignment. */
  on_model: opt(boolean()),
  /** Model object id the pin is attached to (offset from its anchor, world metres). */
  attach: opt(string()),
  offset: opt(vec3),
});

const calibrationPoint = object({ src: planPoint, plan: planPoint });

export const mowerSchema = object({
  entity: opt(string()),
  /** 'gps' | 'xy' (others: read as gps). */
  source: opt(string()),
  x_attr: opt(string()),
  y_attr: opt(string()),
  floor_id: opt(string()),
  calibration: opt(array(calibrationPoint)),
  /** 'floor': the mower drives on the floor, not on the model's lawn. */
  ground: opt(string()),
  /** xy source: attribute with the path driven so far ([[u, v], ...] or a list of segments). */
  track_attr: opt(string()),
  /** true / 'always' (also while docked). */
  track_show: opt(union(boolean(), string())),
  track_color: opt(string()),
  track_width: opt(number()),
  track_opacity: opt(number()),
  error_entity: opt(string()),
  /** Extra "no problem" states of the error entity: "a, b" or a list. */
  ok_values: opt(union(string(), array(string()))),
  /** Minutes mowing without moving before the stuck warning (0 off). */
  stuck_minutes: opt(numeric()),
});

/** layout.model.levels[levelId]: which HA floor shows a model level (see bindings.ts). */
export const levelBindingSchema = object({
  /** null: belongs to no HA floor. */
  floor: opt(nullable(string())),
  /** Older visibility mode ('always', 'hidden', 'all-only', 'only', 'with'). */
  show: opt(string()),
});

/** layout.model.rooms[roomId]: the HA area of a model room / zone (null = none). */
export const roomBindingSchema = object({ area: opt(nullable(string())) });

/** An uploaded model (`layout.model`): file info, alignment and its level / room bindings. */
export const modelSchema = object({
  url: opt(string()),
  /** Plan metres + height. */
  position: opt(vec3),
  /** Degrees. */
  rotation: opt(number()),
  scale: opt(number()),
  opacity: opt(number()),
  name: opt(string()),
  size: opt(number()),
  uploaded: opt(union(string(), number())),
  /** Content hash of the uploaded file (integration model.py). */
  version: opt(string()),
  /** Level / room ids the user has been shown (the regeneration notice reports changes since). */
  known: opt(
    object({
      levels: withDefault(array(string()), () => []),
      rooms: withDefault(array(string()), () => []),
    }),
  ),
  levels: opt(record(levelBindingSchema)),
  rooms: opt(record(roomBindingSchema)),
  pins_migrated: opt(boolean()),
});

/** Per-object UI overrides (layout.objects[id].ui); the actions are normalised by actions.ts. */
export const objectUiSchema = object({
  tap_action: opt(unknownValue()),
  hold_action: opt(unknownValue()),
  double_tap_action: opt(unknownValue()),
  popup: opt(array(unknownValue())),
});

/** layout.objects[id]: binding and display overrides of one model object. */
export const objectSchema = object({
  /** Bound entity; null / '' = explicitly unbound; missing = automatic. */
  entity: opt(nullable(string())),
  hidden: opt(boolean()),
  label: opt(string()),
  tags: opt(array(string())),
  /** "Light on wall". */
  wash: opt(washDir),
  ui: opt(objectUiSchema),
});

/** layout.tags[name]: controller entity, label, wash of a tag. */
export const tagSchema = object({
  entity: opt(string()),
  label: opt(string()),
  wash: opt(washDir),
});

/** A view visibility rule: show or hide carries a selector ("level:ground", "node:a/b"...). */
export const viewRuleSchema = object({
  show: opt(string()),
  hide: opt(string()),
  keep_objects: opt(boolean()),
});

/** layout.views[id]: overrides of one view; cameras and sections are validated by views.ts. */
export const viewSchema = object({
  label: opt(string()),
  added: opt(boolean()),
  hidden: opt(boolean()),
  rules: opt(array(viewRuleSchema)),
  camera: opt(unknownValue()),
  camera_top: opt(unknownValue()),
  section: opt(unknownValue()),
  floors: opt(array(string())),
  cut: opt(nullable(boolean())),
  zoom_to: opt(string()),
});

export const badgesSchema = object({
  integration: opt(boolean()),
  status: opt(boolean()),
  battery: opt(boolean()),
});

export const layoutSchema = object({
  /** Overrides of HA floors (elevation, height) and layout-only floors. */
  floors: withDefault(array(floorSchema), () => []),
  rooms: withDefault(array(roomSchema), () => []),
  /** Marker id ("device:<id>" / "entity:<id>") -> fixed position. */
  pins: withDefault(record(pinSchema), () => ({})),
  /** Marker ids not shown. */
  hidden: withDefault(array(string()), () => []),
  mower: withDefault(nullable(mowerSchema), () => null),
  model: withDefault(nullable(modelSchema), () => null),
  objects: opt(record(objectSchema)),
  tags: opt(record(tagSchema)),
  views: opt(record(viewSchema)),
  view_order: opt(array(string())),
  badges: opt(badgesSchema),
  room_labels: opt(literal("size", "name", "none")),
  tap_hints: opt(literal("near", "always", "off")),
});

export type NormalisedLayout = Infer<typeof layoutSchema>;

type Raw = Record<string, unknown>;

export interface LayoutParse {
  value: NormalisedLayout;
  /** Values that did not fit and were dropped / defaulted (path + message). */
  warnings: Issue[];
  /** Paths of fields this card does not know (kept as they are). */
  unknown: string[];
}

// The YAML's layout (any shape) -> a valid layout. Never throws.
export function parseLayout(input: unknown): LayoutParse {
  const warnings: Issue[] = [];
  let raw: Raw;
  if (isPlainObject(input)) raw = input;
  else {
    if (input !== null && input !== undefined)
      warnings.push({
        path: "(root)",
        message: "expected a layout object; starting empty",
      });
    raw = {};
  }
  const r = run(layoutSchema, raw);
  return {
    value: r.value ?? emptyLayout(),
    warnings: [...warnings, ...r.warnings],
    unknown: r.unknown,
  };
}

/** A fresh empty layout of the current version. */
export const emptyLayout = (): NormalisedLayout => run(layoutSchema, {}).value!; // {} always fits (all defaults)

/** Log parse warnings once per load (unknown fields are kept and not logged). */
export function logLayoutWarnings(
  where: string,
  p: Pick<LayoutParse, "warnings">,
): void {
  for (const w of p.warnings)
    console.warn(`floorplan3d: ${where} ${w.path}: ${w.message}`);
}
