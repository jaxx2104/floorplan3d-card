// View-dependent cutaway (fp.cutaway on model nodes, docs/model-builder-guide.md "Cutaway"): the walls on the
// sides of the house that face the camera are lowered, so the rooms behind them show from any angle, and the
// far walls stay full height. A side is a set of nodes with the same `side` id and an outward horizontal
// direction `facing` ([x, z] in the model frame). Thick parts come as two variants: `full` (shown while the
// side faces away) and `low` (shown while it faces the camera, its cut tops modelled as caps). Thin parts
// (windows, doors, curtains) carry `clip`: the card cuts them off above that height while the side is low.
// Pure parts here (tag validation, the facing test); view/cutaway.ts applies them to the model.

export type CutawayVariant = "full" | "low";

/** A validated fp.cutaway tag. */
export interface CutawayTag {
  side: string;
  /** unit outward direction in the model's horizontal plane, [x, z] */
  facing: [number, number];
  /** a thick part: which variant of its side this node is */
  variant: CutawayVariant | null;
  /** a thin part: the height (model units, y) it is cut off at while its side is low */
  clip: number | null;
}

const SIDE_RE = /^[a-z0-9_-]{1,64}$/;

/** Validate an fp.cutaway value: the tag, or a warning (string) why it is ignored. */
export function normCutaway(raw: unknown): CutawayTag | string {
  if (!raw || typeof raw !== "object") return "cutaway: needs an object";
  const r = raw as {
    side?: unknown;
    facing?: unknown;
    variant?: unknown;
    clip?: unknown;
  };
  if (typeof r.side !== "string" || !SIDE_RE.test(r.side))
    return `cutaway: side "${String(r.side)}" is not an id (a-z 0-9 _ -)`;
  const f = r.facing;
  if (!Array.isArray(f) || f.length !== 2 || !f.every(Number.isFinite))
    return `cutaway "${r.side}": facing needs [x, z]`;
  const len = Math.hypot(f[0], f[1]);
  if (len < 1e-6) return `cutaway "${r.side}": facing is zero`;
  const facing: [number, number] = [f[0] / len, f[1] / len];
  const hasClip = r.clip !== undefined;
  const hasVariant = r.variant !== undefined;
  if (hasClip === hasVariant)
    return `cutaway "${r.side}": needs either variant (full | low) or clip (a height)`;
  if (hasVariant) {
    if (r.variant !== "full" && r.variant !== "low")
      return `cutaway "${r.side}": variant must be full or low`;
    return { side: r.side, facing, variant: r.variant, clip: null };
  }
  if (typeof r.clip !== "number" || !Number.isFinite(r.clip))
    return `cutaway "${r.side}": clip must be a number`;
  return { side: r.side, facing, variant: null, clip: r.clip };
}

// A side is lowered when its facing is within about 70 degrees of the camera's horizontal direction (seen
// from the house), and raised again only past about 78 degrees, so a side does not flicker at the edge.
export const LOW_ON = 0.34;
export const LOW_OFF = 0.2;
// Looking down steeper than this (horizontal share of the view direction below it, about 76 degrees down)
// no side faces the camera: from straight above every wall stays full height, like the plan.
export const MIN_HORIZONTAL = 0.25;

/** The camera's horizontal direction seen from the house (unit [x, z]), or null when it looks straight down.
 * offset: camera position minus its target. */
export function viewHorizontal(
  offset: readonly number[],
): [number, number] | null {
  const h = Math.hypot(offset[0], offset[2]);
  const len = Math.hypot(offset[0], offset[1], offset[2]);
  if (!(len > 0) || h / len < MIN_HORIZONTAL) return null;
  return [offset[0] / h, offset[2] / h];
}

/** Whether a side is shown low: it faces the camera (with hysteresis on the previous state). */
export function sideLow(
  facing: readonly number[],
  view: readonly number[] | null,
  wasLow: boolean,
): boolean {
  if (!view) return false;
  const d = facing[0] * view[0] + facing[1] * view[1];
  return d > (wasLow ? LOW_OFF : LOW_ON);
}
