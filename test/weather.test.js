import { describe, it, expect } from 'vitest';
import {
  windSpeed,
  cloudCoverage, weatherEntity, cloudLight, coverageChanged, convexHull, hullDistance, skyKeepOut, SKY_CLEAR,
} from '../src/weather.js';

const w = (state, attributes = {}) => ({ entity_id: 'weather.x', state, attributes });

describe('cloudCoverage', () => {
  it('uses a numeric cloud_coverage attribute, clamped 0..100', () => {
    expect(cloudCoverage(w('sunny', { cloud_coverage: 62 }))).toBe(62);
    expect(cloudCoverage(w('sunny', { cloud_coverage: '35' }))).toBe(35);
    expect(cloudCoverage(w('sunny', { cloud_coverage: 140 }))).toBe(100);
    expect(cloudCoverage(w('sunny', { cloud_coverage: -3 }))).toBe(0);
  });

  it('falls back to the condition', () => {
    const map = { sunny: 0, 'clear-night': 0, partlycloudy: 40, cloudy: 85, fog: 100, rainy: 100, pouring: 100,
      snowy: 100, 'snowy-rainy': 100, lightning: 100, 'lightning-rainy': 100, hail: 100, 'windy-variant': 100,
      windy: 30, exceptional: 50, unknown: 0, unavailable: 0, weird: 0 };
    for (const [s, c] of Object.entries(map)) expect(cloudCoverage(w(s)), s).toBe(c);
    expect(cloudCoverage(w('cloudy', { cloud_coverage: null }))).toBe(85);
    expect(cloudCoverage(w('cloudy', { cloud_coverage: '' }))).toBe(85);
    expect(cloudCoverage(w('cloudy', { cloud_coverage: 'n/a' }))).toBe(85);
  });

  it('no entity -> 0', () => {
    expect(cloudCoverage(null)).toBe(0);
    expect(cloudCoverage(undefined)).toBe(0);
  });
});

describe('weatherEntity', () => {
  const states = { 'sun.sun': {}, 'weather.home': w('sunny'), 'weather.other': w('cloudy') };
  it('none -> null', () => expect(weatherEntity({ weather: 'none' }, states)).toBe(null));
  it('configured entity wins', () => expect(weatherEntity({ weather: 'weather.other' }, states)).toBe('weather.other'));
  it('default: the first weather.* entity', () => expect(weatherEntity({}, states)).toBe('weather.home'));
  it('default without weather entities -> null', () => expect(weatherEntity({}, { 'sun.sun': {} })).toBe(null));
  it('false also disables', () => expect(weatherEntity({ weather: false }, states)).toBe(null));
});

describe('cloudLight', () => {
  it('clear sky changes nothing', () => {
    expect(cloudLight(0, 0)).toEqual({ sun: 1, shadowRadius: 1, shadowIntensity: 1, hemi: 1, sunDisc: 1, moon: 1 });
  });
  it('overcast: sun x0.25, softer and fainter shadow, more fill by day', () => {
    const l = cloudLight(100, 0);
    expect(l.sun).toBeCloseTo(0.25);
    expect(l.shadowRadius).toBeCloseTo(4);
    expect(l.shadowIntensity).toBeCloseTo(0.35);
    expect(l.hemi).toBeCloseTo(1.35);
    expect(l.sunDisc).toBeCloseTo(0.2);
    expect(l.moon).toBeCloseTo(0.3);
  });
  it('night: hemisphere unchanged', () => {
    expect(cloudLight(100, 1).hemi).toBe(1);
    expect(cloudLight(60, 0).hemi).toBeCloseTo(1.21);
  });
});

describe('coverageChanged', () => {
  it('applies only on a change of 5 or more (and on reaching 0 / 100)', () => {
    expect(coverageChanged(null, 0)).toBe(true);
    expect(coverageChanged(40, 44)).toBe(false);
    expect(coverageChanged(40, 45)).toBe(true);
    expect(coverageChanged(40, 35)).toBe(true);
    expect(coverageChanged(3, 0)).toBe(true);
    expect(coverageChanged(97, 100)).toBe(true);
    expect(coverageChanged(0, 0)).toBe(false);
  });
});

describe('sky keep-out', () => {
  const sq = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [2, 8]]);
  it('hull drops inner points', () => {
    expect(sq.length).toBe(4);
  });
  it('signed distance: outside > 0, inside < 0', () => {
    expect(hullDistance(sq, [15, 5])).toBeCloseTo(5);
    expect(hullDistance(sq, [13, 14])).toBeCloseTo(5); // corner
    expect(hullDistance(sq, [5, 5])).toBeCloseTo(-5);
    expect(hullDistance(sq, [1, 5])).toBeCloseTo(-1);
    expect(hullDistance([], [0, 0])).toBe(Infinity);
  });
  it('fade: full from SKY_CLEAR x r outside, gone when touching', () => {
    expect(skyKeepOut(SKY_CLEAR * 50, 50)).toBe(1);
    expect(skyKeepOut(200, 50)).toBe(1);
    expect(skyKeepOut(0, 50)).toBe(0);
    expect(skyKeepOut(-30, 50)).toBe(0);
    const k = skyKeepOut(30, 50);
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThan(1);
    expect(skyKeepOut(Infinity, 50)).toBe(1); // no rooms
  });
});

describe('windSpeed', () => {
  const st = (wind_speed, wind_speed_unit) => ({ state: 'sunny', attributes: { wind_speed, wind_speed_unit } });
  it('m/s from the entity unit, km/h when missing, 0 without a number', () => {
    expect(windSpeed(st(10, 'm/s'))).toBe(10);
    expect(windSpeed(st(36, 'km/h'))).toBeCloseTo(10);
    expect(windSpeed(st(36))).toBeCloseTo(10);
    expect(windSpeed(st(10, 'mph'))).toBeCloseTo(4.4704);
    expect(windSpeed(st('x', 'm/s'))).toBe(0);
    expect(windSpeed(null)).toBe(0);
  });
});
