// Idle path tracing of render quality 'still' (still.ts has the rules): the view's side. Nothing happens in the
// other tiers: no session, no import of the path tracer (src/path-tracer.ts, its own chunk, loaded on the first
// idle moment under 'still'). The render loop asks idle() on every animation frame no frame was due; a frame
// that is due calls frameDrawn() first, which ends a running session, so the raster frame replaces the traced
// image at once.
import * as THREE from 'three';
import { stillBudget, stillDone, stillFade, stillHold, STILL_IDLE_MS, type StillBudget, type StillHold } from '../still.ts';
import { frameInterval, isMesh } from './core.ts';
import type { FloorplanView } from '../view.ts';
import type { PathTraceSession, TraceSource } from '../path-tracer.ts';

type Module = typeof import('../path-tracer.ts');

export class StillTrace {
  view: FloorplanView;
  /** the path tracer (null until the first idle moment under 'still'; freed when the tier changes) */
  session: PathTraceSession | null;
  /** edit mode is open (the card) */
  editing: boolean;
  /** idle time (ms) before a trace starts */
  idleMs: number;
  /** a session runs (tracing or showing its image) */
  active: boolean;
  /** the session spent its budget: its image stays until the next frame */
  done: boolean;
  /** why no session runs (null: one runs or may start) */
  hold: StillHold;
  budget: StillBudget;
  /** idle time (ms) before the last session started (checks) */
  startedAfter: number;
  _lastFrameAt: number;
  _tracingAt: number;
  _stepAt: number;
  _load: Promise<Module> | null;
  _mod: Module | null;
  _failed: boolean;

  constructor(view: FloorplanView) {
    this.view = view;
    this.session = null;
    this.editing = false;
    this.idleMs = STILL_IDLE_MS;
    this.active = false;
    this.done = false;
    this.hold = 'tier';
    this.budget = stillBudget(!!view.test);
    this.startedAfter = 0;
    this._lastFrameAt = performance.now();
    this._tracingAt = 0;
    this._stepAt = 0;
    this._load = null;
    this._mod = null;
    this._failed = false;
  }

  /** samples of the running session (0: none) */
  get samples(): number {
    return this.active && this.session ? this.session.samples : 0;
  }

  // A raster frame is being drawn: a running session ends (its image is replaced by this frame) and the idle
  // time counts from now.
  frameDrawn(now: number): void {
    this._lastFrameAt = now;
    this.active = false;
    this.done = false;
  }

  // The tier or the model changed: the path tracer freed unless the tier traces with a model.
  sync(): void {
    const v = this.view;
    if (v.look.tier().pathTrace && v.model) return;
    this.hold = v.look.tier().pathTrace ? 'model' : 'tier';
    if (this.active) v.dirty = true;
    this.active = false;
    this.dispose();
  }

  // Edit mode opened / closed (the card): no trace while editing.
  setEditing(on: boolean): void {
    if (this.editing === !!on) return;
    this.editing = !!on;
    if (on && this.active) { this.active = false; this.view.dirty = true; }
  }

  // An animation frame with no frame due: start a session once idle long enough, else trace a tile of the running
  // one and draw it over the raster frame. A hold (off screen, edit mode, clipped) ends a running session: the
  // raster frame is drawn again so no traced image is left.
  idle(now: number): void {
    const v = this.view;
    const tier = v.look.tier().pathTrace;
    if (!tier && !this.session && !this.active) { this.hold = 'tier'; return; } // standard / high: nothing at all
    const hold = stillHold({
      tier, model: !!v.model, onScreen: v.onScreen,
      visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
      editing: this.editing, clipped: this._clipped(), idleFor: this.active ? Infinity : now - this._lastFrameAt, idleMs: this.idleMs,
    });
    this.hold = hold;
    if (hold) {
      if (this.active) { this.active = false; v.dirty = true; } // back to the raster frame
      return;
    }
    if (this.done || this._failed) return;
    if (!this.active) { this._start(now); return; }
    const s = this.session!;
    if (now - this._stepAt < frameInterval(0, v._maxFps)) return; // max_fps: the trace's frames too
    this._stepAt = now;
    s.step();
    if (s.compiling) return; // the shader compiles in parallel (KHR_parallel_shader_compile)
    if (!this._tracingAt) this._tracingAt = now;
    v.stats.stillSteps++;
    s.draw(stillFade(s.samples, this.budget));
    if (stillDone(s.samples, now - this._tracingAt, this.budget)) this.done = true;
  }

  _clipped(): boolean {
    const v = this.view;
    return v.renderer.clippingPlanes.length > 0 || v.modelClip.constant < 1e5;
  }

  // The first idle moment loads the path tracer (its chunk); the next one builds the scene when its inputs changed,
  // draws the raster frame again to keep it (the drawing buffer is gone after the browser shows it) and begins.
  _start(now: number): void {
    const v = this.view;
    if (!this._mod) {
      if (!this._load) {
        this._load = import('../path-tracer.ts');
        this._load.then((m) => { this._mod = m; }, (e: unknown) => this._fail(e)); // the next idle frame starts
      }
      return;
    }
    try {
      if (!this.session) this.session = new this._mod.PathTraceSession(v.renderer);
      const s = this.session;
      v.camera.updateMatrixWorld();
      if (s.prepare(this._source(), v.camera)) v.stats.stillBuilds++;
      v._drawGl(false); // the raster frame as it is on screen
      s.keepRaster();
      s.begin(v.camera);
    } catch (e) {
      this._fail(e);
      return;
    }
    this.active = true;
    this.done = false;
    this.startedAfter = now - this._lastFrameAt;
    this._tracingAt = 0;
    this._stepAt = 0;
    v.stats.stillSessions++;
  }

  // What to trace: the model's visible meshes, the sun, moon and lamp lights, the sky environment.
  _source(): TraceSource {
    const v = this.view, env = v.look._env, cube = env && env.built && env._cube ? env._cube.texture : null;
    const skip = (o: THREE.Object3D): boolean => !!o.userData.helper;
    // what the raster frame does not draw: meshes outside the camera's layers (nodes a view hides itself), all
    // materials invisible
    const drop = (o: THREE.Object3D): boolean => {
      if (!isMesh(o)) return false;
      if (!o.layers.test(v.camera.layers)) return true;
      return ([] as THREE.Material[]).concat(o.material).every((m) => !m || !m.visible);
    };
    return {
      meshes: [v.modelGroup],
      lights: [v.sun, v.moonLight, v.objectsGroup],
      skip,
      drop,
      environment: cube,
      environmentIntensity: cube ? v.scene.environmentIntensity : 0,
      geometryKey: [v.model ? v.model.id : '', v._modelSig(), v.stats.materialSwaps, v._modelVisibility ? [...v._modelVisibility.masks.keys()].map((n) => n.id).join(',') : ''].join('#'),
      envKey: String(env ? env.builds : 0),
    };
  }

  _fail(e: unknown): void {
    this._failed = true;
    this.active = false;
    console.warn('floorplan3d: render quality still: path tracing is not available here, showing the high tier', e);
    this.dispose();
    this.view.dirty = true;
  }

  dispose(): void {
    if (this.session) this.session.dispose();
    this.session = null;
  }
}
