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
  [key: string]: unknown;
}

export interface MowerCalibrationPoint {
  src: PlanPoint;
  plan: PlanPoint;
}

export interface MowerOverlay {
  entity?: string;
  x?: number;
  y?: number;
  rotation?: number;
  width?: number;
  opacity?: number;
  refresh?: number;
  [key: string]: unknown;
}

export interface LayoutMower {
  entity?: string;
  source?: 'gps' | 'xy' | 'image' | string;
  x_attr?: string;
  y_attr?: string;
  floor_id?: string;
  calibration?: MowerCalibrationPoint[];
  overlay?: MowerOverlay;
  [key: string]: unknown;
}

export interface Layout {
  version: number;
  floors?: LayoutFloor[];
  rooms?: LayoutRoom[];
  pins?: Record<string, LayoutPin>;
  hidden?: string[];
  mower?: LayoutMower | null;
  model?: Record<string, unknown> | null;
  objects?: Record<string, unknown>;
  groups?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  views?: Record<string, unknown>;
  view_order?: string[];
  badges?: Record<string, unknown>;
  room_labels?: unknown;
  tap_hints?: unknown;
  [key: string]: unknown;
}

/** A floor after merging HA floors with the layout (see mergeFloors). */
export interface Floor {
  id: string;
  name: string;
  elevation: number;
  height: number;
}
