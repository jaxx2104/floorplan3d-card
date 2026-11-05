import { describe, it, expect } from "bun:test";
import {
  AutoQuality,
  AUTO_TUNING,
  AUTO_LEVELS,
  median,
} from "../src/auto-quality.ts";
import { levelQuality } from "../src/view/auto-quality.ts";

const T = AUTO_TUNING;

// Drives a controller with synthetic animation frames: rendered frames `ms` apart, or idle ticks at 60 Hz.
// A due change is applied at once (waiting for the view to be idle is the view's part). Records the changes.
function rig(opts = {}) {
  const ctl = new AutoQuality({ now: 0, ...opts });
  const clock = { t: 0 };
  const changes = [];
  const settle = () => {
    const c = ctl.due(clock.t);
    if (c) {
      ctl.applied(c.level, clock.t);
      changes.push(c.level);
    }
    return c;
  };
  const render = (frames, ms, cpu = 0) => {
    for (let i = 0; i < frames; i++) {
      clock.t += ms;
      ctl.tick(clock.t, true, cpu);
    }
    return settle();
  };
  const idle = (msTotal, step = 1000 / 60) => {
    for (let s = 0; s < msTotal; s += step) {
      clock.t += step;
      ctl.tick(clock.t, false);
    }
    return settle();
  };
  return { ctl, clock, changes, render, idle };
}

describe("auto quality controller", () => {
  it("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNaN();
  });

  it("levels: high, standard, reduced; reduced and standard render the standard tier", () => {
    expect(AUTO_LEVELS).toEqual(["high", "standard", "reduced"]);
    expect(levelQuality("high")).toBe("high");
    expect(levelQuality("standard")).toBe("standard");
    expect(levelQuality("reduced")).toBe("standard");
  });

  it("starts at high and keeps it while frames are fast", () => {
    const r = rig();
    r.idle(T.settleMs);
    expect(r.render(600, 17)).toBeNull();
    expect(r.ctl.level).toBe("high");
  });

  it("steps down when the median frame is over the budget for a full window", () => {
    const r = rig();
    r.idle(T.settleMs + T.cooldownMs);
    expect(r.render(T.window, 60)).toBeNull(); // the first frame after idle has no interval: not a full window yet
    const c = r.render(1, 60);
    expect(c).toMatchObject({ level: "standard", from: "high" });
    expect(c.reason).toMatch(/median frame 60\.0 ms over 60 frames > 40 ms/);
    expect(r.ctl.level).toBe("standard");
  });

  it("a few spikes (shader compile, GC) do not step down: the median holds", () => {
    const r = rig();
    r.idle(T.settleMs + T.cooldownMs);
    for (let i = 0; i < 10; i++) {
      r.render(4, 17);
      r.render(1, 400);
    }
    expect(r.render(40, 17)).toBeNull();
    expect(r.ctl.level).toBe("high");
  });

  it("ignores idle gaps: isolated frames between idle ticks give no samples", () => {
    const r = rig();
    r.idle(T.settleMs + T.cooldownMs);
    for (let i = 0; i < 200; i++) {
      r.render(1, 900);
      r.idle(500);
    } // a frame now and then, after idle ticks
    expect(r.ctl.samples).toHaveLength(0);
    expect(r.ctl.level).toBe("high");
  });

  it("ignores gaps over gapMs (tab hidden, long task) between rendered frames", () => {
    const r = rig();
    r.idle(T.settleMs + T.cooldownMs);
    r.render(T.window * 2, T.gapMs + 1);
    expect(r.ctl.samples).toHaveLength(0);
  });

  it("ignores the frames right after start and after a change (settle)", () => {
    const r = rig();
    r.render(T.window + 1, 60); // 3.6 s from start: the first settleMs (3 s) are not counted
    expect(r.ctl.samples.length).toBeLessThan(T.window);
    r.idle(T.cooldownMs);
    r.render(T.window + 1, 60);
    expect(r.ctl.level).toBe("standard");
    r.render(20, 100); // the first 2 s at the new level: compiles, not counted
    expect(r.ctl.samples).toHaveLength(0);
  });

  it("respects the cooldown: one change per cooldownMs", () => {
    const r = rig();
    r.idle(T.settleMs + T.cooldownMs);
    r.render(T.window + 1, 60);
    expect(r.ctl.level).toBe("standard");
    const t0 = r.clock.t;
    r.idle(T.settleMs);
    expect(r.render(T.window + 1, 60)).toBeNull(); // still slow at standard, but within the cooldown
    while (r.ctl.level === "standard") r.render(1, 60);
    expect(r.ctl.level).toBe("reduced");
    expect(r.clock.t - t0).toBeGreaterThanOrEqual(T.cooldownMs);
    expect(r.clock.t - t0).toBeLessThan(T.cooldownMs + 100);
  });

  it("never goes below the last level", () => {
    const r = rig({ levels: ["high", "standard"] });
    for (let i = 0; i < 10; i++) {
      r.idle(T.cooldownMs);
      r.render(T.window * 2, 80);
    }
    expect(r.changes).toEqual(["standard"]);
  });

  it("steps up only after upAfterMs with frames at the refresh (hysteresis)", () => {
    const r = rig({ level: "standard", levels: ["high", "standard"] });
    r.idle(T.settleMs);
    expect(r.render(T.window + 1, 25)).toBeNull(); // between the budgets: neither down nor up
    r.idle(T.upAfterMs);
    expect(r.render(T.window + 1, 25)).toBeNull(); // 25 ms is not "at the 16.7 ms refresh"
    expect(r.ctl.level).toBe("standard");
    const c = r.render(T.window + 1, 1000 / 60);
    expect(c).toMatchObject({ level: "high", from: "standard" });
    expect(c.reason).toMatch(/at a 16\.7 ms refresh/);
  });

  it("does not step up before upAfterMs, however cheap the frames", () => {
    const r = rig({ level: "standard", levels: ["high", "standard"] });
    r.idle(T.settleMs);
    for (let i = 0; i < 50; i++)
      expect(r.render(T.window + 1, 1000 / 60)).toBeNull(); // 50 s
    expect(r.ctl.level).toBe("standard");
  });

  it("measures the refresh from the idle ticks (120 Hz needs 120 Hz frames to step up)", () => {
    const r = rig({ level: "standard", levels: ["high", "standard"] });
    r.idle(T.upAfterMs, 1000 / 120);
    expect(r.ctl.refreshMs).toBeCloseTo(1000 / 120, 1);
    expect(r.render(T.window + 1, 1000 / 60)).toBeNull(); // 60 fps on a 120 Hz screen: not cheap enough
    expect(r.render(T.window + 1, 1000 / 120)).toMatchObject({ level: "high" });
  });

  it("does not oscillate: a failed step up doubles the wait, and after maxUpFailures it stays down", () => {
    // a device where high costs 60 ms a frame and standard runs at the refresh, in use for an hour
    const r = rig({ levels: ["high", "standard"] });
    const cost = () => (r.ctl.level === "high" ? 60 : 1000 / 60);
    const ups = [];
    for (let s = 0; s < 3600; s++) {
      const before = r.ctl.level;
      r.render(Math.max(1, Math.round(1000 / cost())), cost());
      if (before === "standard" && r.ctl.level === "high") ups.push(r.clock.t);
    }
    expect(ups).toHaveLength(T.maxUpFailures);
    expect(r.ctl.failures).toBe(T.maxUpFailures);
    expect(r.ctl.level).toBe("standard");
    expect(r.changes).toHaveLength(1 + 2 * T.maxUpFailures); // down, then (up, down) per try
    expect(ups[1] - ups[0]).toBeGreaterThan(T.upAfterMs * 2); // the second try waited twice as long
  });

  it("a step up that holds past probeMs is no failure", () => {
    const r = rig({ levels: ["high", "standard"] });
    r.idle(T.settleMs + T.cooldownMs);
    r.render(T.window + 1, 60); // down: a heavy moment
    r.idle(T.upAfterMs);
    r.render(T.window + 1, 1000 / 60); // up
    expect(r.ctl.level).toBe("high");
    r.idle(T.probeMs);
    r.render(T.window + 1, 60); // down again, much later
    expect(r.ctl.level).toBe("standard");
    expect(r.ctl.failures).toBe(0);
  });

  it("reset drops the samples and settles again (a model load)", () => {
    const r = rig();
    r.idle(T.settleMs + T.cooldownMs);
    r.render(T.window - 5, 60);
    r.ctl.reset(r.clock.t);
    expect(r.ctl.samples).toHaveLength(0);
    expect(r.render(10, 60)).toBeNull();
  });

  it("CPU time counts when it is longer than the interval", () => {
    const r = rig();
    r.idle(T.settleMs + T.cooldownMs);
    expect(r.render(T.window + 1, 17, 55)).toMatchObject({ level: "standard" });
  });

  it("start level: the given one if offered, else the best", () => {
    expect(
      new AutoQuality({ level: "reduced", levels: ["high", "standard"] }).level,
    ).toBe("high");
    expect(new AutoQuality().level).toBe("high");
    expect(new AutoQuality({ level: "standard" }).state()).toMatchObject({
      level: "standard",
      median: null,
      samples: 0,
      failures: 0,
      pending: null,
      switches: 0,
    });
  });
});
