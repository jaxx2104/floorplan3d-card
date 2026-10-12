// Rain and snow around the house: falling streaks / flakes in the open air around the rooms, animated in
// the vertex shader from a time uniform (no buffer updates), kept off the rooms twice: no drop starts
// over a room footprint (world x / z, with a margin), and fragments over the rooms on screen are
// discarded (a mask of the on-screen room hulls), so nothing falls in front of a room either.
import * as THREE from 'three';
import { CLOUD_WIND } from './cloud-shadow.js';

// Amounts 0..1 of rain and snow for a weather condition.
const CONDITIONS = {
  rainy: { rain: 0.6, snow: 0 }, pouring: { rain: 1, snow: 0 }, 'lightning-rainy': { rain: 0.8, snow: 0 }, hail: { rain: 0.7, snow: 0 },
  snowy: { rain: 0, snow: 0.7 }, 'snowy-rainy': { rain: 0.4, snow: 0.4 },
};
export function precipAmounts(condition) {
  return CONDITIONS[condition] || { rain: 0, snow: 0 };
}

// Drop counts at amount 1, fall speeds (m/s), rain streak length (m), sideways drift per metre of fall.
export const RAIN_MAX = 1600;
export const SNOW_MAX = 1400;
export const RAIN_SPEED = 7;
export const SNOW_SPEED = 0.9;
export const RAIN_LEN = 0.6;
export const RAIN_SLANT = 0.12;
// Room footprint margin (m) without drops, and the frame rate while it rains / snows.
export const PRECIP_ROOM_MARGIN = 0.6;
export const PRECIP_FRAME_MS = 33;

// Point in polygon ([[x, y], ...], plan coordinates) or within margin of its edges.
export function nearPolygon(poly, x, y, margin = 0) {
  let inside = false, best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    const ex = xi - xj, ey = yi - yj, l2 = ex * ex + ey * ey || 1;
    const t = Math.max(0, Math.min(1, ((x - xj) * ex + (y - yj) * ey) / l2));
    best = Math.min(best, Math.hypot(x - xj - t * ex, y - yj - t * ey));
  }
  return inside || best <= margin;
}

// Deterministic drop bases in a square of half-size `half` (m) around centre [x, z] (world), none
// over the room polygons (plan coordinates: world z = -y) within margin: Float32Array of
// [x, z, phase 0..1] per drop.
export function placeDrops(count, centre, half, rooms = [], margin = PRECIP_ROOM_MARGIN) {
  let seed = 424242;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const out = new Float32Array(count * 3);
  let n = 0;
  for (let tries = 0; n < count && tries < count * 20; tries++) {
    const x = centre[0] + (rnd() * 2 - 1) * half, z = centre[1] + (rnd() * 2 - 1) * half;
    if (rooms.some((p) => nearPolygon(p, x, -z, margin))) continue;
    out.set([x, z, rnd()], n * 3);
    n++;
  }
  return out.subarray(0, n * 3);
}

const VERT = `
attribute vec3 aDrop; // x, z, phase
attribute float aEnd; // rain: 0 head, 1 tail of the streak
uniform float uTime, uTop, uBottom, uSpeed, uLen, uWobble, uSize;
uniform vec2 uWind;
void main() {
  float h = max(0.1, uTop - uBottom);
  float fall = mod(aDrop.z * h + uTime * uSpeed, h);
  vec3 p = vec3(aDrop.x + uWind.x * fall, uTop - fall, aDrop.y + uWind.y * fall);
  p.x += uWobble * sin(uTime * 0.9 + aDrop.z * 40.0);
  p.z += uWobble * cos(uTime * 0.7 + aDrop.z * 31.0);
  p += vec3(-uWind.x, 1.0, -uWind.y) * uLen * aEnd; // the tail trails up and against the drift
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize / max(0.5, -mv.z);
}
`;
const FRAG = `
uniform sampler2D uMask;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float uOpacity, uRound;
void main() {
  if (texture2D(uMask, gl_FragCoord.xy / uRes).r > 0.5) discard; // over a room on screen
  float a = uOpacity;
  if (uRound > 0.5) { vec2 q = gl_PointCoord * 2.0 - 1.0; float r = dot(q, q); if (r > 1.0) discard; a *= 1.0 - r * r; }
  gl_FragColor = vec4(uColor, a);
}
`;

// Shared uniforms of both layers.
export function makePrecipUniforms() {
  return {
    uTime: { value: 0 }, uTop: { value: 10 }, uBottom: { value: 0 }, uMask: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
  };
}

// A rain (LineSegments) or snow (Points) layer for drop bases from placeDrops; own uniforms for speed,
// look and drift, the shared ones (time, range, mask) by reference.
export function makePrecipLayer(kind, drops, shared) {
  const n = drops.length / 3, g = new THREE.BufferGeometry(), rain = kind === 'rain';
  const per = rain ? 2 : 1, aDrop = new Float32Array(n * per * 3), aEnd = new Float32Array(n * per), pos = new Float32Array(n * per * 3);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < per; k++) { aDrop.set(drops.subarray(i * 3, i * 3 + 3), (i * per + k) * 3); aEnd[i * per + k] = k; }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); // unused (the shader places the drops)
  g.setAttribute('aDrop', new THREE.BufferAttribute(aDrop, 3));
  g.setAttribute('aEnd', new THREE.BufferAttribute(aEnd, 1));
  const wind = rain ? [CLOUD_WIND[0] * RAIN_SLANT, CLOUD_WIND[1] * RAIN_SLANT] : [CLOUD_WIND[0] * 0.25, CLOUD_WIND[1] * 0.25];
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
    uniforms: {
      ...shared,
      uSpeed: { value: rain ? RAIN_SPEED : SNOW_SPEED }, uLen: { value: rain ? RAIN_LEN : 0 }, uWobble: { value: rain ? 0 : 0.25 },
      uSize: { value: rain ? 1 : 150 }, uWind: { value: new THREE.Vector2(...wind) },
      uColor: { value: new THREE.Color(rain ? 0x8fa3bd : 0xffffff) }, uOpacity: { value: rain ? 0.55 : 0.9 }, uRound: { value: rain ? 0 : 1 },
    },
  });
  const obj = rain ? new THREE.LineSegments(g, mat) : new THREE.Points(g, mat);
  obj.frustumCulled = false; // the shader moves the drops; the bounding box would be stale
  obj.userData.helper = true;
  obj.userData.precip = kind;
  obj.castShadow = obj.receiveShadow = false;
  obj.raycast = () => {};
  obj.renderOrder = 2;
  return obj;
}

// Screen mask of the room hulls (px from the centre, y up) as a canvas texture (red = room), drawn
// into an existing canvas texture when given.
export function drawRoomMask(hulls, width, height, tex = null, px = 256) {
  const t = tex || new THREE.CanvasTexture(document.createElement('canvas'));
  const c = t.image;
  c.width = c.height = px;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, px, px);
    g.fillStyle = '#fff';
    for (const h of hulls || []) {
      g.beginPath();
      h.forEach(([x, y], i) => { const u = ((x + width / 2) / width) * px, v = ((height / 2 - y) / height) * px; if (i) g.lineTo(u, v); else g.moveTo(u, v); });
      g.closePath();
      g.fill();
    }
    if (hulls === null) g.fillRect(0, 0, px, px); // camera in the rooms: all masked
  }
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}
