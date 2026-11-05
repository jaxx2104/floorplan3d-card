// An entity's icon as HA draws it: <ha-state-icon> (HA's icon rules and icon translations, by state and
// device class; the entity registry icon wins) with the card's override; where HA's element is not
// defined (the demo, a page without HA's frontend) or the entity has no state, <ha-icon> with iconFor.

import { iconFor } from "../registry.ts";
import type { Hass, HassEntity } from "../types/ha.ts";

type StateIconEl = HTMLElement & {
  hass?: Hass;
  stateObj?: HassEntity;
  icon?: string;
};

const SEL = ":scope > ha-state-icon, :scope > ha-icon";

/** The icon element of host (made or swapped as first child when needed), painted for entityId. */
export function paintStateIcon(
  host: Element,
  hass: Hass,
  entityId: string,
  override?: string | null,
): void {
  const st = hass.states[entityId];
  const tag =
    st && customElements.get("ha-state-icon") ? "ha-state-icon" : "ha-icon";
  let el = host.querySelector<StateIconEl>(SEL);
  if (!el || el.localName !== tag) {
    const n = document.createElement(tag) as StateIconEl;
    if (el) el.replaceWith(n);
    else host.prepend(n);
    el = n;
  }
  if (tag === "ha-state-icon") {
    if (el.hass !== hass) el.hass = hass;
    if (el.stateObj !== st) el.stateObj = st;
    const ic = override || undefined;
    if (el.icon !== ic) el.icon = ic;
    return;
  }
  const ic = override || iconFor(hass, entityId);
  if (el.getAttribute("icon") !== ic) el.setAttribute("icon", ic);
}
