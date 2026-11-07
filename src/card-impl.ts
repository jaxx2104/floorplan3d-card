// floorplan3d-card-impl: the real card behind the floorplan3d-card shell (./floorplan3d-card.ts), which
// imports this module (and three.js with it) on first connect and forwards config and hass here.
// The element is a facade: lifecycle, render and the update diff live here, the rest in the parts
// under ./card/ (mower, model, views, markers, object input, actions, sky). Every member that the
// debug overlay or the headless checks use keeps its name on the card (delegates below).

import { Color } from "three";
import { FloorplanView } from "./view.ts";
import { logLayoutWarnings, parseLayout } from "./schema/layout.ts";
import { ObjectLayer } from "./objects/layer.ts";
import { TapHints } from "./objects/hints.ts";
import { DebugOverlay } from "./debug-overlay.ts";
import { ModelLoadUI, LOAD_STYLE } from "./load-ui.ts";
import { loadOutline, pickOutline } from "./load-outline.ts";
import { ObjectPopup } from "./objects/popup.ts";
import { TapSequencer } from "./actions.ts";
import { STYLE } from "./card/style.ts";
import { defineDelegates } from "./card/delegates.ts";
import { MowerController } from "./card/mower-controller.ts";
import { ModelLoader } from "./card/model-loader.ts";
import { ViewController } from "./card/view-controller.ts";
import { MarkerLayer } from "./card/marker-layer.ts";
import { ActionRunner } from "./card/action-runner.ts";
import { ObjectInput } from "./card/object-input.ts";
import { SkyController } from "./card/sky-controller.ts";
import { CardState, type CardSteps } from "./card/state.ts";
import { logConfigWarnings, parseCardConfig } from "./schema/config.ts";
import type { CardConfig, ResolvedCardConfig } from "./types/config.ts";
import type { Hass } from "./types/ha.ts";
import type { Layout } from "./types/layout.ts";
import type { LoadedModel, ModelOptions } from "./view/model.ts";
import type { ModelBindings } from "./card/model-loader.ts";

/** The card's colours from the HA theme (view.setTheme). */
export interface CardTheme {
  dark: boolean;
  primary: Color;
}

/** A main-thread long task (> 50 ms): start (performance.now ms) and duration. */
export interface LongTask {
  start: number;
  ms: number;
}

/** The info a ModelLoader load hands to _afterModel. */
export interface ModelLoadInfo {
  fresh: boolean;
  opts: ModelOptions | null;
  gen: number;
  prevModel: LoadedModel | null;
}

function cssColor(el: Element, name: string, fallback: string): Color {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  const c = new Color();
  try {
    // drop alpha from rgba() so three.js can parse it
    c.setStyle(
      (v || fallback).replace(
        /rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/,
        "rgb($1,$2,$3)",
      ),
    );
  } catch (e) {
    c.setStyle(fallback);
  }
  return c;
}

const luminance = (c: Color): number =>
  0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

// Delegated members (see the facade at the end): the names per part. The interface merged with the
// class below gives the card their types, taken from the part that owns them.
const MOWER_METHODS = [
  "_mowerFloor",
  "_refreshMower",
  "_mowerStateEntity",
  "_updateMowerWarning",
  "_warningText",
  "_dockGroup",
  "_dockedNow",
  "_mowerZ",
  "mapInfo",
] as const satisfies readonly (keyof MowerController)[];
const MOWER_FIELDS = [
  "_mowerLive",
  "_mowerOffline",
  "_warning",
] as const satisfies readonly (keyof MowerController)[];
const MODEL_METHODS = [
  "_loadModel",
  "_modelFresh",
  "_modelBytes",
  "_checkMergeKeep",
  "_modelAlign",
  "modelBindings",
] as const satisfies readonly (keyof ModelLoader)[];
const MODEL_FIELDS = [
  "_loadGen",
  "_modelEvicted",
  "_modelFromCache",
  "_modelSrc",
] as const satisfies readonly (keyof ModelLoader)[];
const VIEW_METHODS = [
  "_buildStructure",
  "_pickView",
  "_refreshViews",
  "_resolveViewList",
  "_stateFor",
  "currentView",
  "viewIndex",
  "_applyViewVisibility",
  "_applyMarkerStates",
  "_allRooms",
  "_setView",
  "_initialCamera",
  "_resetCamera",
  "_setFloor",
  "_setMode",
  "_armIdleReset",
  "saveViewPatch",
] as const satisfies readonly (keyof ViewController)[];
const VIEW_FIELDS = [
  "_fitted",
  "_floor",
  "_floorOnly",
  "_floors",
  "_idleTimer",
  "_levels",
  "_modelRooms",
  "_outlineModel",
  "_roomList",
  "_viewId",
  "_viewState",
  "_views",
  "_zones",
  "_index",
  "_mode",
] as const satisfies readonly (keyof ViewController)[];
const MARKER_METHODS = [
  "_buildMarkers",
  "_refreshStates",
  "badgeOpts",
  "_objectBadge",
  "_applyMarkerSelection",
  "_scheduleSurfaces",
  "_refreshAttached",
  "_syncMarkerMode",
  "_markerAt",
  "_markerRect",
  "_markerView",
  "_endMarkerGesture",
] as const satisfies readonly (keyof MarkerLayer)[];
const MARKER_FIELDS = [
  "_markers",
  "_faces",
  "_positions",
  "_mowerMarkerId",
  "_surf",
  "_surfJob",
] as const satisfies readonly (keyof MarkerLayer)[];
const ACTION_METHODS = [
  "_runAction",
  "_notify",
  "_moreInfo",
] as const satisfies readonly (keyof ActionRunner)[];
const OBJECT_METHODS = [
  "_syncBindings",
  "_tagIndex",
  "_updateObjects",
  "_objectHit",
  "_endGesture",
  "testObject",
  "_markerActions",
  "_runObjectAction",
  "_openObjectPopup",
  "_runMarkerAction",
  "objectLabel",
  "_syncHints",
] as const satisfies readonly (keyof ObjectInput)[];
const OBJECT_FIELDS = [
  "_bindings",
  "_boundEntities",
  "_groups",
] as const satisfies readonly (keyof ObjectInput)[];
const SKY_METHODS = [
  "_paintDayBtn",
  "_applySky",
  "_applyWeather",
  "_syncNightMarkers",
  "_wakeMarkers",
] as const satisfies readonly (keyof SkyController)[];
const SKY_FIELDS = [
  "_skyMode",
  "_sunNow",
  "_dayBtn",
] as const satisfies readonly (keyof SkyController)[];

type Names<T extends readonly string[]> = T[number];

// The delegated members on the card, typed as their parts declare them (the accessors are defined below
// by defineDelegates, so the declaration merging is intended).
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging
export interface Floorplan3dCard
  extends
    Pick<
      MowerController,
      Names<typeof MOWER_METHODS> | Names<typeof MOWER_FIELDS>
    >,
    Pick<ModelLoader, Names<typeof MODEL_METHODS> | Names<typeof MODEL_FIELDS>>,
    Pick<
      ViewController,
      Names<typeof VIEW_METHODS> | Names<typeof VIEW_FIELDS>
    >,
    Pick<
      MarkerLayer,
      Names<typeof MARKER_METHODS> | Names<typeof MARKER_FIELDS>
    >,
    Pick<ActionRunner, Names<typeof ACTION_METHODS>>,
    Pick<
      ObjectInput,
      Names<typeof OBJECT_METHODS> | Names<typeof OBJECT_FIELDS>
    >,
    Pick<SkyController, Names<typeof SKY_METHODS> | Names<typeof SKY_FIELDS>> {}

export class Floorplan3dCard extends HTMLElement {
  _mowerCtl: MowerController;
  _modelLoader: ModelLoader;
  _viewCtl: ViewController;
  _markerLayer: MarkerLayer;
  _actionRunner: ActionRunner;
  _objectInput: ObjectInput;
  _skyCtl: SkyController;
  /** The state flow: inputs as signals, the rebuild / refresh steps as effects (card/state.ts). */
  _state: CardState<ModelBindings>;
  _layoutReady: Promise<void>;
  /** The theme colours of the last applied HA theme (undefined until the first build). */
  _theme: CardTheme | undefined;
  _taps: TapSequencer;
  _objects: ObjectLayer | null;
  // Set later (declare: no own field until then). setConfig sets _config / _mode / _layout before the
  // card renders, _render the DOM parts and the view, the hass setter _hass: the members that use them
  // run after that (the ones that may run earlier check them).
  declare _layoutLoaded: () => void;
  declare _view: FloorplanView;
  declare _stage: HTMLDivElement;
  declare _body: HTMLDivElement;
  declare _chips: HTMLDivElement;
  declare _empty: HTMLDivElement;
  declare _notice: HTMLDivElement;
  declare _loadUI: ModelLoadUI;
  declare _popup: ObjectPopup;
  declare _hints: TapHints;
  declare _labelsTried: boolean | undefined;
  declare _debug: DebugOverlay | null | undefined;
  declare _ltObs: PerformanceObserver | null | undefined;
  declare _longs: LongTask[] | undefined;
  declare _ro: ResizeObserver | undefined;
  declare _io: IntersectionObserver | null | undefined;
  declare _onActivity: (() => void) | undefined;
  _haLayout: string | undefined = undefined;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    // the parts first: the delegated fields below live in them (and _syncToolbar may run before _render's end)
    this._mowerCtl = new MowerController(this);
    this._modelLoader = new ModelLoader(this);
    this._viewCtl = new ViewController(this);
    this._markerLayer = new MarkerLayer(this);
    this._actionRunner = new ActionRunner(this);
    this._objectInput = new ObjectInput(this);
    this._skyCtl = new SkyController(this);
    this._state = new CardState<ModelBindings>();
    this._state.connect(this._steps());
    this._theme = undefined;
    this._layoutReady = new Promise<void>((r) => {
      this._layoutLoaded = r;
    }); // resolves once the first config has given the layout
    this._taps = new TapSequencer(); // single vs double tap, per target
    this._objects = null; // ObjectLayer: model lamps and the real light pool
  }

  // The inputs of the state flow: reads are untracked (the card's own code), writes notify the graph.
  get _hass(): Hass {
    return this._state.hass.peek()!; // the members that run before the first hass check it
  }
  set _hass(h: Hass) {
    this._state.hass.value = h;
  }
  get _config(): ResolvedCardConfig {
    return this._state.config.peek()!; // set by setConfig before the card renders
  }
  set _config(c: ResolvedCardConfig) {
    this._state.config.value = c;
  }
  get _layout(): Layout | null {
    return this._state.layout.peek();
  }
  set _layout(l: Layout | null) {
    this._state.layout.value = l;
  }
  get _labels(): Record<string, { name: string }> | undefined {
    return this._state.labels.peek();
  }
  set _labels(v: Record<string, { name: string }> | undefined) {
    this._state.labels.value = v;
  }
  /** The model bindings now (derived: model, layout, HA floors and areas, config). */
  get _mb(): ModelBindings | null {
    return this._state.mb.peek();
  }
  /** Updates are waiting for their microtask (the headless checks wait for a settled card). */
  get _pending(): boolean {
    return this._state.pending();
  }

  // What the state flow runs (card/state.ts decides when).
  _steps(): CardSteps<ModelBindings> {
    return {
      applyTheme: () => this._applyTheme(),
      modelBindings: () => this.modelBindings(),
      modelKey: (mb) =>
        mb ? JSON.stringify([mb.levels, mb.rooms, this._modelAlign()]) : "",
      resolveViews: (mb) => this._resolveViewList(mb),
      checkMergeKeep: () => this._checkMergeKeep(),
      buildStructure: (mb, viewsChanged) =>
        this._buildStructure(mb, viewsChanged),
      refreshViews: () => this._refreshViews(),
      syncBindings: () => this._syncBindings(),
      buildMarkers: () => this._buildMarkers(),
      loadModel: () => this._loadModel(),
      mowerConfig: (m) => this._mowerCtl.configChanged(m),
      refreshStates: () => {
        this._refreshStates();
        this._refreshMower();
      },
      tail: () => {
        this._updateObjects();
        this._popup.update();
      },
    };
  }

  setConfig(config: CardConfig): void {
    const parsed = parseCardConfig(config);
    logConfigWarnings(parsed);
    this._config = parsed.value;
    this._mode = this._config.view === "top" ? "top" : "3d";
    this._applyHeight();
    // the layout is part of the YAML: a new config gives a new one
    const p = parseLayout(this._config.layout);
    logLayoutWarnings("card YAML layout:", p);
    this._layout = p.value;
    this._layoutLoaded();
    if (this.isConnected && !this._view) this.connectedCallback();
    else if (this._view) {
      this._view.setRenderOption(this._config.render);
      this._view.setBackground(this._config.background);
      this._view.setFurniture(this._config.furniture);
      this._view.setBokeh(this._config.bokeh);
      this._view.setGrade(this._config.grade);
      this._view.setSway(this._config.sway);
      this._view.setMaxFps(this._config.max_fps);
      this._view.setSurroundLight(this._config.surround_light);
      this._view.setCityLights(this._config.city_lights);
      if (this._view.model) this._applySky(true); // sky_bodies
      this._skyCtl.resetWeather(); // option weather may have changed
      this._applyWeather();
      this._loadModel();
      this._updateObjects(); // lights: auto | off
      this._syncDebug();
      if (this._idleTimer) this._armIdleReset(); // idle_reset may have changed
      this._syncNightMarkers(); // night_markers may have changed
    }
  }

  // debug: true -> the performance overlay
  _syncDebug(): void {
    const on =
      !!(this._config && this._config.debug) &&
      !!this._view &&
      this.isConnected;
    if (on && !this._debug)
      this._debug = new DebugOverlay(this._stage, this._view, this);
    else if (!on && this._debug) {
      this._debug.dispose();
      this._debug = null;
    }
  }

  // Main-thread long tasks (> 50 ms) of the last minute, where the browser reports them: the adaptive
  // map throttle and the debug overlay. -> [{ start, ms }] | null (not supported)
  _observeLongTasks(): void {
    if (this._ltObs || typeof PerformanceObserver !== "function") return;
    const types = PerformanceObserver.supportedEntryTypes || [];
    if (!types.includes("longtask")) return;
    const longs = (this._longs = this._longs || []);
    try {
      this._ltObs = new PerformanceObserver((list) => {
        const now = performance.now();
        for (const e of list.getEntries())
          longs.push({ start: e.startTime, ms: e.duration });
        while (longs.length && now - longs[0].start > 60000) longs.shift();
      });
      this._ltObs.observe({ type: "longtask" });
    } catch (e) {
      this._ltObs = null;
    }
  }

  longTasks(): LongTask[] | null {
    return this._ltObs ? this._longs || [] : null;
  }

  getCardSize(): number {
    return Math.ceil(parseInt(this._config?.height as string, 10) / 50) || 10; // NaN (no config) -> 10
  }

  /** HA's layout of the card's place (the shell forwards it): "grid" in a sections view. */
  get layout(): string | undefined {
    return this._haLayout;
  }

  set layout(v: string | undefined) {
    this._haLayout = v;
    this._applyHeight();
  }

  // A grid cell (sections view) gives the card its size: fill it. Elsewhere `height`.
  _applyHeight(): void {
    const grid = this._haLayout === "grid";
    this.toggleAttribute("grid", grid);
    this.style.height = grid ? "100%" : "";
    if (!this._stage || !this._config) return;
    const h = grid ? "100%" : this._config.height;
    this._stage.style.height = h;
    this._body.style.setProperty("--fp-height", h);
  }

  set hass(hass: Hass) {
    this._hass = hass;
    this._fetchLabels(hass);
    if (this._view && this._view.model && this._skyMode === "auto")
      this._applySky(false);
    this._applyWeather();
    if (this._view) this._view.setScreenStates(hass.states); // fp_anim screens follow their entities
  }

  get hass(): Hass {
    return this._hass;
  }

  // hass.labels is missing on some HA versions: ask the label registry once (non-admins may be refused), cache the names.
  _fetchLabels(hass: Hass): void {
    if (hass.labels || this._labelsTried || typeof hass.callWS !== "function")
      return;
    this._labelsTried = true;
    Promise.resolve()
      .then(() => hass.callWS<unknown>({ type: "config/label_registry/list" }))
      .then((list) => {
        if (!Array.isArray(list)) return;
        const out: Record<string, { name: string }> = {};
        for (const l of list as ({ label_id?: string; name: string } | null)[])
          if (l && l.label_id) out[l.label_id] = { name: l.name };
        this._objectInput.resetBindKey();
        this._labels = out;
      })
      .catch(() => {});
  }

  connectedCallback(): void {
    if (!this._config) return; // setConfig renders once it arrives
    if (!this._view) this._render();
    this._view.start();
    this._skyCtl.resume(); // moon timer, back-on-the-tab listener
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this._stage);
    // clouds drift only while the card is on screen
    if (this._io) this._io.disconnect();
    this._io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((es) => {
            const e = es[es.length - 1];
            if (e && this._view) this._view.setOnScreen(e.isIntersecting);
          })
        : null;
    if (this._io) this._io.observe(this);
    this._syncDebug();
    this._observeLongTasks();
    this._state.reconnects.value = this._state.reconnects.peek() + 1;
    this._scheduleSurfaces();
    // idle_reset: any touch, wheel or key on the card restarts the countdown
    if (!this._onActivity)
      this._onActivity = () => {
        this._armIdleReset();
        this._wakeMarkers();
      };
    const onActivity = this._onActivity;
    for (const t of ["pointerdown", "wheel", "keydown"])
      this.addEventListener(t, onActivity, { capture: true, passive: true });
    this._armIdleReset(); // counting from when the card is shown, so an untouched tablet starts turning too
  }

  disconnectedCallback(): void {
    const onActivity = this._onActivity;
    for (const t of ["pointerdown", "wheel", "keydown"])
      if (onActivity)
        this.removeEventListener(t, onActivity, { capture: true });
    this._viewCtl.dispose(); // idle reset timer
    if (this._view) this._view.stop();
    if (this._loadUI) this._loadUI.dispose();
    this._objectInput.dispose(); // gesture, hint touch timer, hover frame
    this._taps.cancel();
    if (this._popup) this._popup.close(); // window listeners
    if (this._ro) this._ro.disconnect();
    if (this._io) {
      this._io.disconnect();
      this._io = null;
    }
    this._skyCtl.dispose(); // wake and moon timers
    this._mowerCtl.dispose(); // stuck timer, warning pulse
    if (this._debug) {
      this._debug.dispose();
      this._debug = null;
    }
    if (this._ltObs) {
      this._ltObs.disconnect();
      this._ltObs = null;
    }
    this._markerLayer.dispose(); // surface job
  }

  _render(): void {
    const root = this.shadowRoot!; // attached in the constructor
    root.innerHTML = `<style>${STYLE}${LOAD_STYLE}</style>
      <ha-card>
        <div class="body">
          <div class="stage">
            <div class="toolbar">
              <div class="chips"></div>
              <div class="seg"><button data-mode="3d">3D</button><button data-mode="top">Top</button></div>
              <button class="reset" title="Reset view"><ha-icon icon="mdi:crosshairs-gps"></ha-icon></button>
              <button class="daynight" hidden title="Day / night: auto"><ha-icon icon="mdi:theme-light-dark"></ha-icon></button>
            </div>
            <div class="empty" hidden></div>
            <div class="notice" hidden></div>
          </div>
        </div>
      </ha-card>`;
    // the elements of the markup above (always there)
    const q = <E extends Element>(sel: string): E =>
      root.querySelector<E>(sel)!;
    this._stage = q<HTMLDivElement>(".stage");
    this._body = q<HTMLDivElement>(".body");
    this._applyHeight();
    this._chips = q<HTMLDivElement>(".chips");
    this._empty = q<HTMLDivElement>(".empty");
    this._notice = q<HTMLDivElement>(".notice");
    q<HTMLDivElement>(".seg").addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const mode = t.dataset && t.dataset.mode;
      if (mode) this._setMode(mode as "3d" | "top"); // the buttons' data-mode
    });
    this._chips.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const id = t.dataset && t.dataset.view;
      if (id) this._setView(id);
    });
    q<HTMLButtonElement>("button.reset").addEventListener("click", () =>
      this._resetCamera(),
    );
    this._skyCtl.wire(root); // Day / night button
    this._view = new FloorplanView(this._stage);
    this._loadUI = new ModelLoadUI({
      stage: this._stage,
      controls: () => this._view && this._view.controls,
      // the last loaded model's rooms of this layout, else the drawn rooms (null: the house fallback)
      outline: () => {
        if (!this._config) return null;
        const saved = loadOutline(this._config.model || "default");
        if (saved) return saved;
        const drawn = pickOutline((this._layout && this._layout.rooms) || []);
        return drawn.length ? drawn : null;
      },
    });
    const objects = (this._objects = new ObjectLayer(this._view));
    this._view.onObjectsInvalidate = () => this._objectInput._updateObjects(); // view, section or placement changed
    this._popup = new ObjectPopup(this._stage, {
      onLink: (action: Parameters<ActionRunner["_runAction"]>[0]) =>
        this._runAction(action, {}),
      project: (w: Parameters<FloorplanView["projectWorld"]>[0]) =>
        this._view.projectWorld(w),
      anchor: (id: string) => objects.anchorOf(id),
      resolve: (id: string) => this._objectInput.popupResolve(id),
    });
    this._hints = new TapHints(this._view.objectsGroup);
    this._hints.setPixelRatio(this._view.renderer.getPixelRatio());
    this._view.onRender = () => {
      this._popup.position();
      this._objectInput._hintsNear();
    };
    this._view.setRenderOption(this._config.render);
    this._view.setBackground(this._config.background);
    this._view.setFurniture(this._config.furniture);
    this._view.setBokeh(this._config.bokeh);
    this._view.setGrade(this._config.grade);
    this._view.setSway(this._config.sway);
    this._view.setMaxFps(this._config.max_fps);
    this._view.setSurroundLight(this._config.surround_light);
    this._view.setCityLights(this._config.city_lights);
    this._view.onPixelRatio = (pr: number) => this._hints.setPixelRatio(pr);
    this._view.setMode(this._mode);
    this._loadModel();
    const canvas = this._view.renderer.domElement;
    this._objectInput.wire(this._stage, canvas); // object taps, tap hints, hover
    this._markerLayer.wire(this._stage, canvas); // marker taps / holds, hover (after the objects)
    this._syncToolbar();
    this._state.rendered.value = true;
  }

  // A model load finished (ModelLoader._loadModel; err: its message, '' / undefined when fine): the
  // card rebuilds around the model that is there now.
  _afterModel(
    err: string | null | undefined,
    { fresh, opts, gen, prevModel }: ModelLoadInfo,
  ): void {
    if ((fresh || err || !opts) && gen === (this._loadGen || 0))
      this._loadUI.done(!!this._view.model && !err, err || "");
    if (this._view.model !== prevModel) {
      this._endGesture();
      this._popup.close();
    }
    this._objects!.setModel(this._view.model); // created with the view, before any model load
    // bind now: lamps light and bound markers hide without waiting for the next hass push
    if (this._hass && this._layout && this._floors && this._syncBindings()) {
      this._buildMarkers();
      this._refreshStates();
    }
    this._updateObjects();
    this._refreshAttached(); // the model (re)placed: attached markers follow their objects
    this._updateMowerWarning(); // the ground under the mower changed
    this._scheduleSurfaces(); // auto-placed markers onto (or off) the model's surfaces
    this._notice.textContent = err || "";
    this._notice.hidden = !err;
    // a new model resets the views; the first view applied frames it (see _resolveViewList)
    this._stage.classList.toggle("has-model", !!this._view.model);
    if (this._view.model) {
      this._applySky(true);
      this._applyWeather();
    } else this._skyCtl.resetDay(); // no model: the toggle is hidden, so always day
    this._syncToolbar();
    this._state.model.value = this._view.model; // the manifest arrived: rebuild
    this._schedule();
  }

  _resize(): void {
    const r = this._stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this._view.resize(r.width, r.height);
    if (!this._fitted && this._roomList) this._initialCamera();
  }

  // Something the state flow cannot see changed (e.g. a merged model tree): run the per-update steps again.
  _schedule(): void {
    this._state.schedule();
  }

  _applyTheme(): void {
    const bg = cssColor(this, "--card-background-color", "#ffffff");
    const dark =
      this._hass.themes && typeof this._hass.themes.darkMode === "boolean"
        ? this._hass.themes.darkMode
        : luminance(bg) < 0.4;
    const theme: CardTheme = (this._theme = {
      dark,
      primary: cssColor(this, "--primary-color", "#03a9f4"),
    });
    this._view.setTheme(theme);
  }

  _syncToolbar(): void {
    const hasModel = !!(this._view && this._view.model);
    // without a model: one chip per floor plus All, shown with 2+ floors
    const views = this._views.filter((v) => !v.hidden);
    const show = hasModel
      ? views.length > 1
      : this._views.filter((v) => !v.hidden && v.id !== "all").length > 1;
    this._chips.innerHTML = "";
    if (show) {
      for (const v of views) {
        const btn = document.createElement("button");
        btn.className =
          "chip" + (v.id === this._viewId && !this._floorOnly ? " on" : "");
        btn.dataset.view = v.id;
        btn.textContent = v.label;
        this._chips.append(btn);
      }
    }
    for (const btn of this.shadowRoot!.querySelectorAll<HTMLButtonElement>(
      ".seg button",
    ))
      btn.classList.toggle("on", btn.dataset.mode === this._mode);
    this._dayBtn!.hidden = !(this._view && this._view.model); // wired by _render first
    this._paintDayBtn();
  }
}

// The facade: members used outside their part (the debug overlay, headless checks, the other
// parts) keep their names on the card. Fields forward get / set, so the same objects come back.
const proto = Floorplan3dCard.prototype;
defineDelegates<MowerController>(proto, "_mowerCtl", {
  methods: MOWER_METHODS,
  fields: MOWER_FIELDS,
});
defineDelegates<ModelLoader>(proto, "_modelLoader", {
  methods: MODEL_METHODS,
  fields: MODEL_FIELDS,
});
defineDelegates<ViewController>(proto, "_viewCtl", {
  methods: VIEW_METHODS,
  fields: VIEW_FIELDS,
});
defineDelegates<MarkerLayer>(proto, "_markerLayer", {
  methods: MARKER_METHODS,
  fields: MARKER_FIELDS,
});
defineDelegates<ActionRunner>(proto, "_actionRunner", {
  methods: ACTION_METHODS,
});
defineDelegates<ObjectInput>(proto, "_objectInput", {
  methods: OBJECT_METHODS,
  fields: OBJECT_FIELDS,
});
defineDelegates<SkyController>(proto, "_skyCtl", {
  methods: SKY_METHODS,
  fields: SKY_FIELDS,
});

declare global {
  interface HTMLElementTagNameMap {
    "floorplan3d-card-impl": Floorplan3dCard;
  }
}

if (!customElements.get("floorplan3d-card-impl"))
  customElements.define("floorplan3d-card-impl", Floorplan3dCard);
