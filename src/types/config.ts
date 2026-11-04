// Card YAML config (Lovelace `type: custom:floorplan3d-card`). Options with structured values are
// typed loosely here and normalised by the module that owns them (render-recipe, finish, views ...).

/** Card option render, object form: recipe source, quality tier, tone mapping. */
export interface RenderCardOptions {
  recipe?: 'model' | 'default';
  quality?: 'standard' | 'high';
  tone_mapping?: 'aces' | 'agx' | 'neutral' | 'reinhard' | 'cineon' | 'linear' | 'none';
}
export type RenderCardOption = 'model' | 'default' | RenderCardOptions;

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
  model_opacity?: number;
  /** Merge static model parts (default true). */
  merge?: boolean;
  view?: string;
  /** Start floor (HA floor id). */
  floor?: string;
  zoom_to?: string;
  room_labels?: string;
  /** Weather entity; 'none' / false: no weather. Unset: the first weather entity. */
  weather?: string | false;
  /** Cloud shadows, rain and snow (default true). */
  clouds?: boolean;
  view_id?: string;
  views?: unknown;
  /** 'model' | 'default' (the render recipe), or the object form (render-recipe.ts normRenderOption). */
  render?: RenderCardOption;
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

/** The card config after setConfig: its defaults applied. */
export type ResolvedCardConfig = CardConfig & { layout_key: string };
