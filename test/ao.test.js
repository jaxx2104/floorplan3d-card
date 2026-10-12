import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { normAo, AO_DEFAULTS } from '../src/ao.js';
import { occludes } from '../src/depth-pass.js';

describe('normAo', () => {
  it('off unless asked for', () => {
    for (const v of [undefined, null, false, 0, 'yes']) expect(normAo(v)).toBe(null);
  });
  it('true: the defaults; an object: its valid keys, clamped', () => {
    expect(normAo(true)).toEqual({ ...AO_DEFAULTS });
    expect(normAo({ intensity: 2 })).toEqual({ ...AO_DEFAULTS, intensity: 2 });
    expect(normAo({ radius: 99, resolution: 0, intensity: 'x' })).toEqual({ intensity: AO_DEFAULTS.intensity, radius: 3, resolution: 0.25 });
  });
});

describe('occludes', () => {
  const mesh = (mat, userData = {}) => Object.assign(new THREE.Mesh(new THREE.BufferGeometry(), mat), { userData });
  it('opaque meshes that write depth', () => {
    expect(occludes(mesh(new THREE.MeshStandardMaterial()))).toBe(true);
    expect(occludes(mesh([new THREE.MeshStandardMaterial(), new THREE.MeshBasicMaterial()]))).toBe(true);
  });
  it('not transparent, depth-less, glass, helper or see-through meshes, nor sprites / points / lines', () => {
    expect(occludes(mesh(new THREE.MeshStandardMaterial({ transparent: true })))).toBe(false);
    expect(occludes(mesh(new THREE.MeshStandardMaterial({ depthWrite: false })))).toBe(false);
    expect(occludes(mesh(new THREE.MeshPhysicalMaterial({ transmission: 1 })))).toBe(false);
    expect(occludes(mesh([new THREE.MeshStandardMaterial(), new THREE.MeshBasicMaterial({ transparent: true })]))).toBe(false);
    expect(occludes(mesh(new THREE.MeshStandardMaterial(), { helper: true }))).toBe(false);
    expect(occludes(mesh(new THREE.MeshStandardMaterial(), { seeThrough: true }))).toBe(false);
    expect(occludes(new THREE.Sprite())).toBe(false);
    expect(occludes(new THREE.Points())).toBe(false);
    expect(occludes(new THREE.Line())).toBe(false);
  });
});
