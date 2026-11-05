// Helpers shared by the view parts (src/view/*) and re-exported from src/view.

import * as THREE from "three";
import type { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { LayoutRoom, Vec3 } from "../types/layout.ts";

declare global {
  interface Window {
    /** Set by the demo's ?test=1: cheaper rendering for the headless checks. Never set in HA. */
    __floorplan3dTest?: boolean;
  }
}

// Narrowing helpers for scene-graph walks (traverse hands out Object3D; three's is* flags tell the kind).
export const isMesh = (o: THREE.Object3D | null | undefined): o is THREE.Mesh =>
  !!o && (o as Partial<THREE.Mesh>).isMesh === true;
export const isCss2d = (
  o: THREE.Object3D | null | undefined,
): o is CSS2DObject =>
  !!o && (o as { isCSS2DObject?: boolean }).isCSS2DObject === true; // three sets the flag; its types omit it
/** The view's two camera kinds. */
export type ViewCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
export const isPerspective = (c: THREE.Camera): c is THREE.PerspectiveCamera =>
  (c as Partial<THREE.PerspectiveCamera>).isPerspectiveCamera === true;
/** Object that carries geometry and material(s): Mesh, Line, Points, Sprite. */
export type Drawable = THREE.Object3D & {
  geometry?: THREE.BufferGeometry;
  material?: THREE.Material | THREE.Material[];
};
/** The materials of a mesh as an array (its one material wrapped). */
export const meshMaterials = (o: {
  material: THREE.Material | THREE.Material[];
}): THREE.Material[] => (Array.isArray(o.material) ? o.material : [o.material]);

/** Texture slots of the glTF materials (MeshStandard / MeshPhysical / MeshBasic). */
export type TexKey =
  | "map"
  | "normalMap"
  | "roughnessMap"
  | "metalnessMap"
  | "aoMap"
  | "emissiveMap"
  | "bumpMap"
  | "alphaMap";
/** A model material as the view reads it: any Material, plus the fields the glTF material kinds may carry. */
export type ModelMaterial = THREE.Material &
  Partial<Record<TexKey, THREE.Texture | null>> & {
    color?: THREE.Color;
    emissive?: THREE.Color;
    transmission?: number;
  };

// --- the view's contract with its parts and callers ---

/** A CSS2D object the view tracks for floor visibility: marker, room label or editor handle. */
export interface CssEntry {
  obj: CSS2DObject;
  floorId: string;
  kind: "marker" | "label" | "handle";
  id?: string;
}
/** A drawn room on its floor (setStructure). */
export interface ViewRoom {
  room: LayoutRoom;
  floorId: string;
  label?: string | null;
}
/** view.markerObjects value. */
export interface MarkerEntry {
  obj: CSS2DObject;
  floorId: string;
}
/** view.glows value: the glow under a light that is on. */
export interface GlowEntry {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  floorId: string;
  sig?: string;
}
/** Card theme (floorplan3d-card _applyTheme); { dark: false } until the card sets one. */
export interface ViewTheme {
  dark: boolean;
  floor?: THREE.ColorRepresentation;
  outdoor?: THREE.ColorRepresentation;
  wall?: THREE.ColorRepresentation;
  edge?: THREE.ColorRepresentation;
  primary?: THREE.ColorRepresentation;
}
/** Marker visibility override per marker id (setMarkerStates). */
export interface MarkerState {
  shown?: boolean;
  faded?: boolean;
}
/** Saved 3D camera. */
export interface CameraPose {
  position: Vec3 | number[];
  target: Vec3 | number[];
}
/** Saved top camera: centre in plan metres, zoom 1 = 10 m half height. */
export interface TopCameraPose {
  center: [number, number] | number[];
  zoom: number;
}
/** A plane as plain data (card world or model space). */
export interface PlaneData {
  normal: Vec3 | number[];
  constant: number;
}
/** World box as arrays. */
export interface BoxData {
  min: number[];
  max: number[];
}

/** Plan metres (x east, y north, z up from the floor) to Three.js world coordinates. */
export function planToWorld(
  x: number,
  y: number,
  z: number,
  elevation = 0,
): THREE.Vector3 {
  return new THREE.Vector3(x, elevation + z, -y);
}

// Headless test mode (the demo's ?test=1 sets window.__floorplan3dTest): cheaper rendering for the
// checks: pixel ratio 1, small shadow maps and sky textures, no cloud drift. Never set in HA.
export const testMode = (): boolean =>
  typeof window !== "undefined" && !!window.__floorplan3dTest;

// Frame interval (ms) of an animation (idle orbit, clouds, rain / snow, sway): its own default, or with
// the card option max_fps that many frames a second for all of them. 2 ms under the period, so a 60 Hz
// requestAnimationFrame whose gaps jitter around 16.7 ms is not cut to every other frame.
export function frameInterval(base: number, maxFps: unknown): number {
  const f = Number(maxFps);
  return f > 0 ? Math.max(0, 1000 / f - 2) : base;
}
