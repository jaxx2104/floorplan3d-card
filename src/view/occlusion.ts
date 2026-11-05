// Marker occlusion of the floorplan view: markers behind model walls are dimmed (class fp-occluded) by
// a debounced pass once the camera is still, run in time slices; plus the one-ray pointHidden test.

import * as THREE from "three";
import { isOccluded } from "../render-rules.ts";
import { isMesh } from "./core.ts";
import type { FloorplanView } from "../view.ts";

interface Occluder {
  mesh: THREE.Mesh;
  box: THREE.Box3;
}

export const OCCLUSION_DELAY_MS = 150; // camera still this long -> occlusion pass
const OCCLUSION_MAX = 300; // markers per pass
const OCCLUSION_SLICE_MS = 8; // a pass yields (setTimeout) after this long

export class MarkerOcclusion {
  view: FloorplanView;
  _occRay: THREE.Raycaster;
  _occlusion: boolean;
  _occTimer: ReturnType<typeof setTimeout> | null;
  _occBoxes: Occluder[] | null;
  _occGen: number;
  _occFull: boolean;
  _occIds: Set<string> | null;
  _tapRay: THREE.Raycaster | null;

  constructor(view: FloorplanView) {
    this.view = view;
    this._occRay = new THREE.Raycaster();
    this._occlusion = true; // dim markers behind model walls
    this._occTimer = null;
    this._occBoxes = null; // [{ mesh, box }] world boxes of occluding model meshes (cached per placement)
    this._occGen = 0; // occlusion pass generation (a new schedule cancels running slices)
    this._occFull = false; // a full pass is pending or running
    this._occIds = null; // marker ids waiting for a partial pass (live mower)
    this._tapRay = null; // pointHidden's raycaster, created on first use
  }

  // Card option `occlusion`: markers behind model walls are dimmed (class fp-occluded).
  setOcclusion(on: unknown): void {
    this._occlusion = on !== false;
    this._scheduleOcclusion(0);
  }

  // Occlusion pass once the camera has been still for 150 ms (debounced; never per frame). A new
  // schedule cancels the pending timer and any pass still running in slices.
  // id: only that marker (a moving live marker); a pending or running full pass already covers it.
  // Nothing runs while the card is detached (start() schedules a full pass again).
  _scheduleOcclusion(
    delay = OCCLUSION_DELAY_MS,
    id: string | null = null,
  ): void {
    if (this.view._disposed || !this.view._raf) return;
    if (id !== null) {
      if (this._occFull) return;
      (this._occIds = this._occIds || new Set()).add(id);
    } else {
      this._occFull = true;
      this._occIds = null;
    }
    if (this._occTimer) clearTimeout(this._occTimer);
    this._occGen++;
    this._occTimer = setTimeout(() => this._runOcclusion(), delay);
  }

  _cancelOcclusion(): void {
    if (this._occTimer) clearTimeout(this._occTimer);
    this._occTimer = null;
    this._occGen++;
    this._occFull = false;
    this._occIds = null;
  }

  _clearOcclusion(): void {
    for (const c of this.view.cssObjects)
      if (c.kind === "marker") c.obj.element.classList.remove("fp-occluded");
  }

  // World boxes of the model meshes that can hide a marker (not glass / see-through), cached.
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
  // hides a world point from the camera: object taps skip lamps behind walls. One raycast.
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
        .find((x) => x.point.y <= cut + 1e-6 && !this.view._cutAway(x.point));
      if (h && isOccluded(h.distance, dist)) return true;
    }
    return false;
  }

  _runOcclusion(): void {
    this._occTimer = null;
    if (this.view._disposed) return;
    const full = this._occFull,
      ids = this._occIds;
    if (
      !this._occlusion ||
      this.view.mode !== "3d" ||
      !this.view.model ||
      (this.view.model.opacity ?? 1) < 0.6
    ) {
      this._occFull = false;
      this._occIds = null;
      this._clearOcclusion();
      return;
    }
    const since = performance.now() - (this.view.cam._camMovedAt || 0);
    if (since < OCCLUSION_DELAY_MS) {
      const wait = OCCLUSION_DELAY_MS - since;
      if (full) this._scheduleOcclusion(wait);
      else {
        this._occIds = null;
        for (const id of ids || []) this._scheduleOcclusion(wait, id);
      }
      return;
    }
    this._occIds = null;
    if (full) this.view.stats.occPasses++;
    else this.view.stats.occPartial++;
    const cam = this.view.camera;
    cam.updateMatrixWorld();
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const shown = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p; p = p.parent)
        if (!p.visible) return false;
      return true;
    };
    const boxes = this._occluders().filter((b) => shown(b.mesh));
    const shownMarkers = this.view.cssObjects.filter(
      (c) =>
        c.kind === "marker" &&
        c.obj.visible &&
        (full || (ids && ids.has(c.id!))),
    );
    const markers = shownMarkers.slice(0, OCCLUSION_MAX);
    // past the budget: not tested, so not dimmed (a stale fp-occluded would leave them unclickable)
    for (const c of shownMarkers.slice(OCCLUSION_MAX))
      c.obj.element.classList.remove("fp-occluded");
    const gen = this._occGen;
    const rc = this._occRay,
      pos = new THREE.Vector3(),
      dir = new THREE.Vector3(),
      tmp = new THREE.Vector3();
    const cut = this.view.modelClip.constant;
    let i = 0;
    const slice = () => {
      this._occTimer = null;
      if (this.view._disposed || gen !== this._occGen) return; // cancelled (camera, view, model, dispose)
      const t0 = performance.now();
      for (; i < markers.length; i++) {
        if (performance.now() - t0 > OCCLUSION_SLICE_MS) {
          this._occTimer = setTimeout(slice, 0);
          return;
        }
        const c = markers[i];
        if (!c.obj.parent) continue; // removed meanwhile
        c.obj.getWorldPosition(pos);
        const dist = origin.distanceTo(pos);
        rc.set(origin, dir.subVectors(pos, origin).normalize());
        rc.near = 0;
        rc.far = Math.max(dist - 0.3, 0);
        let hitD: number | null = null;
        for (const { mesh, box } of boxes) {
          if (!box.containsPoint(origin)) {
            // inside the box: the ray may hit it anywhere, test the mesh
            const at = rc.ray.intersectBox(box, tmp);
            if (!at || origin.distanceTo(at) > rc.far) continue; // box pre-filter
          }
          const h = rc
            .intersectObject(mesh, false)
            .find(
              (x) => x.point.y <= cut + 1e-6 && !this.view._cutAway(x.point),
            );
          if (h) {
            hitD = h.distance;
            break;
          }
        }
        c.obj.element.classList.toggle("fp-occluded", isOccluded(hitD, dist));
      }
      if (full) {
        this._occFull = false;
        this.view.stats.occDone++;
      }
    };
    slice();
  }
}
