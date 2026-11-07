// Render quality 'auto' (auto-quality.ts has the rules): the view's side. The render loop calls frame() on
// every animation frame; a change the controller proposes waits for a quiet moment (an animation frame that draws
// nothing, no pointer on the controls, no camera tween, the camera still for AUTO_IDLE_MS unless the idle orbit
// turns it), so the rebuild of materials and programs never lands mid-gesture. Animations that draw now and then
// (clouds, rain, sway, screens) do not hold it off.
// The level a device settled on is remembered (localStorage, per device) and is where the next load starts.
import {
  AutoQuality,
  AUTO_LEVELS,
  type AutoChange,
  type AutoLevel,
  type AutoState,
  type AutoTuning,
} from "../auto-quality.ts";
import type { Quality } from "../render-recipe.ts";
import type { FloorplanView } from "../view.ts";

/** time (ms) the camera has been still before a proposed change is applied */
export const AUTO_IDLE_MS = 1000;
export const AUTO_STORE_KEY = "floorplan3d.quality";
/** remembered failed tries up count for this long (ms); the level itself is kept */
const FAILURES_KEEP_MS = 24 * 3600e3;

/** The tier a level renders with. */
export const levelQuality = (level: AutoLevel): Quality =>
  level === "high" ? "high" : "standard";

interface Stored {
  level: AutoLevel;
  failures: number;
  at: number;
}

export class AutoQualityView {
  view: FloorplanView;
  /** the controller while the card option asks for 'auto', else null */
  ctl: AutoQuality | null;
  /** adapt to the measured frames (off in test mode until a check turns it on) */
  adapt: boolean;
  /** a change waiting for the view to be idle */
  pending: AutoChange | null;
  /** test hook: artificial cost (ms, busy wait) added to every rendered frame */
  testCostMs: number;
  /** tuning overrides for the next controller (checks) */
  tuning: Partial<AutoTuning>;
  _model: unknown;
  _dueAt: number;

  constructor(view: FloorplanView) {
    this.view = view;
    this.ctl = null;
    this.adapt = !view.test;
    this.pending = null;
    this.testCostMs = 0;
    this.tuning = {};
    this._model = null;
    this._dueAt = 0;
  }

  // The levels this device can use: 'reduced' only where it lowers the pixel ratio.
  levels(): AutoLevel[] {
    const dpr =
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    return AUTO_LEVELS.filter(
      (l) =>
        l !== "reduced" ||
        Math.min(dpr, this.view.look.render.pixelRatioMax) > 1,
    );
  }

  // The card option changed: a controller while it says 'auto' (starting at the remembered level), else none.
  sync(auto: boolean): void {
    if (!auto) {
      this.ctl = null;
      this.pending = null;
      return;
    }
    if (this.ctl) return;
    const levels = this.levels(),
      s = this._load(),
      now = performance.now();
    const level = !s
      ? "high"
      : levels.includes(s.level)
        ? s.level
        : levels[levels.length - 1]; // 'reduced' here without it: the lowest
    this.ctl = new AutoQuality({ level, levels, now, tuning: this.tuning });
    if (s && Date.now() - s.at < FAILURES_KEEP_MS)
      this.ctl.failures = s.failures;
  }

  /** the level in use (null: not 'auto') */
  get level(): AutoLevel | null {
    return this.ctl ? this.ctl.level : null;
  }

  // An animation frame: rendered (cpuMs its own time) or idle. A due change is applied once idle.
  frame(ts: number, rendered: boolean, cpuMs: number): void {
    const ctl = this.ctl,
      v = this.view;
    if (!ctl || !this.adapt) return;
    const now = performance.now();
    if (!v.model) {
      ctl.reset(now);
      return;
    } // the tiers differ only with a model
    if (v.model !== this._model) {
      this._model = v.model;
      this.pending = null;
      ctl.reset(now);
    } // a load: its programs compile now
    if (typeof document !== "undefined" && document.hidden) {
      ctl.reset(now);
      return;
    }
    ctl.tick(ts, rendered, cpuMs);
    if (!this.pending && (rendered || now - this._dueAt >= 1000)) {
      this._dueAt = now;
      this.pending = ctl.due(now);
    } // idle: once a second (the time-based step up)
    if (this.pending && !rendered && this._quiet(now))
      this._apply(this.pending, now);
  }

  // No gesture, tween or camera glide: the user is not steering the view.
  _quiet(now: number): boolean {
    const cam = this.view.cam,
      c = cam.controls as unknown as { state?: number };
    if (typeof c.state === "number" && c.state !== -1) return false; // OrbitControls: -1 = no pointer action
    return !cam._tween && now - (cam._camMovedAt || 0) >= AUTO_IDLE_MS;
  }

  _apply(change: AutoChange, now: number): void {
    this.pending = null;
    const ctl = this.ctl!;
    if (ctl.due(now)?.level !== change.level) return; // the samples changed their mind while waiting
    ctl.applied(change.level, now);
    console.info(
      `floorplan3d: render quality auto: ${change.from} -> ${change.level} (${change.reason})`,
    );
    this.view.stats.autoSwitches++;
    this._save({ level: ctl.level, failures: ctl.failures, at: Date.now() });
    this.view.look._applyAutoLevel(change.from, change.level);
  }

  // Test hook: the artificial cost of a rendered frame.
  burn(): void {
    if (!this.testCostMs) return;
    const end = performance.now() + this.testCostMs;
    while (performance.now() < end) {
      /* busy */
    }
  }

  state(): (AutoState & { quality: Quality }) | null {
    const ctl = this.ctl;
    return ctl
      ? {
          ...ctl.state(this.pending ? this.pending.level : null),
          quality: levelQuality(ctl.level),
        }
      : null;
  }

  _load(): Stored | null {
    if (this.view.test) return null;
    try {
      const s = JSON.parse(localStorage.getItem(AUTO_STORE_KEY) || "null");
      return s && AUTO_LEVELS.includes(s.level)
        ? {
            level: s.level,
            failures: Number(s.failures) || 0,
            at: Number(s.at) || 0,
          }
        : null;
    } catch {
      return null;
    }
  }

  _save(s: Stored): void {
    if (this.view.test) return;
    try {
      localStorage.setItem(AUTO_STORE_KEY, JSON.stringify(s));
    } catch {
      /* private mode */
    }
  }
}
