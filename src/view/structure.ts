// Plan structure of the floorplan view: floors, room fills / outlines / labels and cut-away walls, the
// DOM markers and their edit-mode stems, light glows, the editor overlay and the theme. The scene
// groups and the marker / glow / css object maps stay on the view (visibility runs over them).

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { centroid } from '../placement.ts';
import { wallSegments } from '../layout.ts';
import { planToWorld, type ViewRoom, type ViewTheme } from './core.ts';
import type { FloorplanView } from '../view.ts';
import type { Floor, PlanPoint } from '../types/layout.ts';
import { OCCLUSION_DELAY_MS } from './occlusion.ts';

const WALL_THICKNESS = 0.12;
const GLOW_RADIUS = 2.2;

/** Editor overlay (setOverlay): outlines, fills and DOM handles in plan metres. */
export interface OverlayLine { points: PlanPoint[]; closed?: boolean; floorId: string; color?: THREE.ColorRepresentation }
export interface OverlayFill { points: PlanPoint[]; floorId: string; color?: THREE.ColorRepresentation; opacity?: number }
export interface OverlayHandle { element: HTMLElement; x: number; y: number; floorId: string }
export interface OverlaySpec {
  lines?: OverlayLine[];
  fills?: OverlayFill[];
  handles?: OverlayHandle[];
}
/** A marker to show (setMarkers). */
export interface MarkerSpec { id: string; element: HTMLElement; x: number; y: number; z: number; floorId: string }
/** A light that is on (setGlows): rgb 0..255, strength 0..1. */
export interface GlowSpec { id: string; x: number; y: number; floorId: string; rgb: number[]; strength: number }
export interface StructureOptions { wallHeight?: number; walls?: boolean; fills?: boolean; outlines?: boolean; labels?: boolean }
/** Edit-mode stem of a marker: line to the floor and a disc on it. */
export interface Stem { line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>; disc: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> }
interface StemResources {
  lineGeo: THREE.BufferGeometry;
  discGeo: THREE.CircleGeometry;
  lineMat: THREE.LineBasicMaterial;
  discMat: THREE.MeshBasicMaterial;
}

let glowTexture: THREE.CanvasTexture | null = null;
function getGlowTexture(): THREE.CanvasTexture {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!; // a fresh 2D canvas context
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowTexture = new THREE.CanvasTexture(c);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

export class PlanStructure {
  view: FloorplanView;
  stems: Map<string, Stem>;
  _stemsOn: boolean;
  _stemRes: StemResources | null;

  constructor(view: FloorplanView) {
    this.view = view;
    this.stems = new Map(); // id -> { line, disc }
    this._stemsOn = false;
    this._stemRes = null; // shared geometries + materials of the current stems
  }

  // Editor overlay. lines: [{points, closed, floorId, color}], fills: [{points, floorId, color, opacity}],
  // handles: [{element, x, y, floorId}] (DOM, CSS2D).
  setOverlay({ lines = [], fills = [], handles = [] }: OverlaySpec = {}): void {
    this.view._clearGroup(this.view.overlayGroup);
    this.view.cssObjects = this.view.cssObjects.filter((c) => c.kind !== 'handle');
    for (const f of fills) {
      if (f.points.length < 3) continue;
      const geo = new THREE.ShapeGeometry(new THREE.Shape(f.points.map(([x, y]) => new THREE.Vector2(x, y))));
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: f.color, transparent: true, opacity: f.opacity ?? 0.18, depthTest: false, side: THREE.DoubleSide,
      }));
      mesh.position.y = this.view.floorElevation(f.floorId) + 0.02;
      mesh.renderOrder = 9;
      mesh.userData.floorId = f.floorId;
      mesh.userData.helper = true;
      this.view.overlayGroup.add(mesh);
    }
    for (const l of lines) {
      if (l.points.length < 2) continue;
      const pts = l.points.map(([x, y]) => new THREE.Vector3(x, 0, -y));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color: l.color, depthTest: false, transparent: true });
      const line = l.closed ? new THREE.LineLoop(geo, mat) : new THREE.Line(geo, mat);
      line.position.y = this.view.floorElevation(l.floorId) + 0.03;
      line.renderOrder = 10;
      line.userData.floorId = l.floorId;
      line.userData.helper = true;
      this.view.overlayGroup.add(line);
    }
    for (const h of handles) {
      const obj = new CSS2DObject(h.element);
      obj.position.copy(planToWorld(h.x, h.y, 0.03, this.view.floorElevation(h.floorId)));
      this.view.overlayGroup.add(obj);
      this.view.cssObjects.push({ obj, floorId: h.floorId, kind: 'handle' });
    }
    this.view._applyFloorVisibility();
    this.view.dirty = true;
  }

  moveMarker(id: string, x: number, y: number, z: number, floorId: string): void {
    const m = this.view.markerObjects.get(id);
    if (!m) return;
    m.obj.position.copy(planToWorld(x, y, z, this.view.floorElevation(floorId)));
    const g = this.view.glows.get(id);
    if (g) g.mesh.position.copy(planToWorld(x, y, 0.03, this.view.floorElevation(floorId)));
    // only this marker: visibility (it may have crossed the section cut) and its own occlusion
    const c = this.view.cssObjects.find((o) => o.kind === 'marker' && o.id === id);
    if (c) c.obj.visible = this.view._markerVisible(c);
    if (g) g.mesh.visible = this.view._glowVisible(id, g);
    const st = this.stems.get(id);
    if (st) st.disc.visible = m.obj.visible;
    this._placeStem(id, m.obj.position, floorId);
    this.view.occlusion._scheduleOcclusion(OCCLUSION_DELAY_MS, id);
    this.view.dirty = true;
  }

  setTheme(theme: ViewTheme): void {
    this.view.theme = theme;
    this.view.look._applyLook();
    for (const g of this.view.glows.values()) {
      g.mesh.material.blending = theme.dark ? THREE.AdditiveBlending : THREE.NormalBlending;
      g.mesh.material.needsUpdate = true;
    }
    this.view.dirty = true;
  }

  // floors: [{id, elevation, height}], rooms: [{room, floorId, label}]
  setStructure(floors: Floor[], rooms: ViewRoom[], { wallHeight = 1.0, walls = true, fills = true, outlines = true, labels = true }: StructureOptions = {}): void {
    this.view.floors = floors;
    this.view._rooms = rooms;
    this.view.skyLayer._updateRoomMask();
    this.view.wallHeight = wallHeight;
    this.view._clearGroup(this.view.staticGroup);
    this.view.cssObjects = this.view.cssObjects.filter((c) => c.kind !== 'label');
    const t = this.view.theme;
    // polygon offset: room floors win over a GLB model's slab at the same height (no z-fighting)
    const offset = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
    const floorMat = new THREE.MeshLambertMaterial({ color: t.floor, side: THREE.DoubleSide, ...offset });
    const outdoorMat = new THREE.MeshLambertMaterial({ color: t.outdoor, side: THREE.DoubleSide, transparent: true, opacity: 0.7, ...offset });
    const wallMat = new THREE.MeshLambertMaterial({ color: t.wall });
    const edgeMat = new THREE.LineBasicMaterial({ color: t.edge });

    for (const f of floors) {
      const group = new THREE.Group();
      group.userData.floorId = f.id;
      group.position.y = f.elevation;
      const own = rooms.filter((r) => r.floorId === f.id);
      for (const { room, label } of own) {
        if (!room.polygon || room.polygon.length < 3) continue;
        const shape = new THREE.Shape(room.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
        if (fills) {
          const geo = new THREE.ShapeGeometry(shape);
          geo.rotateX(-Math.PI / 2);
          const mesh = new THREE.Mesh(geo, room.outdoor ? outdoorMat : floorMat);
          mesh.position.y = room.outdoor ? -0.01 : 0;
          mesh.userData.roomId = room.id;
          group.add(mesh);
        }
        if (outlines) {
          const outline = new THREE.LineLoop(
            new THREE.BufferGeometry().setFromPoints(room.polygon.map(([x, y]) => new THREE.Vector3(x, 0.005, -y))),
            edgeMat,
          );
          outline.userData.helper = true;
          group.add(outline);
        }
        if (label && labels) {
          const el = document.createElement('div');
          el.className = 'fp-room-label' + (room.outdoor ? ' outdoor' : '');
          el.textContent = label;
          const obj = new CSS2DObject(el);
          const [cx, cy] = centroid(room.polygon);
          obj.position.set(cx, 0.02, -cy);
          obj.center.set(0.5, 0.5);
          group.add(obj);
          this.view.cssObjects.push({ obj, floorId: f.id, kind: 'label' });
        }
      }
      for (const w of walls ? wallSegments(own.map((r) => r.room)) : []) {
        const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1];
        const len = Math.hypot(dx, dy);
        const box = new THREE.Mesh(new THREE.BoxGeometry(len + WALL_THICKNESS, wallHeight, WALL_THICKNESS), wallMat);
        box.position.set((w.a[0] + w.b[0]) / 2, wallHeight / 2, -(w.a[1] + w.b[1]) / 2);
        box.rotation.y = Math.atan2(dy, dx);
        group.add(box);
      }
      this.view.staticGroup.add(group);
    }
    this.view.cam._bounds = this.view.cam._sceneBounds();
    this.view._applyFloorVisibility();
    this.view.dirty = true;
  }

  // markers: [{id, element, x, y, z, floorId}]
  setMarkers(markers: MarkerSpec[]): void {
    for (const { obj } of this.view.markerObjects.values()) this.view._removeCss(obj);
    this.view.markerObjects.clear();
    this.view.cssObjects = this.view.cssObjects.filter((c) => c.kind !== 'marker');
    for (const m of markers) {
      const obj = new CSS2DObject(m.element);
      obj.position.copy(planToWorld(m.x, m.y, m.z, this.view.floorElevation(m.floorId)));
      this.view.markerGroup.add(obj);
      this.view.markerObjects.set(m.id, { obj, floorId: m.floorId });
      this.view.cssObjects.push({ obj, floorId: m.floorId, kind: 'marker', id: m.id });
    }
    if (this._stemsOn) this._buildStems();
    this.view._occSig = null; // new elements carry no occlusion state yet
    this.view._applyFloorVisibility();
    this.view.dirty = true;
  }

  // Edit mode: a thin vertical line from every shown marker down to its floor plus a small disc
  // on the floor, so a marker at mounting height reads as standing over one spot while orbiting.
  setStems(on: unknown): void {
    this._stemsOn = !!on;
    if (on) this._buildStems();
    else this._disposeStems();
    this.view._applyFloorVisibility();
    this.view.dirty = true;
  }

  _stemColor(): THREE.Color {
    const c = new THREE.Color('#03a9f4');
    try {
      const css = getComputedStyle(this.view.container).getPropertyValue('--primary-color').trim();
      if (/^(#|rgba?\(|hsla?\()/i.test(css)) c.setStyle(css);
    } catch { /* detached or unparsable: keep the fallback */ }
    return c;
  }

  _buildStems(): void {
    this._disposeStems();
    const color = this._stemColor();
    const res: StemResources = {
      lineGeo: new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)]),
      discGeo: new THREE.CircleGeometry(0.08, 24).rotateX(-Math.PI / 2),
      lineMat: new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false }),
      discMat: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }),
    };
    this._stemRes = res;
    for (const [id, m] of this.view.markerObjects) {
      const line = new THREE.Line(res.lineGeo, res.lineMat);
      const disc = new THREE.Mesh(res.discGeo, res.discMat);
      line.renderOrder = disc.renderOrder = 3;
      line.userData.stemId = disc.userData.stemId = id;
      line.userData.helper = disc.userData.helper = true;
      this.view.stemGroup.add(line, disc);
      this.stems.set(id, { line, disc });
      this._placeStem(id, m.obj.position, m.floorId);
    }
  }

  _placeStem(id: string, world: THREE.Vector3, floorId: string): void {
    const st = this.stems.get(id);
    if (!st) return;
    const floor = this.view.floorElevation(floorId);
    const h = Math.max(world.y - floor, 0);
    st.line.position.set(world.x, floor, world.z);
    st.line.scale.set(1, Math.max(h, 1e-4), 1);
    st.line.userData.height = h;
    st.disc.position.set(world.x, floor + 0.05, world.z); // above room fills (+0.02), glows
    st.line.visible = st.disc.visible && h > 0.01;
  }

  _disposeStems(): void {
    for (const { line, disc } of this.stems.values()) this.view.stemGroup.remove(line, disc);
    this.stems.clear();
    if (this._stemRes) {
      for (const r of Object.values(this._stemRes)) r.dispose();
      this._stemRes = null;
    }
  }

  // glows: [{id, x, y, floorId, rgb, strength}] (lights that are on)
  setGlows(glows: GlowSpec[]): void {
    const seen = new Set<string>();
    let changed = false;
    for (const g of glows) {
      seen.add(g.id);
      let entry = this.view.glows.get(g.id);
      if (!entry) {
        const mat = new THREE.MeshBasicMaterial({
          map: getGlowTexture(), transparent: true, depthWrite: false, toneMapped: false,
          blending: this.view.theme.dark ? THREE.AdditiveBlending : THREE.NormalBlending,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
        mesh.renderOrder = 2;
        this.view.glowGroup.add(mesh);
        entry = { mesh, floorId: g.floorId };
        this.view.glows.set(g.id, entry);
      }
      const sig = [g.x, g.y, g.floorId, this.view.floorElevation(g.floorId), g.rgb.join(), g.strength, this.view.theme.dark].join('|');
      const { mesh } = entry;
      const vis = this.view._glowVisible(g.id, entry);
      if (sig === entry.sig && vis === mesh.visible) continue; // nothing new for this glow
      entry.sig = sig;
      changed = true;
      entry.floorId = g.floorId;
      mesh.position.copy(planToWorld(g.x, g.y, 0.03, this.view.floorElevation(g.floorId)));
      mesh.visible = this.view._glowVisible(g.id, entry); // glows cast no shadow and hide no marker
      const r = GLOW_RADIUS * (0.6 + 0.4 * g.strength) * 2;
      mesh.scale.set(r, 1, r);
      mesh.material.color.setRGB(g.rgb[0] / 255, g.rgb[1] / 255, g.rgb[2] / 255, THREE.SRGBColorSpace);
      mesh.material.opacity = (this.view.theme.dark ? 0.75 : 0.55) * g.strength;
    }
    for (const [id, entry] of this.view.glows) {
      if (seen.has(id)) continue;
      this.view.glowGroup.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
      this.view.glows.delete(id);
      changed = true;
    }
    if (changed) this.view.dirty = true; // per-push calls with the same glows draw nothing
  }
}
