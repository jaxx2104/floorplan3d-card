// Weather: cloud coverage from a weather entity, its effect on the light, the cloud layer and the sky keep-out.

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Coverage (%) per condition when the entity has no numeric cloud_coverage.
const CONDITION_COVERAGE = {
  sunny: 0, 'clear-night': 0, partlycloudy: 40, cloudy: 85,
  fog: 100, rainy: 100, pouring: 100, snowy: 100, 'snowy-rainy': 100, lightning: 100,
  'lightning-rainy': 100, hail: 100, 'windy-variant': 100, windy: 30, exceptional: 50,
};

// Cloud sprites at full coverage; the shown count is round(coverage / 100 x max).
export const CLOUD_MAX = 12;
// Drift: a cloud crosses the card sideways in CLOUD_CROSS_S seconds (wrapping around), and leaves /
// enters CLOUD_EDGE (fraction of the card width) beyond the edges so it never pops in on screen.
export const CLOUD_CROSS_S = 240;
export const CLOUD_EDGE = 0.25;
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

// Clouds are a screen layer, not sky on the dome: the 3D camera looks down past the horizon, so
// clouds in the sky would never be on screen. They form a band along the top edge of the card (half
// out of frame), where a camera framing the rooms leaves room; more clouds fill the band.
// Fixed slots (deterministic): u: 0 left .. 1 right, v: 0 top .. 1 bottom (centre), size: width as
// a fraction of the card's width (height half of it); variant: texture index 0..2. The rooms still
// keep them off where they reach the top (sky keep-out below).
let slots = null;
export function cloudSlots() {
  if (slots) return slots;
  slots = [];
  for (let i = 0; i < CLOUD_MAX; i++) {
    const r = (k) => { const x = Math.sin((i + 1) * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
    // u: golden-ratio sequence (evenly spread for any count), v: the top edge +- a little
    slots.push({ u: (i * 0.618034 + 0.13) % 1, v: 0.025 + 0.045 * r(3), size: 0.24 + 0.1 * r(1), variant: i % 3 });
  }
  return slots;
}

// Screen position { u, v } of a slot at drift time t (s): u moves right and wraps over
// [-CLOUD_EDGE, 1 + CLOUD_EDGE].
export function cloudScreen(slot, t) {
  const span = 1 + 2 * CLOUD_EDGE, x = (slot.u + CLOUD_EDGE + ((Number(t) || 0) / CLOUD_CROSS_S) * span) % span;
  return { u: x - CLOUD_EDGE, v: slot.v };
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

