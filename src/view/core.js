// Helpers shared by the view parts (src/view/*.js) and re-exported from src/view.js.

import * as THREE from 'three';

export function planToWorld(x, y, z, elevation = 0) {
  return new THREE.Vector3(x, elevation + z, -y);
}

// Headless test mode (the demo's ?test=1 sets window.__floorplan3dTest): cheaper rendering for the
// checks: pixel ratio 1, small shadow maps and sky textures, no cloud drift. Never set in HA.
export const testMode = () => typeof window !== 'undefined' && !!window.__floorplan3dTest;

// Frame interval (ms) of an animation (idle orbit, clouds, rain / snow, sway): its own default, or with
// the card option max_fps that many frames a second for all of them. 2 ms under the period, so a 60 Hz
// requestAnimationFrame whose gaps jitter around 16.7 ms is not cut to every other frame.
export function frameInterval(base, maxFps) {
  const f = Number(maxFps);
  return f > 0 ? Math.max(0, 1000 / f - 2) : base;
}
