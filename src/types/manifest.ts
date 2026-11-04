// The fp-tag manifest of a house model (manifest buildManifest): levels, rooms / zones, objects and
// views read from node names / glTF extras. Generic over the node type N: three.js nodes in the card,
// glTF JSON nodes in tools/check-model.mjs.

import type { PlanPoint, SectionPlaneConfig, TopCamera, ViewCamera } from './layout.js';

export type LevelRole = 'storey' | 'basement' | 'exterior' | 'roof';
export type ManifestKind = 'level' | 'room' | 'zone' | 'object';

/** Walks any node tree (three.js scene, glTF JSON). */
export interface ModelAdapter<N> {
  roots(): N[];
  children(node: N): N[];
  name(node: N): string;
  extras(node: N): Record<string, unknown> | null | undefined;
  parent(node: N): N | null | undefined;
}

interface ManifestBase<N> {
  kind: ManifestKind;
  id: string;
  label: string;
  node: N;
  path: string;
  source?: 'extras' | 'name' | 'legacy';
}

export interface ManifestLevel<N = unknown> extends ManifestBase<N> {
  kind: 'level';
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
  kind: 'room' | 'zone';
  level: string | null;
  outline: PlanPoint[] | null;
  doors: PlanPoint[];
  suggest: ManifestSuggest;
}

export interface ManifestObject<N = unknown> extends ManifestBase<N> {
  kind: 'object';
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

export type ManifestEntry<N = unknown> = ManifestLevel<N> | ManifestRoom<N> | ManifestObject<N>;

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
  render?: unknown;
  renderKeys?: unknown;
}
