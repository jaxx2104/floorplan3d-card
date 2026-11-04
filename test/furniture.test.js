import { describe, it, expect } from 'bun:test';
import * as THREE from 'three';
import { isWhiteable, rememberColor, paintFurniture } from '../src/furniture.ts';

const mat = (color, extras) => {
  const m = new THREE.MeshStandardMaterial({ color });
  if (extras) m.userData = { ...extras };
  return m;
};

describe('isWhiteable', () => {
  it('needs three finite numbers in fp_white', () => {
    expect(isWhiteable(mat(0x884422, { fp_white: [0.9, 0.9, 0.9] }))).toBe(true);
    expect(isWhiteable(mat(0x884422))).toBe(false);
    expect(isWhiteable(mat(0x884422, { fp_white: [0.9, 0.9] }))).toBe(false);
    expect(isWhiteable(mat(0x884422, { fp_white: [0.9, 'x', 0.9] }))).toBe(false);
    expect(isWhiteable(null)).toBe(false);
  });
});

describe('paintFurniture', () => {
  it('turns tagged materials white and back, leaves the rest alone, counts shared materials once', () => {
    const oak = mat(0x8a5a2b, { fp_white: [0.9, 0.9, 0.9] });
    const leaf = mat(0x336622);
    const root = new THREE.Group();
    for (const m of [oak, oak, leaf]) root.add(new THREE.Mesh(new THREE.BoxGeometry(), m));
    for (const m of [oak, leaf]) rememberColor(m);
    const before = oak.color.clone();
    const leafBefore = leaf.color.clone();
    expect(paintFurniture(root, true)).toBe(1);
    expect(oak.color.toArray()).toEqual([0.9, 0.9, 0.9]);
    expect(leaf.color.equals(leafBefore)).toBe(true);
    expect(paintFurniture(root, false)).toBe(1);
    expect(oak.color.equals(before)).toBe(true);
  });
  it('remembers the modelled colour only once', () => {
    const m = mat(0x8a5a2b, { fp_white: [0.9, 0.9, 0.9] });
    rememberColor(m);
    const kept = m.userData.fpColor.clone();
    m.color.setRGB(0.9, 0.9, 0.9);
    rememberColor(m);
    expect(m.userData.fpColor.equals(kept)).toBe(true);
  });
});
