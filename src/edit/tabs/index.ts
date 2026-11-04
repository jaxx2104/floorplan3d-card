// Every edit tab in panel order.

import { roomsTabDef } from './rooms.ts';
import { devicesTabDef } from './devices.ts';
import { objectsTabDef } from './objects.ts';
import { mowerTabDef } from './mower.ts';
import { viewsTabDef } from './views.ts';
import { modelTabDef } from './model.ts';
import { dataTabDef } from './data.ts';

export type { TabId, TabDef } from './tab.ts';
import type { TabDef, TabId } from './tab.ts';

export const TABS: TabDef[] = [roomsTabDef, devicesTabDef, objectsTabDef, mowerTabDef, viewsTabDef, modelTabDef, dataTabDef];
export const TAB_BY_ID = Object.fromEntries(TABS.map((t) => [t.id, t])) as Record<TabId, TabDef>; // every id is in TABS
