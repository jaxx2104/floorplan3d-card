// A device marker as a GPU sprite (src/view/billboards.ts draws it from the atlas): the face (everything that
// decides its picture, from the registry look and the state), the layout in CSS px and the painter. The look
// follows the former DOM marker: a dot (circle / rounded square / diamond by role) with the state icon, the
// value pill below, integration logo (top right), status dot (bottom right), low battery chip (above), the
// "i" of info markers, the entity picture, the edit-mode selection ring. Sizes: plan, over a model (smaller,
// see-through), compact (zoomed out).
import type { StatusKind } from "./badges.ts";
import type { MarkerKind, MarkerShape } from "./registry.ts";
import {
  hashKey,
  type Rect,
  type SpriteEnv,
  type SpriteLayout,
  type SpriteSpec,
} from "./sprite-atlas.ts";

/** Everything a marker's picture depends on (same face = same atlas cell). */
export interface MarkerFace {
  shape: MarkerShape;
  kind: MarkerKind;
  /** domain light (its own colour while on) */
  light: boolean;
  active: boolean;
  alert: "red" | "yellow" | null;
  unavailable: boolean;
  /** the live mower is offline */
  offline: boolean;
  /** HA's state colour (CSS, var() allowed), "" for none */
  stateColor: string;
  /** a light's own colour (CSS rgb()), "" for none */
  lightColor: string;
  /** icon reference for the icon resolver */
  icon: string;
  /** value inside the dot (sensor markers) */
  inner: string;
  /** value pill below the dot */
  value: string;
  /** entity picture URL (circle with the picture), null for none */
  picture: string | null;
  /** integration logo URL, null for none */
  logo: string | null;
  status: StatusKind | null;
  battery: number | null;
  /** edit mode: the selected marker */
  selected: boolean;
}

/** Sizes in CSS px per size class (the former stylesheet's .fp-dot, .has-model, .compact rules). */
interface Metrics {
  dot: number; // content size of the dot
  border: number;
  icon: number;
  valueIcon: number; // icon of a value marker
  valueFont: number; // the pill below
  valuePad: [number, number]; // pill padding [y, x]
  innerFont: number; // value inside a value marker
  innerPad: [number, number]; // value marker padding [left, right]
  translucent: boolean; // over a model: the dot background lets the model through
}

export function markerMetrics(model: boolean, compact: boolean): Metrics {
  if (compact)
    return {
      dot: 21,
      border: 1,
      icon: 13,
      valueIcon: 11,
      valueFont: 9.5,
      valuePad: [0, 4],
      innerFont: 9.5,
      innerPad: [2, 4],
      translucent: model,
    };
  if (model)
    return {
      dot: 22,
      border: 1.5,
      icon: 14,
      valueIcon: 13,
      valueFont: 10.5,
      valuePad: [1, 5],
      innerFont: 11,
      innerPad: [3, 5],
      translucent: true,
    };
  return {
    dot: 28,
    border: 1.5,
    icon: 17,
    valueIcon: 13,
    valueFont: 10.5,
    valuePad: [1, 5],
    innerFont: 11,
    innerPad: [4, 6],
    translucent: false,
  };
}

const MARGIN = 6; // room for the shadows and the selection ring around the parts
const font = (env: SpriteEnv, weight: number, px: number, style = "") =>
  `${style ? style + " " : ""}${weight} ${px}px ${env.font}`;

/** The parts of a marker relative to its anchor (the dot's centre), CSS px. */
export interface MarkerParts {
  dot: Rect;
  value: Rect | null;
  battery: Rect | null;
  logo: Rect | null;
  status: Rect | null;
  info: Rect | null;
  /** icon box inside the dot, inner text start (value markers) */
  icon: Rect;
  innerX: number;
  innerW: number;
  valueW: number;
  batteryW: number;
  m: Metrics;
}

export function markerParts(face: MarkerFace, env: SpriteEnv): MarkerParts {
  const m = markerMetrics(env.model, env.compact);
  const b = m.border;
  const valueKind = face.kind === "value";
  const iconS = valueKind ? m.valueIcon : m.icon;
  let innerW = 0,
    w = m.dot,
    padL = 0;
  if (valueKind) {
    innerW = face.inner
      ? env.measure(face.inner, font(env, 600, m.innerFont))
      : 0;
    padL = m.innerPad[0];
    // content box: min-width = the dot size; padding and border outside it
    const content = Math.max(m.dot, iconS + (innerW ? 2 + innerW : 0));
    w = content + m.innerPad[0] + m.innerPad[1];
  }
  const ow = w + 2 * b,
    oh = m.dot + 2 * b;
  const dot = { x: -ow / 2, y: -oh / 2, w: ow, h: oh };
  // value marker: icon and text left aligned in the content box; others: the icon centred
  const contentW = valueKind ? ow - 2 * b - padL - m.innerPad[1] : 0;
  const used = iconS + (innerW ? 2 + innerW : 0);
  const startX = valueKind ? dot.x + b + padL + (contentW - used) / 2 : 0;
  const icon = valueKind
    ? { x: startX, y: -iconS / 2, w: iconS, h: iconS }
    : { x: -iconS / 2, y: -iconS / 2, w: iconS, h: iconS };
  let value: Rect | null = null,
    valueW = 0;
  if (face.value) {
    valueW = env.measure(face.value, font(env, 500, m.valueFont));
    const lh = Math.round(m.valueFont * 1.2);
    const vw = valueW + 2 * m.valuePad[1],
      vh = lh + 2 * m.valuePad[0];
    value = { x: -vw / 2, y: dot.y + oh + 2, w: vw, h: vh };
  }
  let battery: Rect | null = null,
    batteryW = 0;
  if (face.battery !== null) {
    batteryW = env.measure(`${face.battery} %`, font(env, 700, 9.5));
    const bw = batteryW + 8;
    battery = { x: -bw / 2, y: dot.y - 1 - 13, w: bw, h: 13 };
  }
  const logo = face.logo
    ? { x: dot.x + ow + 8 - 14, y: dot.y - 6, w: 14, h: 14 }
    : null;
  const status = face.status
    ? { x: dot.x + ow + 1 - 10, y: dot.y + oh + 1 - 10, w: 10, h: 10 }
    : null;
  const info =
    face.kind === "info"
      ? { x: dot.x + b - 4, y: dot.y + b - 4, w: 10, h: 10 }
      : null;
  return {
    dot,
    value,
    battery,
    logo,
    status,
    info,
    icon,
    innerX: startX + iconS + 2,
    innerW,
    valueW,
    batteryW,
    m,
  };
}

/** Cell layout: the bounds of the parts plus a margin; hits = the dot and the value pill (badges let taps through). */
export function markerLayout(face: MarkerFace, env: SpriteEnv): SpriteLayout {
  const p = markerParts(face, env);
  // a diamond is the dot turned 45 degrees at 0.9: its corners reach out further
  const d =
    face.shape === "diamond"
      ? { ...p.dot, x: p.dot.x * 1.28, y: p.dot.y * 1.28 }
      : p.dot;
  const parts = [d, p.value, p.battery, p.logo, p.status, p.info].filter(
    (r): r is Rect => !!r,
  );
  if (face.shape === "diamond") {
    d.w = -2 * d.x;
    d.h = -2 * d.y;
  }
  const x0 = Math.min(...parts.map((r) => r.x)) - MARGIN,
    y0 = Math.min(...parts.map((r) => r.y)) - MARGIN,
    x1 = Math.max(...parts.map((r) => r.x + r.w)) + MARGIN,
    y1 = Math.max(...parts.map((r) => r.y + r.h)) + MARGIN;
  const ax = Math.ceil(-x0),
    ay = Math.ceil(-y0);
  return {
    w: ax + Math.ceil(x1),
    h: ay + Math.ceil(y1),
    ax,
    ay,
    hits: [p.dot, ...(p.value ? [p.value] : [])],
  };
}

/** Atlas key of a face (everything that changes the picture; long URLs hashed). */
export function markerKey(face: MarkerFace): string {
  return [
    "m",
    face.shape,
    face.kind,
    face.light ? 1 : 0,
    face.active ? 1 : 0,
    face.alert || "",
    face.unavailable ? 1 : 0,
    face.offline ? 1 : 0,
    face.stateColor,
    face.lightColor,
    face.icon,
    face.inner,
    face.value,
    face.picture ? hashKey(face.picture) : "",
    face.logo ? hashKey(face.logo) : "",
    face.status || "",
    face.battery ?? "",
    face.selected ? 1 : 0,
  ].join("\u0001");
}

/** The sprite of a marker face. */
export function markerSprite(face: MarkerFace): SpriteSpec {
  const deps = ["icon:" + face.icon];
  if (face.picture) deps.push("img:" + face.picture);
  if (face.logo) deps.push("img:" + face.logo);
  return {
    key: markerKey(face),
    deps,
    layout: (env) => markerLayout(face, env),
    paint: (ctx, env, layout) => paintMarker(ctx, env, layout, face),
  };
}

/** Dot colours: background, border, icon / text (the former .active / .alert-* / .light rules). */
export function markerColors(
  face: MarkerFace,
  env: SpriteEnv,
): { bg: string; border: string; fg: string; inner: string } {
  const card = env.color("var(--card-background-color)", "#ffffff");
  const state = face.stateColor ? env.color(face.stateColor, "") : "";
  if (face.alert === "red") {
    const c = state || "#e53935";
    return { bg: c, border: c, fg: "#ffffff", inner: "#ffffff" };
  }
  if (face.alert === "yellow") {
    const c = state || "#fbc02d";
    return { bg: c, border: c, fg: "#212121", inner: "#212121" };
  }
  if (face.active && face.light) {
    const c =
      (face.lightColor && env.color(face.lightColor, "")) || state || "#ffb74d";
    return { bg: c, border: c, fg: "#ffffff", inner: "#ffffff" };
  }
  if (face.active) {
    const c = state || env.color("var(--primary-color)", "#03a9f4");
    const fg = env.color("var(--text-primary-color)", "#ffffff");
    return { bg: c, border: c, fg, inner: fg };
  }
  return {
    bg: card,
    border: env.color("var(--divider-color)", "rgba(0,0,0,0.15)"),
    fg: env.color("var(--secondary-text-color)", "#727272"),
    inner: env.color("var(--primary-text-color)", "#212121"),
  };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** An icon glyph into a box (fill colour set by the caller); a small ring while the icon resolves. */
export function paintIcon(
  ctx: CanvasRenderingContext2D,
  env: SpriteEnv,
  ref: string,
  box: Rect,
): void {
  const g = env.icon(ref);
  if (!g) {
    ctx.save();
    ctx.globalAlpha *= 0.6;
    ctx.lineWidth = Math.max(1, box.w / 10);
    ctx.strokeStyle = ctx.fillStyle;
    ctx.beginPath();
    ctx.arc(box.x + box.w / 2, box.y + box.h / 2, box.w * 0.28, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const [vx, vy, vw, vh] = g.viewBox;
  ctx.save();
  ctx.translate(box.x, box.y);
  ctx.scale(box.w / (vw || 24), box.h / (vh || 24));
  ctx.translate(-vx, -vy);
  const base = ctx.globalAlpha;
  for (const p of g.paths) {
    ctx.globalAlpha = base * p.opacity;
    ctx.fill(new Path2D(p.d));
  }
  ctx.restore();
}

// the diamond: the dot turned 45 degrees at 0.9 (dir -1 undoes it)
function turn(ctx: CanvasRenderingContext2D, dir: 1 | -1): void {
  if (dir > 0) {
    ctx.rotate(Math.PI / 4);
    ctx.scale(0.9, 0.9);
  } else {
    ctx.scale(1 / 0.9, 1 / 0.9);
    ctx.rotate(-Math.PI / 4);
  }
}

function shadow(
  ctx: CanvasRenderingContext2D,
  env: SpriteEnv,
  blur: number,
  y: number,
  color: string,
): void {
  // canvas shadows ignore the transform: in texels
  ctx.shadowBlur = blur * env.dpr;
  ctx.shadowOffsetY = y * env.dpr;
  ctx.shadowColor = color;
}
const noShadow = (ctx: CanvasRenderingContext2D) => {
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.shadowColor = "transparent";
};

function paintMarker(
  ctx: CanvasRenderingContext2D,
  env: SpriteEnv,
  layout: SpriteLayout,
  face: MarkerFace,
): void {
  const p = markerParts(face, env),
    m = p.m;
  const c = markerColors(face, env);
  const card = env.color("var(--card-background-color)", "#ffffff");
  ctx.translate(layout.ax, layout.ay); // anchor = origin
  const { dot } = p;
  const radius =
    face.shape === "circle" && face.kind !== "value"
      ? dot.h / 2
      : face.shape === "diamond"
        ? 4
        : 7;
  const dotPath = () => roundRect(ctx, dot.x, dot.y, dot.w, dot.h, radius);
  // the selection ring (outline 3 px, 2 px off the border), under the dot's shadow
  if (face.selected) {
    ctx.save();
    if (face.shape === "diamond") turn(ctx, 1);
    roundRect(
      ctx,
      dot.x - 3.5,
      dot.y - 3.5,
      dot.w + 7,
      dot.h + 7,
      radius + 3.5,
    );
    ctx.lineWidth = 3;
    ctx.strokeStyle = env.color("var(--primary-color)", "#03a9f4");
    ctx.stroke();
    ctx.restore();
  }
  // the dot: shape, shadow, background, border, picture, icon, inner value, "i"
  ctx.save();
  if (face.shape === "diamond") turn(ctx, 1);
  if (face.unavailable) ctx.globalAlpha = 0.45;
  if (face.offline) {
    ctx.globalAlpha = 0.5;
    ctx.filter = "grayscale(1)";
  }
  const plainBg = !face.active && !face.alert;
  shadow(ctx, env, 4, 1, "rgba(0,0,0,0.25)");
  dotPath();
  ctx.fillStyle = c.bg;
  if (plainBg && m.translucent) {
    // over a model: 85 % card colour; the shadow drawn at full strength first, then the see-through fill
    ctx.save();
    ctx.globalAlpha *= 0.85;
    ctx.fill();
    ctx.restore();
  } else ctx.fill();
  noShadow(ctx);
  const pic = face.picture ? env.image(face.picture) : null;
  if (pic) {
    ctx.save();
    dotPath();
    ctx.clip();
    const iw = (pic as HTMLImageElement).naturalWidth || dot.w,
      ih = (pic as HTMLImageElement).naturalHeight || dot.h;
    const s = Math.max(dot.w / iw, dot.h / ih); // object-fit: cover
    ctx.drawImage(pic, -iw * s * 0.5, -ih * s * 0.5, iw * s, ih * s);
    ctx.restore();
  }
  ctx.lineWidth = m.border;
  ctx.strokeStyle = c.border;
  if (face.unavailable) ctx.setLineDash([m.border * 2, m.border * 1.5]);
  roundRect(
    ctx,
    dot.x + m.border / 2,
    dot.y + m.border / 2,
    dot.w - m.border,
    dot.h - m.border,
    radius - m.border / 2,
  );
  ctx.stroke();
  ctx.setLineDash([]);
  if (!pic) {
    ctx.save();
    if (face.shape === "diamond") turn(ctx, -1); // the icon stays upright
    ctx.fillStyle = c.fg;
    paintIcon(ctx, env, face.icon, p.icon);
    ctx.restore();
  }
  if (face.kind === "value" && face.inner) {
    ctx.fillStyle = face.active ? c.fg : c.inner;
    ctx.font = font(env, 600, m.innerFont);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(face.inner, p.innerX, 0.5);
  }
  if (p.info) {
    const i = p.info;
    ctx.fillStyle = env.color("var(--secondary-text-color)", "#727272");
    ctx.beginPath();
    ctx.arc(i.x + 5, i.y + 5, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = card;
    ctx.font = "italic 700 8px Georgia, serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("i", i.x + 5, i.y + 5.5);
  }
  ctx.restore();
  // the value pill below
  if (p.value) {
    const v = p.value;
    ctx.save();
    shadow(ctx, env, 3, 1, "rgba(0,0,0,0.2)");
    roundRect(ctx, v.x, v.y, v.w, v.h, 8);
    ctx.fillStyle = card;
    ctx.fill();
    noShadow(ctx);
    ctx.fillStyle = env.color("var(--primary-text-color)", "#212121");
    ctx.font = font(env, 500, m.valueFont);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(face.value, 0, v.y + v.h / 2 + 0.5);
    ctx.restore();
  }
  // badges: low battery chip, logo, status dot
  if (p.battery) {
    const r = p.battery;
    ctx.save();
    shadow(ctx, env, 2, 1, "rgba(0,0,0,0.35)");
    roundRect(ctx, r.x, r.y, r.w, r.h, 7);
    ctx.fillStyle = "#fbc02d";
    ctx.fill();
    noShadow(ctx);
    ctx.fillStyle = "#212121";
    ctx.font = font(env, 700, 9.5);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${face.battery} %`, 0, r.y + r.h / 2 + 0.5);
    ctx.restore();
  }
  const logo = face.logo ? env.image(face.logo) : null;
  if (p.logo && logo) {
    const r = p.logo;
    ctx.save();
    shadow(ctx, env, 2, 1, "rgba(0,0,0,0.25)");
    roundRect(ctx, r.x, r.y, r.w, r.h, 4);
    ctx.fillStyle = card;
    ctx.fill();
    noShadow(ctx);
    ctx.lineWidth = 1;
    ctx.strokeStyle = env.color("var(--divider-color)", "rgba(0,0,0,0.15)");
    roundRect(ctx, r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1, 4.5);
    ctx.stroke();
    // object-fit: contain in the 12 px inside the 1 px padding
    const iw = (logo as HTMLImageElement).naturalWidth || 12,
      ih = (logo as HTMLImageElement).naturalHeight || 12;
    const s = Math.min(12 / iw, 12 / ih);
    ctx.drawImage(
      logo,
      r.x + 1 + (12 - iw * s) / 2,
      r.y + 1 + (12 - ih * s) / 2,
      iw * s,
      ih * s,
    );
    ctx.restore();
  }
  if (p.status && face.status) {
    const r = p.status;
    ctx.beginPath();
    ctx.arc(r.x + 5, r.y + 5, 5, 0, Math.PI * 2);
    ctx.fillStyle = card;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(r.x + 5, r.y + 5, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = STATUS_COLOR[face.status];
    ctx.fill();
  }
}

export const STATUS_COLOR: Record<StatusKind, string> = {
  green: "#43a047",
  grey: "#9e9e9e",
  red: "#e53935",
  yellow: "#fbc02d",
};

// ---------- how a marker is drawn this frame (instance attributes) ----------

/** Inputs of a marker's opacity / pickability besides its face. */
export interface MarkerDrawState {
  /** other floors of the All view, rooms the view hides (setMarkerStates faded) */
  faded: boolean;
  /** night_markers: hide, at night and not woken */
  quiet: boolean;
  /** an alert marker that is on (stays at night) */
  alert: boolean;
  hover: boolean;
}

/** Opacity in front of / behind the model, scale and whether a tap can land on it. */
export interface MarkerDraw {
  alpha: number;
  /** opacity where model geometry hides it (per pixel, from the depth buffer) */
  hiddenAlpha: number;
  scale: number;
  pickable: boolean;
}

export function markerDraw(s: MarkerDrawState): MarkerDraw {
  if (s.quiet && !s.alert)
    return { alpha: 0, hiddenAlpha: 0, scale: 1, pickable: false };
  const alpha = s.faded ? 0.3 : 1;
  return {
    alpha,
    hiddenAlpha: Math.min(alpha, 0.25),
    scale: s.hover ? 1.12 : 1,
    pickable: true,
  };
}
