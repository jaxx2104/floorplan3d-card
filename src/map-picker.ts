// 2D picker on the ORIGINAL map image, over the stage: zoom (wheel, pinch, + / -), pan (drag),
// crosshair, a magnifier loupe with the exact pixel and its colour. A click picks that pixel:
//   mode 'color': adds its colour (median 3x3) through onColor and stays open (Done / Esc closes);
//   mode 'point': reports the pixel through onPoint and closes.
// "Show matches" tints pixels within tolerance of the category's colours (what will be keyed).
import { medianColor } from './mower-image.ts';

export type RGB = number[];
/** View transform: image pixel (x, y) -> box (ox + x * s, oy + y * s). */
export interface PickerView { s: number; ox: number; oy: number }
export interface PickerPoint { px: number; py: number }
/** What the picker can read: everything drawable with a width / height (no SVG images, no video frames). */
export type PickerImage = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas;
export type PickerCloseReason = 'done' | 'esc' | 'point' | 'closed';

export interface MapPickerOptions {
  image: PickerImage;
  title?: string;
  mode: 'color' | 'point';
  /** the colour category (informational) */
  kind?: string;
  colors?: () => RGB[];
  tolerance?: () => number;
  onColor?: (rgb: RGB, q: PickerPoint & { imgW: number; imgH: number }) => void;
  onPoint?: (p: PickerPoint) => void;
  onRemove?: (index: number) => void;
  onClose?: (reason: PickerCloseReason) => void;
}

// natural size of a picture, else its element / bitmap size
function sourceSize(img: PickerImage): [number, number] {
  const n = img as Partial<HTMLImageElement> & Partial<HTMLVideoElement>; // only the members this union may have
  return [n.naturalWidth || n.videoWidth || img.width, n.naturalHeight || n.videoHeight || img.height];
}

const CLICK_PX = 5;
const LOUPE = 112, LOUPE_ZOOM = 8;
const MAX_SIDE = 4096; // read the picture at full size up to this

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: unknown): string => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

// Pure: view transform helpers (tested).
export function fitView(imgW: number, imgH: number, boxW: number, boxH: number, pad = 8): PickerView {
  const s = Math.max(1e-6, Math.min((boxW - 2 * pad) / imgW, (boxH - 2 * pad) / imgH));
  return { s, ox: (boxW - imgW * s) / 2, oy: (boxH - imgH * s) / 2 };
}

// Zoom by factor k about the box point (bx, by), keeping the image point under it fixed.
export function zoomAt(v: PickerView, k: number, bx: number, by: number, min = 0.05, max = 64): PickerView {
  const s = Math.max(min, Math.min(max, v.s * k));
  const r = s / v.s;
  return { s, ox: bx - (bx - v.ox) * r, oy: by - (by - v.oy) * r };
}

export function toImage(v: PickerView, bx: number, by: number): { x: number; y: number } {
  return { x: (bx - v.ox) / v.s, y: (by - v.oy) / v.s };
}

// Pixels of rgba (w x h) within tol (max channel difference) of any of the colours -> Uint8Array.
export function matchMask(rgba: ArrayLike<number>, w: number, h: number, colors: RGB[] | null | undefined, tol: number): Uint8Array {
  const m = new Uint8Array(w * h);
  if (!colors || !colors.length) return m;
  for (let i = 0, k = 0; i < w * h; i++, k += 4) {
    if (rgba[k + 3] < 128) continue;
    for (const c of colors) {
      if (Math.abs(rgba[k] - c[0]) <= tol && Math.abs(rgba[k + 1] - c[1]) <= tol && Math.abs(rgba[k + 2] - c[2]) <= tol) { m[i] = 1; break; }
    }
  }
  return m;
}

export class MapPicker {
  root: HTMLElement;
  opts: MapPickerOptions;
  imgW: number;
  imgH: number;
  /** picture pixels -> sampled pixels */
  k: number;
  src: HTMLCanvasElement;
  data: Uint8ClampedArray;
  w: number;
  h: number;
  showMatches: boolean;
  matchCount = 0;
  _maskKey: string | null;
  _maskCanvas: HTMLCanvasElement | null = null;
  el: HTMLDivElement | null = null;
  // set in _build (run by the constructor)
  view!: HTMLDivElement;
  canvas!: HTMLCanvasElement;
  loupe!: HTMLCanvasElement;
  info!: HTMLDivElement;
  _ptrs!: Map<number, { x: number; y: number }>;
  _onKey!: (e: KeyboardEvent) => void;
  _ro!: ResizeObserver | null;
  /** set by the first _resize (in _build) */
  v!: PickerView;
  _drag: { x: number; y: number; v: PickerView; moved: boolean } | null = null;
  _pinch: { d: number; v: PickerView } | null = null;

  /**
   * root: the stage element. opts: { image (CanvasImageSource), title, mode: 'color' | 'point',
   *   colors() -> [[r,g,b]] (chips), tolerance() -> number, onColor(rgb, { px, py }), onPoint({ px, py }),
   *   onRemove(index), onClose(reason) }
   */
  constructor(root: HTMLElement, opts: MapPickerOptions) {
    this.root = root;
    this.opts = opts;
    const img = opts.image;
    const [W0, H0] = sourceSize(img);
    if (!W0 || !H0) throw new Error('empty image');
    const k = Math.min(1, MAX_SIDE / Math.max(W0, H0));
    this.imgW = W0;
    this.imgH = H0;
    this.k = k; // picture pixels -> sampled pixels
    const w = Math.max(1, Math.round(W0 * k)), h = Math.max(1, Math.round(H0 * k));
    this.src = document.createElement('canvas');
    this.src.width = w;
    this.src.height = h;
    const g = this.src.getContext('2d', { willReadFrequently: true })!; // a fresh canvas always has a 2d context
    g.drawImage(img, 0, 0, w, h);
    this.data = g.getImageData(0, 0, w, h).data;
    this.w = w;
    this.h = h;
    this.showMatches = false;
    this._maskKey = null;
    this._build();
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'fp-picker';
    const color = this.opts.mode !== 'point';
    el.innerHTML = `<div class="fp-pk-bar"><span class="fp-pk-title">${esc(this.opts.title || 'Pick on the map image')}</span>
      <span class="fp-pk-chips"></span>
      ${color ? '<label class="fp-pk-match"><input type="checkbox" data-pk="matches"> Show matches</label>' : ''}
      <button data-pk="out" title="Zoom out">−</button><button data-pk="in" title="Zoom in">+</button><button data-pk="fit" title="Fit">Fit</button>
      <button data-pk="done" class="primary">${color ? 'Done' : 'Cancel'}</button></div>
      <div class="fp-pk-view"><canvas class="fp-pk-canvas"></canvas><canvas class="fp-pk-loupe" width="${LOUPE}" height="${LOUPE}"></canvas>
      <div class="fp-pk-info"></div></div>`;
    for (const t of ['pointerdown', 'pointerup', 'pointermove', 'click', 'dblclick', 'wheel', 'contextmenu', 'touchstart', 'touchmove', 'keydown']) {
      el.addEventListener(t, (e) => e.stopPropagation());
    }
    this.el = el;
    // the markup above has every one of these
    this.view = el.querySelector<HTMLDivElement>('.fp-pk-view')!;
    this.canvas = el.querySelector<HTMLCanvasElement>('.fp-pk-canvas')!;
    this.loupe = el.querySelector<HTMLCanvasElement>('.fp-pk-loupe')!;
    this.info = el.querySelector<HTMLDivElement>('.fp-pk-info')!;
    const bar = el.querySelector<HTMLDivElement>('.fp-pk-bar')!;
    bar.addEventListener('click', (e) => this._bar(e));
    bar.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.pk === 'matches') { this.showMatches = t.checked; this.draw(); }
    });
    const c = this.canvas;
    this._ptrs = new Map();
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => { this._ptrs.delete(e.pointerId); this._drag = null; });
    c.addEventListener('pointerleave', () => { this.loupe.style.display = 'none'; this.info.textContent = ''; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const b = this._box(e);
      this.v = zoomAt(this.v, Math.exp(-e.deltaY * 0.0015), b.x, b.y);
      this.draw();
      this._hover(e);
    }, { passive: false });
    this._onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close('esc'); }
    };
    window.addEventListener('keydown', this._onKey, true);
    this.root.append(el);
    this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._resize()) : null;
    if (this._ro) this._ro.observe(this.view);
    this._resize(true);
    this.refresh();
  }

  _resize(fit = false) {
    const r = this.view.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; fit = fit || !this.v; }
    if (fit || !this.v) this.v = fitView(this.imgW, this.imgH, W, H);
    this.draw();
  }

  _box(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // Client position of a picture pixel (headless checks).
  clientOf(px: number, py: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [r.left + this.v.ox + px * this.v.s, r.top + this.v.oy + py * this.v.s];
  }

  _bar(e: Event) {
    const b = (e.target as Element).closest('button');
    if (!b) return;
    const W = this.canvas.width, H = this.canvas.height;
    switch (b.dataset.pk) {
      case 'in': this.v = zoomAt(this.v, 1.5, W / 2, H / 2); break;
      case 'out': this.v = zoomAt(this.v, 1 / 1.5, W / 2, H / 2); break;
      case 'fit': this.v = fitView(this.imgW, this.imgH, W, H); break;
      case 'done': this.close('done'); return;
      case 'del': if (this.opts.onRemove) this.opts.onRemove(Number(b.dataset.i)); this.refresh(); return;
      default: return;
    }
    this.draw();
  }

  _down(e: PointerEvent) {
    this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    if (this._ptrs.size === 2) {
      const [a, b] = [...this._ptrs.values()];
      this._pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), v: this.v };
      this._drag = null;
      return;
    }
    this._drag = { x: e.clientX, y: e.clientY, v: this.v, moved: false };
  }

  _move(e: PointerEvent) {
    if (this._ptrs.has(e.pointerId)) this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pinch && this._ptrs.size === 2) {
      const [a, b] = [...this._ptrs.values()];
      const r = this.canvas.getBoundingClientRect();
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.v = zoomAt(this._pinch.v, d / (this._pinch.d || 1), (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      this.draw();
      return;
    }
    const d = this._drag;
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) >= CLICK_PX) d.moved = true;
      if (d.moved) { this.v = { ...d.v, ox: d.v.ox + dx, oy: d.v.oy + dy }; this.draw(); }
    }
    this._hover(e);
  }

  _up(e: PointerEvent) {
    this._ptrs.delete(e.pointerId);
    if (this._pinch) { if (this._ptrs.size < 2) this._pinch = null; this._drag = null; return; }
    const d = this._drag;
    this._drag = null;
    if (!d || d.moved) return;
    const p = this._pixelAt(e);
    if (!p) return;
    if (this.opts.mode === 'point') {
      const cb = this.opts.onPoint;
      this.close('point');
      if (cb) cb({ px: (p.i + 0.5) / this.k, py: (p.j + 0.5) / this.k });
      return;
    }
    const rgb = medianColor(this.data, this.w, this.h, p.i, p.j, 1);
    if (this.opts.onColor) this.opts.onColor(rgb, { px: (p.i + 0.5) / this.k, py: (p.j + 0.5) / this.k, imgW: this.imgW, imgH: this.imgH });
    this.refresh();
  }

  // sampled pixel under the pointer, or null outside the picture
  _pixelAt(e: { clientX: number; clientY: number }): { i: number; j: number; b: { x: number; y: number } } | null {
    const b = this._box(e), q = toImage(this.v, b.x, b.y);
    const i = Math.floor(q.x * this.k), j = Math.floor(q.y * this.k);
    return i >= 0 && j >= 0 && i < this.w && j < this.h ? { i, j, b } : null;
  }

  _hover(e: { clientX: number; clientY: number }) {
    const p = this._pixelAt(e);
    if (!p) { this.loupe.style.display = 'none'; this.info.textContent = ''; return; }
    const L = this.loupe, g = L.getContext('2d')!; // own canvas, 2d only
    const n = LOUPE / LOUPE_ZOOM; // pixels shown across
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#000';
    g.fillRect(0, 0, LOUPE, LOUPE);
    g.drawImage(this.src, p.i - n / 2 + 0.5, p.j - n / 2 + 0.5, n, n, 0, 0, LOUPE, LOUPE);
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.strokeRect(LOUPE / 2 - LOUPE_ZOOM / 2, LOUPE / 2 - LOUPE_ZOOM / 2, LOUPE_ZOOM, LOUPE_ZOOM);
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    g.strokeRect(LOUPE / 2 - LOUPE_ZOOM / 2 - 1.5, LOUPE / 2 - LOUPE_ZOOM / 2 - 1.5, LOUPE_ZOOM + 3, LOUPE_ZOOM + 3);
    const W = this.canvas.width;
    L.style.display = 'block';
    const lx = p.b.x + 18 + LOUPE > W ? p.b.x - 18 - LOUPE : p.b.x + 18;
    L.style.left = `${lx}px`;
    L.style.top = `${Math.max(0, p.b.y - LOUPE - 18)}px`;
    const k = (p.j * this.w + p.i) * 4, d = this.data;
    const rgb = [d[k], d[k + 1], d[k + 2]];
    this.info.innerHTML = `<span class="swatch" style="background:rgb(${rgb.join(',')})"></span> ${Math.floor((p.i + 0.5) / this.k)}, ${Math.floor((p.j + 0.5) / this.k)} · rgb(${rgb.join(', ')})`;
  }

  // chips and the match tint follow the category's colours
  refresh() {
    if (!this.el) return;
    const box = this.el.querySelector('.fp-pk-chips');
    if (box && this.opts.mode !== 'point') {
      const cols = this.opts.colors ? this.opts.colors() : [];
      box.innerHTML = cols.map((c, i) => `<span class="cchip"><span class="swatch" style="background:rgb(${c.join(',')})"></span>
        <button data-pk="del" data-i="${i}" class="link" title="Remove this colour" aria-label="Remove">×</button></span>`).join('');
    }
    this.draw();
  }

  _mask(): HTMLCanvasElement {
    const cols = this.opts.colors ? this.opts.colors() : [];
    const tol = this.opts.tolerance ? this.opts.tolerance() : 30;
    const key = JSON.stringify([cols, tol]);
    if (key === this._maskKey && this._maskCanvas) return this._maskCanvas;
    this._maskKey = key;
    const m = matchMask(this.data, this.w, this.h, cols, tol);
    const cv = (this._maskCanvas = this._maskCanvas || document.createElement('canvas'));
    cv.width = this.w;
    cv.height = this.h;
    const g = cv.getContext('2d')!; // own canvas, 2d only
    const id = g.createImageData(this.w, this.h);
    let count = 0;
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      count++;
      id.data.set([255, 0, 255, 200], i * 4);
    }
    g.putImageData(id, 0, 0);
    this.matchCount = count;
    return cv;
  }

  draw() {
    if (!this.el || !this.v) return;
    const g = this.canvas.getContext('2d')!; // own canvas, 2d only
    const { s, ox, oy } = this.v;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.imageSmoothingEnabled = s < 2;
    g.drawImage(this.src, ox, oy, this.imgW * s, this.imgH * s);
    if (this.showMatches && this.opts.mode !== 'point') g.drawImage(this._mask(), ox, oy, this.imgW * s, this.imgH * s);
  }

  close(reason: PickerCloseReason = 'done') {

    if (!this.el) return;
    window.removeEventListener('keydown', this._onKey, true);
    if (this._ro) this._ro.disconnect();
    this.el.remove();
    this.el = null;
    if (this.opts.onClose) this.opts.onClose(reason);
  }
}
