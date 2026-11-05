// Tab definition types: kept apart from index.ts, which imports every tab (no cycle).

import type { EditMode } from "../../edit-mode.ts";
import type { View } from "../html.ts";

export type TabId =
  "rooms" | "devices" | "objects" | "mower" | "views" | "model" | "data";

export interface TabDef {
  id: TabId;
  label: string;
  /** the tab body: a template with its event bindings */
  view: (ed: EditMode) => View;
  /** shows live entity states: re-rendered (once per frame) on hass updates */
  live?: boolean;
}
