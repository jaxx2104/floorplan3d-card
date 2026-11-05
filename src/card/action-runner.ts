// HA actions run from the card (taps, holds, popup links): handed to HA's frontend as a `hass-action`
// event (toggle, more-info, navigate, url, perform-action, assist, with HA's confirmation dialog and
// haptics); messages as HA toasts (`hass-notification`). The card itself runs only `popup`.

import { hassActionDetail, normAction, validateAction } from "../actions.ts";
import type { Floorplan3dCard } from "../card-impl.ts";

/** An action as actions.ts takes it (HA's { action, ... } shape, or a bare action name). */
export type CardAction = Parameters<typeof normAction>[0];
/** Where an action runs: the entity toggle / more-info act on, the model object it came from. */
export interface ActionContext {
  entity?: string | null;
  objectId?: string;
}

/** What the runner reads of the card (the card itself; a narrow view for fakes). */
export type ActionHost = Pick<
  Floorplan3dCard,
  "_hass" | "dispatchEvent" | "_openObjectPopup"
>;

export class ActionRunner {
  card: ActionHost;

  /** @param card the Floorplan3dCard (host): read live, never captured */
  constructor(card: ActionHost) {
    this.card = card;
  }

  _fire(type: string, detail: unknown): void {
    this.card.dispatchEvent(
      new CustomEvent(type, { detail, bubbles: true, composed: true }),
    );
  }

  // One HA action: `popup` here, a missing field as a toast, the rest to HA's frontend.
  _runAction(action: CardAction, ctx: ActionContext): void {
    const a = normAction(action);
    if (!a || a.action === "none") return;
    const missing = validateAction(a);
    if (missing) {
      this._notify(missing);
      return;
    }
    if (a.action === "popup") {
      if (ctx.objectId) this.card._openObjectPopup(ctx.objectId);
      else if (ctx.entity) this._moreInfo(ctx.entity);
      return;
    }
    this._fire("hass-action", hassActionDetail(a, ctx.entity));
  }

  // A direct service call (popup controls): HA's hass.callService reports a failure as a toast itself.
  _callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
  ): void {
    if (!this.card._hass) return;
    try {
      const p = this.card._hass.callService(domain, service, data);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      // reported by HA
    }
  }

  // An HA toast (e.g. an action missing a field).
  _notify(message: string): void {
    this._fire("hass-notification", { message });
  }

  _moreInfo(entityId: string | null): void {
    this._runAction("more-info", { entity: entityId });
  }
}
