import { describe, it, expect } from 'vitest';
import { precipAmounts, nearPolygon, placeDrops, PRECIP_ROOM_MARGIN } from '../src/precip.js';

describe('precipAmounts', () => {
  it('rain / snow per condition, pouring the most, none when dry', () => {
    expect(precipAmounts('pouring').rain).toBe(1);
    expect(precipAmounts('rainy').rain).toBeGreaterThan(0);
    expect(precipAmounts('rainy').rain).toBeLessThan(precipAmounts('pouring').rain);
    expect(precipAmounts('snowy')).toEqual({ rain: 0, snow: 0.7 });
    const mix = precipAmounts('snowy-rainy');
    expect(mix.rain > 0 && mix.snow > 0).toBe(true);
    for (const c of ['sunny', 'cloudy', 'partlycloudy', 'fog', null, undefined]) expect(precipAmounts(c)).toEqual({ rain: 0, snow: 0 });
  });
});

describe('nearPolygon', () => {
  const sq = [[0, 0], [4, 0], [4, 3], [0, 3]];
  it('inside, near an edge, or away', () => {
    expect(nearPolygon(sq, 2, 1)).toBe(true);
    expect(nearPolygon(sq, 4.5, 1, 0.6)).toBe(true);
    expect(nearPolygon(sq, 4.5, 1, 0.2)).toBe(false);
    expect(nearPolygon(sq, 10, 10, 1)).toBe(false);
  });
});

describe('placeDrops', () => {
  const room = [[0, 0], [4, 0], [4, 3], [0, 3]]; // plan: world z = -y
  it('no drop over a room (with the margin), all inside the square, deterministic', () => {
    const d = placeDrops(500, [2, -1.5], 8, [room]);
    expect(d.length).toBe(1500);
    for (let i = 0; i < d.length; i += 3) {
      const [x, z, ph] = [d[i], d[i + 1], d[i + 2]];
      expect(nearPolygon(room, x, -z, PRECIP_ROOM_MARGIN - 1e-6)).toBe(false);
      expect(Math.abs(x - 2)).toBeLessThanOrEqual(8);
      expect(Math.abs(z + 1.5)).toBeLessThanOrEqual(8);
      expect(ph).toBeGreaterThanOrEqual(0); expect(ph).toBeLessThan(1);
    }
    expect([...placeDrops(50, [2, -1.5], 8, [room])]).toEqual([...d.subarray(0, 150)]);
  });
  it('gives up rather than looping when everything is a room', () => {
    expect(placeDrops(10, [0, 0], 1, [[[-5, -5], [5, -5], [5, 5], [-5, 5]]]).length).toBe(0);
  });
});
