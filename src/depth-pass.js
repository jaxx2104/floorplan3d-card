// Depth pre-pass of the opaque meshes for the screen effects (ao.js, dof.js): every visible mesh that
// writes depth, drawn with a depth-only stand-in of its material (same side, clipping planes and alpha
// test, so the cut-away stays cut). Colour red = front face: the inside of a cut wall (its back faces)
// is told apart. Transparent things, helpers, glass, sprites, points and lines are left out.
import * as THREE from 'three';

// Objects the depth pre-pass draws: visible opaque meshes that write depth (not helpers, glass, sprites,
// points, lines).
export function occludes(o) {
  if (!o.isMesh || o.isSprite || (o.userData && (o.userData.helper || o.userData.seeThrough))) return false;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  return mats.length > 0 && mats.every((m) => m && m.visible !== false && !m.transparent && m.depthWrite !== false && m.colorWrite !== false && !(m.transmission > 0));
}

export class DepthPrepass {
  constructor(renderer) {
    this.renderer = renderer;
    this.size = new THREE.Vector2();
    this.target = new THREE.WebGLRenderTarget(1, 1, { depthTexture: new THREE.DepthTexture(1, 1), depthBuffer: true });
    this._mats = new WeakMap();
  }

  // depth-only stand-in for a material: same side, clipping and alpha test
  _depthMat(m) {
    let d = this._mats.get(m);
    if (!d) {
      d = new THREE.MeshBasicMaterial();
      d.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace(/}\s*$/, '  gl_FragColor = vec4(gl_FrontFacing ? 1.0 : 0.0, 0.0, 0.0, 1.0);\n}');
      };
      d.customProgramCacheKey = () => 'fp-depth-pass';
      this._mats.set(m, d);
    }
    d.side = m.side;
    d.clippingPlanes = m.clippingPlanes;
    d.clipIntersection = m.clipIntersection;
    const map = m.alphaTest > 0 ? m.map || null : null, alphaMap = m.alphaTest > 0 ? m.alphaMap || null : null;
    if (!!map !== !!d.map || !!alphaMap !== !!d.alphaMap || (m.alphaTest > 0) !== (d.alphaTest > 0)) d.needsUpdate = true; // other shader defines
    d.alphaTest = m.alphaTest;
    d.map = map;
    d.alphaMap = alphaMap;
    return d;
  }

  // Render at resolution (share of the drawing buffer) for this camera -> this.target (depthTexture + front faces).
  render(scene, camera, resolution) {
    const r = this.renderer;
    const full = r.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, Math.round(full.x * resolution)), h = Math.max(1, Math.round(full.y * resolution));
    if (this.size.x !== w || this.size.y !== h) {
      this.size.set(w, h);
      this.target.setSize(w, h);
    }
    const swapped = [], hidden = [];
    scene.traverseVisible((o) => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      if (!occludes(o)) { o.visible = false; hidden.push(o); return; }
      swapped.push([o, o.material]);
      o.material = Array.isArray(o.material) ? o.material.map((m) => this._depthMat(m)) : this._depthMat(o.material);
    });
    const prevTarget = r.getRenderTarget(), prevAutoClear = r.autoClear, prevShadow = r.shadowMap.needsUpdate;
    const clear = r.getClearColor(new THREE.Color()), clearAlpha = r.getClearAlpha();
    r.shadowMap.needsUpdate = false; // the shadow maps update in the frame render, with every caster shown
    r.autoClear = true;
    r.setClearColor(0x000000, 1);
    try {
      r.setRenderTarget(this.target);
      r.render(scene, camera);
    } finally {
      for (const [o, m] of swapped) o.material = m;
      for (const o of hidden) o.visible = true;
      r.shadowMap.needsUpdate = prevShadow;
      r.setRenderTarget(prevTarget);
      r.setClearColor(clear, clearAlpha);
      r.autoClear = prevAutoClear;
    }
    return this;
  }

  dispose() {
    this.target.depthTexture.dispose();
    this.target.dispose();
  }
}
