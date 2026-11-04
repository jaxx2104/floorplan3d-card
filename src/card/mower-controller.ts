// Live mower for the card: position (gps / xy / the live map image), heading, warning, track and the
// map overlay incl. auto mode (the live map processed off the main thread). One controller for now:
// the live position and the map pass call each other (_refreshMower -> _imageMowerPos -> _detectMower
// -> _refreshMower). The card (host) is read live on every call: _hass / _layout / _config are
// replaced on each update, so nothing of it is captured here.

import { readTrack, readSource, overlayUrl, mowerTransform, type MowerReading, type MowerTransform } from '../mower.ts';
import { lastPosition, rememberPosition, mowerDockGroup, isDocked, dockWord, mowerStatusText, fullSearch, trackWindow, layerDue, LONG_TASK_MS, throttleStep, effectiveRefresh, type MowerStatus, type ThrottleState } from '../mower-track.ts';
import { STUCK_DEFAULT_MIN, stuckStep, errorKind, stuckDueIn, errorText } from '../mower-warning.ts';
import { connectivity, rain, findErrorEntity, findStatusEntity, findProgress, progressValue, findStaticMap, findMowerPicture } from '../mower-device.ts';
import { colorList, pixelToPlan, readImagePixels, FETCH_TIMEOUT_MS, mapWorkSize, MapProcessor, planToPixel, findBlob, stepTrack, headingMinStep, mowedShare, stripeBearing, type ImagePixels } from '../mower-image.ts';
import type { FrameContext } from '../mower-auto.ts';
import { grayOf, matchTemplate, iconMoments, momentsOf, momentHeading, makeTemplate, smoothHeading, norm360, type HeadingTemplate, type TurnedPatch } from '../mower-heading.ts';
import { pointInPolygon, signedArea } from '../placement.ts';
import type { Floorplan3dCard } from '../card-impl.ts';
import type { MapImageResult } from '../view.ts';
import type { Zone } from './view-controller.ts';
import type { LayoutMower, MowerImage, MowerOverlay, PlanPoint } from '../types/layout.ts';

const MOWER_Z = 0.15;
const MATCH_MIN = 0.5; // mower picture match score (NCC) trusted for position and heading

type Rgb = number[];
type Timer = ReturnType<typeof setTimeout>;

/** The live mower: plan position (when known) and the raw reading of the position entity. */
export type MowerLive =
  | { x: number; y: number; floorId: string; reading: MowerReading | null }
  | { x?: undefined; y?: undefined; floorId?: undefined; reading: MowerReading };

/** The tracked mower icon on the live map (image pixels). */
export interface ImageBlob {
  px: number;
  py: number;
  count: number | null;
  misses: number;
  imgW: number;
  imgH: number;
  sampleW: number;
  colors: Rgb[];
  matched?: boolean;
}

/** The last detection: an error, a miss, or the blob size and template match score. */
export interface ImageResult {
  error?: string;
  missing?: boolean;
  count?: number;
  match?: number | null;
}

/** Map statistics of the last processed picture (zone, stripe angle, mowed share). */
export interface MapStats {
  zone: string | null;
  angle: number | null;
  share: number | null;
  auto?: boolean;
}

/** Auto mode tracking state between refreshes. */
export interface TrackState {
  docked: boolean | null;
  leaving: boolean;
  leavingSince?: number;
  lastFull: number | undefined;
  layerAt: number | undefined;
  progress: number | null | undefined;
  lastAt: number | undefined;
  seenAt: number | undefined;
  tplKey?: string | null;
}

/** Timing of the last map refresh (debug overlay, adaptive throttle, headless checks). */
export interface MapPerf {
  last: { main: number; max: number; decode: number; worker: number; apply: number; pass: unknown; at: number } | null;
}

/** framePass context plus the progress value the layer timing compares against. */
type CardFrameContext = FrameContext & { progress: number | null; leaving: boolean };
type AutoEntities = { live: string; static: string | null; picture: string | null };

export class MowerController {
  card: Floorplan3dCard;
  _mowerFn: MowerTransform | null | undefined;
  _mowerLive: MowerLive | null | undefined;
  _mowerAt: 'live' | 'dock' | 'last' | 'dock-start' | null | undefined;
  _mowerHeading: number | null | undefined;
  _mowerHeadFrom: [number, number] | null | undefined;
  _headingSource: string | null | undefined;
  _iconHead: { angle: number; source: string | null } | null | undefined;
  _iconHeadRaw: number | undefined;
  _headSt: ReturnType<typeof smoothHeading> | null | undefined;
  _trackKey: { raw: unknown; fn: MowerTransform | null | undefined; floorId: string | null; cfg: LayoutMower | null } | undefined;
  _mowerChip: { kind: string; icon: string; text: string } | null | undefined;
  _mowerOffline: boolean | undefined;
  _stuck: ReturnType<typeof stuckStep> | null | undefined;
  _stuckTimer: Timer | null | undefined;
  _warning: { kind: string; minutes: number } | null | undefined;
  _imageBlob: ImageBlob | null | undefined;
  _imageResult: ImageResult | null | undefined;
  _imageKey: string | undefined;
  _imageBusy: boolean | undefined;
  _imageAgain: boolean | undefined;
  _imageTimer: ReturnType<typeof setInterval> | null | undefined;
  _imageTimerSec: number | null | undefined;
  _tpl: { key: string; t: HeadingTemplate | null } | undefined;
  _tplCache: Map<string, TurnedPatch> | undefined;
  _tplLoading: string | null | undefined;
  _dockPx: { px: number; py: number } | null | undefined;
  _mowerRefreshQueued: boolean | undefined;
  _cameraTimer: ReturnType<typeof setInterval> | null | undefined;
  _cameraTimerSec: number | null | undefined;
  _cameraTick: number | undefined;
  _extUrl: string | null | undefined;
  _forceFull: boolean | undefined;
  _mapProc: MapProcessor | undefined;
  _mapProcKey: string | null | undefined;
  _mapPump: Promise<void> | null | undefined;
  _mapPumpAgain: boolean | undefined;
  _mapReprocTimer: Timer | undefined;
  _mapDetect: { image: unknown; key: string; found: ImageBlob | null } | undefined;
  _mapStats: MapStats | null | undefined;
  _static: { key: string; blob: Blob; natW: number; natH: number } | undefined;
  _trk: TrackState | undefined;
  _autoCanvas: HTMLCanvasElement | undefined;
  _rawCanvas: HTMLCanvasElement | undefined;
  _autoGrey: number[][] | null | undefined;
  _autoMismatch: boolean | undefined;
  _mismatchBlob: Blob | undefined;
  _lastFrame: { full: boolean; window: unknown; same: boolean; leaving: boolean } | undefined;
  _perf: MapPerf | undefined;
  _throttle: ThrottleState | undefined;

  /** @param card the Floorplan3dCard (host): read live, never captured */
  constructor(card: Floorplan3dCard) {
    this.card = card;
    // live position, heading, warning
    this._mowerFn = undefined; // plan transform of the position entity (set per layout.mower)
    this._mowerLive = undefined;
    this._mowerAt = undefined; // 'live' | 'dock' | 'last' | 'dock-start' | null
    this._mowerHeading = undefined;
    this._mowerHeadFrom = undefined;
    this._headingSource = undefined;
    this._iconHead = undefined;
    this._iconHeadRaw = undefined;
    this._headSt = undefined;
    this._trackKey = undefined;
    this._mowerChip = undefined;
    this._mowerOffline = undefined;
    this._stuck = undefined;
    this._stuckTimer = undefined;
    this._warning = undefined;
    // the mower on the live map image
    this._imageBlob = undefined;
    this._imageResult = undefined;
    this._imageKey = undefined;
    this._imageBusy = undefined;
    this._imageAgain = undefined;
    this._imageTimer = undefined;
    this._imageTimerSec = undefined;
    this._tpl = undefined;
    this._tplCache = undefined;
    this._tplLoading = undefined;
    this._dockPx = undefined;
    this._mowerRefreshQueued = undefined;
    // map overlay and auto mode
    this._cameraTimer = undefined;
    this._cameraTimerSec = undefined;
    this._cameraTick = undefined;
    this._extUrl = undefined;
    this._forceFull = undefined;
    this._mapProc = undefined;
    this._mapProcKey = undefined;
    this._mapPump = undefined;
    this._mapPumpAgain = undefined;
    this._mapReprocTimer = undefined;
    this._mapDetect = undefined;
    this._mapStats = undefined;
    this._static = undefined;
    this._trk = undefined;
    this._autoCanvas = undefined;
    this._rawCanvas = undefined;
    this._autoGrey = undefined;
    this._autoMismatch = undefined;
    this._mismatchBlob = undefined;
    this._lastFrame = undefined;
    this._perf = undefined;
    this._throttle = undefined;
  }

  // layout.mower changed (card _update): the plan transform of its position entity.
  configChanged(m: LayoutMower | null): void {
    this._mowerFn = m && m.entity ? mowerTransform(m) : null;
  }

  // view.onMapReprocess (auto mode: settings or the mower picture changed): the current picture again, searched in full.
  onMapReprocess(): void {
    this._forceFull = true;
    this._extUrl = null;
    if (this.card._layout && this.card._layout.mower) this._refreshMapOverlay();
  }

  // connectedCallback: the map / image timers stopped on disconnect, re-armed on the next update.
  resume(): void {
    this._cameraTimerSec = null;
    this._imageTimerSec = null;
  }

  // disconnectedCallback: timers, the warning's pulse timer, the map worker.
  dispose(): void {
    clearTimeout(this._stuckTimer ?? undefined);
    this._stuckTimer = null;
    if (this.card._view) this.card._view.setMowerWarning(null); // its pulse timer
    this._setCameraTimer(0);
    this._setImageTimer(0);
    clearTimeout(this._mapReprocTimer);
    if (this._mapProc) this._mapProc.dispose(); // its worker
    this._extUrl = null; // fetched again on reconnect
  }

  // The driven path on the floor (xy source with track_attr). Hidden while docked unless track_show: always.
  // Rebuilt only when the attribute, the transform or the floor changed (states update far more often).
  _refreshMowerTrack(cfg: LayoutMower | null, floorId: string | null = null, docked = false): void {
    const st = cfg && cfg.track_attr && cfg.entity && this.card._hass ? this.card._hass.states[cfg.entity] : null;
    const fn = this._mowerFn;
    const show = !!st && !!cfg && fn && (cfg.track_show === 'always' || !docked);
    const raw = show ? st.attributes[cfg.track_attr!] : null; // show: st, so track_attr
    const key = this._trackKey;
    if (key && key.raw === raw && key.fn === this._mowerFn && key.floorId === floorId && key.cfg === cfg) return;
    this._trackKey = { raw, fn: this._mowerFn, floorId, cfg };
    const segs = raw && st && cfg ? readTrack(st, cfg) : null; // raw: shown, so st and cfg
    const segments = segs && fn ? segs.map((s) => s.map((r) => fn(r)).filter((q): q is PlanPoint => !!q)) : null;
    this.card._view.setMowerTrack(segments && cfg && floorId !== null ? { segments, floorId, color: cfg.track_color, width: cfg.track_width, opacity: cfg.track_opacity } : null);
  }

  _mowerFloor(): string {
    const m = this.card._layout!.mower, floors = this.card._floors!; // with a layout, after the structure
    return m && m.floor_id && floors.some((f) => f.id === m.floor_id) ? m.floor_id : floors[0].id;
  }

  // Live mower: move its marker, refresh the map overlay.
  _refreshMower(): void {
    const cfg = this.card._layout!.mower; // from _update and mower refreshes (layout loaded)
    if (!cfg || !cfg.entity) {
      this._mowerLive = null;
      this.card._view.setMapOverlay(null);
      this.card._view.mowerOnFloor = false;
      this._refreshMowerTrack(null);
      this._setCameraTimer(0);
      this._setImageTimer(0);
      return;
    }
    const floorId = this._mowerFloor();
    this.card._view.mowerOnFloor = cfg.ground === 'floor';
    let reading: MowerReading | null = null, p: PlanPoint | null;
    if (cfg.source === 'image') p = this._imageMowerPos(cfg);
    else {
      this._setImageTimer(0);
      this._imageBlob = null;
      this._imageResult = null;
      reading = readSource(this.card._hass.states[cfg.entity], cfg);
      p = reading && this._mowerFn ? this._mowerFn(reading) : null;
    }
    // docked: at the dock object, turned as it is; not found: the last known position (else the dock),
    // never some default spot
    const dk = this._dockedNow();
    const dock = this.card._objects ? this.card._objects.dockPose() : null;
    const key = this.card._config.layout_key;
    let fixed: { heading?: number | null } | null = null;
    this._mowerAt = p ? 'live' : null;
    if (dk.docked && dock) {
      p = [dock.x, dock.y];
      fixed = dock;
      this._mowerAt = 'dock';
    } else if (!p) {
      const last = lastPosition(key);
      if (last && last.entity === cfg.entity) { p = [last.x, last.y]; fixed = { heading: last.heading }; this._mowerAt = 'last'; } else if (dock) { p = [dock.x, dock.y]; fixed = dock; this._mowerAt = 'dock-start'; }
    }
    this._mowerLive = p ? { x: p[0], y: p[1], floorId, reading } : (reading ? { reading } : null);
    this._refreshMowerTrack(cfg, floorId, dk.docked);
    this._poseMowerObject(p, floorId, fixed);
    if (p && this._mowerAt !== 'dock-start') {
      const ib = this._imageBlob && this._imageBlob.matched ? this._imageBlob : null, was = lastPosition(key);
      rememberPosition(key, { x: p[0], y: p[1], heading: this._mowerHeading ?? null, entity: cfg.entity,
        count: ib ? ib.count : was && was.count, imgW: ib ? ib.imgW : was && was.imgW });
    }
    this.card._refreshAttached(); // markers attached to the mower ride along
    const id = this.card._mowerMarkerId, positions = this.card._positions;
    if (p && id && positions) {
      const pos = { x: p[0], y: p[1], z: this._mowerZ(p[0], p[1], floorId), floorId, auto: false, live: true };
      const prev = positions.get(id);
      positions.set(id, pos);
      if (!this.card._view.markerObjects.has(id)) {
        this.card._buildMarkers();
        this.card._refreshStates();
      } else if (!prev || prev.x !== pos.x || prev.y !== pos.y || prev.z !== pos.z || prev.floorId !== floorId) {
        this.card._view.moveMarker(id, pos.x, pos.y, pos.z, floorId); // only when it actually moved
      }
    }
    this._refreshMapOverlay();
    this._updateMowerWarning();
  }

  // ---------- warning over the mower (error / stuck) ----------
  // The lawn_mower state entity: the bound mower object's, else the one of the position entity's device.
  _mowerStateEntity(): string | null {
    const cfg = this.card._layout && this.card._layout.mower;
    if (!cfg || !cfg.entity) return null;
    const o = this.card._objects && this.card._objects.mowerEntity();
    if (o) return o;
    if (cfg.entity.startsWith('lawn_mower.')) return cfg.entity;
    const h = this.card._hass, reg = h && h.entities && h.entities[cfg.entity];
    if (reg && reg.device_id) {
      const sib = Object.keys(h.entities).find((e) => e.startsWith('lawn_mower.') && h.entities[e].device_id === reg.device_id);
      if (sib) return sib;
    }
    return cfg.entity;
  }

  // Red warning on error, yellow when mowing but not moving; the position is the live one (gps / xy / image).
  _updateMowerWarning(): void {
    clearTimeout(this._stuckTimer ?? undefined);
    this._stuckTimer = null;
    const cfg = this.card._layout && this.card._layout.mower, h = this.card._hass, view = this.card._view;
    if (!view) return;
    if (!cfg || !cfg.entity || !h) { this._stuck = null; this._warning = null; view.setMowerWarning(null); view.setMowerChip(null); return; }
    const mse = this._mowerStateEntity();
    const ms = mse ? h.states[mse] : undefined, ee = this._errorEntity(), es = ee ? h.states[ee] : null;
    const live = this._mowerLive, pos: PlanPoint | null = live && live.x !== undefined ? [live.x, live.y] : null;
    const minutes = cfg.stuck_minutes === undefined ? STUCK_DEFAULT_MIN : Number(cfg.stuck_minutes) || 0;
    const now = Date.now();
    // offline, or waiting for the rain to stop: a chip next to the mower, the stuck clock paused
    const conn = connectivity(h, mse), rn = rain(h, mse);
    const offline = !!conn && conn.online === false;
    const chip = offline ? { kind: 'offline', icon: 'mdi:wifi-off', text: 'offline' }
      : rn && rn.wet ? { kind: 'rain', icon: 'mdi:weather-rainy', text: 'rain' }
        : rn && rn.drying !== null ? { kind: 'drying', icon: 'mdi:weather-partly-rainy', text: `${rn.drying} min` } : null;
    this._mowerChip = chip;
    view.setMowerChip(chip && live && live.x !== undefined ? { ...chip, x: live.x, y: live.y, floorId: live.floorId } : null);
    this._mowerOffline = offline;
    if (this.card._objects) this.card._objects.setMowerDim(offline);
    const paused = offline || (rn && (rn.wet || rn.drying !== null));
    this._stuck = stuckStep(this._stuck, { now, pos, state: paused ? 'paused' : ms && ms.state, minutes });
    const kind = (offline ? null : errorKind(ms, es, cfg.ok_values)) || (this._stuck.stuck ? 'stuck' : null);
    this._warning = kind ? { kind, minutes } : null;
    if (kind && live && live.x !== undefined) view.setMowerWarning({ kind, x: live.x, y: live.y, floorId: live.floorId });
    else view.setMowerWarning(null);
    const due = stuckDueIn(this._stuck, now, minutes);
    if (due !== null && this.card.isConnected) this._stuckTimer = setTimeout(() => this._updateMowerWarning(), due + 100);
    if (this.card._popup && this.card._popup.el) this.card._popup.update();
  }

  // Popup row for the warning: { label, value } or null.
  _warningText(): { label: string; value: string } | null {
    const w = this._warning, h = this.card._hass, cfg = this.card._layout && this.card._layout.mower;
    if (!w || !h || !cfg) return null;
    if (w.kind === 'stuck' && !(this._mowerLive && this._mowerLive.x !== undefined)) return { label: 'Position', value: 'no position reading' };
    if (w.kind === 'stuck') return { label: 'Stuck?', value: `no movement for ${w.minutes} min` };
    const ee = this._errorEntity();
    const mse = this._mowerStateEntity();
    return { label: 'Error', value: errorText(mse ? h.states[mse] : undefined, ee ? h.states[ee] : null, cfg.ok_values) || 'error' };
  }

  // The Mower tab's error entity, else an error code sensor of the mower's device.
  _errorEntity(): string | null {
    const cfg = this.card._layout && this.card._layout.mower;
    if (!cfg || !this.card._hass) return null;
    if (cfg.error_entity) return cfg.error_entity;
    return findErrorEntity(this.card._hass, this._mowerStateEntity());
  }

  // ---------- mower position from the live map image ----------
  // The last detected icon pixel mapped through the current overlay alignment; schedules detection
  // when the image changes (image entities) and every refresh interval (cameras, and as a fallback).
  _imageMowerPos(cfg: LayoutMower): PlanPoint | null {
    const ic: MowerImage = cfg.image || {};
    const entity = ic.entity || (cfg.overlay && cfg.overlay.entity);
    const st = entity && this.card._hass.states[entity];
    const auto = this.mowerAuto(cfg);
    const overlay = cfg.overlay;
    const ready = !!(st && (colorList(ic).length || auto) && overlay);
    // the overlay's own picture: detection runs on each loaded overlay image (one fetch per refresh)
    const driven = ready && this._mapDriven(cfg);
    this._setImageTimer(ready && !driven ? Math.max(2, Number(overlay!.refresh) || 10) : 0); // ready: overlay set
    if (!ready || !st || !overlay) {
      this._imageBlob = null;
      this._imageResult = !st ? { error: entity ? `Map image ${entity} not found.` : 'Set the map overlay first.' } : null;
      return null;
    }
    const key = [entity, driven ? '' : st.last_updated, driven ? '' : st.state, JSON.stringify(colorList(ic)), ic.tolerance, ic.min_pixels,
      auto ? `${auto.static}|${auto.picture}` : ''].join('|');
    if (key !== this._imageKey) {
      this._imageKey = key;
      if (driven) this._reprocessMap(); // detection settings changed: run again on the loaded picture
      else this._detectMower();
    }
    const b = this._imageBlob;
    if (!b) return null;
    const q = pixelToPlan(b.px, b.py, b.imgW, b.imgH, overlay);
    return [q.x, q.y];
  }

  // Centre and heading of the icon at blob b (pixels of img): template match with the mower picture
  // (score >= MATCH_MIN), else the icon's moments. -> { x, y, angle (image degrees) | null, source, score }
  _iconPose(img: ImagePixels, b: { px: number; py: number; count: number; idx?: Iterable<number> }, cols: Rgb[], tol: number): { x: number; y: number; angle: number | null; source: string | null; score: number | null } {
    const t = this._mowerTemplate();
    if (t) {
      const g = grayOf(img.data, img.width, img.height);
      const m = matchTemplate(g, img.width, img.height, t, b.px, b.py, { scale: Math.sqrt(b.count / t.count), radius: 3, cache: this._tplCache });
      if (m && m.score >= MATCH_MIN) return { x: m.x, y: m.y, angle: m.angle, source: 'picture', score: m.score };
    }
    const r = Math.max(6, 3 * Math.sqrt(b.count));
    const mo = cols && cols.length ? iconMoments(img.data, img.width, img.height, cols, tol, b.px, b.py, r) : (b.idx ? momentsOf([...b.idx].map((i: number) => [(i % img.width) + 0.5, Math.floor(i / img.width) + 0.5])) : null);
    const hd = momentHeading(mo);
    return { x: mo ? mo.cx : b.px, y: mo ? mo.cy : b.py, angle: hd ? hd.angle : null, source: hd ? 'icon' : null, score: null };
  }

  // The mower picture (auto-detected or set in the Mower tab) as a match template; loaded once per
  // entity picture. -> template or null (not set / still loading)
  _mowerTemplate(): HeadingTemplate | null {
    const cfg = this.card._layout && this.card._layout.mower;
    const auto = cfg && this.mowerAuto(cfg, true);
    const eid = auto && auto.picture;
    const url = eid && overlayUrl(this.card._hass, eid, 0);
    if (!url) return null;
    const key = `${eid}|${(this.card._hass.states[eid!].attributes || {}).entity_picture || ''}`; // url: eid set
    if (this._tpl && this._tpl.key === key) return this._tpl.t;
    if (this._tplLoading === key) return null;
    this._tplLoading = key;
    readImagePixels(url).then((px: ImagePixels) => {
      this._tpl = { key, t: makeTemplate(px.data, px.width, px.height) };
      this._tplCache = new Map();
      this._tplLoading = null;
      if (this.card._view && this.card._view.mapPlane) this.card._view.reprocessMap();
    }, (e: unknown) => { console.warn('floorplan3d: could not read the mower picture', e); this._tplLoading = null; this._tpl = { key, t: null }; });
    return null;
  }

  // Icon heading (image degrees, counter-clockwise from the picture's right) -> plan heading, smoothed;
  // null: none this time (movement decides). source: 'picture' | 'icon'.
  _setIconHeading(angle: number | null | undefined, source: string | null = null): void {
    if (angle === null || angle === undefined) { this._iconHead = null; return; }
    const cfg = this.card._layout!.mower!; // detection runs for a configured mower
    const off = Number((cfg.image || {}).front_offset) || 0;
    this._iconHeadRaw = angle;
    const st = (this._headSt = smoothHeading(this._headSt, norm360(angle + off + ((cfg.overlay && cfg.overlay.rotation) || 0))));
    this._iconHead = st && st.angle !== null ? { angle: st.angle, source } : null;
  }

  // Docked with a mower and a dock object: { mower, dock } ids (one object for taps, dots and the popup), else null.
  _dockGroup(): ReturnType<typeof mowerDockGroup> | null {
    const l = this.card._objects;
    if (!l || !l.model || !this.card._hass) return null;
    const mowerId = l.mowerId();
    if (!mowerId) return null;
    return mowerDockGroup({ docked: this._dockedNow().docked, mowerId, dockId: l.dockId() });
  }

  // The mower's docked state: lawn_mower docked / charging or its "Mower status" sensor. -> { docked, word }
  _dockedNow(): { docked: boolean; word: ReturnType<typeof dockWord> } {
    const h = this.card._hass, mse = this._mowerStateEntity();
    const ms = mse && h && h.states[mse];
    const se = mse && findStatusEntity(h, mse), ss = se && h.states[se];
    const a = ms && ms.state, b = ss && ss.state;
    return { docked: isDocked(a, b), word: dockWord(a, b) };
  }

  // Mower tab status: { kind: dock | tracked | last | mismatch | searching | none, word, score, lostMs } or null.
  mowerStatus(): MowerStatus | null {
    const cfg = this.card._layout && this.card._layout.mower;
    if (!cfg || !cfg.entity || !this.card._hass) return null;
    const at = this._mowerAt;
    if (at === 'dock') return { kind: 'dock', word: this._dockedNow().word };
    if (cfg.source === 'image' && this.mowerAuto(cfg) && this._autoMismatch && !colorList(cfg.image).length) return { kind: 'mismatch' };
    const lost = (): number | null => { const at = this._trk && this._trk.seenAt; return at !== undefined && Number.isFinite(at) ? Date.now() - at : null; };
    if (cfg.source === 'image') {
      const r = this._imageResult, b = this._imageBlob;
      if (at === 'last' || (r && r.missing && b) || (b && b.misses)) return { kind: 'last', lostMs: lost() };
      if (r && !r.missing && !r.error && b) return { kind: 'tracked', score: typeof r.match === 'number' && Number.isFinite(r.match) ? r.match : null };
      if (at === 'dock-start') return { kind: 'last', lostMs: null };
      return { kind: 'searching' };
    }
    if (at === 'last' || at === 'dock-start') return { kind: 'last', lostMs: null };
    return null;
  }

  mowerStatusText(): ReturnType<typeof mowerStatusText> {
    return mowerStatusText(this.mowerStatus());
  }

  // Heading shown in the Mower tab: { deg (compass bearing on the plan), source } or null.
  mowerHeading(): { deg: number; source: string } | null {
    if (this._mowerHeading === undefined || this._mowerHeading === null) return null;
    const deg = (this._mowerHeading * 180) / Math.PI;
    return { deg: Math.round(norm360(90 - deg)), source: this._headingSource || 'movement' };
  }

  // ---------- auto mode: the live map processed off the main thread ----------
  // Each refresh: fetch -> createImageBitmap (decoded off the main thread) -> transferred to the map
  // worker, which draws and reads it, compares it with the static map, searches the mower in a window
  // around its last position (the whole picture when lost, after docking / undocking, every 60 s) and
  // redraws the layer (mowed / no-mow) every 60 s or on a progress change, changed 64 px tiles only.
  // The page draws the changed tiles into one canvas (one texture upload per batch).
  _pumpMap(): void {
    if (this._mapPump) { this._mapPumpAgain = true; return; }
    this._mapPump = (async () => {
      try {
        do {
          this._mapPumpAgain = false;
          await this._mapFrame(this._extUrl);
        } while (this._mapPumpAgain && this.card.isConnected);
      } catch (e) {
        console.warn('floorplan3d: could not process the mower map', e);
      } finally {
        this._mapPump = null;
      }
    })();
  }

  async _fetchBlob(url: string): Promise<Blob> {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: ctl ? ctl.signal : undefined });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.blob();
    } finally {
      clearTimeout(timer ?? undefined);
    }
  }

  // The static map (cached blob and size per picture). -> { key (per working size), blob, natW, natH }
  async _staticMap(eid: string | null): Promise<NonNullable<MowerController['_static']> | null> {
    const st = eid ? this.card._hass.states[eid] : undefined;
    const url = st && overlayUrl(this.card._hass, eid, 0);
    if (!url || !st) return null;
    const key = `${eid}|${(st.attributes || {}).entity_picture || ''}|${st.state}`;
    if (this._static && this._static.key === key) return this._static;
    const blob = await this._fetchBlob(url);
    const bmp = await createImageBitmap(blob);
    this._static = { key, blob, natW: bmp.width, natH: bmp.height };
    if (bmp.close) bmp.close();
    return this._static;
  }

  async _mapFrame(url: string | null | undefined): Promise<void> {
    const cfg = this.card._layout && this.card._layout.mower;
    const auto = cfg && this.mowerAuto(cfg);
    if (!url || !cfg || !auto || !this.card.isConnected || !this.card._view) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { this._extUrl = null; return; } // again when visible
    const t0 = performance.now();
    const perf: { decode: number; worker: number; apply: number; main: number; max: number; sections: [number, number][]; pass?: unknown } = { decode: 0, worker: 0, apply: 0, main: 0, max: 0, sections: [] };
    let mark = t0;
    const end = (): void => { const n = performance.now(), d = n - mark; perf.main += d; perf.max = Math.max(perf.max, d); perf.sections.push([mark, n]); };
    const resume = (): void => { mark = performance.now(); };
    let blob: Blob, live: ImageBitmap | undefined, stat: Awaited<ReturnType<MowerController['_staticMap']>>;
    try {
      end();
      blob = await this._fetchBlob(url);
      resume();
      end();
      live = await createImageBitmap(blob);
      resume();
      end();
      stat = await this._staticMap(auto.static);
      resume();
    } catch (e) {
      if (live && live.close) live.close();
      console.warn('floorplan3d: could not read the mower map', e);
      if (cfg.source === 'image') this._imageResult = { error: "Can't read the map image." };
      return;
    }
    perf.decode = performance.now() - t0;
    const W = live.width, H = live.height;
    if (!stat || !W || !H) { if (live.close) live.close(); return; }
    const { width: w, height: h } = mapWorkSize(W, H);
    if (Math.abs(stat.natW / stat.natH - W / H) > 0.02 * (W / H)) { // another picture: colour picks
      this._setAutoMismatch(true);
      end();
      await this._mismatchPass(live, W, H);
      return;
    }
    const proc = (this._mapProc = this._mapProc || new MapProcessor());
    const now = Date.now();
    const statKey = `${stat.key}|${w}x${h}`;
    const ctx = this._frameContext(cfg, W, H, w, h, now);
    let statArg: { key: string; bitmap: ImageBitmap } | null = null;
    if (!proc.hasStatic(statKey)) {
      end();
      try { statArg = { key: statKey, bitmap: await createImageBitmap(stat.blob) }; } catch (e) { if (live.close) live.close(); return; }
      resume();
    }
    const tpl = ctx.detect ? this._mowerTemplate() : null;
    const tw = performance.now();
    end();
    let r;
    try {
      r = await proc.frame(live, statArg, w, h, tpl ? { key: this._tpl!.key, t: tpl } : null, { ...ctx, statKey }); // tpl: from _tpl
    } catch (e: unknown) {
      const err = e as { disposed?: boolean; restart?: boolean } | null; // the worker's rejection
      if (!(err && (err.disposed || err.restart))) console.warn('floorplan3d: could not process the mower map', e);
      if (err && err.restart) this._extUrl = null; // the static map goes along next time
      return;
    }
    resume();
    perf.worker = performance.now() - tw;
    if (!this.card._layout || this.card._layout.mower !== cfg || !this.card._view) return; // settings changed meanwhile
    const ta = performance.now();
    this._applyFrame(r, cfg, { W, H, w, h, now, ctx, blob });
    perf.apply = performance.now() - ta;
    end();
    perf.main += r.main || 0; // the pass itself when it ran here (no worker)
    perf.max = Math.max(perf.max, r.main || 0);
    perf.pass = r.ms;
    this._recordMapPerf(perf);
  }

  _trackState(): TrackState {
    return (this._trk = this._trk || { docked: null, leaving: false, lastFull: undefined, layerAt: undefined, progress: undefined, lastAt: undefined, seenAt: undefined });
  }

  // framePass context from the tracking state: search window, full search, layer due, dock.
  _frameContext(cfg: LayoutMower, W: number, H: number, w: number, h: number, now: number): CardFrameContext {
    const trk = this._trackState();
    const k = W / w;
    const dk = this._dockedNow();
    const dockChanged = trk.docked !== null && trk.docked !== dk.docked;
    if (trk.docked !== null && trk.docked && !dk.docked) { trk.leaving = true; trk.leavingSince = now; }
    if (trk.docked === null && !dk.docked && !this._imageBlob && !lastPosition(this.card._config.layout_key)) { trk.leaving = true; trk.leavingSince = now; } // unknown: from the dock
    if (dk.docked) trk.leaving = false;
    if (trk.leaving && now - (trk.leavingSince ?? now) > 5 * 60000) trk.leaving = false; // leaving: since set with it
    trk.docked = dk.docked;
    // with a mower picture, wait for it (a shape guess before it loads may lock onto anything)
    const picture = this.mowerAuto(cfg, true);
    const tplWait = !!(picture && picture.picture) && !this._mowerTemplate() && !(this._tpl && this._tpl.t === null && this._tplLoading !== this._tpl.key);
    const detect = cfg.source === 'image' && !dk.docked && !tplWait;
    const tplKey = this._tpl && this._tpl.t ? this._tpl.key : null;
    const tplChanged = trk.tplKey !== tplKey;
    trk.tplKey = tplKey;
    const b = this._imageBlob;
    let prev: number[] | null = b && b.imgW === W ? [b.px / k, b.py / k] : null;
    const last = lastPosition(this.card._config.layout_key);
    const expected: number | null = b && b.count && b.matched ? b.count / (k * k) : last && last.count && last.imgW === W ? last.count / (k * k) : null;
    let dockAt: number[] | null = this._dockPx ? [this._dockPx.px / k, this._dockPx.py / k] : null;
    if (!dockAt && cfg.overlay) {
      const d = this.card._objects && this.card._objects.dockPose();
      if (d) { const q = planToPixel(d.x, d.y, W, H, cfg.overlay); dockAt = [q.px / k, q.py / k]; }
    }
    if (trk.leaving && dockAt && (!prev || dockChanged)) prev = dockAt.slice();
    const missed = !!(this._imageResult && this._imageResult.missing);
    const full = fullSearch({ tracked: !!prev, missed, dockChanged: dockChanged || tplChanged || !!this._forceFull, now, lastFull: trk.lastFull });
    this._forceFull = false;
    const ppm = w / Math.max(0.1, Number(cfg.overlay && cfg.overlay.width) || 20);
    const win = !full && prev ? trackWindow({ px: prev[0], py: prev[1], size: Math.sqrt(expected || (b && b.count ? b.count / (k * k) : 64)) },
      { dt: trk.lastAt ? (now - trk.lastAt) / 1000 : this._mapRefreshSec(), ppm, w, h }) : null;
    const prog = findProgress(this.card._hass, this._mowerStateEntity());
    const pv = prog ? progressValue(this.card._hass, prog) : null;
    const layer = layerDue({ now, lastAt: trk.layerAt, progress: pv, lastProgress: trk.progress });
    return {
      detect, full: full || !win, window: win, layer, prev, expected, leaving: trk.leaving && detect,
      prevGrey: this._autoGrey || null, dockAt, maxBlob: Math.max(400, w * h * 0.02), progress: pv,
    };
  }

  // A refresh's result into the picture and the tracking state (main thread: small, no pixel reads).
  _applyFrame(r: Awaited<ReturnType<MapProcessor['frame']>>, cfg: LayoutMower, { W, H, w, h, now, ctx, blob }: { W: number; H: number; w: number; h: number; now: number; ctx: CardFrameContext; blob: Blob }): void {
    const trk = this._trk!; // set by _frameContext before the frame
    trk.lastAt = now;
    if (r.full) trk.lastFull = now;
    if (ctx.layer) { trk.layerAt = now; trk.progress = ctx.progress; }
    // changed tiles into the canvas, one texture upload
    const c = (this._autoCanvas = this._autoCanvas || document.createElement('canvas'));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    if (r.patches) {
      const g = c.getContext('2d', { willReadFrequently: true })!; // CPU-side: tiles written, uploaded once
      let o = 0;
      for (const [x0, y0, x1, y1] of r.patches.rects) {
        const tw = x1 - x0, th = y1 - y0, len = tw * th * 4;
        g.putImageData(new ImageData(new Uint8ClampedArray(r.patches.data.buffer, r.patches.data.byteOffset + o, len), tw, th), x0, y0);
        o += len;
      }
    }
    if (r.mismatch) {
      this._setAutoMismatch(true);
      this._mismatchBlob = blob; // the colour picks run on it
      this._mismatchPassFromBlob(blob);
      return;
    }
    this._setAutoMismatch(false);
    const showsOther = this.card._view.mapPlane && this.card._view.mapPlane.material.map && this.card._view.mapPlane.material.map.image !== c;
    const ld = this.card._view.mapPlane && this.card._view.mapPlane.userData.loaded;
    if (r.patches || showsOther || !ld || (this.card._editing && !ld.image)) { // edit mode: the raw picture for the pickers
      if (this.card._editing) createImageBitmap(blob).then((img) => { if (this.card._view) this.card._view.setMapCanvas(c, W, H, { image: img }); }, () => { if (this.card._view) this.card._view.setMapCanvas(c, W, H); });
      else this.card._view.setMapCanvas(c, W, H);
    }
    const was = this._mapStats;
    this._mapStats = { zone: null, angle: r.angle, share: r.share, auto: true };
    if (!was || was.angle !== r.angle || was.share !== r.share) this._mapStatsChanged();
    if (!ctx.detect) { // docked (or the position comes from elsewhere): the picture only
      if (cfg.source === 'image') this._queueMowerRefresh();
      return;
    }
    this._lastFrame = { full: r.full, window: ctx.window, same: r.same, leaving: ctx.leaving }; // headless checks
    if (r.same) return; // nothing changed since the last detection
    if (r.grey !== undefined) this._autoGrey = r.grey;
    const before = this._imageBlob;
    this._autoApply(r, { imgW: W, imgH: H, width: w });
    const b = this._imageBlob;
    if (r.pose) trk.seenAt = now;
    // moved away from the dock: an ordinary track again
    if (trk.leaving && r.pose && ctx.dockAt && Math.hypot(r.pose.px - ctx.dockAt[0], r.pose.py - ctx.dockAt[1]) > 2.5 * Math.sqrt(r.pose.count || 64)) trk.leaving = false;
    if (!before || !b || before.px !== b.px || before.py !== b.py || before.misses !== b.misses) this._queueMowerRefresh();
    else if (this.card._editing && this.card._edit) this.card._edit.onStates();
  }

  _queueMowerRefresh(): void {
    if (this._mowerRefreshQueued) return;
    this._mowerRefreshQueued = true;
    queueMicrotask(() => {
      this._mowerRefreshQueued = false;
      if (!this.card._view || !this.card._layout || !this.card._layout.mower) return;
      this._refreshMower();
      if (this.card._editing && this.card._edit) this.card._edit.onStates();
    });
  }

  // The static map does not match this picture: the colour picks (or the picture as loaded) on it.
  async _mismatchPassFromBlob(blob: Blob): Promise<void> {
    try { const bmp = await createImageBitmap(blob); const W = bmp.width, H = bmp.height; await this._mismatchPass(bmp, W, H); } catch (e) { /* next refresh */ }
  }

  async _mismatchPass(bmp: ImageBitmap, W: number, H: number): Promise<void> {
    let r: Awaited<ReturnType<MowerController['_onMapImage']>>;
    try { r = await this._onMapImage(bmp, W, H); } catch (e) { r = undefined; }
    if (!this.card._view) return;
    const plane = this.card._view.mapPlane;
    if (r && r.canvas) this.card._view.setMapCanvas(r.canvas, W, H, { image: this.card._editing ? bmp : null });
    else if (r === null) { // as loaded
      const { width: w, height: h } = mapWorkSize(W, H);
      const c = (this._rawCanvas = this._rawCanvas || document.createElement('canvas'));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const g = c.getContext('2d', { willReadFrequently: true })!; // CPU-side: tiles written, uploaded once
      g.clearRect(0, 0, w, h);
      g.drawImage(bmp, 0, 0, w, h);
      this.card._view.setMapCanvas(c, W, H, { image: this.card._editing ? bmp : null });
    }
    if (!this.card._editing && bmp.close && !(plane && plane.userData.loaded && plane.userData.loaded.image === bmp)) bmp.close();
  }

  _mapRefreshSec(): number {
    const o = this.card._layout && this.card._layout.mower && this.card._layout.mower.overlay;
    return Math.max(1, Number(o && o.refresh) || 10);
  }

  // Timing of a refresh (debug overlay, adaptive throttle, headless checks).
  _recordMapPerf(perf: { main: number; max: number; decode: number; worker: number; apply: number; pass?: unknown; sections: [number, number][] }): void {
    const p: MapPerf = (this._perf = this._perf || { last: null });
    p.last = { main: perf.main, max: perf.max, decode: perf.decode, worker: perf.worker, apply: perf.apply, pass: perf.pass, at: performance.now() };
    // a long task of the page during one of this refresh's own sections counts as the map's
    const longTask = perf.max > LONG_TASK_MS || (this.card._longs || []).some((e) => perf.sections.some(([a, b]) => e.start < b && e.start + e.ms > a));
    const base = this._mapRefreshSec();
    const was = this._throttle ? this._throttle.factor : 1;
    this._throttle = throttleStep(this._throttle, { now: Date.now(), longTask, base });
    if (this._throttle.factor !== was) this._refreshMapOverlay(); // the camera timer at the new interval
  }

  _setAutoMismatch(on: boolean): void {
    if (!!this._autoMismatch === on) return;
    this._autoMismatch = on;
    if (this.card._editing && this.card._edit) this.card._edit.onStates();
  }

  // An auto pass's mower pose (working pixels) -> the tracked blob, heading and dock (image pixels).
  _autoApply(r: { pose?: { px: number; py: number; count: number; score?: number | null; angle?: number | null; source?: string | null } | null; dock?: number[] | null }, px: { imgW: number; imgH: number; width: number }): void {
    const k = px.imgW / px.width;
    const pose = r.pose;
    if (!pose) {
      this._imageResult = { missing: true };
      this._setIconHeading(null);
      if (this._imageBlob) this._imageBlob = { ...this._imageBlob, misses: (this._imageBlob.misses || 0) + 1 };
      return;
    }
    this._imageBlob = { px: pose.px * k, py: pose.py * k, count: pose.count * k * k, misses: 0, imgW: px.imgW, imgH: px.imgH, sampleW: px.width, colors: [], matched: pose.score != null };
    this._imageResult = { count: pose.count, match: pose.score };
    this._setIconHeading(pose.angle, pose.source);
    if (r.dock !== undefined) this._dockPx = r.dock ? { px: r.dock[0] * k, py: r.dock[1] * k } : null; // full searches only
  }

  _setImageTimer(seconds: number): void {
    if (!this.card.isConnected) seconds = 0;
    if (this._imageTimerSec === seconds) return;
    clearInterval(this._imageTimer ?? undefined);
    this._imageTimerSec = seconds;
    this._imageTimer = seconds ? setInterval(() => this._detectMower(), seconds * 1000) : null;
  }

  // The mower icon is looked for on the overlay's own picture (no separate image entity); auto mode
  // always works on it.
  _mapDriven(cfg: LayoutMower | null | undefined): boolean {
    if (cfg && cfg.source === 'image' && this.mowerAuto(cfg) && !this._autoMismatch) return true;
    const ic = cfg && cfg.source === 'image' && cfg.image;
    const o = cfg && cfg.overlay;
    return !!(ic && colorList(ic).length && o && o.entity && (!ic.entity || ic.entity === o.entity));
  }

  // Auto mode entities: { live, static, picture } when the live map (overlay) and a static map exist
  // and it is not switched off (mower.auto === false); entities set in the Mower tab win over the
  // auto-detected ones ('' = none). -> object or null. detected: also when switched off.
  mowerAuto(cfg: LayoutMower | null | undefined = this.card._layout && this.card._layout.mower, detected = false): AutoEntities | null {
    const h = this.card._hass;
    const live = cfg && cfg.overlay && cfg.overlay.entity;
    if (!h || !cfg || !live) return null;
    const pick = (v: string | null | undefined, find: () => string | null): string | null => (v !== undefined && v !== null ? v || null : find());
    const stat = pick(cfg.static_entity, () => findStaticMap(h, live, cfg.entity));
    const picture = pick(cfg.picture_entity, () => findMowerPicture(h, live, cfg.entity));
    const r: AutoEntities = { live, static: stat && h.states[stat] ? stat : null, picture: picture && h.states[picture] ? picture : null };
    if (detected) return r;
    return r.static && cfg.auto !== false ? r : null;
  }

  // Find the icon colour in sampled pixels (imagePixels / readImagePixels), track it, store the pixel.
  // -> { result, found } (found: the blob seen in this picture, image pixels)
  _detectOn(img: ImagePixels, ic: MowerImage): { result: ImageResult; found: ImageBlob | null } {
    const k = img.imgW / img.width; // sampled canvas -> image pixels
    const old = this._imageBlob;
    const cols = colorList(ic);
    const sameColor = !!old && JSON.stringify(old.colors) === JSON.stringify(cols);
    // the picture may change size between refreshes: the track scales with it (same geometry)
    const rs = sameColor && old.imgW > 0 ? img.imgW / old.imgW : 1;
    const track = sameColor && old ? { px: (old.px * rs) / k, py: (old.py * rs) / k, count: old.count == null ? null : (old.count * rs * rs) / (k * k), misses: old.misses || 0 } : null;
    const b = findBlob(img.data, img.width, img.height, cols, ic.tolerance ?? 40, { minPixels: ic.min_pixels ?? 4, prev: track });
    const step = stepTrack(track, b);
    if (step.found && b) { // found: b is the new track
      // refined centre and the icon's heading: its picture (when set) or its shape
      const pose = this._iconPose(img, b, cols, ic.tolerance ?? 40);
      this._trackState().seenAt = Date.now();
      const found: ImageBlob = (this._imageBlob = { px: pose.x * k, py: pose.y * k, count: b.count * k * k, misses: 0, imgW: img.imgW, imgH: img.imgH, sampleW: img.width, colors: cols });
      this._setIconHeading(pose.angle, pose.source);
      return { result: { count: b.count, match: pose.score }, found };
    }
    this._setIconHeading(null);
    if (!sameColor || !old || !step.track) this._imageBlob = null; // a stale position of another colour would mislead (same colour: tracked)
    else if (rs !== 1) { // last known position and count, in this picture's pixels
      this._imageBlob = { ...old, px: old.px * rs, py: old.py * rs, count: old.count == null ? null : old.count * rs * rs, imgW: img.imgW, imgH: img.imgH, sampleW: img.width, misses: step.track.misses };
    } else this._imageBlob = { ...old, misses: step.track.misses }; // last known position, count kept
    return { result: { missing: true }, found: null };
  }

  // Read the map image (a separate image entity), find the icon colour, store the pixel. Async
  // (fetch + createImageBitmap), one run at a time; skipped while disconnected or the tab is hidden.
  async _detectMower(): Promise<void> {
    if (!this.card.isConnected || !this.card._hass || !this.card._layout) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (this._imageBusy) { this._imageAgain = true; return; }
    const cfg = this.card._layout.mower;
    const ic = (cfg && cfg.source === 'image' && cfg.image) || null;
    const entity = ic && (ic.entity || (cfg!.overlay && cfg!.overlay.entity)); // ic: from cfg
    if (!ic || !colorList(ic).length || !entity || this._mapDriven(cfg)) return;
    const url = overlayUrl(this.card._hass, entity, Date.now());
    if (!url) return;
    this._imageBusy = true;
    let result: ImageResult;
    try {
      result = this._detectOn(await readImagePixels(url), ic).result;
    } catch (e) {
      console.warn('floorplan3d: could not read the mower map image', e);
      result = { error: "Can't read the map image." };
    } finally {
      this._imageBusy = false;
    }
    const now = this.card._layout && this.card._layout.mower;
    if (!now || now.source !== 'image') return;
    this._imageResult = result;
    if (this.card._view) this._refreshMower();
    if (this.card._editing && this.card._edit) this.card._edit.onStates();
    if (this._imageAgain) {
      this._imageAgain = false;
      this._detectMower();
    }
  }

  // A bound mower object follows the live position; heading from the last real movement (> 5 cm;
  // image source: > max(0.25 m, 3 map pixels), so detection noise never turns it).
  // fixed: { heading } of the dock / the last known pose (no heading from movement or the icon).
  _poseMowerObject(p: number[] | null, floorId: string, fixed: { heading?: number | null } | null = null): void {
    const layer = this.card._objects;
    if (!layer || !layer.mowerBound()) { this._mowerHeadFrom = null; layer?.setMowerPose(null); return; }
    if (!p) return;
    const from = this._mowerHeadFrom;
    const m = this.card._layout && this.card._layout.mower;
    const icon = m && m.source === 'image' ? this._iconHead : null;
    if (fixed) {
      if (typeof fixed.heading === 'number' && Number.isFinite(fixed.heading)) { this._mowerHeading = fixed.heading; this._headingSource = this._mowerAt === 'last' ? this._headingSource : 'dock'; }
      this._mowerHeadFrom = [p[0], p[1]];
    } else if (icon) { // read from the icon itself
      this._mowerHeading = (icon.angle * Math.PI) / 180;
      this._headingSource = icon.source;
      this._mowerHeadFrom = [p[0], p[1]];
    } else if (!from) this._mowerHeadFrom = [p[0], p[1]];
    else if (Math.hypot(p[0] - from[0], p[1] - from[1]) > this._headingStep()) {
      this._mowerHeading = Math.atan2(p[1] - from[1], p[0] - from[0]);
      this._headingSource = 'movement';
      this._mowerHeadFrom = [p[0], p[1]];
    }
    layer.setMowerPose({ x: p[0], y: p[1], floorId, heading: this._mowerHeading, ground: this.card._view.mowerGround(p[0], p[1], floorId) });
  }

  // Mower marker height above its HA floor: MOWER_Z over the ground under it (the lawn of the model,
  // cached per 0.5 m cell), so a garden floor at an odd elevation does not lift it off the lawn.
  _mowerZ(x: number, y: number, floorId: string): number {
    const g = this.card._view.mowerGround(x, y, floorId);
    return g === null ? MOWER_Z : g - this.card._view.floorElevation(floorId) + MOWER_Z;
  }

  _headingStep(): number {
    const m = this.card._layout && this.card._layout.mower, b = this._imageBlob;
    return headingMinStep(m && m.source, m && m.overlay && m.overlay.width, b && b.sampleW);
  }

  // One pass per loaded map picture (view.onMapImage): a single readback at working size, mower
  // detection on it (when the icon is on the overlay's own picture; a new picture only, re-runs on the
  // same picture reuse that result), then the processed picture (transparent background, mowed stripes,
  // shaded no-mow, hidden icon, zone clip; in a worker where possible) and its statistics.
  // -> Promise of { canvas, width, height } | null (draw as loaded) | undefined (keep what is shown)
  async _onMapImage(image: CanvasImageSource, W: number, H: number): Promise<MapImageResult> {
    const cfg = this.card._layout && this.card._layout.mower;
    const o = cfg && cfg.overlay;
    if (!cfg || !o || !W || !H) return null;
    if (!this.mowerAuto(cfg)) this._setAutoMismatch(false); // auto mode: _mapFrame (this runs on a mismatch)
    // colour picks (also when the static map does not match this picture)
    const driven = this._mapDriven(cfg) && colorList(cfg.image).length > 0;
    const pre = this._mapSettings(o, null);
    const wantIcon = driven && o.hide_icon !== false;
    if (!driven && !pre) {
      if (this._mapStats) { this._mapStats = null; this._mapStatsChanged(); }
      return null;
    }
    const proc = (this._mapProc = this._mapProc || new MapProcessor());
    const px = proc.read(image, W, H);
    let blob: ImageBlob | null = null;
    if (driven) {
      const ic = cfg.image!; // driven: colour picks on cfg.image
      const dkey = [JSON.stringify(colorList(ic)), ic.tolerance, ic.min_pixels].join('|');
      const last = this._mapDetect;
      if (last && last.image === image && last.key === dkey) {
        blob = last.found; // same picture, same settings: not a new sighting / miss
      } else {
        const d = this._detectOn(px, ic);
        blob = d.found;
        this._mapDetect = { image, key: dkey, found: d.found };
        this._imageResult = d.result;
        this._queueMowerRefresh();
      }
    }
    const s = wantIcon && blob ? this._mapSettings(o, blob) : pre;
    if (!s) {
      if (this._mapStats) { this._mapStats = null; this._mapStatsChanged(); }
      return null;
    }
    let r;
    try {
      r = await proc.process(px, s);
    } catch (e) {
      console.warn('floorplan3d: could not process the mower map', e);
      return undefined;
    }
    const was = this._mapStats;
    this._mapStats = { zone: s.zoneId || null, angle: s.mowed ? r.angle : null, share: s.mowed ? mowedShare(r) : null };
    if (!was || was.angle !== this._mapStats.angle || was.share !== this._mapStats.share) this._mapStatsChanged();
    return r;
  }

  // Process the loaded picture again after a settings change; 150 ms debounce (slider drags).
  _reprocessMap(): void {
    clearTimeout(this._mapReprocTimer);
    this._mapReprocTimer = setTimeout(() => { if (this.card._view) this.card._view.reprocessMap(); }, 150);
  }

  _mapStatsChanged(): void {
    if (this.card._popup) this.card._popup.update();
    if (this.card._editing && this.card._edit) this.card._edit.onStates();
  }

  // Processing settings of the overlay (null: none set, the picture is drawn as loaded).
  // blob: the mower icon found in this very picture (image pixels) or null.
  _mapSettings(o: MowerOverlay, blob: ImageBlob | null) {
    const col = (kind: 'bg' | 'mowed' | 'nomow') => { const c = colorList(o, kind); return c.length ? { colors: c, tolerance: Number(o[`${kind}_tolerance`] ?? 30) } : null; };
    const bg = col('bg'), mowed = col('mowed'), nomow = col('nomow');
    const ic: MowerImage = this.card._layout!.mower!.image || {}; // the overlay belongs to layout.mower
    const iconBlob = blob && o.hide_icon !== false ? { px: blob.px, py: blob.py, count: blob.count, colors: colorList(ic), tolerance: ic.tolerance ?? 40 } : null;
    const explicitZone = !!o.zone && o.zone !== 'auto' && o.zone !== 'none';
    if (!bg && !mowed && !nomow && !iconBlob && !explicitZone) return null;
    const zone = this.mapZone(o);
    return { bg, mowed, nomow, iconBlob, dilate: 3, zone: zone ? zone.polygon : null, zoneId: zone ? zone.id : null, overlay: o };
  }

  // Zone the map is clipped to: overlay.zone = a zone id, 'none', or unset / 'auto' = the zone
  // (model room / outdoor outline) containing the overlay centre, the smallest one.
  mapZone(o: MowerOverlay | null | undefined): Zone | null {
    const zones = this.card._zones || [];
    if (!o || o.zone === 'none') return null;
    if (o.zone && o.zone !== 'auto') return zones.find((z) => z.id === o.zone) || null;
    const c: [number, number] = [Number(o.x) || 0, Number(o.y) || 0];
    let best: Zone | null = null, area = Infinity;
    for (const z of zones) {
      if (!pointInPolygon(c, z.polygon)) continue;
      const a = Math.abs(signedArea(z.polygon));
      if (a < area) { area = a; best = z; }
    }
    return best;
  }

  // "Stripes" / "Mowed" texts from the last processed map (null each when unknown).
  mapInfo(): { stripes: string | null; mowed: string | null; mowedSource?: string | null } {
    const st = this._mapStats, o = this.card._layout && this.card._layout.mower && this.card._layout.mower.overlay;
    // a progress sensor of the mower's device wins over the map estimate
    const prog = this.card._layout && this.card._layout.mower && this.card._layout.mower.entity ? findProgress(this.card._hass, this._mowerStateEntity()) : null;
    const pv = prog ? progressValue(this.card._hass, prog) : null;
    if (pv !== null) {
      const base = st && o ? this._mapInfoBase(st, o) : { stripes: null };
      return { ...base, mowed: `${Math.round(pv * 100)} %`, mowedSource: 'progress sensor' };
    }
    if (!st || !o) return { stripes: null, mowed: null };
    return { ...this._mapInfoBase(st, o), mowedSource: st.share != null ? 'map estimate' : null };
  }

  _mapInfoBase(st: MapStats, o: MowerOverlay): { stripes: string | null; mowed: string | null } {
    // against true north: the model's north and alignment rotation, as the sky uses them
    const m = this.card._view && this.card._view.model;
    const b = st.angle != null ? stripeBearing(st.angle, o.rotation, m ? m.north || 0 : 0, m ? this.card._modelAlign().rotation || 0 : 0) : null;
    return {
      stripes: b ? `${b.bearing}° (${b.label})` : null,
      mowed: st.share != null ? `${Math.round(st.share * 100)} %` : null,
    };
  }

  _refreshMapOverlay(): void {
    const cfg = this.card._layout!.mower; // callers check the layout
    const o = cfg && cfg.overlay;
    const st = o && o.entity && this.card._hass.states[o.entity];
    if (!st || !cfg || !o || !o.entity) {
      this.card._view.setMapOverlay(null);
      this._setCameraTimer(0);
      this._mapProcKey = null;
      return;
    }
    const camera = o.entity.startsWith('camera.');
    const external = !!this.mowerAuto(cfg); // auto mode: decoded and processed off the main thread
    // the adaptive throttle stretches the interval of auto mode (long tasks from the map)
    this._setCameraTimer(camera ? (external ? effectiveRefresh(this._mapRefreshSec(), this._throttle) : Math.max(1, Number(o.refresh) || 10)) : 0);
    // image entities change their state when the picture changes; cameras are polled
    const bust = camera ? this._cameraTick || 1 : st.last_updated || st.state;
    const url = overlayUrl(this.card._hass, o.entity, bust);
    this.card._view.setMapOverlay({
      url: external ? `fp-auto:${o.entity}` : url, external,
      x: o.x, y: o.y, rotation: o.rotation, width: o.width, opacity: o.opacity,
      floorId: this._mowerFloor(), heightOffset: o.height_offset || 0,
      hidden: !!o.edit_only && !this.card._editing, // detection keeps reading the loaded image
    });
    if (!external) this._extUrl = null;
    else if (url !== this._extUrl) {
      this._extUrl = url;
      this._pumpMap();
    }
    // processing settings (and the alignment, which moves the zone clip) changed: process the
    // loaded picture again
    // the alignment only matters to a zone clip (it moves the clip over the picture)
    const z = this.mapZone(o);
    const pk = JSON.stringify([colorList(o, 'bg'), o.bg_tolerance, colorList(o, 'mowed'), o.mowed_tolerance, colorList(o, 'nomow'), o.nomow_tolerance,
      o.hide_icon, o.zone, z && z.id, z && z.polygon, ...(z ? [o.x, o.y, o.rotation, o.width] : [])]);
    if (pk !== this._mapProcKey) {
      const first = this._mapProcKey == null;
      this._mapProcKey = pk;
      if (!first) this._reprocessMap();
    }
  }

  _setCameraTimer(seconds: number): void {
    if (!this.card.isConnected) seconds = 0; // async callers after a disconnect; connectedCallback re-arms
    if (this._cameraTimerSec === seconds) return;
    clearInterval(this._cameraTimer ?? undefined);
    this._cameraTimerSec = seconds;
    this._cameraTimer = seconds ? setInterval(() => {
      this._cameraTick = Date.now();
      this._refreshMapOverlay();
    }, seconds * 1000) : null;
  }
}
