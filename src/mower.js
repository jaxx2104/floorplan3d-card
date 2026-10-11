// Robot mower support: read a position from an HA entity and map it onto the plan.
//
// Two source kinds:
//  - gps: entity has latitude/longitude attributes (or "lat,lon" state). Converted to local
//         metres around the first calibration point, then fitted to the plan.
//  - xy:  entity has raw map coordinates in attributes (names configurable).
//
// Calibration points pair a source reading (u, v) with a plan point (x, y).
// 1 point  -> translation only (needs gps, assumes north-up plan)
// 2 points -> similarity transform (shift, rotate, uniform scale)
// 3+ points -> least-squares affine transform

const R_EARTH = 6378137;

// Number() turns null and '' into 0, which would put the mower at the origin.
function num(v) {
  if (v === null || v === undefined || v === '') return NaN;
  return Number(v);
}

export function readSource(stateObj, cfg) {
  if (!stateObj) return null;
  const a = stateObj.attributes || {};
  if ((cfg.source || 'gps') === 'xy') {
    const u = num(a[cfg.x_attr || 'x']);
    const v = num(a[cfg.y_attr || 'y']);
    return Number.isFinite(u) && Number.isFinite(v) ? { u, v, raw: [u, v] } : null;
  }
  let lat = num(a.latitude), lon = num(a.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const m = String(stateObj.state).match(/(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)/);
    if (!m) return null;
    lat = Number(m[1]);
    lon = Number(m[2]);
  }
  return { lat, lon, raw: [lat, lon] };
}

// The path driven so far, from an xy source's track_attr: [[[u, v], ...], ...] (one list per segment,
// a flat [[u, v], ...] is one segment) -> segments of readings for the transform, or null.
export function readTrack(stateObj, cfg) {
  if (!stateObj || cfg.source !== 'xy' || !cfg.track_attr) return null;
  const raw = (stateObj.attributes || {})[cfg.track_attr];
  if (!Array.isArray(raw) || !raw.length) return null;
  const segs = Array.isArray(raw[0]) && Array.isArray(raw[0][0]) ? raw : [raw];
  const out = [];
  for (const seg of segs) {
    if (!Array.isArray(seg)) continue;
    const pts = [];
    for (const p of seg) {
      const u = Array.isArray(p) ? num(p[0]) : NaN, v = Array.isArray(p) ? num(p[1]) : NaN;
      if (Number.isFinite(u) && Number.isFinite(v)) pts.push({ u, v });
    }
    if (pts.length > 1) out.push(pts);
  }
  return out.length ? out : null;
}

// Convert a reading to planar (u, v) metres. For gps, origin = first calibration point.
export function toPlanar(reading, origin) {
  if (!reading) return null;
  if (reading.lat === undefined) return [reading.u, reading.v];
  const o = origin || { lat: reading.lat, lon: reading.lon };
  const u = ((reading.lon - o.lon) * Math.PI / 180) * R_EARTH * Math.cos((o.lat * Math.PI) / 180);
  const v = ((reading.lat - o.lat) * Math.PI / 180) * R_EARTH;
  return [u, v];
}

// Fit a transform from calibration points. Returns f([u,v]) -> [x,y] or null.
export function fitTransform(points, sourceKind) {
  if (!points || !points.length) return null;
  const origin = sourceKind === 'xy' ? null : { lat: points[0].src[0], lon: points[0].src[1] };
  const rd = (src) => (sourceKind === 'xy' ? { u: src[0], v: src[1] } : { lat: src[0], lon: src[1] });
  const pairs = points.map((p) => ({ s: toPlanar(rd(p.src), origin), d: p.plan }));

  let f;
  if (pairs.length === 1) {
    const { s, d } = pairs[0];
    f = ([u, v]) => [d[0] + (u - s[0]), d[1] + (v - s[1])];
  } else if (pairs.length === 2) {
    // similarity via complex numbers: d = a*s + b
    const [p, q] = pairs;
    const su = q.s[0] - p.s[0], sv = q.s[1] - p.s[1];
    const du = q.d[0] - p.d[0], dv = q.d[1] - p.d[1];
    const den = su * su + sv * sv || 1e-9;
    const ar = (du * su + dv * sv) / den;
    const ai = (dv * su - du * sv) / den;
    const br = p.d[0] - (ar * p.s[0] - ai * p.s[1]);
    const bi = p.d[1] - (ar * p.s[1] + ai * p.s[0]);
    f = ([u, v]) => [ar * u - ai * v + br, ar * v + ai * u + bi];
  } else {
    // affine least squares: x = a u + b v + c ; y = d u + e v + f
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const bx = [0, 0, 0], by = [0, 0, 0];
    for (const { s, d } of pairs) {
      const r = [s[0], s[1], 1];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) A[i][j] += r[i] * r[j];
        bx[i] += r[i] * d[0];
        by[i] += r[i] * d[1];
      }
    }
    const cx = solve3(A, bx), cy = solve3(A, by);
    if (!cx || !cy) return fitTransform(points.slice(0, 2), sourceKind);
    f = ([u, v]) => [cx[0] * u + cx[1] * v + cx[2], cy[0] * u + cy[1] * v + cy[2]];
  }
  return (reading) => {
    const s = toPlanar(reading, origin);
    return s ? f(s) : null;
  };
}

function solve3(A, b) {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-12) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const k = m[r][c] / m[c][c];
      for (let k2 = c; k2 < 4; k2++) m[r][k2] -= k * m[c][k2];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

// Image URL for an image.* or camera.* entity (entity_picture carries the access token).
export function overlayUrl(hass, entityId, bust) {
  const st = hass && hass.states[entityId];
  if (!st || !st.attributes.entity_picture) return null;
  if (/^(data|blob):/.test(st.attributes.entity_picture)) return st.attributes.entity_picture; // immutable, no base
  const url = hass.hassUrl ? hass.hassUrl(st.attributes.entity_picture) : st.attributes.entity_picture;
  if (!bust) return url;
  return url + (url.includes('?') ? '&' : '?') + '_t=' + bust;
}

// Root mean square distance (metres) between calibration plan points and where the fitted
// transform puts their readings. 0 for 1-2 points (they fit exactly).
export function calibrationError(points, sourceKind) {
  const f = fitTransform(points, sourceKind);
  if (!f || points.length < 3) return 0;
  let sum = 0;
  for (const p of points) {
    const q = f(sourceKind === 'xy' ? { u: p.src[0], v: p.src[1] } : { lat: p.src[0], lon: p.src[1] });
    sum += (q[0] - p.plan[0]) ** 2 + (q[1] - p.plan[1]) ** 2;
  }
  return Math.sqrt(sum / points.length);
}

// Position on the plan for the current reading, or null. Without calibration, xy readings are
// taken as plan metres; gps needs at least one calibration point.
export function mowerTransform(cfg) {
  const kind = cfg.source === 'xy' ? 'xy' : 'gps';
  const pts = cfg.calibration || [];
  if (pts.length) return fitTransform(pts, kind);
  return kind === 'xy' ? (r) => (r ? [r.u, r.v] : null) : null;
}
