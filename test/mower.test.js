import { describe, it, expect } from 'vitest';
import { readSource, readTrack, toPlanar, fitTransform, overlayUrl, calibrationError, mowerTransform } from '../src/mower.js';

const close = (a, b, digits = 6) => {
  expect(a[0]).toBeCloseTo(b[0], digits);
  expect(a[1]).toBeCloseTo(b[1], digits);
};

describe('readSource', () => {
  it('reads gps attributes', () => {
    expect(readSource({ state: 'home', attributes: { latitude: 45.0, longitude: 10.0 } }, {}))
      .toEqual({ lat: 45.0, lon: 10.0, raw: [45.0, 10.0] });
  });

  it('parses a "lat,lon" state', () => {
    expect(readSource({ state: '45.05, 10.02', attributes: {} }, { source: 'gps' }))
      .toMatchObject({ lat: 45.05, lon: 10.02 });
    expect(readSource({ state: '-12.5;100.25', attributes: {} }, {})).toMatchObject({ lat: -12.5, lon: 100.25 });
  });

  it('falls back to the state when gps attributes are null', () => {
    expect(readSource({ state: 'unknown', attributes: { latitude: null, longitude: null } }, {})).toBeNull();
    expect(readSource({ state: '45.0,10.0', attributes: { latitude: null, longitude: null } }, {}))
      .toMatchObject({ lat: 45.0, lon: 10.0 });
  });

  it('reads xy attributes with configurable names', () => {
    expect(readSource({ state: 'x', attributes: { px: '12.5', py: -3 } }, { source: 'xy', x_attr: 'px', y_attr: 'py' }))
      .toEqual({ u: 12.5, v: -3, raw: [12.5, -3] });
    expect(readSource({ state: 'x', attributes: { x: 1 } }, { source: 'xy' })).toBeNull();
  });

  it('treats null or empty xy attributes as missing, not zero', () => {
    expect(readSource({ state: 'x', attributes: { x: null, y: null } }, { source: 'xy' })).toBeNull();
    expect(readSource({ state: 'x', attributes: { x: '', y: '' } }, { source: 'xy' })).toBeNull();
  });

  it('returns null without a state object', () => {
    expect(readSource(undefined, {})).toBeNull();
  });
});

describe('toPlanar', () => {
  it('passes xy through', () => {
    expect(toPlanar({ u: 3, v: 4 })).toEqual([3, 4]);
  });

  it('converts gps to metres east/north of the origin', () => {
    const o = { lat: 45.0, lon: 10.0 };
    const [u0, v0] = toPlanar({ lat: 45.0, lon: 10.0 }, o);
    expect(u0).toBeCloseTo(0);
    expect(v0).toBeCloseTo(0);
    // 0.001° latitude ~ 111.3 m north
    const [, v] = toPlanar({ lat: 45.001, lon: 10.0 }, o);
    expect(v).toBeCloseTo(111.32, 1);
    // 0.001° longitude shrinks with cos(latitude)
    const [u] = toPlanar({ lat: 45.0, lon: 10.001 }, o);
    expect(u).toBeCloseTo(111.32 * Math.cos((45.0 * Math.PI) / 180), 1);
  });
});

describe('fitTransform', () => {
  it('returns null without points', () => {
    expect(fitTransform([], 'xy')).toBeNull();
    expect(fitTransform(null, 'gps')).toBeNull();
  });

  it('1 point: translation', () => {
    const f = fitTransform([{ src: [10, 10], plan: [1, 2] }], 'xy');
    close(f({ u: 10, v: 10 }), [1, 2]);
    close(f({ u: 13, v: 6 }), [4, -2]);
  });

  it('1 gps point: translation in metres, north-up', () => {
    const f = fitTransform([{ src: [45.0, 10.0], plan: [10, -5] }], 'gps');
    close(f({ lat: 45.0, lon: 10.0 }), [10, -5]);
    const p = f({ lat: 45.0001, lon: 10.0 });
    expect(p[0]).toBeCloseTo(10, 3);
    expect(p[1]).toBeCloseTo(-5 + 11.132, 2);
  });

  it('2 points: similarity (rotate 90°, scale 2, shift)', () => {
    // x = -2v + 5, y = 2u + 1
    const g = ([u, v]) => [-2 * v + 5, 2 * u + 1];
    const pts = [[0, 0], [1, 0]].map((s) => ({ src: s, plan: g(s) }));
    const f = fitTransform(pts, 'xy');
    for (const s of [[0, 0], [1, 0], [3, -2], [0.5, 7]]) close(f({ u: s[0], v: s[1] }), g(s));
  });

  it('3+ points: exact affine with shear and non-uniform scale', () => {
    const g = ([u, v]) => [1.5 * u + 0.3 * v - 2, -0.2 * u + 0.8 * v + 4];
    const pts = [[0, 0], [10, 0], [0, 10], [7, 3]].map((s) => ({ src: s, plan: g(s) }));
    const f = fitTransform(pts, 'xy');
    for (const s of [[5, 5], [-3, 12], [100, -40]]) close(f({ u: s[0], v: s[1] }), g(s), 5);
  });

  it('3+ points: least squares averages out noise', () => {
    const g = ([u, v]) => [u + 1, v - 1];
    const noise = [0.1, -0.1, 0.1, -0.1];
    const srcs = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const f = fitTransform(srcs.map((s, i) => ({ src: s, plan: [g(s)[0] + noise[i], g(s)[1]] })), 'xy');
    close(f({ u: 5, v: 5 }), g([5, 5]), 1);
  });

  it('collinear points fall back to the 2-point similarity', () => {
    const pts = [[0, 0], [1, 0], [2, 0]].map((s) => ({ src: s, plan: [s[0] * 2, 0] }));
    const f = fitTransform(pts, 'xy');
    close(f({ u: 3, v: 0 }), [6, 0]);
    close(f({ u: 0, v: 1 }), [0, 2]);
  });

  it('gps with 2 points recovers a rotated plan', () => {
    // plan is rotated 90°: plan x points north
    const o = { lat: 45.0, lon: 10.0 };
    const a = { src: [o.lat, o.lon], plan: [0, 0] };
    const b = { src: [45.0001, o.lon], plan: [11.132, 0] };
    const f = fitTransform([a, b], 'gps');
    const p = f({ lat: 45.00005, lon: 10.0 });
    expect(p[0]).toBeCloseTo(5.566, 2);
    expect(p[1]).toBeCloseTo(0, 3);
  });

  it('returns null for a missing reading', () => {
    expect(fitTransform([{ src: [0, 0], plan: [0, 0] }], 'xy')(null)).toBeNull();
  });
});

describe('overlayUrl', () => {
  const hass = {
    states: { 'image.map': { attributes: { entity_picture: '/api/image_proxy/image.map?token=abc' } }, 'image.none': { attributes: {} } },
    hassUrl: (p) => 'http://ha.local:8123' + p,
  };

  it('builds an absolute url with cache busting', () => {
    expect(overlayUrl(hass, 'image.map')).toBe('http://ha.local:8123/api/image_proxy/image.map?token=abc');
    expect(overlayUrl(hass, 'image.map', 42)).toBe('http://ha.local:8123/api/image_proxy/image.map?token=abc&_t=42');
  });

  it('leaves data: and blob: urls alone (no base, no cache busting)', () => {
    const h = { ...hass, states: { 'image.d': { attributes: { entity_picture: 'data:image/png;base64,AAAA' } } } };
    expect(overlayUrl(h, 'image.d', 42)).toBe('data:image/png;base64,AAAA');
  });

  it('returns null without a picture', () => {
    expect(overlayUrl(hass, 'image.none')).toBeNull();
    expect(overlayUrl(hass, 'image.missing')).toBeNull();
    expect(overlayUrl(null, 'image.map')).toBeNull();
  });
});

describe('calibrationError', () => {
  it('is 0 for exact fits and small samples', () => {
    const g = ([u, v]) => [2 * u + 1, v - 3];
    const pts = [[0, 0], [5, 0], [0, 5], [3, 3]].map((s) => ({ src: s, plan: g(s) }));
    expect(calibrationError(pts, 'xy')).toBeCloseTo(0);
    expect(calibrationError(pts.slice(0, 2), 'xy')).toBe(0);
  });

  it('reports the residual of a noisy fit', () => {
    const pts = [[0, 0], [10, 0], [10, 10], [0, 10]].map((s, i) => ({ src: s, plan: [s[0] + (i % 2 ? 0.5 : -0.5), s[1]] }));
    expect(calibrationError(pts, 'xy')).toBeGreaterThan(0.3);
  });
});

describe('mowerTransform', () => {
  it('treats uncalibrated xy as plan metres', () => {
    expect(mowerTransform({ source: 'xy' })({ u: 2, v: 3 })).toEqual([2, 3]);
  });

  it('needs calibration for gps', () => {
    expect(mowerTransform({ source: 'gps' })).toBeNull();
    const f = mowerTransform({ calibration: [{ src: [45, 10], plan: [1, 2] }] });
    expect(f({ lat: 45, lon: 10 })).toEqual([1, 2]);
  });
});

describe('readTrack', () => {
  const cfg = { source: 'xy', track_attr: 'path' };
  it('reads segments of [u, v] pairs', () => {
    const s = { state: 'x', attributes: { path: [[[1, 2], [3, 4]], [[5, 6], [7, '8']]] } };
    expect(readTrack(s, cfg)).toEqual([[{ u: 1, v: 2 }, { u: 3, v: 4 }], [{ u: 5, v: 6 }, { u: 7, v: 8 }]]);
  });
  it('takes a flat list as one segment', () => {
    expect(readTrack({ state: 'x', attributes: { path: [[1, 2], [3, 4]] } }, cfg)).toEqual([[{ u: 1, v: 2 }, { u: 3, v: 4 }]]);
  });
  it('drops bad points and segments shorter than two points', () => {
    const s = { state: 'x', attributes: { path: [[[1, 2], [null, 4], ['a', 1]], [[1, 1], [2, 2]]] } };
    expect(readTrack(s, cfg)).toEqual([[{ u: 1, v: 1 }, { u: 2, v: 2 }]]);
  });
  it('null without track_attr, for gps, or when the attribute is missing / empty', () => {
    const s = { state: 'x', attributes: { path: [[1, 2], [3, 4]] } };
    expect(readTrack(s, { source: 'xy' })).toBeNull();
    expect(readTrack(s, { source: 'gps', track_attr: 'path' })).toBeNull();
    expect(readTrack({ state: 'x', attributes: { path: [] } }, cfg)).toBeNull();
    expect(readTrack({ state: 'x', attributes: { path: null } }, cfg)).toBeNull();
    expect(readTrack(null, cfg)).toBeNull();
  });
});
