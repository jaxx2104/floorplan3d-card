// Markup helpers shared by the edit panel's tabs.

import { platformOf, entityOptionLabel } from '../badges.ts';
import type { EditMode } from '../edit-mode.ts';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// Clipboard API needs a secure context (HA over plain http has none): fall back to a hidden textarea.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok: boolean;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}
export const fmt = (v: number): string => (Math.round(v * 100) / 100).toString();

// Every edit-mode slider: a range plus a number input with the same min / max / step and the unit after
// it. The panel keeps them in sync (syncSliderNumber / commitSliderNumber); the range carries data-field.
export function sliderHtml(field: string, label: string, min: number, max: number, step: number, value: unknown, unit = ''): string {
  const v = Number(value);
  return `<label class="slider"><span class="lab">${label}</span><span class="slrow">
    <input type="range" data-field="${field}" min="${min}" max="${max}" step="${step}" value="${v}">
    <input type="text" inputmode="decimal" pattern="-?[0-9]*[.,]?[0-9]*" class="slnum" data-num-for="${field}" min="${min}" max="${max}" step="${step}" value="${fmt(v)}" aria-label="${label}"><span class="unit">${unit}</span></span></label>`; // the unit column also keeps unitless rows aligned
}

// <option> of an entity datalist: value = entity id, label = "<name> · <Integration>"
export function entOption(ed: EditMode, eid: string): string {
  return `<option value="${esc(eid)}" label="${esc(entityOptionLabel(ed.hass, eid))}">`;
}

// fixed 16 px box in a list row; decorateLogos fills it with the entity's integration logo
export function logoBox(ed: EditMode, eid: string | null | undefined): string {

  return `<span class="lg" data-lg="${esc((eid && platformOf(ed.hass.entities, eid)) || '')}"></span>`;
}
