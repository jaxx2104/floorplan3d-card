// The edit panel's tabs and the act / field registry their buttons and inputs dispatch through.
//
// Tab shape: { id, html(ed), acts?: { [data-act]: fn(ed, btn) }, fields?: { [data-field]: fn(ed, el) } (change),
// inputs?: { [data-field]: fn(ed, el) } (input, exact), ranges?: { [prefix]: fn(ed, el) } (input on a range whose
// data-field starts with the prefix), live?(ed) (state updates while the tab is shown) }.
// An act handler returning 'render' re-syncs the stage classes and re-renders the panel afterwards.
// Dispatch goes by name, not by the active tab: some buttons are rendered outside their own tab (the Rooms
// list links to the Model tab; the tab bar itself).

import { roomsTabDef } from './rooms.js';
import { devicesTabDef } from './devices.js';
import { objectsTabDef } from './objects.js';
import { mowerTabDef } from './mower.js';
import { viewsTabDef } from './views.js';
import { modelTabDef } from './model.js';
import { dataTabDef } from './data.js';

export const TABS = [roomsTabDef, devicesTabDef, objectsTabDef, mowerTabDef, viewsTabDef, modelTabDef, dataTabDef];
export const TAB_BY_ID = Object.fromEntries(TABS.map((t) => [t.id, t]));

// One Map per kind over all parts; a name registered twice is a bug (one handler would be dead): throw.
export function buildRegistry(parts) {
  const reg = { acts: new Map(), fields: new Map(), inputs: new Map(), ranges: new Map() };
  for (const part of parts) {
    for (const kind of Object.keys(reg)) {
      for (const [name, fn] of Object.entries(part[kind] || {})) {
        if (reg[kind].has(name)) throw new Error(`floorplan3d: duplicate edit ${kind} handler "${name}" (${part.id})`);
        reg[kind].set(name, fn);
      }
    }
  }
  return reg;
}

// Click on a [data-act] button: every click clears the message first; unknown acts do nothing.
export function dispatchAct(ed, reg, act, btn) {
  ed.message = null;
  const fn = reg.acts.get(act);
  if (!fn) return;
  if (fn(ed, btn) === 'render') {
    ed._syncStageClasses();
    ed.render();
  }
}

export function dispatchField(ed, reg, el) {
  const fn = reg.fields.get(el.dataset.field);
  if (fn) fn(ed, el);
}

// input events: an exact name first, then a range's prefix
export function dispatchInput(ed, reg, el) {
  const f = el.dataset.field;
  if (!f) return;
  const fn = reg.inputs.get(f);
  if (fn) { fn(ed, el); return; }
  if (el.type !== 'range') return;
  for (const [prefix, h] of reg.ranges) {
    if (f.startsWith(prefix)) { h(ed, el); return; }
  }
}
