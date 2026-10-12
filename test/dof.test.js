import { describe, it, expect } from 'vitest';
import { normBokeh, cocAt, BOKEH_DEFAULTS } from '../src/dof.js';

describe('normBokeh', () => {
  it('off unless asked for, or with no strength', () => {
    for (const v of [undefined, null, false, 0, 'yes', { strength: 0 }]) expect(normBokeh(v)).toBe(null);
  });
  it('true: the defaults; an object: its valid keys, clamped', () => {
    expect(normBokeh(true)).toEqual({ ...BOKEH_DEFAULTS });
    expect(normBokeh({ strength: 99, range: 0, start: 'x' })).toEqual({ strength: 20, start: BOKEH_DEFAULTS.start, range: 0.5 });
  });
});

describe('cocAt', () => {
  const s = { start: 1, range: 10 };
  it('sharp up to start, full blur from start + range, smooth between', () => {
    expect(cocAt(0, s)).toBe(0);
    expect(cocAt(1, s)).toBe(0);
    expect(cocAt(6, s)).toBeCloseTo(0.5);
    expect(cocAt(11, s)).toBe(1);
    expect(cocAt(50, s)).toBe(1);
    expect(cocAt(3, s)).toBeLessThan(cocAt(4, s));
  });
});
