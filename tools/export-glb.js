// floorplan3d-card: export the Three.js scene of your house design as a .glb underlay.
//
// 1. Make the scene reachable from the console. In the design's code, right after the scene is
//    created, add:   window.scene = scene;
// 2. Open the design in the browser, open the developer console (F12 → Console), paste this
//    whole file and press Enter.
// 3. house.glb downloads. Copy it to /config/www/ and set  model: /local/house.glb  in the card.
//
// Conventions the card understands (see docs/model-builder-guide.md): metres, Y up, plan x = east,
// plan y = north = -Z. Tag levels, rooms and zones with  node.userData.fp = { kind: 'level', id: 'ground' }
// (also kind 'room' / 'zone' with an outline); userData is exported as glTF extras. Legacy groups
// named "floor:<id>" still work.
(async () => {
  const SCALE = 1; // multiply into metres: 0.01 for centimetres, 0.001 for millimetres
  const FILE = "house.glb";

  const scene =
    window.scene || window.SCENE || (window.app && window.app.scene);
  if (!scene || !scene.isObject3D) {
    console.error(
      "floorplan3d: no scene found. Add  window.scene = scene;  to the design code and reload.",
    );
    return;
  }
  const rev = (window.THREE && window.THREE.REVISION) || "169";
  const cdn = `https://cdn.jsdelivr.net/npm/three@0.${parseInt(rev, 10)}.0`;
  const THREE = await import(window.FLOORPLAN3D_THREE_URL || `${cdn}/+esm`);
  const { GLTFExporter } = await import(
    window.FLOORPLAN3D_EXPORTER_URL ||
      `${cdn}/examples/jsm/exporters/GLTFExporter.js/+esm`
  );

  // copy without lights, cameras, helpers, grids, sprites and HTML labels
  const copy = scene.clone(true);
  const drop = [];
  copy.traverse((o) => {
    if (o === copy) return;
    if (
      o.isLight ||
      o.isCamera ||
      o.isSprite ||
      o.isPoints ||
      o.type.endsWith("Helper") ||
      o.isCSS2DObject ||
      o.isCSS3DObject ||
      (o.userData && o.userData.noExport)
    )
      drop.push(o);
  });
  for (const o of drop) if (o.parent) o.parent.remove(o);
  for (const c of copy.children) {
    c.position.multiplyScalar(SCALE);
    c.scale.multiplyScalar(SCALE);
  }

  const box = new THREE.Box3().setFromObject(copy);
  const size = box.getSize(new THREE.Vector3());
  console.log(
    `floorplan3d: model size ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} (x, height, z).` +
      " A house should be roughly 8-20 m wide; if not, change SCALE.",
  );
  console.log(
    `floorplan3d: min corner x=${box.min.x.toFixed(2)} z=${box.min.z.toFixed(2)}. ` +
      "Plan origin (0,0) should be the south-west corner (x≈0, z≈0); otherwise set model_position in the card.",
  );
  const names = copy.children.map((c) => c.name || "(unnamed)");
  console.log("floorplan3d: top-level nodes:", names.join(", "));
  if (
    !names.some((n) => /^floor[:_]/.test(n)) &&
    !copy.children.some((c) => c.userData && c.userData.fp)
  ) {
    console.warn(
      'floorplan3d: no fp-tagged levels (node.userData.fp = { kind: "level", id }, see docs/model-builder-guide.md); the card will only cut the model at the selected floor height.',
    );
  }

  const glb = await new Promise((resolve, reject) =>
    new GLTFExporter().parse(copy, resolve, reject, {
      binary: true,
      onlyVisible: true,
    }),
  );
  window.__floorplan3dGlb = glb;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([glb], { type: "model/gltf-binary" }));
  a.download = FILE;
  a.click();
  console.log(
    `floorplan3d: saved ${FILE} (${(glb.byteLength / 1024 / 1024).toFixed(2)} MB)`,
  );
})();
