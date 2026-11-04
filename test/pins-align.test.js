import { describe, it, expect } from 'vitest';
import { transformPoint, inverseTransformPoint } from '../src/bindings.ts';
import { realignPins, setPin } from '../src/editor.ts';

const align = { position: [3, -2, 0.5], rotation: 30, scale: 2 };

describe('inverseTransformPoint', () => {
  it('round-trips transformPoint within 1e-9', () => {
    for (const p of [[0, 0], [1.5, -2.25], [-7, 4], [10, 10]]) {
      const back = inverseTransformPoint(transformPoint(p, align), align);
      expect(back[0]).toBeCloseTo(p[0], 9);
      expect(back[1]).toBeCloseTo(p[1], 9);
      const fwd = transformPoint(inverseTransformPoint(p, align), align);
      expect(fwd[0]).toBeCloseTo(p[0], 9);
      expect(fwd[1]).toBeCloseTo(p[1], 9);
    }
  });

  it('defaults to identity', () => {
    expect(inverseTransformPoint([1, 2])).toEqual([1, 2]);
    expect(inverseTransformPoint([1, 2], {})).toEqual([1, 2]);
  });
});

describe('setPin', () => {
  it('keeps on_model only when set', () => {
    expect(setPin({}, 'a', { x: 1, y: 1, z: 1, floor_id: 'g' }).pins.a).not.toHaveProperty('on_model');
    expect(setPin({}, 'a', { x: 1, y: 1, z: 1, floor_id: 'g', on_model: true }).pins.a.on_model).toBe(true);
  });
});

describe('realignPins', () => {
  const layout = {
    rooms: [],
    pins: {
      a: { x: 1, y: 0, z: 2, floor_id: 'g', on_model: true },
      b: { x: 1, y: 0, z: 2, floor_id: 'g' },
    },
  };

  it('maps on_model pins through old inverse then new transform', () => {
    const oldA = { position: [0, 0, 0], rotation: 0, scale: 1 };
    const newA = { position: [0, 0, 0], rotation: 90, scale: 1 };
    const out = realignPins(layout, oldA, newA);
    expect(out.pins.a.x).toBeCloseTo(0, 6);
    expect(out.pins.a.y).toBeCloseTo(1, 6);
    expect(out.pins.a.z).toBe(2);
    expect(out.pins.a.on_model).toBe(true);
    expect(out.pins.a.floor_id).toBe('g');
    expect(out.pins.b).toBe(layout.pins.b);
    expect(layout.pins.a.x).toBe(1); // input untouched
  });

  it('follows offset, rotation and scale; z scales with scale', () => {
    const oldA = { position: [1, 1, 0], rotation: 10, scale: 1 };
    const newA = align;
    const out = realignPins(layout, oldA, newA);
    const exp = transformPoint(inverseTransformPoint([1, 0], oldA), newA);
    expect(out.pins.a.x).toBeCloseTo(exp[0], 3);
    expect(out.pins.a.y).toBeCloseTo(exp[1], 3);
    expect(out.pins.a.z).toBeCloseTo(4, 6);
  });

  it('returns the same layout when nothing changes or no pins follow the model', () => {
    const same = { position: [0, 0, 0], rotation: 0, scale: 1 };
    expect(realignPins(layout, same, { ...same })).toBe(layout);
    const plain = { pins: { b: layout.pins.b } };
    expect(realignPins(plain, same, align)).toBe(plain);
    expect(realignPins({}, same, align)).toEqual({});
  });
});
