// The card's views: structure (floors, rooms, labels) into the view, the view list and per-view
// states, visibility, marker states by room / floor, cameras, floor / mode switches, idle reset and
// the side section. Single owner of _floor / _floorOnly / _section / _viewId / _viewState /
// _viewStates / _index: other parts change them through the methods here.

import { combineRooms, measuredElevations, levelFloorOverrides, modelRooms, transformPoint, levelsFromFloorMap } from '../bindings.ts';
import { mergeFloors, roomFloorId, roomLabel, roomLabelMode } from '../layout.ts';
import { pickOutline, saveOutline } from '../load-outline.ts';
import { levelOrders, floorLevels, defaultViewId, nodeIndex, orderViews, resolveViews, resolveVisibility, primaryLevel, defaultFloors, isOverview, zoomToFor, viewCut, shownHere, exteriorShown, roomAt, deviceState, cameraToCard, topCameraToCard, sectionPlane, sectionCamera, type ResolvedView, type Visibility } from '../views.ts';
import { areaName } from '../registry.ts';
import { threeAdapter } from '../manifest.ts';
import type { Floorplan3dCard } from '../floorplan3d-card.ts';
import type { ModelBindings } from './model-loader.ts';
import type { ModelIndex } from '../view/model.ts';
import type { Floor, LayoutRoom, PlanPoint, SectionPlaneConfig } from '../types/layout.ts';


/** A view's state: effective node visibility, primary storey, linked HA floors. */
export interface ViewState {
  effective: Visibility | null;
  primary: string | null;
  floors: string[];
  allFloors: boolean;
  overview: boolean;
}

/** A drawn room or one from the model (bindings.js modelRooms / combineRooms). */
export type PlanRoom = LayoutRoom & { modelId?: string; label?: string; name?: string; fromModel?: boolean };

/** A room of the plan with its HA floor, display name and model level. */
export interface RoomEntry {
  room: PlanRoom;
  floorId: string;
  name: string;
  levelId: string | null | undefined;
}

/** Model levels: order, level -> HA floor, HA floor -> level. */
export interface Levels {
  levelOrder: ReturnType<typeof levelOrders>;
  levelFloor: Record<string, string>;
  floorLevel: ReturnType<typeof floorLevels>;
}

/** A model room / zone outline in card plan (map clip, roomless markers). */
export interface Zone {
  id: string;
  level: string | null;
  polygon: PlanPoint[];
}


export class ViewController {
  card: Floorplan3dCard;
  _floor: string | null;
  _views: ResolvedView[];
  _viewId: string | null;
  _viewState: ViewState | null;
  _viewStates: Map<string, ViewState>;
  _index: ModelIndex | null;
  _mode: '3d' | 'top';
  _section: boolean;
  _sectionPreview: SectionPlaneConfig | null;
  _floorOnly: string | null | undefined;
  _floors: Floor[] | undefined;
  _levels: Levels | null | undefined;
  _modelRooms: PlanRoom[] | undefined;
  _zones: Zone[] | undefined;
  _roomList: RoomEntry[] | undefined;
  _outlineModel: unknown;
  _labelKey: string | undefined;
  _viewFresh: boolean | undefined;
  _fitted: boolean | undefined;
  _idleTimer: ReturnType<typeof setTimeout> | null | undefined;

  /** @param card the Floorplan3dCard (host): read live, never captured */
  constructor(card: Floorplan3dCard) {
    this.card = card;
    this._floor = null;
    this._views = [];
    this._viewId = null;
    this._viewState = null;
    this._viewStates = new Map();
    this._index = null;
    this._mode = '3d';
    this._section = false; // side section toggle
    this._sectionPreview = null; // Views tab slider: plane shown while dragging
    this._floorOnly = undefined; // one HA floor on its own (edit mode), not a view
    this._floors = undefined;
    this._levels = undefined;
    this._modelRooms = undefined;
    this._zones = undefined;
    this._roomList = undefined;
    this._outlineModel = undefined;
    this._labelKey = undefined;
    this._viewFresh = undefined;
    this._fitted = undefined;
    this._idleTimer = undefined;
  }

  // The node index of the model (views.js nodeIndex), null without one.
  setIndex(index: ModelIndex | null): void {
    this._index = index;
  }

  // Per-view states dropped (index or tags changed): the active view's resolved again.
  refreshViewState(): void {
    this._viewStates = new Map();
    const cur = this.currentView();
    this._viewState = cur ? this._stateFor(cur) : null;
  }

  // Leaving edit mode: back to the view the chips show (camera kept).
  clearFloorOnly(): void {
    if (!this._floorOnly) return;
    this._floorOnly = null;
    this._applyViewVisibility();
    this._applyMarkerStates();
  }

  dispose(): void {
    clearTimeout(this._idleTimer ?? undefined);
    this._idleTimer = null;
  }

  _allRooms(): PlanRoom[] {
    return combineRooms((this.card._layout && this.card._layout.rooms) || [], this._modelRooms || []);
  }

  _buildStructure(mb: ModelBindings | null, viewsChanged = false): void {
    const h = this.card._hass, b = this.card._built, l = this.card._layout!; // built from _update (layout loaded)
    b.rooms = l.rooms;
    b.roomLabels = l.room_labels || null;
    b.lfloors = l.floors;
    b.floors = h.floors;
    b.areas = h.areas;
    const align = this.card._modelAlign();
    // a level bound to an HA floor gives that floor its elevation and height (user overrides win);
    // untagged levels use their measured geometry
    let overrides: ReturnType<typeof levelFloorOverrides> = [];
    if (mb) {
      const meas = measuredElevations(mb.manifest.levels);
      const levels = mb.manifest.levels.map((lv) => (meas[lv.id] ? { ...lv, elevation: meas[lv.id].elevation, height: lv.height ?? meas[lv.id].height } : lv));
      overrides = levelFloorOverrides(levels, mb.levels, align);
    }
    const floors: Floor[] = (this._floors = mergeFloors(h, { ...l, floors: [...overrides, ...(l.floors || [])] }));
    this._modelRooms = mb ? modelRooms(mb.manifest.rooms, mb.levels, mb.rooms, align) : [];
    // every model room / zone outline in card plan, for roomless markers (pins) by position
    if (this.card._view.model && this._outlineModel !== this.card._view.model) { // the next load draws these while it waits
      const polys = pickOutline(this._modelRooms);
      if (polys.length) {
        saveOutline(this.card._config.layout_key, polys);
        this._outlineModel = this.card._view.model;
      }
    }
    this._zones = mb ? mb.manifest.rooms.flatMap((r): Zone[] => (Array.isArray(r.outline) && r.outline.length > 2
      ? [{ id: r.id, level: r.level, polygon: r.outline.map((p) => transformPoint(p, align)) }] : [])) : [];
    if (mb) {
      this.card._view.setModelLevels(mb.levels);
      const levelOrder = levelOrders(mb.manifest.levels);
      const levelFloor: Record<string, string> = {};
      for (const [id, a] of Object.entries(mb.levels || {})) if (a && a.floor) levelFloor[id] = a.floor;
      this._levels = { levelOrder, levelFloor, floorLevel: floorLevels(levelFloor, levelOrder) };
    } else {
      this._levels = null;
    }
    const roomLevel = new Map<string, string | null>(mb ? mb.manifest.rooms.map((r): [string, string | null] => [r.id, r.level]) : []);
    const levels = this._levels;
    const roomList: RoomEntry[] = (this._roomList = this._allRooms().map((room) => {
      const floorId = roomFloorId(room, h, floors);
      return {
        room, floorId,
        name: room.name || (room.area_id ? areaName(h, room.area_id) : room.label || ''),
        levelId: room.modelId ? roomLevel.get(room.modelId) : levels ? levels.floorLevel[floorId] : undefined,
      };
    }));

    const fresh = !!this._viewFresh;
    this._viewFresh = false;
    this._pickView();
    if (viewsChanged) this._floorOnly = null;
    const cur = this.currentView();
    this._viewState = cur ? this._stateFor(cur) : null;
    this._applyZoomTo();
    this._pushStructure();
    if (!this._floorOnly) this._applyViewVisibility();
    this.card._empty.hidden = roomList.length > 0 || !!this.card._editing;
    this.card._empty.textContent = 'No rooms drawn yet. Open edit mode to draw rooms for your areas.';
    this.card._syncToolbar();
    // frame once per load / model; later rebuilds (edits, registry changes) keep the user's camera
    if (fresh) {
      this._fitted = false;
      this._initialCamera();
    }
  }

  // The active view: kept while it exists, else the configured / first one. Resets the per-view states.
  _pickView(): void {
    this._viewStates = new Map();
    if (!this._views.some((v) => v.id === this._viewId && !v.hidden)) {
      const floors = this._floors!, rooms = this._roomList!; // set by _buildStructure, which calls this first
      const withRooms = floors.find((f) => rooms.some((r) => r.floorId === f.id)) || floors[0];
      this._viewId = defaultViewId(this._views, {
        viewId: this.card._config.view_id, floor: this.card._config.floor, fallback: this.card._view.model ? null : withRooms.id,
      }, (v: ResolvedView) => this._stateFor(v).floors);
      this._floorOnly = null;
    }
  }

  // View settings changed (rules, labels, cameras, floors, cut, order): re-resolve visibility and
  // marker states only; the scene, rooms and markers stay.
  _refreshViews(): void {
    this._pickView();
    this._floorOnly = null;
    const cur = this.currentView();
    this._viewState = cur ? this._stateFor(cur) : null;
    this._applyZoomTo();
    if (this._labelKeyNow() !== this._labelKey) this._pushStructure();
    this._applyViewVisibility();
    this._applyMarkerStates();
    this.card._syncToolbar();
  }

  // Rooms, walls and labels into the view. Labels with a model: edit mode, or storey views for
  // rooms on the view's primary level.
  _pushStructure(): void {
    const hasModel = !!this.card._view.model;
    const st = this._viewState;
    const mode = this._roomLabelMode();
    this._labelKey = this._labelKeyNow();
    const labelled = (r: RoomEntry): boolean => !hasModel || !!this.card._editing || (!!st && !st.overview && !!st.primary && r.levelId === st.primary);
    const rooms = (this._roomList || []).map((r) => ({
      room: r.room, floorId: r.floorId, label: labelled(r) ? roomLabel(r.name, r.room.polygon, mode) : '',
    }));
    this.card._view.setStructure(this._floors!, rooms, { // set by _buildStructure before any push
      wallHeight: Number(this.card._config.wall_height) || 1.0,
      walls: !hasModel, fills: !hasModel, outlines: !hasModel || !!this.card._editing, labels: true,
    });
    this.card._stage.classList.toggle('has-model', hasModel);
  }

  // Room labels: card YAML room_labels wins over the layout's (Edit -> Rooms), default name and size.
  _roomLabelMode(): ReturnType<typeof roomLabelMode> {
    return roomLabelMode(this.card._config, this.card._layout);
  }

  _labelKeyNow(): string {
    const st = this._viewState;
    if (!this.card._view.model || this.card._editing) return '*';
    return st && !st.overview && st.primary ? 'p:' + st.primary : '';
  }

  // Views from the model (or HA floors without one) merged with layout + YAML overrides.
  // Returns true when they changed. A new model resets the node index and re-frames.
  _resolveViewList(mb: ModelBindings | null): boolean | 'views' {
    const l = this.card._layout!, b = this.card._built; // from _update (layout loaded)
    // same inputs (by identity) as last time: nothing to resolve (the usual per-state-update case)
    const inputs = [mb, l.views, l.view_order, l.floors, l.model, this.card._hass.floors, this.card._config];
    const was = b.viewInputs;
    if (was && inputs.every((x, i) => x === was[i])) return false;
    b.viewInputs = inputs;
    const manifest = mb ? mb.manifest : null;
    const haFloors = mergeFloors(this.card._hass, manifest ? { floors: [] } : l);
    const savedLevels = { ...(this.card._config.model ? levelsFromFloorMap(this.card._config.model_floors) : {}), ...(l.model && l.model.levels) };
    const key = JSON.stringify([haFloors.map((f) => [f.id, f.name]), this.card._config.views || null, savedLevels, mb ? mb.levels : null]);
    const vkey = JSON.stringify([l.views || null, l.view_order || null]);
    if (manifest === b.viewManifest && key === b.viewKey && vkey === b.viewsKey) return false;
    const onlyViews = manifest === b.viewManifest && key === b.viewKey && !!this._floors;
    if (manifest !== b.viewManifest) {
      this._index = manifest && this.card._view.model ? nodeIndex(threeAdapter(this.card._view.model.root), manifest) : null;
      this.card._tagIndex();
      this._viewFresh = true;
    }
    b.viewManifest = manifest;
    b.viewKey = key;
    b.viewsKey = vkey;
    this._views = orderViews(resolveViews({ manifest, haFloors, layoutViews: l.views, yamlViews: this.card._config.views, savedLevels }), l.view_order);
    return onlyViews ? 'views' : true;
  }

  // Per view: effective node visibility, primary storey, linked HA floors (cached until the next rebuild).
  _stateFor(v: ResolvedView): ViewState {
    let st = this._viewStates.get(v.id);
    if (st) return st;
    const allIds = (this._floors || []).map((f) => f.id);
    const mb = this.card._mb;
    if (!mb || !this._index || !this._levels) {
      const allFloors = v.id === 'all' && !Array.isArray(v.floors);
      st = { effective: null, primary: null, floors: Array.isArray(v.floors) ? [...v.floors] : allFloors ? allIds : [], allFloors, overview: allFloors };
    } else {
      const effective = resolveVisibility(this._index, v.rules);
      const primary = primaryLevel(this._index, effective, mb.manifest.levels);
      const allFloors = !Array.isArray(v.floors) && v.id === 'all' && v.source !== 'model';
      const floors: string[] = Array.isArray(v.floors) ? [...v.floors] : allFloors ? allIds : defaultFloors(primary, this._levels.levelFloor);
      st = { effective, primary, floors, allFloors, overview: isOverview(this._index, effective, mb.manifest.levels) };
    }
    this._viewStates.set(v.id, st);
    return st;
  }

  currentView(): ResolvedView | null {
    return this._views.find((v) => v.id === this._viewId) || null;
  }

  // Zoom pivot of the active view (view zoom_to > card zoom_to > centre).
  _applyZoomTo(): void {
    if (this.card._view) this.card._view.setZoomTo(zoomToFor(this.currentView(), this.card._config));
  }

  viewIndex(): ModelIndex | null {
    return this._index || null;
  }

  // Floors, model node visibility and cut for the active view.
  _applyViewVisibility(): void {
    const vw = this.card._view, v = this.currentView(), section = this._sectionActive();
    const st = section ? this._sectionState() : this._viewState;
    if (section) this._applySectionPlane();
    else if (vw.sectionClip) vw.setSection(null);
    if (!v || !st) {
      this._floor = 'all';
      vw.setVisibleFloors('all');
      vw.applyModelVisibility(null, null);
      vw.setCut(undefined);
      return;
    }
    const visible: 'all' | string[] = st.allFloors || (!st.floors.length && v.id === 'all') ? 'all' : st.floors;
    this._floor = visible === 'all' ? 'all' : st.floors[0] || 'all';
    vw.setVisibleFloors(visible);
    if (this._index && vw.model && st.effective) {
      vw.applyModelVisibility(this._index, st.effective);
      if (section) { vw.setCut(null); return; }
      const all = this._floors || [];
      const floors = st.floors.map((id) => all.find((f) => f.id === id)).filter((f): f is Floor => !!f);
      vw.setCut(viewCut(v, { tagged: vw.isTagged(), floors }));
    } else {
      vw.applyModelVisibility(null, null);
      vw.setCut(undefined);
    }
  }

  // Devices follow the view's visible rooms / linked floors (model only; without one the floor rules apply).
  _applyMarkerStates(): void {
    const vw = this.card._view, mb = this.card._mb, L = this._levels;
    const st = this._sectionActive() ? this._sectionState() : this._viewState;
    if (!mb || !this._index || !vw.model || !st || !st.effective || !L || this._floorOnly || !this.card._positions) {
      vw.setMarkerStates(null);
      return;
    }
    const index = this._index, effective = st.effective;
    const roomByArea = new Map<string, string | undefined>();
    for (const r of this._modelRooms || []) if (r.area_id && !roomByArea.has(r.area_id)) roomByArea.set(r.area_id, r.modelId);
    const roomLevel = new Map<string, string | null>(mb.manifest.rooms.map((r): [string, string | null] => [r.id, r.level]));
    const visibleRooms = new Set<string>();
    index.nodes.forEach((n, i) => {
      if (shownHere(effective, i) && n.tag && (n.tag.kind === 'room' || n.tag.kind === 'zone')) visibleRooms.add(n.tag.id);
    });
    const ctx = {
      levelOrder: L.levelOrder, primaryOrder: st.primary ? L.levelOrder[st.primary] ?? null : null,
      visibleRooms, viewFloors: new Set(st.floors), overview: st.overview,
    };
    const byId = new Map(this.card._markers.map((m) => [m.id, m]));
    const states = new Map<string, ReturnType<typeof deviceState>>();
    const outdoor = exteriorShown(index, effective, mb.manifest.levels);
    for (const [id, p] of this.card._positions) {
      const m = byId.get(id);
      // the live mower is outdoors: shown wherever an exterior level shows
      if (p.live && outdoor !== null) { states.set(id, { shown: outdoor, faded: false }); continue; }
      // pins (and the mower without exterior levels) are roomless: the room / zone under them, else their HA floor
      const roomId = !m ? null : p.auto === false || p.live
        ? roomAt([p.x, p.y], p.floorId, this._zones, L.levelFloor, visibleRooms) : (m.areaId && roomByArea.get(m.areaId)) || null;
      states.set(id, deviceState({
        roomId, roomLevelId: roomId ? roomLevel.get(roomId) : undefined, markerFloorId: p.floorId, floorLevelId: L.floorLevel[p.floorId],
      }, ctx));
    }
    vw.setMarkerStates(states);
  }

  // A view's cameras in card world (model cameras follow the model alignment).
  viewCamera(v: ResolvedView | null): ReturnType<typeof cameraToCard> {
    return cameraToCard(v, this.card._view.model ? (p: readonly number[]) => this.card._view.modelPointToWorld(p) : null);
  }

  viewTopCamera(v: ResolvedView): ReturnType<typeof topCameraToCard> {
    return topCameraToCard(v, this.card._view.model ? this.card._modelAlign() : null);
  }

  // Chip switch. The camera moves only for a view with its own camera (no model: frame the floor, as before).
  _setView(id: string, { instant = false }: { instant?: boolean } = {}): void {
    const v = this._views.find((x) => x.id === id);
    if (!v) return;
    const wasSection = this._section;
    this.card._popup.close();
    this._section = false;
    this._sectionPreview = null;
    this._viewId = id;
    this._floorOnly = null;
    this._viewState = this._stateFor(v);
    this._applyViewVisibility();
    if (this._labelKeyNow() !== this._labelKey) this._pushStructure();
    this._applyMarkerStates();
    this._applyZoomTo();
    if (this._mode === 'top') {
      // top view: its own camera when saved, else keep the current one (no model: frame the floor)
      if (v.camera_top) this.card._view.setTopCamera(this.viewTopCamera(v), { instant });
      else if (!this.card._view.model) this.card._view.fit({ instant });
    } else if (v.camera) this.card._view.setCamera(this.viewCamera(v), { instant });
    else if (!this.card._view.model || wasSection) this.card._view.fit({ instant });
    this.card._syncToolbar();
    if (this.card._editing) this.card._edit.onViewChanged();
  }

  // First view after load / model change: its saved camera, else frame it.
  _initialCamera(): void {
    if (this.card._view.size.w <= 1) return; // _resize retries once the card has a size
    this._fitted = true;
    const v = this.currentView();
    if (v && v.camera && this._mode === '3d') this.card._view.setCamera(this.viewCamera(v), { instant: true });
    else {
      this.card._view.fit({ instant: true });
      if (v && v.camera_top && this._mode === 'top') this.card._view.setTopCamera(this.viewTopCamera(v), { instant: true });
    }
  }

  // Option idle_reset (seconds, 0 / unset = off): after that long without a touch, wheel or key on the
  // card it returns to how it opened (start view, start mode, its camera, live sun time). For wall tablets
  // where someone leaves the plan zoomed into a corner. Never while editing.
  _armIdleReset(): void {
    clearTimeout(this._idleTimer ?? undefined);
    this._idleTimer = null;
    if (this.card._view && this.card._view.stopOrbit) this.card._view.stopOrbit(); // a touch ends the idle orbit
    const sec = Number(this.card._config && this.card._config.idle_reset);
    if (!(sec > 0) || !this.card.isConnected) return;
    this._idleTimer = setTimeout(() => this._idleReset(), sec * 1000);
  }

  _idleReset(): void {
    this._idleTimer = null;
    if (!this.card._view || !this._views) return;
    if (this.card._editing) { this._armIdleReset(); return; }
    this.card._popup.close();
    if (this.card._sunTime !== null) this.card.setSunTime(null);
    const startId = defaultViewId(this._views, {
      viewId: this.card._config.view_id, floor: this.card._config.floor, fallback: this._viewId,
    }, (v: ResolvedView) => this._stateFor(v).floors);
    if (startId && startId !== this._viewId) this._setView(startId);
    const startMode = this.card._config.view === 'top' ? 'top' : '3d';
    if (startMode !== this._mode) this._setMode(startMode);
    this._resetCamera();
    // option idle_orbit (degrees a second): then turn slowly around the start view's target until touched
    if (Number(this.card._config.idle_orbit) && startMode === '3d') this.card._view.startOrbit(Number(this.card._config.idle_orbit));
  }

  // Reset view: the view's saved camera (3D incl. its rotation centre; top: camera_top), else frame it.
  _resetCamera(): void {
    if (this._section) this.setSection(false, { camera: false });
    const v = this.currentView();
    if (this._mode === 'top') {
      if (v && v.camera_top) this.card._view.setTopCamera(this.viewTopCamera(v));
      else this.card._view.fit();
    } else this.card._view.resetCamera(this.viewCamera(v));
  }

  // ---------- side section ----------
  _sectionActive(): boolean {
    if (this._section && (!this.card._mb || !this._index || !this.card._view.model)) this._dropSection(); // model gone: fully off
    return this._section && this._mode === '3d' && !this._floorOnly;
  }

  // Section off without touching visibility or camera (callers re-apply what they need).
  _dropSection(): void {
    this._section = false;
    this._sectionPreview = null;
    if (this.card._view.sectionClip) this.card._view.setSection(null);
    if (this.card._sectionBtn) this.card._sectionBtn.classList.remove('on');
  }

  // "Show all" while the section is on: every node, all floors, overview device rules.
  _sectionState(): ViewState {
    // only while _sectionActive (a model, its index and bindings are there)
    const index = this._index!, mb = this.card._mb!;
    const effective = index.nodes.map(() => true);
    return {
      effective, primary: primaryLevel(index, effective, mb.manifest.levels),
      floors: (this._floors || []).map((f) => f.id), allFloors: true, overview: true,
    };
  }

  // A view's cut plane in card world (the active view: the Views tab preview while sliding wins).
  sectionPlaneNow(v: ResolvedView | null = this.currentView()): SectionPlaneConfig | null {
    const box = this.card._view.sectionBox();
    if (!box || !v) return null;
    if (this._sectionPreview && v.id === this._viewId) return this._sectionPreview;
    return sectionPlane(v, box, (p) => this.card._view.modelPlaneToWorld(p));
  }

  _applySectionPlane(): void {
    const plane = this.sectionPlaneNow();
    this.card._view.setSection(plane);
  }

  // Section off and back at the view's camera at once (before saving or re-centring the camera).
  leaveSection(): boolean {
    if (!this._section) return false;
    this.setSection(false, { camera: false });
    const v = this.currentView();
    if (v && v.camera) this.card._view.setCamera(this.viewCamera(v), { instant: true });
    else this.card._view.fit({ instant: true });
    return true;
  }

  // Toggle the side section. Off returns to the view's visibility and (camera: true) its camera.
  setSection(on: boolean, { camera = true }: { camera?: boolean } = {}): void {
    if (this.card._popup) this.card._popup.close();
    if (on) {
      if (this._mode !== '3d' || !this.card._view.model || !this._index) return;
      const was = this._section;
      this._section = true;
      this._applyViewVisibility();
      this._applyMarkerStates();
      const plane = this.sectionPlaneNow(), box = this.card._view.sectionBox();
      if (!was && plane && box) this.card._view.setCamera(sectionCamera(plane, box));
    } else {
      if (!this._section) return;
      this._section = false;
      this._sectionPreview = null;
      this._applyViewVisibility();
      this._applyMarkerStates();
      if (camera) this._resetCamera();
    }
    this.card._syncToolbar();
  }

  // Views tab: show this plane while the slider moves (turns the section on); null drops the preview.
  // aim: also move the camera to look at the new cut.
  previewSection(id: string, plane: SectionPlaneConfig | null, { aim = false }: { aim?: boolean } = {}): void {
    if (id !== this._viewId || this._mode !== '3d') return;
    this._sectionPreview = plane || null;
    if (!plane) { if (this._section) this._applySectionPlane(); return; }
    if (!this._section) { this.setSection(true); return; }
    this.card._view.setSection(plane);
    const box = this.card._view.sectionBox();
    if (aim && box) this.card._view.setCamera(sectionCamera(plane, box));
  }

  // Merge a patch into layout.views[id] and save (rules replace the stored list).
  saveViewPatch(id: string, patch: Record<string, unknown>): void {
    if ('section' in patch && id === this._viewId) this._sectionPreview = null; // the saved plane takes over
    const l = this.card._layout!; // the Views tab edits a loaded layout
    const views = l.views || {};
    this.card._commit({ ...l, views: { ...views, [id]: { ...views[id], ...patch } } });
  }

  // One HA floor (edit mode): the view linked to just that floor, else that floor on its own
  // with the model's level rules. Frames the floor.
  _setFloor(id: string): void {
    const vis = this._views.filter((v) => !v.hidden);
    // a storey view linked to just that floor wins over an overview (Exterior) linked to it
    const only = (v: ResolvedView): boolean => { const f = this._stateFor(v).floors; return f.length === 1 && f[0] === id; };
    const match = id === 'all' ? vis.find((v) => v.id === 'all')
      : vis.find((v) => only(v) && !this._stateFor(v).overview) || vis.find(only);
    if (match) {
      this._setView(match.id);
      if (this.card._view.model && !match.camera) this.card._view.fit();
      return;
    }
    if (this._section) this._dropSection();
    this._floorOnly = id;
    this._floor = id;
    this.card._view.setVisibleFloor(id);
    this.card._view.applyModelVisibility(null, null);
    this.card._view.setCut(undefined);
    this.card._view.setMarkerStates(null);
    this.card._view.fit();
    this.card._syncToolbar();
  }

  _setMode(mode: '3d' | 'top'): void {
    this.card._popup.close();
    if (mode !== '3d' && this._section) this.setSection(false, { camera: false });
    this._mode = mode;
    this.card._view.setMode(mode);
    const v = this.currentView(), own = v && !this._floorOnly ? v : null;
    if (mode === 'top' && own && own.camera_top) this.card._view.setTopCamera(this.viewTopCamera(own), { instant: true });
    // back in 3D: the view's saved camera, else the camera before Top (setMode framed it otherwise)
    else if (mode === '3d') {
      const cam = (own && own.camera && this.viewCamera(own)) || this.card._view.lastCamera3d;
      if (cam) this.card._view.setCamera(cam, { instant: true });
    }
    this.card._syncToolbar();
    if (this.card._editing && this.card._edit.tab === 'views') this.card._edit.render();
  }
}
