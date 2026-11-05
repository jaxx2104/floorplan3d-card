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

import * as THREE from "three";
import {
  CSS2DRenderer,
  type CSS2DObject,
} from "three/addons/renderers/CSS2DRenderer.js";
import { levelVisible, type LevelAssign } from "./bindings.ts";
import { DepthPrepass } from "./depth-pass.ts";
import {
  testMode,
  isCss2d,
  isMesh,
  meshMaterials,
  type CssEntry,
  type Drawable,
  type GlowEntry,
  type MarkerEntry,
  type MarkerState,
  type ViewCamera,
  type ViewRoom,
  type ViewTheme,
} from "./view/core.ts";
import { CameraRig } from "./view/camera.ts";
import {
  ModelLayer,
  type LoadedModel,
  type ModelVisibility,
} from "./view/model.ts";
import { RenderLook } from "./view/look.ts";
import { SkyLayer } from "./view/sky.ts";
import { PlanStructure } from "./view/structure.ts";
import { MowerLayer } from "./view/mower-layer.ts";
import { MarkerOcclusion } from "./view/occlusion.ts";
import { StillTrace } from "./view/still.ts";
import type { ObjectLayer } from "./objects/layer.ts";
import type { Floor, Vec3 } from "./types/layout.ts";

export { planToWorld, testMode, frameInterval } from "./view/core.ts";
export { fallbackOutline, mergeStaticMeshes } from "./view/model.ts";
export { drawMoon } from "./view/sky.ts";
export { orbitStep } from "./view/camera.ts";

const COMPACT_PPM = 30;
const PICK_LINE_M = 0.02; // raycast threshold for lines / points (three's default is 1 m)

/** Counters for the headless checks. */
export interface ViewStats {
  occPasses: number;
  occPartial: number;
  occDone: number; // full occlusion passes finished
  shadow: number;
  frames: number;
  shadowLights: number; // per-light shadow map redraws requested
  cloudFrames: number;
  envBuilds: number; // environment maps built from the sky (render quality 'high')
  bloomPasses: number; // frames with a selective bloom pass (render quality 'high', an emissive surface in view)
  contactBuilds: number; // contact shadow rebuilds (render quality 'high', the shadow casters changed)
  probeCaptures: number; // room light probe captures (render quality 'high', one room a frame while a pass runs)
  materialSwaps: number; // model materials upgraded to physical or restored (render quality 'high', look changes)
  stillSessions: number; // idle path tracing sessions started (render quality 'still')
  stillSteps: number; // path traced tiles drawn (render quality 'still', one an idle frame while a session traces)
  stillDraws: number; // traced images drawn over the raster frame (render quality 'still', from the fade's start)
  stillBuilds: number; // path tracer scene builds (render quality 'still', the model or its visible geometry changed)
  mapUploads?: number;
}

/** Processed mower map picture (onMapImage): a canvas to draw, null = as loaded, undefined = keep what is shown. */
export type MapImageResult =
  | {
      canvas: HTMLCanvasElement | OffscreenCanvas;
      width: number;
      height: number;
    }
  | null
  | undefined;

// facade parameter types, taken from the parts that own them
type Args<F> = F extends (...a: infer A) => unknown ? A : never;
type CamArgs<K extends keyof CameraRig> = Args<CameraRig[K]>;
type ModelArgs<K extends keyof ModelLayer> = Args<ModelLayer[K]>;
type LookArgs<K extends keyof RenderLook> = Args<RenderLook[K]>;
type SkyArgs<K extends keyof SkyLayer> = Args<SkyLayer[K]>;
type StructureArgs<K extends keyof PlanStructure> = Args<PlanStructure[K]>;
type MowerArgs<K extends keyof MowerLayer> = Args<MowerLayer[K]>;

export class FloorplanView {
  container: HTMLElement;
  scene: THREE.Scene;
  /** test mode: { drift } (checks of the cloud drift turn it back on); null in real use */
  test: { drift: boolean } | null;
  renderer: THREE.WebGLRenderer;
  look: RenderLook;
  cam: CameraRig;
  modelLayer: ModelLayer;
  skyLayer: SkyLayer;
  structure: PlanStructure;
  mower: MowerLayer;
  occlusion: MarkerOcclusion;
  /** idle path tracing (render quality 'still') */
  still: StillTrace;
  labelRenderer: CSS2DRenderer;
  persp: THREE.PerspectiveCamera;
  ortho: THREE.OrthographicCamera;
  mode: "3d" | "top";
  camera: ViewCamera;
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  moonLight: THREE.DirectionalLight;
  skyGroup: THREE.Group;
  onScreen: boolean;
  staticGroup: THREE.Group;
  markerGroup: THREE.Group;
  glowGroup: THREE.Group;
  overlayGroup: THREE.Group;
  mowerGroup: THREE.Group;
  stemGroup: THREE.Group;
  onMapImage:
    | ((
        image: CanvasImageSource,
        width: number,
        height: number,
      ) => MapImageResult | Promise<MapImageResult>)
    | null;
  onMapReprocess: (() => void) | null;
  modelGroup: THREE.Group;
  objectsGroup: THREE.Group;
  onRender: (() => void) | null;
  onPixelRatio: ((pr: number) => void) | null;
  onFrameTime: ((ms: number) => void) | null;
  onTick: ((ts: number) => void) | null;
  objectLayer: ObjectLayer | null;
  onObjectsInvalidate: (() => void) | null;
  model: LoadedModel | null;
  modelLevels: Record<string, LevelAssign> | null;
  _modelVisibility: ModelVisibility | null;
  modelClip: THREE.Plane;
  sectionClip: THREE.Plane | null;
  raycaster: THREE.Raycaster;
  mowerMarkerId: string | null;
  mowerOnFloor: boolean;
  _occSig: string | null;
  _shadowSig: string | null;
  stats: ViewStats;
  floors: Floor[];
  _rooms: ViewRoom[] | null;
  visibleFloor: string;
  _visibleSet: Set<string> | null;
  _markerStates: Map<string, MarkerState> | null;
  _cutOverride: number | null | undefined;
  cssObjects: CssEntry[];
  markerObjects: Map<string, MarkerEntry>;
  glows: Map<string, GlowEntry>;
  theme: ViewTheme;
  wallHeight: number;
  size: { w: number; h: number };
  dirty: boolean;
  _raf: number | null;
  _disposed: boolean;
  _maxFps: number | null;

  constructor(container: HTMLElement) {
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
    this.still = new StillTrace(this);
    this.renderer.setPixelRatio(this.look._pixelRatio());
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.localClippingEnabled = true; // model cut-away
    this.labelRenderer = new CSS2DRenderer();
    Object.assign(this.labelRenderer.domElement.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      isolation: "isolate",
    }); // own stacking context: label z-indexes stay under the popup
    container.append(this.renderer.domElement, this.labelRenderer.domElement);

    this.persp = new THREE.PerspectiveCamera(35, 1, 0.3, 500);
    this.ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 500);
    this.ortho.up.set(0, 0, -1); // north up when looking straight down
    this.mode = "3d";
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
    this.scene.add(
      this.staticGroup,
      this.mowerGroup,
      this.glowGroup,
      this.markerGroup,
      this.overlayGroup,
      this.stemGroup,
    );
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
    this.stats = {
      occPasses: 0,
      occPartial: 0,
      occDone: 0,
      shadow: 0,
      frames: 0,
      shadowLights: 0,
      cloudFrames: 0,
      envBuilds: 0,
      bloomPasses: 0,
      contactBuilds: 0,
      probeCaptures: 0,
      materialSwaps: 0,
      stillSessions: 0,
      stillSteps: 0,
      stillDraws: 0,
      stillBuilds: 0,
    }; // counters for the headless checks (occDone: full passes finished; shadowLights: per-light map redraws requested)

    this.floors = [];
    this._rooms = null; // [{ room, floorId, label }] of setStructure
    this.visibleFloor = "all";
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
    this.renderer.domElement.addEventListener("wheel", this.cam._onWheel, {
      passive: true,
    });
    this.cam._makeControls();
  }

  // --- facade: fields owned by the parts (same objects, so identity checks keep working) ---

  get controls() {
    return this.cam.controls;
  }
  set controls(v) {
    this.cam.controls = v;
  }
  get pivotMarker() {
    return this.cam.pivotMarker;
  }
  set pivotMarker(v) {
    this.cam.pivotMarker = v;
  }
  get _tween() {
    return this.cam._tween;
  }
  set _tween(v) {
    this.cam._tween = v;
  }
  get _framed() {
    return this.cam._framed;
  }
  set _framed(v) {
    this.cam._framed = v;
  }
  // The 3D camera before switching to Top (null until then).
  get lastCamera3d() {
    return this.cam.lastCamera3d;
  }

  get mergeStats() {
    return this.modelLayer.mergeStats;
  }
  set mergeStats(v) {
    this.modelLayer.mergeStats = v;
  }
  get pickHelper() {
    return this.modelLayer.pickHelper;
  }
  set pickHelper(v) {
    this.modelLayer.pickHelper = v;
  }
  get _preview() {
    return this.modelLayer._preview;
  }
  set _preview(v) {
    this.modelLayer._preview = v;
  }
  get _previewRing() {
    return this.modelLayer._previewRing;
  }
  set _previewRing(v) {
    this.modelLayer._previewRing = v;
  }
  get _previewFace() {
    return this.modelLayer._previewFace;
  }
  set _previewFace(v) {
    this.modelLayer._previewFace = v;
  }
  get _surfMeshes() {
    return this.modelLayer._surfMeshes;
  }
  set _surfMeshes(v) {
    this.modelLayer._surfMeshes = v;
  }

  get render() {
    return this.look.render;
  }
  set render(v) {
    this.look.render = v;
  }
  get renderFrom() {
    return this.look.renderFrom;
  }
  set renderFrom(v) {
    this.look.renderFrom = v;
  }
  get sky() {
    return this.look.sky;
  }
  set sky(v) {
    this.look.sky = v;
  }
  get _dome() {
    return this.look._dome;
  }
  set _dome(v) {
    this.look._dome = v;
  }
  get _sunStale() {
    return this.look._sunStale;
  }
  set _sunStale(v) {
    this.look._sunStale = v;
  }

  get skySprites() {
    return this.skyLayer.skySprites;
  }
  set skySprites(v) {
    this.skyLayer.skySprites = v;
  }
  get skyRing() {
    return this.skyLayer.skyRing;
  }
  set skyRing(v) {
    this.skyLayer.skyRing = v;
  }
  get weather() {
    return this.skyLayer.weather;
  }
  set weather(v) {
    this.skyLayer.weather = v;
  }
  get _cloudU() {
    return this.skyLayer._cloudU;
  }
  set _cloudU(v) {
    this.skyLayer._cloudU = v;
  }
  get _precip() {
    return this.skyLayer._precip;
  }
  set _precip(v) {
    this.skyLayer._precip = v;
  }

  get stems() {
    return this.structure.stems;
  }
  set stems(v) {
    this.structure.stems = v;
  }

  get mapPlane() {
    return this.mower.mapPlane;
  }
  set mapPlane(v) {
    this.mower.mapPlane = v;
  }
  get warning() {
    return this.mower.warning;
  }
  set warning(v) {
    this.mower.warning = v;
  }
  get _ground() {
    return this.mower._ground;
  }
  set _ground(v) {
    this.mower._ground = v;
  }
  get _mowerGround() {
    return this.mower._mowerGround;
  }
  set _mowerGround(v) {
    this.mower._mowerGround = v;
  }

  get _occTimer() {
    return this.occlusion._occTimer;
  }
  set _occTimer(v) {
    this.occlusion._occTimer = v;
  }
  get _occFull() {
    return this.occlusion._occFull;
  }
  set _occFull(v) {
    this.occlusion._occFull = v;
  }

  // --- facade: camera (camera.js) ---

  setZoomTo(mode: CamArgs<"setZoomTo">[0]) {
    return this.cam.setZoomTo(mode);
  }
  pivotPoint(
    clientX: CamArgs<"pivotPoint">[0],
    clientY: CamArgs<"pivotPoint">[1],
    y?: CamArgs<"pivotPoint">[2],
  ) {
    return this.cam.pivotPoint(clientX, clientY, y);
  }
  setPivot(point: CamArgs<"setPivot">[0]) {
    return this.cam.setPivot(point);
  }
  setPivotMarker(on: CamArgs<"setPivotMarker">[0]) {
    return this.cam.setPivotMarker(on);
  }
  setControlsEnabled(on: CamArgs<"setControlsEnabled">[0]) {
    return this.cam.setControlsEnabled(on);
  }
  planPoint(
    clientX: CamArgs<"planPoint">[0],
    clientY: CamArgs<"planPoint">[1],
    height: CamArgs<"planPoint">[2],
  ) {
    return this.cam.planPoint(clientX, clientY, height);
  }
  mapHit(clientX: CamArgs<"mapHit">[0], clientY: CamArgs<"mapHit">[1]) {
    return this.cam.mapHit(clientX, clientY);
  }
  screenPoint(
    x: CamArgs<"screenPoint">[0],
    y: CamArgs<"screenPoint">[1],
    z: CamArgs<"screenPoint">[2],
    floorId: CamArgs<"screenPoint">[3],
  ) {
    return this.cam.screenPoint(x, y, z, floorId);
  }
  projectWorld(world: CamArgs<"projectWorld">[0]) {
    return this.cam.projectWorld(world);
  }
  getCamera() {
    return this.cam.getCamera();
  }
  getTopCamera() {
    return this.cam.getTopCamera();
  }
  setTopCamera(
    c: CamArgs<"setTopCamera">[0],
    opts?: CamArgs<"setTopCamera">[1],
  ) {
    return this.cam.setTopCamera(c, opts);
  }
  setCamera(cam: CamArgs<"setCamera">[0], opts?: CamArgs<"setCamera">[1]) {
    return this.cam.setCamera(cam, opts);
  }
  resetCamera(cam?: CamArgs<"resetCamera">[0]) {
    return this.cam.resetCamera(cam);
  }
  // the camera part moves the 3D camera through here, so a patched view._moveCamera sees every move
  _moveCamera(
    pos: CamArgs<"_moveCamera">[0],
    target: CamArgs<"_moveCamera">[1],
    instant?: CamArgs<"_moveCamera">[2],
  ) {
    return this.cam._moveCamera(pos, target, instant);
  }
  setMode(mode: CamArgs<"setMode">[0]) {
    return this.cam.setMode(mode);
  }
  fit(opts?: CamArgs<"fit">[0]) {
    return this.cam.fit(opts);
  }
  pixelsPerMetre() {
    return this.cam.pixelsPerMetre();
  }
  resize(w: CamArgs<"resize">[0], h: CamArgs<"resize">[1]) {
    return this.cam.resize(w, h);
  }
  startOrbit(speed: CamArgs<"startOrbit">[0]) {
    return this.cam.startOrbit(speed);
  }
  stopOrbit() {
    return this.cam.stopOrbit();
  }

  // --- facade: model (model.js) ---

  isModelLoaded(opts: ModelArgs<"isModelLoaded">[0]) {
    return this.modelLayer.isModelLoaded(opts);
  }
  isModelLoading(opts: ModelArgs<"isModelLoading">[0]) {
    return this.modelLayer.isModelLoading(opts);
  }
  setModel(opts: ModelArgs<"setModel">[0]) {
    return this.modelLayer.setModel(opts);
  }
  modelManifest() {
    return this.modelLayer.modelManifest();
  }
  setModelLevels(assign: ModelArgs<"setModelLevels">[0]) {
    return this.modelLayer.setModelLevels(assign);
  }
  pickModel(
    clientX: ModelArgs<"pickModel">[0],
    clientY: ModelArgs<"pickModel">[1],
  ) {
    return this.modelLayer.pickModel(clientX, clientY);
  }
  surfaceAt(
    clientX: ModelArgs<"surfaceAt">[0],
    clientY: ModelArgs<"surfaceAt">[1],
  ) {
    return this.modelLayer.surfaceAt(clientX, clientY);
  }
  surfaceRays(
    worldPoint: ModelArgs<"surfaceRays">[0],
    dirs: ModelArgs<"surfaceRays">[1],
    maxDist: ModelArgs<"surfaceRays">[2],
  ) {
    return this.modelLayer.surfaceRays(worldPoint, dirs, maxDist);
  }
  setSurfacePreview(p: ModelArgs<"setSurfacePreview">[0]) {
    return this.modelLayer.setSurfacePreview(p);
  }
  highlightModelNode(node: ModelArgs<"highlightModelNode">[0]) {
    return this.modelLayer.highlightModelNode(node);
  }
  modelBox() {
    return this.modelLayer.modelBox();
  }
  sectionBox() {
    return this.modelLayer.sectionBox();
  }
  modelPlaneToWorld(plane: ModelArgs<"modelPlaneToWorld">[0]) {
    return this.modelLayer.modelPlaneToWorld(plane);
  }
  modelPointToWorld(p: ModelArgs<"modelPointToWorld">[0]) {
    return this.modelLayer.modelPointToWorld(p);
  }
  meshTriangles(mesh: ModelArgs<"meshTriangles">[0]) {
    return this.modelLayer.meshTriangles(mesh);
  }
  meshPlanRect(mesh: ModelArgs<"meshPlanRect">[0]) {
    return this.modelLayer.meshPlanRect(mesh);
  }
  isTagged() {
    return this.modelLayer.isTagged();
  }
  applyModelVisibility(
    index: ModelArgs<"applyModelVisibility">[0],
    flags: ModelArgs<"applyModelVisibility">[1],
  ) {
    return this.modelLayer.applyModelVisibility(index, flags);
  }

  // --- facade: render look (look.js) ---

  setRenderOption(opt: LookArgs<"setRenderOption">[0]) {
    return this.look.setRenderOption(opt);
  }
  shadowCap() {
    return this.look.shadowCap();
  }
  lampShadowCount() {
    return this.look.lampShadowCount();
  }
  setDaylight(day: LookArgs<"setDaylight">[0]) {
    return this.look.setDaylight(day);
  }
  setSky(sky?: LookArgs<"setSky">[0], opts?: LookArgs<"setSky">[1]) {
    return this.look.setSky(sky, opts);
  }
  setCityLights(opt: LookArgs<"setCityLights">[0]) {
    return this.look.setCityLights(opt);
  }
  setMaxFps(fps: LookArgs<"setMaxFps">[0]) {
    return this.look.setMaxFps(fps);
  }
  setSway(opt: LookArgs<"setSway">[0]) {
    return this.look.setSway(opt);
  }
  setSurroundLight(opt: LookArgs<"setSurroundLight">[0]) {
    return this.look.setSurroundLight(opt);
  }
  setAo(opt: LookArgs<"setAo">[0]) {
    return this.look.setAo(opt);
  }
  setBokeh(opt: LookArgs<"setBokeh">[0]) {
    return this.look.setBokeh(opt);
  }
  setGrade(opt: LookArgs<"setGrade">[0]) {
    return this.look.setGrade(opt);
  }
  setBackground(opt: LookArgs<"setBackground">[0]) {
    return this.look.setBackground(opt);
  }
  setFurniture(opt: LookArgs<"setFurniture">[0]) {
    return this.look.setFurniture(opt);
  }
  setScreenStates(states: LookArgs<"setScreenStates">[0]) {
    return this.look.setScreenStates(states);
  }
  _shadowDirty() {
    return this.look._shadowDirty();
  }
  requestShadowUpdate(lights: LookArgs<"requestShadowUpdate">[0]) {
    return this.look.requestShadowUpdate(lights);
  }

  // --- facade: sky and weather (view/sky.js) ---

  setSkyBodies(bodies?: SkyArgs<"setSkyBodies">[0]) {
    return this.skyLayer.setSkyBodies(bodies);
  }
  setWeather(w?: SkyArgs<"setWeather">[0]) {
    return this.skyLayer.setWeather(w);
  }
  _placeSkyBodies() {
    return this.skyLayer._placeSkyBodies();
  }
  _roomHull() {
    return this.skyLayer._roomHull();
  }
  _skyScreen(
    hulls: SkyArgs<"_skyScreen">[0],
    pos: SkyArgs<"_skyScreen">[1],
    radius: SkyArgs<"_skyScreen">[2],
  ) {
    return this.skyLayer._skyScreen(hulls, pos, radius);
  }

  // --- facade: plan structure (structure.js) ---

  setOverlay(o?: StructureArgs<"setOverlay">[0]) {
    return this.structure.setOverlay(o);
  }
  moveMarker(
    id: StructureArgs<"moveMarker">[0],
    x: StructureArgs<"moveMarker">[1],
    y: StructureArgs<"moveMarker">[2],
    z: StructureArgs<"moveMarker">[3],
    floorId: StructureArgs<"moveMarker">[4],
  ) {
    return this.structure.moveMarker(id, x, y, z, floorId);
  }
  setTheme(theme: StructureArgs<"setTheme">[0]) {
    return this.structure.setTheme(theme);
  }
  setStructure(
    floors: StructureArgs<"setStructure">[0],
    rooms: StructureArgs<"setStructure">[1],
    opts?: StructureArgs<"setStructure">[2],
  ) {
    return this.structure.setStructure(floors, rooms, opts);
  }
  setMarkers(markers: StructureArgs<"setMarkers">[0]) {
    return this.structure.setMarkers(markers);
  }
  setStems(on: StructureArgs<"setStems">[0]) {
    return this.structure.setStems(on);
  }
  setGlows(glows: StructureArgs<"setGlows">[0]) {
    return this.structure.setGlows(glows);
  }

  // --- facade: mower (mower-layer.js) ---

  groundAt(x: MowerArgs<"groundAt">[0], y: MowerArgs<"groundAt">[1]) {
    return this.mower.groundAt(x, y);
  }
  mowerGround(
    x: MowerArgs<"mowerGround">[0],
    y: MowerArgs<"mowerGround">[1],
    floorId: MowerArgs<"mowerGround">[2],
  ) {
    return this.mower.mowerGround(x, y, floorId);
  }
  _groundRay(x: MowerArgs<"_groundRay">[0], y: MowerArgs<"_groundRay">[1]) {
    return this.mower._groundRay(x, y);
  }
  setMapOverlay(o: MowerArgs<"setMapOverlay">[0]) {
    return this.mower.setMapOverlay(o);
  }
  setMapCanvas(
    canvas: MowerArgs<"setMapCanvas">[0],
    natW: MowerArgs<"setMapCanvas">[1],
    natH: MowerArgs<"setMapCanvas">[2],
    loaded?: MowerArgs<"setMapCanvas">[3],
  ) {
    return this.mower.setMapCanvas(canvas, natW, natH, loaded);
  }
  reprocessMap() {
    return this.mower.reprocessMap();
  }
  setMowerWarning(w: MowerArgs<"setMowerWarning">[0]) {
    return this.mower.setMowerWarning(w);
  }
  setMowerChip(c: MowerArgs<"setMowerChip">[0]) {
    return this.mower.setMowerChip(c);
  }
  setMowerTrack(t: MowerArgs<"setMowerTrack">[0]) {
    return this.mower.setMowerTrack(t);
  }
  warningWorld() {
    return this.mower.warningWorld();
  }

  // --- facade: occlusion (occlusion.js) ---

  setOcclusion(on: unknown) {
    return this.occlusion.setOcclusion(on);
  }
  pointHidden(world: THREE.Vector3, own?: THREE.Object3D | null) {
    return this.occlusion.pointHidden(world, own);
  }
  _scheduleOcclusion(delay?: number, id?: string | null) {
    return this.occlusion._scheduleOcclusion(delay, id);
  }

  // --- the view's own: visibility, section, render loop, lifecycle ---

  setVisibleFloor(id: string): void {
    this.setVisibleFloors(id === "all" ? "all" : [id]);
  }

  // ids: floor id array or 'all'. [] means 'none': all floor-bound markers/groups are hidden
  // (callers then set model flags + setCut). visibleFloor keeps the first id (or 'all') for existing callers.
  setVisibleFloors(ids: string[] | "all" | null | undefined): void {
    const list = ids === "all" || !Array.isArray(ids) ? null : ids;
    this._visibleSet = list ? new Set(list) : null;
    this.visibleFloor = list ? (list.length ? list[0] : "none") : "all";
    this._applyFloorVisibility();
    this.dirty = true;
  }

  // states: Map<markerId, {shown, faded}> or null (floor visibility rules). A marker (or glow)
  // whose id is missing from the map follows the floor rules.
  setMarkerStates(states: Map<string, MarkerState> | null | undefined): void {
    this._markerStates = states || null;
    this._applyFloorVisibility();
    this.dirty = true;
  }

  // Clip height override (metres, world); null = no cut; undefined = automatic.
  setCut(height: number | null | undefined): void {
    this._cutOverride = height;
    this._applyFloorVisibility();
    this.dirty = true;
  }

  // Side section: plane {normal, constant} (card world) clips everything (renderer.clippingPlanes);
  // model materials turn double-sided so cut walls read solid; markers and glows on the removed side
  // are hidden. null restores everything.
  setSection(
    plane: { normal: Vec3; constant: number } | null | undefined,
  ): void {
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
  _sectionMaterials(): void {
    if (!this.model) return;
    const on = !!this.sectionClip;
    this.model.root.traverse((o) => {
      if (!isMesh(o)) return;
      for (const mat of meshMaterials(o)) {
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

  _cutAway(pos: THREE.Vector3): boolean {
    return !!this.sectionClip && this.sectionClip.distanceToPoint(pos) < 0;
  }

  floorElevation(floorId: string | null | undefined): number {
    const f = this.floors.find((x) => x.id === floorId);
    return f ? f.elevation : 0;
  }

  _shows(floorId: string | null | undefined): boolean {
    return this._visibleSet
      ? this._visibleSet.has(floorId as string)
      : this.visibleFloor === "all" || this.visibleFloor === floorId;
  }

  _applyFloorVisibility(): void {
    for (const g of this.staticGroup.children)
      g.visible = this._shows(g.userData.floorId);
    // markers live in one group for all floors, so visibility is set per object
    const ms = this._markerStates;
    const stateOf = (id: string | undefined) =>
      ms && id !== undefined ? ms.get(id) : null;
    for (const c of this.cssObjects) c.obj.visible = this._markerVisible(c);
    for (const [id, g] of this.glows) g.mesh.visible = this._glowVisible(id, g);
    for (const [id, st] of this.structure.stems) {
      const m = this.markerObjects.get(id);
      const shown = !!(m && m.obj.visible);
      st.disc.visible = shown;
      st.line.visible = shown && st.line.userData.height > 0.01;
    }
    for (const o of this.overlayGroup.children)
      if (!isCss2d(o)) o.visible = this._shows(o.userData.floorId);
    if (this.mower.warning) this.mower._warningVisible();
    if (this.mower.mowerTrack)
      this.mower.mowerTrack.mesh.visible = this.mower._mowerShows(
        this.mower.mowerTrack.floorId,
      );
    if (this.mower.mowerChip)
      this.mower.mowerChip.obj.visible = this.mower._mowerShows(
        this.mower.mowerChip.floorId,
      );
    if (this.model) {
      const assign = this.modelLevels || {};
      if (!this._modelVisibility) {
        for (const l of this.model.manifest.levels)
          l.node.visible = levelVisible(
            assign[l.id],
            this.visibleFloor,
            (id: string | null) =>
              this.floors.find((f) => f.id === id)?.elevation,
          );
      }
      // everything above the cut-away height of the selected floor is clipped (roof, upper floors)
      // untagged: the top of the selected storey (wall_height is for drawn walls only)
      const vf = this.floors.find((f) => f.id === this.visibleFloor);
      const cut =
        this.visibleFloor === "all" || this.modelLayer.isTagged()
          ? 1e6
          : this.floorElevation(this.visibleFloor) + ((vf && vf.height) || 2.7);
      this.modelClip.constant =
        this._cutOverride === undefined ? cut : (this._cutOverride ?? 1e6);
      if (this.modelLayer.pickHelper) this.modelLayer.pickHelper.update();
    }
    // "top" = the highest floor that actually has markers (an empty attic must not fade everything)
    let top: string | null = null,
      topElev = -Infinity;
    for (const c of this.cssObjects) {
      if (c.kind !== "marker") continue;
      const e = this.floorElevation(c.floorId);
      if (e > topElev) {
        topElev = e;
        top = c.floorId;
      }
    }
    for (const c of this.cssObjects) {
      if (c.kind !== "marker") continue;
      const st = stateOf(c.id);
      c.obj.element.classList.toggle(
        "fp-faded",
        st
          ? !!st.faded
          : !!this.model && this.visibleFloor === "all" && c.floorId !== top,
      );
    }
    if (this.mower.mapPlane && this.mower.mapPlane.material.map)
      this.mower.mapPlane.visible = this.mower._mapShown(this.mower.mapPlane);
    // shadow map and occlusion only when their inputs changed (not on every state update)
    const model = this._modelSig();
    if (model !== this._shadowSig) {
      this._shadowSig = model;
      if (this.model) this.look._shadowDirty();
      this._objectsInvalid(); // lamps on hidden levels give their pool lights to visible ones
    }
    const occ = model + "|" + this.mode + "|" + this._shownMarkersSig();
    if (occ !== this._occSig) {
      this._occSig = occ;
      this.occlusion._scheduleOcclusion(0);
    }
  }

  // css object (marker, label, handle) visibility: marker state, else its floor; section cut
  _markerVisible(c: CssEntry): boolean {
    const st =
      c.kind === "marker" && this._markerStates && c.id !== undefined
        ? this._markerStates.get(c.id)
        : null;
    const floorRule =
      c.kind === "marker" && c.id === this.mowerMarkerId
        ? this.mower._mowerShows(c.floorId)
        : this._shows(c.floorId);
    return (
      (st ? !!st.shown : floorRule) &&
      !(c.kind !== "handle" && this._cutAway(c.obj.position))
    );
  }

  _glowVisible(id: string, g: GlowEntry): boolean {
    const st = this._markerStates ? this._markerStates.get(id) : null;
    return (
      (st ? !!st.shown : this._shows(g.floorId)) &&
      !this._cutAway(g.mesh.position)
    );
  }

  // What the shadow map depends on: the model, which of its nodes are shown, the cut, the section.
  _modelSig(): string {
    if (!this.model) return "";
    const mv = this._modelVisibility;
    const vis = mv
      ? mv.index.nodes.map((n) => (n.node.visible ? 1 : 0)).join("")
      : this.model.manifest.levels
          .map((l) => (l.node.visible ? 1 : 0))
          .join("");
    const s = this.sectionClip;
    return [
      this.model.id,
      vis,
      this.modelClip.constant,
      s
        ? [...s.normal.toArray(), s.constant].map((v) => v.toFixed(4)).join()
        : "",
    ].join("|");
  }

  // Shown markers and where they are (occlusion input).
  _shownMarkersSig(): string {
    const out: string[] = [];
    for (const c of this.cssObjects) {
      if (c.kind !== "marker" || !c.obj.visible) continue;
      const p = c.obj.position;
      out.push(`${c.id}@${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`);
    }
    return out.join(";");
  }

  _flagShadows(lights: THREE.Light[] | null | undefined): void {
    if (!lights || !lights.length) return;
    for (const l of lights) l.shadow!.needsUpdate = true; // only shadow-casting lights are passed
    this.renderer.shadowMap.needsUpdate = true;
    this.stats.shadowLights += lights.length;
  }

  markDirty(): void {
    this.dirty = true;
  }

  _objectsInvalid(): void {
    if (this.onObjectsInvalidate && this.model) this.onObjectsInvalidate();
  }

  // The frame into the drawing buffer: depth pre-pass (ao, finish), the scene, bloom, finish. count: a frame of the
  // loop (false: the 'still' tier drawing the frame on screen again to keep it under the trace).
  _drawGl(count: boolean): void {
    const look = this.look;
    const ao = this.model ? look._ao : null,
      fin = this.model ? look._finish : null;
    if (ao || (fin && fin.needsDepth)) {
      if (!look._depthPass) look._depthPass = new DepthPrepass(this.renderer);
      const depth = look._depthPass.render(
        this.scene,
        this.camera,
        ao ? ao.settings.resolution : 0.5,
      );
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
    const bloom = this.model ? look._bloom : null;
    if (bloom && bloom.render(this.scene, this.camera) && count)
      this.stats.bloomPasses++; // before the finish: it grades the bloom too
    if (fin) fin.apply();
  }

  start(): void {
    if (this._raf) return;
    const cam = this.cam,
      look = this.look,
      sky = this.skyLayer; // direct part refs on the per-frame path
    const loop = (ts: number) => {
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
      if (!this.dirty) {
        this.still.idle(performance.now());
        return;
      } // render quality 'still': trace once idle
      this.dirty = false;
      this.still.frameDrawn(performance.now()); // a traced image is replaced by this frame
      this.stats.frames++;
      const t0 = this.onFrameTime ? performance.now() : 0;
      cam._updateDepth();
      if (look._env && look._env.flush()) this.stats.envBuilds++; // a due sky environment (never more than one per ENV_THROTTLE_MS)
      sky._placeSkyBodies();
      if (look._updateContact()) this.stats.contactBuilds++; // the casters changed since the last frame (quality high)
      this.labelRenderer.domElement.classList.toggle(
        "compact",
        cam.pixelsPerMetre() < COMPACT_PPM,
      );
      this._drawGl(true);
      if (this.model && look.indirect.step()) this.stats.probeCaptures++; // a room's light probe, after the frame drew its shadow maps
      this.labelRenderer.render(this.scene, this.camera);
      if (this.onRender) this.onRender(); // e.g. the object popup follows its anchor
      if (this.onFrameTime) this.onFrameTime(performance.now() - t0);
    };
    this._raf = requestAnimationFrame(loop);
    this.occlusion._scheduleOcclusion(0);
  }

  setOnScreen(on: unknown): void {
    this.onScreen = !!on;
    if (on) this.dirty = true;
  }

  // Edit mode opened / closed (the card): the 'still' tier traces only outside it.
  setEditing(on: unknown): void {
    this.still.setEditing(!!on);
  }

  stop(): void {
    this.skyLayer.weather.frameAt = 0;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.occlusion._cancelOcclusion(); // a detached card runs no passes
  }

  _removeCss(obj: CSS2DObject): void {
    if (obj.parent) obj.parent.remove(obj);
    // removing the object does not reliably remove its DOM element
    if (obj.element && obj.element.parentNode)
      obj.element.parentNode.removeChild(obj.element);
  }

  _clearGroup(group: THREE.Object3D): void {
    group.traverse((obj) => {
      if (isCss2d(obj) && obj.element && obj.element.parentNode)
        obj.element.parentNode.removeChild(obj.element);
      const o = obj as Drawable;
      if (o.geometry) o.geometry.dispose();
      // a material array has no dispose (as before: it throws; the view never puts one in these groups)
      if (o.material) (o.material as THREE.Material).dispose();
    });
    group.clear();
  }

  dispose(): void {
    this.stop();
    this.mower.setMowerChip(null);
    this._disposed = true;
    this.occlusion._cancelOcclusion();
    this.renderer.domElement.removeEventListener("wheel", this.cam._onWheel);
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
    this.still.dispose(); // the path tracer
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
