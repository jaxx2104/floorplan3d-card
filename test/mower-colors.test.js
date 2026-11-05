import { describe, it, expect } from 'vitest';
import { parseLayout } from '../src/schema/layout.ts';
import { processMap, findBlob, colorList, addColorPatch, removeColorPatch, MAX_COLORS } from '../src/mower-image.ts';

const BG1 = [30, 70, 35], BG2 = [60, 110, 50], RED1 = [255, 40, 30], RED2 = [200, 20, 60];
function image(w, h, c) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) a.set([...c, 255], i * 4);
  return a;
}
function rect(a, w, x0, y0, rw, rh, c) {
  for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) a.set([...c, 255], (y * w + x) * 4);
}

describe('colour lists', () => {
  it('reads the list (the v1 single colour is migrated into it on load)', () => {
    expect(colorList({ bg_colors: [[1, 2, 3], [7, 8, 9]] }, 'bg')).toEqual([[1, 2, 3], [7, 8, 9]]);
    expect(colorList({ colors: [[4, 5, 6], 'x'] })).toEqual([[4, 5, 6]]);
    expect(colorList({ bg_colors: [] }, 'bg')).toEqual([]);
    expect(colorList(null, 'bg')).toEqual([]);
    const m = (mower) => parseLayout({ mower }).value.mower;
    expect(m({ overlay: { bg_color: [1, 2, 3] }, image: { color: [4, 5, 6] } })).toEqual({ overlay: { bg_colors: [[1, 2, 3]] }, image: { colors: [[4, 5, 6]] } });
    expect(m({ overlay: { bg_colors: [[1, 2, 3], [7, 8, 9]], bg_color: [0, 0, 0] } }).overlay).toEqual({ bg_colors: [[1, 2, 3], [7, 8, 9]] });
    expect(m({ overlay: { bg_colors: [], bg_color: [0, 0, 0] } }).overlay).toEqual({ bg_colors: [] });
  });
  it('adds (writes the list), no duplicates, at most 4', () => {
    expect(addColorPatch({ bg_colors: [[1, 2, 3]] }, 'bg', [4, 5, 6])).toEqual({ bg_colors: [[1, 2, 3], [4, 5, 6]] });
    expect(addColorPatch({ colors: [[1, 2, 3]] }, null, [1, 2, 3]).colors).toEqual([[1, 2, 3]]);
    let o = {};
    for (let i = 0; i < 6; i++) o = { ...o, ...addColorPatch(o, 'mowed', [i, i, i]) };
    expect(o.mowed_colors.length).toBe(MAX_COLORS);
    expect(o.mowed_colors[MAX_COLORS - 1]).toEqual([5, 5, 5]);
  });
  it('removes by index', () => {
    expect(removeColorPatch({ nomow_colors: [[1, 1, 1], [2, 2, 2]] }, 'nomow', 0)).toEqual({ nomow_colors: [[2, 2, 2]] });
  });
});

describe('several colours per category', () => {
  it('a two-shade background is fully keyed', () => {
    const w = 40, h = 20, a = image(w, h, BG1);
    rect(a, w, 20, 0, 20, 20, BG2);
    const one = processMap(a, w, h, { bg: { colors: [BG1], tolerance: 10 } });
    expect(one.background).toBe(400);
    const r = processMap(a, w, h, { bg: { colors: [BG1, BG2], tolerance: 10 } });
    expect(r.background).toBe(800);
    for (let i = 0; i < w * h; i++) expect(r.data[i * 4 + 3]).toBe(0);
  });
  it('a two-shade icon is found as one blob', () => {
    const w = 40, h = 30, a = image(w, h, BG1);
    rect(a, w, 10, 10, 3, 6, RED1);
    rect(a, w, 13, 10, 3, 6, RED2);
    const b = findBlob(a, w, h, [RED1, RED2], 20);
    expect(b).toMatchObject({ count: 36 });
    expect(b.px).toBeCloseTo(13, 5);
    expect(b.py).toBeCloseTo(13, 5);
    expect(findBlob(a, w, h, RED1, 20).count).toBe(18); // one colour still works
  });
  it('the icon mask hides both shades', () => {
    const w = 40, h = 30, a = image(w, h, BG1);
    rect(a, w, 10, 10, 3, 6, RED1);
    rect(a, w, 13, 10, 3, 6, RED2);
    const r = processMap(a, w, h, { bg: { colors: [BG1], tolerance: 10 }, iconBlob: { px: 13, py: 13, count: 36, colors: [RED1, RED2], tolerance: 20 }, dilate: 0 });
    expect(r.icon).toBe(36);
  });
});
