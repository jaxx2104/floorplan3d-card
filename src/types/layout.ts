// Stored layout JSON (HA storage key `floorplan3d.layouts`, frontend user data or localStorage).
// This is the user's real home setup: changes must stay backward compatible or migrate on load.
// Nested sections the editor owns are typed loosely here and narrowed in the modules that own them.

/** Plan point in metres: [x east, y north]. */
export type PlanPoint = [number, number];

export interface LayoutFloor {
  id: string;
  name?: string;
  elevation?: number;
  height?: number;
}

export interface LayoutRoom {
  id: string;
  area_id?: string | null;
  floor_id?: string | null;
  polygon: PlanPoint[];
  doors?: PlanPoint[];
  outdoor?: boolean;
  [key: string]: unknown;
}

export interface LayoutPin {
  x: number;
  y: number;
  z?: number;
  floor_id?: string;
  /** Placed while a model was loaded: follows the model's alignment. */
  on_model?: boolean;
  /** Model object id the marker is attached to (follows its anchor + offset). */
  attach?: string;
  /** World metres from the attached object's anchor. */
  offset?: number[];
  [key: string]: unknown;
}

export interface MowerCalibrationPoint {
  src: PlanPoint;
  plan: PlanPoint;
}

/** RGB colour as stored by the colour pickers ([r, g, b], 0..255). */
export type RgbColor = [number, number, number] | number[];

/** Colour keying of the map image: overlay.<kind>_colors (older: a single <kind>_color). */
export type MapColorKind = 'bg' | 'mowed' | 'nomow';

export interface MowerOverlay {
  entity?: string;
  x?: number;
  y?: number;
  rotation?: number;
  width?: number;
  opacity?: number;
  refresh?: number;
  /** Set once the alignment tool ran (the defaults then count as aligned). */
  aligned?: boolean;
  edit_only?: boolean;
  hide_icon?: boolean;
  height_offset?: number;
  /** Lawn clip zone id; null / absent / 'auto': automatic, 'none': no clip. */
  zone?: string | null;
  bg_colors?: RgbColor[];
  mowed_colors?: RgbColor[];
  nomow_colors?: RgbColor[];
  bg_color?: RgbColor;
  mowed_color?: RgbColor;
  nomow_color?: RgbColor;
  bg_tolerance?: number;
  mowed_tolerance?: number;
  nomow_tolerance?: number;
  [key: string]: unknown;
}

/** mower.image: mower icon detection on the live map (source 'image'). */
export interface MowerImageConfig {
  entity?: string;
  colors?: RgbColor[];
  /** Older single colour (read as a one-colour list). */
  color?: RgbColor;
  tolerance?: number;
  min_pixels?: number;
  front_offset?: number;
  [key: string]: unknown;
}

export interface LayoutMower {
  entity?: string;
  source?: 'gps' | 'xy' | 'image' | string;
  x_attr?: string;
  y_attr?: string;
  floor_id?: string;
  calibration?: MowerCalibrationPoint[];
  overlay?: MowerOverlay | null;
  image?: MowerImageConfig;
  /** xy source: attribute with the path driven so far ([[u, v], ...] or a list of segments). */
  track_attr?: string;
  track_show?: boolean;
  track_color?: string;
  track_width?: number;
  track_opacity?: number;
  error_entity?: string;
  /** Extra "no problem" states of the error entity: "a, b" or a list. */
  ok_values?: string | string[];
  stuck_minutes?: number;
  /** Auto mode (static vs live map); false turns it off. */
  auto?: boolean;
  static_entity?: string;
  picture_entity?: string;
  [key: string]: unknown;
}

/** An uploaded model (`layout.model`): file info, alignment and its level / room bindings. */
export interface LayoutModel {
  url?: string;
  position?: [number, number, number];
  rotation?: number;
  scale?: number;
  opacity?: number;
  name?: string;
  size?: number;
  uploaded?: string | number;
  version?: unknown;
  /** Level / room ids the user has been shown (the regeneration notice reports changes since). */
  known?: { levels: string[]; rooms: string[] };
  levels?: Record<string, { floor: string | null }>;
  rooms?: Record<string, { area?: string | null }>;
  pins_migrated?: boolean;
  [key: string]: unknown;
}

/** Saved settings of one view (`layout.views[id]`). */
export interface LayoutView {
  label?: string;
  hidden?: boolean;
  added?: boolean;
  rules?: unknown[];
  floors?: string[];
  camera?: unknown;
  camera_top?: unknown;
  section?: unknown;
  cut?: boolean;
  zoom_to?: string;
  [key: string]: unknown;
}

/** Per model object settings (`layout.objects[id]`). */
export interface LayoutObject {
  /** null: explicitly unbound; absent: automatic. */
  entity?: string | null;
  hidden?: boolean;
  label?: string;
  ui?: Record<string, unknown>;
  tags?: string[];
  wash?: string;
  [key: string]: unknown;
}

/** A tag's controller entity, label and wash (`layout.tags[name]`). */
export interface LayoutTag {
  entity?: string;
  label?: string;
  wash?: string;
  [key: string]: unknown;
}

export interface Layout {
  version: number;
  floors?: LayoutFloor[];
  rooms?: LayoutRoom[];
  pins?: Record<string, LayoutPin>;
  hidden?: string[];
  mower?: LayoutMower | null;
  model?: LayoutModel | null;
  objects?: Record<string, LayoutObject>;
  groups?: Record<string, LayoutTag>;
  tags?: Record<string, LayoutTag>;
  views?: Record<string, LayoutView>;
  view_order?: string[];
  badges?: Record<string, unknown>;
  room_labels?: unknown;
  tap_hints?: unknown;
  [key: string]: unknown;
}

/** A layout after storage.normalise: the arrays and maps every reader relies on are present. */
export type NormalisedLayout = Layout & {
  floors: LayoutFloor[];
  rooms: LayoutRoom[];
  pins: Record<string, LayoutPin>;
  hidden: string[];
};

/** A floor after merging HA floors with the layout (see mergeFloors). */
export interface Floor {
  id: string;
  name: string;
  elevation: number;
  height: number;
}
