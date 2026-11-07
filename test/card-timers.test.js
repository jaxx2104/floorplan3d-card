// @vitest-environment happy-dom
// Card timers: idle reset, idle orbit, night markers and the sun time scrubber, on the card's parts with fake hosts.
import { describe, it, expect, vi, afterEach } from "bun:test";
import { ViewController } from "../src/card/view-controller.ts";
import { SkyController } from "../src/card/sky-controller.ts";

describe("idle_reset", () => {
  afterEach(() => vi.useRealTimers());
  function idle(config) {
    const host = {
      isConnected: true,
      _config: config,
      _popup: { close: vi.fn() },
      _view: { startOrbit: vi.fn(), stopOrbit: vi.fn() },
    };
    const v = new ViewController(host);
    v._views = [{ id: "ground" }, { id: "upper" }];
    v._viewId = "upper";
    v._mode = "top";
    v._stateFor = () => ({ floors: [] });
    v._setView = vi.fn((id) => {
      v._viewId = id;
    });
    v._setMode = vi.fn((m) => {
      v._mode = m;
    });
    v._resetCamera = vi.fn();
    return { host, v };
  }
  it("returns to the start view, mode and camera after the idle time", () => {
    vi.useFakeTimers();
    const { host, v } = idle({ idle_reset: 60, view_id: "ground" });
    v._armIdleReset();
    vi.advanceTimersByTime(59000);
    expect(v._resetCamera).not.toHaveBeenCalled();
    v._armIdleReset(); // a touch restarts the countdown
    vi.advanceTimersByTime(59000);
    expect(v._resetCamera).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(host._popup.close).toHaveBeenCalled();
    expect(v._setView).toHaveBeenCalledWith("ground");
    expect(v._setMode).toHaveBeenCalledWith("3d");
    expect(v._resetCamera).toHaveBeenCalledTimes(1);
  });
  it("is off without the option", () => {
    vi.useFakeTimers();
    const off = idle({}).v;
    off._armIdleReset();
    vi.advanceTimersByTime(3600000);
    expect(off._resetCamera).not.toHaveBeenCalled();
    const { v } = idle({ idle_reset: 5 });
    v._armIdleReset();
    vi.advanceTimersByTime(5000);
    expect(v._resetCamera).toHaveBeenCalledTimes(1);
    v._armIdleReset();
    v.dispose();
    vi.advanceTimersByTime(5000);
    expect(v._resetCamera).toHaveBeenCalledTimes(1); // disposed: no second reset
  });
});

describe("night_markers", () => {
  afterEach(() => vi.useRealTimers());
  const sky = (config, daylight) => {
    const s = new SkyController({
      _config: config,
      _stage: document.createElement("div"),
      _syncMarkerMode() {},
    });
    s._daylight = daylight;
    return s;
  };
  it("hides the markers at night only with hide", () => {
    const s = sky({ night_markers: "hide" }, false);
    s._syncNightMarkers();
    expect(s.card._stage.classList.contains("night-quiet")).toBe(true);
    s._daylight = true;
    s._syncNightMarkers();
    expect(s.card._stage.classList.contains("night-quiet")).toBe(false);
    const d = sky({}, false);
    d._syncNightMarkers();
    expect(d.card._stage.classList.contains("night-quiet")).toBe(false);
  });
  it("a touch shows them for idle_reset seconds, 30 without it", () => {
    vi.useFakeTimers();
    const s = sky({ night_markers: "hide", idle_reset: 10 }, false);
    const stage = s.card._stage;
    s._wakeMarkers();
    expect(stage.classList.contains("awake")).toBe(true);
    vi.advanceTimersByTime(9000);
    s._wakeMarkers(); // touched again: the countdown restarts
    vi.advanceTimersByTime(9000);
    expect(stage.classList.contains("awake")).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(stage.classList.contains("awake")).toBe(false);
    const d = sky({ night_markers: "hide" }, false);
    d._wakeMarkers();
    vi.advanceTimersByTime(29000);
    expect(d.card._stage.classList.contains("awake")).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(d.card._stage.classList.contains("awake")).toBe(false);
    const e = sky({}, false);
    e._wakeMarkers();
    expect(e.card._stage.classList.contains("awake")).toBe(false);
  });
  it("dispose() drops the wake countdown", () => {
    vi.useFakeTimers();
    const s = sky({ night_markers: "hide" }, false);
    s._wakeMarkers();
    s.dispose();
    vi.advanceTimersByTime(30000);
    expect(s.card._stage.classList.contains("awake")).toBe(true); // no timer left to remove it
  });
});
