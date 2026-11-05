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

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
// whenDefined with a timeout (false: not there in time)
const defined = (tag: string, ms: number): Promise<boolean> =>
  Promise.race([
    customElements.whenDefined(tag).then(() => true),
    wait(ms).then(() => false),
  ]);

let selectorLoad: Promise<boolean> | null = null;

/**
 * Loads HA's lazy <ha-selector> (the edit panel's pickers): the tile card's editor pulls in ha-form, a
 * hidden ha-form with a selector field pulls in ha-selector. -> whether it is there now (false outside HA).
 */
export function loadSelectors(hass: unknown): Promise<boolean> {
  if (customElements.get("ha-selector")) return Promise.resolve(true);
  if (selectorLoad) return selectorLoad;
  selectorLoad = (async () => {
    try {
      if (!customElements.get("ha-form")) {
        const card = await createCard({ type: "tile", entity: "sun.sun" });
        const ctor = card
          ? (card.constructor as { getConfigElement?: () => Promise<unknown> })
          : null;
        if (ctor && typeof ctor.getConfigElement === "function")
          await ctor.getConfigElement();
      }
      if (customElements.get("ha-form")) {
        const form = document.createElement("ha-form") as HTMLElement &
          Record<string, unknown>;
        Object.assign(form, {
          hass,
          schema: [{ name: "entity", selector: { entity: {} } }],
          data: {},
        });
        form.style.display = "none";
        document.body.append(form);
        await defined("ha-selector", 5000);
        form.remove();
      }
    } catch {
      /* not HA's frontend: native inputs */
    }
    return !!customElements.get("ha-selector");
  })();
  return selectorLoad;
}
