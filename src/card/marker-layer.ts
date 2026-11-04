// Device markers of the card: built from the registry, positioned (auto, pins, attached, the live
// mower), their DOM element and gestures, state refresh (icons, values, badges, light glows) and the
// move of auto-placed markers onto the model's surfaces. _buildMarkers replaces the _positions Map:
// other parts read card._positions each time, never keep it.

import { buildMarkers, isActive, iconFor, markerLook, displayValue, pictureKey } from '../registry.js';
import { markerPositions, lightGlow } from '../layout.js';
import { surfaceKind, surfaceKey, surfaceSearch, worldOf, nearPolygon, chooseSurface, planOf } from '../surface.js';
import { attachedPosition } from '../objects/logic.js';
import { badgeOptions, badgeInfo } from '../badges.js';
import { applyBadges } from '../badge-dom.js';
import { LONG_PRESS_MS, CLICK_SLOP_PX } from './constants.js';
import type { Floorplan3dCard } from '../floorplan3d-card.js';
import type { LayoutPin } from '../types/layout.js';

/** A device / entity marker (registry.js buildMarkers). */
export type Marker = ReturnType<typeof buildMarkers>[number];

/** Plan point (metres) with its height above the floor. */
export interface PlanXYZ {
  x: number;
  y: number;
  z: number;
}

/** Where a marker stands: auto placed, pinned, attached to a model object, or the live mower. */
export interface MarkerPosition extends PlanXYZ {
  floorId: string;
  auto?: boolean;
  live?: boolean;
  /** Attached to this model object (pin.attach). */
  attached?: string;
  /** Auto placed: the computed point, before the move onto a model surface. */
  base?: PlanXYZ;
}

/** A pin attached to a model object: the object id and the offset from its anchor. */
type AttachPin = LayoutPin & { attach?: string; offset?: unknown };

/** The marker element with the look / badge keys cached on it (DOM writes only on a change). */
type MarkerEl = HTMLDivElement & { _fpLook?: string; _fpBadgeSig?: string };

export class MarkerLayer {
  card: Floorplan3dCard;
  _markers: Marker[];
  _markerEls: Map<string, MarkerEl>;
  _positions: Map<string, MarkerPosition> | undefined;
  _mowerMarkerId: string | null | undefined;
  _surf: { key: string; map: Map<string, PlanXYZ | null> } | undefined;
  _surfJob: ReturnType<typeof setTimeout> | null | undefined;

  /** @param card the Floorplan3dCard (host): read live, never captured */
  constructor(card: Floorplan3dCard) {
    this.card = card;
    this._markers = [];
    this._markerEls = new Map();
    this._positions = undefined; // marker id -> plan position (replaced by each _buildMarkers)
    this._mowerMarkerId = undefined;
    this._surf = undefined; // { key, map } surface spots per model placement
    this._surfJob = undefined;
  }

  dispose(): void {
    clearTimeout(this._surfJob ?? undefined);
    this._surfJob = null;
  }

  _applyMarkerSelection(id: string | null): void {
    for (const [mid, el] of this._markerEls) el.classList.toggle('selected', mid === id);
  }

  _buildMarkers(): void {
    const h = this.card._hass, l = this.card._layout!; // from _update / model and mower refreshes (layout loaded)
    // a device bound to a model object has no marker: the object is the control (glow sprite too).
    // With group_by: device the marker stands for the device's primary entity, so a bound primary
    // light hides the whole device marker (its other entities, e.g. a power sensor, included).
    const bound = this.card._boundEntities;
    this._markers = buildMarkers(h, l, { group_by: this.card._config.group_by }).filter((m: Marker) => !bound.has(m.entityId));
    const positions: Map<string, MarkerPosition> = (this._positions = markerPositions(this._markers, { ...l, rooms: this.card._allRooms() }, h, this.card._floors!, (pin: AttachPin, fid: string) => this._attachAt(pin, fid))); // floors: structure built first
    if (this._surfacePass(false)) this._scheduleSurfaces(); // cached surface spots now, new ones after this update

    // the mower's device marker follows the live position instead of being auto placed
    const cfg = l.mower;
    this._mowerMarkerId = null;
    this.card._view.mowerMarkerId = null;
    const mowerObject = !!(this.card._objects && this.card._objects.mowerBound());
    if (cfg && cfg.entity) {
      const reg = h.entities && h.entities[cfg.entity];
      const devId = reg && reg.device_id;
      let mm: Marker | null | undefined = this._markers.find((m) => (devId ? m.deviceId === devId : m.entityId === cfg.entity));
      if (mowerObject) {
        // the mower model replaces the mower marker
        if (mm) { const gone = mm; this._markers = this._markers.filter((m) => m !== gone); positions.delete(gone.id); }
        mm = null;
      } else if (!mm) {
        const st = h.states[cfg.entity];
        mm = { id: 'mower:' + cfg.entity, entityId: cfg.entity, domain: cfg.entity.split('.')[0],
          name: (st && st.attributes.friendly_name) || cfg.entity, entities: [], secondaryId: null };
        this._markers.push(mm);
      }
      if (mm) {
        this._mowerMarkerId = mm.id;
        this.card._view.mowerMarkerId = mm.id;
        const live = this.card._mowerLive;
        if (live && live.floorId && live.x !== undefined && live.y !== undefined) positions.set(mm.id, { x: live.x, y: live.y, z: this.card._mowerZ(live.x, live.y, live.floorId), floorId: live.floorId, auto: false, live: true });
        else positions.delete(mm.id);
      }
    }

    this._markerEls.clear();
    const list: ({ id: string; element: MarkerEl } & MarkerPosition)[] = [];
    for (const m of this._markers) {
      const p = positions.get(m.id);
      if (!p) continue;
      const element = this._markerElement(m);
      this._markerEls.set(m.id, element);
      list.push({ id: m.id, element, ...p });
    }
    this.card._view.setMarkers(list);
    this.card._applyMarkerStates();
  }

  // ---------- auto-placed markers on the model's surfaces ----------
  // Placement inputs of the model surfaces: id, merge state, alignment, floor elevations ('' = no model).
  _surfaceModelKey(): string {
    const v = this.card._view, m = v && v.model;
    if (!m || !this.card._floors) return '';
    const g = v.modelGroup, r = (x: number): number => Math.round(x * 1000) / 1000;
    return [m.id, v.mergeStats ? v.mergeStats.merged : '-', g.position.toArray().map(r).join(), r(g.rotation.y), r(g.scale.x),
      this.card._floors.map((f) => f.id + ':' + r(v.floorElevation(f.id))).join()].join('|');
  }

  // Auto-placed markers (never pins) move onto the nearest model surface of their type: walls for
  // wall / corner / door devices, the ceiling for the ceiling grid, the floor for floor-standing ones.
  // Results are cached per model placement and computed point; compute = false only applies cached
  // ones (the rebuild path), compute = true works through the rest in a ~10 ms slice and moves the
  // markers. Returns true when points are still waiting.
  _surfacePass(compute: boolean): boolean {
    const pos = this._positions, vw = this.card._view;
    if (!pos || !this._markers || !vw) return false;
    const key = this._surfaceModelKey();
    if (key && (!this._surf || this._surf.key !== key)) this._surf = { key, map: new Map() };
    const surf = this._surf;
    const t0 = performance.now();
    let rooms: ReturnType<Floorplan3dCard['_allRooms']> | null = null, pending = false, moved = false;
    for (const m of this._markers) {
      const p = pos.get(m.id);
      if (!p || !p.auto) continue;
      const base = p.base || p;
      const kind = key && surf ? surfaceKind(m.domain, m.deviceClass) : null; // key: surf set above
      let target: PlanXYZ = base;
      if (kind && surf) {
        if (!rooms) rooms = this.card._allRooms();
        const room = rooms.find((r) => r.area_id === m.areaId);
        const k = surfaceKey(kind, p.floorId, base, room ? room.id : '');
        let s = surf.map.get(k);
        if (s === undefined) {
          if (!compute || performance.now() - t0 > 10) { pending = true; continue; }
          const elev = vw.floorElevation(p.floorId);
          const floor = (this.card._floors || []).find((f) => f.id === p.floorId);
          // ceiling / floor rays stay on the device's floor (never the floor above, never through a stair opening)
          const hits = surfaceSearch(kind, base.z, floor && floor.height)
            .flatMap((g) => vw.surfaceRays(worldOf({ ...base, z: g.from }, elev), g.dirs, g.max));
          // stay with the room: an open plan must not send a device to a wall across the house
          const accept = kind === 'wall' && room ? (w: number[]) => nearPolygon([w[0], -w[2]], room.polygon, 0.5) : null;
          const c = chooseSurface(kind, hits, { accept });
          s = c ? planOf(c.point, elev) : null;
          surf.map.set(k, s);
        }
        if (s) target = s;
      }
      if (target.x === p.x && target.y === p.y && target.z === p.z) continue;
      const next: MarkerPosition = { ...p, x: target.x, y: target.y, z: target.z };
      if (target === base) delete next.base;
      else next.base = { x: base.x, y: base.y, z: base.z };
      pos.set(m.id, next);
      if (compute) vw.moveMarker(m.id, next.x, next.y, next.z, next.floorId);
      moved = true;
    }
    if (compute && moved) this._refreshStates(); // light glows follow
    return pending;
  }

  // Compute surface spots after the current update (model loaded, merged, realigned, markers rebuilt).
  _scheduleSurfaces(): void {
    if (this._surfJob) return;
    this._surfJob = setTimeout(() => {
      this._surfJob = null;
      if (!this.card.isConnected || !this.card._view) return;
      if (this._surfacePass(true)) this._scheduleSurfaces();
    }, 0);
  }

  // Plan position of a marker attached to a model object (its anchor + offset), null when the object is not there.
  _attachAt(pin: AttachPin, floorId: string): PlanXYZ | null {
    const a = this.card._objects && pin.attach ? this.card._objects.anchorOf(pin.attach) : null;
    return a ? attachedPosition(a, pin.offset, this.card._view.floorElevation(floorId)) : null;
  }

  // Attached markers follow their object (mower pose, model placement): move the ones that moved.
  _refreshAttached(): void {
    const pins: Record<string, AttachPin> = (this.card._layout && this.card._layout.pins) || {};
    const positions = this._positions;
    if (!positions || !this.card._view) return;
    for (const [id, pos] of positions) {
      const pin = pins[id];
      if (!pin || !pin.attach) continue;
      const at = this._attachAt(pin, pos.floorId);
      if (!at) {
        if (!pos.attached) continue;
        // the object vanished: back to the pin's stored (fallback) position
        const z = pin.z ?? 1.2;
        positions.set(id, { x: pin.x, y: pin.y, z, floorId: pos.floorId, auto: false });
        this.card._view.moveMarker(id, pin.x, pin.y, z, pos.floorId);
        continue;
      }
      if (pos.attached && Math.abs(at.x - pos.x) < 1e-6 && Math.abs(at.y - pos.y) < 1e-6 && Math.abs(at.z - pos.z) < 1e-6) continue;
      positions.set(id, { ...pos, x: at.x, y: at.y, z: at.z, attached: pin.attach });
      this.card._view.moveMarker(id, at.x, at.y, at.z, pos.floorId);
    }
  }

  _markerElement(m: Marker): MarkerEl {
    const el: MarkerEl = document.createElement('div');
    el.className = 'fp-marker ' + m.domain;
    el.innerHTML = '<div class="fp-dot"><ha-icon></ha-icon><span class="fp-in"></span></div><div class="fp-val"></div>';
    el.title = m.name;
    let start: [number, number] | null = null, timer: ReturnType<typeof setTimeout> | null = null, long = false;
    const cancel = (): void => { clearTimeout(timer ?? undefined); timer = null; };
    el.addEventListener('pointerdown', (e) => {
      if (this.card._editing) {
        this.card._edit.markerDown(m, e);
        return;
      }
      if (e.button !== 0) return;
      e.stopPropagation();
      start = [e.clientX, e.clientY];
      long = false;
      timer = setTimeout(() => { long = true; this.card._runMarkerAction(m, 'hold'); }, LONG_PRESS_MS);
    });
    el.addEventListener('pointermove', (e) => {
      if (start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) >= CLICK_SLOP_PX) cancel();
    });
    el.addEventListener('pointerup', (e) => {
      const wasClick = start && !long && timer && Math.hypot(e.clientX - start[0], e.clientY - start[1]) < CLICK_SLOP_PX;
      cancel();
      start = null;
      if (wasClick) this.card._taps.tap(`marker:${m.id}`, !!this.card._markerActions(m).double_tap, () => this.card._runMarkerAction(m, 'tap'), () => this.card._runMarkerAction(m, 'double_tap'));
    });
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    return el;
  }

  // Badge toggles: layout (Edit -> Devices), then the card YAML `badges:` per key.
  badgeOpts(): ReturnType<typeof badgeOptions> {
    return badgeOptions(this.card._layout && this.card._layout.badges, this.card._config && this.card._config.badges);
  }

  // Popup header badges for a model object's bound entity (status dot + logo, no battery chip).
  _objectBadge(entity: string | null | undefined): ReturnType<typeof badgeInfo> | null {
    const h = this.card._hass, o = this.badgeOpts();
    if (!entity || !h || !(o.status || o.integration)) return null;
    const reg = h.entities && h.entities[entity];
    return badgeInfo(h, { entityId: entity, deviceId: reg && reg.device_id }, { ...o, battery: false });
  }

  _refreshStates(): void {
    const h = this.card._hass;
    const glows: Record<string, unknown>[] = [];
    const bo = this.badgeOpts(), anyBadge = bo.integration || bo.status || bo.battery;
    const dark = !!(this.card._built.theme && this.card._built.theme.dark);
    for (const m of this._markers) {
      const el = this._markerEls.get(m.id);
      if (!el) continue;
      const st = h.states[m.entityId];
      el.classList.toggle('active', isActive(st));
      el.classList.toggle('unavailable', !st || st.state === 'unavailable');
      el.classList.toggle('offline', m.id === this._mowerMarkerId && !!this.card._mowerOffline);
      const icon = el.querySelector('ha-icon')!; // the markup of _markerElement
      const ic = m.id === this._mowerMarkerId ? 'mdi:robot-mower' : iconFor(h, m.entityId);
      if (icon.getAttribute('icon') !== ic) icon.setAttribute('icon', ic);
      const look = markerLook(h, m);
      this._applyLook(el, look);
      const own = look.kind === 'value' ? '' : displayValue(h, m.entityId);
      const val = own || (look.kind !== 'value' && m.secondaryId ? displayValue(h, m.secondaryId) : '');
      const ve = el.querySelector('.fp-val')!;
      if (ve.textContent !== val) ve.textContent = val;
      const inner = el.querySelector('.fp-in')!;
      if (inner.textContent !== look.value) inner.textContent = look.value;
      const name = st && st.attributes.friendly_name;
      el.title = m.name + (name && name !== m.name ? ' – ' + name : '');
      if (anyBadge || el._fpBadgeSig) applyBadges(el, anyBadge ? badgeInfo(h, m, bo) : null, dark);

      if (m.domain === 'light') {
        const g = lightGlow(st);
        el.style.setProperty('--fp-light', g && st.attributes.rgb_color ? `rgb(${g.rgb.join(',')})` : '');
        const p = this._positions && this._positions.get(m.id); // set with the markers
        if (g && p) glows.push({ id: m.id, x: p.x, y: p.y, floorId: p.floorId, ...g });
      }
    }
    this.card._view.setGlows(glows);
  }

  // Marker shape / kind classes and the entity picture (registry.js markerLook); DOM writes only on a change.
  _applyLook(el: MarkerEl, look: ReturnType<typeof markerLook>): void {
    // a picture counts by path + cache hash (registry.js pictureKey): rotating access tokens do not reload it
    const pic = look.picture ? pictureKey(look.picture, look.pictureStamp) : '';
    const key = `${look.shape}|${look.kind}|${look.alert || ''}|${pic}`;
    if (el._fpLook === key) return;
    el._fpLook = key;
    for (const c of [...el.classList]) if (/^(shape|kind|alert)-/.test(c)) el.classList.remove(c);
    el.classList.add(`shape-${look.shape}`, `kind-${look.kind}`);
    if (look.alert) el.classList.add(`alert-${look.alert}`);
    const dot = el.querySelector('.fp-dot')!; // the markup of _markerElement
    let img = dot.querySelector<HTMLImageElement>('img.fp-pic');
    if (!look.picture) {
      if (img) img.remove();
      dot.classList.remove('has-pic');
      return;
    }
    if (!img) {
      const pic = (img = document.createElement('img'));
      pic.className = 'fp-pic';
      pic.alt = '';
      pic.draggable = false;
      pic.addEventListener('load', () => pic.parentElement && pic.parentElement.classList.add('has-pic'));
      pic.addEventListener('error', () => pic.parentElement && pic.parentElement.classList.remove('has-pic')); // the icon stays
      dot.prepend(pic);
    }
    dot.classList.remove('has-pic');
    img.src = look.picture;
  }
}
