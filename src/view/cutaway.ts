// View-dependent cutaway of the model (cutaway.ts, fp.cutaway): per frame that drew, the sides of the house
// facing the camera show their `low` nodes and cut their thin `clip` parts, the others their `full` nodes.
// Only the visibility and one clipping plane per side change, so a switch costs no shader rebuild; the shadow
// maps are redrawn when a side switched. The cutaway hides only nodes that were showing and shows again only the
// ones it hid, so a node hidden by a view rule stays hidden; the view's visibility pass releases the cutaway
// before it writes the rules and reapplies it after (applyModelVisibility).

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
  /** the nodes the cutaway hid (shown again when their side switches or the cutaway is released) */
  _cut: Set<THREE.Object3D> = new Set();
  _sig = "";
  _dir = new THREE.Vector3();
  _p = new THREE.Vector3();

  /** Take the model's fp.cutaway nodes (after the merge, which keeps them as their own groups). */
  setModel(
    root: THREE.Object3D | null,
    cutaways: readonly ManifestCutaway<THREE.Object3D>[],
  ): void {
    this.release();
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
      else if (c.variant === "low") s.lows.push(c.node);
      else {
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
    this.reapply();
  }

  /** Show the nodes the cutaway hid (before a visibility pass writes every node). */
  release(): void {
    for (const n of this._cut) n.visible = true;
    this._cut.clear();
  }

  /** Hide the nodes of each side's other variant again (after a visibility pass or a release). */
  reapply(): void {
    for (const s of this._sides.values()) this._show(s);
  }

  _show(s: Side): void {
    for (const n of s.low ? s.full : s.lows)
      if (n.visible) {
        n.visible = false;
        this._cut.add(n);
      }
    for (const n of s.low ? s.lows : s.full)
      if (this._cut.delete(n)) n.visible = true;
  }

  /** The world height of the side's clip (the model's placement may change while the side stays low). */
  _clipY(s: Side): number {
    return s.low && s.clip !== null && this._root
      ? this._root.localToWorld(this._p.set(0, s.clip, 0)).y
      : OFF;
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
      if (low !== s.low) {
        s.low = low;
        changed = true;
        this._show(s);
      }
      const y = this._clipY(s);
      if (y !== s.plane.constant) {
        s.plane.constant = y;
        changed = true;
      }
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
