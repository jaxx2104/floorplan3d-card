// Mower tab: setup checklist, position source, warning, calibration, map overlay and its processing.

import { readSource, calibrationError } from "../../mower.ts";
import { setupChecklist } from "../../mower-setup.ts";
import { colorList, removeColorPatch, MAX_COLORS } from "../../mower-image.ts";
import {
  closePicker,
  openColorPicker,
  alignPicker,
  cancelAlign,
  markFront,
} from "../tools/map-tools.ts";
import { html, nothing } from "lit/html.js";
import { classMap } from "lit/directives/class-map.js";
import { live } from "lit/directives/live.js";
import {
  act,
  entityInput,
  entityList,
  field,
  flash,
  fmt,
  options,
  slider,
} from "../html.ts";
import type { TemplateResult } from "lit/html.js";
import type { TabDef } from "./tab.ts";
import type { View } from "../html.ts";
import type { EditMode } from "../../edit-mode.ts";
import type { ImageResult, MowerLive } from "../../card/mower-controller.ts";
import type {
  LayoutMower,
  MapColorKind,
  MowerCalibrationPoint,
  MowerImageConfig,
  MowerOverlay,
} from "../../types/layout.ts";

// ---------- mower ----------
export function mower(ed: EditMode): LayoutMower {
  return ed.layout.mower || {};
}

export function setMower(ed: EditMode, patch: Partial<LayoutMower>) {
  const cur: LayoutMower = ed.layout.mower || {
    entity: "",
    source: "gps",
    x_attr: "x",
    y_attr: "y",
    floor_id: ed.floors[0].id,
    calibration: [],
    overlay: null,
  };
  ed.commit({ ...ed.layout, mower: { ...cur, ...patch } });
  ed.render();
}

export function setOverlay(
  ed: EditMode,
  patch: Partial<MowerOverlay>,
  rerender = true,
) {
  const m = mower(ed);
  const cur: MowerOverlay = m.overlay || {
    entity: "",
    x: 0,
    y: 0,
    rotation: 0,
    width: 20,
    opacity: 0.6,
    refresh: 10,
  };
  const overlay = { ...cur, ...patch };
  ed.card._commit({ ...ed.layout, mower: { ...m, overlay } });
  if (rerender) ed.render();
}

// Did the last position reading / icon detection put the mower on the plan?
export function mowerFound(ed: EditMode): boolean {
  const m = mower(ed),
    ml = ed.card._mowerLive;
  if (!ml || !ml.floorId) return false;
  if (m.source !== "image") return true;
  const r = ed.card._imageResult;
  return !!(r && !r.error && !r.missing);
}

// Setup checklist at the top of the Mower tab (open while a step is missing); each row scrolls to its control.
export function setupView(ed: EditMode): TemplateResult {
  const m = mower(ed),
    on = ed.card.mowerAuto(m);
  const auto = on ? { ...on, mismatch: !!ed.card._autoMismatch } : null;
  const { rows, complete } = setupChecklist(
    m,
    ed.hass.states,
    mowerFound(ed),
    auto,
  );
  return html`<details class=${classMap({ "mower-setup": true, complete })} ?open=${!complete}><summary>${complete ? "✓ Setup complete" : "Setup"}</summary>
      <ul class="plain setup">${rows.map(
        (
          r,
        ) => html`<li><button class="link setup-row ${r.ok ? "ok" : r.optional ? "opt" : "todo"}" data-target=${r.target}
        @click=${act(ed, () => setupGo(ed, r.target))}><span class="mark">${r.ok ? "✓" : r.optional ? "–" : "✗"}</span> ${r.label}${r.optional && !r.ok ? html` <span class="dim">optional</span>` : nothing}</button></li>`,
      )}</ul></details>`;
}

// "Stripes: 45° (NE–SW) · Mowed: 37 %" from the processed map, or nothing.
export function mapInfoView(ed: EditMode): View {
  const mi = ed.card.mapInfo();
  const parts: string[] = [];
  if (mi.stripes) parts.push(`Stripes: ${mi.stripes}`);
  if (mi.mowed)
    parts.push(
      `Mowed: ${mi.mowed}${mi.mowedSource ? ` (${mi.mowedSource})` : ""}`,
    );
  return parts.length
    ? html`<br><span class="map-info">${parts.join(" · ")}</span>`
    : nothing;
}

export function mowerLiveView(ed: EditMode): TemplateResult | string {
  const m = mower(ed);
  const st = m.entity && ed.hass.states[m.entity];
  if (!m.entity)
    return m.source === "image"
      ? "Pick the mower entity: its marker follows the icon found on the map image."
      : "Pick the entity that reports the mower position.";
  if (!st) return html`Entity <b>${m.entity}</b> not found.`;
  if (m.source === "image") return mowerImageView(ed);
  const r = readSource(st, m);
  if (!r)
    return m.source === "xy"
      ? html`No numeric <b>${m.x_attr || "x"}</b> / <b>${m.y_attr || "y"}</b> attributes on ${m.entity}.`
      : `No latitude/longitude on ${m.entity} (state: ${st.state}).`;
  const ml = ed.card._mowerLive;
  const raw = (r.raw ?? [])
    .map((v: number) => (m.source === "xy" ? fmt(v) : v.toFixed(6)))
    .join(", ");
  const plan =
    ml && ml.floorId
      ? `on plan (${fmt(ml.x)}, ${fmt(ml.y)})`
      : "not on the plan yet: add a calibration point";
  const ms = ed.card.mowerStatus();
  return html`${ms && ms.kind === "dock" ? html`<span class="mower-status">${ed.card.mowerStatusText()}</span><br>` : nothing}Reading ${raw}<br>${plan}`;
}

export function mowerImageView(ed: EditMode): TemplateResult | string {
  const m = mower(ed);
  const ic: MowerImageConfig = m.image || {};
  if (!m.overlay || !m.overlay.entity)
    return "Add the map overlay below and align it with the plan: that alignment is the calibration.";
  const hd = ed.card.mowerHeading();
  const SOURCES: Record<string, string> = {
    picture: "mower picture",
    icon: "icon",
    movement: "movement",
    dock: "dock",
  };
  if (!colorList(ic).length && !ed.card.mowerAuto(m))
    return "Pick the mower icon colour on the map (below).";
  return html`${mowerImageFound(ed)}${hd ? html`<br>Heading ${hd.deg}° (${SOURCES[hd.source] || hd.source})` : nothing}`;
}

export function mowerImageFound(ed: EditMode): TemplateResult | string {
  const r = ed.card._imageResult;
  const ml = ed.card._mowerLive;
  if (r && r.error)
    return html`<span style="color: var(--error-color, #db4437)">${r.error}</span>`;
  const st = ed.card.mowerStatus();
  const line = st
    ? html`<span class="mower-status">${ed.card.mowerStatusText()}</span>`
    : nothing;
  const at = ml && ml.floorId ? ` at ${fmt(ml.x)}, ${fmt(ml.y)}` : "";
  if (st && st.kind === "dock") return html`${line}${at}`;
  if (ed.card.mowerAuto(mower(ed)))
    return html`${line}${st && (st.kind === "tracked" || st.kind === "last") ? at : ""}`;
  if (st && st.kind !== "searching")
    return html`${line}<br>${mowerColourFound(ed, r, ml)}`;
  return mowerColourFound(ed, r, ml);
}

export function mowerColourFound(
  ed: EditMode,
  r: ImageResult | null | undefined,
  ml: MowerLive | null | undefined,
): string {
  if (r && r.missing)
    return (
      "Mower icon not found" +
      (ml && ml.floorId ? ` (last seen at ${fmt(ml.x)}, ${fmt(ml.y)})` : "") +
      "."
    );
  if (r && ml && ml.floorId)
    return `Found at ${fmt(ml.x)}, ${fmt(ml.y)} (${r.count} px${r.match ? `, picture match ${r.match.toFixed(2)}` : ""})`;
  return "Looking for the mower icon…";
}

export function mowerTab(ed: EditMode): TemplateResult {
  const m = mower(ed);
  const states = ed.hass.states;
  const ids = Object.keys(states).sort();
  const posIds = ids.filter((id) =>
    /^(device_tracker|sensor|lawn_mower|vacuum)\./.test(id),
  );
  const picIds = ids.filter((id) => /^(image|camera)\./.test(id));
  const errIds = ids.filter((id) => /^(binary_sensor|sensor)\./.test(id));
  const floor = ed.card._mowerFloor();
  const source = m.source === "xy" || m.source === "image" ? m.source : "gps";
  const text = (
    name: string,
    value: string,
    onChange: (v: string) => void,
    placeholder?: string,
  ) =>
    html`<input name=${name} .value=${value} placeholder=${placeholder ?? nothing} @change=${(e: Event) => onChange(field(e).value)}>`;
  // one template whatever is set up: the controls keep their elements (and focus) as sections appear
  return html`${setupView(ed)}<div class="sub">Position</div>
      <label>Entity ${entityInput(ed, { name: "mower-entity", list: "fp-pos-ents", value: m.entity || "", placeholder: "device_tracker.mower_position", onChange: (v) => setMower(ed, { entity: v.trim() }) })}</label>
      ${entityList(ed, "fp-pos-ents", posIds)}
      <label>Source <select name="mower-source" .value=${live(source)} @change=${(e: Event) => setMower(ed, { source: field(e).value, calibration: [] })}>
        ${options(
          [
            ["gps", "GPS (latitude / longitude)"],
            ["xy", "Map x / y attributes"],
            ["image", "Live map image (mower found on the map)"],
          ],
          source,
        )}</select></label>
      ${
        m.source === "xy"
          ? html`<div class="row"><label>x attribute ${text("mower-xattr", m.x_attr || "x", (v) => setMower(ed, { x_attr: v.trim() || "x" }))}</label>
        <label>y attribute ${text("mower-yattr", m.y_attr || "y", (v) => setMower(ed, { y_attr: v.trim() || "y" }))}</label></div>`
          : nothing
      }
      <label>Floor <select name="mower-floor" .value=${live(floor)} @change=${(e: Event) => setMowerFloor(ed, field(e).value)}>${options(
        ed.floors.map((f) => [f.id, f.name]),
        floor,
      )}</select></label>
      <div class="sub">Warning</div>
      <label>Error entity (optional) ${entityInput(ed, { name: "mower-error-entity", list: "fp-err-ents", value: m.error_entity || "", placeholder: "binary_sensor.mower_error", onChange: (v) => setMower(ed, { error_entity: v.trim() }) })}</label>
      ${entityList(ed, "fp-err-ents", errIds)}
      <label>OK values (optional, comma-separated) ${text("mower-ok-values", Array.isArray(m.ok_values) ? m.ok_values.join(", ") : m.ok_values || "", (v) => setOkValues(ed, v), "rain delay, waiting")}</label>
      <p class="hint">Numbers: 0 = OK, anything else is an error code. Text: ok, none, normal, working, mowing, charging, docked, idle, returning, paused, standby… are OK; add your own above.</p>
      <label>Stuck after (minutes, 0 = off) <input type="number" min="0" max="120" step="1" name="mower-stuck-min" .value=${String(m.stuck_minutes === undefined ? 5 : Number(m.stuck_minutes) || 0)}
        @change=${(e: Event) => setMower(ed, { stuck_minutes: Math.max(0, Math.min(120, Math.round(Number(field(e).value) || 0))) })}></label>
      <p class="hint mower-live">${mowerLiveView(ed)}${mapInfoView(ed)}</p>
      ${
        m.entity
          ? html`${m.source !== "image" ? calibrationView(ed, m) : nothing}
      ${overlayView(ed, m, picIds)}
      ${m.source === "image" ? mowerImageSection(ed, m) : autoSection(ed, m)}
      <div class="row"><button class="danger" @click=${act(ed, () => removeMower(ed))}>Remove mower</button></div>`
          : nothing
      }`;
}

// Colour chips (swatch, rgb, × removes) of one category: 'icon' or bg / mowed / nomow.
export function chipsView(
  ed: EditMode,
  cols: number[][],
  kind: "icon" | MapColorKind,
): View {
  if (!cols.length) return nothing;
  return html`<div class="chips colors">${cols.map(
    (
      c,
      i,
    ) => html`<span class="cchip" title="rgb(${c.join(", ")})"><span class="swatch" style="background:rgb(${c.join(",")})"></span>${c.join(", ")}
      <button class="link" name="color-del" data-kind=${kind} data-i=${i} title="Remove this colour" aria-label="Remove" @click=${act(ed, () => colorDel(ed, kind, i))}>×</button></span>`,
  )}
      ${cols.length < MAX_COLORS ? html`<span class="dim">${cols.length}/${MAX_COLORS}: pick again to add a shade</span>` : nothing}</div>`;
}

// Auto mode: the live map compared with the static map, the mower found by its picture.
export function autoSection(ed: EditMode, m: LayoutMower): View {
  const det = ed.card.mowerAuto(m, true);
  if (!det) return nothing;
  const imgs = Object.keys(ed.hass.states)
    .filter((e) => e.startsWith("image."))
    .sort();
  const on = !!ed.card.mowerAuto(m);
  const optEntity = (v: string) => {
    const x = v.trim();
    return x === "" ? undefined : x === "none" ? "" : x;
  }; // empty: automatic again; "none": no entity
  return html`<div class="sub">Automatic</div>
      ${on && ed.card._autoMismatch ? html`<p class="hint auto-state" style="color: var(--error-color, #db4437)">Static map doesn't match the live map: ${colorList(m.image).length ? "the colour picks are used" : "no detection"} until it does.</p>` : nothing}
      <p class="hint auto-state">${
        on
          ? html`<b>Auto (static map${det.picture ? " + mower picture" : ""})</b>: live map ${det.live}, static map ${det.static}${det.picture ? `, mower picture ${det.picture}` : ""}.`
          : det.static
            ? "Auto mode is off: the colour picks below are used."
            : "No static map found: pick the colours below, or set the static map."
      }</p>
      <label>Static map ${entityInput(ed, {
        name: "mower-static",
        list: "fp-img-ents",
        value: m.static_entity ?? "",
        placeholder:
          m.static_entity === undefined && det.static
            ? `auto: ${det.static}`
            : "image.mower_map",
        onChange: (v) => setMower(ed, { static_entity: optEntity(v) }),
      })}</label>
      <label>Mower picture ${entityInput(ed, {
        name: "mower-picture",
        list: "fp-img-ents",
        value: m.picture_entity ?? "",
        placeholder:
          m.picture_entity === undefined && det.picture
            ? `auto: ${det.picture}`
            : "image.mower_mower_image",
        onChange: (v) => setMower(ed, { picture_entity: optEntity(v) }),
      })}</label>
      ${entityList(ed, "fp-img-ents", imgs)}
      ${
        det.static
          ? html`<label class="check"><input type="checkbox" name="mower-auto-off" .checked=${live(m.auto === false)}
        @change=${(e: Event) => setMower(ed, { auto: field(e).checked ? false : undefined })}> Use colour picks instead</label>`
          : nothing
      }`;
}

export function mowerImageSection(
  ed: EditMode,
  m: LayoutMower,
): TemplateResult {
  const ic: MowerImageConfig = m.image || {};
  const o = m.overlay;
  if (ed.card.mowerAuto(m))
    return html`${autoSection(ed, m)}${markFrontView(ed, m)}`;
  const icols = colorList(ic);
  return html`${autoSection(ed, m)}<div class="sub">Mower icon on the map</div>
      <label>Image entity ${entityInput(ed, { name: "mower-img-entity", list: "fp-pic-ents", value: ic.entity || "", placeholder: (o && o.entity) || "same as the overlay", onChange: (v) => setImageEntity(ed, v) })}</label>
      ${
        ed.colorPick === true
          ? html`<section class="box"><p>Click the mower icon on the map overlay. Esc cancels.</p>
        <div class="row"><button @click=${act(ed, () => {
          ed.colorPick = false;
        })}>Cancel</button></div></section>`
          : nothing
      }
      <div class="row"><button name="img-pick" class=${classMap({ primary: !icols.length && !ed.colorPick })} ?disabled=${!!ed.colorPick || !(o && o.entity) || icols.length >= MAX_COLORS}
        @click=${act(ed, () => pickColor(ed, "icon"))}>Pick mower colour</button></div>
      ${chipsView(ed, icols, "icon")}
      ${
        icols.length
          ? slider(ed, {
              name: "mower-img-tolerance",
              label: "Colour tolerance",
              min: 0,
              max: 255,
              step: 1,
              value: ic.tolerance ?? 40,
              onChange: (v) =>
                setMower(ed, {
                  image: {
                    ...mower(ed).image,
                    tolerance: Math.max(0, Math.min(255, v || 0)),
                  },
                }),
            })
          : nothing
      }
      ${markFrontView(ed, m)}
      <p class="hint">Align the map overlay with the plan first: the alignment maps image pixels to the plan, so no
      calibration points are needed. Then pick the colour of the mower icon on the map.</p>`;
}

// "Mark front": click the icon's front tip once; the offset corrects the icon heading.
export function markFrontView(ed: EditMode, m: LayoutMower): TemplateResult {
  const ic: MowerImageConfig = m.image || {};
  const can =
    !!ed.card._imageBlob &&
    ed.card._iconHeadRaw !== undefined &&
    ed.card._iconHeadRaw !== null;
  const off = Number(ic.front_offset) || 0;
  return html`<div class="row"><button ?disabled=${!can} title="Click the front tip of the mower icon in the map picture" @click=${act(ed, () => markFront(ed))}>Mark front</button>
      ${off ? html`<span class="dim">offset ${Math.round(off)}°</span> <button class="link" @click=${act(ed, () => frontClear(ed))}>Clear</button>` : nothing}</div>`;
}

export function calibrationView(ed: EditMode, m: LayoutMower): TemplateResult {
  const cal: MowerCalibrationPoint[] = m.calibration || [];
  const err = calibrationError(cal, m.source === "xy" ? "xy" : "gps");
  const fitName = [
    "",
    "shift only",
    "shift, rotate, scale",
    "affine (least squares)",
  ][Math.min(cal.length, 3)];
  return html`<div class="sub">Calibration (${cal.length} point${cal.length === 1 ? "" : "s"}${cal.length ? ": " + fitName : ""})</div>
      ${
        ed.calibrating
          ? html`<section class="box"><p>Click on the plan where the mower is right now.</p>
        <div class="row"><button @click=${act(ed, () => {
          ed.calibrating = null;
        })}>Cancel</button></div></section>`
          : nothing
      }
      <ul class="plain">${cal.map(
        (
          c,
          i,
        ) => html`<li>${i + 1}. (${c.src.map((v) => (m.source === "xy" ? fmt(v) : v.toFixed(6))).join(", ")}) → (${fmt(c.plan[0])}, ${fmt(c.plan[1])})
      <button class="link" @click=${act(ed, () => setMower(ed, { calibration: (mower(ed).calibration || []).filter((_, j) => j !== i) }))}>Remove</button></li>`,
      )}</ul>
      ${cal.length >= 3 ? html`<p class="dim">Fit error ${fmt(err)} m</p>` : nothing}
      <div class="row"><button class=${classMap({ primary: !ed.calibrating })} ?disabled=${!!ed.calibrating} @click=${act(ed, () => calAdd(ed))}>Add point</button></div>
      <p class="hint">"Add point" takes the current reading, then you click where the mower really is. One point aligns
      a GPS track north-up, two fix rotation and scale, three or more also correct skew. Spread points far apart.</p>`;
}

type OverlayKey =
  | "x"
  | "y"
  | "rotation"
  | "width"
  | "opacity"
  | "height_offset"
  | "refresh"
  | `${MapColorKind}_tolerance`;
// an overlay slider: moves the map live
const ovSlider = (
  ed: EditMode,
  key: OverlayKey,
  label: string,
  min: number,
  max: number,
  step: number,
  v: unknown,
  unit = "",
) =>
  slider(ed, {
    name: `ov-${key}`,
    label,
    min,
    max,
    step,
    value: v,
    unit,
    onInput: (x) => setOverlay(ed, { [key]: x }, false),
  });

export function overlayView(
  ed: EditMode,
  m: LayoutMower,
  picIds: string[],
): TemplateResult {
  const o = m.overlay;
  return html`<div class="sub">Map overlay</div>
      <label>Image or camera entity ${entityInput(ed, { name: "ov-entity", list: "fp-pic-ents", value: (o && o.entity) || "", placeholder: "image.mower_map", onChange: (v) => setOverlayEntity(ed, v) })}</label>
      ${entityList(ed, "fp-pic-ents", picIds)}
      ${o && o.entity ? overlayControls(ed, m, o) : nothing}`;
}

function overlayControls(
  ed: EditMode,
  m: LayoutMower,
  o: MowerOverlay,
): TemplateResult {
  const a = ed.aligning;
  return html`${ovSlider(ed, "x", "x", -100, 100, 0.05, o.x ?? 0, "m")}
      ${ovSlider(ed, "y", "y", -100, 100, 0.05, o.y ?? 0, "m")}
      ${ovSlider(ed, "rotation", "Rotation", -180, 180, 0.5, o.rotation ?? 0, "°")}
      ${ovSlider(ed, "width", "Width", 1, 200, 0.1, o.width ?? 20, "m")}
      ${ovSlider(ed, "opacity", "Opacity", 0, 1, 0.05, o.opacity ?? 0.6)}
      ${ovSlider(ed, "height_offset", "Height offset", -0.5, 0.5, 0.01, o.height_offset ?? 0, "m")}
      ${(o.entity || "").startsWith("camera.") ? ovSlider(ed, "refresh", "Refresh every", 1, 120, 1, o.refresh ?? 10, "s") : nothing}
      <label class="check"><input type="checkbox" name="ov-edit-only" .checked=${live(!!o.edit_only)} @change=${(e: Event) => setOverlay(ed, { edit_only: field(e).checked })}> Show the map only in edit mode</label>
      ${mapProcessingView(ed, m, o)}
      ${
        a
          ? html`<section class="box align-box"><p>${a.pending ? `Point ${a.pairs.length + 1}: now click the same spot on the model.` : `Point ${a.pairs.length + 1}: click a spot on the map image${ed.picker ? " (in the picture over the plan)" : ""}.`}
          ${a.pairs.length >= 2 ? ` Aligned to ${a.pairs.length} points.` : " Two points align it, more refine it."} Esc cancels.</p>
          <div class="row">${!a.pending && !ed.picker ? html`<button @click=${act(ed, () => alignPicker(ed))}>Pick image point</button>` : nothing}<button class="primary"
          @click=${act(ed, () => alignDone(ed))}>Done</button><button @click=${act(ed, () => cancelAlign(ed))}>Cancel</button></div></section>`
          : nothing
      }
      <div class="row"><button name="ov-align" ?disabled=${!!a} @click=${act(ed, () => alignStart(ed))}>Align by points</button>
        <button class=${classMap({ primary: ed.overlayMove })} @click=${act(ed, () => toggleMove(ed))}>${ed.overlayMove ? "Drag the map on the plan…" : "Move with mouse"}</button>
        <button @click=${act(ed, () => removeOverlay(ed))}>Remove overlay</button></div>
        <p class="hint">The map lies on the model's surface under its centre; adjust with the height offset.</p>`;
}

// Map picture processing: picked colours (background transparent, mowed stripes, shaded no-mow),
// the mower icon hidden, clipped to a zone.
export function mapProcessingView(
  ed: EditMode,
  m: LayoutMower,
  o: MowerOverlay,
): TemplateResult {
  if (ed.card.mowerAuto(m)) {
    return html`<div class="sub">Map picture</div><p class="hint">Automatic: compared with the static map, unchanged parts are transparent, mowed stripes light, no-mow areas shaded.</p>`;
  }
  const NAMES: Record<MapColorKind, string> = {
    bg: "background",
    mowed: "mowed stripe",
    nomow: "no-mow area",
  };
  const kinds: [MapColorKind, string, string][] = [
    ["bg", "Pick background colour", "Background: transparent"],
    ["mowed", "Pick mowed colour", "Mowed stripes: light"],
    ["nomow", "Pick no-mow colour", "No-mow areas: shaded"],
  ];
  const zones = ed.card._zones || [];
  const auto = ed.card.mapZone({ ...o, zone: "auto" });
  const zsel = o.zone || "auto";
  const zoneOpts: [string, string][] = [
    ["auto", `Automatic (${auto ? auto.id : "none at the map centre"})`],
    ["none", "None"],
    ...zones.map((z): [string, string] => [z.id, z.id]),
  ];
  return html`<div class="sub">Map picture</div>
      ${
        ed.colorPick && ed.colorPick !== true
          ? html`<section class="box"><p>Click the ${NAMES[ed.colorPick]} colour on the map overlay. Esc cancels.</p>
        <div class="row"><button @click=${act(ed, () => {
          ed.colorPick = false;
        })}>Cancel</button></div></section>`
          : nothing
      }
      ${kinds.map(([k, label, what]) => {
        const cols = colorList(o, k);
        return html`<div class="row"><button name="map-pick" data-kind=${k} ?disabled=${!!ed.colorPick || cols.length >= MAX_COLORS} @click=${act(ed, () => pickColor(ed, k))}>${label}</button>${cols.length ? html` <span class="dim">${what}</span>` : nothing}</div>
      ${chipsView(ed, cols, k)}
      ${cols.length ? ovSlider(ed, `${k}_tolerance`, "Tolerance", 0, 128, 1, o[`${k}_tolerance`] ?? 30) : nothing}`;
      })}
      ${
        m.source === "image"
          ? html`<label class="check"><input type="checkbox" name="ov-hide-icon" .checked=${live(o.hide_icon !== false)}
        @change=${(e: Event) => setOverlay(ed, { hide_icon: field(e).checked })}> Hide mower icon on the map</label>`
          : nothing
      }
      <label>Clip to zone <select name="ov-zone" .value=${live(zsel)} @change=${(e: Event) => setOverlay(ed, { zone: field(e).value === "auto" ? null : field(e).value })}>${options(zoneOpts, zsel)}</select></label>
      <p class="hint">Pick colours by clicking them on the map. Without a background colour the picture is drawn as it is.
      The zone clip applies once a colour is picked or the icon is hidden.</p>`;
}

// ---------- handlers ----------
function toMowerFloor(ed: EditMode) {
  if (ed.card._floor !== ed.card._mowerFloor())
    ed.card._setFloor(ed.card._mowerFloor());
}

// The colour pick buttons end the calibration click, the move tool and aligning first.
function pickColor(ed: EditMode, kind: "icon" | MapColorKind) {
  ed.calibrating = null;
  ed.overlayMove = false;
  ed.aligning = null;
  openColorPicker(ed, kind);
}

export function calAdd(ed: EditMode) {
  const m = mower(ed);
  const r = m.entity ? readSource(ed.hass.states[m.entity], m) : null; // no entity: no reading
  if (!r) {
    ed.message = {
      text: "No position reading from the mower entity right now.",
      error: true,
    };
    return;
  }
  ed.calibrating = { src: r.raw }; // readSource: [u, v] or [lat, lon]
  ed.overlayMove = false;
  toMowerFloor(ed);
}

export function frontClear(ed: EditMode) {
  const ic: MowerImageConfig = mower(ed).image || {};
  ed.card._headSt = null;
  setMower(ed, { image: { ...ic, front_offset: 0 } });
}

export function colorDel(ed: EditMode, kind: "icon" | MapColorKind, i: number) {
  if (kind === "icon") {
    const ic: MowerImageConfig = mower(ed).image || {};
    setMower(ed, { image: { ...ic, ...removeColorPatch(ic, null, i) } });
  } else setOverlay(ed, removeColorPatch(mower(ed).overlay || {}, kind, i));
  if (ed.picker) ed.picker.refresh();
}

export function toggleMove(ed: EditMode) {
  closePicker(ed);
  ed.overlayMove = !ed.overlayMove;
  ed.calibrating = null;
  ed.colorPick = false;
  ed.aligning = null;
}

export function removeOverlay(ed: EditMode) {
  closePicker(ed);
  ed.overlayMove = false;
  ed.aligning = null;
  setMower(ed, { overlay: null });
}

export function alignStart(ed: EditMode) {
  const o: MowerOverlay = mower(ed).overlay || {};
  // the starting alignment: Cancel / Esc put it back, Done keeps the fit
  ed.aligning = {
    pairs: [],
    pending: null,
    start: {
      x: o.x ?? 0,
      y: o.y ?? 0,
      rotation: o.rotation ?? 0,
      width: o.width ?? 20,
    },
  };
  ed.overlayMove = false;
  ed.calibrating = null;
  ed.colorPick = false;
  toMowerFloor(ed);
  ed._syncStageClasses();
  ed.render();
  alignPicker(ed);
}

export function alignDone(ed: EditMode) {
  const done = ed.aligning && ed.aligning.pairs.length >= 2;
  closePicker(ed);
  ed.aligning = null;
  if (done) setOverlay(ed, { aligned: true });
}

// A setup row: scroll to its control and flash it (a transient class lit does not render).
export function setupGo(ed: EditMode, target: string) {
  const t = ed.panel.querySelector<HTMLElement>(target);
  if (!t) return;
  const box = t.closest("label") || t;
  box.scrollIntoView({ block: "center", behavior: "smooth" });
  flash(box, 1600, "setup-flash");
  if (t.matches("input, select")) t.focus({ preventScroll: true });
}

export function removeMower(ed: EditMode) {
  ed.calibrating = null;
  ed.colorPick = false;
  ed.overlayMove = false;
  ed.aligning = null;
  ed.commit({ ...ed.layout, mower: null });
}

export function setImageEntity(ed: EditMode, value: string) {
  const ic: MowerImageConfig = { ...mower(ed).image };
  const v = value.trim();
  if (v) ic.entity = v;
  else delete ic.entity;
  setMower(ed, { image: ic });
}

export function setMowerFloor(ed: EditMode, fid: string) {
  ed.card._setFloor(fid);
  setMower(ed, { floor_id: fid });
}

export function setOkValues(ed: EditMode, value: string) {
  const v = value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  setMower(ed, { ok_values: v.length ? v : undefined });
}

export function setOverlayEntity(ed: EditMode, value: string) {
  const v = value.trim();
  if (!v) {
    setMower(ed, { overlay: null });
    return;
  }
  // first time: centre the map on the current view
  const t = ed.view.controls!.target; // the controls exist while the card is shown
  const first = !mower(ed).overlay;
  setOverlay(
    ed,
    first
      ? {
          entity: v,
          x: Math.round(t.x * 10) / 10,
          y: Math.round(-t.z * 10) / 10,
        }
      : { entity: v },
  );
}

export const mowerTabDef: TabDef = {
  id: "mower",
  label: "Mower",
  view: mowerTab,
  live: true,
};
