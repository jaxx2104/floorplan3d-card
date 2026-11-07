// Device markers of the card: built from the registry, positioned (auto, pins, attached, the live
// mower), their face (the GPU sprite's picture: icon, value, badges, state colours; marker-sprite.ts),
// the gestures on them (picked on screen: tap, hold, edit drag), state refresh (faces, light glows) and
// the move of auto-placed markers onto the model's surfaces. _buildMarkers replaces the _positions Map:
// other parts read card._positions each time, never keep it.

import {
  buildMarkers,
  isActive,
  markerColor,
  markerLook,
  displayValue,
  pictureKey,
  type Marker,
} from "../registry.ts";
import { markerSprite, type MarkerFace } from "../marker-sprite.ts";
import { logoSrc, logoFailed } from "../badge-dom.ts";
import { markerPositions, lightGlow, type MarkerPosition } from "../layout.ts";
import {
  surfaceKind,
  surfaceKey,
  surfaceSearch,
  worldOf,
  nearPolygon,
  chooseSurface,
  planOf,
  type PlanXYZ,
} from "../surface.ts";
import { attachedPosition } from "../objects/logic.ts";
import { badgeOptions, badgeInfo } from "../badges.ts";
import { LONG_PRESS_MS, CLICK_SLOP_PX } from "./constants.ts";
import type { Floorplan3dCard } from "../card-impl.ts";
import type { LayoutPin } from "../types/layout.ts";
import type { GlowSpec } from "../view/structure.ts";

/** A pin attached to a model object: the object id and the offset from its anchor. */
type AttachPin = LayoutPin & { attach?: string; offset?: unknown };

/** A marker tap in progress (pointer down until up / move / cancel). */
interface MarkerGesture {
  id: string;
  x: number;
  y: number;
  pointerId: number;
  long: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  move: (ev: PointerEvent) => void;
  up: (ev: PointerEvent) => void;
  cancel: () => void;
  menu: (ev: Event) => void;
}

/** A marker as the headless checks see it (_markerView). */
export interface MarkerViewInfo extends MarkerFace {
  title: string;
  /** in the scene and visible (floor rules, view state, section) */
  shown: boolean;
  alpha: number;
  hiddenAlpha: number;
  faded: boolean;
  /** the model hides its anchor now (a tap in view mode passes through) */
  hidden: boolean;
  pickable: boolean;
  logoLoaded: boolean;
  pictureLoaded: boolean;
  iconResolved: boolean;
}

export class MarkerLayer {
  card: Floorplan3dCard;
  _markers: Marker[];
  /** marker id -> its face (what the sprite shows) */
  _faces: Map<string, MarkerFace>;
  _titles: Map<string, string>;
  _positions: Map<string, MarkerPosition> | undefined;
  _mowerMarkerId: string | null | undefined;
  _surf: { key: string; map: Map<string, PlanXYZ | null> } | undefined;
  _surfJob: ReturnType<typeof setTimeout> | null | undefined;
  _selected: string | null;
  _gesture: MarkerGesture | null;
  _hoverId: string | null;
  _hoverAt: [number, number] | null;
  _hoverRaf: number | null;
  /** picture identity (registry pictureKey) -> the URL first seen for it: rotating tokens load nothing new */
  _pictureUrls: Map<string, string>;
  /** integration logo URL -> its platform (a failed logo falls back / hides, badge-dom.ts logoFailed) */
  _logoPlatforms: Map<string, string>;

  /** @param card the Floorplan3dCard (host): read live, never captured */
  constructor(card: Floorplan3dCard) {
    this.card = card;
    this._markers = [];
    this._faces = new Map();
    this._titles = new Map();
    this._positions = undefined; // marker id -> plan position (replaced by each _buildMarkers)
    this._mowerMarkerId = undefined;
    this._surf = undefined; // { key, map } surface spots per model placement
    this._surfJob = undefined;
    this._selected = null;
    this._gesture = null;
    this._hoverId = null;
    this._hoverAt = null;
    this._hoverRaf = null;
    this._pictureUrls = new Map();
    this._logoPlatforms = new Map();
  }

  dispose(): void {
    clearTimeout(this._surfJob ?? undefined);
    this._surfJob = null;
    this._endMarkerGesture();
    if (this._hoverRaf) cancelAnimationFrame(this._hoverRaf);
    this._hoverRaf = null;
  }

  // Edit mode: the selected marker wears the selection ring (its face changes, nothing else).
  _applyMarkerSelection(id: string | null): void {
    if (this._selected === id) return;
    const was = this._selected;
    this._selected = id;
    for (const mid of [was, id]) {
      const f = mid && this._faces.get(mid);
      if (!f || !mid) continue;
      this._setFace(mid, { ...f, selected: mid === id });
    }
  }

  _setFace(id: string, face: MarkerFace): void {
    this._faces.set(id, face);
    this.card._view.setMarkerSprite(id, markerSprite(face), !!face.alert);
  }

  _buildMarkers(): void {
    const h = this.card._hass,
      l = this.card._layout!; // from _update / model and mower refreshes (layout loaded)
    // a device bound to a model object has no marker: the object is the control (glow sprite too).
    // With group_by: device the marker stands for the device's primary entity, so a bound primary
    // light hides the whole device marker (its other entities, e.g. a power sensor, included).
    const bound = this.card._boundEntities;
    this._markers = buildMarkers(h, l, {
      group_by: this.card._config.group_by,
    }).filter((m: Marker) => !bound.has(m.entityId));
    const positions: Map<string, MarkerPosition> = (this._positions =
      markerPositions(
        this._markers,
        { ...l, rooms: this.card._allRooms() },
        h,
        this.card._floors!,
        (pin: AttachPin, fid: string) => this._attachAt(pin, fid),
      )); // floors: structure built first
    if (this._surfacePass(false)) this._scheduleSurfaces(); // cached surface spots now, new ones after this update

    // the mower's device marker follows the live position instead of being auto placed
    const cfg = l.mower;
    this._mowerMarkerId = null;
    this.card._view.mowerMarkerId = null;
    const mowerObject = !!(
      this.card._objects && this.card._objects.mowerBound()
    );
    if (cfg && cfg.entity) {
      const reg = h.entities && h.entities[cfg.entity];
      const devId = reg && reg.device_id;
      let mm: Marker | null | undefined = this._markers.find((m) =>
        devId ? m.deviceId === devId : m.entityId === cfg.entity,
      );
      if (mowerObject) {
        // the mower model replaces the mower marker
        if (mm) {
          const gone = mm;
          this._markers = this._markers.filter((m) => m !== gone);
          positions.delete(gone.id);
        }
        mm = null;
      } else if (!mm) {
        const st = h.states[cfg.entity];
        mm = {
          id: "mower:" + cfg.entity,
          entityId: cfg.entity,
          domain: cfg.entity.split(".")[0],
          areaId: null,
          deviceId: null,
          deviceClass: undefined,
          name: (st && st.attributes.friendly_name) || cfg.entity,
          entities: [],
          secondaryId: null,
        };
        this._markers.push(mm);
      }
      if (mm) {
        this._mowerMarkerId = mm.id;
        this.card._view.mowerMarkerId = mm.id;
        const live = this.card._mowerLive;
        if (
          live &&
          live.floorId &&
          live.x !== undefined &&
          live.y !== undefined
        )
          positions.set(mm.id, {
            x: live.x,
            y: live.y,
            z: this.card._mowerZ(live.x, live.y, live.floorId),
            floorId: live.floorId,
            auto: false,
            live: true,
          });
        else positions.delete(mm.id);
      }
    }

    const list: ({ id: string } & MarkerPosition)[] = [];
    for (const m of this._markers) {
      const p = positions.get(m.id);
      if (p) list.push({ id: m.id, ...p });
    }
    this.card._view.setMarkers(list); // a marker kept keeps its face until the refresh
    const ids = new Set(list.map((x) => x.id));
    for (const id of [...this._faces.keys()])
      if (!ids.has(id)) {
        this._faces.delete(id);
        this._titles.delete(id);
      }
    this.card._applyMarkerStates();
    this._syncMarkerMode();
  }

  // ---------- auto-placed markers on the model's surfaces ----------
  // Placement inputs of the model surfaces: id, merge state, alignment, floor elevations ('' = no model).
  _surfaceModelKey(): string {
    const v = this.card._view,
      m = v && v.model;
    if (!m || !this.card._floors) return "";
    const g = v.modelGroup,
      r = (x: number): number => Math.round(x * 1000) / 1000;
    return [
      m.id,
      v.mergeStats ? v.mergeStats.merged : "-",
      g.position.toArray().map(r).join(),
      r(g.rotation.y),
      r(g.scale.x),
      this.card._floors
        .map((f) => f.id + ":" + r(v.floorElevation(f.id)))
        .join(),
    ].join("|");
  }

  // Auto-placed markers (never pins) move onto the nearest model surface of their type: walls for
  // wall / corner / door devices, the ceiling for the ceiling grid, the floor for floor-standing ones.
  // Results are cached per model placement and computed point; compute = false only applies cached
  // ones (the rebuild path), compute = true works through the rest in a ~10 ms slice and moves the
  // markers. Returns true when points are still waiting.
  _surfacePass(compute: boolean): boolean {
    const pos = this._positions,
      vw = this.card._view;
    if (!pos || !this._markers || !vw) return false;
    const key = this._surfaceModelKey();
    if (key && (!this._surf || this._surf.key !== key))
      this._surf = { key, map: new Map() };
    const surf = this._surf;
    const t0 = performance.now();
    let rooms: ReturnType<Floorplan3dCard["_allRooms"]> | null = null,
      pending = false,
      moved = false;
    for (const m of this._markers) {
      const p = pos.get(m.id);
      if (!p || !p.auto) continue;
      const base = p.base || p;
      const kind = key && surf ? surfaceKind(m.domain, m.deviceClass) : null; // key: surf set above
      let target: PlanXYZ = base;
      if (kind && surf) {
        if (!rooms) rooms = this.card._allRooms();
        const room = rooms.find((r) => r.area_id === m.areaId);
        const k = surfaceKey(kind, p.floorId, base, room ? room.id : "");
        let s = surf.map.get(k);
        if (s === undefined) {
          if (!compute || performance.now() - t0 > 10) {
            pending = true;
            continue;
          }
          const elev = vw.floorElevation(p.floorId);
          const floor = (this.card._floors || []).find(
            (f) => f.id === p.floorId,
          );
          // ceiling / floor rays stay on the device's floor (never the floor above, never through a stair opening)
          const hits = surfaceSearch(
            kind,
            base.z,
            floor && floor.height,
          ).flatMap((g) =>
            vw.surfaceRays(
              worldOf({ ...base, z: g.from }, elev),
              g.dirs,
              g.max,
            ),
          );
          // stay with the room: an open plan must not send a device to a wall across the house
          const accept =
            kind === "wall" && room
              ? (w: number[]) => nearPolygon([w[0], -w[2]], room.polygon, 0.5)
              : null;
          const c = chooseSurface(kind, hits, { accept });
          s = c ? planOf(c.point, elev) : null;
          surf.map.set(k, s);
        }
        if (s) target = s;
      }
      if (target.x === p.x && target.y === p.y && target.z === p.z) continue;
      const next: MarkerPosition = {
        ...p,
        x: target.x,
        y: target.y,
        z: target.z,
      };
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
    const a =
      this.card._objects && pin.attach
        ? this.card._objects.anchorOf(pin.attach)
        : null;
    return a
      ? attachedPosition(a, pin.offset, this.card._view.floorElevation(floorId))
      : null;
  }

  // Attached markers follow their object (mower pose, model placement): move the ones that moved.
  _refreshAttached(): void {
    const pins: Record<string, AttachPin> =
      (this.card._layout && this.card._layout.pins) || {};
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
        positions.set(id, {
          x: pin.x,
          y: pin.y,
          z,
          floorId: pos.floorId,
          auto: false,
        });
        this.card._view.moveMarker(id, pin.x, pin.y, z, pos.floorId);
        continue;
      }
      if (
        pos.attached &&
        Math.abs(at.x - pos.x) < 1e-6 &&
        Math.abs(at.y - pos.y) < 1e-6 &&
        Math.abs(at.z - pos.z) < 1e-6
      )
        continue;
      positions.set(id, {
        ...pos,
        x: at.x,
        y: at.y,
        z: at.z,
        attached: pin.attach,
      });
      this.card._view.moveMarker(id, at.x, at.y, at.z, pos.floorId);
    }
  }

  // ---------- gestures (the markers are GPU sprites: picked on screen, view/sprites.ts markersAt) ----------

  // Stage listeners, after the object input's (an object under the finger wins): tap / hold / edit drag on a
  // marker, the hover look and the tooltip.
  wire(stage: HTMLElement, canvas: HTMLCanvasElement): void {
    stage.addEventListener(
      "pointerdown",
      (e: PointerEvent) => this._markerDown(e, canvas),
      true,
    );
    stage.addEventListener("pointermove", (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      this._hoverAt =
        e.buttons || e.target !== canvas ? null : [e.clientX, e.clientY];
      if (!this._hoverRaf)
        this._hoverRaf = requestAnimationFrame(() => {
          this._hoverRaf = null;
          this._markerHover();
        });
    });
    stage.addEventListener("pointerleave", () => {
      this._hoverAt = null;
      this._markerHover();
    });
  }

  /** The marker a tap at a client point lands on (the one drawn on top; hidden ones skipped in view mode). */
  _markerAt(x: number, y: number): Marker | null {
    const v = this.card._view;
    if (!v) return null;
    for (const id of v.markersAt(x, y)) {
      const m = this._markers.find((k) => k.id === id);
      if (m) return m;
    }
    return null;
  }

  // Tap = moved < 5 px and not held; hold 500 ms = hold action; edit mode: select / drag (edit/tools/drag.ts).
  _markerDown(e: PointerEvent, canvas: HTMLCanvasElement): void {
    if (this._gesture) {
      this._endMarkerGesture(); // a second finger: pinch / orbit, no tap
      return;
    }
    if (e.target !== canvas || !e.isPrimary) return; // toolbar, popup, panel, edit handles
    if (this.card._objectInput._gesture) return; // the object under the finger won
    if (this.card._popup.closedBy === e) return; // this tap closed the popup
    const m = this._markerAt(e.clientX, e.clientY);
    if (!m) return;
    e.stopPropagation(); // the marker takes the pointer: no orbit, no click on the plan
    if (e.button !== 0) return;
    const g: MarkerGesture = {
      id: m.id,
      x: e.clientX,
      y: e.clientY,
      pointerId: e.pointerId,
      long: false,
      timer: null,
      move: (ev: PointerEvent) => {
        if (
          ev.pointerId === g.pointerId &&
          Math.hypot(ev.clientX - g.x, ev.clientY - g.y) >= CLICK_SLOP_PX
        )
          this._endMarkerGesture();
      },
      up: (ev: PointerEvent) => {
        if (ev.pointerId !== g.pointerId) return;
        const tap =
          !g.long &&
          Math.hypot(ev.clientX - g.x, ev.clientY - g.y) < CLICK_SLOP_PX;
        this._endMarkerGesture();
        if (tap)
          this.card._taps.tap(
            `marker:${m.id}`,
            !!this.card._markerActions(m).double_tap,
            () => this.card._runMarkerAction(m, "tap"),
            () => this.card._runMarkerAction(m, "double_tap"),
          );
      },
      cancel: () => this._endMarkerGesture(),
      menu: (ev: Event) => ev.preventDefault(), // a touch hold opens no context menu
    };
    g.timer = setTimeout(() => {
      g.long = true;
      g.timer = null;
      this.card._runMarkerAction(m, "hold");
    }, LONG_PRESS_MS);
    window.addEventListener("pointermove", g.move, true);
    window.addEventListener("pointerup", g.up, true);
    window.addEventListener("pointercancel", g.cancel, true);
    window.addEventListener("contextmenu", g.menu, true);
    this._gesture = g;
  }

  _endMarkerGesture(): void {
    const g = this._gesture;
    if (!g) return;
    this._gesture = null;
    clearTimeout(g.timer ?? undefined);
    window.removeEventListener("pointermove", g.move, true);
    window.removeEventListener("pointerup", g.up, true);
    window.removeEventListener("pointercancel", g.cancel, true);
    // the contextmenu of a touch hold follows the pointerup
    setTimeout(
      () => window.removeEventListener("contextmenu", g.menu, true),
      400,
    );
  }

  // Desktop hover: the marker grows a little, a pointer (grab in edit mode) cursor, its name as the tooltip.
  _markerHover(): void {
    const p = this._hoverAt;
    const m =
      p && !this._gesture && this.card._view
        ? this._markerAt(p[0], p[1])
        : null;
    const id = m ? m.id : null;
    if (id === this._hoverId) return;
    this._hoverId = id;
    const stage = this.card._stage,
      canvas = this.card._view && this.card._view.renderer.domElement;
    if (stage) stage.classList.toggle("fp-marker-hover", !!m);
    if (canvas) {
      const t = m ? this._titles.get(m.id) || m.name : "";
      if (t) canvas.title = t;
      else canvas.removeAttribute("title");
    }
    this._syncMarkerMode();
  }

  // The markers' common draw state: night quiet (the stage classes), the hovered one.
  _syncMarkerMode(): void {
    const v = this.card._view,
      st = this.card._stage;
    if (!v || !st) return;
    const c = st.classList;
    v.setMarkerMode({
      quiet: c.contains("night-quiet") && !c.contains("awake"),
      hover: this._hoverId || null,
    });
  }

  // ---------- for the headless checks ----------

  /** The dot of a marker on screen (client px), null when it is not drawn. */
  _markerRect(
    id: string,
  ): { x: number; y: number; width: number; height: number } | null {
    const s = this.card._view && this.card._view.markerScreen(id);
    if (!s || !s.hits.length) return null;
    const d = s.hits[0];
    return {
      x: s.x + d.x * s.scale,
      y: s.y + d.y * s.scale,
      width: d.w * s.scale,
      height: d.h * s.scale,
    };
  }

  /** What a marker shows and how it is drawn (the face, opacity, faded / hidden, its tooltip). */
  _markerView(id: string): MarkerViewInfo | null {
    const v = this.card._view,
      e = v && v.markerObjects.get(id),
      f = this._faces.get(id);
    if (!e || !f) return null;
    let shown = e.obj.visible;
    for (let p = e.obj.parent; p && shown; p = p.parent) shown = p.visible;
    return {
      ...f,
      title: this._titles.get(id) || "",
      shown,
      alpha: e.obj.alpha,
      hiddenAlpha: e.obj.hiddenAlpha,
      faded: !!e.faded,
      hidden: v.markerHidden(id),
      pickable: e.pickable !== false,
      logoLoaded: !!(f.logo && v.sprites.layer.image(f.logo)),
      pictureLoaded: !!(f.picture && v.sprites.layer.image(f.picture)),
      iconResolved: !!v.sprites.icons.glyph(f.icon),
    };
  }

  // Badge toggles: layout (Edit -> Devices), then the card YAML `badges:` per key.
  badgeOpts(): ReturnType<typeof badgeOptions> {
    return badgeOptions(
      this.card._layout && this.card._layout.badges,
      this.card._config && this.card._config.badges,
    );
  }

  // Popup header badges for a model object's bound entity (status dot + logo, no battery chip).
  _objectBadge(
    entity: string | null | undefined,
  ): ReturnType<typeof badgeInfo> | null {
    const h = this.card._hass,
      o = this.badgeOpts();
    if (!entity || !h || !(o.status || o.integration)) return null;
    const reg = h.entities && h.entities[entity];
    return badgeInfo(
      h,
      { entityId: entity, deviceId: reg && reg.device_id },
      { ...o, battery: false },
    );
  }

  _refreshStates(): void {
    const h = this.card._hass,
      vw = this.card._view;
    const glows: GlowSpec[] = [];
    const bo = this.badgeOpts(),
      anyBadge = bo.integration || bo.status || bo.battery;
    const dark = !!(this.card._theme && this.card._theme.dark);
    const layer = vw.sprites.layer;
    if (!layer.onImageError)
      layer.onImageError = (url: string) => {
        // an integration logo that failed: the dark one falls back to the light one, a light one hides
        const p = this._logoPlatforms.get(url);
        if (p === undefined) return;
        logoFailed(p, url);
        this._refreshStates();
      };
    const icons = new Set<string>(),
      images = new Set<string>();
    for (const m of this._markers) {
      if (!vw.markerObjects.has(m.id)) continue;
      const st = h.states[m.entityId];
      const mower = m.id === this._mowerMarkerId;
      const look = markerLook(h, m);
      const icon = vw.sprites.icons.stateIcon(
        m.id,
        h,
        m.entityId,
        mower ? "mdi:robot-mower" : null,
      );
      icons.add(icon);
      const own = look.kind === "value" ? "" : displayValue(h, m.entityId);
      const val =
        own ||
        (look.kind !== "value" && m.secondaryId
          ? displayValue(h, m.secondaryId)
          : "");
      const badge = anyBadge ? badgeInfo(h, m, bo) : null;
      const logo =
        badge && badge.platform ? logoSrc(badge.platform, dark) : null;
      if (logo && badge && badge.platform) {
        this._logoPlatforms.set(logo, badge.platform);
        images.add(logo);
      }
      // a picture counts by path + cache hash (registry pictureKey): rotating access tokens do not reload it
      let picture: string | null = null;
      if (look.picture) {
        const k = pictureKey(look.picture, look.pictureStamp);
        picture = this._pictureUrls.get(k) || look.picture;
        this._pictureUrls.set(k, picture);
        images.add(picture);
      }
      let lightColor = "";
      if (m.domain === "light") {
        const g = lightGlow(st);
        lightColor =
          g && st.attributes.rgb_color ? `rgb(${g.rgb.join(",")})` : "";
        const p = this._positions && this._positions.get(m.id); // set with the markers
        if (g && p)
          glows.push({ id: m.id, x: p.x, y: p.y, floorId: p.floorId, ...g });
      }
      this._setFace(m.id, {
        shape: look.shape,
        kind: look.kind,
        light: m.domain === "light",
        active: isActive(st),
        alert: look.alert,
        unavailable: !st || st.state === "unavailable",
        offline: mower && !!this.card._mowerOffline,
        stateColor: markerColor(st, m.domain, look.alert),
        lightColor,
        icon,
        inner: look.value,
        value: val,
        picture,
        logo,
        status: badge ? badge.status : null,
        battery: badge ? badge.battery : null,
        selected: this._selected === m.id,
      });
      const name = st && st.attributes.friendly_name;
      this._titles.set(
        m.id,
        m.name + (name && name !== m.name ? " – " + name : ""),
      );
    }
    vw.sprites.icons.keep(icons); // hosts of markers that went
    layer.keepImages(images);
    for (const k of this._pictureUrls.keys())
      if (!images.has(this._pictureUrls.get(k)!)) this._pictureUrls.delete(k);
    vw.setGlows(glows);
  }
}
