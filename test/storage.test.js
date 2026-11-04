// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LayoutStore, normalise, EMPTY_LAYOUT } from '../src/storage.ts';

const fail = () => Promise.reject(new Error('unknown command'));

describe('normalise', () => {
  it('fills defaults and repairs bad fields', () => {
    expect(normalise(null)).toEqual(EMPTY_LAYOUT());
    expect(normalise({ rooms: 'x', pins: null, floors: [{ id: 'g' }], extra: 1 }))
      .toMatchObject({ version: 1, rooms: [], pins: {}, floors: [{ id: 'g' }], hidden: [], extra: 1 });
  });
  it('migrates the v0.1.4 model floor_map into level bindings', () => {
    expect(normalise({ model: { version: 'v', floor_map: { ground: 'floor1', attic: 'always' } } }).model)
      .toEqual({ version: 'v', levels: { ground: { floor: 'floor1' }, attic: { show: 'always' } } });
  });
});

describe('LayoutStore', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
  afterEach(() => vi.useRealTimers());

  it('prefers the companion integration', async () => {
    const callWS = vi.fn(async (m) => (m.type === 'floorplan3d/layout/get' ? { layout: { rooms: [{ id: 'r' }] } } : null));
    const s = new LayoutStore('k');
    const l = await s.load({ callWS });
    expect(s.backend).toBe('shared');
    expect(l.rooms).toEqual([{ id: 'r' }]);
    const p = s.save({ callWS }, l);
    await vi.runAllTimersAsync();
    expect(await p).toBe(true);
    expect(callWS).toHaveBeenLastCalledWith({ type: 'floorplan3d/layout/set', key: 'k', layout: l });
  });

  it('migrates an older per-user layout when nothing is shared yet', async () => {
    const callWS = vi.fn(async (m) => {
      if (m.type === 'floorplan3d/layout/get') return { layout: null };
      if (m.type === 'frontend/get_user_data') return { value: { rooms: [{ id: 'old' }] } };
      return null;
    });
    const s = new LayoutStore('k');
    expect((await s.load({ callWS })).rooms).toEqual([{ id: 'old' }]);
    expect(s.backend).toBe('shared');
  });

  it('migrates a browser layout when nothing is shared yet', async () => {
    localStorage.setItem('floorplan3d_k', JSON.stringify({ rooms: [{ id: 'local' }] }));
    const callWS = vi.fn(async (m) => {
      if (m.type === 'floorplan3d/layout/get') return { layout: null };
      throw new Error('unknown');
    });
    const s = new LayoutStore('k');
    expect((await s.load({ callWS })).rooms).toEqual([{ id: 'local' }]);
    expect(s.backend).toBe('shared');
  });

  it('falls back to frontend user data', async () => {
    const callWS = vi.fn(async (m) => {
      if (m.type === 'frontend/get_user_data') return { value: { hidden: ['x'] } };
      if (m.type === 'frontend/set_user_data') return null;
      throw new Error('unknown');
    });
    const s = new LayoutStore();
    expect((await s.load({ callWS })).hidden).toEqual(['x']);
    expect(s.backend).toBe('user');
    const p = s.save({ callWS }, { a: 1 });
    await vi.runAllTimersAsync();
    await p;
    expect(callWS).toHaveBeenLastCalledWith({ type: 'frontend/set_user_data', key: 'floorplan3d_default', value: { a: 1 } });
  });

  it('falls back to localStorage', async () => {
    localStorage.setItem('floorplan3d_k', JSON.stringify({ rooms: [{ id: 'z' }] }));
    const s = new LayoutStore('k');
    expect((await s.load({ callWS: fail })).rooms).toEqual([{ id: 'z' }]);
    expect(s.backend).toBe('browser');
    const p = s.save({ callWS: fail }, { rooms: [] });
    await vi.runAllTimersAsync();
    expect(await p).toBe(true);
    expect(JSON.parse(localStorage.getItem('floorplan3d_k'))).toEqual({ rooms: [] });
  });

  it('debounces saves and settles superseded promises', async () => {
    const callWS = vi.fn(async (m) => (m.type === 'floorplan3d/layout/get' ? { layout: null } : null));
    const s = new LayoutStore('k');
    await s.load({ callWS });
    callWS.mockClear();
    const first = s.save({ callWS }, { n: 1 });
    const second = s.save({ callWS }, { n: 2 });
    await vi.runAllTimersAsync();
    expect(await second).toBe(true);
    expect(await first).toBe(false);
    expect(callWS).toHaveBeenCalledTimes(1);
    expect(callWS.mock.calls[0][0].layout).toEqual({ n: 2 });
  });

  it('reports a failed save', async () => {
    const s = new LayoutStore('k');
    s.backend = 'shared';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = s.save({ callWS: fail }, {});
    await vi.runAllTimersAsync();
    expect(await p).toBe(false);
    err.mockRestore();
  });
});
