// Type-based auto placement of devices inside room polygons.
// Plan coordinates are metres: x = east, y = north. z = height above the floor.

import type { PlanPoint } from "./types/layout.ts";

// ---------- geometry ----------
export function signedArea(poly: readonly PlanPoint[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function centroid(poly: readonly PlanPoint[]): PlanPoint {
  const a = signedArea(poly);
  if (Math.abs(a) < 1e-9) {
    const n = poly.length || 1;
    return [
      poly.reduce((s, p) => s + p[0], 0) / n,
      poly.reduce((s, p) => s + p[1], 0) / n,
    ];
  }
  let cx = 0,
    cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

export function pointInPolygon(
  [x, y]: readonly [number, number],
  poly: readonly PlanPoint[],
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function perimeter(poly: readonly PlanPoint[]): number {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
}

// Point at distance d along the perimeter, pushed `inset` metres into the room.
function pointOnPerimeter(
  poly: readonly PlanPoint[],
  d: number,
  inset: number,
): PlanPoint {
  const ccw = signedArea(poly) > 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d <= len || i === poly.length - 1) {
      const t = len ? Math.min(d, len) / len : 0;
      const dx = (b[0] - a[0]) / (len || 1),
        dy = (b[1] - a[1]) / (len || 1);
      // inward normal: left of edge for CCW polygons, right for CW
      const nx = ccw ? -dy : dy,
        ny = ccw ? dx : -dx;
      return [
        a[0] + (b[0] - a[0]) * t + nx * inset,
        a[1] + (b[1] - a[1]) * t + ny * inset,
      ];
    }
    d -= len;
  }
  return poly[0];
}

// Corner spots, `inset` metres into the room. A convex room keeps the push toward the centroid.
// In a concave room the centroid can lie outside the floor, so each convex corner is pushed along
// its interior bisector instead (shrinking the push until the spot is inside); reflex corners are
// skipped, a device there would face the walls of the notch.
function cornerSpots(poly: readonly PlanPoint[], inset: number): PlanPoint[] {
  const sign = Math.sign(signedArea(poly)) || 1;
  const n = poly.length;
  const turn = (i: number): number => {
    const a = poly[(i + n - 1) % n],
      p = poly[i],
      b = poly[(i + 1) % n];
    return (
      sign * ((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]))
    );
  };
  const d = inset * 1.4;
  if (poly.every((_, i) => turn(i) >= -1e-12)) {
    const c = centroid(poly);
    return poly.map((p): PlanPoint => {
      const dx = c[0] - p[0],
        dy = c[1] - p[1];
      const l = Math.hypot(dx, dy) || 1;
      return [p[0] + (dx / l) * d, p[1] + (dy / l) * d];
    });
  }
  const spots: PlanPoint[] = [];
  for (let i = 0; i < n; i++) {
    if (turn(i) <= 1e-12) continue; // reflex or straight
    const a = poly[(i + n - 1) % n],
      p = poly[i],
      b = poly[(i + 1) % n];
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]),
      lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    // at a convex corner the sum of the unit edge vectors points into the room
    const bx = (a[0] - p[0]) / la + (b[0] - p[0]) / lb,
      by = (a[1] - p[1]) / la + (b[1] - p[1]) / lb;
    const l = Math.hypot(bx, by);
    for (let k = d; k > d / 16; k /= 2) {
      const q: PlanPoint = [p[0] + (bx / l) * k, p[1] + (by / l) * k];
      if (pointInPolygon(q, poly)) {
        spots.push(q);
        break;
      }
    }
  }
  return spots;
}

// ---------- type rules ----------
// anchor: center (ceiling grid), wall (spread along walls), corner, door (near a room door)
// z: metres above floor, or 'ceiling' (room height minus a bit)
export type Anchor = "center" | "wall" | "corner" | "door";
export interface PlacementRule {
  anchor: Anchor;
  z: number | "ceiling";
}
type MatchRule = PlacementRule & {
  match: (domain: string, deviceClass: string | undefined) => boolean;
};
const oneOf = (list: readonly string[], c: string | undefined): boolean =>
  c !== undefined && list.includes(c);

const RULES: MatchRule[] = [
  { match: (d) => d === "light", anchor: "center", z: "ceiling" },
  { match: (d) => d === "fan", anchor: "center", z: "ceiling" },
  {
    match: (d, c) =>
      d === "binary_sensor" &&
      oneOf(["smoke", "gas", "carbon_monoxide", "heat"], c),
    anchor: "center",
    z: "ceiling",
  },
  {
    match: (d, c) =>
      d === "binary_sensor" && oneOf(["motion", "occupancy", "presence"], c),
    anchor: "corner",
    z: "ceiling",
  },
  {
    match: (d, c) =>
      d === "binary_sensor" && oneOf(["door", "garage_door", "opening"], c),
    anchor: "door",
    z: 1.0,
  },
  {
    match: (d, c) => d === "binary_sensor" && c === "window",
    anchor: "wall",
    z: 1.2,
  },
  { match: (d) => d === "lock", anchor: "door", z: 1.0 },
  { match: (d) => d === "cover", anchor: "wall", z: 1.8 },
  { match: (d) => d === "camera", anchor: "corner", z: 2.3 },
  {
    match: (d) => d === "climate" || d === "water_heater" || d === "humidifier",
    anchor: "wall",
    z: 1.5,
  },
  {
    match: (d) => d === "switch" || d === "input_boolean",
    anchor: "door",
    z: 1.1,
  },
  {
    match: (d) => d === "sensor" || d === "binary_sensor",
    anchor: "wall",
    z: 1.5,
  },
  { match: (d) => d === "media_player", anchor: "wall", z: 0.8 },
  {
    match: (d) => d === "vacuum" || d === "lawn_mower",
    anchor: "center",
    z: 0.1,
  },
];

export function ruleFor(domain: string, deviceClass?: string): PlacementRule {
  return (
    RULES.find((r) => r.match(domain, deviceClass)) || {
      anchor: "wall",
      z: 1.2,
    }
  );
}

// Domains that never get a marker of their own.
export const SKIP_DOMAINS = new Set([
  "update",
  "button",
  "number",
  "select",
  "text",
  "event",
  "scene",
  "script",
  "automation",
  "zone",
  "person",
  "sun",
  "image",
  "tts",
  "stt",
  "conversation",
  "wake_word",
  "todo",
  "calendar",
  "notify",
  "input_number",
  "input_select",
  "input_text",
  "input_datetime",
  "input_button",
  "counter",
  "timer",
  "schedule",
  "date",
  "time",
  "datetime",
  "siren",
  "device_tracker",
  "remote",
  "weather",
  "assist_satellite",
]);

// When several entities share a device, the marker uses the highest priority one.
const PRIORITY = [
  "light",
  "fan",
  "cover",
  "climate",
  "lock",
  "switch",
  "media_player",
  "camera",
  "vacuum",
  "lawn_mower",
  "water_heater",
  "humidifier",
  "valve",
  "alarm_control_panel",
  "binary_sensor",
  "sensor",
];
export function domainPriority(domain: string): number {
  const i = PRIORITY.indexOf(domain);
  return i === -1 ? 99 : i;
}

// Sensor classes worth choosing as a primary entity over others of the same device.
const SENSOR_PRIORITY = [
  "temperature",
  "humidity",
  "carbon_dioxide",
  "illuminance",
  "power",
  "energy",
];
export function sensorPriority(dc: string | undefined): number {
  const i = dc === undefined ? -1 : SENSOR_PRIORITY.indexOf(dc);
  return i === -1 ? 50 : i;
}

// ---------- layout ----------
// markers: [{id, domain, deviceClass}] belonging to one room.
// Returns Map id -> {x, y, z, auto: true}
export interface PlaceInput {
  id: string;
  domain: string;
  deviceClass?: string;
}
export interface AutoPosition {
  x: number;
  y: number;
  z: number;
  auto: true;
}
type Placed = { m: PlaceInput; r: PlacementRule };

export function autoPlace(
  room: {
    polygon?: readonly PlanPoint[] | null;
    doors?: readonly PlanPoint[] | null;
  },
  markers: readonly PlaceInput[],
  roomHeight = 2.7,
): Map<string, AutoPosition> {
  const out = new Map<string, AutoPosition>();
  const poly = room.polygon;
  if (!poly || poly.length < 3) return out;
  const inset = 0.25;
  const groups: Record<Anchor, Placed[]> = {
    center: [],
    wall: [],
    corner: [],
    door: [],
  };
  for (const m of [...markers].sort((a, b) => a.id.localeCompare(b.id))) {
    const r = ruleFor(m.domain, m.deviceClass);
    groups[r.anchor].push({ m, r });
  }
  const zOf = (r: PlacementRule): number =>
    r.z === "ceiling" ? Math.max(0.3, roomHeight - 0.08) : r.z;

  // center: spiral grid around centroid, only points inside the room
  if (groups.center.length) {
    const c = centroid(poly);
    const step = 0.7;
    const candidates: PlanPoint[] = [];
    for (
      let ring = 0;
      candidates.length < groups.center.length && ring < 40;
      ring++
    ) {
      for (let i = -ring; i <= ring; i++) {
        for (let j = -ring; j <= ring; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
          const p: PlanPoint = [c[0] + i * step, c[1] + j * step];
          if (pointInPolygon(p, poly)) candidates.push(p);
        }
      }
    }
    if (!candidates.length)
      candidates.push(cornerSpots(poly, inset)[0] ?? poly[0]);
    groups.center.forEach(({ m, r }, i) => {
      const p = candidates[i % candidates.length];
      out.set(m.id, { x: p[0], y: p[1], z: zOf(r), auto: true });
    });
  }

  // corners: one per usable corner, then wrap
  if (groups.corner.length) {
    const spots = cornerSpots(poly, inset);
    if (!spots.length) spots.push(pointOnPerimeter(poly, 0.3, inset));
    groups.corner.forEach(({ m, r }, i) => {
      const p = spots[i % spots.length];
      out.set(m.id, { x: p[0], y: p[1], z: zOf(r), auto: true });
    });
  }

  // door: near the room's first door (or the first vertex), spread sideways
  if (groups.door.length) {
    const door = room.doors && room.doors[0];
    const per = perimeter(poly);
    let start = 0.3;
    if (door) {
      // find perimeter distance closest to the door point
      let best = Infinity;
      for (let d = 0; d < per; d += 0.05) {
        const p = pointOnPerimeter(poly, d, 0);
        const dist = Math.hypot(p[0] - door[0], p[1] - door[1]);
        if (dist < best) {
          best = dist;
          start = d + 0.5;
        }
      }
    }
    groups.door.forEach(({ m, r }, i) => {
      const p = pointOnPerimeter(poly, (start + i * 0.35) % per, inset);
      out.set(m.id, { x: p[0], y: p[1], z: zOf(r), auto: true });
    });
  }

  // wall: spread evenly around the perimeter, offset to avoid corners
  if (groups.wall.length) {
    const per = perimeter(poly);
    const n = groups.wall.length;
    groups.wall.forEach(({ m, r }, i) => {
      const p = pointOnPerimeter(
        poly,
        (((i + 0.5) / n) * per + per * 0.07) % per,
        inset,
      );
      out.set(m.id, { x: p[0], y: p[1], z: zOf(r), auto: true });
    });
  }
  return out;
}

export function snap(v: number, step = 0.05): number {
  return Math.round(v / step) * step;
}
