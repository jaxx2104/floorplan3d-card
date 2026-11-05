// The pure parts of the GPU sprites (markers, labels, the mower chip; src/view/billboards.ts draws them):
// what a sprite is (a keyed picture with its layout in CSS px), the shelf packer of the atlas, and the
// screen-space pick (which sprite a pointer is on). No DOM, no three: unit tested.

/** A rectangle in CSS px. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A resolved icon: SVG path data in its viewBox (HA's ha-svg-icon: primary path, secondary at half opacity). */
export interface IconGlyph {
  paths: { d: string; opacity: number }[];
  viewBox: [number, number, number, number];
}

/** What a painter may read while laying out / painting a sprite. */
export interface SpriteEnv {
  /** atlas texels per CSS px */
  dpr: number;
  /** a model is shown: markers are smaller and see-through */
  model: boolean;
  /** zoomed out: the compact marker size */
  compact: boolean;
  /** the card's font family */
  font: string;
  /** a CSS colour (var() allowed) resolved against the card, fallback when it does not resolve */
  color(css: string | null | undefined, fallback: string): string;
  /** text width in CSS px for a canvas font string */
  measure(text: string, font: string): number;
  /** a resolved icon, null while it resolves (a placeholder is painted) */
  icon(ref: string): IconGlyph | null;
  /** a loaded image (entity picture, integration logo), null while loading or when it failed */
  image(url: string): CanvasImageSource | null;
}

/** Where things are in a sprite's cell (CSS px): its size, the anchor (the 3D point) and the tappable parts. */
export interface SpriteLayout {
  w: number;
  h: number;
  ax: number;
  ay: number;
  hits: Rect[];
}

/** A sprite: a key (same key = same picture) plus how to lay it out and paint it. */
export interface SpriteSpec {
  key: string;
  /** resources the picture depends on ("icon:<ref>", "img:<url>"): their versions join the cell key */
  deps?: string[];
  layout(env: SpriteEnv): SpriteLayout;
  /** ctx: at the cell's top-left, scaled to CSS px */
  paint(
    ctx: CanvasRenderingContext2D,
    env: SpriteEnv,
    layout: SpriteLayout,
  ): void;
}

/** The atlas cell key of a sprite: its key, the size class and the versions of what it depends on. */
export function cellKey(
  spec: Pick<SpriteSpec, "key" | "deps">,
  env: Pick<SpriteEnv, "model" | "compact">,
  version: (dep: string) => number,
): string {
  let k = spec.key + "#" + (env.model ? "m" : "p") + (env.compact ? "c" : "");
  if (spec.deps) for (const d of spec.deps) k += "|" + version(d);
  return k;
}

/** A cell of the atlas in texels. */
export interface AtlasCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Shelf packer: cells fill rows left to right; a row is as tall as its first cell (a cell up to that tall
// joins it), a new row starts below. gutter texels between cells keep linear filtering from bleeding.
export class ShelfPacker {
  width: number;
  height: number;
  gutter: number;
  _rows: { y: number; h: number; x: number }[];
  _bottom: number;

  constructor(width: number, height: number, gutter = 2) {
    this.width = width;
    this.height = height;
    this.gutter = gutter;
    this._rows = [];
    this._bottom = 0;
  }

  reset(width = this.width, height = this.height): void {
    this.width = width;
    this.height = height;
    this._rows = [];
    this._bottom = 0;
  }

  /** A free cell of w x h texels, null when the atlas is full. */
  add(w: number, h: number): AtlasCell | null {
    const g = this.gutter,
      cw = Math.ceil(w) + g,
      ch = Math.ceil(h) + g;
    if (cw > this.width || ch > this.height) return null;
    // the best row: the lowest one that is tall enough (wasted height counts)
    let best: { y: number; h: number; x: number } | null = null;
    for (const r of this._rows)
      if (r.h >= ch && r.x + cw <= this.width && (!best || r.h < best.h))
        best = r;
    if (!best) {
      if (this._bottom + ch > this.height) return null;
      best = { y: this._bottom, h: ch, x: 0 };
      this._rows.push(best);
      this._bottom += ch;
    }
    const cell = { x: best.x, y: best.y, w: Math.ceil(w), h: Math.ceil(h) };
    best.x += cw;
    return cell;
  }
}

/** Next atlas size after a full one (texels): width first, then height, up to max (null: at the limit). */
export function growAtlas(
  w: number,
  h: number,
  max: number,
): [number, number] | null {
  if (w <= h && w * 2 <= max) return [w * 2, h];
  if (h * 2 <= max) return [w, h * 2];
  if (w * 2 <= max) return [w * 2, h];
  return null;
}

/** A sprite on screen for picking: its id, anchor (client px), distance from the camera and tappable parts. */
export interface PickItem {
  id: string;
  x: number;
  y: number;
  /** view depth: smaller = nearer the camera (drawn on top) */
  depth: number;
  /** hover / press scale about the anchor */
  scale: number;
  /** tappable rects relative to the anchor (CSS px, unscaled) */
  hits: Rect[];
}

/** Ids of the sprites under a client point, the one drawn on top first (pad: extra px around each rect). */
export function pickAt(
  items: readonly PickItem[],
  px: number,
  py: number,
  pad = 0,
): string[] {
  const hit: PickItem[] = [];
  for (const it of items) {
    const lx = (px - it.x) / it.scale,
      ly = (py - it.y) / it.scale;
    if (
      it.hits.some(
        (r) =>
          lx >= r.x - pad &&
          lx <= r.x + r.w + pad &&
          ly >= r.y - pad &&
          ly <= r.y + r.h + pad,
      )
    )
      hit.push(it);
  }
  return hit.sort((a, b) => a.depth - b.depth).map((it) => it.id);
}

/** Back to front: the order the sprites are drawn in (blending), farthest first; ties keep their order. */
export function drawOrder(depths: readonly number[]): number[] {
  return depths
    .map((d, i) => [d, i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .map((x) => x[1]);
}

/** The atlas cell of a sprite as uv (0..1, v down: the canvas is uploaded without flip). */
export function cellUv(
  cell: AtlasCell,
  aw: number,
  ah: number,
): [number, number, number, number] {
  return [
    cell.x / aw,
    cell.y / ah,
    (cell.x + cell.w) / aw,
    (cell.y + cell.h) / ah,
  ];
}

// 32-bit FNV-1a of a string as base 36: short stable keys for long inputs (icon paths, URLs).
export function hashKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
