// View-dependent cutaway of the model (cutaway.ts, fp.cutaway): per frame that drew, the sides of the house
// facing the camera show their `low` nodes and cut their thin `clip` parts, the others their `full` nodes.
// Only the visibility and one clipping plane per side change, so a switch costs no shader rebuild; the shadow
// maps are redrawn when a side switched.

import * as THREE from "three";
import { sideLow, viewHorizontal } from "../cutaway.ts";
import { isMesh } from "./core.ts";
import type { ManifestCutaway } from "../types/manifest.ts";

const OFF = 1e6; // a clipping plane constant that keeps everything
const baseOf = new WeakMap<THREE.Material, THREE.Material>(); // a clip clone -> the model's material

interface Side {
  facing: [number, number];
  low: boolean;
  full: THREE.Object3D[];
  lows: THREE.Object3D[];
  /** keeps y <= its height (world) while the side is low */
  plane: THREE.Plane;
  clip: number | null;
}

export class ModelCutaway {
  _sides: Map<string, Side> = new Map();
  _root: THREE.Object3D | null = null;
  _sig = "";
  _dir = new THREE.Vector3();
  _p = new THREE.Vector3();

  /** Take the model's fp.cutaway nodes (after the merge, which keeps them as their own groups). */
  setModel(
    root: THREE.Object3D | null,
    cutaways: readonly ManifestCutaway<THREE.Object3D>[],
  ): void {
    this._sides.clear();
    this._root = root;
    this._sig = "";
    if (!root) return;
    for (const c of cutaways) {
      let s = this._sides.get(c.side);
      if (!s) {
        s = {
          facing: c.facing,
          low: false,
          full: [],
          lows: [],
          plane: new THREE.Plane(new THREE.Vector3(0, -1, 0), OFF),
          clip: null,
        };
        this._sides.set(c.side, s);
      }
      if (c.variant === "full") s.full.push(c.node);
      else if (c.variant === "low") {
        s.lows.push(c.node);
        c.node.visible = false;
      } else {
        s.clip = c.clip;
        // the thin part's own materials (they are shared with parts of other sides or uncut ones), cloned from
        // the model's material again when the model is set again (after its merge)
        c.node.traverse((o) => {
          if (!isMesh(o)) return;
          const own = (m: THREE.Material) => {
            const base = baseOf.get(m) || m;
            const k = base.clone();
            baseOf.set(k, base);
            k.clippingPlanes = [...(m.clippingPlanes || []), s!.plane];
            k.clipShadows = true;
            return k;
          };
          o.material = Array.isArray(o.material)
            ? o.material.map(own)
            : own(o.material);
        });
      }
    }
  }

  /** Switch the sides for the camera. True when a side switched (the shadow maps are stale). */
  update(camera: THREE.Camera, target: THREE.Vector3): boolean {
    if (!this._sides.size || !this._root) return false;
    const off = this._p.copy(camera.position).sub(target);
    const view = viewHorizontal([off.x, off.y, off.z]);
    let changed = false;
    for (const s of this._sides.values()) {
      // the facing in the world: the model may be rotated by its placement
      const d = this._dir
        .set(s.facing[0], 0, s.facing[1])
        .transformDirection(this._root.matrixWorld);
      const low = sideLow([d.x, d.z], view, s.low);
      if (low === s.low) continue;
      s.low = low;
      changed = true;
      for (const n of s.full) n.visible = !low;
      for (const n of s.lows) n.visible = low;
      s.plane.constant =
        low && s.clip !== null
          ? this._root.localToWorld(this._p.set(0, s.clip, 0)).y
          : OFF;
    }
    if (changed)
      this._sig = [...this._sides.entries()]
        .filter(([, s]) => s.low)
        .map(([id]) => id)
        .join(",");
    return changed;
  }

  /** Which sides are low, for the shadow / still signatures. */
  get sig(): string {
    return this._sig;
  }
}
