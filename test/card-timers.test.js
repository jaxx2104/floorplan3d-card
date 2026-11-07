// @vitest-environment happy-dom
// Card timers across disconnect / reconnect (a wall tablet switching dashboard views), idle reset and
// night markers, on the card's parts with fake hosts.
import { describe, it, expect, vi, afterEach } from "bun:test";
import { MowerController } from "../src/card/mower-controller.ts";
import { ViewController } from "../src/card/view-controller.ts";
import { SkyController } from "../src/card/sky-controller.ts";

function mower(connected) {
  const host = { isConnected: connected };
  const m = new MowerController(host);
  m._refreshMapOverlay = vi.fn();
  return { host, m };
}

describe("_setCameraTimer", () => {
  afterEach(() => vi.useRealTimers());
  it("while disconnected counts as 0 s, so a later reconnect can start the interval", () => {
    vi.useFakeTimers();
    const { host, m } = mower(false);
    m._setCameraTimer(10); // e.g. model load .then finishing after the disconnect
    vi.advanceTimersByTime(20000);
    expect(m._refreshMapOverlay).not.toHaveBeenCalled();
    host.isConnected = true;
    m._setCameraTimer(10); // reconnect: the same interval is armed now
    vi.advanceTimersByTime(10000);
    expect(m._refreshMapOverlay).toHaveBeenCalledTimes(1);
    m._setCameraTimer(0);
  });
  it("the image timer behaves the same", () => {
    vi.useFakeTimers();
    const { host, m } = mower(false);
    m._detectMower = vi.fn();
    m._setImageTimer(5);
    vi.advanceTimersByTime(10000);
    expect(m._detectMower).not.toHaveBeenCalled();
    host.isConnected = true;
    m._setImageTimer(5);
    vi.advanceTimersByTime(5000);
    expect(m._detectMower).toHaveBeenCalledTimes(1);
    m._setImageTimer(0);
  });
  it("resume() lets the same interval start again; dispose() stops both", () => {
    vi.useFakeTimers();
    const { host, m } = mower(true);
    m._detectMower = vi.fn();
    m._setCameraTimer(10);
    m._setImageTimer(5);
    host.isConnected = false;
    m.dispose();
    vi.advanceTimersByTime(20000);
    expect(m._refreshMapOverlay).not.toHaveBeenCalled();
    expect(m._detectMower).not.toHaveBeenCalled();
    host.isConnected = true;
    m.resume(); // connectedCallback: the next update re-arms whatever interval it asks for
    m._setCameraTimer(10);
    vi.advanceTimersByTime(10000);
    expect(m._refreshMapOverlay).toHaveBeenCalledTimes(1);
    m._setCameraTimer(0);
  });
});

describe("idle_reset", () => {
  afterEach(() => vi.useRealTimers());
  function idle(config) {
    const host = {
      isConnected: true,
      _config: config,
      _sunTime: 600,
      _popup: { close: vi.fn() },
      _view: { startOrbit: vi.fn(), stopOrbit: vi.fn() },
    };
    host.setSunTime = vi.fn((m) => {
      host._sunTime = m;
    });
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
    expect(host.setSunTime).toHaveBeenCalledWith(null);
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

describe("idle_orbit", () => {
  afterEach(() => vi.useRealTimers());
  it("starts after the idle reset in 3D and a touch stops it", () => {
    vi.useFakeTimers();
    const host = {
      isConnected: true,
      _config: { idle_reset: 10, idle_orbit: 3 },
      _sunTime: null,
      _popup: { close: vi.fn() },
      _view: { startOrbit: vi.fn(), stopOrbit: vi.fn() },
    };
    const v = new ViewController(host);
    Object.assign(v, {
      _views: [{ id: "g" }],
      _viewId: "g",
      _mode: "3d",
      _stateFor: () => ({ floors: [] }),
      _setView: vi.fn(),
      _setMode: vi.fn(),
      _resetCamera: vi.fn(),
    });
    v._armIdleReset();
    vi.advanceTimersByTime(10000);
    expect(host._view.startOrbit).toHaveBeenCalledWith(3);
    v._armIdleReset();
    expect(host._view.stopOrbit).toHaveBeenCalled();
    v.dispose();
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

// The time scrubber's shadow settle (SkyController.setSunTime): what model-check used to read in a browser as "the
// shadow map waits" right after an input, a "not yet" against the real clock.
describe("sun time scrubber: the sun's shadow map follows 150 ms after the last move", () => {
  afterEach(() => vi.useRealTimers());
  const sky = () => {
    const s = new SkyController({
      _config: {},
      _stage: document.createElement("div"),
      _syncMarkerMode() {},
      _syncToolbar() {},
    });
    s._applySky = vi.fn();
    return s;
  };
  it("dragging: sky now without the shadow, the shadow once 150 ms passed since the last move", () => {
    vi.useFakeTimers();
    const s = sky();
    s.setSunTime(600, { settle: false });
    expect(s._applySky).toHaveBeenLastCalledWith(true, { shadow: false });
    vi.advanceTimersByTime(100);
    s.setSunTime(615, { settle: false }); // still dragging: the settle starts over
    vi.advanceTimersByTime(149);
    expect(s._applySky).toHaveBeenCalledTimes(2);
    expect(s._applySky.mock.calls.every((c) => c[1]?.shadow === false)).toBe(
      true,
    );
    vi.advanceTimersByTime(1);
    expect(s._applySky).toHaveBeenCalledTimes(3);
    expect(s._applySky).toHaveBeenLastCalledWith(true);
    s.setSunTime(null);
  });
  it("a settled set (release, Now) applies the shadow at once", () => {
    vi.useFakeTimers();
    const s = sky();
    s.setSunTime(600);
    expect(s._applySky).toHaveBeenCalledWith(true);
    s.setSunTime(null);
  });
});
