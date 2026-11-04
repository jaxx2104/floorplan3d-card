// Card option furniture: a model with real furniture colours can switch to a white model look. Each material
// that may turn white carries glTF extras fp_white = [r, g, b] (linear, 0..1), the colour of the white look
// (GLTFLoader puts material extras in material.userData).

import type * as THREE from 'three';
import { isMesh, meshMaterials } from './view/core.ts';

type ColorMaterial = THREE.Material & { color: THREE.Color };

// A material the option can whiten.
export const isWhiteable = (mat: THREE.Material | null | undefined): mat is ColorMaterial => !!mat && !!(mat as Partial<ColorMaterial>).color
  && Array.isArray(mat.userData && mat.userData.fp_white)
  && mat.userData.fp_white.length === 3 && (mat.userData.fp_white as unknown[]).every((c) => Number.isFinite(Number(c)));

// Keep the modelled colour of a whiteable material (once, at load) so it can come back.
export function rememberColor(mat: THREE.Material | null | undefined): void {
  if (isWhiteable(mat) && !mat.userData.fpColor) mat.userData.fpColor = mat.color.clone();
}

// Paint every remembered material under root white (fp_white) or back in its own colour. -> materials touched.
export function paintFurniture(root: THREE.Object3D, white: boolean): number {
  const seen = new Set<THREE.Material>();
  root.traverse((o) => {
    if (!isMesh(o)) return;
    for (const mat of meshMaterials(o) as ColorMaterial[]) {
      if (!mat || seen.has(mat) || !mat.userData || !mat.userData.fpColor) continue;
      seen.add(mat);
      if (white) mat.color.setRGB(...(mat.userData.fp_white.map(Number) as [number, number, number]));
      else mat.color.copy(mat.userData.fpColor);
    }
  });
  return seen.size;
}
