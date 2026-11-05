import { describe, it, expect } from "bun:test";
import * as THREE from "three";
import { occludes } from "../src/depth-pass.ts";
import { ghostMaterial } from "../src/render-rules.ts";

const mesh = (mat) => new THREE.Mesh(new THREE.BoxGeometry(), mat);
// a model material as the loader leaves it, then ghosted by the card's model_opacity
const modelMat = (opts = {}) => {
  const m = new THREE.MeshStandardMaterial(opts);
  m.userData.baseOpacity = m.opacity;
  m.userData.wasTransparent = m.transparent;
  m.userData.baseDepthWrite = m.depthWrite;
  return m;
};
const ghost = (m, opacity) =>
  Object.assign(m, ghostMaterial(m.userData, opacity));

describe("occludes", () => {
  it("opaque meshes occlude; transparent ones and helpers do not", () => {
    expect(occludes(mesh(new THREE.MeshStandardMaterial()))).toBe(true);
    expect(
      occludes(
        mesh(
          new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 }),
        ),
      ),
    ).toBe(false);
    const helper = mesh(new THREE.MeshStandardMaterial());
    helper.userData.helper = true;
    expect(occludes(helper)).toBe(false);
    expect(occludes(new THREE.Sprite())).toBe(false);
  });

  it("a model ghosted by model_opacity still occludes (depth writes kept)", () => {
    const m = ghost(modelMat(), 0.95);
    expect(m.transparent).toBe(true);
    expect(occludes(mesh(m))).toBe(true);
  });

  it("glass in the file stays out, ghosted or not", () => {
    const glass = modelMat({ transparent: true, opacity: 0.3 });
    expect(occludes(mesh(glass))).toBe(false);
    expect(occludes(mesh(ghost(glass, 0.95)))).toBe(false);
  });
});
