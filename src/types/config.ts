// Card YAML config (Lovelace `type: custom:floorplan3d-card`). Options with structured values are
// typed loosely here and normalised by the module that owns them (render-recipe, finish, views ...).

export interface CardConfig {
  type: string;
  layout_key?: string;
  height?: string;
  group_by?: 'device' | 'entity';
  wall_height?: number;
  model?: string;
  model_position?: [number, number, number];
  model_rotation?: number;
  model_scale?: number;
  model_floors?: unknown;
  view?: string;
  view_id?: string;
  views?: unknown;
  render?: unknown;
  ao?: unknown;
  bokeh?: unknown;
  grade?: unknown;
  background?: unknown;
  furniture?: unknown;
  lights?: unknown;
  city_lights?: unknown;
  surround_light?: unknown;
  sky_bodies?: unknown;
  sway?: unknown;
  occlusion?: unknown;
  night_markers?: unknown;
  badges?: unknown;
  actions?: unknown;
  idle_orbit?: unknown;
  idle_reset?: unknown;
  max_fps?: number;
  time_zone?: string;
  debug?: boolean;
  [key: string]: unknown;
}
