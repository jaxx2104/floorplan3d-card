// floorplan3d-card: Home Assistant Lovelace card showing a 3D floorplan with auto-placed devices.
// The element is a facade: lifecycle, render and the update diff live here, the rest in the parts
// under ./card/ (mower, model, views, markers, object input, actions, sky). Every member that edit
// mode, the debug overlay or the headless checks use keeps its name on the card (delegates below).

import { Color } from 'three';
import { FloorplanView } from './view.js';
import { EditMode } from './edit-mode.js';
import './card-editor.js';
import { LayoutStore } from './storage.js';
import { registrySignature } from './registry.js';
import './mower-auto.js'; // registers the auto-mode kernel with the map worker
import { ObjectLayer } from './objects/layer.js';
import { TapHints } from './objects/hints.js';
import { DebugOverlay } from './debug-overlay.js';
import { ModelLoadUI, LOAD_STYLE } from './load-ui.js';
import { loadOutline, pickOutline } from './load-outline.js';
import { ObjectPopup } from './objects/popup.js';
import { TapSequencer } from './actions.js';
import { STYLE } from './card/style.js';
import { defineDelegates } from './card/delegates.js';
import { MowerController } from './card/mower-controller.js';
import { ModelLoader } from './card/model-loader.js';
import { ViewController } from './card/view-controller.js';
import { MarkerLayer } from './card/marker-layer.js';
import { ActionRunner } from './card/action-runner.js';
import { ObjectInput } from './card/object-input.js';
import { SkyController } from './card/sky-controller.js';

const VERSION = '0.0.0-dev';

function cssColor(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  const c = new Color();
  try {
    // drop alpha from rgba() so three.js can parse it
    c.setStyle((v || fallback).replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, 'rgb($1,$2,$3)'));
  } catch (e) {
    c.setStyle(fallback);
  }
  return c;
}

const luminance = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

class Floorplan3dCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    // the parts first: the delegated fields below live in them (and _syncToolbar may run before _render's end)
    this._mowerCtl = new MowerController(this);
    this._modelLoader = new ModelLoader(this);
    this._viewCtl = new ViewController(this);
    this._markerLayer = new MarkerLayer(this);
    this._actionRunner = new ActionRunner(this);
    this._objectInput = new ObjectInput(this);
    this._skyCtl = new SkyController(this);
    this._layout = null;
    this._layoutReady = new Promise((r) => { this._layoutLoaded = r; }); // resolves once the stored layout has loaded (or failed)
    this._built = {};
    this._taps = new TapSequencer(); // single vs double tap, per target
    this._objects = null; // ObjectLayer: model lamps and the real light pool
  }

  static getStubConfig() {
    return {};
  }

  // sections view: span the whole section by default
  getGridOptions() {
    return { columns: 'full', min_columns: 6, rows: 'auto' };
  }

  static getConfigElement() {
    return document.createElement('floorplan3d-card-editor');
  }

  setConfig(config) {
    this._config = { layout_key: 'default', height: '520px', group_by: 'device', wall_height: 1.0, view: '3d', ...config };
    this._mode = this._config.view === 'top' ? 'top' : '3d';
    this._store = new LayoutStore(this._config.layout_key);
    if (this._stage) {
      this._stage.style.height = this._config.height;
      this._body.style.setProperty('--fp-height', this._config.height);
    }
    if (this.isConnected && !this._view) this.connectedCallback();
    else if (this._view) {
      this._view.setOcclusion(this._config.occlusion !== false);
      this._view.setRenderOption(this._config.render);
      this._view.setBackground(this._config.background);
      this._view.setFurniture(this._config.furniture);
      this._view.setAo(this._config.ao);
      this._view.setBokeh(this._config.bokeh);
      this._view.setGrade(this._config.grade);
      this._view.setSway(this._config.sway);
      this._view.setMaxFps(this._config.max_fps);
      this._view.setSurroundLight(this._config.surround_light);
      this._view.setCityLights(this._config.city_lights);
      if (this._view.model) this._applySky(true); // sky_bodies
      this._skyCtl.resetWeather(); // option weather may have changed
      this._applyWeather();
      this._applyZoomTo();
      this._loadModel();
      this._updateObjects(); // lights: auto | off
      this._syncDebug();
      if (this._idleTimer) this._armIdleReset(); // idle_reset may have changed
      this._syncNightMarkers(); // night_markers may have changed
    }
  }

  // debug: true -> the performance overlay
  _syncDebug() {
    const on = !!(this._config && this._config.debug) && !!this._view && this.isConnected;
    if (on && !this._debug) this._debug = new DebugOverlay(this._stage, this._view, this);
    else if (!on && this._debug) { this._debug.dispose(); this._debug = null; }
  }

  // Main-thread long tasks (> 50 ms) of the last minute, where the browser reports them: the adaptive
  // map throttle and the debug overlay. -> [{ start, ms }] | null (not supported)
  _observeLongTasks() {
    if (this._ltObs || typeof PerformanceObserver !== 'function') return;
    const types = PerformanceObserver.supportedEntryTypes || [];
    if (!types.includes('longtask')) return;
    this._longs = this._longs || [];
    try {
      this._ltObs = new PerformanceObserver((list) => {
        const now = performance.now();
        for (const e of list.getEntries()) this._longs.push({ start: e.startTime, ms: e.duration });
        while (this._longs.length && now - this._longs[0].start > 60000) this._longs.shift();
      });
      this._ltObs.observe({ type: 'longtask' });
    } catch (e) {
      this._ltObs = null;
    }
  }

  longTasks() {
    return this._ltObs ? this._longs || [] : null;
  }

  getCardSize() {
    return Math.ceil(parseInt(this._config?.height, 10) / 50) || 10;
  }

  set hass(hass) {
    this._hass = hass;
    this._fetchLabels(hass);
    if (this._view && this._view.model && this._skyMode === 'auto') this._applySky(false);
    this._applyWeather();
    if (this._view) this._view.setScreenStates(hass.states); // fp_anim screens follow their entities
    if (!this._layout && !this._loading) this._load();
    this._schedule();
  }

  get hass() {
    return this._hass;
  }

  // hass.labels is missing on some HA versions: ask the label registry once (non-admins may be refused), cache the names.
  _fetchLabels(hass) {
    if (hass.labels || this._labelsTried || typeof hass.callWS !== 'function') return;
    this._labelsTried = true;
    Promise.resolve().then(() => hass.callWS({ type: 'config/label_registry/list' })).then((list) => {
      if (!Array.isArray(list)) return;
      const out = {};
      for (const l of list) if (l && l.label_id) out[l.label_id] = { name: l.name };
      this._labels = out;
      this._objectInput.resetBindKey();
      this._schedule();
    }).catch(() => {});
  }

  connectedCallback() {
    if (!this._config) return; // setConfig renders once it arrives
    if (!this._view) this._render();
    else if (this._editing) this._edit.attach();
    this._view.start();
    this._skyCtl.resume(); // moon timer, back-on-the-tab listener
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this._stage);
    // clouds drift only while the card is on screen
    if (this._io) this._io.disconnect();
    this._io = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((es) => { const e = es[es.length - 1]; if (e && this._view) this._view.setOnScreen(e.isIntersecting); }) : null;
    if (this._io) this._io.observe(this);
    this._syncDebug();
    this._observeLongTasks();
    // the map / image timers stopped on disconnect: re-arm them (refresh states and mower on the next update)
    this._mowerCtl.resume();
    if (this._built) this._built.states = undefined;
    this._schedule();
    this._scheduleSurfaces();
    // idle_reset: any touch, wheel or key on the card restarts the countdown
    if (!this._onActivity) this._onActivity = () => { this._armIdleReset(); this._wakeMarkers(); };
    for (const t of ['pointerdown', 'wheel', 'keydown']) this.addEventListener(t, this._onActivity, { capture: true, passive: true });
    this._armIdleReset(); // counting from when the card is shown, so an untouched tablet starts turning too
  }

  disconnectedCallback() {
    for (const t of ['pointerdown', 'wheel', 'keydown']) if (this._onActivity) this.removeEventListener(t, this._onActivity, { capture: true });
    if (this._view) this._view.stopOrbit();
    this._viewCtl.dispose(); // idle reset timer
    if (this._view) this._view.stop();
    if (this._loadUI) this._loadUI.dispose();
    this._objectInput.dispose(); // gesture, hint touch timer, hover frame
    this._taps.cancel();
    this._actionRunner.dispose(); // confirmation
    if (this._popup) this._popup.close(); // window listeners
    if (this._editing && this._edit) this._edit.detach(); // window listeners (keys, pick menu)
    if (this._ro) this._ro.disconnect();
    if (this._io) { this._io.disconnect(); this._io = null; }
    this._skyCtl.dispose(); // wake, moon, scrubber timers, visibility listener
    this._mowerCtl.dispose(); // stuck, camera, image, reprocess timers, the map worker
    if (this._debug) { this._debug.dispose(); this._debug = null; }
    if (this._ltObs) { this._ltObs.disconnect(); this._ltObs = null; }
    this._markerLayer.dispose(); // surface job
  }

  async _load() {
    this._loading = true;
    try {
      this._layout = await this._store.load(this._hass);
    } finally {
      this._loading = false;
      this._layoutLoaded();
    }
    this._schedule();
  }

  _render() {
    const root = this.shadowRoot;
    root.innerHTML = `<style>${STYLE}${LOAD_STYLE}</style>
      <ha-card>
        <div class="body">
          <div class="stage">
            <div class="toolbar">
              <div class="chips"></div>
              <div class="seg"><button data-mode="3d">3D</button><button data-mode="top">Top</button></div>
              <button class="reset" title="Reset view"><ha-icon icon="mdi:crosshairs-gps"></ha-icon></button>
              <button class="section" hidden title="Side section"><ha-icon icon="mdi:box-cutter"></ha-icon></button>
              <button class="daynight" hidden title="Day / night: auto"><ha-icon icon="mdi:theme-light-dark"></ha-icon></button>
              <button class="suntime" hidden title="Sun time (today)"><ha-icon icon="mdi:clock-outline"></ha-icon><span class="t"></span></button>
              <button class="edit" hidden title="Edit floorplan"><ha-icon icon="mdi:pencil"></ha-icon><span>Edit</span></button>
            </div>
            <div class="fp-suntime" hidden><input type="range" min="0" max="1440" step="15" aria-label="Sun time"><span class="time"></span><button class="now">Now</button></div>
            <div class="empty" hidden></div>
            <div class="notice" hidden></div>
            <div class="fp-toast" hidden></div>
          </div>
        </div>
      </ha-card>`;
    this._stage = root.querySelector('.stage');
    this._stage.style.height = this._config.height;
    root.querySelector('.body').style.setProperty('--fp-height', this._config.height);
    this._chips = root.querySelector('.chips');
    this._empty = root.querySelector('.empty');
    this._notice = root.querySelector('.notice');
    this._toastEl = root.querySelector('.fp-toast');
    root.querySelector('.seg').addEventListener('click', (e) => {
      const mode = e.target.dataset && e.target.dataset.mode;
      if (mode) this._setMode(mode);
    });
    this._chips.addEventListener('click', (e) => {
      const id = e.target.dataset && e.target.dataset.view;
      if (id) this._setView(id);
    });
    root.querySelector('button.reset').addEventListener('click', () => this._resetCamera());
    this._sectionBtn = root.querySelector('button.section');
    this._sectionBtn.addEventListener('click', () => this.setSection(!this._section));
    this._body = root.querySelector('.body');
    this._editBtn = root.querySelector('button.edit');
    this._skyCtl.wire(root); // Day / night button, sun time scrubber
    this._editBtn.addEventListener('click', () => this._toggleEdit());
    this._view = new FloorplanView(this._stage);
    this._loadUI = new ModelLoadUI({
      stage: this._stage,
      controls: () => this._view && this._view.controls,
      // the last loaded model's rooms of this layout, else the drawn rooms (null: the house fallback)
      outline: () => {
        if (!this._config) return null;
        const saved = loadOutline(this._config.layout_key);
        if (saved) return saved;
        const drawn = pickOutline((this._layout && this._layout.rooms) || []);
        return drawn.length ? drawn : null;
      },
    });
    this._view.onMapImage = (img, w, h) => this._mowerCtl._onMapImage(img, w, h);
    // auto mode: settings or the mower picture changed -> the current picture again, searched in full
    this._view.onMapReprocess = () => this._mowerCtl.onMapReprocess();
    this._objects = new ObjectLayer(this._view);
    this._view.onObjectsInvalidate = () => this._objectInput._updateObjects(); // view, section or placement changed
    this._popup = new ObjectPopup(this._stage, {
      onAction: (domain, service, data) => this._callService(domain, service, data),
      onLink: (action) => this._runAction(action, {}),
      project: (w) => this._view.projectWorld(w),
      anchor: (id) => this._objects.anchorOf(id),
      resolve: (id) => this._objectInput.popupResolve(id),
    });
    this._hints = new TapHints(this._view.objectsGroup);
    this._hints.setPixelRatio(this._view.renderer.getPixelRatio());
    this._view.onRender = () => { this._popup.position(); this._objectInput._hintsNear(); };
    this._view.setOcclusion(this._config.occlusion !== false);
    this._view.setRenderOption(this._config.render);
    this._view.setBackground(this._config.background);
    this._view.setFurniture(this._config.furniture);
    this._view.setAo(this._config.ao);
    this._view.setBokeh(this._config.bokeh);
    this._view.setGrade(this._config.grade);
    this._view.setSway(this._config.sway);
    this._view.setMaxFps(this._config.max_fps);
    this._view.setSurroundLight(this._config.surround_light);
    this._view.setCityLights(this._config.city_lights);
    this._view.onPixelRatio = (pr) => this._hints.setPixelRatio(pr);
    this._view.setMode(this._mode);
    this._loadModel();
    this._edit = new EditMode(this);
    this._body.append(this._edit.panel);
    const canvas = this._view.renderer.domElement;
    this._stage.addEventListener('pointerdown', (e) => {
      if (this._editing && e.target === canvas) this._edit.canvasDownCapture(e);
    }, true);
    canvas.addEventListener('pointerdown', (e) => this._editing && this._edit.canvasDown(e));
    canvas.addEventListener('pointermove', (e) => this._editing && this._edit.canvasMove(e));
    canvas.addEventListener('pointerup', (e) => this._editing && this._edit.canvasUp(e));
    this._objectInput.wire(this._stage, canvas); // object taps, tap hints, hover
    this._syncToolbar();
  }

  // A model load finished (ModelLoader._loadModel; err: its message, '' / undefined when fine): the
  // card rebuilds around the model that is there now.
  _afterModel(err, { fresh, opts, gen, prevModel }) {
    if ((fresh || err || !opts) && gen === (this._loadGen || 0)) this._loadUI.done(!!this._view.model && !err, err || '');
    if (this._view.model !== prevModel && this._section) this._dropSection();
    if (this._view.model !== prevModel) { this._endGesture(); this._popup.close(); }
    this._objects.setModel(this._view.model);
    // bind now: lamps light and bound markers hide without waiting for the next hass push
    if (this._hass && this._layout && this._floors && this._syncBindings()) {
      this._buildMarkers();
      this._refreshStates();
    }
    this._updateObjects();
    this._refreshAttached(); // the model (re)placed: attached markers follow their objects
    this._updateMowerWarning(); // the ground under the mower changed
    this._scheduleSurfaces(); // auto-placed markers onto (or off) the model's surfaces
    this._notice.textContent = err || '';
    this._notice.hidden = !err;
    // a new model resets the views; the first view applied frames it (see _resolveViewList)
    this._stage.classList.toggle('has-model', !!this._view.model);
    if (this._view.model) { this._applySky(true); this._applyWeather(); }
    else this._skyCtl.resetDay(); // no model: the toggle is hidden, so always day
    this._syncToolbar();
    this._schedule(); // the manifest arrived: rebuild
    if (this._layout && this._layout.mower && this._hass) this._refreshMapOverlay(); // the map lies on the model's lawn
    if (this._editing) this._edit.onModelLoaded(this._view.model !== prevModel);
  }

  _toggleEdit() {
    this._objectInput.clearHover();
    this._endGesture();
    this._taps.cancel();
    this._closeConfirm();
    this._popup.close();
    this._editing = !this._editing;
    this._body.classList.toggle('editing', this._editing);
    if (this._editing) {
      if (!this._view.model && this._floor === 'all') this._setFloor(this._floors[0].id);
      this._edit.enter();
    } else {
      this._edit.exit();
      this._viewCtl.clearFloorOnly(); // back to the view the chips show (camera kept)
    }
    this._syncHints(); // no tap hints while editing
    this._built.rooms = undefined; // model look: outlines and labels only while editing
    if (this._layout && this._layout.mower && this._hass) this._refreshMapOverlay(); // "map only in edit mode"
    this._schedule();
    this._syncToolbar();
    // the panel changes the canvas size: resize once the layout has settled; the camera stays
    requestAnimationFrame(() => this._resize());
  }

  // Apply an edited layout: rebuild the plan and save it.
  _commit(layout) {
    this._layout = layout;
    const seq = (this._saveSeq = (this._saveSeq || 0) + 1);
    this._edit.setSaveState('saving');
    this._store.save(this._hass, layout).then((ok) => {
      if (seq === this._saveSeq) this._edit.setSaveState(ok ? 'saved' : 'failed');
    });
    this._schedule();
  }

  _resize() {
    const r = this._stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this._view.resize(r.width, r.height);
    if (!this._fitted && this._roomList) this._initialCamera();
  }

  _schedule() {
    if (this._pending) return;
    this._pending = true;
    queueMicrotask(() => {
      this._pending = false;
      if (this._view && this._hass && this._layout) this._update();
    });
  }

  // Rebuild only what changed. Edits replace just the layout parts they touch, so identity
  // comparisons per part keep e.g. overlay slider changes from rebuilding the whole scene.
  _update() {
    const h = this._hass;
    const b = this._built;
    const l = this._layout;
    let structure = false, markers = false, mower = false;

    if (h.themes !== b.themes || !b.theme) {
      b.themes = h.themes;
      this._applyTheme();
      structure = true;
    }
    const mb = this.modelBindings();
    this._mb = mb;
    const viewsChanged = this._resolveViewList(mb);
    if (viewsChanged) this._checkMergeKeep();
    const viewsOnly = viewsChanged === 'views'; // only layout.views / view_order: no scene or marker rebuild
    let viewRefreshed = false;
    const mkIn = [mb, this._config, l.model];
    if (!b.modelKeyIn || mkIn.some((x, i) => x !== b.modelKeyIn[i])) {
      b.modelKeyIn = mkIn;
      b.modelKeyNow = mb ? JSON.stringify([mb.levels, mb.rooms, this._modelAlign()]) : '';
    }
    const modelKey = b.modelKeyNow;
    if (structure || (viewsChanged && !viewsOnly) || l.rooms !== b.rooms || (l.room_labels || null) !== (b.roomLabels ?? null) || l.floors !== b.lfloors || h.floors !== b.floors || h.areas !== b.areas
      || (mb && mb.manifest) !== b.manifest || modelKey !== b.modelKey) {
      b.manifest = mb && mb.manifest;
      b.modelKey = modelKey;
      this._buildStructure(mb, !!viewsChanged);
      markers = true;
    } else if (viewsOnly) {
      this._refreshViews();
      viewRefreshed = true;
    }
    const sig = registrySignature(h);
    const m = l.mower || null;
    const mowerKey = m ? `${m.entity}|${m.floor_id}` : '';
    if (this._syncBindings() || markers || !b.sig || sig.some((x, i) => x !== b.sig[i]) || l.pins !== b.pins || l.hidden !== b.hidden || mowerKey !== b.mowerKey) {
      b.sig = sig;
      b.pins = l.pins;
      b.hidden = l.hidden;
      b.mowerKey = mowerKey;
      this._buildMarkers();
      markers = true;
    }
    if (l.model !== b.model) {
      b.model = l.model;
      this._loadModel();
    }
    if (m !== b.mower) {
      b.mower = m;
      this._mowerCtl.configChanged(m);
      mower = true;
    }
    if (h.states !== b.states || markers || mower || l.badges !== b.badges || structure) {
      b.states = h.states;
      b.badges = l.badges;
      this._refreshStates();
      this._refreshMower();
    }
    this._updateObjects();
    this._popup.update();
    if ((markers || viewRefreshed) && this._editing) this._edit.afterUpdate();
    else if (this._editing) this._edit.onStates();
  }

  _applyTheme() {
    const bg = cssColor(this, '--card-background-color', '#ffffff');
    const text = cssColor(this, '--primary-text-color', '#212121');
    const dark = this._hass.themes && typeof this._hass.themes.darkMode === 'boolean'
      ? this._hass.themes.darkMode : luminance(bg) < 0.4;
    const mix = (a, c, t) => a.clone().lerp(c, t);
    this._built.theme = {
      dark,
      floor: mix(bg, text, dark ? 0.09 : 0.05),
      outdoor: mix(bg, new Color('#5a9e4b'), dark ? 0.22 : 0.3),
      wall: mix(bg, text, dark ? 0.42 : 0.3),
      edge: mix(bg, text, dark ? 0.3 : 0.22),
      primary: cssColor(this, '--primary-color', '#03a9f4'),
    };
    this._view.setTheme(this._built.theme);
  }

  _syncToolbar() {
    const hasModel = !!(this._view && this._view.model);
    // without a model: one chip per floor plus All (not while editing), shown with 2+ floors
    const views = this._views.filter((v) => !v.hidden && (hasModel || !this._editing || v.id !== 'all'));
    const show = hasModel ? views.length > 1 : this._views.filter((v) => !v.hidden && v.id !== 'all').length > 1;
    this._chips.innerHTML = '';
    if (show) {
      for (const v of views) {
        const btn = document.createElement('button');
        btn.className = 'chip' + (v.id === this._viewId && !this._floorOnly ? ' on' : '');
        btn.dataset.view = v.id;
        btn.textContent = v.label;
        this._chips.append(btn);
      }
    }
    for (const btn of this.shadowRoot.querySelectorAll('.seg button')) btn.classList.toggle('on', btn.dataset.mode === this._mode);
    this._dayBtn.hidden = !(this._view && this._view.model);
    if (this._section && (!this._mb || !this._index || !hasModel)) this._dropSection();
    if (this._sectionBtn) {
      this._sectionBtn.hidden = !(this._view && this._view.model && this._mode === '3d');
      this._sectionBtn.classList.toggle('on', !!this._section);
    }
    this._paintDayBtn();
    this._paintSunBtn();
    this._editBtn.hidden = !(this._hass && this._hass.user && this._hass.user.is_admin);
    this._editBtn.querySelector('span').textContent = this._editing ? 'Done' : 'Edit';
    if (this._empty && this._editing) this._empty.hidden = true;
  }
}

// The facade: members used outside their part (edit mode, the debug overlay, headless checks, the other
// parts) keep their names on the card. Fields forward get / set, so the same objects come back.
const proto = Floorplan3dCard.prototype;
defineDelegates(proto, '_mowerCtl', {
  methods: [
    '_mowerFloor', '_refreshMower', '_mowerStateEntity', '_updateMowerWarning', '_warningText', '_dockGroup',
    '_dockedNow', 'mowerStatus', 'mowerStatusText', 'mowerHeading', '_mapRefreshSec', 'mowerAuto', '_mowerZ',
    'mapZone', 'mapInfo', '_refreshMapOverlay',
  ],
  fields: [
    '_autoMismatch', '_dockPx', '_headSt', '_headingSource', '_iconHead', '_iconHeadRaw', '_imageBlob',
    '_imageResult', '_lastFrame', '_mapDetect', '_mapProc', '_mapStats', '_mowerLive', '_mowerOffline', '_perf',
    '_throttle', '_trk', '_warning',
  ],
});
defineDelegates(proto, '_modelLoader', {
  methods: [
    '_loadModel', '_modelFresh', '_modelBytes', '_checkMergeKeep', '_modelAlign', 'modelBindings',
  ],
  fields: [
    '_loadGen', '_modelEvicted', '_modelFromCache', '_modelSrc',
  ],
});
defineDelegates(proto, '_viewCtl', {
  methods: [
    '_buildStructure', '_pickView', '_refreshViews', '_resolveViewList', '_stateFor', 'currentView', '_applyZoomTo',
    'viewIndex', '_applyViewVisibility', '_applyMarkerStates', '_allRooms', '_setView', '_initialCamera',
    '_resetCamera', '_setFloor', '_setMode', '_armIdleReset', '_dropSection', 'sectionPlaneNow', 'leaveSection',
    'setSection', 'previewSection', 'saveViewPatch',
  ],
  fields: [
    '_fitted', '_floor', '_floorOnly', '_floors', '_idleTimer', '_levels', '_modelRooms', '_outlineModel',
    '_roomList', '_section', '_viewId', '_viewState', '_views', '_zones', '_index', '_mode',
  ],
});
defineDelegates(proto, '_markerLayer', {
  methods: [
    '_buildMarkers', '_refreshStates', 'badgeOpts', '_objectBadge', '_applyMarkerSelection', '_scheduleSurfaces',
    '_refreshAttached',
  ],
  fields: [
    '_markers', '_markerEls', '_positions', '_mowerMarkerId', '_surf', '_surfJob',
  ],
});
defineDelegates(proto, '_actionRunner', {
  methods: [
    '_runAction', '_callService', '_toast', '_closeConfirm', '_moreInfo',
  ],
});
defineDelegates(proto, '_objectInput', {
  methods: [
    '_syncBindings', '_tagIndex', '_updateObjects', '_objectTapsOn', '_objectHit', '_endGesture', 'testObject',
    '_markerActions', '_runObjectAction', '_openObjectPopup', '_runMarkerAction', 'objectLabel', '_syncHints',
  ],
  fields: [
    '_bindings', '_boundEntities', '_groups',
  ],
});
defineDelegates(proto, '_skyCtl', {
  methods: [
    'setSunTime', '_paintSunBtn', '_paintDayBtn', '_applySky', '_applyWeather', '_syncNightMarkers', '_wakeMarkers',
  ],
  fields: [
    '_skyMode', '_sunTime', '_sunNow', '_dayBtn',
  ],
});

if (!customElements.get('floorplan3d-card')) {
  customElements.define('floorplan3d-card', Floorplan3dCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'floorplan3d-card',
    name: 'Floorplan 3D',
    description: '3D floorplan with automatically placed devices',
    preview: false,
  });
  console.info(`%c floorplan3d-card ${VERSION} `, 'background:#03a9f4;color:#fff;border-radius:3px');
}
