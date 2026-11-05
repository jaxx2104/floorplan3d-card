// Animated screens: a material whose glTF extras carry fp_anim = { frames, fps, entity, above? } shows one
// frame of its textures at a time. The frames are stacked top to bottom in one image and the model's UVs
// cover frame 0 (the top 1/frames of the image), so a card without this module shows frame 0 still.
// The screen plays while its entity is on: state 'on', or a number above `above` when that is given
// (e.g. a desk plug's power for monitors). Off, its emissive goes dark. No entity: always on.

import type * as THREE from "three";
import type { HassEntity } from "./types/ha.ts";
import { isMesh, meshMaterials } from "./view/core.ts";

const TEX = ["map", "emissiveMap"] as const;

export interface ScreenAnim {
  frames: number;
  fps: number;
  entity: string | null;
  above: number | null;
}

/** A material that may carry textures and an emissive colour (MeshStandardMaterial and the like). */
export type ScreenMaterial = THREE.Material & {
  map?: THREE.Texture | null;
  emissiveMap?: THREE.Texture | null;
  emissive?: THREE.Color;
};

export interface Screen {
  mat: ScreenMaterial;
  anim: ScreenAnim;
  emissive: THREE.Color | null;
  frame: number;
  on: boolean;
}

// The animation spec of a material, or null.
export function animOf(
  mat: THREE.Material | null | undefined,
): ScreenAnim | null {
  const a: unknown = mat && mat.userData && mat.userData.fp_anim;
  if (!a || typeof a !== "object") return null;
  const spec = a as {
    frames?: unknown;
    fps?: unknown;
    entity?: unknown;
    above?: unknown;
  };
  const frames = Math.floor(Number(spec.frames));
  const fps = Number(spec.fps);
  if (!(frames > 1) || !(fps > 0)) return null;
  const above = spec.above == null ? null : Number(spec.above);
  return {
    frames,
    fps,
    entity: typeof spec.entity === "string" ? spec.entity : null,
    above: Number.isFinite(above) ? above : null,
  };
}

// Is the screen showing, given hass.states?
export function screenOn(
  anim: ScreenAnim,
  states: Record<string, HassEntity> | null | undefined,
): boolean {
  if (!anim.entity) return true;
  const st = states && states[anim.entity];
  if (!st) return false;
  if (anim.above !== null) {
    const v = Number(st.state);
    return Number.isFinite(v) && v > anim.above;
  }
  return st.state === "on";
}

// Frame index at time t (seconds).
export const frameAt = (anim: ScreenAnim, t: number): number =>
  Math.floor(Math.max(0, t) * anim.fps) % anim.frames;

// Every animated material under root (each once): { mat, anim, emissive (the modelled colour), frame, on }.
export function collectScreens(root: THREE.Object3D): Screen[] {
  const out: Screen[] = [],
    seen = new Set<THREE.Material>();
  root.traverse((o) => {
    if (!isMesh(o)) return;
    for (const mat of meshMaterials(o) as ScreenMaterial[]) {
      if (!mat || seen.has(mat)) continue;
      seen.add(mat);
      const anim = animOf(mat);
      if (!anim) continue;
      out.push({
        mat,
        anim,
        emissive: mat.emissive ? mat.emissive.clone() : null,
        frame: 0,
        on: true,
      });
    }
  });
  return out;
}

// Show frame k of a screen. -> true when it changed.
export function showFrame(s: Screen, k: number): boolean {
  if (s.frame === k) return false;
  s.frame = k;
  for (const key of TEX) {
    const tex = s.mat[key];
    if (tex) tex.offset.y = k / s.anim.frames; // glTF UVs: v grows down the image, frame k sits k/frames lower
  }
  return true;
}

// Turn a screen on or off (off: no glow, back to frame 0). -> true when it changed.
export function setScreenOn(s: Screen, on: boolean): boolean {
  if (s.on === on) return false;
  s.on = on;
  if (s.mat.emissive && s.emissive) {
    if (on) s.mat.emissive.copy(s.emissive);
    else s.mat.emissive.setRGB(0, 0, 0);
  }
  if (!on) showFrame(s, 0);
  return true;
}
