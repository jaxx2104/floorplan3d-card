import { describe, it, expect } from 'vitest';
import { frameInterval } from '../src/view.js';

describe('frameInterval (card option max_fps)', () => {
  it('keeps each animation\'s own interval without max_fps', () => {
    expect(frameInterval(50, undefined)).toBe(50);
    expect(frameInterval(66, null)).toBe(66);
    expect(frameInterval(33, 0)).toBe(33);
    expect(frameInterval(33, 'x')).toBe(33);
  });
  it('max_fps sets the period, 2 ms short so a jittery 60 Hz rAF keeps every frame', () => {
    expect(frameInterval(50, 60)).toBeCloseTo(1000 / 60 - 2);
    expect(frameInterval(66, '30')).toBeCloseTo(1000 / 30 - 2);
    expect(frameInterval(50, 1000)).toBe(0);
  });
});
