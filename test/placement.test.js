import { describe, it, expect } from 'bun:test';
import {
  signedArea, centroid, pointInPolygon, ruleFor, autoPlace, snap, domainPriority, SKIP_DOMAINS,
} from '../src/placement.ts';

const square = [[0, 0], [4, 0], [4, 3], [0, 3]]; // CCW, 4 x 3
const squareCW = [...square].reverse();
const L = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]]; // centroid lies outside the floor

const inside = (p, poly) => pointInPolygon([p.x, p.y], poly);

describe('geometry', () => {
  it('signedArea is positive for CCW and negative for CW', () => {
    expect(signedArea(square)).toBeCloseTo(12);
    expect(signedArea(squareCW)).toBeCloseTo(-12);
  });

  it('centroid of a rectangle is its middle, regardless of winding', () => {
    expect(centroid(square)).toEqual([2, 1.5]);
    const [x, y] = centroid(squareCW);
    expect(x).toBeCloseTo(2);
    expect(y).toBeCloseTo(1.5);
  });

  it('centroid of a degenerate polygon falls back to the vertex mean', () => {
    expect(centroid([[0, 0], [2, 0], [4, 0]])).toEqual([2, 0]);
  });

  it('pointInPolygon handles concave shapes', () => {
    expect(pointInPolygon([1, 1], L)).toBe(true);
    expect(pointInPolygon([4, 4], L)).toBe(false);
    expect(pointInPolygon([5, 1], L)).toBe(true);
    expect(pointInPolygon([-1, 1], L)).toBe(false);
  });

  it('snap rounds to the grid', () => {
    expect(snap(1.234)).toBeCloseTo(1.25);
    expect(snap(1.22)).toBeCloseTo(1.2);
    expect(snap(0.37, 0.25)).toBeCloseTo(0.25);
  });
});

describe('type rules', () => {
  it('maps domains and device classes to anchors', () => {
    expect(ruleFor('light')).toMatchObject({ anchor: 'center', z: 'ceiling' });
    expect(ruleFor('binary_sensor', 'smoke').anchor).toBe('center');
    expect(ruleFor('binary_sensor', 'motion').anchor).toBe('corner');
    expect(ruleFor('binary_sensor', 'door').anchor).toBe('door');
    expect(ruleFor('binary_sensor', 'window')).toMatchObject({ anchor: 'wall', z: 1.2 });
    expect(ruleFor('binary_sensor', 'moisture').anchor).toBe('wall');
    expect(ruleFor('switch').anchor).toBe('door');
    expect(ruleFor('something_new')).toEqual({ anchor: 'wall', z: 1.2 });
  });

  it('ranks lights above sensors and unknown domains last', () => {
    expect(domainPriority('light')).toBeLessThan(domainPriority('sensor'));
    expect(domainPriority('nope')).toBe(99);
    expect(SKIP_DOMAINS.has('update')).toBe(true);
  });
});

describe('autoPlace', () => {
  const room = { id: 'r', polygon: square, doors: [[2, 0]] };

  it('returns nothing for a room without a usable polygon', () => {
    expect(autoPlace({ polygon: [[0, 0], [1, 1]] }, [{ id: 'a', domain: 'light' }], 2.7).size).toBe(0);
  });

  it('puts ceiling devices just under the ceiling, inside the room', () => {
    const out = autoPlace(room, [{ id: 'l1', domain: 'light' }, { id: 'l2', domain: 'light' }], 2.7);
    for (const p of out.values()) {
      expect(p.z).toBeCloseTo(2.62);
      expect(p.auto).toBe(true);
      expect(inside(p, square)).toBe(true);
    }
    const [a, b] = [...out.values()];
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(0.5);
  });

  it('uses a default room height when none is given', () => {
    const p = autoPlace(room, [{ id: 'l', domain: 'light' }]).get('l');
    expect(Number.isFinite(p.z)).toBe(true);
    expect(p.z).toBeGreaterThan(2);
  });

  it('finds ceiling spots inside concave rooms whose centroid is outside', () => {
    const out = autoPlace({ polygon: L }, [1, 2, 3].map((i) => ({ id: 'l' + i, domain: 'light' })), 2.7);
    expect(out.size).toBe(3);
    for (const p of out.values()) expect(inside(p, L)).toBe(true);
  });

  it('spreads wall devices around the whole perimeter, inset into the room', () => {
    for (const poly of [square, squareCW]) {
      const markers = Array.from({ length: 6 }, (_, i) => ({ id: 's' + i, domain: 'sensor' }));
      const pts = [...autoPlace({ polygon: poly }, markers, 2.7).values()];
      for (const p of pts) {
        expect(inside(p, poly)).toBe(true);
        expect(p.z).toBe(1.5);
      }
      // all distinct: nobody piles up at the end of the perimeter
      const keys = new Set(pts.map((p) => p.x.toFixed(2) + ',' + p.y.toFixed(2)));
      expect(keys.size).toBe(6);
    }
  });

  it('never parks the last wall device on a corner when there are many', () => {
    const markers = Array.from({ length: 10 }, (_, i) => ({ id: 's' + i, domain: 'sensor' }));
    for (const p of autoPlace({ polygon: square }, markers, 2.7).values()) {
      const nearest = Math.min(...square.map(([x, y]) => Math.hypot(p.x - x, p.y - y)));
      expect(nearest).toBeGreaterThan(0.3);
    }
  });

  it('places door devices close to the door', () => {
    const out = autoPlace(room, [{ id: 'sw', domain: 'switch' }, { id: 'lk', domain: 'lock' }], 2.7);
    for (const p of out.values()) {
      expect(inside(p, square)).toBe(true);
      expect(Math.hypot(p.x - 2, p.y - 0)).toBeLessThan(1.5);
    }
  });

  it('puts corner devices near distinct corners', () => {
    const out = autoPlace(room, [0, 1, 2].map((i) => ({ id: 'm' + i, domain: 'binary_sensor', deviceClass: 'motion' })), 2.7);
    const pts = [...out.values()];
    pts.forEach((p, i) => {
      expect(inside(p, square)).toBe(true);
      expect(Math.hypot(p.x - square[i][0], p.y - square[i][1])).toBeLessThan(0.6);
    });
  });

  it('is deterministic regardless of input order', () => {
    const ms = [{ id: 'b', domain: 'sensor' }, { id: 'a', domain: 'sensor' }, { id: 'c', domain: 'light' }];
    const a = autoPlace(room, ms, 2.7);
    const b = autoPlace(room, [...ms].reverse(), 2.7);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
});
