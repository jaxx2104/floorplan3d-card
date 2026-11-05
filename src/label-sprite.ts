// Text sprites of the view (GPU, src/view/billboards.ts): room labels on the floor, object labels (charger
// power, climate temperature) above their object, and the chip next to the mower (offline / rain / drying).
// The look of the former DOM labels (.fp-room-label, .fp-obj-label, .fp-mower-chip).
import { paintIcon } from "./marker-sprite.ts";
import type { SpriteEnv, SpriteLayout, SpriteSpec } from "./sprite-atlas.ts";

const LABEL_PX = 11;

const labelFont = (env: SpriteEnv, italic: boolean) =>
  `${italic ? "italic " : ""}400 ${LABEL_PX}px ${env.font}`;

/** A room / object label. anchorY: where the 3D point sits in the text box (0.5 middle, 1.2 below it). */
export function labelSprite(
  text: string,
  {
    italic = false,
    anchorY = 0.5,
  }: { italic?: boolean; anchorY?: number } = {},
): SpriteSpec {
  const layout = (env: SpriteEnv): SpriteLayout => {
    const w = Math.ceil(
      env.measure(text, labelFont(env, italic)) + text.length * 0.22 + 2,
    );
    const h = Math.round(LABEL_PX * 1.2) + 2;
    return {
      w,
      h,
      ax: Math.round(w / 2),
      ay: Math.round(h * anchorY),
      hits: [],
    };
  };
  return {
    key: `l\u0001${italic ? 1 : 0}\u0001${anchorY}\u0001${text}`,
    layout,
    paint(ctx, env, l) {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = env.color("var(--secondary-text-color)", "#727272");
      ctx.font = labelFont(env, italic);
      (
        ctx as CanvasRenderingContext2D & { letterSpacing?: string }
      ).letterSpacing = "0.22px";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, l.w / 2, l.h / 2 + 0.5);
    },
  };
}

/** The mower chip: kind 'offline' | 'rain' | 'drying', an icon name (mdi:...) and text. */
export function chipSprite(
  kind: string,
  icon: string,
  text: string,
): SpriteSpec {
  const font = (env: SpriteEnv) => `600 11px ${env.font}`;
  const layout = (env: SpriteEnv): SpriteLayout => {
    const tw = text ? env.measure(text, font(env)) : 0;
    const w = Math.ceil(4 + 14 + (tw ? 3 + tw : 0) + 6),
      h = 16;
    const m = 4; // shadow
    // CSS2D centred the chip on the point, then moved it 20 px right and 18 px up
    return {
      w: w + 2 * m,
      h: h + 2 * m,
      ax: Math.round(m + w / 2 - 20),
      ay: Math.round(m + h / 2 + 18),
      hits: [],
    };
  };
  return {
    key: `c\u0001${kind}\u0001${icon}\u0001${text}`,
    deps: ["icon:name:" + icon],
    layout,
    paint(ctx, env, l) {
      const m = 4,
        w = l.w - 2 * m,
        h = l.h - 2 * m;
      ctx.shadowBlur = 3 * env.dpr;
      ctx.shadowOffsetY = env.dpr;
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.moveTo(m + 8, m);
      ctx.arcTo(m + w, m, m + w, m + h, 8);
      ctx.arcTo(m + w, m + h, m, m + h, 8);
      ctx.arcTo(m, m + h, m, m, 8);
      ctx.arcTo(m, m, m + w, m, 8);
      ctx.closePath();
      ctx.fillStyle = env.color("var(--card-background-color)", "#ffffff");
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.shadowColor = "transparent";
      ctx.fillStyle =
        kind === "rain" || kind === "drying"
          ? "#1e88e5"
          : kind === "offline"
            ? env.color("var(--secondary-text-color)", "#727272")
            : env.color("var(--primary-text-color)", "#212121");
      paintIcon(ctx, env, "name:" + icon, { x: m + 4, y: m + 1, w: 14, h: 14 });
      if (text) {
        ctx.font = font(env);
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(text, m + 4 + 14 + 3, m + h / 2 + 0.5);
      }
    },
  };
}
