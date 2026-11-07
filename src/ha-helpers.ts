// Home Assistant's frontend helpers: window.loadCardHelpers() (HA's own cards, e.g. the tile card
// with its features). Absent outside HA (unit tests; the demo page installs a stand-in).
import type { Hass } from "./types/ha.ts";

/** An HA card element (hui-tile-card ...): a custom element taking hass. */
export interface HaCardElement extends HTMLElement {
  hass?: Hass | unknown;
  setConfig?(config: Record<string, unknown>): void;
}
export interface CardHelpers {
  createCardElement(
    config: Record<string, unknown>,
  ): HaCardElement | Promise<HaCardElement>;
}

declare global {
  interface Window {
    loadCardHelpers?: () => Promise<CardHelpers>;
  }
}

let helpers: Promise<CardHelpers | null> | null = null;

/** HA's card helpers, null without them (cached once window.loadCardHelpers was there). */
export function cardHelpers(): Promise<CardHelpers | null> {
  if (helpers) return helpers;
  const load = typeof window !== "undefined" ? window.loadCardHelpers : null;
  if (typeof load !== "function") return Promise.resolve(null);
  helpers = Promise.resolve()
    .then(() => load())
    .catch(() => null);
  return helpers;
}

/** An HA card for config, null when the helpers are missing or the card fails. */
export async function createCard(
  config: Record<string, unknown>,
): Promise<HaCardElement | null> {
  const h = await cardHelpers();
  if (!h) return null;
  try {
    return await h.createCardElement(config);
  } catch {
    return null;
  }
}
