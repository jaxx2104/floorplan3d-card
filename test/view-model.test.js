import { describe, it, expect } from 'vitest';
import { fallbackOutline } from '../src/view.ts';

describe('fallbackOutline', () => {
  it('is the plan rectangle of a world box (north = -z)', () => {
    expect(fallbackOutline({ min: { x: 1, z: -5 }, max: { x: 4, z: -2 } })).toEqual([[1, 2], [4, 2], [4, 5], [1, 5]]);
  });
});
