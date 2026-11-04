// The card's views: structure (floors, rooms, labels) into the view, the view list and per-view
// states, visibility, marker states by room / floor, cameras, floor / mode switches, idle reset and
// the side section. Single owner of _floor / _floorOnly / _section / _viewId / _viewState /
// _viewStates / _index: other parts change them through the methods here.

import { combineRooms, measuredElevations, levelFloorOverrides, modelRooms, transformPoint, levelsFromFloorMap } from '../bindings.js';
import { mergeFloors, roomFloorId, roomLabel, roomLabelMode } from '../layout.js';
import { pickOutline, saveOutline } from '../load-outline.js';
import { levelOrders, floorLevels, defaultViewId, nodeIndex, orderViews, resolveViews, resolveVisibility, primaryLevel, defaultFloors, isOverview, zoomToFor, viewCut, shownHere, exteriorShown, roomAt, deviceState, cameraToCard, topCameraToCard, sectionPlane, sectionCamera } from '../views.js';
import { areaName } from '../registry.js';
import { threeAdapter } from '../manifest.js';

export class ViewController {
  /** @param {object} card the Floorplan3dCard (host): read live, never captured */
  constructor(card) {
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
  setIndex(index) {
    this._index = index;
  }

  // Per-view states dropped (index or tags changed): the active view's resolved again.
  refreshViewState() {
    this._viewStates = new Map();
    const cur = this.currentView();
    this._viewState = cur ? this._stateFor(cur) : null;
  }

  // Leaving edit mode: back to the view the chips show (camera kept).
  clearFloorOnly() {
    if (!this._floorOnly) return;
    this._floorOnly = null;
    this._applyViewVisibility();
    this._applyMarkerStates();
  }

  dispose() {
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
  }

  _allRooms() {
    return combineRooms((this.card._layout && this.card._layout.rooms) || [], this._modelRooms || []);
  }

  _buildStructure(mb, viewsChanged = false) {
    const h = this.card._hass, b = this.card._built;
    b.rooms = this.card._layout.rooms;
    b.roomLabels = this.card._layout.room_labels || null;
    b.lfloors = this.card._layout.floors;
    b.floors = h.floors;
    b.areas = h.areas;
    const align = this.card._modelAlign();
    // a level bound to an HA floor gives that floor its elevation and height (user overrides win);
    // untagged levels use their measured geometry
    let overrides = [];
    if (mb) {
      const meas = measuredElevations(mb.manifest.levels);
      const levels = mb.manifest.levels.map((lv) => (meas[lv.id] ? { ...lv, elevation: meas[lv.id].elevation, height: lv.height ?? meas[lv.id].height } : lv));
      overrides = levelFloorOverrides(levels, mb.levels, align);
    }
    this._floors = mergeFloors(h, { ...this.card._layout, floors: [...overrides, ...(this.card._layout.floors || [])] });
    this._modelRooms = mb ? modelRooms(mb.manifest.rooms, mb.levels, mb.rooms, align) : [];
    // every model room / zone outline in card plan, for roomless markers (pins) by position
    if (this.card._view.model && this._outlineModel !== this.card._view.model) { // the next load draws these while it waits
      const polys = pickOutline(this._modelRooms);
      if (polys.length) {
        saveOutline(this.card._config.layout_key, polys);
        this._outlineModel = this.card._view.model;
      }
    }
    this._zones = mb ? mb.manifest.rooms.filter((r) => Array.isArray(r.outline) && r.outline.length > 2)
      .map((r) => ({ id: r.id, level: r.level, polygon: r.outline.map((p) => transformPoint(p, align)) })) : [];
    if (mb) {
      this.card._view.setModelLevels(mb.levels);
      const levelOrder = levelOrders(mb.manifest.levels);
      const levelFloor = {};
      for (const [id, a] of Object.entries(mb.levels || {})) if (a && a.floor) levelFloor[id] = a.floor;
      this._levels = { levelOrder, levelFloor, floorLevel: floorLevels(levelFloor, levelOrder) };
    } else {
      this._levels = null;
    }
    const roomLevel = new Map(mb ? mb.manifest.rooms.map((r) => [r.id, r.level]) : []);
    this._roomList = this._allRooms().map((room) => {
      const floorId = roomFloorId(room, h, this._floors);
      return {
        room, floorId,
        name: room.name || (room.area_id ? areaName(h, room.area_id) : room.label || ''),
        levelId: room.modelId ? roomLevel.get(room.modelId) : this._levels ? this._levels.floorLevel[floorId] : undefined,
      };
    });

    const fresh = !!this._viewFresh;
    this._viewFresh = false;
    this._pickView();
    if (viewsChanged) this._floorOnly = null;
    const cur = this.currentView();
    this._viewState = cur ? this._stateFor(cur) : null;
    this._applyZoomTo();
    this._pushStructure();
    if (!this._floorOnly) this._applyViewVisibility();
    this.card._empty.hidden = this._roomList.length > 0 || !!this.card._editing;
    this.card._empty.textContent = 'No rooms drawn yet. Open edit mode to draw rooms for your areas.';
    this.card._syncToolbar();
    // frame once per load / model; later rebuilds (edits, registry changes) keep the user's camera
    if (fresh) {
      this._fitted = false;
      this._initialCamera();
    }
  }

  // The active view: kept while it exists, else the configured / first one. Resets the per-view states.
  _pickView() {
    this._viewStates = new Map();
    if (!this._views.some((v) => v.id === this._viewId && !v.hidden)) {
      const withRooms = this._floors.find((f) => this._roomList.some((r) => r.floorId === f.id)) || this._floors[0];
      this._viewId = defaultViewId(this._views, {
        viewId: this.card._config.view_id, floor: this.card._config.floor, fallback: this.card._view.model ? null : withRooms.id,
      }, (v) => this._stateFor(v).floors);
      this._floorOnly = null;
    }
  }

  // View settings changed (rules, labels, cameras, floors, cut, order): re-resolve visibility and
  // marker states only; the scene, rooms and markers stay.
  _refreshViews() {
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
  _pushStructure() {
    const hasModel = !!this.card._view.model;
    const st = this._viewState;
    const mode = this._roomLabelMode();
    this._labelKey = this._labelKeyNow();
    const labelled = (r) => !hasModel || !!this.card._editing || (!!st && !st.overview && !!st.primary && r.levelId === st.primary);
    const rooms = (this._roomList || []).map((r) => ({
      room: r.room, floorId: r.floorId, label: labelled(r) ? roomLabel(r.name, r.room.polygon, mode) : '',
    }));
    this.card._view.setStructure(this._floors, rooms, {
      wallHeight: Number(this.card._config.wall_height) || 1.0,
      walls: !hasModel, fills: !hasModel, outlines: !hasModel || !!this.card._editing, labels: true,
    });
    this.card._stage.classList.toggle('has-model', hasModel);
  }

  // Room labels: card YAML room_labels wins over the layout's (Edit -> Rooms), default name and size.
  _roomLabelMode() {
    return roomLabelMode(this.card._config, this.card._layout);
  }

  _labelKeyNow() {
    const st = this._viewState;
    if (!this.card._view.model || this.card._editing) return '*';
    return st && !st.overview && st.primary ? 'p:' + st.primary : '';
  }

  // Views from the model (or HA floors without one) merged with layout + YAML overrides.
  // Returns true when they changed. A new model resets the node index and re-frames.
  _resolveViewList(mb) {
    const l = this.card._layout, b = this.card._built;
    // same inputs (by identity) as last time: nothing to resolve (the usual per-state-update case)
    const inputs = [mb, l.views, l.view_order, l.floors, l.model, this.card._hass.floors, this.card._config];
    if (b.viewInputs && inputs.every((x, i) => x === b.viewInputs[i])) return false;
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
  _stateFor(v) {
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
      const floors = Array.isArray(v.floors) ? [...v.floors] : allFloors ? allIds : defaultFloors(primary, this._levels.levelFloor);
      st = { effective, primary, floors, allFloors, overview: isOverview(this._index, effective, mb.manifest.levels) };
    }
    this._viewStates.set(v.id, st);
    return st;
  }

  currentView() {
    return this._views.find((v) => v.id === this._viewId) || null;
  }

  // Zoom pivot of the active view (view zoom_to > card zoom_to > centre).
  _applyZoomTo() {
    if (this.card._view) this.card._view.setZoomTo(zoomToFor(this.currentView(), this.card._config));
  }

  viewIndex() {
    return this._index || null;
  }

  // Floors, model node visibility and cut for the active view.
  _applyViewVisibility() {
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
    const visible = st.allFloors || (!st.floors.length && v.id === 'all') ? 'all' : st.floors;
    this._floor = visible === 'all' ? 'all' : st.floors[0] || 'all';
    vw.setVisibleFloors(visible);
    if (this._index && vw.model && st.effective) {
      vw.applyModelVisibility(this._index, st.effective);
      if (section) { vw.setCut(null); return; }
      const floors = st.floors.map((id) => this._floors.find((f) => f.id === id)).filter(Boolean);
      vw.setCut(viewCut(v, { tagged: vw.isTagged(), floors }));
    } else {
      vw.applyModelVisibility(null, null);
      vw.setCut(undefined);
    }
  }

  // Devices follow the view's visible rooms / linked floors (model only; without one the floor rules apply).
  _applyMarkerStates() {
    const vw = this.card._view, mb = this.card._mb, L = this._levels;
    const st = this._sectionActive() ? this._sectionState() : this._viewState;
    if (!mb || !this._index || !vw.model || !st || !st.effective || !L || this._floorOnly || !this.card._positions) {
      vw.setMarkerStates(null);
      return;
    }
    const roomByArea = new Map();
    for (const r of this._modelRooms || []) if (r.area_id && !roomByArea.has(r.area_id)) roomByArea.set(r.area_id, r.modelId);
    const roomLevel = new Map(mb.manifest.rooms.map((r) => [r.id, r.level]));
    const visibleRooms = new Set();
    this._index.nodes.forEach((n, i) => {
      if (shownHere(st.effective, i) && n.tag && (n.tag.kind === 'room' || n.tag.kind === 'zone')) visibleRooms.add(n.tag.id);
    });
    const ctx = {
      levelOrder: L.levelOrder, primaryOrder: st.primary ? L.levelOrder[st.primary] ?? null : null,
      visibleRooms, viewFloors: new Set(st.floors), overview: st.overview,
    };
    const byId = new Map(this.card._markers.map((m) => [m.id, m]));
    const states = new Map();
    const outdoor = exteriorShown(this._index, st.effective, mb.manifest.levels);
    for (const [id, p] of this.card._positions) {
      const m = byId.get(id);
      // the live mower is outdoors: shown wherever an exterior level shows
      if (p.live && outdoor !== null) { states.set(id, { shown: outdoor, faded: false }); continue; }
      // pins (and the mower without exterior levels) are roomless: the room / zone under them, else their HA floor
      const roomId = !m ? null : p.auto === false || p.live
        ? roomAt([p.x, p.y], p.floorId, this._zones, L.levelFloor, visibleRooms) : roomByArea.get(m.areaId) || null;
      states.set(id, deviceState({
        roomId, roomLevelId: roomId ? roomLevel.get(roomId) : undefined, markerFloorId: p.floorId, floorLevelId: L.floorLevel[p.floorId],
      }, ctx));
    }
    vw.setMarkerStates(states);
  }

  // A view's cameras in card world (model cameras follow the model alignment).
  viewCamera(v) {
    return cameraToCard(v, this.card._view.model ? (p) => this.card._view.modelPointToWorld(p) : null);
  }

  viewTopCamera(v) {
    return topCameraToCard(v, this.card._view.model ? this.card._modelAlign() : null);
  }

  // Chip switch. The camera moves only for a view with its own camera (no model: frame the floor, as before).
  _setView(id, { instant = false } = {}) {
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
  _initialCamera() {
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
  _armIdleReset() {
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
    if (this.card._view && this.card._view.stopOrbit) this.card._view.stopOrbit(); // a touch ends the idle orbit
    const sec = Number(this.card._config && this.card._config.idle_reset);
    if (!(sec > 0) || !this.card.isConnected) return;
    this._idleTimer = setTimeout(() => this._idleReset(), sec * 1000);
  }

  _idleReset() {
    this._idleTimer = null;
    if (!this.card._view || !this._views) return;
    if (this.card._editing) { this._armIdleReset(); return; }
    this.card._popup.close();
    if (this.card._sunTime !== null) this.card.setSunTime(null);
    const startId = defaultViewId(this._views, {
      viewId: this.card._config.view_id, floor: this.card._config.floor, fallback: this._viewId,
    }, (v) => this._stateFor(v).floors);
    if (startId && startId !== this._viewId) this._setView(startId);
    const startMode = this.card._config.view === 'top' ? 'top' : '3d';
    if (startMode !== this._mode) this._setMode(startMode);
    this._resetCamera();
    // option idle_orbit (degrees a second): then turn slowly around the start view's target until touched
    if (Number(this.card._config.idle_orbit) && startMode === '3d') this.card._view.startOrbit(Number(this.card._config.idle_orbit));
  }

  // Reset view: the view's saved camera (3D incl. its rotation centre; top: camera_top), else frame it.
  _resetCamera() {
    if (this._section) this.setSection(false, { camera: false });
    const v = this.currentView();
    if (this._mode === 'top') {
      if (v && v.camera_top) this.card._view.setTopCamera(this.viewTopCamera(v));
      else this.card._view.fit();
    } else this.card._view.resetCamera(this.viewCamera(v));
  }

  // ---------- side section ----------
  _sectionActive() {
    if (this._section && (!this.card._mb || !this._index || !this.card._view.model)) this._dropSection(); // model gone: fully off
    return this._section && this._mode === '3d' && !this._floorOnly;
  }

  // Section off without touching visibility or camera (callers re-apply what they need).
  _dropSection() {
    this._section = false;
    this._sectionPreview = null;
    if (this.card._view.sectionClip) this.card._view.setSection(null);
    if (this.card._sectionBtn) this.card._sectionBtn.classList.remove('on');
  }

  // "Show all" while the section is on: every node, all floors, overview device rules.
  _sectionState() {
    const effective = this._index.nodes.map(() => true);
    return {
      effective, primary: primaryLevel(this._index, effective, this.card._mb.manifest.levels),
      floors: (this._floors || []).map((f) => f.id), allFloors: true, overview: true,
    };
  }

  // A view's cut plane in card world (the active view: the Views tab preview while sliding wins).
  sectionPlaneNow(v = this.currentView()) {
    const box = this.card._view.sectionBox();
    if (!box || !v) return null;
    if (this._sectionPreview && v.id === this._viewId) return this._sectionPreview;
    return sectionPlane(v, box, (p) => this.card._view.modelPlaneToWorld(p));
  }

  _applySectionPlane() {
    const plane = this.sectionPlaneNow();
    this.card._view.setSection(plane);
  }

  // Section off and back at the view's camera at once (before saving or re-centring the camera).
  leaveSection() {
    if (!this._section) return false;
    this.setSection(false, { camera: false });
    const v = this.currentView();
    if (v && v.camera) this.card._view.setCamera(this.viewCamera(v), { instant: true });
    else this.card._view.fit({ instant: true });
    return true;
  }

  // Toggle the side section. Off returns to the view's visibility and (camera: true) its camera.
  setSection(on, { camera = true } = {}) {
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
  previewSection(id, plane, { aim = false } = {}) {
    if (id !== this._viewId || this._mode !== '3d') return;
    this._sectionPreview = plane || null;
    if (!plane) { if (this._section) this._applySectionPlane(); return; }
    if (!this._section) { this.setSection(true); return; }
    this.card._view.setSection(plane);
    const box = this.card._view.sectionBox();
    if (aim && box) this.card._view.setCamera(sectionCamera(plane, box));
  }

  // Merge a patch into layout.views[id] and save (rules replace the stored list).
  saveViewPatch(id, patch) {
    if ('section' in patch && id === this._viewId) this._sectionPreview = null; // the saved plane takes over
    const l = this.card._layout;
    const views = l.views || {};
    this.card._commit({ ...l, views: { ...views, [id]: { ...views[id], ...patch } } });
  }

  // One HA floor (edit mode): the view linked to just that floor, else that floor on its own
  // with the model's level rules. Frames the floor.
  _setFloor(id) {
    const vis = this._views.filter((v) => !v.hidden);
    // a storey view linked to just that floor wins over an overview (Exterior) linked to it
    const only = (v) => { const f = this._stateFor(v).floors; return f.length === 1 && f[0] === id; };
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

  _setMode(mode) {
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
