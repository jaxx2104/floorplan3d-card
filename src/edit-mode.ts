// Edit mode: side panel (Rooms / Devices / Mower / Views / Model / Data) and the pointer interactions on
// the plan (drawing rooms, dragging corners, adding doors, dragging markers to pin them, hiding model
// parts per view).
//
// EditMode holds the edit state and is the facade the card (and the headless checks) talk to; the work
// lives in src/edit/: panel.js (panel element, rendering, dispatch), router.js (plan clicks and keys),
// tools/* (drawing, outline picking, drags, handles, map pickers, rotation centre, the Views pick menu)
// and tabs/* (each tab's markup and its act / field handlers). Those take the EditMode as `ed`.

import * as E from './editor.ts';
import { roomFloorId } from './layout.ts';
import { createPanel, render, setSaveState, onStates } from './edit/panel.ts';
import { canvasDown, canvasMove, canvasUp, canvasDownCapture, onKeyDown, syncStageClasses } from './edit/router.ts';
import { traceOutline } from './edit/tools/pick-outline.ts';
import { markerDown, dragMove, dragEnd, endWindowDrag } from './edit/tools/drag.ts';
import { refreshOverlay } from './edit/tools/handles.ts';
import { closePicker } from './edit/tools/map-tools.ts';
import { closeMenu } from './edit/tools/view-menu.ts';
import { selectObject } from './edit/tabs/objects.ts';
import { onViewChanged } from './edit/tabs/views.ts';
import { onModelLoaded, setModelProps } from './edit/tabs/model.ts';

import type { Mesh, Object3D } from 'three';
import type { FloorplanView } from './view.ts';
import type { Hass } from './types/ha.ts';
import type { Floorplan3dCard } from './card-impl.ts';
import type { MarkerPosition } from './layout.ts';
import type { ModelIndex } from './view/model.ts';
import type { TabId } from './edit/tabs/index.ts';
import type { TreeRows } from './edit/tabs/views.ts';
import type { MapPicker, PickerPoint } from './map-picker.ts';
import type { PinInput, SnapResult } from './editor.ts';
import type { Floor, Layout, LayoutModel, LayoutPin, LayoutRoom, MapColorKind, PlanPoint } from './types/layout.ts';
import type { OutlineGrid } from './outline.ts';


export { sliderHtml } from './edit/html.ts';

// ---------- edit state ----------
export interface Drawing { areaId: string; floorId: string; points: PlanPoint[]; cursor: SnapResult | null }
export interface Picking { areaId: string; busy: boolean; poly: PlanPoint[] | null; floorId?: string }
/** false: off; true: the mower icon colour; else the map colour category (3D click on the overlay). */
export type ColorPick = boolean | MapColorKind;
export interface AlignPair extends PickerPoint { plan: PlanPoint }
export interface Aligning {
  pairs: AlignPair[];
  pending: PickerPoint | null;
  /** the overlay alignment when it started: Cancel / Esc put it back */
  start?: { x: number; y: number; rotation: number; width: number };
}
export interface EditMessage { text: string; error?: boolean; warn?: boolean }
/** Model tab: the part clicked in 3D (untagged parts have only a path). */
export interface ModelPick { kind: string; id?: string; path?: string }
export interface StickMove { id: string; from: LayoutPin; pin: PinInput }

interface DragBase { start: [number, number]; moved: boolean; raf?: number }
/** A room corner (vertex) or edge midpoint (mid: becomes a vertex drag on the first move). */
export interface RoomDrag extends DragBase {
  kind: 'vertex' | 'mid';
  roomId: string;
  /** the corner dragged (mid: set on the first move) */
  index: number;
  /** mid: the edge whose midpoint was grabbed */
  edge: number;
  base?: LayoutRoom;
  preview?: LayoutRoom;
}
export interface MarkerDrag extends DragBase {
  kind: 'marker';
  id: string;
  pos: MarkerPosition;
  last?: { clientX: number; clientY: number };
  /** model object under the pointer (the drop attaches to it) */
  attach?: string | null;
  snapped?: boolean;
}
export interface OverlayDrag extends DragBase {
  kind: 'overlay';
  plan: PlanPoint;
  origin: [number, number];
  floorId: string;
}
export type Drag = RoomDrag | MarkerDrag | OverlayDrag;

/** Traced floor outlines per mesh piece and height (pick-outline). */
export interface OutlineEntry { grid?: OutlineGrid | null; loops?: PlanPoint[][] }

const SNAP_PX = 10; // snap radius never smaller than this many screen pixels

export class EditMode {
  card: Floorplan3dCard;
  tab: TabId;
  selectedRoom: string | null;
  selectedMarker: string | null;
  drawing: Drawing | null;
  picking: Picking | null;
  _outlineCache: Map<string, OutlineEntry>;
  _outlineModel: unknown;
  _outlineAlign: string | null;
  doorMode: boolean;
  calibrating: { src: PlanPoint } | null;
  colorPick: ColorPick;
  overlayMove: boolean;
  aligning: Aligning | null;
  drag: Drag | null;
  confirmDelete: boolean;
  confirmModelDelete: boolean;
  saveState: string;
  message: EditMessage | null;
  picker: MapPicker | null;
  pivoting: boolean;
  modelPick: ModelPick | null;
  stick: { moves: StickMove[] } | null;
  uploading: string | null;
  _freshModel: boolean;
  _snapPending: boolean;
  _down: [number, number] | null;
  _sliding: boolean;
  _renderHeld: boolean;
  _numTimer: ReturnType<typeof setTimeout> | undefined;
  _renderedTab: TabId | null;
  _reportOpen: boolean;
  _advancedOpen: boolean;
  _setupOpen: boolean;
  _setupLast: string | null;
  _treeCache: { idx: ModelIndex; objs: unknown; tree: TreeRows } | null;
  _posCache: { idx: ModelIndex; map: Map<Object3D, number> } | null;
  panel: HTMLDivElement;
  _onKey: (e: KeyboardEvent) => void;
  _onWinMove: (e: PointerEvent) => void;
  _onWinUp: () => void;
  _handles: Map<string, HTMLDivElement>;
  vwSel: string | null;
  vwPick: { sel: string; idx: number } | null;
  vwExpanded: Set<string>;
  objExpanded: Set<string>;
  objSel: string | null;
  objTagFilter: string;
  objTagBulk: string;
  objPicked: Set<string>;
  menu: HTMLDivElement | null;
  _onMenuAway: (e: PointerEvent) => void;

  constructor(card: Floorplan3dCard) {
    this.card = card;
    this.tab = 'rooms';
    this.selectedRoom = null;
    this.selectedMarker = null;
    this.drawing = null; // { areaId, floorId, points, cursor }
    this.picking = null; // { areaId, busy, poly, floorId, note }
    this._outlineCache = new Map<string, OutlineEntry>();
    this._outlineModel = null;
    this._outlineAlign = null; // JSON of the model alignment the cached outlines were traced with
    this.doorMode = false;
    this.calibrating = null; // { src } waiting for a click on the plan
    this.colorPick = false; // waiting for a click on the map overlay: true = mower icon, 'bg' / 'mowed' / 'nomow' = map colours
    this.overlayMove = false;
    this.aligning = null; // { pairs: [{ px, py, plan }], pending: { px, py } | null } "Align by points"
    this.drag = null;
    this.confirmDelete = false;
    this.confirmModelDelete = false;
    this.saveState = '';
    this.message = null; // { text, error }
    this.picker = null; // the open MapPicker (2D map image)
    this.pivoting = false; // "Set rotation centre" waiting for a click
    this.modelPick = null; // Model tab: { kind, id } | { kind: 'untagged', path } clicked in 3D
    this.stick = null; // Devices tab: { moves } previewed by "Stick all to surfaces"
    this.uploading = null; // file name of a model upload in progress
    this._freshModel = false; // a model was just uploaded: its parts count as seen once loaded
    this._snapPending = false;
    this._down = null; // [x, y] of a left button press on the plan
    this._sliding = false; // a slider dragged / its number edited: renders are held
    this._renderHeld = false;
    this._numTimer = undefined;
    this._renderedTab = null;
    this._reportOpen = false;
    this._advancedOpen = false;
    this._setupOpen = false;
    this._setupLast = null; // Mower tab checklist markup as last rendered
    this._treeCache = null;
    this._posCache = null;
    this.panel = createPanel(this);
    this._onKey = (e: KeyboardEvent) => onKeyDown(this, e);
    this._onWinMove = (e: PointerEvent) => dragMove(this, e);
    this._onWinUp = () => dragEnd(this);
    this._handles = new Map<string, HTMLDivElement>();
    this.vwSel = null; // a hidden view chosen in the Views tab (visible views follow the chips)
    this.vwPick = null; // { sel, idx } last part clicked in 3D on the Views tab
    this.vwExpanded = new Set<string>(); // room/zone rows showing their objects
    this.objExpanded = new Set<string>(); // Objects tab: room rows showing their objects (collapsed by default)
    this.objSel = null; // Objects tab: object picked in 3D / its row
    this.objTagFilter = ''; // Objects tab: show only objects with this tag ('' = all)
    this.objTagBulk = ''; // Objects tab: the tag typed for Add tag / Remove tag
    this.objPicked = new Set<string>(); // Objects tab: multi-select for Add tag / Remove tag
    this.menu = null;
    this._onMenuAway = (e: PointerEvent) => { if (this.menu && !e.composedPath().includes(this.menu)) closeMenu(this); };
  }

  get layout(): Layout { return this.card._layout!; } // edit mode opens on a loaded layout
  get hass(): Hass { return this.card._hass; }
  get view(): FloorplanView { return this.card._view; }
  get floors(): Floor[] { return this.card._floors || []; }

  // The floor that "Place", drawing and the door tool work on: the floor shown on its own, the view's
  // single linked floor, else (overview, several or no linked floors) the HA floor of the view's
  // primary level, else the first floor.
  activeFloor(): string {
    const c = this.card, has = (id: string | null | undefined): id is string => !!id && this.floors.some((f) => f.id === id);
    if (c._floorOnly && has(c._floor)) return c._floor;
    const st = c._viewState;
    if (st && !st.allFloors && st.floors.length === 1 && has(st.floors[0])) return st.floors[0];
    const prim = st && st.primary && c._levels ? c._levels.levelFloor[st.primary] : null;
    if (has(prim)) return prim;
    if (!st && has(c._floor)) return c._floor;
    return this.floors[0].id;
  }

  floorOf(room: LayoutRoom): string {
    return roomFloorId(room, this.hass, this.floors);
  }

  room(id: string | null | undefined): LayoutRoom | null {
    return (this.layout.rooms || []).find((r) => r.id === id) || null;
  }

  snapRadius(): number {
    return Math.max(E.SNAP_RADIUS, SNAP_PX / Math.max(this.view.pixelsPerMetre(), 1e-6));
  }

  enter() {
    window.addEventListener('keydown', this._onKey);
    this.view.setStems(true);
    this.render();
    refreshOverlay(this);
    this._syncStageClasses();
  }

  // card detached while editing / attached again: window listeners off / on (state kept)
  detach() {
    window.removeEventListener('keydown', this._onKey);
    endWindowDrag(this);
    closeMenu(this);
  }

  attach() {
    window.addEventListener('keydown', this._onKey);
  }

  exit() {
    window.removeEventListener('keydown', this._onKey);
    closePicker(this);
    endWindowDrag(this);
    this.drawing = null;
    this.picking = null;
    this.doorMode = false;
    this.calibrating = null;
    this.colorPick = false;
    this.overlayMove = false;
    this.aligning = null;
    this.selectedRoom = null;
    this.selectedMarker = null;
    this.modelPick = null;
    this.vwPick = null;
    this.vwSel = null;
    this.pivoting = false;
    closeMenu(this);
    this.view.highlightModelNode(null);
    this.view.setStems(false);
    this.view.setOverlay({});
    this._syncStageClasses();
    this.card._applyMarkerSelection(null);
  }

  // called by the card after every rebuild
  afterUpdate() {
    if (this.selectedRoom && !this.room(this.selectedRoom)) this.selectedRoom = null;
    this.card._applyMarkerSelection(this.selectedMarker);
    refreshOverlay(this);
    if (this._sliding) this._renderHeld = true;
    else this.render();
  }

  commit(layout: Layout) {
    this.card._commit(layout);
  }

  selectRoom(id: string | null) {
    this.selectedRoom = id;
    this.selectedMarker = null;
    this.doorMode = false;
    this.confirmDelete = false;
    if (id) this.tab = 'rooms';
    this.card._applyMarkerSelection(null);
    refreshOverlay(this);
    this.render();
  }

  selectMarker(id: string | null) {
    this.selectedMarker = id;
    this.selectedRoom = null;
    this.doorMode = false;
    if (id) this.tab = 'devices';
    this.card._applyMarkerSelection(id);
    refreshOverlay(this);
    this.render();
  }

  // ---------- facade: the card's listeners and hooks, and the headless checks ----------
  setSaveState(s: string) { setSaveState(this, s); }
  render() { render(this); }
  onStates() { onStates(this); }
  onModelLoaded(changed = true) { onModelLoaded(this, changed); }
  onViewChanged() { onViewChanged(this); }
  selectObject(id: string) { selectObject(this, id); }
  setModelProps(patch: Partial<LayoutModel>, rerender = true) { setModelProps(this, patch, rerender); }
  canvasDown(e: PointerEvent) { canvasDown(this, e); }
  canvasMove(e: PointerEvent) { canvasMove(this, e); }
  canvasUp(e: PointerEvent) { canvasUp(this, e); }
  canvasDownCapture(e: PointerEvent) { canvasDownCapture(this, e); }
  markerDown(m: { id: string }, e: PointerEvent) { markerDown(this, m, e); }
  _syncStageClasses() { syncStageClasses(this); }
  _traceOutline(mesh: Mesh, hit: number[]) { return traceOutline(this, mesh, hit); }
}
