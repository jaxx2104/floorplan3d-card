import { describe, it, expect } from 'vitest';
import { stillBudget, stillHold, stillFade, stillDone, stillSize, STILL_IDLE_MS, STILL_MAX_SAMPLES, STILL_MAX_MS, STILL_TEST_SAMPLES, STILL_FADE_SAMPLES } from '../src/still.ts';

const base = { tier: true, model: true, onScreen: true, visible: true, editing: false, clipped: false, idleFor: STILL_IDLE_MS };

describe('still: idle path tracing rules', () => {
  it('budget: 256 spp or 30 s, a few samples in test mode', () => {
    expect(stillBudget(false)).toEqual({ samples: STILL_MAX_SAMPLES, ms: STILL_MAX_MS, fade: STILL_FADE_SAMPLES });
    expect(STILL_MAX_SAMPLES).toBe(256);
    expect(STILL_MAX_MS).toBe(30000);
    const t = stillBudget(true);
    expect(t.samples).toBe(STILL_TEST_SAMPLES);
    expect(t.samples).toBeLessThanOrEqual(4);
    expect(t.fade).toBe(t.samples); // fully faded in at the last test sample
  });
  it('starts only in the still tier, with a model, on screen, outside edit mode, unclipped, after the idle time', () => {
    expect(stillHold(base)).toBe(null);
    expect(stillHold({ ...base, tier: false })).toBe('tier');
    expect(stillHold({ ...base, model: false })).toBe('model');
    expect(stillHold({ ...base, onScreen: false })).toBe('offscreen');
    expect(stillHold({ ...base, visible: false })).toBe('hidden');
    expect(stillHold({ ...base, editing: true })).toBe('edit');
    expect(stillHold({ ...base, clipped: true })).toBe('clip');
    expect(stillHold({ ...base, idleFor: STILL_IDLE_MS - 1 })).toBe('idle');
    expect(stillHold({ ...base, idleFor: 500, idleMs: 400 })).toBe(null);
    expect(stillHold({ ...base, idleFor: NaN })).toBe('idle');
    // the tier comes first: standard / high never get further
    expect(stillHold({ ...base, tier: false, onScreen: false, editing: true })).toBe('tier');
  });
  it('fades in with the samples', () => {
    const b = stillBudget(false);
    expect(stillFade(0, b)).toBe(0);
    expect(stillFade(0.25, b)).toBeCloseTo(0.25 / STILL_FADE_SAMPLES);
    expect(stillFade(STILL_FADE_SAMPLES / 2, b)).toBeCloseTo(0.5);
    expect(stillFade(STILL_FADE_SAMPLES, b)).toBe(1);
    expect(stillFade(200, b)).toBe(1);
    expect(stillFade(NaN, b)).toBe(0);
  });
  it('ends at the sample cap or the time cap', () => {
    const b = stillBudget(false);
    expect(stillDone(255, 1000, b)).toBe(false);
    expect(stillDone(256, 1000, b)).toBe(true);
    expect(stillDone(10, 30000, b)).toBe(true);
    expect(stillDone(3, 10, stillBudget(true))).toBe(true);
  });
  it('traces at half resolution', () => {
    expect(stillSize(1200, 700)).toEqual([600, 350]);
    expect(stillSize(1, 1)).toEqual([1, 1]);
  });
});
