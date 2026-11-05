// Layout persistence. The floorplan3d companion integration is the only place layouts are saved
// (shared across all users and devices). Read order:
// 1. the companion integration
// 2. frontend user data (per user; older versions saved there): read-only, for migration
// 3. browser localStorage (older versions without HA storage): read-only, for migration
// A layout read from 2. or 3. while the integration is installed moves to it with the next save;
// without the integration the layout is shown but edits are not saved.

import {
  logLayoutWarnings,
  parseLayout,
  serializeLayout,
} from "./schema/layout.ts";
import type { Hass } from "./types/ha.ts";
import type { Layout } from "./types/layout.ts";

/** Where the layout was read from: the companion integration (the only writable one), HA user data, or this browser. */
export type StorageBackend = "shared" | "user" | "browser";

export class LayoutStore {
  key: string;
  backend: StorageBackend | null;
  _timer: ReturnType<typeof setTimeout> | null;
  _pending: ((ok: boolean) => void) | null;

  constructor(key?: string | null) {
    this.key = key || "default";
    this.backend = null;
    this._timer = null;
    this._pending = null;
  }

  /** Saves go through: the companion integration answered. */
  get writable(): boolean {
    return this.backend === "shared";
  }

  async load(hass: Pick<Hass, "callWS">): Promise<Layout> {
    let shared: unknown;
    try {
      const r = await hass.callWS<{ layout?: unknown } | null>({
        type: "floorplan3d/layout/get",
        key: this.key,
      });
      shared = r && r.layout;
      this.backend = "shared";
    } catch (e) {
      /* integration not installed */
    }
    // nothing shared yet: pick up a layout made before the integration was installed,
    // the next save moves it to shared storage
    if (this.backend === "shared" && shared) return this._parse(shared);
    const user = await this._userData(hass);
    if (!this.backend) this.backend = user.ok ? "user" : "browser";
    return this._parse(user.value || this._browser());
  }

  // Stored JSON -> the current layout version (migrated, defaults filled); problems go to the console.
  _parse(stored: unknown): Layout {
    const p = parseLayout(stored);
    logLayoutWarnings(`layout "${this.key}":`, p);
    return p.value;
  }

  async _userData(
    hass: Pick<Hass, "callWS">,
  ): Promise<{ ok: boolean; value: unknown }> {
    try {
      const r = await hass.callWS<{ value?: unknown } | null>({
        type: "frontend/get_user_data",
        key: "floorplan3d_" + this.key,
      });
      return { ok: true, value: r && r.value };
    } catch (e) {
      return { ok: false, value: null };
    }
  }

  _browser(): unknown {
    try {
      return JSON.parse(
        localStorage.getItem("floorplan3d_" + this.key) || "null",
      );
    } catch (e) {
      return null;
    }
  }

  save(
    hass: Pick<Hass, "callWS">,
    layout: Layout,
    delay = 600,
  ): Promise<boolean> {
    clearTimeout(this._timer ?? undefined);
    // a newer save replaces this one; settle the old promise so callers don't hang
    if (this._pending) this._pending(false);
    return new Promise<boolean>((resolve) => {
      this._pending = resolve;
      this._timer = setTimeout(async () => {
        this._pending = null;
        if (!this.writable) {
          console.warn(
            "floorplan3d: layout not saved, the floorplan3d integration is not installed",
          );
          resolve(false);
          return;
        }
        try {
          await hass.callWS({
            type: "floorplan3d/layout/set",
            key: this.key,
            layout: serializeLayout(layout),
          });
          resolve(true);
        } catch (e) {
          console.error("floorplan3d: save failed", e);
          resolve(false);
        }
      }, delay);
    });
  }
}
