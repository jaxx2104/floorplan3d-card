// Card option furniture: a model with real furniture colours can switch to a white model look. Each material
// that may turn white carries glTF extras fp_white = [r, g, b] (linear, 0..1), the colour of the white look
// (GLTFLoader puts material extras in material.userData).

// A material the option can whiten.
export const isWhiteable = (mat) => !!mat && !!mat.color && Array.isArray(mat.userData && mat.userData.fp_white)
  && mat.userData.fp_white.length === 3 && mat.userData.fp_white.every((c) => Number.isFinite(Number(c)));

// Keep the modelled colour of a whiteable material (once, at load) so it can come back.
export function rememberColor(mat) {
  if (isWhiteable(mat) && !mat.userData.fpColor) mat.userData.fpColor = mat.color.clone();
}

// Paint every remembered material under root white (fp_white) or back in its own colour. -> materials touched.
export function paintFurniture(root, white) {
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!mat || seen.has(mat) || !mat.userData || !mat.userData.fpColor) continue;
      seen.add(mat);
      if (white) mat.color.setRGB(...mat.userData.fp_white.map(Number));
      else mat.color.copy(mat.userData.fpColor);
    }
  });
  return seen.size;
}
