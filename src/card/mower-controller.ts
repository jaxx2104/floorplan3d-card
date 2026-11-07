// Live mower for the card: position (gps / xy through the calibration), heading from movement, the
// driven track, the dock, and the warning (error / stuck) with its chip (offline / rain). The card
// (host) is read live on every call: _hass / _layout / _config are replaced on each update, so
// nothing of it is captured here.

import {
  readTrack,
  readSource,
  mowerTransform,
  type MowerReading,
  type MowerTransform,
} from "../mower.ts";
import {
  lastPosition,
  rememberPosition,
  mowerDockGroup,
  isDocked,
  dockWord,
} from "../mower-track.ts";
import {
  STUCK_DEFAULT_MIN,
  stuckStep,
  errorKind,
  stuckDueIn,
  errorText,
} from "../mower-warning.ts";
import {
  connectivity,
  rain,
  findErrorEntity,
  findStatusEntity,
  findProgress,
  progressValue,
} from "../mower-device.ts";
import type { Floorplan3dCard } from "../card-impl.ts";
import type { LayoutMower, PlanPoint } from "../types/layout.ts";

const MOWER_Z = 0.15;
const LAST_KEY = "default"; // the last known position, remembered in this browser
const HEADING_STEP_M = 0.05; // movement below this keeps the heading (reading noise)

type Timer = ReturnType<typeof setTimeout>;

/** The live mower: plan position (when known) and the raw reading of the position entity. */
export type MowerLive =
  | { x: number; y: number; floorId: string; reading: MowerReading | null }
  | {
      x?: undefined;
      y?: undefined;
      floorId?: undefined;
      reading: MowerReading;
    };

export class MowerController {
  card: Floorplan3dCard;
  _mowerFn: MowerTransform | null | undefined;
  _mowerLive: MowerLive | null | undefined;
  _mowerAt: "live" | "dock" | "last" | "dock-start" | null | undefined;
  _mowerHeading: number | null | undefined;
  _mowerHeadFrom: [number, number] | null | undefined;
  _trackKey:
    | {
        raw: unknown;
        fn: MowerTransform | null | undefined;
        floorId: string | null;
        cfg: LayoutMower | null;
      }
    | undefined;
  _mowerChip: { kind: string; icon: string; text: string } | null | undefined;
  _mowerOffline: boolean | undefined;
  _stuck: ReturnType<typeof stuckStep> | null | undefined;
  _stuckTimer: Timer | null | undefined;
  _warning: { kind: string; minutes: number } | null | undefined;

  /** @param card the Floorplan3dCard (host): read live, never captured */
  constructor(card: Floorplan3dCard) {
    this.card = card;
    this._mowerFn = undefined; // plan transform of the position entity (set per layout.mower)
    this._mowerLive = undefined;
    this._mowerAt = undefined;
    this._mowerHeading = undefined;
    this._mowerHeadFrom = undefined;
    this._trackKey = undefined;
    this._mowerChip = undefined;
    this._mowerOffline = undefined;
    this._stuck = undefined;
    this._stuckTimer = undefined;
    this._warning = undefined;
  }

  // layout.mower changed (card _update): the plan transform of its position entity.
  configChanged(m: LayoutMower | null): void {
    this._mowerFn = m && m.entity ? mowerTransform(m) : null;
  }

  // disconnectedCallback: the stuck timer and the warning's pulse timer.
  dispose(): void {
    clearTimeout(this._stuckTimer ?? undefined);
    this._stuckTimer = null;
    if (this.card._view) this.card._view.setMowerWarning(null); // its pulse timer
  }

  // The driven path on the floor (xy source with track_attr). Hidden while docked unless track_show: always.
  // Rebuilt only when the attribute, the transform or the floor changed (states update far more often).
  _refreshMowerTrack(
    cfg: LayoutMower | null,
    floorId: string | null = null,
    docked = false,
  ): void {
    const st =
      cfg && cfg.track_attr && cfg.entity && this.card._hass
        ? this.card._hass.states[cfg.entity]
        : null;
    const fn = this._mowerFn;
    const show =
      !!st && !!cfg && fn && (cfg.track_show === "always" || !docked);
    const raw = show ? st.attributes[cfg.track_attr!] : null; // show: st, so track_attr
    const key = this._trackKey;
    if (
      key &&
      key.raw === raw &&
      key.fn === this._mowerFn &&
      key.floorId === floorId &&
      key.cfg === cfg
    )
      return;
    this._trackKey = { raw, fn: this._mowerFn, floorId, cfg };
    const segs = raw && st && cfg ? readTrack(st, cfg) : null; // raw: shown, so st and cfg
    const segments =
      segs && fn
        ? segs.map((s) =>
            s.map((r) => fn(r)).filter((q): q is PlanPoint => !!q),
          )
        : null;
    this.card._view.setMowerTrack(
      segments && cfg && floorId !== null
        ? {
            segments,
            floorId,
            color: cfg.track_color,
            width: cfg.track_width,
            opacity: cfg.track_opacity,
          }
        : null,
    );
  }

  _mowerFloor(): string {
    const m = this.card._layout!.mower,
      floors = this.card._floors!; // with a layout, after the structure
    return m && m.floor_id && floors.some((f) => f.id === m.floor_id)
      ? m.floor_id
      : floors[0].id;
  }

  // Live mower: move its marker (or the model's mower object), the track and the warning.
  _refreshMower(): void {
    const cfg = this.card._layout!.mower; // from _update and mower refreshes (layout loaded)
    if (!cfg || !cfg.entity) {
      this._mowerLive = null;
      this.card._view.mowerOnFloor = false;
      this._refreshMowerTrack(null);
      return;
    }
    const floorId = this._mowerFloor();
    this.card._view.mowerOnFloor = cfg.ground === "floor";
    const reading = readSource(this.card._hass.states[cfg.entity], cfg);
    let p: PlanPoint | null =
      reading && this._mowerFn ? this._mowerFn(reading) : null;
    // docked: at the dock object, turned as it is; not found: the last known position (else the dock),
    // never some default spot
    const dk = this._dockedNow();
    const dock = this.card._objects ? this.card._objects.dockPose() : null;
    let fixed: { heading?: number | null } | null = null;
    this._mowerAt = p ? "live" : null;
    if (dk.docked && dock) {
      p = [dock.x, dock.y];
      fixed = dock;
      this._mowerAt = "dock";
    } else if (!p) {
      const last = lastPosition(LAST_KEY);
      if (last && last.entity === cfg.entity) {
        p = [last.x, last.y];
        fixed = { heading: last.heading };
        this._mowerAt = "last";
      } else if (dock) {
        p = [dock.x, dock.y];
        fixed = dock;
        this._mowerAt = "dock-start";
      }
    }
    this._mowerLive = p
      ? { x: p[0], y: p[1], floorId, reading }
      : reading
        ? { reading }
        : null;
    this._refreshMowerTrack(cfg, floorId, dk.docked);
    this._poseMowerObject(p, floorId, fixed);
    if (p && this._mowerAt !== "dock-start")
      rememberPosition(LAST_KEY, {
        x: p[0],
        y: p[1],
        heading: this._mowerHeading ?? null,
        entity: cfg.entity,
      });
    this.card._refreshAttached(); // markers attached to the mower ride along
    const id = this.card._mowerMarkerId,
      positions = this.card._positions;
    if (p && id && positions) {
      const pos = {
        x: p[0],
        y: p[1],
        z: this._mowerZ(p[0], p[1], floorId),
        floorId,
        auto: false,
        live: true,
      };
      const prev = positions.get(id);
      positions.set(id, pos);
      if (!this.card._view.markerObjects.has(id)) {
        this.card._buildMarkers();
        this.card._refreshStates();
      } else if (
        !prev ||
        prev.x !== pos.x ||
        prev.y !== pos.y ||
        prev.z !== pos.z ||
        prev.floorId !== floorId
      ) {
        this.card._view.moveMarker(id, pos.x, pos.y, pos.z, floorId); // only when it actually moved
      }
    }
    this._updateMowerWarning();
  }

  // ---------- warning over the mower (error / stuck) ----------
  // The lawn_mower state entity: the bound mower object's, else the one of the position entity's device.
  _mowerStateEntity(): string | null {
    const cfg = this.card._layout && this.card._layout.mower;
    if (!cfg || !cfg.entity) return null;
    const o = this.card._objects && this.card._objects.mowerEntity();
    if (o) return o;
    if (cfg.entity.startsWith("lawn_mower.")) return cfg.entity;
    const h = this.card._hass,
      reg = h && h.entities && h.entities[cfg.entity];
    if (reg && reg.device_id) {
      const sib = Object.keys(h.entities).find(
        (e) =>
          e.startsWith("lawn_mower.") &&
          h.entities[e].device_id === reg.device_id,
      );
      if (sib) return sib;
    }
    return cfg.entity;
  }

  // Red warning on error, yellow when mowing but not moving.
  _updateMowerWarning(): void {
    clearTimeout(this._stuckTimer ?? undefined);
    this._stuckTimer = null;
    const cfg = this.card._layout && this.card._layout.mower,
      h = this.card._hass,
      view = this.card._view;
    if (!view) return;
    if (!cfg || !cfg.entity || !h) {
      this._stuck = null;
      this._warning = null;
      view.setMowerWarning(null);
      view.setMowerChip(null);
      return;
    }
    const mse = this._mowerStateEntity();
    const ms = mse ? h.states[mse] : undefined,
      ee = this._errorEntity(),
      es = ee ? h.states[ee] : null;
    const live = this._mowerLive,
      pos: PlanPoint | null =
        live && live.x !== undefined ? [live.x, live.y] : null;
    const minutes =
      cfg.stuck_minutes === undefined
        ? STUCK_DEFAULT_MIN
        : Number(cfg.stuck_minutes) || 0;
    const now = Date.now();
    // offline, or waiting for the rain to stop: a chip next to the mower, the stuck clock paused
    const conn = connectivity(h, mse),
      rn = rain(h, mse);
    const offline = !!conn && conn.online === false;
    const chip = offline
      ? { kind: "offline", icon: "mdi:wifi-off", text: "offline" }
      : rn && rn.wet
        ? { kind: "rain", icon: "mdi:weather-rainy", text: "rain" }
        : rn && rn.drying !== null
          ? {
              kind: "drying",
              icon: "mdi:weather-partly-rainy",
              text: `${rn.drying} min`,
            }
          : null;
    this._mowerChip = chip;
    view.setMowerChip(
      chip && live && live.x !== undefined
        ? { ...chip, x: live.x, y: live.y, floorId: live.floorId }
        : null,
    );
    this._mowerOffline = offline;
    if (this.card._objects) this.card._objects.setMowerDim(offline);
    const paused = offline || (rn && (rn.wet || rn.drying !== null));
    this._stuck = stuckStep(this._stuck, {
      now,
      pos,
      state: paused ? "paused" : ms && ms.state,
      minutes,
    });
    const kind =
      (offline ? null : errorKind(ms, es, cfg.ok_values)) ||
      (this._stuck.stuck ? "stuck" : null);
    this._warning = kind ? { kind, minutes } : null;
    if (kind && live && live.x !== undefined)
      view.setMowerWarning({
        kind,
        x: live.x,
        y: live.y,
        floorId: live.floorId,
      });
    else view.setMowerWarning(null);
    const due = stuckDueIn(this._stuck, now, minutes);
    if (due !== null && this.card.isConnected)
      this._stuckTimer = setTimeout(
        () => this._updateMowerWarning(),
        due + 100,
      );
    if (this.card._popup && this.card._popup.el) this.card._popup.update();
  }

  // Popup row for the warning: { label, value } or null.
  _warningText(): { label: string; value: string } | null {
    const w = this._warning,
      h = this.card._hass,
      cfg = this.card._layout && this.card._layout.mower;
    if (!w || !h || !cfg) return null;
    if (
      w.kind === "stuck" &&
      !(this._mowerLive && this._mowerLive.x !== undefined)
    )
      return { label: "Position", value: "no position reading" };
    if (w.kind === "stuck")
      return { label: "Stuck?", value: `no movement for ${w.minutes} min` };
    const ee = this._errorEntity();
    const mse = this._mowerStateEntity();
    return {
      label: "Error",
      value:
        errorText(
          mse ? h.states[mse] : undefined,
          ee ? h.states[ee] : null,
          cfg.ok_values,
        ) || "error",
    };
  }

  // layout.mower.error_entity, else an error code sensor of the mower's device.
  _errorEntity(): string | null {
    const cfg = this.card._layout && this.card._layout.mower;
    if (!cfg || !this.card._hass) return null;
    if (cfg.error_entity) return cfg.error_entity;
    return findErrorEntity(this.card._hass, this._mowerStateEntity());
  }

  // Docked with a mower and a dock object: { mower, dock } ids (one object for taps, dots and the popup), else null.
  _dockGroup(): ReturnType<typeof mowerDockGroup> | null {
    const l = this.card._objects;
    if (!l || !l.model || !this.card._hass) return null;
    const mowerId = l.mowerId();
    if (!mowerId) return null;
    return mowerDockGroup({
      docked: this._dockedNow().docked,
      mowerId,
      dockId: l.dockId(),
    });
  }

  // The mower's docked state: lawn_mower docked / charging or its "Mower status" sensor. -> { docked, word }
  _dockedNow(): { docked: boolean; word: ReturnType<typeof dockWord> } {
    const h = this.card._hass,
      mse = this._mowerStateEntity();
    const ms = mse && h && h.states[mse];
    const se = mse && findStatusEntity(h, mse),
      ss = se && h.states[se];
    const a = ms && ms.state,
      b = ss && ss.state;
    return { docked: isDocked(a, b), word: dockWord(a, b) };
  }

  // "Mowed" text from a progress sensor of the mower's device (null when there is none).
  mapInfo(): { mowed: string | null } {
    const cfg = this.card._layout && this.card._layout.mower;
    const prog =
      cfg && cfg.entity
        ? findProgress(this.card._hass, this._mowerStateEntity())
        : null;
    const pv = prog ? progressValue(this.card._hass, prog) : null;
    return { mowed: pv !== null ? `${Math.round(pv * 100)} %` : null };
  }

  // Mower marker height above its HA floor: MOWER_Z over the ground under it (the lawn of the model,
  // cached per 0.5 m cell), so a garden floor at an odd elevation does not lift it off the lawn.
  _mowerZ(x: number, y: number, floorId: string): number {
    const g = this.card._view.mowerGround(x, y, floorId);
    return g === null
      ? MOWER_Z
      : g - this.card._view.floorElevation(floorId) + MOWER_Z;
  }

  // A bound mower object follows the live position; heading from the last real movement (> 5 cm).
  // fixed: { heading } of the dock / the last known pose (no heading from movement).
  _poseMowerObject(
    p: number[] | null,
    floorId: string,
    fixed: { heading?: number | null } | null = null,
  ): void {
    const layer = this.card._objects;
    if (!layer || !layer.mowerBound()) {
      this._mowerHeadFrom = null;
      layer?.setMowerPose(null);
      return;
    }
    if (!p) return;
    const from = this._mowerHeadFrom;
    if (fixed) {
      if (typeof fixed.heading === "number" && Number.isFinite(fixed.heading))
        this._mowerHeading = fixed.heading;
      this._mowerHeadFrom = [p[0], p[1]];
    } else if (!from) this._mowerHeadFrom = [p[0], p[1]];
    else if (Math.hypot(p[0] - from[0], p[1] - from[1]) > HEADING_STEP_M) {
      this._mowerHeading = Math.atan2(p[1] - from[1], p[0] - from[0]);
      this._mowerHeadFrom = [p[0], p[1]];
    }
    layer.setMowerPose({
      x: p[0],
      y: p[1],
      floorId,
      heading: this._mowerHeading,
      ground: this.card._view.mowerGround(p[0], p[1], floorId),
    });
  }
}
