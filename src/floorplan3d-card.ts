// floorplan3d-card: Home Assistant Lovelace card showing a 3D floorplan with auto-placed devices.
// This entry is a thin shell, loaded on every HA page: it answers HA's card API (config, size, grid,
// editor, picker entry) itself and imports the real card (./card-impl.ts, three.js and all) only when
// a card is first shown, then hosts it as a floorplan3d-card-impl child and forwards config and hass.
// Keep it free of three and of the card's modules: test/entry-size.test.js guards the size.

import type { CardConfig } from './types/config.ts';
import type { Hass } from './types/ha.ts';

const VERSION = '0.0.0-dev';

/** What the shell forwards to: the part of floorplan3d-card-impl it uses. */
interface CardImpl extends HTMLElement {
  setConfig(config: CardConfig): void;
  hass: Hass;
}

/** An entry of HA's custom card picker (window.customCards). */
export interface CustomCardEntry {
  type: string;
  name: string;
  description?: string;
  preview?: boolean;
}

declare global {
  interface HTMLElementTagNameMap {
    'floorplan3d-card': Floorplan3dCardShell;
  }
  interface Window {
    customCards?: CustomCardEntry[];
  }
}

const DEFAULT_HEIGHT = '520px';

// One import for every card on the page.
let implLoad: Promise<unknown> | null = null;
const loadImpl = (): Promise<unknown> => (implLoad ||= import('./card-impl.ts').catch((e: unknown) => {
  implLoad = null; // a later connect tries again
  throw e;
}));

export class Floorplan3dCardShell extends HTMLElement {
  _config: CardConfig | null = null;
  _hass: Hass | null = null;
  _impl: CardImpl | null = null;
  _loading = false;

  static getStubConfig(): Partial<CardConfig> {
    return {};
  }

  static async getConfigElement(): Promise<HTMLElement> {
    await import('./card-editor.ts');
    return document.createElement('floorplan3d-card-editor');
  }

  // sections view: span the whole section by default
  getGridOptions(): { columns: string; min_columns: number; rows: string } {
    return { columns: 'full', min_columns: 6, rows: 'auto' };
  }

  getCardSize(): number {
    return Math.ceil(parseInt(this._config?.height as string, 10) / 50) || 10; // NaN (no config) -> 10
  }

  setConfig(config: CardConfig): void {
    if (!config || typeof config !== 'object') throw new Error('Invalid configuration');
    this._config = config;
    this.style.display = 'block';
    if (this._impl) this._impl.setConfig(config);
    else this.style.minHeight = config.height || DEFAULT_HEIGHT; // the card's place while it loads
    if (this.isConnected) this._ensure();
  }

  set hass(hass: Hass) {
    this._hass = hass;
    if (this._impl) this._impl.hass = hass;
  }

  get hass(): Hass | null {
    return this._hass;
  }

  connectedCallback(): void {
    this._ensure();
  }

  _ensure(): void {
    if (this._impl || this._loading || !this._config) return;
    this._loading = true;
    loadImpl().then(() => {
      this._loading = false;
      if (this._impl || !this._config) return;
      this.replaceChildren();
      const impl = document.createElement('floorplan3d-card-impl') as unknown as CardImpl;
      impl.style.display = 'block';
      // config first (the card renders on connect once it has one), then hass
      impl.setConfig(this._config);
      if (this._hass) impl.hass = this._hass;
      this._impl = impl;
      this.style.minHeight = '';
      this.append(impl);
    }, (e: unknown) => {
      this._loading = false;
      const line = document.createElement('div');
      line.style.cssText = 'padding:8px 16px;color:var(--error-color,#db4437)';
      line.textContent = `Floorplan 3D failed to load: ${e instanceof Error ? e.message : String(e)}`;
      this.replaceChildren(line);
    });
  }
}

if (!customElements.get('floorplan3d-card')) {
  customElements.define('floorplan3d-card', Floorplan3dCardShell);
  const cards = (window.customCards = window.customCards || []);
  cards.push({
    type: 'floorplan3d-card',
    name: 'Floorplan 3D',
    description: '3D floorplan with automatically placed devices',
    preview: false,
  });
  console.info(`%c floorplan3d-card ${VERSION} `, 'background:#03a9f4;color:#fff;border-radius:3px');
}
