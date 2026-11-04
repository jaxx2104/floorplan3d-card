// Helpers shared by the view parts (src/view/*) and re-exported from src/view.

import * as THREE from 'three';

declare global {
  interface Window {
    /** Set by the demo's ?test=1: cheaper rendering for the headless checks. Never set in HA. */
    __floorplan3dTest?: boolean;
  }
}

/** Plan metres (x east, y north, z up from the floor) to Three.js world coordinates. */
export function planToWorld(x: number, y: number, z: number, elevation = 0): THREE.Vector3 {
  return new THREE.Vector3(x, elevation + z, -y);
}

// Headless test mode (the demo's ?test=1 sets window.__floorplan3dTest): cheaper rendering for the
// checks: pixel ratio 1, small shadow maps and sky textures, no cloud drift. Never set in HA.
export const testMode = (): boolean => typeof window !== 'undefined' && !!window.__floorplan3dTest;

// Frame interval (ms) of an animation (idle orbit, clouds, rain / snow, sway): its own default, or with
// the card option max_fps that many frames a second for all of them. 2 ms under the period, so a 60 Hz
// requestAnimationFrame whose gaps jitter around 16.7 ms is not cut to every other frame.
export function frameInterval(base: number, maxFps: unknown): number {
  const f = Number(maxFps);
  return f > 0 ? Math.max(0, 1000 / f - 2) : base;
}
