// Mower state (pure, no DOM): docked state, the dock pose and the last known position.

// ---------- docked ----------
// The lawn_mower state is docked / charging, or a "Mower status" sensor says so (not "returning to
// the dock", not "leaving the dock").
export function isDocked(
  mowerState: unknown,
  statusState: unknown = null,
): boolean {
  const s = String(mowerState || "")
    .toLowerCase()
    .trim();
  if (s === "docked" || s === "charging") return true;
  const t = String(statusState || "").toLowerCase();
  if (!t || /return|going|leav|back to|to dock|to the dock/.test(t))
    return false;
  return /\b(docked|charging|charged|in (the )?dock|on (the )?dock|at (the )?dock)\b/.test(
    t,
  );
}

// The word for the status line: 'docked' | 'charging'.
export function dockWord(
  mowerState: unknown,
  statusState: unknown = null,
): "charging" | "docked" {
  return /charg/.test(
    `${String(mowerState || "").toLowerCase()} ${String(statusState || "").toLowerCase()}`,
  )
    ? "charging"
    : "docked";
}

// ---------- mower + dock as one (docked) ----------
// Docked with both a mower and a dock object: one object for taps and the popup -> { mower, dock } ids, else null.
export interface DockGroup {
  mower: string;
  dock: string;
}
export function mowerDockGroup({
  docked,
  mowerId,
  dockId,
}: {
  docked: boolean;
  mowerId?: string | null;
  dockId?: string | null;
}): DockGroup | null {
  return docked && mowerId && dockId && mowerId !== dockId
    ? { mower: mowerId, dock: dockId }
    : null;
}
// The object a tap on id stands for (the dock -> the mower while grouped).
export const groupedTapId = (
  id: string,
  group: DockGroup | null | undefined,
): string => (group && id === group.dock ? group.mower : id);
// No tap target / dot of its own (the dock while grouped).
export const groupedHidden = (
  id: string,
  group: DockGroup | null | undefined,
): boolean => !!group && id === group.dock;
// The mower popup's dock row: 'Charging' / 'Docked' with the battery (%) when known.
export function dockRows(
  word: string,
  battery: unknown,
): { kind: "info"; label: string; value: string }[] {
  const b =
    battery === null || battery === undefined || battery === ""
      ? NaN
      : Number(battery);
  const w = word === "charging" ? "Charging" : "Docked";
  return [
    {
      kind: "info" as const,
      label: "Dock",
      value: Number.isFinite(b) ? `${w} · ${Math.round(b)} %` : w,
    },
  ];
}

// ---------- dock pose ----------
// hints.front of the dock node ('+x' | '-x' | '+z' | '-z'), default its +Z: the local axis it faces.
export function dockFrontAxis(
  hints: { front?: unknown } | null | undefined,
): number[] {
  const f = hints && hints.front;
  const axes: Record<string, number[]> = {
    "+x": [1, 0, 0],
    "-x": [-1, 0, 0],
    "+z": [0, 0, 1],
    "-z": [0, 0, -1],
  };
  return (
    (typeof f === "string" && Object.hasOwn(axes, f) ? axes[f] : undefined) || [
      0, 0, 1,
    ]
  );
}

// Card world anchor { x, y, z } and front direction (world, any length) -> plan pose
// { x, y, heading (radians ccw from east) | null }. World (x, h, -y) = plan (x, y).
export function dockPose(
  anchor: { x: number; y?: number; z: number },
  dir: { x: number; z: number } | null | undefined,
): { x: number; y: number; heading: number | null } {
  const len = dir ? Math.hypot(dir.x, dir.z) : 0;
  return {
    x: anchor.x,
    y: -anchor.z,
    heading: dir && len > 1e-6 ? Math.atan2(-dir.z, dir.x) : null,
  };
}

// ---------- last known position (per layout, in memory) ----------
/** Where the mower was last seen (plan metres) and its heading then. */
export interface LastPosition {
  x: number;
  y: number;
  heading?: number | null;
  entity?: string;
}
const LAST = new Map<unknown, LastPosition>();
export function rememberPosition(
  key: unknown,
  pos: LastPosition | null | undefined,
): void {
  if (key == null) return;
  if (pos) LAST.set(key, { ...pos });
  else LAST.delete(key);
}
export const lastPosition = (key: unknown): LastPosition | null => {
  const p = LAST.get(key);
  return p ? { ...p } : null;
};
