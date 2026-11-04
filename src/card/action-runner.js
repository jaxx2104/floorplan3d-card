// HA actions run from the card (taps, holds, popup links): service calls with failures as a toast,
// more-info, navigation, URLs, Assist, and the in-card confirmation.

import { actionCall } from '../actions.js';

// HA frontend navigation: push the path and tell the router.
function navigate(path, replace = false) {
  if (replace) window.history.replaceState(window.history.state, '', path);
  else window.history.pushState(null, '', path);
  window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace } }));
}

export class ActionRunner {
  /** @param {object} card the Floorplan3dCard (host): read live, never captured */
  constructor(card) {
    this.card = card;
    this._confirmEl = undefined;
    this._confirmKey = undefined;
    this._toastTimer = undefined; // not cleared on disconnect (the toast hides itself)
  }

  dispose() {
    this._closeConfirm(); // its window keydown listener
  }

  // Runs one HA action (after the in-card confirmation when it asks for one).
  _runAction(action, ctx) {
    const call = actionCall(action, { entity: ctx.entity || null, userId: (this.card._hass && this.card._hass.user && this.card._hass.user.id) || null });
    if (call.kind === 'none') return;
    if (call.kind === 'error') { this._toast(call.message); return; }
    if (call.confirm) this._confirm(call.confirm, () => this._execCall(call, ctx));
    else this._execCall(call, ctx);
  }

  _execCall(call, ctx) {
    switch (call.kind) {
      case 'service':
        this._callService(call.domain, call.service, call.data, call.target);
        break;
      case 'more-info': this._moreInfo(call.entityId); break;
      case 'navigate': navigate(call.path, call.replace); break;
      case 'url':
        if (call.newTab) window.open(call.url, '_blank', 'noopener');
        else window.location.assign(call.url);
        break;
      case 'assist':
        // HA's frontend runs actions fired as hass-action (opens the Assist dialog)
        this.card.dispatchEvent(new CustomEvent('hass-action', { detail: { config: { tap_action: call.action }, action: 'tap' }, bubbles: true, composed: true }));
        break;
      case 'popup':
        if (ctx.objectId) this.card._openObjectPopup(ctx.objectId);
        else if (ctx.entity) this._moreInfo(ctx.entity);
        break;
      default:
    }
  }

  // hass.callService with a failure (rejected promise or a throw) shown as a toast, never unhandled.
  _callService(domain, service, data, target) {
    if (!this.card._hass) return;
    const fail = (err) => this._toast((err && err.message) || 'Action failed');
    try {
      const p = target ? this.card._hass.callService(domain, service, data, target) : this.card._hass.callService(domain, service, data);
      if (p && typeof p.catch === 'function') p.catch(fail);
    } catch (err) {
      fail(err);
    }
  }

  // A short message at the bottom of the stage (e.g. an action missing a field).
  _toast(text) {
    if (!this.card._toastEl) return;
    this.card._toastEl.textContent = text;
    this.card._toastEl.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this.card._toastEl.hidden = true; }, 4000);
  }

  // In-card confirmation (never a browser dialog). OK runs ok(); Cancel, Esc or a new one drops it.
  _confirm(text, ok) {
    this._closeConfirm();
    const el = document.createElement('div');
    el.className = 'fp-confirm';
    el.setAttribute('role', 'dialog');
    el.innerHTML = '<div class="fp-confirm-text"></div><div class="fp-confirm-btns"><button data-c="no">Cancel</button><button data-c="yes" class="primary">OK</button></div>';
    el.querySelector('.fp-confirm-text').textContent = text;
    for (const t of ['pointerdown', 'pointerup', 'pointermove', 'click', 'contextmenu', 'wheel']) el.addEventListener(t, (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      const c = e.target.dataset && e.target.dataset.c;
      if (!c) return;
      this._closeConfirm();
      if (c === 'yes') ok();
    });
    this._confirmKey = (e) => { if (e.key === 'Escape') this._closeConfirm(); };
    window.addEventListener('keydown', this._confirmKey);
    this._confirmEl = el;
    this.card._stage.append(el);
    el.querySelector('[data-c=yes]').focus();
  }

  _closeConfirm() {
    if (!this._confirmEl) return;
    window.removeEventListener('keydown', this._confirmKey);
    this._confirmEl.remove();
    this._confirmEl = null;
  }

  _moreInfo(entityId) {
    this.card.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId }, bubbles: true, composed: true }));
  }
}
