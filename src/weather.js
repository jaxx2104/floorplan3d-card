// Weather: cloud coverage from a weather entity, its effect on the light, cloud placement on the sky dome.

const RAD = Math.PI / 180;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Coverage (%) per condition when the entity has no numeric cloud_coverage.
const CONDITION_COVERAGE = {
  sunny: 0, 'clear-night': 0, partlycloudy: 40, cloudy: 85,
  fog: 100, rainy: 100, pouring: 100, snowy: 100, 'snowy-rainy': 100, lightning: 100,
  'lightning-rainy': 100, hail: 100, 'windy-variant': 100, windy: 30, exceptional: 50,
};

// Cloud sprites at full coverage; the shown count is round(coverage / 100 x max).
export const CLOUD_MAX = 12;
// Drift: azimuth swings +-CLOUD_DRIFT_DEG with angular rate CLOUD_DRIFT_RATE (rad/s of the phase),
// so the peak speed is 6 x 0.08 = 0.48 deg/s and clouds near the sun stay near it.
export const CLOUD_DRIFT_DEG = 6;
export const CLOUD_DRIFT_RATE = 0.08;
// Coverage change (percentage points) that re-applies light and clouds.
export const COVERAGE_STEP = 5;

// Coverage 0..100 of a weather state object (0 without one).
export function cloudCoverage(st) {
  if (!st) return 0;
  const raw = st.attributes ? st.attributes.cloud_coverage : undefined;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
  return CONDITION_COVERAGE[st.state] ?? 0;
}

// The weather entity: option weather (entity id | 'none' | false), default the first weather.* entity.
export function weatherEntity(config, states) {
  const opt = config ? config.weather : undefined;
  if (opt === 'none' || opt === false) return null;
  if (typeof opt === 'string' && opt) return opt;
  for (const id in states || {}) if (id.startsWith('weather.')) return id;
  return null;
}

// Light factors for coverage (%) and night 0..1: sun intensity, sun shadow radius / intensity,
// hemisphere fill (by day only), sun disc opacity, moon disc and moonlight.
export function cloudLight(coverage, night = 0) {
  const c = clamp01((Number(coverage) || 0) / 100), day = 1 - clamp01(Number(night) || 0);
  return {
    sun: 1 - 0.75 * c,
    shadowRadius: 1 + 3 * c,
    shadowIntensity: 1 - 0.65 * c,
    hemi: 1 + 0.35 * c * day,
    sunDisc: 1 - 0.8 * c,
    moon: 1 - 0.7 * c,
  };
}

export const cloudCount = (coverage, max = CLOUD_MAX) => Math.round(clamp01((Number(coverage) || 0) / 100) * max);

// True when the coverage moved enough to re-apply (first value, >= 5 points, or reaching 0 / 100).
export function coverageChanged(last, next) {
  if (last === null || last === undefined) return true;
  if (next === last) return false;
  return Math.abs(next - last) >= COVERAGE_STEP || next === 0 || next === 100;
}

// World unit vector for an azimuth (deg, clockwise from world -z) and elevation (deg); and back.
export function dirFromAzEl(az, el) {
  const a = az * RAD, e = el * RAD;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

export function azElFromDir(d) {
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return { az: ((Math.atan2(d[0], -d[2]) / RAD) % 360 + 360) % 360, el: Math.asin(Math.max(-1, Math.min(1, d[1] / len))) / RAD };
}

// Fixed cloud slots (deterministic): the first three sit around the anchor (sun / moon), so a partly
// cloudy sky partially covers its disc; the rest spread around the sky (golden-angle azimuths).
// size: sprite size as a fraction of the dome radius; variant: texture index 0..2.
let slots = null;
export function cloudSlots() {
  if (slots) return slots;
  const near = [[7, 1.5], [-10, -2], [3, -5.5]];
  slots = [];
  for (let i = 0; i < CLOUD_MAX; i++) {
    const r = (k) => { const x = Math.sin((i + 1) * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
    if (i < near.length) slots.push({ near: true, dAz: near[i][0], dEl: near[i][1], size: 0.5 + 0.12 * r(1), variant: i % 3, phase: r(2) * Math.PI * 2 });
    else slots.push({ near: false, az: (i * 137.508) % 360, el: 14 + 38 * r(3), size: 0.55 + 0.3 * r(1), variant: i % 3, phase: r(2) * Math.PI * 2 });
  }
  return slots;
}

// Azimuth / elevation (deg) of a slot at drift time t (s), anchor { az, el } (deg, world frame).
export function cloudAzEl(slot, anchor, t) {
  const a = anchor || { az: 0, el: 35 };
  const swing = CLOUD_DRIFT_DEG * Math.sin(CLOUD_DRIFT_RATE * t + slot.phase);
  const baseEl = Math.max(14, Math.min(60, a.el)); // near-sun clouds stay in the sky with a low / high sun
  const az = slot.near ? a.az + slot.dAz : a.az + slot.az;
  const el = slot.near ? (a.el < 8 ? 10 : Math.min(70, a.el)) + slot.dEl : slot.el + (baseEl - 35) * 0.2;
  return { az: (((az + swing) % 360) + 360) % 360, el: Math.max(6, Math.min(75, el)) };
}

// Clouds fade out as the camera orbits high over the house: full up to 50 deg of camera elevation
// (seen from the dome centre), gone from 65 deg (the camera looks down on their flat backs).
export const CLOUD_FADE_FROM_DEG = 50;
export const CLOUD_FADE_DEG = 15;
export function cloudFade(cam, centre) {
  const d = [cam[0] - centre[0], cam[1] - centre[1], cam[2] - centre[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (!len) return 0;
  const el = Math.asin(d[1] / len) * 180 / Math.PI;
  return Math.max(0, Math.min(1, (CLOUD_FADE_FROM_DEG + CLOUD_FADE_DEG - el) / CLOUD_FADE_DEG));
}

// Sky keep-out: clouds and the sun / moon discs never cover the rooms. The rooms' box is projected
// to the screen (convex hull, px); a sky sprite fades out as its centre comes within its own radius
// of that hull: full from SKY_CLEAR x radius outside, gone from SKY_TOUCH x radius (inside < 0).
export const SKY_CLEAR = 1;
export const SKY_TOUCH = 0.2;

// Convex hull of 2D points [[x, y], ...] (monotone chain), counter-clockwise in a y-up frame.
export function convexHull(points) {
  const p = points.map((q) => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const h = [];
    for (const q of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return [...half(p), ...half(p.slice().reverse())];
}

// Signed distance from a point to a convex polygon (from convexHull): > 0 outside, < 0 inside.
export function hullDistance(hull, pt) {
  if (!hull || !hull.length) return Infinity;
  if (hull.length === 1) return Math.hypot(pt[0] - hull[0][0], pt[1] - hull[0][1]);
  let out = -Infinity, edge = Infinity, inside = true;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey) || 1;
    const side = (ex * (pt[1] - a[1]) - ey * (pt[0] - a[0])) / len; // > 0 left of the edge (inside for ccw)
    if (side < 0) inside = false;
    out = Math.max(out, -side);
    const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * ex + (pt[1] - a[1]) * ey) / (len * len)));
    edge = Math.min(edge, Math.hypot(pt[0] - a[0] - t * ex, pt[1] - a[1] - t * ey));
  }
  return inside && hull.length > 2 ? Math.max(out, -edge) : edge;
}

// Opacity factor 0..1 of a sky sprite with screen radius r (px) at signed distance dist from the rooms.
export function skyKeepOut(dist, r) {
  if (!Number.isFinite(dist)) return 1;
  const rr = Math.max(1, Number(r) || 0);
  return clamp01((dist - SKY_TOUCH * rr) / ((SKY_CLEAR - SKY_TOUCH) * rr));
}

// Day cloud colour (hex) for the background behind them: white on a dark background (the default),
// a darker shade of a light background (luminance > 0.5) so white clouds don't vanish into it.
export const CLOUD_ON_LIGHT = 0.8;
export function cloudDayColor(bg) {
  const n = Number(bg) || 0, r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 <= 0.5) return 0xffffff;
  const k = (x) => Math.round(x * CLOUD_ON_LIGHT);
  return (k(r) << 16) | (k(g) << 8) | k(b);
}

// A cloud the camera is (nearly) inside: hidden.
export const cloudNear = (cam, cloud, size) => Math.hypot(cloud[0] - cam[0], cloud[1] - cam[1], cloud[2] - cam[2]) < size;
