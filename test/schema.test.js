// Schema combinators (src/schema/core.ts) and the card YAML contract (src/schema/config.ts).
import { describe, it, expect, vi } from 'vitest';
import {
  run, object, optional, withDefault, string, number, numeric, boolean, literal, nullable, union, array, record, tuple, map, refine,
  unknownValue, toJson, jsonEqual,
} from '../src/schema/core.ts';
import { parseCardConfig, logConfigWarnings, DEFAULT_HEIGHT } from '../src/schema/config.ts';

describe('schema combinators', () => {
  const s = object({ a: string(), b: optional(number()), c: withDefault(literal('x', 'y'), () => 'x') });

  it('required / optional / default fields', () => {
    expect(run(s, { a: 'A' })).toEqual({ value: { a: 'A', c: 'x' }, warnings: [], unknown: [] });
    expect(run(s, { a: 'A', b: 2, c: 'y' }).value).toEqual({ a: 'A', b: 2, c: 'y' });
    const bad = run(s, { a: 'A', b: 'two', c: 'z' });
    expect(bad.value).toEqual({ a: 'A', c: 'x' }); // invalid optional dropped, invalid default replaced
    expect(bad.warnings.map((w) => w.path)).toEqual(['b', 'c']);
    expect(run(s, { b: 1 })).toMatchObject({ value: null, warnings: [{ path: 'a', message: 'missing' }] });
    expect(run(s, 'x').value).toBeNull();
  });

  it('keeps unknown fields and the input key order, skips undefined', () => {
    const r = run(s, { z: 1, a: 'A', y: { deep: [1] }, b: undefined });
    expect(Object.keys(r.value)).toEqual(['z', 'a', 'y', 'c']);
    expect(r.value.y).toEqual({ deep: [1] });
    expect(r.unknown).toEqual(['z', 'y']);
  });

  it('drops a __proto__ key (JSON.parse makes it an own key)', () => {
    const r = run(object({ m: record(number()) }), JSON.parse('{"__proto__": {"x": 1}, "m": {"__proto__": 2, "a": 1}}'));
    expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
    expect(r.value).toEqual({ m: { a: 1 } });
    expect(r.warnings.map((w) => w.path)).toEqual(['__proto__', 'm.__proto__']);
  });

  it('lists and maps drop what does not fit, with the path', () => {
    const r = run(object({ l: array(number()), m: record(object({ n: number() })) }), { l: [1, 'x', 3], m: { a: { n: 1 }, b: { n: 'no' }, c: 4 } });
    expect(r.value).toEqual({ l: [1, 3], m: { a: { n: 1 } } });
    expect(r.warnings.map((w) => w.path)).toEqual(['l[1]', 'm.b.n', 'm.c']);
  });

  it('scalars', () => {
    expect(run(number(), NaN).value).toBeNull();
    expect(run(number(), Infinity).value).toBeNull();
    expect(run(numeric(), ' 2.5 ').value).toBe(2.5);
    expect(run(numeric(), '').value).toBeNull();
    expect(run(boolean(), 'true').value).toBeNull();
    expect(run(nullable(string()), null).value).toBeNull();
    expect(run(nullable(string()), null).warnings).toEqual([]);
    expect(run(unknownValue(), { any: 1 }).value).toEqual({ any: 1 });
  });

  it('tuples, unions, map, refine', () => {
    expect(run(tuple(2), [1, 2, 3]).value).toEqual([1, 2]);
    expect(run(tuple(2), [1]).value).toBeNull();
    expect(run(tuple(3), [1, '2', 3]).value).toBeNull();
    const u = union(string(), array(string()));
    expect(run(u, ['a']).value).toEqual(['a']);
    expect(run(u, 3).warnings[0].message).toBe('expected a string or a list, got 3');
    expect(run(map(number(), (n) => n * 2), 2).value).toBe(4);
    expect(run(refine(number(), (n) => n > 0, 'a positive number'), -1).warnings[0].message).toBe('expected a positive number, got -1');
  });

  it('toJson / jsonEqual', () => {
    expect(toJson({ a: undefined, b: [1, { c: undefined }] })).toEqual({ b: [1, {}] });
    expect(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(jsonEqual([1], [1, 2])).toBe(false);
  });
});

describe('card config (YAML)', () => {
  it('fills the defaults', () => {
    expect(parseCardConfig({ type: 'custom:floorplan3d-card' })).toEqual({
      value: { type: 'custom:floorplan3d-card', layout_key: 'default', height: DEFAULT_HEIGHT, group_by: 'device', wall_height: 1, view: '3d' },
      warnings: [],
    });
  });

  it('reads YAML numbers and strings the way they were meant', () => {
    const c = parseCardConfig({ type: 't', layout_key: 2, height: 400, wall_height: '1.5', model_position: ['1', 0, 2], idle_orbit: '3' }).value;
    expect(c).toMatchObject({ layout_key: '2', height: '400px', wall_height: 1.5, model_position: [1, 0, 2], idle_orbit: 3 });
  });

  it('drops wrong values (their default applies) and keeps unknown options', () => {
    const p = parseCardConfig({ type: 't', group_by: 'room', wall_height: 0, view: 'side', zoom_to: 'mouse', model_position: [1, 2], merge: 'no', weather: true, future_option: { a: 1 } });
    expect(p.value).toMatchObject({ group_by: 'device', wall_height: 1, view: '3d', future_option: { a: 1 } });
    expect(['zoom_to', 'model_position', 'merge', 'weather'].filter((k) => k in p.value)).toEqual([]);
    expect(p.warnings.map((w) => w.path)).toEqual(['group_by', 'wall_height', 'view', 'zoom_to', 'model_position', 'merge', 'weather']);
  });

  it('passes the options other modules own on as written', () => {
    const render = { recipe: 'model', quality: 'whatever' };
    const p = parseCardConfig({ type: 't', render, ao: 'strong', views: { a: {} }, actions: { 'light.a': {} }, weather: false });
    expect(p.value.render).toBe(render);
    expect(p.value).toMatchObject({ ao: 'strong', views: { a: {} }, weather: false });
    expect(p.warnings).toEqual([]);
  });

  it('never throws', () => {
    for (const bad of [null, undefined, 'x', 3, []]) expect(parseCardConfig(bad).value.layout_key).toBe('default');
  });

  it('logs each problem once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = parseCardConfig({ type: 't', view: 'sideways-once' });
    logConfigWarnings(p);
    logConfigWarnings(p);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('floorplan3d: card YAML view: expected \'3d\' | \'top\', got "sideways-once"; ignored');
    warn.mockRestore();
  });
});
