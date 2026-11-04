// Data tab: storage backend, JSON export / import.

import * as E from '../../editor.ts';
import { LEVEL_SPACING } from '../../layout.ts';
import { html } from 'lit';
import { act, field } from '../html.ts';
import type { TemplateResult } from 'lit';
import type { TabDef } from './tab.ts';
import type { EditMode } from '../../edit-mode.ts';

export function dataTab(ed: EditMode): TemplateResult {
  const b = ed.card._store.backend;
  const infos: Record<string, [string, string]> = {
    shared: ['ok', 'Shared: stored by the floorplan3d integration, every user and device sees the same layout.'],
    user: ['warn', 'Per user: stored in your HA user data. Other users will not see this layout. Install the floorplan3d integration to share it.'],
    browser: ['warn', 'This browser only: other browsers and devices will not see this layout. Install the floorplan3d integration to share it.'],
  };
  const info = (b && infos[b]) || ['warn', 'Storage not loaded yet.'];
  return html`<div class="sub">Storage</div><p class="note ${info[0]}">${info[1]}</p>
      <div class="sub">Export / import</div>
      <p class="hint">The layout is plain JSON (rooms in metres, x east, y north). Importing replaces the current layout.</p>
      <div class="row"><button @click=${act(ed, () => exportLayout(ed))}>Export JSON</button>
      <label class="button">Import JSON<input type="file" accept="application/json,.json" name="import" hidden @change=${(e: Event) => importFile(ed, field(e))}></label></div>`;
}

export function importFile(ed: EditMode, el: HTMLInputElement) {
  const file = el.files && el.files[0];
  el.value = ''; // picking the same file again must fire change again
  if (file) file.text().then((text) => importLayout(ed, text));
}

export function importLayout(ed: EditMode, text: string) {
  try {
    const raw: Record<string, unknown> = JSON.parse(text); // parseImport below rejects anything but an object
    const parsed = E.parseImport(text);
    const haFloors = Object.values(ed.hass.floors || {}).map((f) => ({ id: f.floor_id, elevation: (f.level ?? 0) * LEVEL_SPACING }));
    const fit = E.fitImport(parsed, haFloors, Object.keys(ed.hass.areas || {}));
    const { floorMap, unknownAreas } = fit;
    // the uploaded model, the mower setup and view settings missing from the file: keep ours
    const l = E.mergeImport(fit.layout, raw, ed.layout);
    ed.selectedRoom = null;
    ed.selectedMarker = null;
    const parts = [`Imported ${l.rooms.length} rooms, ${Object.keys(l.pins).length} pins.`];
    const mapped = Object.entries(floorMap);
    if (mapped.length) {
      const floors = ed.hass.floors || {};
      const name = (id: string) => (floors[id] && floors[id].name) || id;
      parts.push('Floors mapped to Home Assistant: ' + mapped.map(([a, b]) => `${a} → ${name(b)}`).join(', ') + '.');
    }
    if (unknownAreas.length) {
      parts.push(`${unknownAreas.length} area id${unknownAreas.length === 1 ? ' is' : 's are'} not in Home Assistant (${unknownAreas.join(', ')}): ` +
        'pick the area for those rooms under Rooms → "Rooms without an HA area", or create the areas.');
    }
    ed.message = { text: parts.join(' '), error: false, warn: unknownAreas.length > 0 };
    ed.commit(l);
  } catch (err) {
    ed.message = { text: (err as Error).message, error: true };
    ed.render();
  }
}

export function exportLayout(ed: EditMode) {
  const blob = new Blob([JSON.stringify(ed.layout, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `floorplan3d-${ed.card._config.layout_key}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const dataTabDef: TabDef = { id: 'data', label: 'Data', view: dataTab };
