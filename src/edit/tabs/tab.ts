// Tab definition types and defineTab: kept apart from index.ts, which imports every tab (no cycle).

import type { EditMode } from '../../edit-mode.ts';

export type TabId = 'rooms' | 'devices' | 'objects' | 'mower' | 'views' | 'model' | 'data';

/** What an act handler may ask for: 'render' re-syncs the stage classes and re-renders the panel. */
export type ActResult = 'render' | void;
export type ActHandler = (ed: EditMode, btn: HTMLElement) => ActResult;
/** Panel form controls carry data-field / data-id / ...; the handler reads the control it was given. */
export type FieldEl = HTMLInputElement; // inputs and selects, read through the members they share (value, dataset, ...)
export type FieldHandler = (ed: EditMode, el: FieldEl) => void;

export interface EditPart {
  id: string;
  acts?: Record<string, ActHandler>;
  fields?: Record<string, FieldHandler>;
  inputs?: Record<string, FieldHandler>;
  ranges?: Record<string, FieldHandler>;
}

export interface TabDef extends EditPart {
  id: TabId;
  html: (ed: EditMode) => string;
  live?: (ed: EditMode) => void;
}

/** Checks a tab definition against TabDef without widening it (the id stays a literal). */
export const defineTab = <T extends TabDef>(t: T): T => t;
