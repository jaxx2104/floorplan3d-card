import { describe, it, expect } from 'vitest';
import { normTopCamera, zoomToFor, pivotCamera, rayPlaneY, orthoZoom, topZoom, resolveViews } from '../src/views.js';
import { buildManifest } from '../src/manifest.js';

describe('normTopCamera', () => {
  it('accepts a plan centre and a positive zoom (copied)', () => {
    const c = { center: [1.5, -2], zoom: 2 };
    expect(normTopCamera(c)).toEqual({ center: [1.5, -2], zoom: 2 });
    expect(normTopCamera(c).center).not.toBe(c.center);
  });
  it('rejects bad input', () => {
    for (const c of [null, 3, {}, { center: [1, 2] }, { center: [1, 2], zoom: 0 }, { center: [1, 2], zoom: -1 },
      { center: [1], zoom: 1 }, { center: [1, NaN], zoom: 1 }, { center: [1, 2], zoom: Infinity }, { center: ['1', 2], zoom: 1 }]) {
      expect(normTopCamera(c)).toBeNull();
    }
  });
});

describe('zoomToFor', () => {
  it('defaults to center', () => {
    expect(zoomToFor(null, {})).toBe('center');
    expect(zoomToFor({}, undefined)).toBe('center');
  });
  it('view wins over the card option; invalid values are ignored', () => {
    expect(zoomToFor({}, { zoom_to: 'cursor' })).toBe('cursor');
    expect(zoomToFor({ zoom_to: 'center' }, { zoom_to: 'cursor' })).toBe('center');
    expect(zoomToFor({ zoom_to: 'cursor' }, {})).toBe('cursor');
    expect(zoomToFor({ zoom_to: 'mouse' }, { zoom_to: 'cursor' })).toBe('cursor');
    expect(zoomToFor({ zoom_to: 'mouse' }, { zoom_to: 'x' })).toBe('center');
  });
});

describe('pivotCamera', () => {
  it('moves target to the point and the position by the same delta', () => {
    const cam = { position: [10, 8, 10], target: [0, 0, 0] };
    expect(pivotCamera(cam, [2, 1, -3])).toEqual({ position: [12, 9, 7], target: [2, 1, -3] });
  });
  it('keeps the view direction and distance; rounds to cm', () => {
    const r = pivotCamera({ position: [1, 1, 1], target: [0, 0, 0] }, [0.123456, 0, 0]);
    expect(r).toEqual({ position: [1.12, 1, 1], target: [0.12, 0, 0] });
  });
});

describe('rayPlaneY', () => {
  it('intersects a downward ray with a horizontal plane', () => {
    expect(rayPlaneY([0, 10, 0], [1, -1, 0], 3)).toEqual([7, 3, 0]);
  });
  it('null when parallel or the plane is behind', () => {
    expect(rayPlaneY([0, 10, 0], [1, 0, 0], 3)).toBeNull();
    expect(rayPlaneY([0, 10, 0], [0, 1, 0], 3)).toBeNull();
  });
});

describe('top zoom <-> ortho zoom', () => {
  it('stored zoom is independent of the fitted ortho half height', () => {
    expect(orthoZoom(1, 10)).toBe(1);
    expect(orthoZoom(2, 5)).toBe(1);
    expect(topZoom(orthoZoom(1.7, 13), 13)).toBeCloseTo(1.7, 9);
  });
});

describe('resolveViews camera_top / zoom_to', () => {
  const haFloors = [{ id: 'g', name: 'Ground' }];
  it('YAML > layout, validated and copied', () => {
    const ct = { center: [1, 2], zoom: 1.5 };
    const r = resolveViews({ manifest: null, haFloors, layoutViews: { g: { camera_top: ct, zoom_to: 'cursor' } }, yamlViews: {}, savedLevels: {} });
    const g = r.find((v) => v.id === 'g');
    expect(g.camera_top).toEqual(ct);
    expect(g.camera_top.center).not.toBe(ct.center);
    expect(g.zoom_to).toBe('cursor');
    const y = resolveViews({ manifest: null, haFloors, layoutViews: { g: { camera_top: ct, zoom_to: 'cursor' } },
      yamlViews: { g: { camera_top: { center: [5, 5], zoom: 3 }, zoom_to: 'center' } }, savedLevels: {} }).find((v) => v.id === 'g');
    expect(y.camera_top).toEqual({ center: [5, 5], zoom: 3 });
    expect(y.zoom_to).toBe('center');
  });
  it('null when missing or invalid', () => {
    const g = resolveViews({ manifest: null, haFloors, layoutViews: { g: { camera_top: { center: [1, 2], zoom: 0 }, zoom_to: 'x' } }, yamlViews: {}, savedLevels: {} })
      .find((v) => v.id === 'g');
    expect(g.camera_top).toBeNull();
    expect(g.zoom_to).toBeNull();
  });
  it('falls back to the model view camera_top', () => {
    const manifest = { levels: [], views: [{ id: 'm', label: 'M', show: [], hide: [], camera: null, camera_top: { center: [3, 4], zoom: 2 } }] };
    const m = resolveViews({ manifest, haFloors, layoutViews: {}, yamlViews: {}, savedLevels: {} })[0];
    expect(m.camera_top).toEqual({ center: [3, 4], zoom: 2 });
    const o = resolveViews({ manifest, haFloors, layoutViews: { m: { camera_top: { center: [0, 0], zoom: 1 } } }, yamlViews: {}, savedLevels: {} })[0];
    expect(o.camera_top).toEqual({ center: [0, 0], zoom: 1 });
  });
});

describe('manifest camera_top', () => {
  const tree = (roots) => {
    const parent = new Map();
    const walk = (n) => (n.children || []).forEach((c) => { parent.set(c, n); walk(c); });
    roots.forEach(walk);
    return {
      roots: () => roots, children: (n) => n.children || [], name: (n) => n.name || '',
      extras: (n) => n.extras || {}, parent: (n) => parent.get(n) || null,
    };
  };
  it('reads a valid camera_top, warns on an invalid one', () => {
    const root = { name: 'Scene', extras: { fp: { views: [
      { id: 'a', camera_top: { center: [1, 2], zoom: 2 } },
      { id: 'b', camera_top: { center: [1, 2], zoom: -2 } },
      { id: 'c' },
    ] } } };
    const m = buildManifest(tree([root]));
    expect(m.views[0].camera_top).toEqual({ center: [1, 2], zoom: 2 });
    expect('camera_top' in m.views[1]).toBe(false);
    expect('camera_top' in m.views[2]).toBe(false);
    expect(m.warnings.join('\n')).toMatch(/view "b": invalid camera_top/);
  });
});

import { orbitStep } from '../src/view.js';
describe('orbitStep', () => {
  it('turns around the target on the ground plane, keeping height and distance', () => {
    const pos = { x: 2, y: 5, z: 0 };
    orbitStep(pos, { x: 1, y: 0, z: 0 }, Math.PI / 2);
    expect(pos.x).toBeCloseTo(1);
    expect(pos.z).toBeCloseTo(-1);
    expect(pos.y).toBe(5);
  });
});
