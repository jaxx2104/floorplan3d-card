// Mower position from a live map image: find the mower icon by its colour, then map the pixel
// onto the plan through the map overlay alignment (the overlay IS the calibration).
//
// Pixel coordinates are continuous: pixel (i, j) covers [i, i+1) x [j, j+1), so its centre is
// (i + 0.5, j + 0.5) and the image spans [0, w] x [0, h].

import type { MapColorKind, MowerOverlay, PlanPoint, RgbColor } from './types/layout.ts';
import type { AutoContext, AutoKernel, AutoResult, FrameContext, FrameResult, FrameState } from './mower-auto.ts';
import type { HeadingTemplate, TurnedPatch } from './mower-heading.ts';

export const MAX_SAMPLE_WIDTH = 1600;

/** RGBA pixels (canvas readback or a typed copy). */
export type Pixels = Uint8ClampedArray | Uint8Array;
/** A colour class for keying: one colour or a list, and the max channel difference. */
export interface ColorClass {
  colors?: RgbColor[];
  color?: RgbColor;
  tolerance?: number;
}
/** Blob centroid in pixel coordinates (continuous) and its pixel count. */
export interface MapBlob {
  px: number;
  py: number;
  count: number;
}
export interface PickedBlob extends MapBlob {
  matched: boolean;
}
export interface BlobTrack {
  px: number;
  py: number;
  count?: number | null;
  misses?: number;
}
/** The overlay alignment fields the frame maths reads. */
export type OverlayFrame = Pick<MowerOverlay, 'x' | 'y' | 'rotation' | 'width'>;
/** The mower icon to hide: centroid / count in working pixels plus its colours. */
export interface IconBlob extends ColorClass {
  px: number;
  py: number;
  count?: number | null;
}
export interface ProcessOptions {
  bg?: ColorClass | null;
  mowed?: ColorClass | null;
  nomow?: ColorClass | null;
  iconBlob?: IconBlob | null;
  dilate?: number;
  zoneMask?: Uint8Array | null;
}
/** Typed arrays a kernel reuses between calls (grown as needed). */
export interface KernelBufs {
  out?: Uint8ClampedArray;
  mowed?: Uint8Array;
  icon?: Uint8Array;
  stack?: Int32Array;
  tmp?: Uint8Array;
}
export interface ProcessResult {
  data: Uint8ClampedArray;
  mowedMask: Uint8Array;
  mowed: number;
  background: number;
  nomow: number;
  icon: number;
  zone: number;
}
export interface StripeAngle {
  angle: number;
  coherence: number;
}
/** A picture read back at sampling / working size, plus the real image size. */
export interface ImagePixels {
  data: Pixels;
  width: number;
  height: number;
  imgW: number;
  imgH: number;
}

// ---------- colour lists: up to MAX_COLORS per category ----------
// Stored as overlay.bg_colors / mowed_colors / nomow_colors and image.colors (the v1 single
// bg_color / ... / image.color is migrated into the list on load, see schema/layout.ts).
export const MAX_COLORS = 4;
const isRgb = (c: unknown): c is RgbColor => Array.isArray(c) && c.length >= 3 && c.slice(0, 3).every((v) => Number.isFinite(Number(v)));
const keyOf = (kind: MapColorKind | null | undefined): string => (kind ? `${kind}_colors` : 'colors');

// kind: 'bg' | 'mowed' | 'nomow' (on the overlay) or null (the mower icon, on mower.image)
export function colorList(obj: Record<string, unknown> | null | undefined, kind: MapColorKind | null = null): number[][] {
  const m = obj ? obj[keyOf(kind)] : null;
  const list: RgbColor[] = Array.isArray(m) ? m.filter(isRgb) : [];
  return list.slice(0, MAX_COLORS).map((c) => c.slice(0, 3).map(Number));
}

// Patch adding a colour (an equal one is not added twice; a full list replaces its last colour).
export function addColorPatch(obj: Record<string, unknown> | null | undefined, kind: MapColorKind | null, color: RgbColor): Record<string, number[][]> {
  const c = color.slice(0, 3).map(Number);
  let list = colorList(obj, kind).filter((x) => String(x) !== String(c));
  if (list.length >= MAX_COLORS) list = list.slice(0, MAX_COLORS - 1);
  return { [keyOf(kind)]: [...list, c] };
}

export function removeColorPatch(obj: Record<string, unknown> | null | undefined, kind: MapColorKind | null, index: number): Record<string, number[][]> {
  return { [keyOf(kind)]: colorList(obj, kind).filter((_, i) => i !== index) };
}

// Overlay geometry, exactly as view.setMapOverlay draws it: a plane centred on (x, y), `width`
// metres wide, height = width * imgH / imgW, top of the image north, then rotated
// counter-clockwise by `rotation` degrees (plane.rotation.y) about its centre.
function frame(imgW: number, imgH: number, o: OverlayFrame | null | undefined) {
  const w = (o && o.width) || 20;
  const r = (((o && o.rotation) || 0) * Math.PI) / 180;
  return { w, h: (w * imgH) / imgW, cos: Math.cos(r), sin: Math.sin(r), ox: (o && o.x) || 0, oy: (o && o.y) || 0 };
}

export function pixelToPlan(px: number, py: number, imgW: number, imgH: number, overlay: OverlayFrame | null | undefined): { x: number; y: number } {
  const f = frame(imgW, imgH, overlay);
  const lx = (px / imgW - 0.5) * f.w;
  const ly = (0.5 - py / imgH) * f.h;
  return { x: f.ox + lx * f.cos - ly * f.sin, y: f.oy + lx * f.sin + ly * f.cos };
}

export function planToPixel(x: number, y: number, imgW: number, imgH: number, overlay: OverlayFrame | null | undefined): { px: number; py: number } {
  const f = frame(imgW, imgH, overlay);
  const dx = x - f.ox, dy = y - f.oy;
  const lx = dx * f.cos + dy * f.sin;
  const ly = -dx * f.sin + dy * f.cos;
  return { px: (lx / f.w + 0.5) * imgW, py: (0.5 - ly / f.h) * imgH };
}

// Overlay from point pairs: [{ px, py, plan: [x, y] }] (image pixels -> where they lie on the plan).
// In the overlay frame plan = centre + (width / imgW) * e^(i*rotation) * u with
// u = (px - imgW/2) + i*(imgH/2 - py), a similarity: 2 points fit exactly, 3+ by least squares.
// -> { x, y, rotation (degrees, -180..180), width } or null (fewer than 2 distinct pixels).
export function fitOverlay(
  pairs: { px: number; py: number; plan: PlanPoint }[] | null | undefined,
  imgW: number,
  imgH: number,
): { x: number; y: number; rotation: number; width: number } | null {
  if (!Array.isArray(pairs) || pairs.length < 2 || !(imgW > 0) || !(imgH > 0)) return null;
  const n = pairs.length;
  const us = pairs.map((p) => [p.px - imgW / 2, imgH / 2 - p.py]);
  let ur = 0, ui = 0, zr = 0, zi = 0;
  for (let k = 0; k < n; k++) { ur += us[k][0]; ui += us[k][1]; zr += pairs[k].plan[0]; zi += pairs[k].plan[1]; }
  ur /= n; ui /= n; zr /= n; zi /= n;
  // a = sum((z - zm) * conj(u - um)) / sum(|u - um|^2)
  let nr = 0, ni = 0, den = 0;
  for (let k = 0; k < n; k++) {
    const dur = us[k][0] - ur, dui = us[k][1] - ui;
    const dzr = pairs[k].plan[0] - zr, dzi = pairs[k].plan[1] - zi;
    nr += dzr * dur + dzi * dui;
    ni += dzi * dur - dzr * dui;
    den += dur * dur + dui * dui;
  }
  if (den < 1e-9) return null;
  const ar = nr / den, ai = ni / den;
  const scale = Math.hypot(ar, ai);
  if (!(scale > 0)) return null;
  // centre = zm - a * um
  const x = zr - (ar * ur - ai * ui), y = zi - (ar * ui + ai * ur);
  return { x, y, rotation: (Math.atan2(ai, ar) * 180) / Math.PI, width: scale * imgW };
}

// Mask and flood-fill stack reused between detections (grown as needed): a 1600 px map would
// otherwise allocate about 9 MB per run.
let maskBuf = new Uint8Array(0), stackBuf = new Int32Array(0);

// Blobs (4-connected) of pixels within `tolerance` (max channel difference) of `color`;
// components smaller than minPixels are noise. -> [{ px, py, count }] (centroids)
export function findBlobs(rgba: Pixels, w: number, h: number, color: RgbColor | RgbColor[], tolerance?: number | null, minPixels = 4): MapBlob[] {
  const n = w * h;
  const cols = (Array.isArray(color && color[0]) ? color : [color]) as RgbColor[]; // one colour or a list (any of them)
  const tol = tolerance ?? 40;
  if (maskBuf.length < n) { maskBuf = new Uint8Array(n); stackBuf = new Int32Array(n); }
  const mask = maskBuf, stack = stackBuf;
  mask.fill(0, 0, n);
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    if (rgba[k + 3] < 128) continue;
    for (const c of cols) {
      if (Math.abs(rgba[k] - c[0]) <= tol && Math.abs(rgba[k + 1] - c[1]) <= tol && Math.abs(rgba[k + 2] - c[2]) <= tol) { mask[i] = 1; break; }
    }
  }
  const blobs: MapBlob[] = [];
  for (let s = 0; s < n; s++) {
    if (mask[s] !== 1) continue;
    let top = 0, count = 0, sx = 0, sy = 0;
    stack[top++] = s;
    mask[s] = 2;
    while (top) {
      const i = stack[--top];
      const x = i % w, y = (i - x) / w;
      count++;
      sx += x;
      sy += y;
      if (x > 0 && mask[i - 1] === 1) { mask[i - 1] = 2; stack[top++] = i - 1; }
      if (x < w - 1 && mask[i + 1] === 1) { mask[i + 1] = 2; stack[top++] = i + 1; }
      if (y > 0 && mask[i - w] === 1) { mask[i - w] = 2; stack[top++] = i - w; }
      if (y < h - 1 && mask[i + w] === 1) { mask[i + w] = 2; stack[top++] = i + w; }
    }
    if (count >= minPixels) blobs.push({ px: sx / count + 0.5, py: sy / count + 0.5, count });
  }
  return blobs;
}

// Choose the mower among the blobs. With `prev` ({ px, py, count? }, the tracked blob): the nearest
// blob whose size is within 0.5..2x prev.count (any size when count is unknown, e.g. right after the
// colour pick) -> matched: true. None qualifies (or no prev): the largest blob, matched only without prev.
// -> { px, py, count, matched } or null
export function pickBlob(blobs: MapBlob[] | null | undefined, prev: BlobTrack | null = null): PickedBlob | null {
  if (!blobs || !blobs.length) return null;
  let largest = blobs[0];
  for (const b of blobs) if (b.count > largest.count) largest = b;
  if (!prev) return { ...largest, matched: true };
  const c = Number(prev.count) || 0;
  const ok = c > 0 ? blobs.filter((b) => b.count >= c * 0.5 && b.count <= c * 2) : blobs;
  if (!ok.length) return { ...largest, matched: false };
  const d = (b: MapBlob) => Math.hypot(b.px - prev.px, b.py - prev.py);
  return { ...ok.reduce((a, b) => (d(b) < d(a) ? b : a)), matched: true };
}

// The mower blob: see findBlobs / pickBlob. -> { px, py, count, matched } or null
export function findBlob(
  rgba: Pixels, w: number, h: number, color: RgbColor | RgbColor[], tolerance?: number | null,
  { minPixels = 4, prev = null }: { minPixels?: number; prev?: BlobTrack | null } = {},
): PickedBlob | null {
  return pickBlob(findBlobs(rgba, w, h, color, tolerance, minPixels), prev);
}

// Unmatched frames (the icon hidden, only other blobs of its colour) before the largest blob is
// accepted as the new track.
export const TRACK_MAX_MISSES = 3;

// Next tracked blob from the last one and this frame's pick. -> { track, found }:
// found = the position moved to this frame's blob. An unmatched pick keeps the old track (and the
// last known position) until TRACK_MAX_MISSES frames in a row, so a brief miss never hands the
// track to a look-alike.
/** A track after stepTrack: misses counted. found: the track moved to this frame's blob. */
export type TrackStep = { track: BlobTrack & { misses: number }; found: true } | { track: (BlobTrack & { misses: number }) | null; found: false };
export function stepTrack(track: BlobTrack | null | undefined, blob: PickedBlob | null | undefined): TrackStep {
  if (!blob) return { track: track ? { ...track, misses: (track.misses || 0) + 1 } : null, found: false };
  if (!track || blob.matched || (track.misses || 0) + 1 >= TRACK_MAX_MISSES) {
    return { track: { px: blob.px, py: blob.py, count: blob.count, misses: 0 }, found: true };
  }
  return { track: { ...track, misses: (track.misses || 0) + 1 }, found: false };
}

// Smallest move (m) that turns the mower object: image positions jitter by a pixel or so.
export function headingMinStep(source: string | null | undefined, overlayWidth: unknown, sampleWidth: number | null | undefined): number {
  if (source !== 'image') return 0.05;
  const sw = sampleWidth ?? 0;
  const mpp = sw > 0 ? (Number(overlayWidth) || 20) / sw : 0;
  return Math.max(0.25, 3 * mpp);
}

// Per-channel median of the (2r+1)^2 neighbourhood around pixel (px, py) (integer pixel indices,
// default 5x5), clamped to the image.
export function medianColor(rgba: Pixels, w: number, h: number, px: number, py: number, r = 2): number[] {
  const ch: number[][] = [[], [], []];
  for (let y = py - r; y <= py + r; y++) {
    if (y < 0 || y >= h) continue;
    for (let x = px - r; x <= px + r; x++) {
      if (x < 0 || x >= w) continue;
      const k = (y * w + x) * 4;
      ch[0].push(rgba[k]);
      ch[1].push(rgba[k + 1]);
      ch[2].push(rgba[k + 2]);
    }
  }
  return ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1] ?? 0);
}

// Scale used to sample an image of this width (large images are read on a smaller canvas).
export function imageScale(width: number): number {
  return width > MAX_SAMPLE_WIDTH ? MAX_SAMPLE_WIDTH / width : 1;
}

// ---------- map image processing (one pass per refresh) ----------
// Working size of the processed map: masks, statistics and the visible texture (<= 1024 px wide).
export const MAP_WORK_WIDTH = 1024;
const MAP_WORK_HEIGHT = 2048;

export function mapWorkSize(width: number, height: number): { width: number; height: number } {
  const s = Math.min(1, MAP_WORK_WIDTH / width, MAP_WORK_HEIGHT / height);
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

// The pixel kernel: processMap, zoneMask, stripeAngle and their helpers in one self-contained
// function (no references outside it), so a worker runs the very same code from its source text.
// Each kernel instance reuses its own stripe grid.
export function mapKernel() {
  // Look of the processed map (before the overlay opacity): mowed stripes = their own colour
  // lightened halfway to white at ~25 % alpha; no-mow = dark, hatched (diagonal lines every 8 px).
  const MOWED_ALPHA = 64, NOMOW_RGB = 24, NOMOW_LINE_ALPHA = 200, NOMOW_GAP_ALPHA = 90;
  let grid = new Float32Array(0);

  function grow<K extends keyof KernelBufs>(bufs: KernelBufs, key: K, Type: new (n: number) => NonNullable<KernelBufs[K]>, n: number): NonNullable<KernelBufs[K]> {
    let b = bufs[key];
    if (!b || b.length < n) bufs[key] = b = new Type(n);
    return b as NonNullable<KernelBufs[K]>; // just set when missing
  }

  // Colour distance (max channel difference) to the nearest of the colours when within tol, else -1.
  function within(rgba: Pixels, k: number, cols: RgbColor[], tol: number): number {
    let best = -1;
    for (const c of cols) {
      const d = Math.max(Math.abs(rgba[k] - c[0]), Math.abs(rgba[k + 1] - c[1]), Math.abs(rgba[k + 2] - c[2]));
      if (d <= tol && (best < 0 || d < best)) best = d;
    }
    return best;
  }

  // { colors: [[r, g, b], ...] } or the single { color: [r, g, b] } -> the list
  function colorsOf(c: ColorClass | null | undefined): RgbColor[] {
    if (!c) return [];
    if (Array.isArray(c.colors)) return c.colors.filter((x) => Array.isArray(x));
    return Array.isArray(c.color) ? [c.color] : [];
  }

  // Pixels of the mower icon: pixels of its colour near the blob centroid, their 4-connected
  // neighbours of the same colour, then dilated by `dilate` px (the icon's outline / anti-aliasing).
  function iconMask(rgba: Pixels, w: number, h: number, blob: IconBlob, dilate: number, bufs: KernelBufs): Uint8Array | null {
    const n = w * h;
    const mask = grow(bufs, 'icon', Uint8Array, n).subarray(0, n);
    const stack = grow(bufs, 'stack', Int32Array, n);
    mask.fill(0);
    const tol = blob.tolerance ?? 40;
    const cols = colorsOf(blob);
    const ok = (i: number) => rgba[i * 4 + 3] >= 128 && within(rgba, i * 4, cols, tol) >= 0;
    const r = Number(blob.count) > 0 ? Math.sqrt(Number(blob.count) / Math.PI) * 1.5 + 2 : 8;
    const cx = blob.px, cy = blob.py;
    let top = 0, found = 0;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
        const i = y * w + x;
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r && ok(i)) { mask[i] = 1; stack[top++] = i; }
      }
    }
    while (top) {
      const i = stack[--top];
      const x = i % w, y = (i - x) / w;
      found++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && !mask[i - 1] && ok(i - 1)) { mask[i - 1] = 1; stack[top++] = i - 1; }
      if (x < w - 1 && !mask[i + 1] && ok(i + 1)) { mask[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && !mask[i - w] && ok(i - w)) { mask[i - w] = 1; stack[top++] = i - w; }
      if (y < h - 1 && !mask[i + w] && ok(i + w)) { mask[i + w] = 1; stack[top++] = i + w; }
    }
    if (!found) return null;
    const d = Math.max(0, Math.round(dilate || 0));
    if (d) {
      // square dilation, separable: rows into tmp, then columns back into the mask (bounding box only)
      const tmp = grow(bufs, 'tmp', Uint8Array, n);
      const bx0 = Math.max(0, x0 - d), bx1 = Math.min(w - 1, x1 + d), by0 = Math.max(0, y0 - d), by1 = Math.min(h - 1, y1 + d);
      for (let y = by0; y <= by1; y++) {
        for (let x = bx0; x <= bx1; x++) {
          let v = 0;
          for (let t = Math.max(0, x - d); t <= Math.min(w - 1, x + d) && !v; t++) v = mask[y * w + t];
          tmp[y * w + x] = v;
        }
      }
      for (let y = by0; y <= by1; y++) {
        for (let x = bx0; x <= bx1; x++) {
          let v = 0;
          for (let t = Math.max(by0, y - d); t <= Math.min(by1, y + d) && !v; t++) v = tmp[t * w + x];
          mask[y * w + x] = v;
        }
      }
    }
    return mask;
  }

  // The map picture as it is drawn on the lawn. rgba: w x h pixels; opts:
  //   bg / mowed / nomow: { colors: [[r, g, b], ...] (or color), tolerance } (each optional; a pixel matching
  //     any colour of a class belongs to it, matching several classes goes to the nearest),
  //   iconBlob: { px, py, count, colors (or color), tolerance } (working pixels) to hide,
  //   dilate: px around the icon, zoneMask: Uint8Array (1 = inside) or null.
  // Background -> transparent, mowed -> light translucent, no-mow -> dark hatched, icon and outside the
  // zone -> transparent, the rest unchanged. No options: a plain copy (no keying).
  // bufs: typed arrays reused between calls (grown as needed); bufs.out may be the output ImageData's
  // data (written in place).
  // -> { data (w*h*4), mowedMask (w*h, 1 = mowed), mowed, background, nomow, icon, zone (pixel counts;
  //    icon pixels belong to no colour class) }
  function processMap(rgba: Pixels, w: number, h: number, opts: ProcessOptions = {}, bufs: KernelBufs = {}): ProcessResult {
    const n = w * h;
    const out = grow(bufs, 'out', Uint8ClampedArray, n * 4).subarray(0, n * 4);
    const mowedMask = grow(bufs, 'mowed', Uint8Array, n).subarray(0, n);
    mowedMask.fill(0);
    const cls: { kind: MapColorKind; colors: RgbColor[]; tol: number }[] = [];
    for (const [kind, c] of [['bg', opts.bg], ['mowed', opts.mowed], ['nomow', opts.nomow]] as const) {
      const cols = colorsOf(c);
      if (c && cols.length) cls.push({ kind, colors: cols, tol: c.tolerance ?? 30 });
    }
    const icon = opts.iconBlob && colorsOf(opts.iconBlob).length ? iconMask(rgba, w, h, opts.iconBlob, opts.dilate ?? 3, bufs) : null;
    const zone = opts.zoneMask || null;
    let mowed = 0, background = 0, nomow = 0, iconCount = 0, zoneCount = 0;
    for (let i = 0, k = 0, y = 0, x = 0; i < n; i++, k += 4) {
      if (zone && !zone[i]) {
        out[k] = out[k + 1] = out[k + 2] = out[k + 3] = 0;
      } else if (icon && icon[i]) {
        if (zone) zoneCount++;
        iconCount++;
        out[k] = out[k + 1] = out[k + 2] = out[k + 3] = 0;
      } else {
        if (zone) zoneCount++;
        let kind: MapColorKind | null = null, best = 256;
        if (rgba[k + 3] >= 128) {
          for (const c of cls) {
            const d = within(rgba, k, c.colors, c.tol);
            if (d >= 0 && d < best) { best = d; kind = c.kind; }
          }
        }
        if (kind === 'bg') {
          background++;
          out[k] = out[k + 1] = out[k + 2] = out[k + 3] = 0;
        } else if (kind === 'mowed') {
          mowed++;
          mowedMask[i] = 1;
          out[k] = (rgba[k] + 255) >> 1;
          out[k + 1] = (rgba[k + 1] + 255) >> 1;
          out[k + 2] = (rgba[k + 2] + 255) >> 1;
          out[k + 3] = Math.min(rgba[k + 3], MOWED_ALPHA);
        } else if (kind === 'nomow') {
          nomow++;
          out[k] = out[k + 1] = out[k + 2] = NOMOW_RGB;
          out[k + 3] = (x + y) % 8 < 3 ? NOMOW_LINE_ALPHA : NOMOW_GAP_ALPHA;
        } else {
          out[k] = rgba[k];
          out[k + 1] = rgba[k + 1];
          out[k + 2] = rgba[k + 2];
          out[k + 3] = rgba[k + 3];
        }
      }
      if (++x === w) { x = 0; y++; }
    }
    return { data: out, mowedMask, mowed, background, nomow, icon: iconCount, zone: zoneCount };
  }

  // Polygon [[px, py], ...] (pixel coordinates, continuous) -> mask of the pixels whose centres lie
  // inside (even-odd). out: optional reused Uint8Array. -> { mask, count }
  function zoneMask(points: number[][], w: number, h: number, out: Uint8Array | null = null): { mask: Uint8Array; count: number } {
    const n = w * h;
    const mask = out && out.length >= n ? out.subarray(0, n) : new Uint8Array(n);
    mask.fill(0);
    let count = 0;
    const xs: number[] = [];
    const m = points.length;
    for (let y = 0; y < h; y++) {
      const yc = y + 0.5;
      xs.length = 0;
      for (let a = 0, b = m - 1; a < m; b = a++) {
        const [xa, ya] = points[a], [xb, yb] = points[b];
        if ((ya <= yc) !== (yb <= yc)) xs.push(xa + ((yc - ya) / (yb - ya)) * (xb - xa));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil(xs[k] - 0.5)), to = Math.min(w, Math.ceil(xs[k + 1] - 0.5));
        for (let x = from; x < to; x++) { mask[y * w + x] = 1; count++; }
      }
    }
    return { mask, count };
  }

  // Dominant direction of the mowed stripes: structure tensor of Sobel gradients on the mask
  // downscaled to <= 256 px (block sums, a reused grid). Gradients run across the stripes, so the
  // stripes lie 90° from the dominant gradient. -> { angle (degrees 0..180, counter-clockwise from
  // image right, image up), coherence (0..1) } or null (no mowed pixels, or no clear direction).
  function stripeAngle(mask: Uint8Array, w: number, h: number, minCoherence = 0.3): StripeAngle | null {
    const f = Math.max(1, Math.ceil(Math.max(w, h) / 256));
    const gw = Math.floor(w / f), gh = Math.floor(h / f);
    if (gw < 3 || gh < 3) return null;
    if (grid.length < gw * gh) grid = new Float32Array(gw * gh);
    const g = grid;
    g.fill(0, 0, gw * gh);
    for (let y = 0; y < gh * f; y++) {
      const row = y * w, gy = ((y / f) | 0) * gw;
      for (let x = 0; x < gw * f; x++) if (mask[row + x]) g[gy + ((x / f) | 0)] += 1;
    }
    let sxx = 0, syy = 0, sxy = 0;
    for (let y = 1; y < gh - 1; y++) {
      for (let x = 1; x < gw - 1; x++) {
        const i = y * gw + x;
        const tl = g[i - gw - 1], tc = g[i - gw], tr = g[i - gw + 1];
        const ml = g[i - 1], mr = g[i + 1];
        const bl = g[i + gw - 1], bc = g[i + gw], br = g[i + gw + 1];
        const gx = tr + 2 * mr + br - tl - 2 * ml - bl;
        const gy = bl + 2 * bc + br - tl - 2 * tc - tr;
        sxx += gx * gx;
        syy += gy * gy;
        sxy += gx * gy;
      }
    }
    const energy = sxx + syy;
    if (!(energy > 0)) return null;
    const coherence = Math.hypot(sxx - syy, 2 * sxy) / energy;
    if (coherence < minCoherence) return null;
    const phi = 0.5 * Math.atan2(2 * sxy, sxx - syy); // gradient direction, image y down
    const deg = (-(phi + Math.PI / 2) * 180) / Math.PI; // stripes, image y up
    return { angle: ((deg % 180) + 180) % 180, coherence };
  }

  return { processMap, zoneMask, stripeAngle };
}

/** The map kernel's functions (what mapKernel() returns). */
export type MapKernel = ReturnType<typeof mapKernel>;

const KERNEL = mapKernel();
/** See mapKernel. */
export const processMap = KERNEL.processMap;
export const zoneMask = KERNEL.zoneMask;
export const stripeAngle = KERNEL.stripeAngle;

// Plan polygon -> working pixel polygon of an imgW x imgH map drawn at w x h through the overlay.
export function zonePixels(polygon: number[][], overlay: OverlayFrame | null | undefined, imgW: number, imgH: number, w: number, h: number): PlanPoint[] {
  const sx = w / imgW, sy = h / imgH;
  return polygon.map(([x, y]): PlanPoint => {
    const q = planToPixel(x, y, imgW, imgH, overlay);
    return [q.px * sx, q.py * sy];
  });
}

const AXES = ['N–S', 'NE–SW', 'E–W', 'SE–NW'];

// Stripe angle on the image (stripeAngle) -> compass axis against true north: through the overlay
// rotation onto the plan (degrees counter-clockwise), then the model's north and alignment rotation
// exactly as the sky uses them (sunVector). -> { bearing: 0..179 (clockwise from north), label }
export function stripeBearing(angle: number, rotation: unknown = 0, north: unknown = 0, alignRotation: unknown = 0): { bearing: number; label: string } {
  const plan = angle + (Number(rotation) || 0);
  const b = ((Math.round(90 - plan - (Number(north) || 0) + (Number(alignRotation) || 0)) % 180) + 180) % 180;
  return { bearing: b, label: AXES[Math.round(b / 45) % 4] };
}

// Share of the lawn mowed: mowed / (zone pixels - no-mow - icon) when clipped to a zone, else
// mowed / (mowed + background). -> 0..1 or null (nothing to compare with)
export function mowedShare({ mowed, background, zone, zoned, nomow = 0, icon = 0 }: { mowed: number; background: number; zone: number; zoned?: boolean; nomow?: number; icon?: number }): number | null {
  const total = zoned ? zone - (nomow || 0) - (icon || 0) : mowed + background;
  return total > 0 ? Math.min(1, mowed / total) : null;
}

function segDist(p: number[], a: number[], b: number[]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function inside([x, y]: number[], poly: number[][]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const edgeDist = (p: number[], poly: number[][]): number => {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, segDist(p, poly[j], poly[i]));
  return d;
};

// A point well inside a polygon (for a label or an arrow): the centroid when it lies inside and
// nearly as far from the edges as the best point, else the grid point (24 x 24) farthest from the
// edges (a pole-of-inaccessibility estimate). -> [x, y]
export function insidePoint(poly: number[][]): number[] {
  let a = 0, cx = 0, cy = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f;
    cx += (poly[j][0] + poly[i][0]) * f;
    cy += (poly[j][1] + poly[i][1]) * f;
    x0 = Math.min(x0, poly[i][0]); x1 = Math.max(x1, poly[i][0]);
    y0 = Math.min(y0, poly[i][1]); y1 = Math.max(y1, poly[i][1]);
  }
  const c = Math.abs(a) > 1e-9 ? [cx / (3 * a), cy / (3 * a)] : [(x0 + x1) / 2, (y0 + y1) / 2];
  let best: number[] | null = null, bd = -1;
  const N = 24;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const p = [x0 + ((i + 0.5) * (x1 - x0)) / N, y0 + ((j + 0.5) * (y1 - y0)) / N];
      if (!inside(p, poly)) continue;
      const d = edgeDist(p, poly);
      if (d > bd) { bd = d; best = p; }
    }
  }
  if (inside(c, poly) && edgeDist(c, poly) >= 0.8 * bd) return c;
  return best || c;
}

// ---------- browser: load an image URL into pixels (one reused canvas) ----------
let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;

// The 2d context of a sampling canvas: never null (no other context kind is taken on these canvases),
// and <canvas> / OffscreenCanvas share the 2d API used here.
const ctx2d = (c: HTMLCanvasElement | OffscreenCanvas) =>
  (c as OffscreenCanvas).getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;

type Drawable = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;

async function decode(blob: Blob): Promise<{ src: Drawable; width: number; height: number; done: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob); // decoded off the main thread
      return { src: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close() };
    } catch { /* e.g. SVG: fall back to an <img> */ }
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return { src: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

export const FETCH_TIMEOUT_MS = 8000;

// Pixels of a decoded image (ImageBitmap / <img> / canvas) on the reused, downscaled canvas.
// -> { data, width, height, imgW, imgH }
export function imagePixels(src: CanvasImageSource, width: number, height: number): ImagePixels {
  if (!width || !height) throw new Error('empty image');
  const s = imageScale(width);
  const cw = Math.max(1, Math.round(width * s)), chh = Math.max(1, Math.round(height * s));
  if (!canvas) canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(cw, chh) : document.createElement('canvas');
  if (canvas.width !== cw) canvas.width = cw;
  if (canvas.height !== chh) canvas.height = chh;
  const ctx = ctx2d(canvas);
  ctx.clearRect(0, 0, cw, chh);
  ctx.drawImage(src, 0, 0, cw, chh);
  const data = ctx.getImageData(0, 0, cw, chh).data;
  return { data, width: cw, height: chh, imgW: width, imgH: height };
}

// { data, width, height } of the sampled canvas plus the real image size (imgW, imgH).
// Throws when the image cannot be fetched (8 s timeout) or read (e.g. another origin).
export async function readImagePixels(url: string): Promise<ImagePixels> {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
  let blob: Blob;
  try {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } finally {
    clearTimeout(timer ?? undefined);
  }
  const img = await decode(blob);
  try {
    return imagePixels(img.src, img.width, img.height);
  } finally {
    img.done();
  }
}

// ---------- browser: the processed map (one readback, reused canvases and buffers) ----------
function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: w, height: h });
  return new OffscreenCanvas(w, h);
}

// Let the page breathe between the readback and the pixel loop (main-thread path only).
const yieldOnce = () => new Promise<void>((r) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => r(), { timeout: 50 });
  else setTimeout(r, 0);
});

// Auto mode (mower-auto.js registers itself: no import cycle): { source (worker code defining A),
// run (the same autoProcess on the main thread) }.
export interface AutoHooks {
  source: string;
  run: AutoKernel['autoProcess'];
  frame: AutoKernel['framePass'];
  frameState: AutoKernel['frameState'];
  bestShift: AutoKernel['bestShift'];
  downGray: AutoKernel['downGray'];
}
let AUTO: AutoHooks | null = null;
export function registerAuto(a: AutoHooks): void { AUTO = a; }

/** A picture for auto mode: key + pixels (process / auto) or a decoded bitmap (frame). */
export interface StaticPixels {
  key: unknown;
  data: Pixels;
}
export interface StaticBitmap {
  key: unknown;
  bitmap: ImageBitmap;
}
export interface TemplateRef {
  key: unknown;
  t: HeadingTemplate | null;
}
/** Options of MapProcessor.process (image pixels; the zone is a plan polygon). */
export interface MapProcessOptions {
  bg?: ColorClass | null;
  mowed?: ColorClass | null;
  nomow?: ColorClass | null;
  iconBlob?: IconBlob | null;
  dilate?: number;
  zone?: number[][] | null;
  overlay?: OverlayFrame | null;
}
export interface MapProcessResult {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  width: number;
  height: number;
  zoned: boolean;
  mowed: number;
  background: number;
  nomow: number;
  icon: number;
  zone: number;
  angle: number | null;
}
type Counts = Omit<MapProcessResult, 'canvas' | 'width' | 'height' | 'zoned'>;
/** A reply of the map worker (our own worker source, so its shape is known). */
type WorkerReply = { id?: number; out?: ArrayBuffer; error?: string; disposed?: boolean } & Record<string, unknown>;
type ProcError = Error & { disposed?: boolean; restart?: boolean };
const flagOf = (e: unknown, k: 'disposed' | 'restart'): boolean => !!e && typeof e === 'object' && !!(e as ProcError)[k];

// Worker running the kernel: one message per picture, the pixel and output buffers transferred both ways.
function workerSource(): string {
  return `const K = (${mapKernel.toString()})();
${AUTO ? AUTO.source : 'const A = null;'}
const bufs = {};
let zone = { key: null, mask: null };
let stat = { key: null, data: null }, tpl = { key: null, t: null, cache: new Map() };
function auto(m) {
  if (m.stat) stat = { key: m.statKey, data: new Uint8ClampedArray(m.stat) };
  if (m.tplKey !== tpl.key) tpl = { key: m.tplKey, t: m.template, cache: new Map() };
  if (stat.key !== m.statKey) throw new Error('static map missing');
  const r = A.autoProcess(stat.data, new Uint8ClampedArray(m.live), m.w, m.h, Object.assign({}, m.ctx, { template: tpl.t, cache: tpl.cache }));
  const out = r.data.buffer;
  delete r.data;
  self.postMessage(Object.assign({ id: m.id, out, live: m.live }, r), [out, m.live]);
}
// live map refreshes: the decoded pictures (ImageBitmap) drawn and read here, never on the page
let fs = { key: null, data: null, shift: null, w: 0, h: 0 }, fstate = A ? A.frameState() : null, fcv = null;
function pixelsOf(bmp, w, h) {
  if (!fcv) fcv = new OffscreenCanvas(w, h);
  if (fcv.width !== w) fcv.width = w;
  if (fcv.height !== h) fcv.height = h;
  const g = fcv.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, w, h);
  g.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  return g.getImageData(0, 0, w, h).data;
}
function frame(m) {
  const t0 = performance.now();
  if (m.stat) fs = { key: m.statKey, data: pixelsOf(m.stat, m.w, m.h), shift: null, w: m.w, h: m.h };
  if (m.tplKey !== tpl.key) tpl = { key: m.tplKey, t: m.template, cache: new Map() };
  if (fs.key !== m.statKey || fs.w !== m.w || fs.h !== m.h) { if (m.live && m.live.close) m.live.close(); throw new Error('static map missing'); }
  const live = pixelsOf(m.live, m.w, m.h);
  if (!fs.shift) { // small offset between the two pictures, once per static picture / size
    const f = Math.max(1, Math.round(m.w / 256));
    const a = A.downGray(fs.data, m.w, m.h, f), b = A.downGray(live, m.w, m.h, f);
    const sh = A.bestShift(a.g, b.g, a.w, a.h, 4);
    fs.shift = { dx: sh.dx * f, dy: sh.dy * f };
  }
  const r = A.framePass(fs.data, live, m.w, m.h, Object.assign({}, m.ctx, { shift: fs.shift, statKey: fs.key, template: tpl.t, cache: tpl.cache }), fstate);
  const tr = r.patches ? [r.patches.data.buffer] : [];
  self.postMessage(Object.assign({ id: m.id, ms: performance.now() - t0 }, r), tr);
}
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'frame') {
    try { frame(m); } catch (err) { self.postMessage({ id: m.id, error: String(err) }); }
    return;
  }
  if (m.type === 'auto') {
    try { auto(m); } catch (err) { self.postMessage({ id: m.id, error: String(err), live: m.live }, [m.live]); }
    return;
  }
  try {
    bufs.out = new Uint8ClampedArray(m.out);
    let zm = null;
    if (m.zonePts) {
      if (m.zoneKey !== zone.key) zone = { key: m.zoneKey, mask: K.zoneMask(m.zonePts, m.w, m.h, zone.mask).mask };
      zm = zone.mask;
    }
    const r = K.processMap(new Uint8ClampedArray(m.rgba), m.w, m.h, Object.assign({}, m.opts, { zoneMask: zm }), bufs);
    const s = m.stripes ? K.stripeAngle(r.mowedMask, m.w, m.h) : null;
    self.postMessage({ id: m.id, out: m.out, mowed: r.mowed, background: r.background, nomow: r.nomow, icon: r.icon, zone: r.zone, angle: s ? s.angle : null }, [m.out]);
  } catch (err) {
    self.postMessage({ id: m.id, out: m.out, error: String(err) }, [m.out]);
  }
};`;
}

const WORKER_TIMEOUT_MS = 5000;

export class MapProcessor {
  // worker: run the pixel loop in a worker when OffscreenCanvas and Worker exist (falls back to the
  // main thread for good on any worker failure).
  bufs: KernelBufs;
  work: HTMLCanvasElement | OffscreenCanvas | null;
  canvas: HTMLCanvasElement | OffscreenCanvas | null;
  lastMainMs?: number;
  _out: ImageData | null;
  _zone: { key: string | null; mask: Uint8Array | null };
  _wantWorker: boolean;
  _worker: Worker | null;
  _workerDead: boolean;
  _seq: number;
  _waiting: Map<number, (m: WorkerReply) => void>;
  _queue: Promise<unknown>;
  _sentFrameStat?: unknown;
  _sentStat?: unknown;
  _sentTpl?: unknown;
  _autoCache?: { key: unknown; cache: Map<string, TurnedPatch> };
  _fstat?: { key: unknown; data: Pixels; shift: { dx: number; dy: number } | null; w: number; h: number };
  _fstate?: FrameState;

  constructor({ worker = true }: { worker?: boolean } = {}) {
    this.bufs = {};
    this.work = null; // the decoded picture at working size (read back once per refresh)
    this.canvas = null; // the processed picture (texture source)
    this._out = null; // ImageData of this.canvas, written in place (its buffer travels to the worker and back)
    this._zone = { key: null, mask: null }; // main-thread zone mask cache
    this._wantWorker = worker;
    this._worker = null;
    this._workerDead = false;
    this._seq = 0;
    this._waiting = new Map();
    this._queue = Promise.resolve();
  }

  // The one readback per refresh: the picture at working size. -> { data, width, height, imgW, imgH }
  read(src: CanvasImageSource, imgW: number, imgH: number): ImagePixels {
    const { width: w, height: h } = mapWorkSize(imgW, imgH);
    if (!this.work) this.work = makeCanvas(w, h);
    if (this.work.width !== w) this.work.width = w;
    if (this.work.height !== h) this.work.height = h;
    const ctx = ctx2d(this.work);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h, imgW, imgH };
  }

  // Process pixels from read() (consumed: their buffer may move to the worker). opts: { bg, mowed,
  // nomow ({ color, tolerance }), iconBlob ({ px, py, count } in image pixels + color, tolerance),
  // dilate, zone (plan polygon), overlay (alignment, for the zone) }. One picture at a time.
  // -> { canvas, width, height, mowed, background, nomow, icon, zone, zoned, angle }
  process(px: ImagePixels, opts: MapProcessOptions = {}): Promise<MapProcessResult> {
    const run = this._queue.then(() => this._process(px, opts));
    this._queue = run.catch(() => {});
    return run;
  }

  async _process(px: ImagePixels, opts: MapProcessOptions): Promise<MapProcessResult> {
    const { width: w, height: h, imgW, imgH } = px;
    let zonePts: PlanPoint[] | null = null, zoneKey: string | null = null;
    if (opts.zone && opts.overlay) {
      const o = opts.overlay;
      zoneKey = [JSON.stringify(opts.zone), o.x, o.y, o.rotation, o.width, w, h, imgW, imgH].join('|');
      zonePts = zonePixels(opts.zone, o, imgW, imgH, w, h);
    }
    const sx = w / imgW, b = opts.iconBlob;
    const kopts: ProcessOptions = {
      bg: opts.bg || null, mowed: opts.mowed || null, nomow: opts.nomow || null, dilate: opts.dilate ?? 3,
      iconBlob: b ? { px: b.px * sx, py: b.py * sx, count: b.count == null ? null : b.count * sx * sx, color: b.color, colors: b.colors, tolerance: b.tolerance } : null,
    };
    this._ensureOut(w, h);
    let r: Counts | null = null;
    const wk = this._getWorker();
    if (wk) {
      try {
        r = await this._viaWorker(wk, px.data, w, h, kopts, zonePts, zoneKey, !!opts.mowed);
      } catch (e) {
        if (flagOf(e, 'disposed')) { this._ensureOut(w, h); throw e; } // disposed mid-run: skip, keep the worker usable
        console.warn('floorplan3d: map worker failed, processing on the main thread', e);
        this._killWorker();
        this._ensureOut(w, h);
        if (!px.data.byteLength) throw e; // the pixels went to the worker: this picture is skipped
        r = null;
      }
    }
    if (!r) {
      await yieldOnce();
      let zm: Uint8Array | null = null;
      if (zonePts) {
        if (zoneKey !== this._zone.key) this._zone = { key: zoneKey, mask: zoneMask(zonePts, w, h, this._zone.mask).mask };
        zm = this._zone.mask;
      }
      this.bufs.out = this._out!.data; // _ensureOut above
      const res = processMap(px.data, w, h, { ...kopts, zoneMask: zm }, this.bufs);
      const s = opts.mowed ? stripeAngle(res.mowedMask, w, h) : null;
      r = { mowed: res.mowed, background: res.background, nomow: res.nomow, icon: res.icon, zone: res.zone, angle: s ? s.angle : null };
    }
    if (!this.canvas) this.canvas = makeCanvas(w, h);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    ctx2d(this.canvas).putImageData(this._out!, 0, 0); // set by _ensureOut / the worker reply // CPU-side: uploaded, not drawn
    return { canvas: this.canvas, width: w, height: h, zoned: !!zonePts, ...r };
  }

  _ensureOut(w: number, h: number): void {
    const o = this._out;
    if (!o || o.width !== w || o.height !== h || o.data.byteLength === 0) this._out = new ImageData(w, h);
  }

  _getWorker(): Worker | null {
    if (this._worker || this._workerDead || !this._wantWorker) return this._worker;
    if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function' || typeof Blob !== 'function' || typeof URL === 'undefined') {
      this._workerDead = true;
      return null;
    }
    try {
      const url = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
      this._worker = new Worker(url);
      URL.revokeObjectURL(url);
      this._worker.onmessage = (e: MessageEvent<WorkerReply>) => {
        const w = this._waiting.get(e.data.id as number);
        if (w) w(e.data);
      };
      this._worker.onerror = (e: ErrorEvent) => {
        e.preventDefault?.();
        for (const w of this._waiting.values()) w({ error: 'worker error' });
      };
    } catch (e) {
      console.warn('floorplan3d: no map worker', e);
      this._workerDead = true;
      this._worker = null;
    }
    return this._worker;
  }

  _killWorker(): void {
    if (this._worker) this._worker.terminate();
    this._worker = null;
    this._workerDead = true;
    this._sentFrameStat = null;
    this._waiting.clear();
  }

  _viaWorker(
    wk: Worker, rgba: Pixels, w: number, h: number, opts: ProcessOptions,
    zonePts: PlanPoint[] | null, zoneKey: string | null, stripes: boolean,
  ): Promise<Counts> {
    const id = ++this._seq;
    const out = this._out!.data.buffer; // _ensureOut before every run
    // the readback may share its buffer with nothing else: transfer it
    const pix = rgba.byteOffset === 0 && rgba.byteLength === rgba.buffer.byteLength ? rgba.buffer : rgba.slice().buffer;
    return new Promise<Counts>((resolve, reject) => {
      const timer = setTimeout(() => { this._waiting.delete(id); reject(new Error('timeout')); }, WORKER_TIMEOUT_MS);
      this._waiting.set(id, (m) => {
        clearTimeout(timer);
        this._waiting.delete(id);
        if (m.out) this._out = new ImageData(new Uint8ClampedArray(m.out), w, h);
        if (m.disposed) reject(Object.assign(new Error('disposed'), { disposed: true }));
        else if (m.error) reject(new Error(m.error));
        else resolve({ mowed: m.mowed, background: m.background, nomow: m.nomow, icon: m.icon, zone: m.zone, angle: m.angle } as Counts);
      });
      wk.postMessage({ id, rgba: pix, out, w, h, opts, zonePts, zoneKey, stripes }, [pix, out]);
    });
  }

  // Auto mode pass (mower-auto.js autoProcess) in the worker, else on the main thread after one
  // yield. px: read() pixels (consumed); stat: { key, data } (sent to the worker once per key);
  // template: { key, t }; ctx: autoProcess context (no cache / template). -> Promise of its result.
  auto(px: ImagePixels, stat: StaticPixels, template: TemplateRef | null, ctx: AutoContext): Promise<AutoResult> {
    const run = this._queue.then(() => this._auto(px, stat, template, ctx));
    this._queue = run.catch(() => {});
    return run;
  }

  async _auto(px: ImagePixels, stat: StaticPixels, template: TemplateRef | null, ctx: AutoContext): Promise<AutoResult> {
    const { width: w, height: h } = px;
    const wk = AUTO ? this._getWorker() : null;
    if (wk) {
      try {
        this.lastMainMs = 0;
        return await this._autoViaWorker(wk, px.data, w, h, stat, template, ctx);
      } catch (e) {
        if (flagOf(e, 'disposed')) throw e;
        console.warn('floorplan3d: map worker failed, processing on the main thread', e);
        this._killWorker();
        if (!px.data.byteLength) throw e;
      }
    }
    await yieldOnce();
    if (!this._autoCache || this._autoCache.key !== (template && template.key)) this._autoCache = { key: template && template.key, cache: new Map() };
    const t0 = performance.now();
    const r = AUTO!.run(stat.data, px.data, w, h, { ...ctx, template: template && template.t, cache: this._autoCache.cache }); // auto() runs only with mower-auto loaded
    this.lastMainMs = performance.now() - t0; // the pass on the main thread (no worker)
    return r;
  }

  _autoViaWorker(wk: Worker, rgba: Pixels, w: number, h: number, stat: StaticPixels, template: TemplateRef | null, ctx: AutoContext): Promise<AutoResult> {
    const id = ++this._seq;
    const live = rgba.byteOffset === 0 && rgba.byteLength === rgba.buffer.byteLength ? rgba.buffer : rgba.slice().buffer;
    const msg: Record<string, unknown> & { tplKey: unknown; stat?: ArrayBufferLike } = { type: 'auto', id, live, w, h, ctx, statKey: stat.key, tplKey: template ? template.key : null, template: null };
    const tr: Transferable[] = [live as ArrayBuffer];
    if (this._sentStat !== stat.key) { msg.stat = stat.data.slice().buffer; tr.push(msg.stat as ArrayBuffer); }
    if (this._sentTpl !== msg.tplKey) msg.template = template ? template.t : null;
    return new Promise<AutoResult>((resolve, reject) => {
      const timer = setTimeout(() => { this._waiting.delete(id); reject(new Error('timeout')); }, WORKER_TIMEOUT_MS);
      this._waiting.set(id, (m) => {
        clearTimeout(timer);
        this._waiting.delete(id);
        if (m.disposed) reject(Object.assign(new Error('disposed'), { disposed: true }));
        else if (m.error) { this._sentStat = null; this._sentTpl = undefined; reject(new Error(m.error)); }
        else { m.data = new Uint8ClampedArray(m.out!); resolve(m as unknown as AutoResult); } // the worker's autoProcess result + out
      });
      wk.postMessage(msg, tr);
      this._sentStat = stat.key;
      this._sentTpl = msg.tplKey;
    });
  }

  // One live map refresh (mower-auto.js framePass): live / stat are decoded pictures (ImageBitmap,
  // transferred: the worker draws and reads them, the page never reads pixels); stat only when its key
  // changed. w, h: working size. template: { key, t } | null; ctx: framePass context. Without a worker:
  // the same pass here. -> Promise of its result + { ms (pass time), main (ms on this thread) }
  frame(
    live: ImageBitmap, stat: StaticBitmap | null, w: number, h: number, template: TemplateRef | null, ctx: FrameContext,
  ): Promise<FrameResult & { ms: number; main: number }> {
    const run = this._queue.then(() => this._frame(live, stat, w, h, template, ctx));
    this._queue = run.catch(() => {});
    return run;
  }

  async _frame(
    live: ImageBitmap, stat: StaticBitmap | null, w: number, h: number, template: TemplateRef | null, ctx: FrameContext,
  ): Promise<FrameResult & { ms: number; main: number }> {
    const wk = AUTO ? this._getWorker() : null; // registered hooks always include frame
    if (wk) {
      try {
        return await this._frameViaWorker(wk, live, stat, w, h, template, ctx);
      } catch (e) {
        if (flagOf(e, 'disposed')) throw e;
        if (flagOf(e, 'restart')) { this._sentFrameStat = null; throw e; }
        console.warn('floorplan3d: map worker failed, processing on the main thread', e);
        this._killWorker();
        throw e; // the pictures went to the worker: this refresh is skipped, the next one runs here
      }
    }
    await yieldOnce();
    const t0 = performance.now();
    const read = (bmp: ImageBitmap) => {
      if (!this.work) this.work = makeCanvas(w, h);
      if (this.work.width !== w) this.work.width = w;
      if (this.work.height !== h) this.work.height = h;
      const g = ctx2d(this.work);
      g.clearRect(0, 0, w, h);
      g.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      return g.getImageData(0, 0, w, h).data;
    };
    if (stat) this._fstat = { key: stat.key, data: read(stat.bitmap), shift: null, w, h };
    const fst = this._fstat;
    if (!fst || fst.key !== (stat ? stat.key : ctx.statKey) || fst.w !== w || fst.h !== h) { if (live.close) live.close(); throw Object.assign(new Error('static map missing'), { restart: true }); }
    const px = read(live);
    const A = AUTO!; // _frame runs on this thread only with mower-auto loaded (else frame() has no pass)
    if (!fst.shift) {
      const f = Math.max(1, Math.round(w / 256));
      const a = A.downGray(fst.data, w, h, f), b = A.downGray(px, w, h, f);
      const sh = A.bestShift(a.g, b.g, a.w, a.h, 4);
      fst.shift = { dx: sh.dx * f, dy: sh.dy * f };
    }
    if (!this._fstate) this._fstate = A.frameState();
    if (!this._autoCache || this._autoCache.key !== (template && template.key)) this._autoCache = { key: template && template.key, cache: new Map() };
    const r = A.frame(fst.data, px, w, h, { ...ctx, shift: fst.shift, statKey: fst.key, template: template && template.t, cache: this._autoCache.cache }, this._fstate);
    const ms = performance.now() - t0;
    return { ...r, ms, main: ms };
  }

  _frameViaWorker(
    wk: Worker, live: ImageBitmap, stat: StaticBitmap | null, w: number, h: number, template: TemplateRef | null, ctx: FrameContext,
  ): Promise<FrameResult & { ms: number; main: number }> {
    const id = ++this._seq;
    const msg: Record<string, unknown> & { tplKey: unknown } = { type: 'frame', id, live, w, h, ctx, statKey: stat ? stat.key : this._sentFrameStat, tplKey: template ? template.key : null, template: null };
    const tr: Transferable[] = [live];
    if (stat) { msg.stat = stat.bitmap; tr.push(stat.bitmap); }
    if (this._sentTpl !== msg.tplKey) msg.template = template ? template.t : null;
    return new Promise<FrameResult & { ms: number; main: number }>((resolve, reject) => {
      const timer = setTimeout(() => { this._waiting.delete(id); reject(new Error('timeout')); }, WORKER_TIMEOUT_MS);
      this._waiting.set(id, (m) => {
        clearTimeout(timer);
        this._waiting.delete(id);
        if (m.disposed) reject(Object.assign(new Error('disposed'), { disposed: true }));
        else if (m.error) {
          this._sentTpl = undefined;
          // the static map is not there (another size, a new worker): send it again next time
          reject(Object.assign(new Error(m.error), { restart: /static map missing/.test(m.error) }));
          this._sentFrameStat = null;
        } else resolve({ ...m, main: 0 } as unknown as FrameResult & { ms: number; main: number }); // the worker's framePass result + ms
      });
      wk.postMessage(msg, tr);
      if (stat) this._sentFrameStat = stat.key;
      this._sentTpl = msg.tplKey;
    });
  }

  // Does the processor (its worker, else this thread) hold the static picture of this key?
  hasStatic(key: unknown): boolean {
    if (this._worker) return this._sentFrameStat === key;
    return !!this._fstat && this._fstat.key === key;
  }

  // Terminates the worker and settles pending runs (their timeouts cleared) without marking the worker
  // dead, so a later run (after a reconnect) starts a fresh one.
  dispose(): void {
    if (this._worker) this._worker.terminate();
    this._worker = null;
    this._sentFrameStat = null;
    this._sentStat = null;
    this._sentTpl = undefined;
    for (const w of [...this._waiting.values()]) w({ disposed: true });
    this._waiting.clear();
  }
}
