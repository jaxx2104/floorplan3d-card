import { describe, it, expect } from "bun:test";
import { frameInterval, driftTick } from "../src/view/core.ts";
import { CLOUD_FRAME_MS } from "../src/cloud-shadow.ts";
import { PRECIP_FRAME_MS } from "../src/precip.ts";

describe("frameInterval (card option max_fps)", () => {
  it("keeps each animation's own interval without max_fps", () => {
    expect(frameInterval(50, undefined)).toBe(50);
    expect(frameInterval(66, null)).toBe(66);
    expect(frameInterval(33, 0)).toBe(33);
    expect(frameInterval(33, "x")).toBe(33);
  });
  it("max_fps sets the period, 2 ms short so a jittery 60 Hz rAF keeps every frame", () => {
    expect(frameInterval(50, 60)).toBeCloseTo(1000 / 60 - 2);
    expect(frameInterval(66, "30")).toBeCloseTo(1000 / 30 - 2);
    expect(frameInterval(50, 1000)).toBe(0);
  });
});

// The drift throttle of the cloud shadows and rain / snow (view/sky.ts _driftClouds), stepped by a simulated
// 60 Hz requestAnimationFrame: the frame-rate caps the headless model-check used to time in a browser.
describe("driftTick (cloud drift / rain throttle)", () => {
  // n rAF ticks every `step` ms from t0 -> { frames, minGap (ms), dts }
  const run = (interval, n, step = 1000 / 60, t0 = 1000) => {
    let frameAt = 0,
      prev = 0,
      minGap = Infinity,
      frames = 0;
    const dts = [];
    for (let i = 0; i < n; i++) {
      const now = t0 + i * step;
      const t = driftTick(frameAt, now, interval);
      frameAt = t.frameAt;
      if (t.dt === null) continue;
      frames++;
      dts.push(t.dt);
      if (prev) minGap = Math.min(minGap, now - prev);
      prev = now;
    }
    return { frames, minGap, dts };
  };

  it("arms on the first call without a frame, then waits out the interval", () => {
    expect(driftTick(0, 500, 50)).toEqual({ frameAt: 500, dt: null });
    expect(driftTick(500, 549, 50)).toEqual({ frameAt: 500, dt: null });
    expect(driftTick(500, 550, 50)).toEqual({ frameAt: 550, dt: 0.05 });
  });

  it("dt is the time since the last frame, at most 1 s (a stalled tab does not jump the drift)", () => {
    expect(driftTick(500, 5500, 50).dt).toBe(1);
  });

  it("cloud shadows: at most 20 frames a second (>= 47.6 ms between frames) on a 60 Hz rAF", () => {
    const r = run(frameInterval(CLOUD_FRAME_MS, undefined), 600);
    expect(r.minGap).toBeGreaterThanOrEqual(1000 / 21);
    expect(r.frames).toBeLessThanOrEqual(20 * 10);
    expect(r.frames).toBeGreaterThan(100); // it does drift
  });

  it("rain / snow: at most 31.5 frames a second (>= 31.7 ms between frames)", () => {
    const r = run(frameInterval(PRECIP_FRAME_MS, undefined), 600);
    expect(r.minGap).toBeGreaterThanOrEqual(1000 / 31.5);
    expect(r.frames).toBeGreaterThan(150);
  });

  it("a slow renderer (5 fps) still gets a frame on every rAF, dt following the real gaps", () => {
    const r = run(frameInterval(PRECIP_FRAME_MS, undefined), 20, 200);
    expect(r.frames).toBe(19); // all but the arming call
    expect(r.dts.every((d) => Math.abs(d - 0.2) < 1e-9)).toBe(true);
  });
});
