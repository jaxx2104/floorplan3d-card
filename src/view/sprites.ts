// The view's GPU sprites (view/billboards.ts): the icon resolver and the billboard layer, the markers' look
// per frame (opacity in front of / behind the model, hover scale, tappable or not: marker-sprite.ts
// markerDraw), drawing after the frame and picking on screen.
import * as THREE from "three";
import { BillboardLayer, type Billboard } from "./billboards.ts";
import { IconResolver } from "./icons.ts";
import { markerDraw } from "../marker-sprite.ts";
import { pickAt, type PickItem, type SpriteSpec } from "../sprite-atlas.ts";
import type { FloorplanView } from "../view.ts";

/** What the card says about all markers: night quiet, the hovered marker. */
export interface MarkerMode {
  quiet: boolean;
  hover: string | null;
}

export const COMPACT_PPM = 30; // zoomed out below this: compact markers

export class ViewSprites {
  view: FloorplanView;
  icons: IconResolver;
  layer: BillboardLayer;
  mode: MarkerMode;

  constructor(view: FloorplanView) {
    this.view = view;
    this.icons = new IconResolver(view.container);
    this.layer = new BillboardLayer(view.container, this.icons);
    const dirty = () => {
      this.view.dirty = true;
    };
    this.icons.onChange = dirty;
    this.layer.onChange = dirty;
    this.mode = { quiet: false, hover: null };
  }

  /** Theme / CSS changed: every sprite painted again. */
  invalidate(): void {
    this.layer.invalidate();
    this.view.dirty = true;
  }

  /** A marker's picture and whether it is an alert that is on (stays at night). */
  setMarkerSprite(id: string, spec: SpriteSpec | null, alert: boolean): void {
    const e = this.view.markerObjects.get(id);
    if (!e) return;
    const same = e.obj.spec && spec && e.obj.spec.key === spec.key;
    if (!same) {
      e.obj.spec = spec;
      this.view.dirty = true;
    }
    if (e.alert !== alert) {
      e.alert = alert;
      this.applyMarkerDraw(id);
    }
  }

  setMarkerMode(mode: Partial<MarkerMode>): void {
    const m = { ...this.mode, ...mode };
    const was = this.mode;
    if (m.quiet === was.quiet && m.hover === was.hover) return;
    this.mode = m;
    if (m.quiet !== was.quiet) this.applyMarkerDraw();
    else {
      if (was.hover) this.applyMarkerDraw(was.hover);
      if (m.hover) this.applyMarkerDraw(m.hover);
    }
  }

  /** Opacity / scale / pickability of one marker or all of them from their state and the mode. */
  applyMarkerDraw(id?: string): void {
    const one = id !== undefined ? this.view.markerObjects.get(id) : null;
    const list: [string, NonNullable<typeof one>][] = one
      ? [[id!, one]]
      : [...this.view.markerObjects];
    for (const [mid, e] of list) {
      const d = markerDraw({
        faded: !!e.faded,
        quiet: this.mode.quiet,
        alert: !!e.alert,
        hover: this.mode.hover === mid,
      });
      const b = e.obj;
      if (
        b.alpha !== d.alpha ||
        b.hiddenAlpha !== d.hiddenAlpha ||
        b.spriteScale !== d.scale
      )
        this.view.dirty = true;
      b.alpha = d.alpha;
      b.hiddenAlpha = d.hiddenAlpha;
      b.spriteScale = d.scale;
      e.pickable = d.pickable;
    }
  }

  /** The frame's sprites over the bound framebuffer (depth: the scene's, when the model hides markers). */
  draw(depth: THREE.Texture | null): number {
    const v = this.view;
    this.layer.setSize(!!v.model, v.cam.pixelsPerMetre() < COMPACT_PPM);
    return this.layer.draw(v.renderer, v.scene, v.camera, depth);
  }

  _rect(): DOMRect {
    return this.view.renderer.domElement.getBoundingClientRect();
  }

  /** Where a marker is drawn (client px; anchor, scale, tappable rects), null when it is not. */
  markerScreen(id: string): PickItem | null {
    const e = this.view.markerObjects.get(id);
    if (!e) return null;
    const v = this.view;
    v.scene.updateMatrixWorld();
    v.camera.updateMatrixWorld();
    return this.layer.screenOf(e.obj, v.scene, v.camera, this._rect());
  }

  /** Marker ids under a client point that take a tap, the one on top first (hidden ones skipped in view mode). */
  markersAt(x: number, y: number): string[] {
    const v = this.view;
    const items = this.layer
      .pickItems(v.scene, v.camera, this._rect())
      .filter((it) => {
        const e = v.markerObjects.get(it.id);
        return !!e && e.obj.pickId === it.id && e.pickable !== false;
      });
    const occ = v.occlusion.active();
    return pickAt(items, x, y).filter((id) => {
      const e = v.markerObjects.get(id)!;
      if (!occ) return true;
      e.obj.updateWorldMatrix(true, false);
      return !v.occlusion.pointHidden(
        e.obj.getWorldPosition(new THREE.Vector3()),
      );
    });
  }

  /** Whether the model hides a marker now (what a tap in view mode sees; the picture dims per pixel). */
  markerHidden(id: string): boolean {
    const v = this.view,
      e = v.markerObjects.get(id);
    if (!e || !v.occlusion.active()) return false;
    e.obj.updateWorldMatrix(true, false);
    return v.occlusion.pointHidden(e.obj.getWorldPosition(new THREE.Vector3()));
  }

  /** Texts of the room / object labels (the headless checks): drawn now, or all that exist. */
  labels(kind: "room" | "object", all = false): string[] {
    const v = this.view;
    v.scene.updateMatrixWorld();
    const out: string[] = [];
    const rect = this._rect();
    for (const b of this.layer.items)
      if (
        b.userData.labelKind === kind &&
        b.userData.text &&
        (all || this.layer.screenOf(b, v.scene, v.camera, rect))
      )
        out.push(b.userData.text);
    return out;
  }

  remove(b: Billboard): void {
    this.layer.remove(b);
  }

  dispose(): void {
    this.layer.dispose();
    this.icons.dispose();
  }
}
