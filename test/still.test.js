import { describe, it, expect } from "bun:test";
import {
  stillBudget,
  stillHold,
  stillFade,
  stillDone,
  stillSize,
  STILL_IDLE_MS,
  STILL_MAX_SAMPLES,
  STILL_MAX_MS,
  STILL_TEST_SAMPLES,
  STILL_FADE_FROM,
  STILL_FADE_TO,
} from "../src/still.ts";
import { StillTrace } from "../src/view/still.ts";

const base = {
  tier: true,
  model: true,
  onScreen: true,
  visible: true,
  editing: false,
  clipped: false,
  idleFor: STILL_IDLE_MS,
};

describe("still: idle path tracing rules", () => {
  it("budget: 512 spp or 60 s, a few samples in test mode", () => {
    expect(stillBudget(false)).toEqual({
      samples: STILL_MAX_SAMPLES,
      ms: STILL_MAX_MS,
      fadeFrom: STILL_FADE_FROM,
      fadeTo: STILL_FADE_TO,
    });
    expect(STILL_FADE_FROM).toBeGreaterThanOrEqual(128); // never a noisy image over the raster frame
    expect(STILL_FADE_TO).toBeGreaterThan(STILL_FADE_FROM);
    expect(STILL_FADE_TO).toBeLessThanOrEqual(STILL_MAX_SAMPLES);
    const t = stillBudget(true);
    expect(t.samples).toBe(STILL_TEST_SAMPLES);
    expect(t.samples).toBeLessThanOrEqual(4);
    expect(t.fadeTo).toBe(t.samples); // fully faded in at the last test sample
    expect(t.ms).toBe(Infinity); // ends on the sample count only: a slow runner cannot end it by time
  });
  it("starts only in the still tier, with a model, on screen, outside edit mode, unclipped, after the idle time", () => {
    expect(stillHold(base)).toBe(null);
    expect(stillHold({ ...base, tier: false })).toBe("tier");
    expect(stillHold({ ...base, model: false })).toBe("model");
    expect(stillHold({ ...base, onScreen: false })).toBe("offscreen");
    expect(stillHold({ ...base, visible: false })).toBe("hidden");
    expect(stillHold({ ...base, editing: true })).toBe("edit");
    expect(stillHold({ ...base, clipped: true })).toBe("clip");
    expect(stillHold({ ...base, idleFor: STILL_IDLE_MS - 1 })).toBe("idle");
    expect(stillHold({ ...base, idleFor: 500, idleMs: 400 })).toBe(null);
    expect(stillHold({ ...base, idleFor: NaN })).toBe("idle");
    // the tier comes first: standard / high never get further
    expect(
      stillHold({ ...base, tier: false, onScreen: false, editing: true }),
    ).toBe("tier");
  });
  it("shows nothing before the fade threshold, then fades in to full", () => {
    const b = stillBudget(false);
    expect(stillFade(0, b)).toBe(0);
    expect(stillFade(1, b)).toBe(0);
    expect(stillFade(STILL_FADE_FROM - 0.25, b)).toBe(0); // a sample's tiles not all drawn yet
    expect(stillFade(STILL_FADE_FROM, b)).toBe(0);
    expect(stillFade((STILL_FADE_FROM + STILL_FADE_TO) / 2, b)).toBeCloseTo(
      0.5,
    );
    expect(stillFade(STILL_FADE_TO, b)).toBe(1);
    expect(stillFade(STILL_MAX_SAMPLES, b)).toBe(1);
    expect(stillFade(NaN, b)).toBe(0);
    // test mode: the same rule over the tiny cap
    const t = stillBudget(true);
    expect(stillFade(0.75, t)).toBe(0);
    expect(stillFade(1, t)).toBe(0);
    expect(stillFade(1.5, t)).toBeCloseTo(0.5);
    expect(stillFade(t.samples, t)).toBe(1);
    // a degenerate fade shows at once from its start
    expect(stillFade(5, { samples: 10, ms: 1, fadeFrom: 5, fadeTo: 5 })).toBe(
      1,
    );
    expect(stillFade(4, { samples: 10, ms: 1, fadeFrom: 5, fadeTo: 5 })).toBe(
      0,
    );
  });
  it("ends at the sample cap or the time cap", () => {
    const b = stillBudget(false);
    expect(stillDone(511, 1000, b)).toBe(false);
    expect(stillDone(512, 1000, b)).toBe(true);
    expect(stillDone(10, 60000, b)).toBe(true);
    expect(stillDone(3, 10, stillBudget(true))).toBe(true);
  });
  it("traces at half resolution", () => {
    expect(stillSize(1200, 700)).toEqual([600, 350]);
    expect(stillSize(1, 1)).toEqual([1, 1]);
  });
});

// The view side's idle clock (view/still.ts StillTrace), on a stub view and a stub path tracer: the 3 s idle rule
// the headless perf-check used to read off a real session (startedAfter >= 3000 after real-time waits). The render
// loop hands it the frame time, so the test steps that clock itself.
describe("StillTrace: a session starts once the idle time has passed since the last raster frame", () => {
  class FakeSession {
    samples = 0;
    compiling = false;
    prepare() {
      return true;
    }
    keepRaster() {}
    begin() {}
    step() {
      this.samples++;
    }
    draw() {}
    dispose() {}
  }
  const make = () => {
    const view = {
      look: { tier: () => ({ pathTrace: true }), _env: null },
      model: { id: "m" },
      onScreen: true,
      renderer: { clippingPlanes: [] },
      modelClip: { constant: 1e9 },
      camera: { updateMatrixWorld() {} },
      _drawGl() {},
      _drawOverlay() {},
      stats: { stillSessions: 0, stillBuilds: 0, stillSteps: 0, stillDraws: 0 },
      test: true,
      dirty: false,
    };
    const t = new StillTrace(view);
    t._mod = { PathTraceSession: FakeSession }; // the chunk loaded
    t._source = () => ({});
    return { t, view };
  };

  it("holds 'idle' until idleMs after the last frame, then starts with startedAfter = that idle time", () => {
    const { t, view } = make();
    t.frameDrawn(10000);
    t.idle(10000 + STILL_IDLE_MS - 1);
    expect(t.hold).toBe("idle");
    expect(view.stats.stillSessions).toBe(0);
    t.idle(10000 + STILL_IDLE_MS);
    expect(t.hold).toBe(null);
    expect(t.active).toBe(true);
    expect(view.stats.stillSessions).toBe(1);
    expect(view.stats.stillBuilds).toBe(1);
    expect(t.startedAfter).toBe(STILL_IDLE_MS);
  });

  it("a raster frame ends the session and the idle time counts again from it", () => {
    const { t, view } = make();
    t.frameDrawn(0);
    t.idle(STILL_IDLE_MS);
    expect(t.active).toBe(true);
    t.frameDrawn(5000);
    expect(t.active).toBe(false);
    t.idle(5000 + STILL_IDLE_MS - 1);
    expect(t.hold).toBe("idle");
    expect(view.stats.stillSessions).toBe(1);
    t.idle(5000 + STILL_IDLE_MS + 500);
    expect(view.stats.stillSessions).toBe(2);
    expect(t.startedAfter).toBe(STILL_IDLE_MS + 500);
  });

  it("a running session is never held by the idle time (it traces on, then stays done)", () => {
    const { t, view } = make();
    t.idleMs = 1000;
    t.frameDrawn(0);
    t.idle(1000);
    for (let i = 1; i <= 200 && !t.done; i++) t.idle(1000 + i * 20);
    expect(t.done).toBe(true);
    const steps = view.stats.stillSteps;
    t.idleMs = Infinity; // no effect on the running session
    t.idle(99999);
    expect(t.hold).toBe(null);
    expect(t.active).toBe(true);
    expect(view.stats.stillSteps).toBe(steps); // budget spent: no more tiles
    expect(view.stats.stillSessions).toBe(1);
  });
});
