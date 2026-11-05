// Layout persistence.
// 1. floorplan3d companion integration (shared across all users and devices)
// 2. frontend user data (stored in HA, but per user)
// 3. browser localStorage (last resort)

import { logLayoutWarnings, parseLayout, serializeLayout } from './schema/layout.ts';
import type { Hass } from './types/ha.ts';
import type { Layout } from './types/layout.ts';

/** Where layouts are saved: the companion integration, HA user data, or this browser. */
export type StorageBackend = 'shared' | 'user' | 'browser';

export class LayoutStore {
  key: string;
  backend: StorageBackend | null;
  _timer: ReturnType<typeof setTimeout> | null;
  _pending: ((ok: boolean) => void) | null;

  constructor(key?: string | null) {
    this.key = key || 'default';
    this.backend = null;
    this._timer = null;
    this._pending = null;
  }

  async load(hass: Pick<Hass, 'callWS'>): Promise<Layout> {
    let shared: unknown;
    try {
      const r = await hass.callWS<{ layout?: unknown } | null>({ type: 'floorplan3d/layout/get', key: this.key });
      shared = r && r.layout;
      this.backend = 'shared';
    } catch (e) { /* integration not installed */ }
    // nothing shared yet: pick up a layout made before the integration was installed,
    // the next save moves it to shared storage
    if (this.backend === 'shared' && shared) return this._parse(shared);
    const user = await this._userData(hass);
    if (!this.backend) this.backend = user.ok ? 'user' : 'browser';
    return this._parse(user.value || this._browser());
  }

  // Stored JSON -> the current layout version (migrated, defaults filled); problems go to the console.
  _parse(stored: unknown): Layout {
    const p = parseLayout(stored);
    logLayoutWarnings(`layout "${this.key}":`, p);
    return p.value;
  }

  async _userData(hass: Pick<Hass, 'callWS'>): Promise<{ ok: boolean; value: unknown }> {
    try {
      const r = await hass.callWS<{ value?: unknown } | null>({ type: 'frontend/get_user_data', key: 'floorplan3d_' + this.key });
      return { ok: true, value: r && r.value };
    } catch (e) {
      return { ok: false, value: null };
    }
  }

  _browser(): unknown {
    try {
      return JSON.parse(localStorage.getItem('floorplan3d_' + this.key) || 'null');
    } catch (e) {
      return null;
    }
  }

  save(hass: Pick<Hass, 'callWS'>, layout: Layout, delay = 600): Promise<boolean> {
    clearTimeout(this._timer ?? undefined);
    // a newer save replaces this one; settle the old promise so callers don't hang
    if (this._pending) this._pending(false);
    return new Promise<boolean>((resolve) => {
      this._pending = resolve;
      this._timer = setTimeout(async () => {
        this._pending = null;
        const data = serializeLayout(layout);
        try {
          if (this.backend === 'shared') {
            await hass.callWS({ type: 'floorplan3d/layout/set', key: this.key, layout: data });
          } else if (this.backend === 'user') {
            await hass.callWS({ type: 'frontend/set_user_data', key: 'floorplan3d_' + this.key, value: data });
          } else {
            localStorage.setItem('floorplan3d_' + this.key, JSON.stringify(data));
          }
          resolve(true);
        } catch (e) {
          console.error('floorplan3d: save failed', e);
          resolve(false);
        }
      }, delay);
    });
  }
}
