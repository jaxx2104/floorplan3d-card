// floorplan3d-card: Home Assistant Lovelace card showing a 3D floorplan with auto-placed devices.
// This entry is a thin shell, loaded on every HA page: it answers HA's card API (config, size, grid,
// editor, picker entry) itself and imports the real card (./card-impl.ts, three.js and all) only when
// a card is first shown, then hosts it as a floorplan3d-card-impl child and forwards config and hass.
// Keep it free of three and of the card's modules: test/entry-size.test.js guards the size.

import type { CardConfig } from "./types/config.ts";
import type { Hass } from "./types/ha.ts";

const VERSION = "0.0.0-dev";

/** What the shell forwards to: the part of floorplan3d-card-impl it uses. */
interface CardImpl extends HTMLElement {
  setConfig(config: CardConfig): void;
  hass: Hass;
  layout?: string;
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
    "floorplan3d-card": Floorplan3dCardShell;
  }
  interface Window {
    customCards?: CustomCardEntry[];
  }
}

const DEFAULT_HEIGHT = "520px";
// sections view grid: a row is 56 px plus an 8 px gap
const GRID_ROW_PX = 64;
const GRID_ROWS = 8;
const GRID_MIN_ROWS = 4;

/** Sections view rows for a configured height: px heights rounded to rows, others the default. */
export function gridRows(height: unknown): number {
  const m = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(String(height ?? ""));
  if (!m) return GRID_ROWS;
  return Math.max(GRID_MIN_ROWS, Math.round((Number(m[1]) + 8) / GRID_ROW_PX));
}

// One import for every card on the page.
let implLoad: Promise<unknown> | null = null;
const loadImpl = (): Promise<unknown> =>
  (implLoad ||= import("./card-impl.ts").catch((e: unknown) => {
    implLoad = null; // a later connect tries again
    throw e;
  }));

export class Floorplan3dCardShell extends HTMLElement {
  _config: CardConfig | null = null;
  _hass: Hass | null = null;
  _impl: CardImpl | null = null;
  _loading = false;
  /** HA's layout of the card's place: "grid" in a sections view (the card fills its grid cell). */
  _haLayout: string | undefined = undefined;

  static getStubConfig(): Partial<CardConfig> {
    return {};
  }

  static async getConfigElement(): Promise<HTMLElement> {
    await import("./card-editor.ts");
    return document.createElement("floorplan3d-card-editor");
  }

  // sections view: span the whole section, rows from `height` (resizable there; the card fills them)
  getGridOptions(): {
    columns: string;
    min_columns: number;
    rows: number;
    min_rows: number;
  } {
    return {
      columns: "full",
      min_columns: 6,
      rows: gridRows(this._config?.height),
      min_rows: GRID_MIN_ROWS,
    };
  }

  // HA sets layout = "grid" on cards in a sections view: fill the cell, `height` is for masonry views.
  set layout(v: string | undefined) {
    this._haLayout = v;
    this._applyLayout();
    if (this._impl) this._impl.layout = v;
  }

  get layout(): string | undefined {
    return this._haLayout;
  }

  _applyLayout(): void {
    const grid = this._haLayout === "grid";
    this.style.height = grid ? "100%" : "";
    // the card's place while it loads (a grid cell has its own size)
    this.style.minHeight =
      this._impl || grid || !this._config
        ? ""
        : this._config.height || DEFAULT_HEIGHT;
  }

  getCardSize(): number {
    return Math.ceil(parseInt(this._config?.height as string, 10) / 50) || 10; // NaN (no config) -> 10
  }

  setConfig(config: CardConfig): void {
    if (!config || typeof config !== "object")
      throw new Error("Invalid configuration");
    this._config = config;
    this.style.display = "block";
    if (this._impl) this._impl.setConfig(config);
    this._applyLayout();
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
    loadImpl().then(
      () => {
        this._loading = false;
        if (this._impl || !this._config) return;
        this.replaceChildren();
        const impl = document.createElement(
          "floorplan3d-card-impl",
        ) as unknown as CardImpl;
        impl.style.display = "block";
        impl.layout = this._haLayout;
        // config first (the card renders on connect once it has one), then hass
        impl.setConfig(this._config);
        if (this._hass) impl.hass = this._hass;
        this._impl = impl;
        this._applyLayout();
        this.append(impl);
      },
      (e: unknown) => {
        this._loading = false;
        const line = document.createElement("div");
        line.style.cssText =
          "padding:8px 16px;color:var(--error-color,#db4437)";
        line.textContent = `Floorplan 3D failed to load: ${e instanceof Error ? e.message : String(e)}`;
        this.replaceChildren(line);
      },
    );
  }
}

if (!customElements.get("floorplan3d-card")) {
  customElements.define("floorplan3d-card", Floorplan3dCardShell);
  const cards = (window.customCards = window.customCards || []);
  cards.push({
    type: "floorplan3d-card",
    name: "Floorplan 3D",
    description: "3D floorplan with automatically placed devices",
    preview: false,
  });
  console.info(
    `%c floorplan3d-card ${VERSION} `,
    "background:#03a9f4;color:#fff;border-radius:3px",
  );
}
