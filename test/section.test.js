import { describe, it, expect } from 'bun:test';
import { normSection, sectionPlane, sectionCamera, SECTION_DIRS, sectionDir, sectionPos, sectionAt, sectionRange,
  sectionSide, sectionLevels, unionBox, resolveViews } from '../src/views.ts';
import { buildManifest } from '../src/manifest.ts';

const box = { min: [0, 0, -10], max: [16, 8, 0] }; // centre x 8, plan y 0..10
const close = (a, b) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 6));

describe('normSection', () => {
  it('accepts finite numbers, normalises the normal and scales the constant', () => {
    expect(normSection({ normal: [-2, 0, 0], constant: 14 })).toEqual({ normal: [-1, 0, 0], constant: 7 });
    expect(normSection({ normal: [0, 0, 1], constant: -3 })).toEqual({ normal: [0, 0, 1], constant: -3 });
  });
  it('rejects bad input', () => {
    for (const s of [null, 7, {}, { normal: [0, 0, 0], constant: 1 }, { normal: [1, 0], constant: 1 },
      { normal: [1, 0, NaN], constant: 1 }, { normal: [1, 0, 0], constant: Infinity }, { normal: [1, 0, 0] }, { normal: ['1', 0, 0], constant: 1 }]) {
      expect(normSection(s)).toBeNull();
    }
  });
  it('returns a copy', () => {
    const s = { normal: [1, 0, 0], constant: 2 };
    expect(normSection(s).normal).not.toBe(s.normal);
  });
});

describe('sectionPlane', () => {
  it('defaults to normal (-1,0,0) through the box centre x', () => {
    expect(sectionPlane({}, box)).toEqual({ normal: [-1, 0, 0], constant: 8 });
    expect(sectionPlane(null, box)).toEqual({ normal: [-1, 0, 0], constant: 8 });
  });
  it('uses the layout/YAML section as is (card world), before the model one', () => {
    const toWorld = () => { throw new Error('must not transform'); };
    expect(sectionPlane({ section: { normal: [0, 0, 1], constant: 2 }, modelSection: { normal: [-1, 0, 0], constant: 7 } }, box, toWorld))
      .toEqual({ normal: [0, 0, 1], constant: 2 });
  });
  it('transforms the model section into card world', () => {
    const shift = (p) => ({ normal: p.normal, constant: p.constant + 3 });
    expect(sectionPlane({ modelSection: { normal: [-1, 0, 0], constant: 7 } }, box, shift)).toEqual({ normal: [-1, 0, 0], constant: 10 });
    expect(sectionPlane({ modelSection: { normal: [-1, 0, 0], constant: 7 } }, box)).toEqual({ normal: [-1, 0, 0], constant: 7 });
  });
  it('ignores invalid sections', () => {
    expect(sectionPlane({ section: { normal: [0, 0, 0], constant: 1 }, modelSection: 'x' }, box)).toEqual({ normal: [-1, 0, 0], constant: 8 });
  });
});

describe('sectionCamera', () => {
  it('looks back at the cut face from the removed side', () => {
    const plane = { normal: [-1, 0, 0], constant: 7 }; // keeps x <= 7
    const { position, target } = sectionCamera(plane, box);
    close(target, [7, 3.6, -5]);
    const diag = Math.hypot(16, 8, 10);
    expect(position[0]).toBeCloseTo(7 + Math.max(20, 1.3 * diag), 6);
    expect(position[1]).toBeGreaterThan(target[1]);
    expect(position[2]).toBeCloseTo(-5, 6);
    expect(sectionSide(plane, position)).toBeLessThan(0); // camera on the removed side
  });
  it('works for a north/south cut', () => {
    const plane = sectionAt([0, 0, 1], 4); // plan y = 4 -> z = -4
    const { position, target } = sectionCamera(plane, box);
    close(target, [8, 3.6, -4]);
    expect(position[2]).toBeLessThan(target[2]);
    expect(sectionSide(plane, position)).toBeLessThan(0);
  });
  it('uses at least 20 m', () => {
    const small = { min: [0, 0, 0], max: [1, 1, 1] };
    const { position, target } = sectionCamera({ normal: [1, 0, 0], constant: -0.5 }, small);
    expect(target[0] - position[0]).toBeCloseTo(20, 6);
  });
});

describe('section directions and slider position', () => {
  it('has the four directions, labelled by the half they keep', () => {
    expect(SECTION_DIRS.map((d) => [d.id, d.label, d.normal])).toEqual([
      ['west', 'Keep west half', [-1, 0, 0]], ['east', 'Keep east half', [1, 0, 0]],
      ['north', 'Keep north half', [0, 0, -1]], ['south', 'Keep south half', [0, 0, 1]],
    ]);
  });
  it('each direction keeps the half its label says (world z = -plan y)', () => {
    const at = { west: [-5, 0, 0], east: [5, 0, 0], north: [0, 0, -5], south: [0, 0, 5] };
    const opposite = { west: 'east', east: 'west', north: 'south', south: 'north' };
    for (const d of SECTION_DIRS) {
      const p = { normal: d.normal, constant: 0 };
      expect(sectionSide(p, at[d.id])).toBeGreaterThan(0);
      expect(sectionSide(p, at[opposite[d.id]])).toBeLessThan(0);
    }
  });
  it('picks the closest direction', () => {
    expect(sectionDir([-1, 0, 0]).id).toBe('west');
    expect(sectionDir([0.9, 0, 0.1]).id).toBe('east');
    expect(sectionDir([0, 0, 1]).id).toBe('south');
    expect(sectionDir([0.1, 0, -0.9]).id).toBe('north');
  });
  it('position round-trips: x for east-west normals, plan y (north) for north-south', () => {
    for (const d of SECTION_DIRS) {
      const p = sectionAt(d.normal, 3.25);
      expect(sectionPos(p)).toBeCloseTo(3.25, 9);
    }
    expect(sectionAt([-1, 0, 0], 7)).toEqual({ normal: [-1, 0, 0], constant: 7 });
    expect(sectionAt([1, 0, 0], 7)).toEqual({ normal: [1, 0, 0], constant: -7 });
    // north-south: plane through world z = -4 (plan y 4)
    const ns = sectionAt([0, 0, 1], 4);
    expect(sectionSide(ns, [0, 0, -4])).toBeCloseTo(0, 9);
  });
  it('range is the box along the axis', () => {
    expect(sectionRange([-1, 0, 0], box)).toEqual([0, 16]);
    expect(sectionRange([0, 0, -1], box)).toEqual([0, 10]);
  });
  it('sectionSide is >= 0 on the kept side', () => {
    const p = { normal: [-1, 0, 0], constant: 7 };
    expect(sectionSide(p, [6, 0, 0])).toBeGreaterThan(0);
    expect(sectionSide(p, [8, 0, 0])).toBeLessThan(0);
  });
});

describe('section in manifest and resolveViews', () => {
  const tree = (roots) => ({ roots: () => roots, children: (n) => n.children || [], name: (n) => n.name || '', extras: (n) => n.extras || {}, parent: () => null });
  it('manifest reads a valid section only', () => {
    const root = { name: 'Scene', extras: { fp: { views: [
      { id: 'a', section: { normal: [-2, 0, 0], constant: 14 } },
      { id: 'b', section: { normal: [0, 0, 0], constant: 1 } },
      { id: 'c' },
    ] } } };
    const m = buildManifest(tree([root]));
    expect(m.views[0].section).toEqual({ normal: [-1, 0, 0], constant: 7 });
    expect('section' in m.views[1]).toBe(false);
    expect('section' in m.views[2]).toBe(false);
  });
  it('resolveViews: model section separate, YAML wins over layout, copies', () => {
    const ls = { normal: [0, 0, 1], constant: 2 }, ys = { normal: [1, 0, 0], constant: -3 };
    const manifest = { levels: [], views: [{ id: 'a', show: [], hide: [], section: { normal: [-1, 0, 0], constant: 7 } }, { id: 'b', show: [], hide: [] }] };
    const v = resolveViews({ manifest, haFloors: [], layoutViews: { a: { section: ls }, b: { section: ls } }, yamlViews: { b: { section: ys } }, savedLevels: {} });
    expect(v[0].modelSection).toEqual({ normal: [-1, 0, 0], constant: 7 });
    expect(v[0].section).toEqual(ls);
    expect(v[0].section.normal).not.toBe(ls.normal);
    expect(v[1].section).toEqual(ys);
    expect(v[1].modelSection).toBeNull();
    const w = resolveViews({ manifest, haFloors: [], layoutViews: { a: { section: { normal: [0, 0, 0], constant: 1 } } }, yamlViews: {}, savedLevels: {} });
    expect(w[0].section).toBeNull();
  });
});

describe('section box', () => {
  it('uses storey and basement levels only', () => {
    const levels = [{ id: 'g', role: 'storey' }, { id: 'b', role: 'basement' }, { id: 'ext', role: 'exterior' }, { id: 'roof', role: 'roof' }, { id: 'x' }];
    expect(sectionLevels(levels).map((l) => l.id)).toEqual(['g', 'b']);
    expect(sectionLevels(null)).toEqual([]);
  });
  it('unions boxes, skipping empty ones; null when none', () => {
    expect(unionBox([{ min: [0, 0, 0], max: [1, 1, 1] }, null, { min: [-1, 2, 0], max: [0, 3, 5] }])).toEqual({ min: [-1, 0, 0], max: [1, 3, 5] });
    expect(unionBox([])).toBeNull();
  });
});
