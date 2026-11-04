import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { animOf, screenOn, frameAt, collectScreens, showFrame, setScreenOn } from '../src/screens.ts';

const screenMat = (extras) => {
  const m = new THREE.MeshStandardMaterial({ color: 0x050505, emissive: 0xffffff });
  m.emissiveMap = new THREE.Texture();
  m.userData = { fp_anim: extras };
  return m;
};

describe('animOf', () => {
  it('reads frames, fps, entity and above', () => {
    expect(animOf(screenMat({ frames: 8, fps: 2, entity: 'light.x' }))).toEqual({ frames: 8, fps: 2, entity: 'light.x', above: null });
    expect(animOf(screenMat({ frames: 8, fps: 2, entity: 'sensor.p', above: 230 })).above).toBe(230);
  });
  it('rejects a still or broken spec', () => {
    expect(animOf(screenMat({ frames: 1, fps: 2 }))).toBe(null);
    expect(animOf(screenMat({ frames: 8, fps: 0 }))).toBe(null);
    expect(animOf(new THREE.MeshStandardMaterial())).toBe(null);
    expect(animOf(null)).toBe(null);
  });
});

describe('screenOn', () => {
  const st = (state) => ({ 'light.x': { state }, 'sensor.p': { state } });
  it('follows on / off, or a number above the threshold', () => {
    expect(screenOn({ entity: 'light.x', above: null }, st('on'))).toBe(true);
    expect(screenOn({ entity: 'light.x', above: null }, st('off'))).toBe(false);
    expect(screenOn({ entity: 'sensor.p', above: 230 }, st('280.5'))).toBe(true);
    expect(screenOn({ entity: 'sensor.p', above: 230 }, st('170'))).toBe(false);
    expect(screenOn({ entity: 'sensor.p', above: 230 }, st('unavailable'))).toBe(false);
  });
  it('is off for a missing entity and on without one', () => {
    expect(screenOn({ entity: 'light.gone', above: null }, {})).toBe(false);
    expect(screenOn({ entity: null, above: null }, {})).toBe(true);
  });
});

describe('frames', () => {
  it('steps at fps and wraps', () => {
    const a = { frames: 4, fps: 2 };
    expect([0, 0.4, 0.5, 1.9, 2.0].map((t) => frameAt(a, t))).toEqual([0, 0, 1, 3, 0]);
  });
  it('moves the texture offset, darkens when off and comes back', () => {
    const m = screenMat({ frames: 4, fps: 2, entity: 'light.x' });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), m), new THREE.Mesh(new THREE.BoxGeometry(), m));
    const [s, ...rest] = collectScreens(root);
    expect(rest).toEqual([]);
    expect(showFrame(s, 2)).toBe(true);
    expect(showFrame(s, 2)).toBe(false);
    expect(m.emissiveMap.offset.y).toBeCloseTo(0.5);
    expect(setScreenOn(s, false)).toBe(true);
    expect(m.emissive.getHex()).toBe(0);
    expect(m.emissiveMap.offset.y).toBe(0);
    expect(setScreenOn(s, true)).toBe(true);
    expect(m.emissive.getHex()).toBe(0xffffff);
  });
});
