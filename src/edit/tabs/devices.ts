// Devices tab: the selected marker, stick to surfaces, badges, unplaced and hidden devices.

import * as E from "../../editor.ts";
import { buildMarkers, areaName, type Marker } from "../../registry.ts";
import {
  surfaceKind,
  surfaceSearch,
  stickSurface,
  nearestDistance,
  needsStick,
  worldOf,
  planOf,
} from "../../surface.ts";
import { html, nothing } from "lit/html.js";
import { repeat } from "lit/directives/repeat.js";
import { act, checkField, field, fmt, logoBox, selectField } from "../html.ts";
import type { TemplateResult } from "lit/html.js";
import type { TabDef } from "./tab.ts";
import type { EditMode, StickMove } from "../../edit-mode.ts";
import type { Layout, LayoutPin, Vec3 } from "../../types/layout.ts";
import type { BadgeOptions } from "../../badges.ts";

export function allMarkers(ed: EditMode): Marker[] {
  return buildMarkers(
    ed.hass,
    { ...ed.layout, hidden: [] },
    { group_by: ed.card._config.group_by },
  );
}

// Badge toggles (layout.badges); keys set in the card YAML `badges:` win and are shown disabled.
export function badgesView(ed: EditMode): TemplateResult {
  const o = ed.card.badgeOpts(),
    yaml = ((ed.card._config && ed.card._config.badges) || {}) as Record<
      string,
      unknown
    >; // YAML: read per key below
  const row = (k: keyof BadgeOptions, label: string) => {
    const fixed = typeof yaml[k] === "boolean";
    return checkField(ed, {
      name: "badge",
      id: k,
      dataKey: k,
      label,
      checked: !!o[k],
      disabled: fixed,
      note: fixed ? html` <span class="dim">(card YAML)</span>` : nothing,
      onChange: (v) => setBadge(ed, k, v),
    });
  };
  const th = String(ed.layout.tap_hints || "near");
  return html`<div class="sub">Badges</div>${row("integration", "Show integration logos")}${row("status", "Show status")}${row("battery", "Show low battery")}
      ${selectField(ed, {
        name: "tap-hints",
        cls: "tap-hints",
        label: "Tap hints",
        value: th,
        options: [
          ["always", "Always"],
          ["near", "Near pointer"],
          ["off", "Off"],
        ],
        onChange: (v) => setTapHints(ed, v),
      })}
      <p class="hint">Dots on tappable model objects: filled when a tap works, hollow grey when it is offline or a controller is off.</p>`;
}

function selectedView(ed: EditMode, m: Marker): TemplateResult {
  const pos = ed.card._positions && ed.card._positions.get(m.id);
  const pin = ed.layout.pins[m.id];
  const pinned = !!pin;
  const attached = pin && pin.attach;
  const target = attached
    ? ed.card._objects && ed.card._objects.objectAt(attached)
    : null;
  const done = html`<button @click=${act(ed, () => ed.selectMarker(null))}>Done</button>`;
  if (m.id === ed.card._mowerMarkerId) {
    return html`<section class="box"><h3>${m.name}</h3><p class="dim">${m.entityId}</p>
          <p>Follows the live mower position. Set it up in the Mower tab.</p>
          <div class="row">${done}</div></section>`;
  }
  return html`<section class="box"><h3>${m.name}</h3>
        <p class="dim">${m.entityId}${m.areaId ? " · " + areaName(ed.hass, m.areaId) : ""}</p>
        <p>${attached ? `Attached to ${target ? ed.card.objectLabel(target.obj) : attached}${target ? "" : " (not in the model)"}` : pinned ? "Pinned" : "Auto placed"}</p>
        ${pos ? html`<label>Height above floor (m) <input type="number" step="0.05" min="0" name="marker-z" .value=${fmt(pos.z)} @change=${(e: Event) => setMarkerZ(ed, field(e).value)}></label>` : nothing}
        <div class="row">
          ${attached ? html`<button name="detach" @click=${act(ed, () => detach(ed))}>Detach</button>` : nothing}
          ${pinned ? html`<button @click=${act(ed, () => ed.commit(E.clearPin(ed.layout, m.id)))}>Return to auto placement</button>` : nothing}
          <button @click=${act(ed, () => hide(ed))}>Hide</button>
          ${done}
        </div></section>`;
}

function stickView(ed: EditMode): TemplateResult {
  const st = ed.stick;
  if (!st) {
    return html`<div class="row"><button title="Pinned markers floating more than 15 cm from the model move onto the nearest wall, ceiling or floor"
      @click=${act(ed, () => {
        ed.stick = { moves: stickMoves(ed) };
      })}>Stick all to surfaces</button></div>`;
  }
  const n = st.moves.length;
  return html`<section class="box stick"><p>${n ? `${n} marker${n === 1 ? "" : "s"} will move onto the nearest surface.` : "Every pinned marker already sits on a surface."}</p>
          <div class="row">${n ? html`<button name="stick-apply" class="primary" @click=${act(ed, () => stickApply(ed))}>Apply</button>` : nothing}<button name="stick-cancel"
          @click=${act(ed, () => {
            ed.stick = null;
          })}>${n ? "Cancel" : "OK"}</button></div></section>`;
}

export function devicesTab(ed: EditMode): TemplateResult {
  const all = allMarkers(ed);
  const byId = new Map(all.map((m) => [m.id, m]));
  const hidden = ed.layout.hidden;
  const m = ed.selectedMarker && byId.get(ed.selectedMarker);
  if (m && m.id === ed.card._mowerMarkerId) return selectedView(ed, m);
  const unplaced = all.filter(
    (x) =>
      !hidden.includes(x.id) &&
      !hidden.includes(x.entityId) &&
      !(ed.card._positions || new Map()).has(x.id),
  );
  return html`${m ? selectedView(ed, m) : nothing}
      <p class="hint">Drag any marker on the plan to pin it there${ed.view.model ? " (it sticks to the model surface; drop on a model object to attach it, hold Alt for a free drag)" : ""}. Click a marker to select it.</p>
      ${ed.view.model ? stickView(ed) : nothing}
      ${badgesView(ed)}
      <div class="sub">Devices without a room (${unplaced.length})</div>
      ${
        unplaced.length
          ? html`<ul class="list">${repeat(
              unplaced,
              (x) => x.id,
              (
                x,
              ) => html`<li>${logoBox(ed, x.entityId)}<span class="name">${x.name}<span class="dim"> · ${x.areaId ? areaName(ed.hass, x.areaId) : "no area"}</span></span>
          <button @click=${act(ed, () => place(ed, x.id))}>Place</button></li>`,
            )}</ul>`
          : html`<p class="dim">Every device is on the plan.</p>`
      }
      <div class="sub">Hidden (${hidden.length})</div>
      ${
        hidden.length
          ? html`<ul class="list">${repeat(
              hidden,
              (id) => id,
              (id) => {
                const x = byId.get(id) || all.find((y) => y.entityId === id);
                return html`<li>${logoBox(ed, x && x.entityId)}<span class="name">${x ? x.name : id}</span><button @click=${act(ed, () => ed.commit(E.unhide(ed.layout, id)))}>Unhide</button></li>`;
              },
            )}</ul>`
          : html`<p class="dim">Nothing hidden.</p>`
      }`;
}

// "Stick all to surfaces": free pins more than 15 cm from every model surface (8 horizontal rays,
// up and down) move onto the surface their device type sticks to, else the nearest one (stickSurface).
export function stickMoves(ed: EditMode): StickMove[] {
  const vw = ed.view,
    out: StickMove[] = [];
  if (!vw.model) return out;
  const byId = new Map(allMarkers(ed).map((m) => [m.id, m])); // hidden ones included
  for (const [id, pin] of Object.entries(ed.layout.pins)) {
    const m = byId.get(id);
    if (!m || !pin || pin.attach || id === ed.card._mowerMarkerId) continue; // device gone: leave its pin alone
    const floor = ed.floors.find((f) => f.id === pin.floor_id) || ed.floors[0];
    const elev = vw.floorElevation(floor.id);
    const z = pin.z ?? 1.2;
    const world = worldOf({ x: pin.x, y: pin.y, z }, elev);
    const hits = surfaceSearch("all", z, floor.height).flatMap((g) =>
      vw.surfaceRays(world, g.dirs, g.max),
    );
    if (!needsStick(pin, nearestDistance(hits))) continue;
    const s = stickSurface(surfaceKind(m.domain, m.deviceClass), hits);
    if (s)
      out.push({
        id,
        from: pin,
        pin: { ...planOf(s.point, elev), floor_id: floor.id, on_model: true },
      });
  }
  return out;
}

// A pin placed while a model is loaded sits on the model and follows its alignment.
export function onModel(ed: EditMode, id: string): boolean {
  const pin = ed.layout.pins[id];
  return !!ed.view.model || !!(pin && pin.on_model);
}

// ---------- handlers (the marker buttons show only with a marker selected) ----------
const selectedId = (ed: EditMode): string => ed.selectedMarker!;

export function stickApply(ed: EditMode) {
  // the previewed moves; a pin changed since then is left alone
  const moves = ed.stick ? ed.stick.moves : [];
  ed.stick = null;
  let layout = ed.layout;
  for (const mv of moves)
    if (layout.pins[mv.id] === mv.from)
      layout = E.setPin(layout, mv.id, mv.pin, { grid: false });
  if (layout !== ed.layout) ed.commit(layout);
}

export function detach(ed: EditMode) {
  // keep where it is now, as a normal pin on the model
  const id = selectedId(ed);
  const pos = ed.card._positions && ed.card._positions.get(id);
  const pin: LayoutPin | undefined = ed.layout.pins[id];
  const at = pos
    ? { x: pos.x, y: pos.y, z: pos.z, floor_id: pos.floorId }
    : pin;
  if (at)
    ed.commit(
      E.setPin(ed.layout, id, { ...at, on_model: true }, { grid: false }),
    );
}

export function hide(ed: EditMode) {
  const mid = selectedId(ed);
  ed.selectMarker(null);
  ed.commit(E.hide(ed.layout, mid));
}

export function place(ed: EditMode, id: string) {
  const fid = ed.activeFloor();
  const t = ed.view.controls!.target; // the controls exist while the card is shown
  ed.selectedMarker = id;
  ed.commit(
    E.setPin(ed.layout, id, {
      x: t.x,
      y: -t.z,
      z: 1.2,
      floor_id: fid,
      on_model: onModel(ed, id),
    }),
  );
}

export function setTapHints(ed: EditMode, v: string) {
  const l: Layout = { ...ed.layout };
  if (v === "always" || v === "off") l.tap_hints = v;
  else delete l.tap_hints; // near: the default
  ed.commit(l);
}

export function setMarkerZ(ed: EditMode, value: string) {
  const v = Number(value);
  const id = selectedId(ed);
  const pos = ed.card._positions!.get(id); // the height input shows only for a drawn marker
  if (!Number.isFinite(v) || !pos) return;
  const pin: LayoutPin | undefined = ed.layout.pins[id];
  if (pin && pin.attach && Array.isArray(pin.offset)) {
    // attached: raise / lower the offset; object missing: keep the attach, only the fallback height changes
    const o = pin.offset;
    const off: Vec3 = pos.attached ? [o[0], o[1] + v - pos.z, o[2]] : o;
    ed.commit(
      E.attachPin(ed.layout, id, pin.attach, off, {
        x: pin.x,
        y: pin.y,
        z: pos.attached ? Number(pin.z) + v - pos.z : v,
        floor_id: pin.floor_id,
      }),
    );
    return;
  }
  ed.commit(
    E.setPin(
      ed.layout,
      id,
      {
        x: pos.x,
        y: pos.y,
        z: v,
        floor_id: pos.floorId,
        on_model: onModel(ed, id),
      },
      { grid: !pin },
    ),
  );
}

export function setBadge(ed: EditMode, key: string, on: boolean) {
  ed.commit({ ...ed.layout, badges: { ...ed.layout.badges, [key]: on } });
  ed.render();
}

export const devicesTabDef: TabDef = {
  id: "devices",
  label: "Devices",
  view: devicesTab,
};
