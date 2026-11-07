// Plan structure of the floorplan view: floors, room labels, the markers (GPU sprites,
// view/billboards.ts) and the theme. The scene groups and the marker / css object maps stay on the
// view (visibility runs over them).

import * as THREE from "three";
import { centroid } from "../placement.ts";
import { planToWorld, type ViewRoom, type ViewTheme } from "./core.ts";
import type { FloorplanView } from "../view.ts";
import type { Floor } from "../types/layout.ts";
import { Billboard } from "./billboards.ts";
import { labelSprite } from "../label-sprite.ts";

/** A marker to show (setMarkers); its picture comes with setMarkerSprite. */
export interface MarkerSpec {
  id: string;
  x: number;
  y: number;
  z: number;
  floorId: string;
}
export interface StructureOptions {
  labels?: boolean;
}

export class PlanStructure {
  view: FloorplanView;

  constructor(view: FloorplanView) {
    this.view = view;
  }

  moveMarker(
    id: string,
    x: number,
    y: number,
    z: number,
    floorId: string,
  ): void {
    const m = this.view.markerObjects.get(id);
    if (!m) return;
    m.obj.position.copy(
      planToWorld(x, y, z, this.view.floorElevation(floorId)),
    );
    // only this marker: visibility (it may have crossed the section cut)
    const c = this.view.cssObjects.find(
      (o) => o.kind === "marker" && o.id === id,
    );
    if (c) c.obj.visible = this.view._markerVisible(c);
    this.view.dirty = true;
  }

  setTheme(theme: ViewTheme): void {
    this.view.theme = theme;
    this.view.look._applyLook();
    this.view.sprites.invalidate(); // the sprites' colours come from the card's CSS
    this.view.dirty = true;
  }

  // floors: [{id, elevation, height}], rooms: [{room, floorId, label}]
  setStructure(
    floors: Floor[],
    rooms: ViewRoom[],
    { labels = true }: StructureOptions = {},
  ): void {
    this.view.floors = floors;
    this.view._rooms = rooms;
    this.view.skyLayer._updateRoomMask();
    this.view._clearGroup(this.view.staticGroup);
    this.view.cssObjects = this.view.cssObjects.filter(
      (c) => c.kind !== "label",
    );
    for (const f of floors) {
      const group = new THREE.Group();
      group.userData.floorId = f.id;
      group.position.y = f.elevation;
      for (const { room, label } of rooms.filter((r) => r.floorId === f.id)) {
        if (!label || !labels || !room.polygon || room.polygon.length < 3)
          continue;
        const obj = this.view.sprites.layer.add(new Billboard());
        obj.spec = labelSprite(label, { italic: !!room.outdoor });
        obj.userData.text = label;
        obj.userData.labelKind = "room";
        const [cx, cy] = centroid(room.polygon);
        obj.position.set(cx, 0.02, -cy);
        group.add(obj);
        this.view.cssObjects.push({ obj, floorId: f.id, kind: "label" });
      }
      this.view.staticGroup.add(group);
    }
    this.view.cam._bounds = this.view.cam._sceneBounds();
    this.view._applyFloorVisibility();
    this.view.dirty = true;
  }

  // markers: [{id, x, y, z, floorId}]; an id kept keeps its sprite (setMarkerSprite)
  setMarkers(markers: MarkerSpec[]): void {
    const was = new Map(this.view.markerObjects);
    for (const { obj } of was.values()) this.view._removeCss(obj);
    this.view.markerObjects.clear();
    this.view.cssObjects = this.view.cssObjects.filter(
      (c) => c.kind !== "marker",
    );
    for (const m of markers) {
      const old = was.get(m.id);
      const obj = this.view.sprites.layer.add(new Billboard());
      obj.pickId = m.id;
      if (old) {
        obj.spec = old.obj.spec;
        obj.alpha = old.obj.alpha;
        obj.hiddenAlpha = old.obj.hiddenAlpha;
      }
      obj.position.copy(
        planToWorld(m.x, m.y, m.z, this.view.floorElevation(m.floorId)),
      );
      this.view.markerGroup.add(obj);
      this.view.markerObjects.set(m.id, {
        obj,
        floorId: m.floorId,
        alert: old ? old.alert : false,
      });
      this.view.cssObjects.push({
        obj,
        floorId: m.floorId,
        kind: "marker",
        id: m.id,
      });
    }
    this.view._applyFloorVisibility();
    this.view.dirty = true;
  }
}
