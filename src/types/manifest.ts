import type { CutawayTag } from "../cutaway.ts";
// The fp-tag manifest of a house model (manifest buildManifest): levels, rooms / zones, objects and
// views read from node names / glTF extras. Generic over the node type N: three.js nodes in the card,
// glTF JSON nodes in tools/check-model.mjs.

import type {
  PlanPoint,
  SectionPlaneConfig,
  TopCamera,
  ViewCamera,
} from "./layout.ts";
import type { RenderRecipe } from "../render-recipe.ts";

export type LevelRole = "storey" | "basement" | "exterior" | "roof";
export type ManifestKind = "level" | "room" | "zone" | "object";

/** Walks any node tree (three.js scene, glTF JSON). */
export interface ModelAdapter<N> {
  roots(): N[];
  children(node: N): N[];
  name(node: N): string;
  extras(node: N): Record<string, unknown> | null | undefined;
  parent(node: N): N | null | undefined;
  /** Node origin in the root's frame (optional: enables the spot aim check). */
  position?(node: N): number[];
}

interface ManifestBase<N> {
  kind: ManifestKind;
  id: string;
  label: string;
  node: N;
  path: string;
  source?: "extras" | "name";
}

export interface ManifestLevel<N = unknown> extends ManifestBase<N> {
  kind: "level";
  role: LevelRole;
  order: number | null;
  elevation: number | null;
  height: number | null;
  /** Lowest world y of the level's geometry, set by the view after loading. */
  minY?: number;
}

export interface ManifestSuggest {
  entity?: string;
  area?: string;
  [key: string]: unknown;
}

export interface ManifestRoom<N = unknown> extends ManifestBase<N> {
  kind: "room" | "zone";
  level: string | null;
  outline: PlanPoint[] | null;
  doors: PlanPoint[];
  suggest: ManifestSuggest;
  /** Set by the view when the outline came from the room's bounding box. */
  outlineFallback?: boolean;
}

export interface ManifestObject<N = unknown> extends ManifestBase<N> {
  kind: "object";
  type: string;
  level: string | null;
  room: string | null;
  group: string | null;
  glow: string | null;
  anchor: number[] | null;
  /** Raw fp hints; normalised by objects/types.ts hintDefaults. */
  hints: Record<string, unknown>;
  suggest: ManifestSuggest;
  ui: Record<string, unknown>;
}

export type ManifestEntry<N = unknown> =
  ManifestLevel<N> | ManifestRoom<N> | ManifestObject<N>;

export interface ManifestView {
  id: string;
  label: string;
  show: string[];
  hide: string[];
  camera: ViewCamera | null;
  section?: SectionPlaneConfig;
  camera_top?: TopCamera;
}

export interface Manifest<N = unknown> {
  levels: ManifestLevel<N>[];
  rooms: ManifestRoom<N>[];
  objects: ManifestObject<N>[];
  views: ManifestView[];
  errors: string[];
  warnings: string[];
  byNode: Map<N, ManifestEntry<N>>;
  ownerOf(node: N): ManifestEntry<N> | null;
  /** Validated extras.fp.render recipe (render-recipe.ts normRender). */
  render: RenderRecipe | null;
  /** Number of render recipe keys found. */
  renderKeys: number;
  /** Nodes with a valid fp.cutaway (cutaway.ts): lowered with their side while it faces the camera. */
  cutaways: ManifestCutaway<N>[];
}

export interface ManifestCutaway<N = unknown> extends CutawayTag {
  node: N;
}
