import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { normBokeh, normGrade, cocAt, tiltAt, screenBand, focusBand, TILT_BAND, BOKEH_DEFAULTS, GRADE_DEFAULTS, TILT_FALLOFF } from '../src/finish.js';

describe('normBokeh', () => {
  it('off unless asked for, or with no strength', () => {
    for (const v of [undefined, null, false, 0, 'yes', { strength: 0 }]) expect(normBokeh(v)).toBe(null);
  });
  it('true: the defaults; an object: its valid keys, clamped', () => {
    expect(normBokeh(true)).toEqual({ ...BOKEH_DEFAULTS });
    expect(normBokeh({ strength: 99, range: 0, start: 'x', tilt: 3 })).toEqual({ strength: 20, start: BOKEH_DEFAULTS.start, range: 0.5, tilt: 1 });
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

describe('normGrade', () => {
  it('off unless asked for; true: the defaults; values clamped', () => {
    for (const v of [undefined, null, false, 'yes']) expect(normGrade(v)).toBe(null);
    expect(normGrade(true)).toEqual({ ...GRADE_DEFAULTS });
    expect(normGrade({ saturation: 5, vignette: -1 })).toEqual({ ...GRADE_DEFAULTS, saturation: 2, vignette: 0 });
  });
});

describe('tiltAt', () => {
  it('none inside the band, full a falloff beyond it, scaled by tilt', () => {
    expect(tiltAt(0.5, 0.3, 0.7, 1)).toBe(0);
    expect(tiltAt(0.7 + TILT_FALLOFF, 0.3, 0.7, 1)).toBe(1);
    expect(tiltAt(0.3 - TILT_FALLOFF / 2, 0.3, 0.7, 1)).toBeCloseTo(0.5);
    expect(tiltAt(0, 0.3, 0.7, 0.5)).toBeCloseTo(0.5);
  });
});

describe('screenBand', () => {
  it('the screen heights a box covers, null behind the camera or for an empty box', () => {
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    cam.position.set(0, 0, 10);
    cam.updateMatrixWorld();
    const [y0, y1] = screenBand(new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)), cam);
    expect(y0).toBeLessThan(0.5);
    expect(y1).toBeGreaterThan(0.5);
    expect(y0 + y1).toBeCloseTo(1);
    expect(screenBand(new THREE.Box3(new THREE.Vector3(-1, -1, 11), new THREE.Vector3(1, 1, 12)), cam)).toBe(null);
    expect(screenBand(new THREE.Box3(), cam)).toBe(null);
  });
});

describe('focusBand', () => {
  it('a narrow band around the middle of the rooms, never wider than they are', () => {
    const [a, b] = focusBand([0.2, 0.8]);
    expect(a).toBeCloseTo(0.5 - TILT_BAND);
    expect(b).toBeCloseTo(0.5 + TILT_BAND);
    const [c, d] = focusBand([0.45, 0.55]);
    expect(c).toBeCloseTo(0.45);
    expect(d).toBeCloseTo(0.55);
    expect(focusBand(null)).toBe(null);
  });
});
