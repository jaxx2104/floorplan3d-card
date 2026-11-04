// Mower map tools: the 2D picker on the map image (colour picks, align points, mark front), the 3D colour
// pick fallback, and "Align by points".

import { overlayUrl } from '../../mower.ts';
import { MapPicker } from '../../map-picker.ts';
import { readImagePixels, imagePixels, medianColor, colorList, addColorPatch, removeColorPatch, MAX_COLORS, fitOverlay } from '../../mower-image.ts';
import { mapPoint } from '../router.ts';
import { mower, setMower, setOverlay } from '../tabs/mower.ts';
import type { EditMode, MapColorKind } from '../../edit-mode.ts';
import type { PickerImage, PickerPoint, RGB } from '../../map-picker.ts';
import type { MowerImageConfig, MowerOverlay, PlanPoint } from '../../types/layout.ts';


/** Colour categories: the mower icon or one of the map colours. */
export type ColorKind = 'icon' | MapColorKind;
/** What the map overlay plane keeps of its last load (mapPlane.userData.loaded). */
interface LoadedMap { image?: PickerImage & { naturalWidth?: number; naturalHeight?: number } }

// mower-image.js is still JS: its `kind = null` default is inferred as the parameter's only type
export const colorsOf = colorList as (obj: unknown, kind?: string | null) => RGB[];

// the overlay picture as loaded, if any
function loadedMap(ed: EditMode): LoadedMap | null {
  const pl = ed.view.mapPlane;
  return pl ? (pl.userData.loaded as LoadedMap | null | undefined) || null : null; // three.js userData
}

// ---------- 2D picker on the original map image ----------
export function closePicker(ed: EditMode) {
  const p = ed.picker;
  ed.picker = null;
  if (p) p.close('closed');
}

// The map picture as loaded (raw, not processed) for a category: the overlay's picture, or for the
// icon a separate image entity (fetched). -> CanvasImageSource or null.
export async function pickerImage(ed: EditMode, kind: ColorKind): Promise<PickerImage | null> {
  const m = mower(ed), o: MowerOverlay = m.overlay || {}, ic: MowerImageConfig = m.image || {};
  if (kind === 'icon' && ic.entity && ic.entity !== o.entity) {
    const url = overlayUrl(ed.hass, ic.entity, Date.now());
    if (!url || typeof createImageBitmap !== 'function') return null;
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return createImageBitmap(await res.blob());
  }
  const ld = loadedMap(ed);
  return ld && ld.image ? ld.image : null;
}

export function pickerFallback(ed: EditMode, kind: ColorKind) {
  // no picture to show: pick on the map in 3D (the clicked overlay pixel)
  ed.colorPick = kind === 'icon' ? true : kind;
  if (ed.card._floor !== ed.card._mowerFloor()) ed.card._setFloor(ed.card._mowerFloor());
  ed._syncStageClasses();
  ed.render();
}

// Colour picks for a category ('icon', 'bg', 'mowed', 'nomow'); stays open for more shades.
export async function openColorPicker(ed: EditMode, kind: ColorKind) {
  closePicker(ed);
  ed.colorPick = false;
  let image: PickerImage | null = null;
  try { image = await pickerImage(ed, kind); } catch (e) { console.warn('floorplan3d: could not read the mower map image', e); }
  if (!image) { pickerFallback(ed, kind); return; }
  const names = { icon: 'mower icon', bg: 'background', mowed: 'mowed stripe', nomow: 'no-mow area' };
  const icon = kind === 'icon';
  const cur = (): MowerImageConfig | MowerOverlay => (icon ? mower(ed).image || {} : mower(ed).overlay || {});
  try {
    ed.picker = new MapPicker(ed.card._stage, {
      image, mode: 'color', kind,
      title: `Click the ${names[kind]} colour (up to ${MAX_COLORS})`,
      colors: () => colorsOf(cur(), icon ? null : kind),
      tolerance: () => Number(icon ? cur().tolerance ?? 40 : cur()[`${kind}_tolerance`] ?? 30),
      onColor: (rgb, q) => {
        if (colorsOf(cur(), icon ? null : kind).length >= MAX_COLORS) { ed.message = { text: `At most ${MAX_COLORS} colours: remove one first.`, error: true }; ed.render(); return; }
        ed.message = null;
        if (icon) addMowerColor(ed, rgb, q, { imgW: q.imgW, imgH: q.imgH, width: q.imgW });
        else addMapColor(ed, kind as MapColorKind, rgb); // not the icon
      },
      onRemove: (i) => {
        if (icon) { const ic = cur(); setMower(ed, { image: { ...ic, ...removeColorPatch(ic, null, i) } }); } else setOverlay(ed, removeColorPatch(cur(), kind, i));
      },
      onClose: () => { ed.picker = null; ed.render(); },
    });
  } catch (e) {
    console.warn('floorplan3d: could not open the map picker', e);
    pickerFallback(ed, kind);
    return;
  }
  ed.render();
}

// Align by points: the image point in the 2D picker, then the model point in 3D.
export function alignPicker(ed: EditMode) {
  const a = ed.aligning;
  if (!a || a.pending) return;
  closePicker(ed);
  const ld = loadedMap(ed);
  if (!ld || !ld.image) return; // 3D fallback: click the map on the plan
  try {
    ed.picker = new MapPicker(ed.card._stage, {
      image: ld.image, mode: 'point',
      title: `Point ${a.pairs.length + 1}: click a spot on the map image you can find on the model`,
      onPoint: ({ px, py }: PickerPoint) => {
        if (ed.aligning !== a) return;
        a.pending = { px, py };
        ed.message = null;
        ed.render();
      },
      onClose: () => { ed.picker = null; ed.render(); },
    });
  } catch (e) {
    console.warn('floorplan3d: could not open the map picker', e);
  }
  ed.render();
}

// Stop aligning and put the overlay back where it was when "Align by points" started.
export function cancelAlign(ed: EditMode) {
  closePicker(ed);
  const a = ed.aligning;
  ed.aligning = null;
  if (a && a.start && a.pairs.length >= 2 && mower(ed).overlay) setOverlay(ed, { ...a.start }, false);
}

// "Align by points": odd clicks pick a spot on the map image (pixel through the current overlay),
// even clicks the same spot on the model (surface under the pointer, else the map's height).
// From 2 pairs on, the overlay is fitted to all pairs (similarity, least squares for 3+).
export function alignClick(ed: EditMode, e: PointerEvent) {
  const a = ed.aligning!; // the 'align' route: set
  const o = mower(ed).overlay;
  const ld = loadedMap(ed);
  const img = ld && ld.image;
  if (!o || !img) { ed.aligning = null; ed.message = { text: 'Wait for the map image to load.', error: true }; ed._syncStageClasses(); ed.render(); return; }
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  if (!a.pending) {
    const hit = ed.view.mapHit(e.clientX, e.clientY);
    if (!hit) { ed.message = { text: 'Click on the map image.', error: true }; ed.render(); return; }
    const q = { px: hit.u * W, py: (1 - hit.v) * H };
    ed.message = null;
    a.pending = { px: q.px, py: q.py };
    ed.render();
    return;
  }
  const hit = ed.view.model ? ed.view.surfaceAt(e.clientX, e.clientY) : null;
  const plan: PlanPoint | null = hit ? [hit.point.x, -hit.point.z] : mapPoint(ed, e);
  if (!plan) return;
  a.pairs = [...a.pairs, { ...a.pending, plan }];
  a.pending = null;
  const fit = a.pairs.length >= 2 ? fitOverlay(a.pairs, W, H) : null;
  if (fit) {
    const r = (v: number, k: number) => Math.round(v * k) / k;
    setOverlay(ed, { x: r(fit.x, 1000), y: r(fit.y, 1000), rotation: r(fit.rotation, 100), width: r(fit.width, 1000) });
  } else ed.render();
  alignPicker(ed); // the next image point
}

// Add a mower icon colour (up to MAX_COLORS); q: the clicked image pixel, where tracking starts
// (at the clicked icon, not the largest blob of its colours). img: { imgW, imgH, width }.
export function addMowerColor(ed: EditMode, color: RGB, q: PickerPoint | null, img: { imgW: number; imgH: number; width: number } | null) {
  const ic: MowerImageConfig = mower(ed).image || {};
  const image = { tolerance: 40, min_pixels: 4, ...ic, ...addColorPatch(ic, null, color) };
  if (q && img) ed.card._imageBlob = { px: q.px, py: q.py, count: null, misses: 0, imgW: img.imgW, imgH: img.imgH, sampleW: img.width, colors: colorList(image) };
  setMower(ed, { image });
}

export function addMapColor(ed: EditMode, kind: MapColorKind, color: RGB, rerender = true) {
  setOverlay(ed, addColorPatch(mower(ed).overlay || {}, kind, color), rerender);
}

// Colour at an image position (fractions 0..1 from the top left) of the RAW map image: median of 5x5 pixels.
export async function pickMowerColor(ed: EditMode, fx: number, fy: number) {
  const m = mower(ed);
  const o = m.overlay;
  const ic: MowerImageConfig = m.image || {};
  const entity = ic.entity || (o && o.entity);
  const url = entity && overlayUrl(ed.hass, entity, Date.now());
  if (!url || !o) { ed.message = { text: 'Set the map overlay first.', error: true }; ed.render(); return; }
  try {
    // the picture on the plane when it is the same entity (what was clicked), else a fresh read
    const ld = loadedMap(ed);
    const li = ld && ld.image;
    const same = li && (!ic.entity || ic.entity === o.entity);
    const img = same ? imagePixels(li, li.naturalWidth || li.width, li.naturalHeight || li.height) : await readImagePixels(url);
    const q = { px: fx * img.imgW, py: fy * img.imgH };
    const px = Math.floor(fx * img.width), py = Math.floor(fy * img.height);
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) {
      ed.message = { text: 'That point is outside the map image.', error: true };
      ed.render();
      return;
    }
    ed.message = null;
    addMowerColor(ed, medianColor(img.data, img.width, img.height, px, py), q, img);
  } catch (e) {
    console.warn('floorplan3d: could not read the mower map image', e);
    ed.message = { text: "Can't read the map image.", error: true };
    ed.render();
  }
}

// Map colour (background / mowed / no-mow) at an image position (fractions from the top left):
// median of the 5x5 pixels of the loaded overlay picture as loaded (not the processed one).
export function pickMapColor(ed: EditMode, kind: MapColorKind, fx: number, fy: number) {
  const o = mower(ed).overlay;
  const ld = loadedMap(ed);
  const img = ld && ld.image;
  if (!o || !img) { ed.message = { text: 'Wait for the map image to load.', error: true }; ed.render(); return; }
  try {
    const px = imagePixels(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
    const i = Math.floor(fx * px.width), j = Math.floor(fy * px.height);
    if (i < 0 || j < 0 || i >= px.width || j >= px.height) { ed.message = { text: 'That point is outside the map image.', error: true }; ed.render(); return; }
    ed.message = null;
    addMapColor(ed, kind, medianColor(px.data, px.width, px.height, i, j));
  } catch (e) {
    console.warn('floorplan3d: could not read the mower map image', e);
    ed.message = { text: "Can't read the map image.", error: true };
    ed.render();
  }
}

export function markFront(ed: EditMode) {
  const ld = loadedMap(ed), b = ed.card._imageBlob;
  const image = ld && ld.image;
  if (!image || !b) return;
  closePicker(ed);
  try {
    ed.picker = new MapPicker(ed.card._stage, {
      image, mode: 'point', title: 'Click the front tip of the mower icon',
      onPoint: ({ px, py }: PickerPoint) => {
        const bb = ed.card._imageBlob, raw = ed.card._iconHeadRaw;
        if (!bb || raw === undefined || raw === null) return;
        const sx = (image.naturalWidth || image.width) / bb.imgW;
        const marked = (Math.atan2(-(py - bb.py * sx), px - bb.px * sx) * 180) / Math.PI;
        let off = (((marked - raw) % 360) + 540) % 360 - 180;
        off = Math.round(off);
        const ic = mower(ed).image || {};
        ed.card._headSt = null;
        setMower(ed, { image: { ...ic, front_offset: off } });
      },
      onClose: () => { ed.picker = null; ed.render(); },
    });
  } catch (e) {
    console.warn('floorplan3d: could not open the map picker', e);
  }
  ed.render();
}
