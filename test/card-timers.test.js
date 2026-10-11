// @vitest-environment jsdom
// Live map camera timer across disconnect / reconnect (a wall tablet switching dashboard views).
import { describe, it, expect, vi, afterEach } from 'vitest';
import '../src/floorplan3d-card.js';

const proto = customElements.get('floorplan3d-card').prototype;

function fake(connected) {
  const o = Object.create(proto);
  Object.defineProperty(o, 'isConnected', { value: connected, writable: true });
  o._refreshMapOverlay = vi.fn();
  return o;
}

describe('_setCameraTimer', () => {
  afterEach(() => vi.useRealTimers());
  it('while disconnected counts as 0 s, so a later reconnect can start the interval', () => {
    vi.useFakeTimers();
    const c = fake(false);
    c._setCameraTimer(10); // e.g. model load .then finishing after the disconnect
    expect(c._cameraTimer).toBeNull();
    expect(c._cameraTimerSec).toBe(0);
    c.isConnected = true;
    c._setCameraTimer(10); // reconnect -> _refreshMapOverlay
    expect(c._cameraTimer).not.toBeNull();
    vi.advanceTimersByTime(10000);
    expect(c._refreshMapOverlay).toHaveBeenCalledTimes(1);
    c._setCameraTimer(0);
  });
  it('the image timer behaves the same', () => {
    vi.useFakeTimers();
    const c = fake(false);
    c._detectMower = vi.fn();
    c._setImageTimer(5);
    expect(c._imageTimer).toBeNull();
    c.isConnected = true;
    c._setImageTimer(5);
    vi.advanceTimersByTime(5000);
    expect(c._detectMower).toHaveBeenCalledTimes(1);
    c._setImageTimer(0);
  });
});

describe('idle_reset', () => {
  afterEach(() => vi.useRealTimers());
  function idle(config) {
    const c = fake(true);
    c._config = config;
    c._view = {};
    c._views = [{ id: 'ground' }, { id: 'upper' }];
    c._viewId = 'upper';
    c._mode = 'top';
    c._sunTime = 600;
    c._popup = { close: vi.fn() };
    c._stateFor = () => ({ floors: [] });
    c._setView = vi.fn((id) => { c._viewId = id; });
    c._setMode = vi.fn((m) => { c._mode = m; });
    c.setSunTime = vi.fn((m) => { c._sunTime = m; });
    c._resetCamera = vi.fn();
    return c;
  }
  it('returns to the start view, mode and camera after the idle time', () => {
    vi.useFakeTimers();
    const c = idle({ idle_reset: 60, view_id: 'ground' });
    c._armIdleReset();
    vi.advanceTimersByTime(59000);
    expect(c._resetCamera).not.toHaveBeenCalled();
    c._armIdleReset(); // a touch restarts the countdown
    vi.advanceTimersByTime(59000);
    expect(c._resetCamera).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(c._popup.close).toHaveBeenCalled();
    expect(c._setView).toHaveBeenCalledWith('ground');
    expect(c._setMode).toHaveBeenCalledWith('3d');
    expect(c.setSunTime).toHaveBeenCalledWith(null);
    expect(c._resetCamera).toHaveBeenCalledTimes(1);
  });
  it('is off without the option and waits while editing', () => {
    vi.useFakeTimers();
    const off = idle({});
    off._armIdleReset();
    expect(off._idleTimer).toBeNull();
    const c = idle({ idle_reset: 5 });
    c._editing = true;
    c._armIdleReset();
    vi.advanceTimersByTime(5000);
    expect(c._resetCamera).not.toHaveBeenCalled();
    c._editing = false;
    vi.advanceTimersByTime(5000);
    expect(c._resetCamera).toHaveBeenCalledTimes(1);
    c._armIdleReset();
    clearTimeout(c._idleTimer);
  });
});
