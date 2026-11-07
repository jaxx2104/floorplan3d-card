// Camera rig of the floorplan view: perspective / top cameras, orbit controls, framing (fit), camera
// tweens, depth range, idle orbit and screen <-> plan conversions. The cameras themselves (persp,
// ortho, camera, mode) stay on the view; this part owns the controls and the camera state.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { pivotCamera, rayPlaneY, orthoZoom, topZoom } from "../views.ts";
import { SUN_DISC_M, MOON_DISC_M } from "../sky.ts";
import { recipeFar } from "../render-recipe.ts";
import { depthRange, depthChanged } from "../render-rules.ts";
import {
  planToWorld,
  isMesh,
  type CameraPose,
  type TopCameraPose,
} from "./core.ts";
import type { FloorplanView } from "../view.ts";
import type { PlanPoint } from "../types/layout.ts";

type CameraTween =
  | {
      top: true;
      t0: number;
      from: { target: THREE.Vector3; zoom: number };
      to: { target: THREE.Vector3; zoom: number };
    }
  | {
      top?: undefined;
      t0: number;
      from: { pos: THREE.Vector3; target: THREE.Vector3 };
      to: { pos: THREE.Vector3; target: THREE.Vector3 };
    };
/** Depth-range bounds (_sceneBounds). */
export interface SceneBounds {
  house: THREE.Box3;
  centre: THREE.Vector3;
  radius: number;
}

const TOOLBAR_PX = 48; // plan is framed below the card's toolbar
const MAX_FRAME_MESH_M = 60; // meshes larger than this are left out when framing the model
const SKY_FRAME_MARGIN_M = 1; // top view: margin around a visible sun / moon disc

// Turn a camera position around the target's vertical axis by angle radians (counter-clockwise from above).
export function orbitStep(
  position: THREE.Vector3,
  target: THREE.Vector3,
  angle: number,
): THREE.Vector3 {
  const dx = position.x - target.x,
    dz = position.z - target.z,
    c = Math.cos(angle),
    sn = Math.sin(angle);
  position.x = target.x + dx * c + dz * sn;
  position.z = target.z - dx * sn + dz * c;
  return position;
}

export class CameraRig {
  view: FloorplanView;
  /** OrbitControls, rebuilt by setMode; made by _makeControls at the end of the view's constructor */
  controls!: OrbitControls;
  _tween: CameraTween | null;
  _framed: boolean;
  _camMovedAt: number;
  _minDistance: number | null;
  _orthoHalf: number | null;
  _lastCam3d: CameraPose | null;
  _bounds: SceneBounds | null;
  _onWheel: () => void;

  constructor(view: FloorplanView) {
    this.view = view;
    this._tween = null; // camera tween { t0, from, to } (top: { top: true, ... })
    this._framed = false; // the 3D camera was placed once (the first move is instant)
    this._camMovedAt = 0; // last controls change (auto quality waits for a still camera)
    this._minDistance = null; // zoom limit from the last fit()
    this._orthoHalf = null; // top view: half height (m) at zoom 1
    this._lastCam3d = null; // the 3D camera before switching to Top
    this._bounds = null; // { house: Box3, centre: Vector3, radius } for the depth range
    this._onWheel = () => {
      this.view.dirty = true;
    };
  }

  _makeControls(): void {
    const prevTarget = this.controls && this.controls.target.clone();
    if (this.controls) this.controls.dispose();
    const c = new OrbitControls(
      this.view.camera,
      this.view.renderer.domElement,
    );
    c.enableDamping = true;
    c.dampingFactor = 0.05;
    c.screenSpacePanning = true;
    if (this.view.mode === "top") {
      c.enableRotate = false;
      c.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      };
      c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    } else {
      c.maxPolarAngle = Math.PI * 0.47;
      c.maxDistance = 130;
      c.minDistance = this._minDistance || 4;
    }
    c.addEventListener("change", () => {
      this.view.dirty = true;
      this._camMovedAt = performance.now();
    });
    c.addEventListener("start", () => {
      this._tween = null;
    });
    if (this.controls) c.enabled = this.controls.enabled;
    if (prevTarget) c.target.copy(prevTarget);
    this.controls = c;
  }

  // Rotation centre under a screen point: the model surface, else the horizontal plane at height y.
  pivotPoint(clientX: number, clientY: number, y = 0): number[] | null {
    const pick = this.view.modelLayer.pickModel(clientX, clientY);
    if (pick && pick.hit) return pick.hit.point;
    const r = this.view.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    this.view.raycaster.setFromCamera(ndc, this.view.camera);
    const { origin, direction } = this.view.raycaster.ray;
    return rayPlaneY(origin.toArray(), direction.toArray(), y);
  }

  // Move the rotation centre to a world point; the camera keeps its angle and distance (tweened).
  // Returns the new camera { position, target }.
  setPivot(point: number[] | null | undefined): CameraPose | null {
    if (this.view.mode !== "3d" || !point) return null;
    const cam = pivotCamera(this.getCamera(), point);
    this.setCamera(cam);
    return cam;
  }

  setControlsEnabled(on: boolean): void {
    this.controls.enabled = on;
  }

  // Plan point [x, y] under a screen position, on the horizontal plane at world height `height`.
  planPoint(
    clientX: number,
    clientY: number,
    height: number,
  ): PlanPoint | null {
    const r = this.view.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    this.view.raycaster.setFromCamera(ndc, this.view.camera);
    const hit = this.view.raycaster.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -height),
      new THREE.Vector3(),
    );
    return hit ? [hit.x, -hit.z] : null;
  }

  // Screen position (client px) of a plan point, the inverse of planPoint.
  screenPoint(
    x: number,
    y: number,
    z: number,
    floorId: string | null | undefined,
  ): [number, number] {
    const v = planToWorld(x, y, z, this.view.floorElevation(floorId)).project(
      this.view.camera,
    );
    const r = this.view.renderer.domElement.getBoundingClientRect();
    return [
      r.left + ((v.x + 1) / 2) * r.width,
      r.top + ((1 - v.y) / 2) * r.height,
    ];
  }

  // Client px of a world point, null when it is behind the camera or outside the depth range.
  projectWorld(world: THREE.Vector3): [number, number] | null {
    const v = world.clone().project(this.view.camera);
    if (!(v.z >= -1 && v.z <= 1)) return null;
    const r = this.view.renderer.domElement.getBoundingClientRect();
    return [
      r.left + ((v.x + 1) / 2) * r.width,
      r.top + ((1 - v.y) / 2) * r.height,
    ];
  }

  getCamera(): CameraPose {
    if (this.view.mode === "top" && this._lastCam3d) return this._lastCam3d;
    const r = (a: THREE.Vector3) =>
      a.toArray().map((x) => Math.round(x * 100) / 100);
    return {
      position: r(this.view.persp.position),
      target: r(this.controls.target),
    };
  }

  // Top view: ortho centre in plan metres + zoom (1 = 10 m half height), or null outside top mode.
  getTopCamera(): TopCameraPose | null {
    if (this.view.mode !== "top") return null;
    const t = this.controls.target,
      r = (x: number) => Math.round(x * 100) / 100 + 0;
    return {
      center: [r(t.x), r(-t.z)],
      zoom:
        Math.round(
          topZoom(this.view.ortho.zoom, this._orthoHalf || 10) * 1000,
        ) / 1000,
    };
  }

  setTopCamera(
    c: TopCameraPose | null | undefined,
    { instant = false }: { instant?: boolean } = {},
  ): void {
    if (this.view.mode !== "top" || !c) return;
    const target = new THREE.Vector3(
      c.center[0],
      this.controls.target.y,
      -c.center[1],
    );
    const zoom = orthoZoom(c.zoom, this._orthoHalf || 10);
    if (instant) {
      this._tween = null;
      this._placeOrtho(target, zoom);
    } else {
      this._tween = {
        top: true,
        t0: performance.now(),
        from: {
          target: this.controls.target.clone(),
          zoom: this.view.ortho.zoom,
        },
        to: { target, zoom },
      };
    }
    this.view.dirty = true;
  }

  _placeOrtho(target: THREE.Vector3, zoom: number): void {
    this.view.ortho.zoom = zoom;
    this.view.ortho.position.set(target.x, target.y + 60, target.z);
    this.view.ortho.lookAt(target);
    this.view.ortho.updateProjectionMatrix();
    this.controls.target.copy(target);
    this.controls.update();
  }

  setCamera(
    cam: CameraPose | null | undefined,
    { instant = false }: { instant?: boolean } = {},
  ): void {
    if (this.view.mode !== "3d" || !cam) return;
    const pos = new THREE.Vector3(...cam.position),
      target = new THREE.Vector3(...cam.target);
    // saved cameras must not be clamped by the zoom limits; relaxed until the next fit()
    const d = pos.distanceTo(target);
    this.controls.minDistance = Math.min(this.controls.minDistance, d);
    this.controls.maxDistance = Math.max(this.controls.maxDistance, d);
    this.view._moveCamera(pos, target, instant);
  }

  // cam: {position, target} or null for the default framing.
  resetCamera(cam?: CameraPose | null): void {
    if (cam) this.setCamera(cam);
    else this.fit();
  }

  _moveCamera(
    pos: THREE.Vector3,
    target: THREE.Vector3,
    instant?: boolean,
  ): void {
    if (instant || !this._framed) {
      this._tween = null;
      this.view.persp.position.copy(pos);
      this.view.persp.lookAt(target);
      this._framed = true;
      this.controls.target.copy(target);
      this.controls.update();
    } else {
      this._tween = {
        t0: performance.now(),
        from: {
          pos: this.view.persp.position.clone(),
          target: this.controls.target.clone(),
        },
        to: { pos, target },
      };
    }
    this.view.dirty = true;
  }

  // The 3D camera before switching to Top (null until then).
  get lastCamera3d(): CameraPose | null {
    return this._lastCam3d || null;
  }

  setMode(mode: "3d" | "top"): void {
    if (mode === this.view.mode) return;
    if (this.view.mode === "3d") this._lastCam3d = this.getCamera();
    this.view.mode = mode;
    this.view.camera = mode === "top" ? this.view.ortho : this.view.persp;
    this._makeControls();
    this.fit();
  }

  // Frame the rooms of the visible floor(s); the model when there are no rooms (or asked to).
  fit({
    model = false,
    instant = false,
  }: { model?: boolean; instant?: boolean } = {}): void {
    const box = new THREE.Box3();
    if (!model) {
      // rooms as data (independent of fills/outlines/walls flags), on the visible floors
      for (const { room, floorId } of this.view._rooms || []) {
        if (
          !this.view._shows(floorId) ||
          !room.polygon ||
          room.polygon.length < 3
        )
          continue;
        const f = this.view.floors.find((x) => x.id === floorId);
        const y0 = f ? f.elevation : 0,
          y1 = y0 + ((f && f.height) || 2.7);
        for (const [x, y] of room.polygon) {
          box.expandByPoint(new THREE.Vector3(x, y0, -y));
          box.expandByPoint(new THREE.Vector3(x, y1, -y));
        }
      }
    }
    if (box.isEmpty() && this.view.model) {
      // only the parts currently shown, and not above the cut
      this.view.modelGroup.updateMatrixWorld(true);
      this.view.model.root.traverse((o) => {
        if (!isMesh(o)) return;
        for (let p: THREE.Object3D | null = o; p; p = p.parent)
          if (!p.visible) return;
        const b = new THREE.Box3().setFromObject(o);
        // a world ground plane or a long road would frame the whole neighbourhood
        if (Math.max(b.max.x - b.min.x, b.max.z - b.min.z) > MAX_FRAME_MESH_M)
          return;
        b.max.y = Math.min(b.max.y, this.view.modelClip.constant);
        if (b.min.y <= b.max.y) box.union(b);
      });
    }
    if (box.isEmpty())
      box.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 0, 5));
    if (
      this.view.mode === "top" &&
      this.view.model &&
      this.view.skyLayer._skyOn
    ) {
      // top view: the house, plus a visible sun / moon disc (the ring may be cut)
      this.view.skyLayer._placeSkyBodies();
      for (const [s, disc] of [
        [this.view.skyLayer.skySprites.sun, SUN_DISC_M],
        [this.view.skyLayer.skySprites.moon, MOON_DISC_M],
      ] as const) {
        if (!s || !s.visible) continue;
        const r = disc / 2 + SKY_FRAME_MARGIN_M;
        box.expandByPoint(
          new THREE.Vector3(s.position.x - r, box.min.y, s.position.z - r),
        );
        box.expandByPoint(
          new THREE.Vector3(s.position.x + r, box.min.y, s.position.z + r),
        );
      }
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const aspect = this.view.size.w / this.view.size.h;
    const target = center.clone();
    this._minDistance = Math.max(size.x, size.z) < 10 ? 1 : 4;
    if (this.view.mode === "3d") {
      this.controls.minDistance = this._minDistance;
      this.controls.maxDistance = 130;
    }
    if (this.view.visibleFloor !== "all")
      target.y = this.view.floorElevation(this.view.visibleFloor);

    if (this.view.mode === "top") {
      const { h } = this.view.size;
      const half =
        Math.max(size.z / 2, size.x / 2 / aspect) *
        1.08 *
        ((h + TOOLBAR_PX) / Math.max(h - TOOLBAR_PX, 1));
      this._tween = null;
      this._orthoHalf = half;
      this._updateOrtho();
      this.view.ortho.zoom = 1;
      this.view.ortho.position.set(target.x, target.y + 60, target.z);
      this.view.ortho.lookAt(target);
      this.view.ortho.updateProjectionMatrix();
    } else {
      const dir = this.view.model
        ? new THREE.Vector3(0.42, 0.616, 0.69).normalize() // 3/4 view
        : new THREE.Vector3(0.18, 0.95, 0.75).normalize(); // from the south, high up
      const corners: THREE.Vector3[] = [];
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z])
            corners.push(new THREE.Vector3(x, y, z));
      // start far, then shrink until the projected corners fill ~85 % of the view
      let dist = Math.max(size.x, size.z, 4) * 3;
      for (let i = 0; i < 6; i++) {
        this.view.persp.position.copy(target).addScaledVector(dir, dist);
        this.view.persp.lookAt(target);
        this.view.persp.updateMatrixWorld();
        let extent = 0;
        for (const c of corners) {
          const p = c.clone().project(this.view.persp);
          extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y));
        }
        dist *= extent / 0.85;
      }
      const to = {
        pos: target.clone().addScaledVector(dir, dist),
        target: target.clone(),
      };
      this._bounds = this._sceneBounds();
      this.view._moveCamera(to.pos, to.target, instant);
      this._updateDepth();
      return;
    }
    this.controls.target.copy(target);
    this.controls.update();
    this._bounds = this._sceneBounds();
    this._updateDepth();
    this.view.dirty = true;
  }

  // Depth-range bounds: the house box (rooms + model meshes up to 60 m) and the bounding sphere of
  // everything (terrain included).
  _sceneBounds(): SceneBounds {
    const house = new THREE.Box3(),
      full = new THREE.Box3();
    for (const { room, floorId } of this.view._rooms || []) {
      if (!room.polygon || room.polygon.length < 3) continue;
      const f = this.view.floors.find((x) => x.id === floorId);
      const y0 = f ? f.elevation : 0,
        y1 = y0 + ((f && f.height) || 2.7);
      for (const [x, y] of room.polygon)
        house
          .expandByPoint(new THREE.Vector3(x, y0, -y))
          .expandByPoint(new THREE.Vector3(x, y1, -y));
    }
    full.union(house);
    if (this.view.model) {
      this.view.modelGroup.updateMatrixWorld(true);
      this.view.model.root.traverse((o) => {
        if (!isMesh(o)) return;
        const b = new THREE.Box3().setFromObject(o);
        full.union(b);
        if (Math.max(b.max.x - b.min.x, b.max.z - b.min.z) <= MAX_FRAME_MESH_M)
          house.union(b);
      });
    }
    if (full.isEmpty())
      full.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 3, 5));
    if (house.isEmpty()) house.copy(full);
    const sphere = full.getBoundingSphere(new THREE.Sphere());
    return { house, centre: sphere.center, radius: Math.max(sphere.radius, 5) };
  }

  // Near / far from the camera position (depth precision where the model is); only on > 1 % changes.
  _updateDepth(): void {
    const cam = this.view.camera,
      ortho = cam === this.view.ortho;
    const b = this._bounds || (this._bounds = this._sceneBounds());
    const p = cam.position;
    const next = depthRange({
      target: p.distanceTo(this.controls.target),
      house: b.house.distanceToPoint(p),
      centre: p.distanceTo(b.centre),
      radius: b.radius,
      ortho,
    });
    const d = this.view.look._dome;
    let needed =
      Math.round((p.distanceTo(b.centre) + Math.min(b.radius, 1e5)) * 1050) /
      1000;
    if (d && this.view.skyLayer._skyOn && this.view.model && !ortho) {
      const dome =
        Math.round((p.distanceTo(d.centre) + d.radius + SUN_DISC_M) * 1050) /
        1000; // the dome stays in front of far
      next.far = Math.max(next.far, dome);
      needed = Math.max(needed, dome);
    }
    if (!ortho && this.view.model && this.view.look.render.camera)
      next.far = recipeFar(next.far, needed, this.view.look.render.camera.far); // the recipe's far: an upper bound only
    if (!depthChanged({ near: cam.near, far: cam.far }, next)) return;
    cam.near = next.near;
    cam.far = next.far;
    cam.updateProjectionMatrix();
  }

  _stepTween(now: number): void {
    const tw = this._tween!; // the render loop steps only a running tween
    const t = Math.min(1, (now - tw.t0) / 400);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    if (tw.top) {
      if (this.view.mode !== "top") {
        this._tween = null;
        return;
      }
      this._placeOrtho(
        new THREE.Vector3().lerpVectors(tw.from.target, tw.to.target, e),
        tw.from.zoom + (tw.to.zoom - tw.from.zoom) * e,
      );
      this.view.dirty = true;
      if (t === 1) this._tween = null;
      return;
    }
    this.view.persp.position.lerpVectors(tw.from.pos, tw.to.pos, e);
    this.controls.target.lerpVectors(tw.from.target, tw.to.target, e);
    this.controls.update();
    this.view.dirty = true;
    if (t === 1) this._tween = null;
  }

  _updateOrtho(): void {
    const half = this._orthoHalf || 10;
    const { w, h } = this.view.size;
    const aspect = w / (h + TOOLBAR_PX);
    Object.assign(this.view.ortho, {
      left: -half * aspect,
      right: half * aspect,
      top: half,
      bottom: -half,
    });
    this.view.ortho.setViewOffset(w, h + TOOLBAR_PX, 0, 0, w, h);
  }

  // Screen pixels per plan metre at the orbit target.
  pixelsPerMetre(): number {
    const { h } = this.view.size;
    if (this.view.mode === "top")
      return (
        (h * this.view.ortho.zoom) /
        (this.view.ortho.top - this.view.ortho.bottom)
      );
    const dist = this.view.persp.position.distanceTo(this.controls.target);
    return h / (2 * dist * Math.tan((this.view.persp.fov * Math.PI) / 360));
  }

  resize(w: number, h: number): void {
    if (!w || !h) return;
    this.view.size = { w, h };
    this.view.renderer.setSize(w, h);
    // render the top part of a taller view, so the scene centre sits below the toolbar
    this.view.persp.aspect = w / (h + TOOLBAR_PX);
    this.view.persp.setViewOffset(w, h + TOOLBAR_PX, 0, 0, w, h);
    this._updateOrtho();
    this.view.dirty = true;
  }
}
