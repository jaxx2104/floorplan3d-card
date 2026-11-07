// Card YAML config (Lovelace `type: custom:floorplan3d-card`). The option types are derived from the
// schema in src/schema/config.ts; options with structured values are normalised by the module that
// owns them (render-recipe, finish, views ...).

import type { ResolvedCardConfig } from "../schema/config.ts";

/** Card option render, object form: recipe source, quality tier, tone mapping. */
export interface RenderCardOptions {
  recipe?: "model" | "default";
  /** Default 'auto' (high, stepping down to standard when frames are slow). */
  quality?: "auto" | "standard" | "high";
  tone_mapping?:
    "aces" | "agx" | "neutral" | "reinhard" | "cineon" | "linear" | "none";
  /** Physical material rules (quality high): { '<selector>': 'glass' | 'floor' | 'fabric' | 'none' }. */
  materials?: Record<string, string>;
}
export type RenderCardOption = "model" | "default" | RenderCardOptions;

/** The card options after parseCardConfig (src/schema/config.ts): defaults applied, types checked. */
export type { ResolvedCardConfig };

/** The YAML as written (what HA hands to setConfig and the visual editor edits): every option optional. */
export type CardConfig = Partial<ResolvedCardConfig> & { type: string };
