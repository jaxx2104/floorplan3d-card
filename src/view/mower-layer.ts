// Mower layer of the floorplan view: the ground under plan points (model surface rays, cached), the
// warning sprite, the status chip and the driven track. Shown with the
// outdoors when a model is loaded.

import * as THREE from "three";
import { Billboard } from "./billboards.ts";
import { chipSprite } from "../label-sprite.ts";
import { outdoorShown } from "../views.ts";
import { GroundCache } from "../surface.ts";
import type { FloorplanView } from "../view.ts";

export interface MowerWarningSpec {
  kind: "error" | "stuck" | string;
  x: number;
  y: number;
  floorId: string;
}
export interface MowerChipSpec {
  kind: string;
  icon: string;
  text?: string;
  x: number;
  y: number;
  floorId: string;
}
export interface MowerTrackSpec {
  segments: number[][][];
  floorId: string;
  color?: THREE.ColorRepresentation;
  width?: number;
  opacity?: number;
}
/** Ground under a plan point: world height and the model level it belongs to. */
interface GroundHit {
  y: number;
  level: string | null;
}

const MOWER_RAY_ABOVE_M = 1.5; // mower ground ray: starts this far over the floor
const MOWER_RAY_M = 4.5; // ... and reaches 3 m below it

export class MowerLayer {
  view: FloorplanView;
  warning: {
    sprite: THREE.Sprite;
    kind: string;
    floorId: string;
    timer: ReturnType<typeof setInterval>;
  } | null;
  mowerChip: {
    obj: Billboard;
    floorId?: string;
    kind?: string;
    icon?: string;
    text?: string;
  } | null;
  mowerTrack: {
    mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    sig: string | null;
    floorId: string;
  } | null;
  _ground: GroundCache<GroundHit>;
  _mowerGround: GroundCache<number>;

  constructor(view: FloorplanView) {
    this.view = view;
    this.warning = null; // { sprite, kind, floorId, timer }
    this.mowerChip = null; // { obj, floorId }
    this.mowerTrack = null; // { mesh, sig, floorId }
    this._ground = new GroundCache(); // ground seen from above the model, per 0.5 m cell (cleared with _surfMeshes)
    this._mowerGround = new GroundCache(); // ground under the mower: a bounded ray (eaves, canopies ignored)
  }

  // World height of the model surface seen from above at plan (x, y) (cached per 0.5 m cell, one ray down
  // from over the model against the surface meshes: helpers, objects and glass ignored), or null.
  groundAt(x: number, y: number): number | null {
    const g = this._groundHit(x, y);
    return g ? g.y : null;
  }

  // The ground height, else the floor's elevation (no model, or nothing under the point).
  groundHeight(x: number, y: number, floorId: string): number {
    const g = this.groundAt(x, y);
    return g ?? this.view.floorElevation(floorId);
  }

  _groundHit(x: number, y: number): GroundHit | null {
    if (!this.view.model) return null;
    return this._ground.get(x, y, this.view.model.id, (cx, cy) =>
      this._groundRay(cx, cy),
    );
  }

  // Ground under the mower (marker, model node, warning): a ray down from 1.5 m over the floor's elevation, at most MOWER_RAY_M long, so roofs, eaves, carports and tree canopies
  // over the mower are ignored. Falls back to the ray from above the model when that finds nothing.
  mowerGround(x: number, y: number, floorId: string): number | null {
    if (!this.view.model) return null;
    if (this.view.mowerOnFloor) return this.view.floorElevation(floorId); // indoors: a ray would land on tables and beds
    const base = this.view.floorElevation(floorId);
    const key = `${this.view.model.id}|${base}`;
    const g = this._mowerGround.get(x, y, key, (cx, cy) => {
      const from = base + MOWER_RAY_ABOVE_M;
      const hit = this.view.modelLayer.surfaceRays(
        [cx, from, -cy],
        [[0, -1, 0]],
        MOWER_RAY_M,
      )[0];
      return hit ? hit.point[1] : (this._groundHit(cx, cy)?.y ?? null);
    });
    return g;
  }

  // mowerGround, else the floor's elevation
  mowerHeight(x: number, y: number, floorId: string): number {
    return this.mowerGround(x, y, floorId) ?? this.view.floorElevation(floorId);
  }

  _groundRay(x: number, y: number): GroundHit | null {
    const meshes = this.view.modelLayer._surfaceMeshes();
    if (!meshes.length) return null;
    let top = -Infinity,
      bottom = Infinity;
    for (const { box } of meshes) {
      if (box.max.y > top) top = box.max.y;
      if (box.min.y < bottom) bottom = box.min.y;
    }
    const from = top + 1;
    const hit = this.view.modelLayer.surfaceRays(
      [x, from, -y],
      [[0, -1, 0]],
      from - bottom + 1,
    )[0];
    if (!hit) return null;
    let level = null;
    const levels = this.view.model!.manifest.levels || []; // the surface meshes exist only with a model
    for (let o: THREE.Object3D | null = hit.object; o && !level; o = o.parent)
      level = levels.find((l) => l.node === o) || null;
    return { y: hit.point[1], level: level ? level.id : null };
  }

  // Marker of the mower: with a model, shown wherever the outdoors (an exterior level) shows, whatever the mower's HA floor; else the floor rule.
  _mowerShows(floorId: string | null | undefined): boolean {
    if (this.view.model) {
      const mv = this.view._modelVisibility;
      const o = outdoorShown(
        this.view.model.manifest.levels,
        mv && mv.index,
        mv && mv.flags,
      );
      if (o !== null) return o;
    }
    return this.view._shows(floorId);
  }

  // Warning over the mower: { kind: 'error' | 'stuck', x, y, floorId } or null. A world-size sprite 0.6 m
  // above the ground under the mower, pulsing at 2 Hz by a timer that exists only while it is shown
  // (the render loop stays idle otherwise).
  setMowerWarning(w: MowerWarningSpec | null | undefined): void {
    const cur = this.warning;
    if (!w) {
      if (cur) {
        clearInterval(cur.timer);
        this.view.mowerGroup.remove(cur.sprite);
        cur.sprite.material.map!.dispose(); // made with its canvas texture below
        cur.sprite.material.dispose();
        this.warning = null;
        this.view.dirty = true;
      }
      return;
    }
    const y = this.mowerHeight(w.x, w.y, w.floorId) + 0.6;
    if (cur && cur.kind === w.kind) {
      const at = cur.sprite.position;
      if (
        at.x !== w.x ||
        at.y !== y ||
        at.z !== -w.y ||
        cur.floorId !== w.floorId
      ) {
        at.set(w.x, y, -w.y);
        cur.floorId = w.floorId;
        this._warningVisible();
        this.view.dirty = true;
      }
      return;
    }
    this.setMowerWarning(null);
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!; // a fresh 2D canvas context
    const col = w.kind === "stuck" ? "#f5b800" : "#e53935";
    g.beginPath();
    g.moveTo(64, 10);
    g.lineTo(122, 112);
    g.lineTo(6, 112);
    g.closePath();
    g.fillStyle = col;
    g.fill();
    g.lineWidth = 8;
    g.lineJoin = "round";
    g.strokeStyle = "#ffffff";
    g.stroke();
    g.fillStyle = w.kind === "stuck" ? "#3a2e00" : "#ffffff";
    g.font = "bold 66px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("!", 64, 80);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    sprite.scale.set(0.5, 0.5, 1);
    sprite.renderOrder = 20; // above objects
    sprite.position.set(w.x, y, -w.y);
    sprite.userData.helper = true; // never picked by the model ray
    sprite.raycast = () => {};
    this.view.mowerGroup.add(sprite);
    let bright = true;
    const timer = setInterval(() => {
      bright = !bright;
      sprite.material.opacity = bright ? 1 : 0.55;
      if (sprite.visible) this.view.dirty = true; // no frames for a warning on a hidden floor
    }, 500);
    this.warning = { sprite, kind: w.kind, floorId: w.floorId, timer };
    this._warningVisible();
    this.view.dirty = true;
  }

  // Chip next to the mower: { kind ('offline' | 'rain' | 'drying'), icon, text, x, y, floorId } or null.
  // A GPU sprite (view/billboards.ts) 0.5 m above the ground under the mower, never hidden by the model.
  setMowerChip(c: MowerChipSpec | null | undefined): void {
    const cur = this.mowerChip;
    if (!c) {
      if (cur) {
        this.view.mowerGroup.remove(cur.obj);
        this.view.sprites.remove(cur.obj);
        this.mowerChip = null;
        this.view.dirty = true;
      }
      return;
    }
    let obj = cur && cur.obj;
    if (!obj) {
      obj = this.view.sprites.layer.add(new Billboard());
      this.view.mowerGroup.add(obj);
      this.mowerChip = { obj };
    }
    const spec = chipSprite(c.kind, c.icon, c.text || "");
    if (!obj.spec || obj.spec.key !== spec.key) obj.spec = spec;
    Object.assign(this.mowerChip!, {
      kind: c.kind,
      icon: c.icon,
      text: c.text || "",
    }); // set above when it was missing
    obj.position.set(c.x, this.mowerHeight(c.x, c.y, c.floorId) + 0.5, -c.y);
    obj.visible = this._mowerShows(c.floorId);
    this.mowerChip!.floorId = c.floorId; // set above when it was missing
    this.view.dirty = true;
  }

  _warningVisible(): void {
    if (!this.warning) return; // callers check for one
    this.warning.sprite.visible = this._mowerShows(this.warning.floorId);
  }

  // Path the mower drove: { segments: [[[x, y], ...], ...] (plan metres), floorId, color, width, opacity }
  // or null. A flat ribbon (one quad per step) 1 cm over the floor, rebuilt only when the points change.
  setMowerTrack(t: MowerTrackSpec | null | undefined): void {
    const cur = this.mowerTrack;
    const sig = t
      ? JSON.stringify([t.segments, t.floorId, t.color, t.width, t.opacity])
      : null;
    if (cur && cur.sig === sig) return;
    if (cur) {
      this.view.mowerGroup.remove(cur.mesh);
      cur.mesh.geometry.dispose();
      cur.mesh.material.dispose();
      this.mowerTrack = null;
      this.view.dirty = true;
    }
    if (!t || !t.segments || !t.segments.length) return;
    const y = this.view.floorElevation(t.floorId) + 0.01,
      half = (t.width || 0.05) / 2;
    const pos: number[] = [];
    for (const seg of t.segments) {
      for (let i = 1; i < seg.length; i++) {
        const [x0, y0] = seg[i - 1],
          [x1, y1] = seg[i];
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 1e-4) continue;
        const nx = (-(y1 - y0) / len) * half,
          ny = ((x1 - x0) / len) * half;
        // world (x, h, -y); two triangles per step
        const a = [x0 + nx, y, -(y0 + ny)],
          b = [x0 - nx, y, -(y0 - ny)],
          c = [x1 + nx, y, -(y1 + ny)],
          d = [x1 - nx, y, -(y1 - ny)];
        pos.push(...a, ...b, ...c, ...c, ...b, ...d);
      }
    }
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(t.color || "#4fc3f7"),
      transparent: true,
      opacity: t.opacity ?? 0.7,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -1;
    mesh.userData.helper = true; // never picked by the model ray
    mesh.raycast = () => {};
    mesh.visible = this._mowerShows(t.floorId);
    this.view.mowerGroup.add(mesh);
    this.mowerTrack = { mesh, sig, floorId: t.floorId };
    this.view.dirty = true;
  }

  // World position of the warning sprite while shown (the tap target), else null.
  warningWorld(): THREE.Vector3 | null {
    const w = this.warning;
    return w && w.sprite.visible ? w.sprite.position.clone() : null;
  }
}
