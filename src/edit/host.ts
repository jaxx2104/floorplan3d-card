// What edit mode reads and calls on the card: the contract between Floorplan3dCard (its parts reach it
// through delegates, so the class type alone does not list them) and EditMode. The card must stay
// assignable to EditCard (`new EditMode(this)` checks it). Shapes owned by other modules (views,
// bindings, mower) are listed only as far as edit mode reads them.

import type { FloorplanView } from '../view.ts';
import type { Hass } from '../types/ha.ts';
import type { CardConfig } from '../types/config.ts';
import type { Floor, Layout, LayoutMower, MowerOverlay, PlanPoint } from '../types/layout.ts';

/** A resolved view (card._views): model / generated / added, merged with layout.views and the YAML. */
export interface CardView {
  id: string;
  label: string;
  hidden?: boolean;
  source?: string;
  camera?: unknown;
  camera_top?: unknown;
  rules?: Record<string, unknown>[];
  cut?: boolean;
  modelSection?: unknown;
  [key: string]: unknown;
}

/** Per view state (card._stateFor): effective node visibility, primary storey, linked HA floors. */
export interface ViewState {
  effective: ArrayLike<boolean> | null;
  primary: string | null;
  floors: string[];
  allFloors: boolean;
  overview?: boolean;
}

/** One node of the model's view index (pre-order). */
export interface ViewIndexNode {
  node: unknown;
  name?: string;
  parent: number;
  children: number[];
  [key: string]: unknown;
}
export interface ViewIndex { nodes: ViewIndexNode[]; [key: string]: unknown }

export interface ManifestLevel { id: string; label: string; role?: string; [key: string]: unknown }
export interface ManifestRoom {
  id: string;
  kind: string; // 'room' | 'zone'
  label: string;
  level?: string;
  outlineFallback?: boolean;
  [key: string]: unknown;
}
export interface ManifestObject {
  id: string;
  type: string;
  label?: string;
  level?: string;
  room?: string;
  suggest?: { entity?: string };
  ui?: unknown;
  hints?: unknown;
  [key: string]: unknown;
}
export interface ModelManifest {
  levels: ManifestLevel[];
  rooms: ManifestRoom[];
  objects: ManifestObject[];
  errors: string[];
  warnings: string[];
}
export interface AddedMissing { added: string[]; missing: string[] }
/** card.modelBindings(): the manifest with its level -> floor and room -> area assignments. */
export interface ModelBindings {
  manifest: ModelManifest;
  levels: Record<string, { floor?: string | null; auto?: boolean; stale?: boolean }>;
  rooms: Record<string, { area?: string | null; auto?: boolean; stale?: boolean }>;
  diff: { levels: { missing: string[] }; rooms: { missing: string[] } };
  notice: { levels: AddedMissing; rooms: AddedMissing };
}

/** An object's resolved entity binding (card._bindings). */
export interface ObjectBinding {
  entity?: string | null;
  from?: string;
  missing?: boolean;
  hidden?: boolean;
  [key: string]: unknown;
}

/** Where a marker is drawn (card._positions). */
export interface MarkerPosition {
  x: number;
  y: number;
  z: number;
  floorId: string;
  /** an attached marker whose object is in the model */
  attached?: boolean;
  [key: string]: unknown;
}

/** The model objects layer (card._objects), as far as edit mode uses it. */
export interface ObjectLayerLike {
  objectAt(id: string): { obj: ManifestObject } | null | undefined;
  anchorOf(id: string): unknown;
}

export interface MowerLive { x: number; y: number; floorId?: string | null; [key: string]: unknown }
export interface MowerImageResult { error?: string; missing?: boolean; count?: number; match?: number; [key: string]: unknown }
/** The icon blob being tracked on the map image (picture pixels). */
export interface MowerImageBlob {
  px: number;
  py: number;
  count: number | null;
  misses: number;
  imgW: number;
  imgH: number;
  sampleW: number;
  colors: number[][];
  [key: string]: unknown;
}
export interface MowerStatus { kind: string; [key: string]: unknown }
export interface MowerAutoInfo { live: string; static: string | null; picture: string | null; [key: string]: unknown }
export interface MapZone { id: string; polygon: PlanPoint[]; [key: string]: unknown }
export interface MapInfo { stripes?: string | null; mowed?: string | null; mowedSource?: string | null }

/** card._built: what the last rebuild produced; edit mode reads the theme. */
export interface BuiltState { theme?: { dark: boolean; primary: number; [key: string]: unknown } | null; [key: string]: unknown }

export interface EditCard {
  _layout: Layout;
  _hass: Hass;
  _view: FloorplanView;
  _floors: Floor[] | null | undefined;
  _config: CardConfig;
  _stage: HTMLElement;
  _store: { backend: string | null | undefined };
  _built: BuiltState;
  _editing: boolean | null | undefined;
  _mode: string;
  _floor: string | null | undefined;
  /** one HA floor on its own (edit mode), not a view */
  _floorOnly: string | null | undefined;
  _viewState: ViewState | null;
  _levels: { levelFloor: Record<string, string | null | undefined> } | null | undefined;
  _views: CardView[] | null | undefined;
  _viewId: string | null | undefined;
  _zones: MapZone[] | null | undefined;
  _modelRooms: { area_id?: string | null }[] | null | undefined;
  _mb: ModelBindings | null | undefined;
  _positions: Map<string, MarkerPosition> | null | undefined;
  _mowerMarkerId: string | null | undefined;
  _objects: ObjectLayerLike | null;
  _bindings: Map<string, ObjectBinding> | null | undefined;
  _groups: Record<string, unknown> | null | undefined;
  _mowerLive: MowerLive | null | undefined;
  _imageResult: MowerImageResult | null | undefined;
  _imageBlob: MowerImageBlob | null | undefined;
  _iconHeadRaw: number | null | undefined;
  _headSt: unknown;
  _autoMismatch: boolean | null | undefined;

  _commit(layout: Layout): void;
  _setFloor(id: string): void;
  _setMode(mode: string): void;
  _setView(id: string): void;
  _resetCamera(): void;
  _applyMarkerSelection(id: string | null): void;
  _stateFor(v: CardView): ViewState;
  _modelAlign(): unknown;
  _mowerFloor(): string;
  currentView(): CardView | null | undefined;
  viewIndex(): ViewIndex | null | undefined;
  modelBindings(): ModelBindings | null | undefined;
  saveViewPatch(id: string, patch: Record<string, unknown>): void;
  leaveSection(): void;
  sectionPlaneNow(v: CardView): { normal: number[]; constant?: number; [key: string]: unknown } | null | undefined;
  previewSection(id: string, section: unknown, opts?: { aim?: boolean }): void;
  objectLabel(o: { id: string; label?: string; [key: string]: unknown }): string;
  testObject(id: string): boolean;
  badgeOpts(): Record<string, boolean>;
  mowerAuto(cfg?: LayoutMower | null, detected?: boolean): MowerAutoInfo | null;
  mowerStatus(): MowerStatus | null;
  mowerStatusText(): string;
  mowerHeading(): { deg: number; source: string } | null;
  mapInfo?(): MapInfo;
  mapZone(o: MowerOverlay): MapZone | null;
}
