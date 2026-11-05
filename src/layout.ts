// Pure layout helpers shared by the view and the editor: floors, room floors, walls, positions.
// Plan metres: x = east, y = north, z = height above the floor.

import { autoPlace, signedArea } from "./placement.ts";
import { floorsFromHA } from "./registry.ts";
import type { Marker } from "./registry.ts";
import type { Hass, HassEntity } from "./types/ha.ts";
import type {
  Floor,
  Layout,
  LayoutFloor,
  LayoutPin,
  LayoutRoom,
  PlanPoint,
} from "./types/layout.ts";
import type { CardConfig } from "./types/config.ts";
import type { PlanXYZ } from "./surface.ts";

/** A wall piece between two plan points (door gaps already cut out). */
export interface WallSegment {
  a: PlanPoint;
  b: PlanPoint;
}

/** Where a marker is drawn: plan metres on a floor (auto placed, pinned, attached or the live mower). */
export interface MarkerPosition extends PlanXYZ {
  floorId: string;
  auto: boolean;
  /** Attached to this model object (pin.attach). */
  attached?: string;
  /** The live mower (set by the card). */
  live?: boolean;
  /** Auto placed: the computed point, before the card moves it onto a model surface. */
  base?: PlanXYZ;
}

export type AttachResolver = (
  pin: LayoutPin,
  floorId: string,
) => { x: number; y: number; z: number } | null;
export type RoomLabelMode = "size" | "name" | "none";

export const DEFAULT_FLOOR_HEIGHT = 2.7;
export const LEVEL_SPACING = 3;

/** A stored floor entry or a model level override (the fields mergeFloors reads). */
export type FloorEntry = Pick<
  LayoutFloor,
  "id" | "name" | "elevation" | "height"
>;

// HA floors (auto-synced, elevation = level * 3) overlaid with what the layout stores.
// Layout-only floors are kept. Never returns an empty list.

export function mergeFloors(
  hass: Hass,
  layout: { floors?: readonly FloorEntry[] },
): Floor[] {
  const stored = new Map<string, FloorEntry>();
  for (const f of layout.floors || [])
    stored.set(f.id, { ...stored.get(f.id), ...f }); // merge per id
  const out = floorsFromHA(hass).map((f): Floor => {
    const s: Partial<FloorEntry> = stored.get(f.id) || {};
    stored.delete(f.id);
    return {
      id: f.id,
      name: f.name,
      elevation: s.elevation ?? f.level * LEVEL_SPACING,
      height: s.height ?? DEFAULT_FLOOR_HEIGHT,
    };
  });
  for (const s of stored.values()) {
    out.push({
      id: s.id,
      name: s.name || s.id,
      elevation: s.elevation ?? 0,
      height: s.height ?? DEFAULT_FLOOR_HEIGHT,
    });
  }
  if (!out.length)
    out.push({
      id: "ground",
      name: "Ground floor",
      elevation: 0,
      height: DEFAULT_FLOOR_HEIGHT,
    });
  return out.sort((a, b) => a.elevation - b.elevation);
}

// room.floor_id, else the area's floor, else the lowest floor.
export function roomFloorId(
  room: Pick<LayoutRoom, "floor_id" | "area_id">,
  hass: Hass,
  floors: readonly Floor[],
): string {
  if (room.floor_id && floors.some((f) => f.id === room.floor_id))
    return room.floor_id;
  const area =
    hass.areas && room.area_id ? hass.areas[room.area_id] : undefined;
  if (area && area.floor_id && floors.some((f) => f.id === area.floor_id))
    return area.floor_id;
  return floors[0].id;
}

function distToSegment(
  p: PlanPoint,
  a: PlanPoint,
  b: PlanPoint,
): { d: number; t: number } {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    : 0;
  return { d: Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]), t };
}

const ptKey = (p: PlanPoint): string =>
  Math.round(p[0] * 100) + "," + Math.round(p[1] * 100);

// Wall segments for the indoor rooms of one floor. Edges shared by two rooms are emitted once
// and doors (points near an edge) cut a gap of doorWidth into it.
export function wallSegments(
  rooms: readonly Pick<LayoutRoom, "outdoor" | "polygon" | "doors">[],
  { doorWidth = 0.9, doorSnap = 0.3 } = {},
): WallSegment[] {
  const edges = new Map<string, [PlanPoint, PlanPoint]>();
  const doors: PlanPoint[] = [];
  for (const r of rooms) {
    if (r.outdoor || !r.polygon || r.polygon.length < 3) continue;
    for (const d of r.doors || []) doors.push(d);
    const poly = r.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i],
        b = poly[(i + 1) % poly.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) continue;
      const ka = ptKey(a),
        kb = ptKey(b);
      const key = ka < kb ? ka + "|" + kb : kb + "|" + ka;
      if (!edges.has(key)) edges.set(key, [a, b]);
    }
  }
  // doors also apply to outdoor rooms (terrace door in an indoor wall)
  for (const r of rooms)
    if (r.outdoor) for (const d of r.doors || []) doors.push(d);

  const out: WallSegment[] = [];
  for (const [a, b] of edges.values()) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const gaps: [number, number][] = [];
    for (const d of doors) {
      const { d: dist, t } = distToSegment(d, a, b);
      if (dist > doorSnap) continue;
      const half = doorWidth / 2 / len;
      gaps.push([Math.max(0, t - half), Math.min(1, t + half)]);
    }
    gaps.sort((g, h) => g[0] - h[0]);
    let start = 0;
    const at = (t: number): PlanPoint => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
    ];
    for (const [g0, g1] of gaps) {
      if (g0 > start + 1e-6) out.push({ a: at(start), b: at(g0) });
      start = Math.max(start, g1);
    }
    if (start < 1 - 1e-6) out.push({ a: at(start), b: at(1) });
  }
  return out;
}

// Positions for all markers: pins win, otherwise auto placement inside the first room drawn
// for the marker's area. Returns Map id -> {x, y, z, floorId, auto}. Markers without a room
// and without a pin are left out (the editor lists them). attachAt(pin, floorId) resolves pins
// attached to a model object ({ x, y, z } or null = object not there: the stored position).
export function markerPositions(
  markers: readonly Marker[],
  layout: Pick<Layout, "rooms" | "pins">,
  hass: Hass,
  floors: readonly Floor[],
  attachAt: AttachResolver | null = null,
): Map<string, MarkerPosition> {
  const out = new Map<string, MarkerPosition>();
  const floorById = new Map(floors.map((f) => [f.id, f]));
  const roomByArea = new Map<string, LayoutRoom>();
  for (const r of layout.rooms || [])
    if (r.area_id && !roomByArea.has(r.area_id)) roomByArea.set(r.area_id, r);

  const perRoom = new Map<LayoutRoom, Marker[]>();
  for (const m of markers) {
    const pin = layout.pins && layout.pins[m.id];
    if (pin) {
      const floorId =
        pin.floor_id !== undefined && floorById.has(pin.floor_id)
          ? pin.floor_id
          : floors[0].id;
      const at = pin.attach && attachAt ? attachAt(pin, floorId) : null;
      out.set(
        m.id,
        at
          ? {
              x: at.x,
              y: at.y,
              z: at.z,
              floorId,
              auto: false,
              attached: pin.attach,
            }
          : { x: pin.x, y: pin.y, z: pin.z ?? 1.2, floorId, auto: false },
      );
      continue;
    }
    const room = m.areaId !== null ? roomByArea.get(m.areaId) : undefined;
    if (!room) continue;
    if (!perRoom.has(room)) perRoom.set(room, []);
    perRoom.get(room)!.push(m); // set just above
  }
  for (const [room, ms] of perRoom) {
    const floorId = roomFloorId(room, hass, floors);
    const placed = autoPlace(room, ms, floorById.get(floorId)!.height); // roomFloorId returns a floor of the list
    for (const [id, p] of placed) out.set(id, { ...p, floorId });
  }
  return out;
}

// Light glow: colour from rgb_color (or a warm white), strength from brightness.
export function lightGlow(
  stateObj: HassEntity | null | undefined,
): { rgb: [number, number, number]; strength: number } | null {
  if (!stateObj || stateObj.state !== "on") return null;
  const a = stateObj.attributes || {};
  const rgb: [number, number, number] =
    Array.isArray(a.rgb_color) && a.rgb_color.length === 3
      ? a.rgb_color
      : [255, 196, 120];
  const b =
    typeof a.brightness === "number" && Number.isFinite(a.brightness)
      ? a.brightness / 255
      : 1;
  return { rgb, strength: 0.25 + 0.75 * Math.max(0, Math.min(1, b)) };
}

// Room label text: name plus size (bounding width × depth for rectangles, area otherwise).
// Room label mode: card YAML room_labels wins over the layout's (Edit -> Rooms); default name and size.
const LABEL_MODES: readonly unknown[] = ["size", "name", "none"];
export function roomLabelMode(
  config: CardConfig | null | undefined,
  layout: Pick<Layout, "room_labels"> | null | undefined,
): RoomLabelMode {
  const v =
    (config && config.room_labels) || (layout && layout.room_labels) || "size";
  return LABEL_MODES.includes(v) ? (v as RoomLabelMode) : "size";
}

export function roomLabel(
  name: string | null | undefined,
  polygon: readonly PlanPoint[] | null | undefined,
  mode: RoomLabelMode = "size",
): string {
  if (mode === "none") return "";
  if (mode === "name" || !polygon || polygon.length < 3) return name || "";
  const axis =
    polygon.length === 4 &&
    polygon.every((p, i) => {
      const q = polygon[(i + 1) % 4];
      return Math.abs(p[0] - q[0]) < 0.01 || Math.abs(p[1] - q[1]) < 0.01;
    });
  let rect = axis;
  if (!rect && polygon.length === 4) {
    // Check for rotated rectangle with right angles using normalized edge directions
    const edges: PlanPoint[] = [];
    for (let i = 0; i < 4; i++) {
      const p = polygon[i],
        q = polygon[(i + 1) % 4];
      const dx = q[0] - p[0],
        dy = q[1] - p[1];
      const len = Math.hypot(dx, dy) || 1;
      edges.push([dx / len, dy / len]);
    }
    rect = edges.every((e, i) => {
      const next = edges[(i + 1) % 4];
      const dot = e[0] * next[0] + e[1] * next[1];
      return Math.abs(dot) < 0.01;
    });
  }
  let size: string;
  if (rect && polygon.length === 4) {
    // For rectangles, use edge lengths
    const e0 = Math.hypot(
      polygon[1][0] - polygon[0][0],
      polygon[1][1] - polygon[0][1],
    );
    const e1 = Math.hypot(
      polygon[2][0] - polygon[1][0],
      polygon[2][1] - polygon[1][1],
    );
    const one = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);
    size = `${one(e0)} × ${one(e1)} m`;
  } else {
    const one = (v: number): string => (Math.round(v * 10) / 10).toFixed(1); // toFixed alone rounds 2.65 down to 2.6
    size = `${one(Math.abs(signedArea(polygon)))} m²`;
  }
  return name ? `${name} · ${size}` : size;
}
