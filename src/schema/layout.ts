// The stored layout contract (HA storage key `floorplan3d.layouts` via the companion integration,
// frontend user data or localStorage, and exported JSON files). This is the user's real home setup:
// every layout ever saved must keep loading. parseLayout never throws: it migrates older versions,
// fills the defaults, drops what does not fit (warned) and keeps fields it does not know, so a newer
// card's data survives a round trip through this one.
//
// Changing the shape: bump LAYOUT_VERSION and add a pure migration from the previous version below.
// The types in src/types/layout.ts are derived from these schemas.

import {
  array, boolean, literal, map, nullable, number, numeric, object, optional, record, string, tuple, union,
  unknownValue, withDefault, isPlainObject, run, toJson, type Infer, type Issue, type Schema,
} from './core.ts';

/** The version this card writes. Older layouts are migrated on load; newer ones load as far as known. */
export const LAYOUT_VERSION = 2;

const opt = optional;
/** null stored for "not set" (JSON of NaN / an emptied field): read as absent. */
const absentIfNull = <T>(s: Schema<T>): Schema<T | undefined> => map(nullable(s), (v) => v ?? undefined);

/** Plan point in metres: [x east, y north]. */
export const planPoint = tuple(2, '[x, y]');
const vec3 = tuple(3, '[x, y, z]');
/** RGB colour as stored by the colour pickers ([r, g, b], 0..255). */
const rgb = map(tuple(3, '[r, g, b]'), (c): number[] => c);
const washDir = literal('down', 'up', 'both', 'none');

export const floorSchema = object({
  id: string(),
  name: opt(string()),
  /** Metres above the lowest floor; absent: from the HA floor level (level * 3). */
  elevation: opt(number()),
  height: opt(number()),
});

export const roomSchema = object({
  /** Missing in hand-written files: '' (the importer assigns one). */
  id: withDefault(string(), () => ''),
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

export const overlaySchema = object({
  entity: opt(string()),
  x: opt(number()),
  y: opt(number()),
  rotation: opt(number()),
  width: opt(number()),
  opacity: opt(number()),
  refresh: opt(number()),
  /** Set once the alignment tool ran (the defaults then count as aligned). */
  aligned: opt(boolean()),
  edit_only: opt(boolean()),
  hide_icon: opt(boolean()),
  height_offset: opt(number()),
  /** Lawn clip zone id; null / absent / 'auto': automatic, 'none': no clip. */
  zone: opt(nullable(string())),
  /** Colour keying of the map image (v1 also had a single <kind>_color: migrated). */
  bg_colors: opt(array(rgb)),
  mowed_colors: opt(array(rgb)),
  nomow_colors: opt(array(rgb)),
  bg_tolerance: opt(number()),
  mowed_tolerance: opt(number()),
  nomow_tolerance: opt(number()),
});

/** mower.image: mower icon detection on the live map (source 'image'). */
export const mowerImageSchema = object({
  entity: opt(string()),
  colors: opt(array(rgb)),
  tolerance: opt(number()),
  min_pixels: opt(number()),
  front_offset: opt(number()),
});

export const mowerSchema = object({
  entity: opt(string()),
  /** 'gps' | 'xy' | 'image' (others: read as gps). */
  source: opt(string()),
  x_attr: opt(string()),
  y_attr: opt(string()),
  floor_id: opt(string()),
  calibration: opt(array(calibrationPoint)),
  overlay: opt(nullable(overlaySchema)),
  image: opt(mowerImageSchema),
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
  /** Auto mode (static vs live map); false turns it off. */
  auto: opt(boolean()),
  /** '' = none, unset = auto-detected. */
  static_entity: opt(nullable(string())),
  picture_entity: opt(nullable(string())),
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
  known: opt(object({ levels: withDefault(array(string()), () => []), rooms: withDefault(array(string()), () => []) })),
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
  version: withDefault(number(), () => LAYOUT_VERSION),
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
  room_labels: opt(literal('size', 'name', 'none')),
  tap_hints: opt(literal('near', 'always', 'off')),
});

export type NormalisedLayout = Infer<typeof layoutSchema>;

// ---------- migrations ----------
// MIGRATIONS[n] turns a version n layout into version n + 1. Pure, tolerant of any input shape (they
// run before validation), and never drop data they do not understand.
type Raw = Record<string, unknown>;
type Migration = (l: Raw) => Raw;

const isRgb = (c: unknown): boolean => Array.isArray(c) && c.length >= 3 && c.slice(0, 3).every((v) => Number.isFinite(Number(v)));

// v1 colour keys: a single <one> colour next to (or instead of) the <many> list -> the list only.
function foldColor(o: unknown, one: string, many: string): unknown {
  if (!isPlainObject(o) || !(one in o)) return o;
  const { [one]: c, ...rest } = o;
  return Array.isArray(rest[many]) || !isRgb(c) ? rest : { ...rest, [many]: [c] };
}

// v0.1.4 model.floor_map { levelId: haFloorId | 'always' | 'hidden' } -> model.levels (saved levels win).
function foldFloorMap(m: unknown): unknown {
  if (!isPlainObject(m) || !('floor_map' in m)) return m;
  const { floor_map: fm, ...rest } = m;
  const levels: Raw = {};
  if (isPlainObject(fm)) {
    for (const [id, v] of Object.entries(fm)) if (typeof v === 'string') levels[id] = v === 'always' || v === 'hidden' ? { show: v } : { floor: v };
  }
  return { ...rest, levels: { ...levels, ...(isPlainObject(m.levels) ? m.levels : {}) } };
}

const MIGRATIONS: Record<number, Migration> = {
  // v1 -> v2: the legacy aliases readers had to understand are folded into their current form.
  //   groups (pre-0.4.5)          -> tags (a tags entry wins)
  //   model.floor_map (v0.1.4)    -> model.levels
  //   mower.overlay.<kind>_color  -> <kind>_colors, mower.image.color -> colors
  1: (l) => {
    const out: Raw = { ...l, version: 2 };
    if ('groups' in out) {
      const g = out.groups;
      delete out.groups;
      if (isPlainObject(g)) out.tags = { ...g, ...(isPlainObject(out.tags) ? out.tags : {}) };
    }
    if ('model' in out) out.model = foldFloorMap(out.model);
    if (isPlainObject(out.mower)) {
      const m: Raw = { ...out.mower };
      if (isPlainObject(m.overlay)) {
        let o = m.overlay as unknown;
        for (const k of ['bg', 'mowed', 'nomow']) o = foldColor(o, `${k}_color`, `${k}_colors`);
        m.overlay = o;
      }
      if (isPlainObject(m.image)) m.image = foldColor(m.image, 'color', 'colors');
      out.mower = m;
    }
    return out;
  },
};

export interface LayoutParse {
  value: NormalisedLayout;
  /** Values that did not fit and were dropped / defaulted (path + message). */
  warnings: Issue[];
  /** Paths of stored fields this card does not know (kept as they are). */
  unknown: string[];
  /** The stored version before migration (1 when none was stored). */
  from: number;
}

// Stored JSON (any shape: older versions, hand edits, imports) -> a valid layout of LAYOUT_VERSION
// (or the stored version when it is newer). Never throws.
export function parseLayout(input: unknown): LayoutParse {
  const warnings: Issue[] = [];
  let raw: Raw;
  if (isPlainObject(input)) raw = input;
  else {
    if (input !== null && input !== undefined) warnings.push({ path: '(root)', message: 'expected a layout object; starting empty' });
    raw = {};
  }
  const v = raw.version;
  let from = 1;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1) from = v;
  else if (v !== undefined) warnings.push({ path: 'version', message: `expected a version number, got ${JSON.stringify(v)}; read as 1` });
  if (from > LAYOUT_VERSION) warnings.push({ path: 'version', message: `layout version ${from} is newer than this card (${LAYOUT_VERSION}); fields it does not know are kept` });
  let l: Raw = { ...raw, version: from };
  for (let n = from; n < LAYOUT_VERSION; n++) l = MIGRATIONS[n](l);
  const r = run(layoutSchema, l);
  return { value: r.value ?? emptyLayout(), warnings: [...warnings, ...r.warnings], unknown: r.unknown, from };
}

/** A fresh empty layout of the current version. */
export const emptyLayout = (): NormalisedLayout => run(layoutSchema, {}).value!; // {} always fits (all defaults)

/** The JSON that is stored / exported: plain values only (no undefined), the version stamped. */
export function serializeLayout(layout: NormalisedLayout): NormalisedLayout {
  return toJson({ ...layout, version: Math.max(LAYOUT_VERSION, Number(layout.version) || 0) });
}

/** Log parse warnings once per load (unknown fields are expected from newer cards: not logged). */
export function logLayoutWarnings(where: string, p: Pick<LayoutParse, 'warnings'>): void {
  for (const w of p.warnings) console.warn(`floorplan3d: ${where} ${w.path}: ${w.message}`);
}
