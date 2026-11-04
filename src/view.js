// Three.js scene for the floorplan: floors, rooms, cut-away walls, DOM markers, light glow.
// Plan (x, y, z) maps to world (x, floorElevation + z, -y) so north is up in top view.
//
// FloorplanView is the facade the card, the editor and the checks talk to. It owns the scene graph
// (renderer, cameras, lights, groups), floor / marker visibility, the section and the render loop;
// the rest lives in parts under src/view/, each with a back-reference to the view:
//   cam (camera.js), modelLayer (model.js), look (look.js), skyLayer (sky.js), structure (structure.js),
//   mower (mower-layer.js), occlusion (occlusion.js).
// Members used outside the class keep their names here: methods delegate to their part, fields are
// accessors that return the part's own object.

import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { levelVisible } from './bindings.js';
import { DepthPrepass } from './depth-pass.js';
import { testMode } from './view/core.js';
import { CameraRig } from './view/camera.js';
import { ModelLayer } from './view/model.js';
import { RenderLook } from './view/look.js';
import { SkyLayer } from './view/sky.js';
import { PlanStructure } from './view/structure.js';
import { MowerLayer } from './view/mower-layer.js';
import { MarkerOcclusion } from './view/occlusion.js';

export { planToWorld, testMode, frameInterval } from './view/core.js';
export { fallbackOutline, mergeStaticMeshes } from './view/model.js';
export { drawMoon } from './view/sky.js';
export { orbitStep } from './view/camera.js';

const COMPACT_PPM = 30;
const PICK_LINE_M = 0.02; // raycast threshold for lines / points (three's default is 1 m)

export class FloorplanView {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    // test mode: { drift } (checks of the cloud drift turn it back on); null in real use
    this.test = testMode() ? { drift: false } : null;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    // the parts make no scene objects in their constructors (object ids, and so draw order ties, stay as they were)
    this.look = new RenderLook(this);
    this.cam = new CameraRig(this);
    this.modelLayer = new ModelLayer(this);
    this.skyLayer = new SkyLayer(this);
    this.structure = new PlanStructure(this);
    this.mower = new MowerLayer(this);
    this.occlusion = new MarkerOcclusion(this);
    this.renderer.setPixelRatio(this.look._pixelRatio());
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.localClippingEnabled = true; // model cut-away
    this.labelRenderer = new CSS2DRenderer();
    Object.assign(this.labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none', isolation: 'isolate' }); // own stacking context: label z-indexes stay under the popup
    container.append(this.renderer.domElement, this.labelRenderer.domElement);

    this.persp = new THREE.PerspectiveCamera(35, 1, 0.3, 500);
    this.ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 500);
    this.ortho.up.set(0, 0, -1); // north up when looking straight down
    this.mode = '3d';
    this.camera = this.persp;

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2.2);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.position.set(-12, 30, 18);
    this.scene.add(this.hemi, this.sun, this.sun.target);
    // faint moonlight: always in the scene (a light added later recompiles every shader), 0 by day
    this.moonLight = new THREE.DirectionalLight(0xa8bcff, 0);
    this.moonLight.castShadow = false;
    this.scene.add(this.moonLight, this.moonLight.target);
    this.skyGroup = new THREE.Group(); // sun / moon sprites (not in the model: never merged)
    this.skyGroup.userData.helper = true;
    this.scene.add(this.skyGroup);
    this.onScreen = true; // the card is on screen (IntersectionObserver in the card); drift only then

    this.staticGroup = new THREE.Group();
    this.markerGroup = new THREE.Group();
    this.glowGroup = new THREE.Group();
    this.overlayGroup = new THREE.Group(); // editor graphics, drawn on top
    this.mowerGroup = new THREE.Group(); // map image, warning
    this.stemGroup = new THREE.Group(); // edit mode: marker -> floor stems
    this.scene.add(this.staticGroup, this.mowerGroup, this.glowGroup, this.markerGroup, this.overlayGroup, this.stemGroup);
    this.onMapImage = null; // (image, width, height) -> processed { canvas, width, height } | null
    this.onMapReprocess = null; // external map: run the card's processing again
    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);
    this.objectsGroup = new THREE.Group(); // model objects: the light pool sub-group (ObjectLayer.lights) and object labels
    this.scene.add(this.objectsGroup);
    this.onRender = null; // called after every rendered frame
    this.onPixelRatio = null; // called when the renderer's pixel ratio changed
    this.onFrameTime = null; // debug overlay: render time per frame (ms)
    this.onTick = null; // debug overlay: every animation frame
    this.objectLayer = null; // ObjectLayer (registers itself); reset when the model goes
    this.onObjectsInvalidate = null; // called when model placement or visibility changed
    this.model = null; // { id, root, manifest }
    this.modelLevels = null; // level id -> { show, floor } from the card's bindings
    this._modelVisibility = null; // { index, flags, masks } of applyModelVisibility, null = level rules
    this.modelClip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    this.sectionClip = null; // side section: global clipping plane (card world) or null
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line.threshold = PICK_LINE_M;
    this.raycaster.params.Points.threshold = PICK_LINE_M;
    this.mowerMarkerId = null; // the live mower's marker (shown with the outdoors)
    this.mowerOnFloor = false; // the mower stands on its floor (indoors: no ground ray)
    this._occSig = null; // inputs of the last occlusion pass (shown markers, model visibility, cut, section)
    this._shadowSig = null; // inputs of the last shadow map render (model visibility, cut, section)
    this.stats = { occPasses: 0, occPartial: 0, occDone: 0, shadow: 0, frames: 0, shadowLights: 0, cloudFrames: 0 }; // counters for the headless checks (occDone: full passes finished; shadowLights: per-light map redraws requested)
    this._depth = null;

    this.floors = [];
    this._rooms = null; // [{ room, floorId, label }] of setStructure
    this.visibleFloor = 'all';
    this._visibleSet = null; // Set of floor ids, null = all
    this._markerStates = null;
    this._cutOverride = undefined;
    this.cssObjects = []; // { obj, floorId }
    this.markerObjects = new Map(); // id -> { obj, floorId }
    this.glows = new Map(); // id -> { mesh, floorId }
    this.theme = { dark: false };
    this.wallHeight = 1.0;
    this.size = { w: 1, h: 1 };
    this.dirty = true;
    this._raf = null;
    this._disposed = false;
    this._maxFps = null; // card option max_fps (null: each animation's own default)
    this.renderer.domElement.addEventListener('wheel', this.cam._onWheel, { passive: true });
    this.cam._makeControls();
  }

  // --- facade: fields owned by the parts (same objects, so identity checks keep working) ---

  get controls() { return this.cam.controls; }
  set controls(v) { this.cam.controls = v; }
  get pivotMarker() { return this.cam.pivotMarker; }
  set pivotMarker(v) { this.cam.pivotMarker = v; }
  get _tween() { return this.cam._tween; }
  set _tween(v) { this.cam._tween = v; }
  get _framed() { return this.cam._framed; }
  set _framed(v) { this.cam._framed = v; }
  // The 3D camera before switching to Top (null until then).
  get lastCamera3d() { return this.cam.lastCamera3d; }

  get mergeStats() { return this.modelLayer.mergeStats; }
  set mergeStats(v) { this.modelLayer.mergeStats = v; }
  get pickHelper() { return this.modelLayer.pickHelper; }
  set pickHelper(v) { this.modelLayer.pickHelper = v; }
  get _preview() { return this.modelLayer._preview; }
  set _preview(v) { this.modelLayer._preview = v; }
  get _previewRing() { return this.modelLayer._previewRing; }
  set _previewRing(v) { this.modelLayer._previewRing = v; }
  get _previewFace() { return this.modelLayer._previewFace; }
  set _previewFace(v) { this.modelLayer._previewFace = v; }
  get _surfMeshes() { return this.modelLayer._surfMeshes; }
  set _surfMeshes(v) { this.modelLayer._surfMeshes = v; }

  get render() { return this.look.render; }
  set render(v) { this.look.render = v; }
  get renderFrom() { return this.look.renderFrom; }
  set renderFrom(v) { this.look.renderFrom = v; }
  get sky() { return this.look.sky; }
  set sky(v) { this.look.sky = v; }
  get _dome() { return this.look._dome; }
  set _dome(v) { this.look._dome = v; }
  get _sunStale() { return this.look._sunStale; }
  set _sunStale(v) { this.look._sunStale = v; }

  get skySprites() { return this.skyLayer.skySprites; }
  set skySprites(v) { this.skyLayer.skySprites = v; }
  get skyRing() { return this.skyLayer.skyRing; }
  set skyRing(v) { this.skyLayer.skyRing = v; }
  get weather() { return this.skyLayer.weather; }
  set weather(v) { this.skyLayer.weather = v; }
  get _cloudU() { return this.skyLayer._cloudU; }
  set _cloudU(v) { this.skyLayer._cloudU = v; }
  get _precip() { return this.skyLayer._precip; }
  set _precip(v) { this.skyLayer._precip = v; }

  get stems() { return this.structure.stems; }
  set stems(v) { this.structure.stems = v; }

  get mapPlane() { return this.mower.mapPlane; }
  set mapPlane(v) { this.mower.mapPlane = v; }
  get warning() { return this.mower.warning; }
  set warning(v) { this.mower.warning = v; }
  get _ground() { return this.mower._ground; }
  set _ground(v) { this.mower._ground = v; }
  get _mowerGround() { return this.mower._mowerGround; }
  set _mowerGround(v) { this.mower._mowerGround = v; }

  get _occTimer() { return this.occlusion._occTimer; }
  set _occTimer(v) { this.occlusion._occTimer = v; }
  get _occFull() { return this.occlusion._occFull; }
  set _occFull(v) { this.occlusion._occFull = v; }

  // --- facade: camera (camera.js) ---

  setZoomTo(mode) { return this.cam.setZoomTo(mode); }
  pivotPoint(clientX, clientY, y) { return this.cam.pivotPoint(clientX, clientY, y); }
  setPivot(point) { return this.cam.setPivot(point); }
  setPivotMarker(on) { return this.cam.setPivotMarker(on); }
  setControlsEnabled(on) { return this.cam.setControlsEnabled(on); }
  planPoint(clientX, clientY, height) { return this.cam.planPoint(clientX, clientY, height); }
  mapHit(clientX, clientY) { return this.cam.mapHit(clientX, clientY); }
  screenPoint(x, y, z, floorId) { return this.cam.screenPoint(x, y, z, floorId); }
  projectWorld(world) { return this.cam.projectWorld(world); }
  getCamera() { return this.cam.getCamera(); }
  getTopCamera() { return this.cam.getTopCamera(); }
  setTopCamera(c, opts) { return this.cam.setTopCamera(c, opts); }
  setCamera(cam, opts) { return this.cam.setCamera(cam, opts); }
  resetCamera(cam) { return this.cam.resetCamera(cam); }
  // the camera part moves the 3D camera through here, so a patched view._moveCamera sees every move
  _moveCamera(pos, target, instant) { return this.cam._moveCamera(pos, target, instant); }
  setMode(mode) { return this.cam.setMode(mode); }
  fit(opts) { return this.cam.fit(opts); }
  pixelsPerMetre() { return this.cam.pixelsPerMetre(); }
  resize(w, h) { return this.cam.resize(w, h); }
  startOrbit(speed) { return this.cam.startOrbit(speed); }
  stopOrbit() { return this.cam.stopOrbit(); }

  // --- facade: model (model.js) ---

  isModelLoaded(opts) { return this.modelLayer.isModelLoaded(opts); }
  isModelLoading(opts) { return this.modelLayer.isModelLoading(opts); }
  setModel(opts) { return this.modelLayer.setModel(opts); }
  modelManifest() { return this.modelLayer.modelManifest(); }
  setModelLevels(assign) { return this.modelLayer.setModelLevels(assign); }
  pickModel(clientX, clientY) { return this.modelLayer.pickModel(clientX, clientY); }
  surfaceAt(clientX, clientY) { return this.modelLayer.surfaceAt(clientX, clientY); }
  surfaceRays(worldPoint, dirs, maxDist) { return this.modelLayer.surfaceRays(worldPoint, dirs, maxDist); }
  setSurfacePreview(p) { return this.modelLayer.setSurfacePreview(p); }
  highlightModelNode(node) { return this.modelLayer.highlightModelNode(node); }
  modelBox() { return this.modelLayer.modelBox(); }
  sectionBox() { return this.modelLayer.sectionBox(); }
  modelPlaneToWorld(plane) { return this.modelLayer.modelPlaneToWorld(plane); }
  modelPointToWorld(p) { return this.modelLayer.modelPointToWorld(p); }
  meshTriangles(mesh) { return this.modelLayer.meshTriangles(mesh); }
  meshPlanRect(mesh) { return this.modelLayer.meshPlanRect(mesh); }
  isTagged() { return this.modelLayer.isTagged(); }
  applyModelVisibility(index, flags) { return this.modelLayer.applyModelVisibility(index, flags); }

  // --- facade: render look (look.js) ---

  setRenderOption(opt) { return this.look.setRenderOption(opt); }
  shadowCap() { return this.look.shadowCap(); }
  lampShadowCount() { return this.look.lampShadowCount(); }
  setDaylight(day) { return this.look.setDaylight(day); }
  setSky(sky, opts) { return this.look.setSky(sky, opts); }
  setCityLights(opt) { return this.look.setCityLights(opt); }
  setMaxFps(fps) { return this.look.setMaxFps(fps); }
  setSway(opt) { return this.look.setSway(opt); }
  setSurroundLight(opt) { return this.look.setSurroundLight(opt); }
  setAo(opt) { return this.look.setAo(opt); }
  setBokeh(opt) { return this.look.setBokeh(opt); }
  setGrade(opt) { return this.look.setGrade(opt); }
  setBackground(opt) { return this.look.setBackground(opt); }
  setFurniture(opt) { return this.look.setFurniture(opt); }
  setScreenStates(states) { return this.look.setScreenStates(states); }
  _shadowDirty() { return this.look._shadowDirty(); }
  requestShadowUpdate(lights) { return this.look.requestShadowUpdate(lights); }

  // --- facade: sky and weather (view/sky.js) ---

  setSkyBodies(bodies) { return this.skyLayer.setSkyBodies(bodies); }
  setWeather(w) { return this.skyLayer.setWeather(w); }
  _placeSkyBodies() { return this.skyLayer._placeSkyBodies(); }
  _roomHull() { return this.skyLayer._roomHull(); }
  _skyScreen(hulls, pos, radius) { return this.skyLayer._skyScreen(hulls, pos, radius); }

  // --- facade: plan structure (structure.js) ---

  setOverlay(o) { return this.structure.setOverlay(o); }
  moveMarker(id, x, y, z, floorId) { return this.structure.moveMarker(id, x, y, z, floorId); }
  setTheme(theme) { return this.structure.setTheme(theme); }
  setStructure(floors, rooms, opts) { return this.structure.setStructure(floors, rooms, opts); }
  setMarkers(markers) { return this.structure.setMarkers(markers); }
  setStems(on) { return this.structure.setStems(on); }
  setGlows(glows) { return this.structure.setGlows(glows); }

  // --- facade: mower (mower-layer.js) ---

  groundAt(x, y) { return this.mower.groundAt(x, y); }
  mowerGround(x, y, floorId) { return this.mower.mowerGround(x, y, floorId); }
  _groundRay(x, y) { return this.mower._groundRay(x, y); }
  setMapOverlay(o) { return this.mower.setMapOverlay(o); }
  setMapCanvas(canvas, natW, natH, loaded) { return this.mower.setMapCanvas(canvas, natW, natH, loaded); }
  reprocessMap() { return this.mower.reprocessMap(); }
  setMowerWarning(w) { return this.mower.setMowerWarning(w); }
  setMowerChip(c) { return this.mower.setMowerChip(c); }
  setMowerTrack(t) { return this.mower.setMowerTrack(t); }
  warningWorld() { return this.mower.warningWorld(); }

  // --- facade: occlusion (occlusion.js) ---

  setOcclusion(on) { return this.occlusion.setOcclusion(on); }
  pointHidden(world, own) { return this.occlusion.pointHidden(world, own); }
  _scheduleOcclusion(delay, id) { return this.occlusion._scheduleOcclusion(delay, id); }

  // --- the view's own: visibility, section, render loop, lifecycle ---

  setVisibleFloor(id) {
    this.setVisibleFloors(id === 'all' ? 'all' : [id]);
  }

  // ids: floor id array or 'all'. [] means 'none': all floor-bound markers/groups are hidden
  // (callers then set model flags + setCut). visibleFloor keeps the first id (or 'all') for existing callers.
  setVisibleFloors(ids) {
    const list = ids === 'all' || !Array.isArray(ids) ? null : ids;
    this._visibleSet = list ? new Set(list) : null;
    this.visibleFloor = list ? (list.length ? list[0] : 'none') : 'all';
    this._applyFloorVisibility();
    this.dirty = true;
  }

  // states: Map<markerId, {shown, faded}> or null (floor visibility rules). A marker (or glow)
  // whose id is missing from the map follows the floor rules.
  setMarkerStates(states) {
    this._markerStates = states || null;
    this._applyFloorVisibility();
    this.dirty = true;
  }

  // Clip height override (metres, world); null = no cut; undefined = automatic.
  setCut(height) {
    this._cutOverride = height;
    this._applyFloorVisibility();
    this.dirty = true;
  }

  // Side section: plane {normal, constant} (card world) clips everything (renderer.clippingPlanes);
  // model materials turn double-sided so cut walls read solid; markers and glows on the removed side
  // are hidden. null restores everything.
  setSection(plane) {
    if (plane) {
      if (!this.sectionClip) this.sectionClip = new THREE.Plane();
      this.sectionClip.normal.set(...plane.normal);
      this.sectionClip.constant = plane.constant;
      this.sectionClip.normalize();
      this.renderer.clippingPlanes = [this.sectionClip];
    } else {
      this.sectionClip = null;
      this.renderer.clippingPlanes = [];
    }
    this._sectionMaterials();
    this.skyLayer._placeSkyBodies();
    this._applyFloorVisibility(); // the section is part of the shadow / occlusion signatures
    this.dirty = true;
  }

  // double-sided model materials while the section is on (original side remembered in userData)
  _sectionMaterials() {
    if (!this.model) return;
    const on = !!this.sectionClip;
    this.model.root.traverse((o) => {
      if (!o.isMesh) return;
      for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
        if (on && mat.userData.sectionSide === undefined) {
          mat.userData.sectionSide = mat.side;
          mat.side = THREE.DoubleSide;
          mat.needsUpdate = true;
        } else if (!on && mat.userData.sectionSide !== undefined) {
          mat.side = mat.userData.sectionSide;
          delete mat.userData.sectionSide;
          mat.needsUpdate = true;
        }
      }
    });
  }

  _cutAway(pos) {
    return !!this.sectionClip && this.sectionClip.distanceToPoint(pos) < 0;
  }

  floorElevation(floorId) {
    const f = this.floors.find((x) => x.id === floorId);
    return f ? f.elevation : 0;
  }

  _shows(floorId) {
    return this._visibleSet ? this._visibleSet.has(floorId) : this.visibleFloor === 'all' || this.visibleFloor === floorId;
  }

  _applyFloorVisibility() {
    for (const g of this.staticGroup.children) g.visible = this._shows(g.userData.floorId);
    // markers live in one group for all floors, so visibility is set per object
    const ms = this._markerStates;
    const stateOf = (id) => (ms && id !== undefined ? ms.get(id) : null);
    for (const c of this.cssObjects) c.obj.visible = this._markerVisible(c);
    for (const [id, g] of this.glows) g.mesh.visible = this._glowVisible(id, g);
    for (const [id, st] of this.structure.stems) {
      const m = this.markerObjects.get(id);
      const shown = !!(m && m.obj.visible);
      st.disc.visible = shown;
      st.line.visible = shown && st.line.userData.height > 0.01;
    }
    for (const o of this.overlayGroup.children) if (!o.isCSS2DObject) o.visible = this._shows(o.userData.floorId);
    if (this.mower.warning) this.mower._warningVisible();
    if (this.mower.mowerTrack) this.mower.mowerTrack.mesh.visible = this.mower._mowerShows(this.mower.mowerTrack.floorId);
    if (this.mower.mowerChip) this.mower.mowerChip.obj.visible = this.mower._mowerShows(this.mower.mowerChip.floorId);
    if (this.model) {
      const assign = this.modelLevels || {};
      if (!this._modelVisibility) {
        for (const l of this.model.manifest.levels) l.node.visible = levelVisible(assign[l.id], this.visibleFloor, (id) => this.floors.find((f) => f.id === id)?.elevation);
      }
      // everything above the cut-away height of the selected floor is clipped (roof, upper floors)
      // untagged: the top of the selected storey (wall_height is for drawn walls only)
      const vf = this.floors.find((f) => f.id === this.visibleFloor);
      const cut = this.visibleFloor === 'all' || this.modelLayer.isTagged() ? 1e6 : this.floorElevation(this.visibleFloor) + ((vf && vf.height) || 2.7);
      this.modelClip.constant = this._cutOverride === undefined ? cut : (this._cutOverride ?? 1e6);
      if (this.modelLayer.pickHelper) this.modelLayer.pickHelper.update();
    }
    // "top" = the highest floor that actually has markers (an empty attic must not fade everything)
    let top = null, topElev = -Infinity;
    for (const c of this.cssObjects) {
      if (c.kind !== 'marker') continue;
      const e = this.floorElevation(c.floorId);
      if (e > topElev) { topElev = e; top = c.floorId; }
    }
    for (const c of this.cssObjects) {
      if (c.kind !== 'marker') continue;
      const st = stateOf(c.id);
      c.obj.element.classList.toggle('fp-faded', st ? !!st.faded : !!this.model && this.visibleFloor === 'all' && c.floorId !== top);
    }
    if (this.mower.mapPlane && this.mower.mapPlane.material.map) this.mower.mapPlane.visible = this.mower._mapShown(this.mower.mapPlane);
    // shadow map and occlusion only when their inputs changed (not on every state update)
    const model = this._modelSig();
    if (model !== this._shadowSig) {
      this._shadowSig = model;
      if (this.model) this.look._shadowDirty();
      this._objectsInvalid(); // lamps on hidden levels give their pool lights to visible ones
    }
    const occ = model + '|' + this.mode + '|' + this._shownMarkersSig();
    if (occ !== this._occSig) {
      this._occSig = occ;
      this.occlusion._scheduleOcclusion(0);
    }
  }

  // css object (marker, label, handle) visibility: marker state, else its floor; section cut
  _markerVisible(c) {
    const st = c.kind === 'marker' && this._markerStates && c.id !== undefined ? this._markerStates.get(c.id) : null;
    const floorRule = c.kind === 'marker' && c.id === this.mowerMarkerId ? this.mower._mowerShows(c.floorId) : this._shows(c.floorId);
    return (st ? !!st.shown : floorRule) && !(c.kind !== 'handle' && this._cutAway(c.obj.position));
  }

  _glowVisible(id, g) {
    const st = this._markerStates ? this._markerStates.get(id) : null;
    return (st ? !!st.shown : this._shows(g.floorId)) && !this._cutAway(g.mesh.position);
  }

  // What the shadow map depends on: the model, which of its nodes are shown, the cut, the section.
  _modelSig() {
    if (!this.model) return '';
    const mv = this._modelVisibility;
    const vis = mv ? mv.index.nodes.map((n) => (n.node.visible ? 1 : 0)).join('')
      : this.model.manifest.levels.map((l) => (l.node.visible ? 1 : 0)).join('');
    const s = this.sectionClip;
    return [this.model.id, vis, this.modelClip.constant, s ? [...s.normal.toArray(), s.constant].map((v) => v.toFixed(4)).join() : ''].join('|');
  }

  // Shown markers and where they are (occlusion input).
  _shownMarkersSig() {
    const out = [];
    for (const c of this.cssObjects) {
      if (c.kind !== 'marker' || !c.obj.visible) continue;
      const p = c.obj.position;
      out.push(`${c.id}@${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`);
    }
    return out.join(';');
  }

  _flagShadows(lights) {
    if (!lights || !lights.length) return;
    for (const l of lights) l.shadow.needsUpdate = true;
    this.renderer.shadowMap.needsUpdate = true;
    this.stats.shadowLights += lights.length;
  }

  markDirty() {
    this.dirty = true;
  }

  _objectsInvalid() {
    if (this.onObjectsInvalidate && this.model) this.onObjectsInvalidate();
  }

  start() {
    if (this._raf) return;
    const cam = this.cam, look = this.look, sky = this.skyLayer; // direct part refs on the per-frame path
    const loop = (ts) => {
      this._raf = requestAnimationFrame(loop);
      if (this.onTick) this.onTick(ts); // debug overlay: frame gaps
      if (cam._tween) cam._stepTween(performance.now());
      if (cam.controls.update()) this.dirty = true; // damping still moving
      const pivot = cam.pivotMarker;
      if (pivot && !pivot.position.equals(cam.controls.target)) {
        pivot.position.copy(cam.controls.target);
        this.dirty = true;
      }
      if (pivot && pivot.visible === !!this.sectionClip) {
        pivot.visible = !this.sectionClip; // no rotation-centre cross over the section camera
        this.dirty = true;
      }
      sky._driftClouds();
      look._stepScreens();
      look._stepSway();
      cam._stepOrbit();
      if (!this.dirty) return;
      this.dirty = false;
      this.stats.frames++;
      const t0 = this.onFrameTime ? performance.now() : 0;
      cam._updateDepth();
      sky._placeSkyBodies();
      this.labelRenderer.domElement.classList.toggle('compact', cam.pixelsPerMetre() < COMPACT_PPM);
      const ao = this.model ? look._ao : null, fin = this.model ? look._finish : null;
      if (ao || (fin && fin.needsDepth)) {
        if (!look._depthPass) look._depthPass = new DepthPrepass(this.renderer);
        const depth = look._depthPass.render(this.scene, this.camera, ao ? ao.settings.resolution : 0.5);
        if (ao) ao.begin(depth, this.camera);
        if (fin && fin.needsDepth) {
          this.camera.updateMatrixWorld();
          fin.setFocus(look._focusBox());
          fin.prepare(depth, this.camera);
        }
      }
      try {
        this.renderer.render(this.scene, this.camera);
      } finally {
        if (ao) ao.end();
      }
      if (fin) fin.apply();
      this.labelRenderer.render(this.scene, this.camera);
      if (this.onRender) this.onRender(); // e.g. the object popup follows its anchor
      if (this.onFrameTime) this.onFrameTime(performance.now() - t0);
    };
    this._raf = requestAnimationFrame(loop);
    this.occlusion._scheduleOcclusion(0);
  }

  setOnScreen(on) {
    this.onScreen = !!on;
    if (on) this.dirty = true;
  }

  stop() {
    this.skyLayer.weather.frameAt = 0;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.occlusion._cancelOcclusion(); // a detached card runs no passes
  }

  _removeCss(obj) {
    if (obj.parent) obj.parent.remove(obj);
    // removing the object does not reliably remove its DOM element
    if (obj.element && obj.element.parentNode) obj.element.parentNode.removeChild(obj.element);
  }

  _clearGroup(group) {
    group.traverse((o) => {
      if (o.isCSS2DObject && o.element && o.element.parentNode) o.element.parentNode.removeChild(o.element);
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    group.clear();
  }

  dispose() {
    this.stop();
    this.mower.setMowerChip(null);
    this._disposed = true;
    this.occlusion._cancelOcclusion();
    this.renderer.domElement.removeEventListener('wheel', this.cam._onWheel);
    this.cam.controls.dispose();
    this._clearGroup(this.staticGroup);
    this._clearGroup(this.markerGroup);
    this._clearGroup(this.glowGroup);
    this._clearGroup(this.overlayGroup);
    this.structure._disposeStems();
    this.cam.setPivotMarker(false);
    this.modelLayer._disposeModel();
    this.modelLayer._disposePreview();
    if (this.objectLayer) this.objectLayer.dispose();
    this.onObjectsInvalidate = null;
    this.look.dispose(); // ao, finish, depth pass
    this.mower.setMapOverlay(null);
    this.mower.setMowerWarning(null);
    this.skyLayer.dispose(); // sprites, room mask, rain / snow, compass ring
    this.markerObjects.clear();
    this.glows.clear();
    this.cssObjects = [];
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelRenderer.domElement.remove();
  }
}
