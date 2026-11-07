// Sky of the card: day / night mode, the sun from sun.sun, the moon, clouds from the weather entity,
// the Day / night button, and night_markers.

import { moonPosition } from "../sky.ts";
import {
  sunVector,
  nightFactor,
  clampSunDir,
  sunStrength,
} from "../objects/logic.ts";
import { weatherEntity, cloudCoverage, windSpeed } from "../weather.ts";
import type { Floorplan3dCard } from "../card-impl.ts";
import type { CardConfig } from "../types/config.ts";
import type { SkyState } from "../view/look.ts";
import type { SkyBody } from "../view/sky.ts";

declare global {
  interface Window {
    /** Tests and the demo: the current time (Date or ms) instead of Date.now(). */
    __demoNow?: Date | number | null;
  }
}

export const MOON_EVERY_MS: number = 60000;
const DAY_SUN: [number, number] = [200, 40]; // manual Day: sun azimuth / elevation (deg)
const NIGHT_MOON: [number, number] = [160, 35]; // manual Night: moon azimuth / elevation

export type SkyMode = "auto" | "day" | "night";

export function readSkyMode(): SkyMode {
  try {
    const v = localStorage.getItem("floorplan3d.sky");
    if (v === "auto" || v === "day" || v === "night") return v;
  } catch (e) {
    /* storage blocked */
  }
  return "auto";
}

export class SkyController {
  card: Floorplan3dCard;
  _daylight: boolean;
  _skyMode: SkyMode;
  _skyLast: SkyState | null;
  _sunNow: { elevation: number; azimuth: number } | null | undefined;
  _moonAt: number | undefined;
  _weatherId: string | null | undefined;
  _weatherScanAt: number | undefined;
  _skyTimer: ReturnType<typeof setInterval> | null | undefined;
  _wakeTimer: ReturnType<typeof setTimeout> | null | undefined;
  // the toolbar's Day / night button (wire, from the card's _render)
  _dayBtn: HTMLButtonElement | undefined;

  /** @param card the Floorplan3dCard (host): read live, never captured */
  constructor(card: Floorplan3dCard) {
    this.card = card;
    this._daylight = true;
    this._skyMode = readSkyMode();
    this._skyLast = null;
    this._sunNow = undefined; // for the checks
    this._moonAt = undefined;
    this._weatherId = undefined;
    this._weatherScanAt = undefined;
    this._skyTimer = undefined;
    this._wakeTimer = undefined;
    this._dayBtn = undefined;
  }

  // The Day / night button of the toolbar (card _render).
  wire(root: ShadowRoot): void {
    const dayBtn = (this._dayBtn =
      root.querySelector<HTMLButtonElement>("button.daynight")!);
    dayBtn.addEventListener("click", () => {
      this._skyMode = ({ auto: "day", day: "night", night: "auto" } as const)[
        this._skyMode
      ];
      try {
        localStorage.setItem("floorplan3d.sky", this._skyMode);
      } catch (e) {
        /* private mode */
      }
      this._applySky(true);
      this.card._syncToolbar();
    });
  }

  // connectedCallback: the moon moves without hass updates.
  resume(): void {
    clearInterval(this._skyTimer ?? undefined);
    this._skyTimer = setInterval(() => this._applySky(false), MOON_EVERY_MS);
  }

  dispose(): void {
    clearTimeout(this._wakeTimer ?? undefined);
    this._wakeTimer = null;
    clearInterval(this._skyTimer ?? undefined);
    this._skyTimer = null;
  }

  // No model: the Day / night toggle is hidden, so always day.
  resetDay(): void {
    this._daylight = true;
    this.card._view.setDaylight(true);
  }

  // Option weather may have changed: the entity is looked up again.
  resetWeather(): void {
    this._weatherId = undefined;
  }

  // Option night_markers: 'hide' -> at night (sun down, or the night toggle) markers fade out so the lit rooms
  // carry the plan; alerts stay. A touch, wheel or key shows them for idle_reset seconds (30 without it).
  _syncNightMarkers(): void {
    if (!this.card._stage) return;
    const quiet =
      !!this.card._config &&
      this.card._config.night_markers === "hide" &&
      this._daylight === false;
    this.card._stage.classList.toggle("night-quiet", quiet);
    this.card._syncMarkerMode();
  }

  _wakeMarkers(): void {
    if (
      !this.card._stage ||
      !this.card._config ||
      this.card._config.night_markers !== "hide"
    )
      return;
    this.card._stage.classList.add("awake");
    this.card._syncMarkerMode();
    clearTimeout(this._wakeTimer ?? undefined);
    const r = this.card._config.idle_reset,
      sec = r && r > 0 ? r : 30;
    this._wakeTimer = setTimeout(() => {
      this._wakeTimer = null;
      if (this.card._stage) this.card._stage.classList.remove("awake");
      this.card._syncMarkerMode();
    }, sec * 1000);
  }

  _paintDayBtn(): void {
    const btn = this._dayBtn!; // the card paints its toolbar after _render wired it
    const icon = {
      auto: "mdi:theme-light-dark",
      day: "mdi:white-balance-sunny",
      night: "mdi:weather-night",
    }[this._skyMode];
    const el = btn.querySelector("ha-icon");
    if (el && el.getAttribute("icon") !== icon) el.setAttribute("icon", icon);
    btn.title = `Day / night: ${this._skyMode}`;
  }

  // Auto reads sun.sun; setSky only when night moved > 0.01 or the sun > 1 degree since the last call.
  // Sun / moon sprites: with the sun change, else the moon at most every 60 s (option sky_bodies).
  _applySky(force: boolean): void {
    const v = this.card._view;
    if (!v || !v.model) return;
    const c = this.card._hass && this.card._hass.config;
    const north = v.model.north || 0,
      rot = this.card._modelAlign().rotation || 0;
    let sky: SkyState = { night: 0, sunDir: null },
      sunBody: SkyBody | null = null,
      auto = false;
    if (this._skyMode === "night") sky = { night: 1, sunDir: null };
    else if (this._skyMode === "day")
      sunBody = { dir: sunVector(...DAY_SUN, north, rot) };
    else {
      auto = true;
      const a =
        this.card._hass &&
        this.card._hass.states &&
        this.card._hass.states["sun.sun"];
      const el = a ? Number(a.attributes.elevation) : NaN,
        az = a ? Number(a.attributes.azimuth) : NaN;
      this._sunNow =
        Number.isFinite(el) && Number.isFinite(az)
          ? { elevation: el, azimuth: az }
          : null; // for the checks
      if (Number.isFinite(el) && Number.isFinite(az)) {
        const dir = sunVector(az, el, north, rot);
        sky = {
          night: nightFactor(el),
          sunDir: clampSunDir(dir),
          sun: sunStrength(el),
        };
        sunBody = { dir };
      }
    }
    const l = this._skyLast;
    const sd = sky.sunDir;
    const same =
      !force &&
      l &&
      Math.abs(l.night - sky.night) <= 0.01 &&
      Math.abs((l.sun ?? 1) - (sky.sun ?? 1)) <= 0.01 &&
      !!l.sunDir === !!sky.sunDir &&
      (!sd ||
        Math.acos(
          Math.max(
            -1,
            Math.min(
              1,
              l.sunDir![0] * sd[0] +
                l.sunDir![1] * sd[1] +
                l.sunDir![2] * sd[2],
            ),
          ),
        ) <=
          Math.PI / 180); // both set (checked above)
    const now = this._now();
    if (same && !(auto && now - (this._moonAt ?? -Infinity) >= MOON_EVERY_MS))
      return;
    if (!same) {
      this._skyLast = sky;
      this._daylight = sky.night < 0.5;
      this._syncNightMarkers();
      v.setSky(sky);
    }
    let moonBody: SkyBody | null = null;
    if (this._skyMode === "night")
      moonBody = {
        dir: sunVector(...NIGHT_MOON, north, rot),
        phase: 0.4,
        illumination: 0.8,
      };
    else if (auto) {
      const m = c
        ? moonPosition(now, Number(c.latitude), Number(c.longitude))
        : null;
      if (m && c)
        moonBody = {
          dir: sunVector(m.azimuth, m.elevation, north, rot),
          phase: m.phase,
          illumination: m.illumination,
          latitude: Number(c.latitude),
        };
    }
    this._moonAt = now;
    v.setSkyBodies({
      sun: sunBody,
      moon: moonBody,
      north: sunVector(0, 0, north, rot),
      on: this.card._config.sky_bodies !== false,
    });
  }

  // Cloud coverage of the weather entity (option weather, default the first weather.* entity) to the view;
  // the view re-applies only when it moved >= 5 points. The default entity is looked up again only when
  // it disappears (at most every 30 s while there is none).
  _applyWeather(): void {
    const v = this.card._view,
      states = this.card._hass && this.card._hass.states;
    if (!v || !states) return;
    const c: Partial<CardConfig> = this.card._config || {};
    let id = this._weatherId;
    if (typeof c.weather === "string" || c.weather === false)
      id = weatherEntity(c, states);
    else if (!id || !states[id]) {
      const now = this._now();
      if (id === undefined || id || now - (this._weatherScanAt || 0) >= 30000) {
        this._weatherScanAt = now;
        id = weatherEntity(c, states);
      }
    }
    this._weatherId = id;
    v.setWeather({
      coverage: id ? cloudCoverage(states[id]) : 0,
      clouds: c.clouds !== false,
      condition: id && states[id] ? states[id].state : null,
      wind: id ? windSpeed(states[id]) : 0,
    });
  }

  // Current time; tests set window.__demoNow (Date or ms).
  _now(): number {
    const t = typeof window !== "undefined" ? window.__demoNow : undefined;
    if (t !== undefined && t !== null)
      return t instanceof Date ? t.getTime() : Number(t);
    return Date.now();
  }
}
