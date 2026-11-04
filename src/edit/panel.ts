// The edit side panel: its element, the tab bar, save state and storage backend, and rendering. The panel
// is a lit-html template rendered into one element; lit keeps the DOM it does not need to change, so
// focus, scroll, open <details> and a dragged slider survive re-renders. Renders are coalesced:
// requestRender() renders once at the end of the current task (or once per frame for hass updates).

import { html, nothing, render } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { keyed } from 'lit/directives/keyed.js';
import { closePicker } from './tools/map-tools.ts';
import { closeMenu } from './tools/view-menu.ts';
import { objectsAvailable } from './tabs/objects.ts';
import { TABS, TAB_BY_ID } from './tabs/index.ts';
import { act } from './html.ts';
import type { TemplateResult } from 'lit';
import type { TabId } from './tabs/index.ts';
import type { EditMode } from '../edit-mode.ts';

export function createPanel(): HTMLDivElement {
  const panel = document.createElement('div');
  panel.className = 'panel';
  return panel;
}

const raf = (fn: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));

// One render for any number of requests: 'frame' (hass updates) waits for the next frame, else the
// render runs as a microtask after the current handler (and the commit it made) is done.
export function requestRender(ed: EditMode, when: 'soon' | 'frame' = 'soon') {
  if (ed._renderQueued === 'soon') return;
  if (when === 'soon') {
    ed._renderQueued = 'soon';
    queueMicrotask(() => { if (ed._renderQueued === 'soon') renderNow(ed); });
    return;
  }
  if (ed._renderQueued === 'frame') return;
  ed._renderQueued = 'frame';
  raf(() => { if (ed._renderQueued === 'frame') renderNow(ed); });
}

// Renders at once (callers that scroll to a row they just made visible).
export function renderNow(ed: EditMode) {
  ed._renderQueued = null;
  if (ed.tab === 'objects' && !objectsAvailable(ed)) ed.tab = 'devices';
  render(panelView(ed), ed.panel);
}

export function switchTab(ed: EditMode, id: TabId) {
  if (id !== ed.tab) {
    closePicker(ed);
    ed.picking = null;
    ed.pivoting = false;
    ed.modelPick = null;
    ed.vwPick = null;
    closeMenu(ed);
    ed.view.highlightModelNode(null);
    ed.drafts.clear();
  }
  if (id !== 'objects') ed.objSel = null;
  if (id !== 'devices') ed.stick = null;
  ed.tab = id;
}

export function setSaveState(ed: EditMode, s: string) {
  ed.saveState = s;
  requestRender(ed);
}

const SAVE_TEXT: Record<string, string> = { saving: 'Saving…', saved: 'Saved', failed: 'Save failed' };
export function saveText(ed: EditMode): string {
  return SAVE_TEXT[ed.saveState] || '';
}

const BACKEND_LABEL: Record<string, string> = { shared: 'Shared storage', user: 'Per-user storage', browser: 'Browser storage' };
export function backendLabel(ed: EditMode): string {
  const b = ed.card._store.backend;
  return (b && BACKEND_LABEL[b]) || '';
}

// hass updates: re-render a tab that shows live states (Mower), at most once per frame
export function onStates(ed: EditMode) {
  if (TAB_BY_ID[ed.tab].live) requestRender(ed, 'frame');
}

export function panelView(ed: EditMode): TemplateResult {
  const hasObjects = objectsAvailable(ed);
  const tabs = TABS.filter((t) => t.id !== 'objects' || hasObjects);
  const m = ed.message;
  const msg = m ? html`<div class=${classMap({ msg: true, error: !!m.error, warn: !m.error && !!m.warn })}>${m.text}</div>` : nothing;
  // a tab gets its own body element: switching tabs starts at the top
  return html`
      <div class="tabs">${tabs.map((t) => html`<button class=${classMap({ on: ed.tab === t.id })} @click=${act(ed, () => switchTab(ed, t.id))}>${t.label}</button>`)}</div>
      ${keyed(ed.tab, html`<div class="tab-body">${msg}${TAB_BY_ID[ed.tab].view(ed)}</div>`)}
      <div class="foot"><span class="save-state">${saveText(ed)}</span><span>${backendLabel(ed)}</span></div>`;
}
