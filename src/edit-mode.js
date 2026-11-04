// Edit mode: side panel (Rooms / Devices / Mower / Views / Model / Data) and the pointer interactions on
// the plan (drawing rooms, dragging corners, adding doors, dragging markers to pin them, hiding model
// parts per view).
//
// EditMode holds the edit state and is the facade the card (and the headless checks) talk to; the work
// lives in src/edit/: panel.js (panel element, rendering, dispatch), router.js (plan clicks and keys),
// tools/* (drawing, outline picking, drags, handles, map pickers, rotation centre, the Views pick menu)
// and tabs/* (each tab's markup and its act / field handlers). Those take the EditMode as `ed`.

import * as E from './editor.js';
import { roomFloorId } from './layout.js';
import { createPanel, render, setSaveState, onStates } from './edit/panel.js';
import { canvasDown, canvasMove, canvasUp, canvasDownCapture, onKeyDown, syncStageClasses } from './edit/router.js';
import { traceOutline } from './edit/tools/pick-outline.js';
import { markerDown, dragMove, dragEnd, endWindowDrag } from './edit/tools/drag.js';
import { refreshOverlay } from './edit/tools/handles.js';
import { closePicker } from './edit/tools/map-tools.js';
import { closeMenu } from './edit/tools/view-menu.js';
import { selectObject } from './edit/tabs/objects.js';
import { onViewChanged } from './edit/tabs/views.js';
import { onModelLoaded, setModelProps } from './edit/tabs/model.js';

export { sliderHtml } from './edit/html.js';

const SNAP_PX = 10; // snap radius never smaller than this many screen pixels

export class EditMode {
  constructor(card) {
    this.card = card;
    this.tab = 'rooms';
    this.selectedRoom = null;
    this.selectedMarker = null;
    this.drawing = null; // { areaId, floorId, points, cursor }
    this.picking = null; // { areaId, busy, poly, floorId, note }
    this._outlineCache = new Map();
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
    this._onKey = (e) => onKeyDown(this, e);
    this._onWinMove = (e) => dragMove(this, e);
    this._onWinUp = () => dragEnd(this);
    this._handles = new Map();
    this.vwSel = null; // a hidden view chosen in the Views tab (visible views follow the chips)
    this.vwPick = null; // { sel, idx } last part clicked in 3D on the Views tab
    this.vwExpanded = new Set(); // room/zone rows showing their objects
    this.objExpanded = new Set(); // Objects tab: room rows showing their objects (collapsed by default)
    this.objSel = null; // Objects tab: object picked in 3D / its row
    this.objTagFilter = ''; // Objects tab: show only objects with this tag ('' = all)
    this.objTagBulk = ''; // Objects tab: the tag typed for Add tag / Remove tag
    this.objPicked = new Set(); // Objects tab: multi-select for Add tag / Remove tag
    this.menu = null;
    this._onMenuAway = (e) => { if (this.menu && !e.composedPath().includes(this.menu)) closeMenu(this); };
  }

  get layout() { return this.card._layout; }
  get hass() { return this.card._hass; }
  get view() { return this.card._view; }
  get floors() { return this.card._floors || []; }

  // The floor that "Place", drawing and the door tool work on: the floor shown on its own, the view's
  // single linked floor, else (overview, several or no linked floors) the HA floor of the view's
  // primary level, else the first floor.
  activeFloor() {
    const c = this.card, has = (id) => !!id && this.floors.some((f) => f.id === id);
    if (c._floorOnly && has(c._floor)) return c._floor;
    const st = c._viewState;
    if (st && !st.allFloors && st.floors.length === 1 && has(st.floors[0])) return st.floors[0];
    const prim = st && st.primary && c._levels ? c._levels.levelFloor[st.primary] : null;
    if (has(prim)) return prim;
    if (!st && has(c._floor)) return c._floor;
    return this.floors[0].id;
  }

  floorOf(room) {
    return roomFloorId(room, this.hass, this.floors);
  }

  room(id) {
    return (this.layout.rooms || []).find((r) => r.id === id) || null;
  }

  snapRadius() {
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

  commit(layout) {
    this.card._commit(layout);
  }

  selectRoom(id) {
    this.selectedRoom = id;
    this.selectedMarker = null;
    this.doorMode = false;
    this.confirmDelete = false;
    if (id) this.tab = 'rooms';
    this.card._applyMarkerSelection(null);
    refreshOverlay(this);
    this.render();
  }

  selectMarker(id) {
    this.selectedMarker = id;
    this.selectedRoom = null;
    this.doorMode = false;
    if (id) this.tab = 'devices';
    this.card._applyMarkerSelection(id);
    refreshOverlay(this);
    this.render();
  }

  // ---------- facade: the card's listeners and hooks, and the headless checks ----------
  setSaveState(s) { setSaveState(this, s); }
  render() { render(this); }
  onStates() { onStates(this); }
  onModelLoaded(changed = true) { onModelLoaded(this, changed); }
  onViewChanged() { onViewChanged(this); }
  selectObject(id) { selectObject(this, id); }
  setModelProps(patch, rerender = true) { setModelProps(this, patch, rerender); }
  canvasDown(e) { canvasDown(this, e); }
  canvasMove(e) { canvasMove(this, e); }
  canvasUp(e) { canvasUp(this, e); }
  canvasDownCapture(e) { canvasDownCapture(this, e); }
  markerDown(m, e) { markerDown(this, m, e); }
  _syncStageClasses() { syncStageClasses(this); }
  _traceOutline(mesh, hit) { return traceOutline(this, mesh, hit); }
}
