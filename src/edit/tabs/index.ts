// The edit panel's tabs and the act / field registry their buttons and inputs dispatch through.
//
// Tab shape: { id, html(ed), acts?: { [data-act]: fn(ed, btn) }, fields?: { [data-field]: fn(ed, el) } (change),
// inputs?: { [data-field]: fn(ed, el) } (input, exact), ranges?: { [prefix]: fn(ed, el) } (input on a range whose
// data-field starts with the prefix), live?(ed) (state updates while the tab is shown) }.
// An act handler returning 'render' re-syncs the stage classes and re-renders the panel afterwards.
// Dispatch goes by name, not by the active tab: some buttons are rendered outside their own tab (the Rooms
// list links to the Model tab; the tab bar itself).

import type { EditMode } from '../../edit-mode.ts';
import { roomsTabDef } from './rooms.ts';
import { devicesTabDef } from './devices.ts';
import { objectsTabDef } from './objects.ts';
import { mowerTabDef } from './mower.ts';
import { viewsTabDef } from './views.ts';
import { modelTabDef } from './model.ts';
import { dataTabDef } from './data.ts';

export type { TabId, ActResult, ActHandler, FieldEl, FieldHandler, EditPart, TabDef } from './tab.ts';
import type { TabDef, TabId, ActHandler, FieldHandler, EditPart, FieldEl } from './tab.ts';

export const TABS: TabDef[] = [roomsTabDef, devicesTabDef, objectsTabDef, mowerTabDef, viewsTabDef, modelTabDef, dataTabDef];
export const TAB_BY_ID = Object.fromEntries(TABS.map((t) => [t.id, t])) as Record<TabId, TabDef>; // every id is in TABS

export interface Registry {
  acts: Map<string, ActHandler>;
  fields: Map<string, FieldHandler>;
  inputs: Map<string, FieldHandler>;
  ranges: Map<string, FieldHandler>;
}

// One Map per kind over all parts; a name registered twice is a bug (one handler would be dead): throw.
export function buildRegistry(parts: EditPart[]): Registry {
  const reg: Registry = { acts: new Map(), fields: new Map(), inputs: new Map(), ranges: new Map() };
  const add = <H>(kind: string, map: Map<string, H>, part: EditPart, handlers: Record<string, H> | undefined) => {
    for (const [name, fn] of Object.entries(handlers || {})) {
      if (map.has(name)) throw new Error(`floorplan3d: duplicate edit ${kind} handler "${name}" (${part.id})`);
      map.set(name, fn);
    }
  };
  for (const part of parts) {
    add('acts', reg.acts, part, part.acts);
    add('fields', reg.fields, part, part.fields);
    add('inputs', reg.inputs, part, part.inputs);
    add('ranges', reg.ranges, part, part.ranges);
  }
  return reg;
}

// Click on a [data-act] button: every click clears the message first; unknown acts do nothing.
export function dispatchAct(ed: EditMode, reg: Registry, act: string, btn: HTMLElement) {
  ed.message = null;
  const fn = reg.acts.get(act);
  if (!fn) return;
  if (fn(ed, btn) === 'render') {
    ed._syncStageClasses();
    ed.render();
  }
}

export function dispatchField(ed: EditMode, reg: Registry, el: FieldEl) {
  const fn = el.dataset.field === undefined ? undefined : reg.fields.get(el.dataset.field);
  if (fn) fn(ed, el);
}

// input events: an exact name first, then a range's prefix
export function dispatchInput(ed: EditMode, reg: Registry, el: FieldEl) {
  const f = el.dataset.field;
  if (!f) return;
  const fn = reg.inputs.get(f);
  if (fn) { fn(ed, el); return; }
  if (el.type !== 'range') return;
  for (const [prefix, h] of reg.ranges) {
    if (f.startsWith(prefix)) { h(ed, el); return; }
  }
}
