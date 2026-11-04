// The edit side panel: its element and listeners, the slider + number pairs (renders held while a slider
// is dragged or its number typed), rendering with scroll / focus / open details kept, logos, save state,
// and the dispatch of panel clicks / changes / inputs through the tabs' registry.

import * as E from '../editor.ts';
import { platformOf } from '../badges.ts';
import { setLogo } from '../badge-dom.ts';
import { closePicker } from './tools/map-tools.ts';
import { closeMenu } from './tools/view-menu.ts';
import { objectsAvailable } from './tabs/objects.ts';
import { TABS, TAB_BY_ID, buildRegistry, dispatchAct, dispatchField, dispatchInput } from './tabs/index.ts';
import { esc, fmt } from './html.ts';
import type { EditPart, FieldEl, TabId } from './tabs/index.ts';
import type { EditMode } from '../edit-mode.ts';

// The tab bar (rendered on every tab).
const panelPart: EditPart = {
  id: 'panel',
  acts: {
    tab: (ed, btn) => {
      const id = btn.dataset.id as TabId; // the tab bar's buttons carry a tab id
      if (id !== ed.tab) {
        closePicker(ed);
        ed.picking = null;
        ed.pivoting = false;
        ed.modelPick = null;
        ed.vwPick = null;
        closeMenu(ed);
        ed.view.highlightModelNode(null);
      }
      if (id !== 'objects') ed.objSel = null;
      if (id !== 'devices') ed.stick = null;
      ed.tab = id;
      ed._syncStageClasses();
      return 'render';
    },
  },
};

export const REGISTRY = buildRegistry([panelPart, ...TABS]);

// Panel events come from its own controls: the target is an element (an input for the field paths).
const fieldOf = (e: Event): FieldEl => e.target as FieldEl;

export function createPanel(ed: EditMode): HTMLDivElement {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.addEventListener('click', (e) => onPanelClick(ed, e));
  panel.addEventListener('change', (e) => onPanelChange(ed, e));
  panel.addEventListener('input', (e) => onPanelInput(ed, e));
  const syncLogoOf = (e: Event) => { const t = fieldOf(e); if (t.matches && t.matches('.entin > input[list]')) syncLogo(ed, t); };
  panel.addEventListener('input', syncLogoOf);
  panel.addEventListener('change', syncLogoOf);
  // rebuilding the panel under a dragged slider would drop the drag: hold renders until release
  panel.addEventListener('pointerdown', (e) => { if (fieldOf(e).type === 'range') ed._sliding = true; });
  const release = () => releaseSlider(ed);
  // a number input left without a change (nothing typed): release a render held while it was edited
  // arrow keys in a slider's number: one step, applied at once
  panel.addEventListener('keydown', (e) => {
    const num = fieldOf(e);
    if (!num.dataset || !num.dataset.numFor) return;
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(ed._numTimer); commitSliderNumber(ed, num); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const cur = Number(String(num.value).replace(',', '.'));
    const step = Number(num.getAttribute('step')) || 1, min = num.getAttribute('min'), max = num.getAttribute('max');
    const v = E.sliderValue((Number.isFinite(cur) ? cur : Number(min) || 0) + (e.key === 'ArrowUp' ? step : -step), min, max, step);
    if (v === null) return;
    num.value = fmt(v);
    ed._sliding = true; // hold renders; saved 400 ms after the last key
    clearTimeout(ed._numTimer);
    const field = num.dataset.numFor;
    ed._numTimer = setTimeout(() => {
      const el = num.isConnected ? num : ed.panel.querySelector<HTMLInputElement>(`input.slnum[data-num-for="${field}"]`);
      if (el) { el.value = fmt(v); commitSliderNumber(ed, el); }
    }, 400);
  });
  panel.addEventListener('focusout', (e) => { const t = fieldOf(e); if (t.dataset && t.dataset.numFor) setTimeout(release, 0); });
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  panel.addEventListener('change', (e) => { if (fieldOf(e).type === 'range') release(); });
  return panel;
}

export function releaseSlider(ed: EditMode) {
  if (!ed._sliding) return;
  ed._sliding = false;
  if (ed._renderHeld) { ed._renderHeld = false; ed.render(); }
}

export function setSaveState(ed: EditMode, s: string) {
  ed.saveState = s;
  const el = ed.panel.querySelector('.save-state');
  if (el) el.textContent = saveText(ed);
  else ed.render();
}

// ---------- panel ----------
const SAVE_TEXT: Record<string, string> = { saving: 'Saving…', saved: 'Saved', failed: 'Save failed' };
export function saveText(ed: EditMode): string {
  return SAVE_TEXT[ed.saveState] || '';
}

export function render(ed: EditMode) {
  // a rebuild must not move the panel under the user: keep scroll position and the focused control
  const oldBody = ed.panel.querySelector('.tab-body');
  const scroll = oldBody && ed._renderedTab === ed.tab ? oldBody.scrollTop : 0;
  const focused = (ed.panel.getRootNode() as Document | ShadowRoot).activeElement as HTMLElement | null; // the panel lives in the card's shadow root
  const active = ed.panel.contains(focused) ? focused : null;
  const focusKey = active && active.dataset && (active.dataset.field || active.dataset.numFor)
    ? [active.dataset.field ? 'field' : 'numFor', active.dataset.field || active.dataset.numFor, active.dataset.id || ''] as const : null;
  const report = ed.panel.querySelector<HTMLDetailsElement>('details.report');
  if (report) ed._reportOpen = report.open;
  const adv = ed.panel.querySelector<HTMLDetailsElement>('details.advanced');
  if (adv) ed._advancedOpen = adv.open;
  ed._renderedTab = ed.tab;
  const hasObjects = objectsAvailable(ed);
  if (ed.tab === 'objects' && !hasObjects) ed.tab = 'devices';
  const tabs: [TabId, string][] = [['rooms', 'Rooms'], ['devices', 'Devices'], ...(hasObjects ? [['objects', 'Objects'] as [TabId, string]] : []), ['mower', 'Mower'], ['views', 'Views'], ['model', 'Model'], ['data', 'Data']];
  const body = TAB_BY_ID[ed.tab].html(ed);
  const msg = ed.message ? `<div class="msg ${ed.message.error ? 'error' : ed.message.warn ? 'warn' : ''}">${esc(ed.message.text)}</div>` : '';
  ed.panel.innerHTML = `
      <div class="tabs">${tabs.map(([id, label]) => `<button data-act="tab" data-id="${id}" class="${ed.tab === id ? 'on' : ''}">${label}</button>`).join('')}</div>
      <div class="tab-body">${msg}${body}</div>
      <div class="foot"><span class="save-state">${saveText(ed)}</span><span>${esc(backendLabel(ed))}</span></div>`;
  decorateLogos(ed);
  const newBody = ed.panel.querySelector('.tab-body');
  if (newBody && scroll) newBody.scrollTop = scroll;
  if (focusKey) {
    const el = [...ed.panel.querySelectorAll<HTMLElement>(focusKey[0] === 'field' ? '[data-field]' : '[data-num-for]')]
      .find((x) => x.dataset[focusKey[0]] === focusKey[1] && (x.dataset.id || '') === focusKey[2]);
    if (el) el.focus({ preventScroll: true });
  }
}

// Integration logos in the panel: list rows (.lg) and a box inside every entity input (input[list]).
export function decorateLogos(ed: EditMode) {
  const dark = !!(ed.card._built && ed.card._built.theme && ed.card._built.theme.dark);
  for (const box of ed.panel.querySelectorAll<HTMLElement>('.lg[data-lg]')) setLogo(box, box.dataset.lg, dark, true);
  for (const inp of ed.panel.querySelectorAll<HTMLInputElement>('input[list]')) {
    if (inp.getAttribute('list') === 'fp-tag-names') continue;
    const parent = inp.parentElement!; // inside the panel
    if (!parent.classList || !parent.classList.contains('entin')) {
      const wrap = document.createElement('span');
      wrap.className = 'entin';
      wrap.innerHTML = '<span class="lg"></span>';
      parent.insertBefore(wrap, inp);
      wrap.append(inp);
    }
    syncLogo(ed, inp);
  }
}

export function syncLogo(ed: EditMode, inp: HTMLInputElement) {
  const box = inp.previousElementSibling;
  if (!box || !box.classList.contains('lg')) return;
  const dark = !!(ed.card._built && ed.card._built.theme && ed.card._built.theme.dark);
  setLogo(box, platformOf(ed.hass.entities, inp.value.trim()), dark, true);
}

const BACKEND_LABEL: Record<string, string> = { shared: 'Shared storage', user: 'Per-user storage', browser: 'Browser storage' };
export function backendLabel(ed: EditMode): string {
  const b = ed.card._store.backend;
  return (b && BACKEND_LABEL[b]) || '';
}


// The number next to a slider follows it (while dragging too).
export function syncSliderNumber(ed: EditMode, range: HTMLInputElement) {
  const num = range.parentElement && range.parentElement.querySelector<HTMLInputElement>(`input.slnum[data-num-for="${range.dataset.field}"]`);
  if (num && num !== (ed.panel.getRootNode() as Document | ShadowRoot).activeElement) num.value = fmt(Number(range.value));
}

// A number typed next to a slider (Enter / blur / arrow step): clamp + round, set the slider and run the
// slider's own input + change path; not a number -> back to the slider's value.
export function commitSliderNumber(ed: EditMode, num: HTMLInputElement) {
  const range = num.parentElement && num.parentElement.querySelector<HTMLInputElement>(`input[type=range][data-field="${num.dataset.numFor}"]`);
  if (!range) return;
  const v = E.sliderValue(num.value, range.min, range.max, range.step);
  if (v === null) { num.value = fmt(Number(range.value)); releaseSlider(ed); return; }
  num.value = fmt(v);
  range.value = String(v);
  range.dispatchEvent(new Event('input', { bubbles: true }));
  range.dispatchEvent(new Event('change', { bubbles: true })); // releases a held render
}

// live values of the shown tab (Mower), without re-rendering the panel
export function onStates(ed: EditMode) {
  const t = TAB_BY_ID[ed.tab];
  if (t && t.live) t.live(ed);
}

export function onPanelClick(ed: EditMode, e: Event) {
  const btn = (e.target as Element).closest<HTMLButtonElement>('[data-act]');
  if (!btn || btn.disabled) return;
  dispatchAct(ed, REGISTRY, btn.dataset.act || '', btn);
}

export function onPanelChange(ed: EditMode, e: Event) {
  const el = fieldOf(e);
  if (el.dataset.numFor) { commitSliderNumber(ed, el); return; }
  dispatchField(ed, REGISTRY, el);
}

// sliders update the overlay live, without re-rendering the panel under the pointer
export function onPanelInput(ed: EditMode, e: Event) {
  const el = fieldOf(e);

  if (el.dataset.numFor) { ed._sliding = true; return; } // typing: hold renders until Enter / blur
  if (el.type === 'range') syncSliderNumber(ed, el);
  dispatchInput(ed, REGISTRY, el);
}
