// Markers hidden by the model: the GPU sprites dim themselves per pixel against the frame's depth buffer
// (view/billboards.ts), so no pass runs here. What stays is when that applies (option `occlusion`, 3D view, a
// model that is not see-through) and the one-ray pointHidden test of a tap: a marker or object hidden behind
// the model takes no tap in view mode.

import * as THREE from "three";
import { isOccluded } from "../render-rules.ts";
import { isMesh } from "./core.ts";
import type { FloorplanView } from "../view.ts";

interface Occluder {
  mesh: THREE.Mesh;
  box: THREE.Box3;
}

export class MarkerOcclusion {
  view: FloorplanView;
  _occBoxes: Occluder[] | null;
  _tapRay: THREE.Raycaster | null;

  constructor(view: FloorplanView) {
    this.view = view;
    this._occBoxes = null; // [{ mesh, box }] world boxes of occluding model meshes (cached per placement)
    this._tapRay = null; // pointHidden's raycaster, created on first use
  }

  /** The model hides markers now: 3D view, a model that is not see-through. */
  active(): boolean {
    const v = this.view;
    return v.mode === "3d" && !!v.model && (v.model.opacity ?? 1) >= 0.6;
  }

  // World boxes of the model meshes that can hide a point (not glass / see-through), cached.
  _occluders(): Occluder[] {
    if (this._occBoxes) return this._occBoxes;
    this.view.modelGroup.updateMatrixWorld(true);
    const out: Occluder[] = [];
    this.view.model!.root.traverse((o) => {
      // callers checked view.model
      if (!isMesh(o) || o.userData.seeThrough || o.userData.helper) return;
      const box = new THREE.Box3().setFromObject(o);
      if (!box.isEmpty()) out.push({ mesh: o, box });
    });
    this._occBoxes = out;
    return out;
  }

  // True when visible model geometry (not glass, not `own`'s meshes, below the cut, section respected)
  // hides a world point from the camera: taps skip markers and lamps behind walls. One raycast.
  pointHidden(
    world: THREE.Vector3,
    own: THREE.Object3D | null = null,
  ): boolean {
    if (!this.view.model || (this.view.model.opacity ?? 1) < 0.6) return false; // a see-through model hides nothing
    const cam = this.view.camera;
    cam.updateMatrixWorld();
    const ndc = world.clone().project(cam);
    const rc = this._tapRay || (this._tapRay = new THREE.Raycaster());
    rc.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), cam);
    const origin = rc.ray.origin,
      dist = origin.distanceTo(world);
    rc.near = 0;
    rc.far = dist; // isOccluded keeps a margin in front of the point
    const shown = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p; p = p.parent)
        if (!p.visible) return false;
      return true;
    };
    const ownMesh = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p && own; p = p.parent)
        if (p === own) return true;
      return false;
    };
    const cut = this.view.modelClip.constant,
      tmp = new THREE.Vector3();
    for (const { mesh, box } of this._occluders()) {
      if (ownMesh(mesh) || !shown(mesh)) continue;
      if (!box.containsPoint(origin)) {
        const at = rc.ray.intersectBox(box, tmp);
        if (!at || origin.distanceTo(at) > rc.far) continue;
      }
      const h = rc
        .intersectObject(mesh, false)
        .find((x) => x.point.y <= cut + 1e-6);
      if (h && isOccluded(h.distance, dist)) return true;
    }
    return false;
  }
}
