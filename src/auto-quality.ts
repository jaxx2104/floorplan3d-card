// Render quality 'auto': the rules, without three or the DOM (the view's side is view/auto-quality.ts). The
// view feeds every animation frame (tick) and applies a level change only once the view is idle (the
// controller proposes it with due()); applied() commits it.
//
// Measured: the time between two consecutive animation frames that both rendered (continuous rendering:
// orbiting, damping, a tween, an animation running every frame), at least the frame's own CPU time. That
// interval holds the GPU time too (a GPU-bound frame delays the next requestAnimationFrame), unlike the CPU
// time of renderer.render alone. Not measured: frames after an idle tick (no interval), gaps over GAP_MS (tab
// hidden, a long task), the first frames after start, a model load or a level change (shader compiles).
//
// Down: the median of the last WINDOW samples over downMs (about 25 fps). Up: only after upAfterMs at the
// level with the last full window at the display's refresh (median within upFactor x the refresh interval,
// estimated from the idle ticks), at most maxUpFailures times a session; an up that has to come back down
// within probeMs doubles the wait for the next. Never more than one change per cooldownMs.

/** What 'auto' chooses from, best first. 'reduced' is 'standard' at pixel ratio 1 (only offered where the
 * device's pixel ratio is above 1). 'still' is never chosen automatically. */
export type AutoLevel = "high" | "standard" | "reduced";
export const AUTO_LEVELS: readonly AutoLevel[] = Object.freeze([
  "high",
  "standard",
  "reduced",
] as AutoLevel[]);

export interface AutoTuning {
  /** samples (ms) a decision looks at */
  window: number;
  /** median frame interval (ms) above which the level steps down */
  downMs: number;
  /** step up when the median is within this many refresh intervals */
  upFactor: number;
  /** time (ms) at a level before the first step up is tried; doubled after each failed try */
  upAfterMs: number;
  /** an up followed by a down within this time (ms) counts as failed */
  probeMs: number;
  /** failed tries after which 'auto' stays where it is for the session */
  maxUpFailures: number;
  /** at most one change per this time (ms) */
  cooldownMs: number;
  /** no samples for this time (ms) after start, a reset or a change (shader compiles, uploads) */
  settleMs: number;
  /** a tick gap (ms) above this is no sample (tab hidden, long task) */
  gapMs: number;
}
export const AUTO_TUNING: Readonly<AutoTuning> = Object.freeze({
  window: 60,
  downMs: 40,
  upFactor: 1.25,
  upAfterMs: 60000,
  probeMs: 60000,
  maxUpFailures: 2,
  cooldownMs: 20000,
  settleMs: 3000,
  gapMs: 1000,
});

/** Refresh interval (ms) assumed until the idle ticks have shown the display's. */
export const DEFAULT_REFRESH_MS = 1000 / 60;

export const median = (xs: readonly number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** A proposed change: the level and why (for the console). */
export interface AutoChange {
  level: AutoLevel;
  from: AutoLevel;
  reason: string;
}

/** Debug state (the overlay, the checks). */
export interface AutoState {
  level: AutoLevel;
  levels: readonly AutoLevel[];
  /** median of the samples in the window (ms), null while it is not full */
  median: number | null;
  samples: number;
  refreshMs: number;
  failures: number;
  pending: AutoLevel | null;
  switches: number;
}

export class AutoQuality {
  tuning: AutoTuning;
  levels: readonly AutoLevel[];
  level: AutoLevel;
  switches: number;
  failures: number;
  /** samples (ms) since the last change, at most tuning.window */
  samples: number[];
  _prevTs: number | null;
  _prevRendered: boolean;
  _settleUntil: number;
  _changedAt: number;
  /** the last change was a step up at this time (a down within probeMs fails it) */
  _upAt: number | null;
  /** test hook (the headless check): each sample is this (ms) instead of the measured interval */
  fixedSampleMs: number | null;
  _deltas: number[];
  _deltaCount: number;
  _refresh: number;

  constructor({
    level = "high",
    levels = AUTO_LEVELS,
    now = 0,
    tuning = {},
  }: {
    level?: AutoLevel;
    levels?: readonly AutoLevel[];
    now?: number;
    tuning?: Partial<AutoTuning>;
  } = {}) {
    this.tuning = { ...AUTO_TUNING, ...tuning };
    this.levels = levels.length ? levels : AUTO_LEVELS;
    this.level = this.levels.includes(level) ? level : this.levels[0];
    this.switches = 0;
    this.failures = 0;
    this.samples = [];
    this._prevTs = null;
    this._prevRendered = false;
    this._settleUntil = now + this.tuning.settleMs;
    this._changedAt = now;
    this._upAt = null;
    this.fixedSampleMs = null;
    this._deltas = [];
    this._deltaCount = 0;
    this._refresh = DEFAULT_REFRESH_MS;
  }

  /** Display refresh interval (ms): a low percentile of the recent tick gaps (idle ticks run at the refresh). */
  get refreshMs(): number {
    return this._refresh;
  }

  // An animation frame at ts (ms); rendered: it drew a frame; cpuMs: the frame's own time.
  tick(ts: number, rendered: boolean, cpuMs = 0): void {
    const prev = this._prevTs,
      gap = prev === null ? Infinity : ts - prev;
    if (gap < 100 && !rendered && !this._prevRendered) {
      // two idle ticks: the display's refresh, not the frames' cost
      const d = this._deltas;
      d.push(gap);
      if (d.length > 120) d.shift();
      if (d.length >= 20 && ++this._deltaCount % 30 === 0)
        this._refresh = Math.max(
          4,
          [...d].sort((a, b) => a - b)[Math.floor(d.length * 0.1)],
        );
    }
    if (
      rendered &&
      this._prevRendered &&
      gap <= this.tuning.gapMs &&
      ts >= this._settleUntil
    ) {
      this.samples.push(this.fixedSampleMs ?? Math.max(gap, cpuMs));
      if (this.samples.length > this.tuning.window) this.samples.shift();
    }
    this._prevTs = ts;
    this._prevRendered = rendered;
  }

  // Start over without a change (a model load, the option set again): no samples until settled.
  reset(now: number): void {
    this.samples = [];
    this._prevRendered = false;
    this._settleUntil = now + this.tuning.settleMs;
  }

  _median(): number | null {
    return this.samples.length >= this.tuning.window
      ? median(this.samples)
      : null;
  }

  // The change the samples ask for at now, or null (the view applies it once idle, then calls applied()).
  due(now: number): AutoChange | null {
    const T = this.tuning,
      i = this.levels.indexOf(this.level),
      m = this._median();
    if (m === null || now - this._changedAt < T.cooldownMs) return null;
    if (m > T.downMs && i < this.levels.length - 1) {
      return {
        level: this.levels[i + 1],
        from: this.level,
        reason: `median frame ${m.toFixed(1)} ms over ${this.samples.length} frames > ${T.downMs} ms`,
      };
    }
    const wait = T.upAfterMs * 2 ** this.failures;
    if (
      i > 0 &&
      this.failures < T.maxUpFailures &&
      now - this._changedAt >= wait &&
      m <= this._refresh * T.upFactor
    ) {
      return {
        level: this.levels[i - 1],
        from: this.level,
        reason: `median frame ${m.toFixed(1)} ms at a ${this._refresh.toFixed(1)} ms refresh for ${Math.round((now - this._changedAt) / 1000)} s`,
      };
    }
    return null;
  }

  // The view switched to level at now.
  applied(level: AutoLevel, now: number): void {
    const from = this.levels.indexOf(this.level),
      to = this.levels.indexOf(level);
    if (to < 0 || to === from) return;
    if (
      to > from &&
      this._upAt !== null &&
      now - this._upAt < this.tuning.probeMs
    )
      this.failures++; // the try up did not hold
    this._upAt = to < from ? now : null;
    this.level = level;
    this.switches++;
    this._changedAt = now;
    this.reset(now);
  }

  state(pending: AutoLevel | null = null): AutoState {
    return {
      level: this.level,
      levels: this.levels,
      median: this._median(),
      samples: this.samples.length,
      refreshMs: this._refresh,
      failures: this.failures,
      pending,
      switches: this.switches,
    };
  }
}
