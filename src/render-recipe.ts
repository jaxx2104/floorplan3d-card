// Render recipe of a model (extras.fp.render on a root node): renderer, camera, sun / lamp shadow and
// day / night light settings the model was designed with. normRender validates (numbers finite, ranges
// clamped, unknown keys ignored, warnings for invalid values); mergeRender fills the rest from the
// card's defaults (the values used before recipes existed).

import { normMaterialRules, type MaterialRule } from "./material-class.ts";

/** [sky colour, ground colour, intensity] */
export type HemiSetting = [number, number, number];
/** [colour, intensity] */
export type SunSetting = [number, number];
export interface SkySetting {
  hemi: HemiSetting;
  sun: SunSetting;
}
export interface CameraSetting {
  fov: number;
  near: number;
  far: number;
}
export interface SunShadowSetting {
  shadowMapSize: number;
  bias: number;
  normalBias: number;
}
export interface LampShadowSetting {
  max: number;
  mapSize: number;
  bias: number;
  normalBias: number;
  radius: number;
}

/** Full render settings (mergeRender): every key set. */
export interface RenderSettings {
  toneMapping: string;
  exposure: number;
  outputColorSpace: string;
  pixelRatioMax: number;
  anisotropy: number;
  camera: CameraSetting;
  sun: SunShadowSetting;
  lampShadows: LampShadowSetting;
  day: SkySetting;
  night: SkySetting;
  glowIntensityPerBrightness: number;
}

/** A validated recipe (normRender): only the keys the model set. */
export interface RenderRecipe {
  toneMapping?: string;
  exposure?: number;
  outputColorSpace?: string;
  pixelRatioMax?: number;
  anisotropy?: number;
  camera?: Partial<CameraSetting>;
  sun?: Partial<SunShadowSetting>;
  lampShadows?: Partial<LampShadowSetting>;
  day?: Partial<SkySetting>;
  night?: Partial<SkySetting>;
  glowIntensityPerBrightness?: number;
  /** Physical material rules (material-class.ts, applied at load): fp.render.materials, in order. */
  materials?: MaterialRule[];
}

type Frozen<T> = {
  readonly [K in keyof T]: T[K] extends unknown[]
    ? Readonly<T[K]>
    : T[K] extends object
      ? Frozen<T[K]>
      : T[K];
};

export const RENDER_DEFAULTS: Frozen<RenderSettings> = Object.freeze({
  toneMapping: "ACESFilmic",
  exposure: 1.25,
  outputColorSpace: "srgb",
  pixelRatioMax: 1.5,
  anisotropy: 8,
  camera: Object.freeze({ fov: 35, near: 0.3, far: 500 }),
  sun: Object.freeze({ shadowMapSize: 2048, bias: -0.0005, normalBias: 0.02 }),
  lampShadows: Object.freeze({
    max: 4,
    mapSize: 512,
    bias: -0.004,
    normalBias: 0,
    radius: 1,
  }),
  day: Object.freeze({
    hemi: Object.freeze([0xc4d6ff, 0x2a2520, 0.9] as HemiSetting),
    sun: Object.freeze([0xfff0dc, 2.6] as SunSetting),
  }),
  night: Object.freeze({
    hemi: Object.freeze([0xc4d6ff, 0x2a2520, 0.14] as HemiSetting),
    sun: Object.freeze([0xfff0dc, 0] as SunSetting),
  }),
  glowIntensityPerBrightness: 3,
});

export const TONE_MAPPINGS = [
  "None",
  "Linear",
  "Reinhard",
  "Cineon",
  "ACESFilmic",
  "AgX",
  "Neutral",
];
const COLOR_SPACES = ["srgb", "srgb-linear"];

type NumKind = "int" | "pow2";
// [min, max, kind] per numeric key; kind 'pow2' rounds down to a power of two, 'int' rounds
const NUM: Record<string, [number, number, NumKind?]> = {
  exposure: [0.05, 4],
  pixelRatioMax: [0.5, 3],
  anisotropy: [1, 16, "int"],
  glowIntensityPerBrightness: [0, 20],
  "camera.fov": [10, 100],
  "camera.near": [0.01, 10],
  "camera.far": [10, 10000],
  "sun.shadowMapSize": [256, 4096, "pow2"],
  "sun.bias": [-0.01, 0.01],
  "sun.normalBias": [0, 0.5],
  "lampShadows.max": [0, 8, "int"],
  "lampShadows.mapSize": [128, 1024, "pow2"],
  "lampShadows.bias": [-0.05, 0.05],
  "lampShadows.normalBias": [0, 0.5],
  "lampShadows.radius": [0, 10],
};
const GROUPS = {
  camera: ["fov", "near", "far"],
  sun: ["shadowMapSize", "bias", "normalBias"],
  lampShadows: ["max", "mapSize", "bias", "normalBias", "radius"],
} as const;
const SKY_MAX = { hemi: 10, sun: 20 };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === "object" && !Array.isArray(v);

// '#rrggbb' / 'rrggbb' / 0xrrggbb -> number or null
export function hexColor(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffff)
    return v;
  if (typeof v === "string" && /^#?[0-9a-f]{6}$/i.test(v.trim()))
    return parseInt(v.trim().replace("#", ""), 16);
  return null;
}

const finite = (v: unknown): v is number => Number.isFinite(v);

// raw extras.fp.render -> { recipe (valid keys only) | null, warnings, keys (top-level keys kept) }
export function normRender(raw: unknown): {
  recipe: RenderRecipe | null;
  warnings: string[];
  keys: number;
} {
  const warnings: string[] = [];
  if (raw === undefined || raw === null)
    return { recipe: null, warnings, keys: 0 };
  if (!isObj(raw))
    return { recipe: null, warnings: ["render: needs an object"], keys: 0 };
  const out: Obj = {};
  const num = (path: string, v: unknown): number | undefined => {
    const [lo, hi, kind] = NUM[path];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      warnings.push(`render.${path}: needs a number`);
      return undefined;
    }
    let x = v;
    if (kind === "int") x = Math.round(x);
    if (x < lo || x > hi) {
      warnings.push(`render.${path}: ${v} out of range ${lo}..${hi}, clamped`);
      x = Math.min(hi, Math.max(lo, x));
    }
    if (kind === "pow2") x = 2 ** Math.floor(Math.log2(x));
    return x;
  };
  for (const k of [
    "exposure",
    "pixelRatioMax",
    "anisotropy",
    "glowIntensityPerBrightness",
  ]) {
    if (raw[k] === undefined) continue;
    const v = num(k, raw[k]);
    if (v !== undefined) out[k] = v;
  }
  if (raw.toneMapping !== undefined) {
    if (TONE_MAPPINGS.includes(raw.toneMapping as string))
      out.toneMapping = raw.toneMapping;
    else
      warnings.push(
        `render.toneMapping: "${raw.toneMapping}" is not one of ${TONE_MAPPINGS.join(", ")}`,
      );
  }
  if (raw.outputColorSpace !== undefined) {
    if (COLOR_SPACES.includes(raw.outputColorSpace as string))
      out.outputColorSpace = raw.outputColorSpace;
    else
      warnings.push(
        `render.outputColorSpace: "${raw.outputColorSpace}" is not one of ${COLOR_SPACES.join(", ")}`,
      );
  }
  for (const [g, keys] of Object.entries(GROUPS)) {
    const group = raw[g];
    if (group === undefined) continue;
    if (!isObj(group)) {
      warnings.push(`render.${g}: needs an object`);
      continue;
    }
    const o: Obj = {};
    for (const k of keys) {
      if (group[k] === undefined) continue;
      const v = num(`${g}.${k}`, group[k]);
      if (v !== undefined) o[k] = v;
    }
    if (Object.keys(o).length) out[g] = o;
  }
  for (const part of ["day", "night"]) {
    const p = raw[part];
    if (p === undefined) continue;
    if (!isObj(p)) {
      warnings.push(`render.${part}: needs an object`);
      continue;
    }
    const o: Partial<SkySetting> = {};
    const h = p.hemi,
      s = p.sun;
    if (h !== undefined) {
      const ok =
        Array.isArray(h) &&
        h.length === 3 &&
        hexColor(h[0]) !== null &&
        hexColor(h[1]) !== null &&
        finite(h[2]);
      if (ok)
        o.hemi = [
          hexColor(h[0])!,
          hexColor(h[1])!,
          Math.min(SKY_MAX.hemi, Math.max(0, h[2])),
        ];
      else
        warnings.push(
          `render.${part}.hemi: needs [skyColour, groundColour, intensity]`,
        );
    }
    if (s !== undefined) {
      const ok =
        Array.isArray(s) &&
        s.length === 2 &&
        hexColor(s[0]) !== null &&
        finite(s[1]);
      if (ok)
        o.sun = [hexColor(s[0])!, Math.min(SKY_MAX.sun, Math.max(0, s[1]))];
      else warnings.push(`render.${part}.sun: needs [colour, intensity]`);
    }
    if (Object.keys(o).length) out[part] = o;
  }
  if (raw.materials !== undefined) {
    const m = normMaterialRules(raw.materials, "render.materials");
    warnings.push(...m.warnings);
    if (m.rules.length) out.materials = m.rules;
  }
  const keys = Object.keys(out).length;
  return { recipe: keys ? (out as RenderRecipe) : null, warnings, keys };
}

// recipe (normalized) or null -> full settings (defaults for every missing key)
export function mergeRender(
  recipe: RenderRecipe | null | undefined,
): RenderSettings {
  const d = RENDER_DEFAULTS,
    r = recipe || {};
  const sky = (part: "day" | "night"): SkySetting => ({
    hemi: [...((r[part] && r[part].hemi) || d[part].hemi)] as HemiSetting,
    sun: [...((r[part] && r[part].sun) || d[part].sun)] as SunSetting,
  });
  return {
    toneMapping: r.toneMapping ?? d.toneMapping,
    exposure: r.exposure ?? d.exposure,
    outputColorSpace: r.outputColorSpace ?? d.outputColorSpace,
    pixelRatioMax: r.pixelRatioMax ?? d.pixelRatioMax,
    anisotropy: r.anisotropy ?? d.anisotropy,
    camera: { ...d.camera, ...r.camera },
    sun: { ...d.sun, ...r.sun },
    lampShadows: { ...d.lampShadows, ...r.lampShadows },
    day: sky("day"),
    night: sky("night"),
    glowIntensityPerBrightness:
      r.glowIntensityPerBrightness ?? d.glowIntensityPerBrightness,
  };
}

export interface ShadowCap {
  max: number;
  mapSize: number;
}

// Lamp shadow maps this device affords -> { max, mapSize }: 4 at 512 on touch devices, dense screens
// (dpr > 2) or <= 4 cores, else 6 at up to 1024.
export function deviceShadowCap({
  touch = false,
  dpr = 1,
  cores = 8,
}: { touch?: boolean; dpr?: number; cores?: number } = {}): ShadowCap {
  return touch || dpr > 2 || (Number.isFinite(cores) && cores <= 4)
    ? { max: 4, mapSize: 512 }
    : { max: 6, mapSize: 1024 };
}

// Shadow-casting lamps: min(recipe max, device max, texture units left: maxTextures - 9 for the
// material's own maps, the sun's shadow map and the rest).
export function lampShadowSlots(
  max: number,
  cap: ShadowCap,
  maxTextures: number | null | undefined,
): number {
  const units = finite(maxTextures) ? Math.max(0, maxTextures - 9) : Infinity;
  return Math.max(0, Math.min(max, cap.max, units));
}

// Lamp shadow map size: the recipe's, at most 1024 and the device cap.
export const lampMapSize = (size: number, cap: ShadowCap): number =>
  Math.min(size, 1024, cap.mapSize);

// Camera far with the recipe's far as an upper bound that never cuts what the scene needs.
export function recipeFar(
  dynamicFar: number,
  neededFar: number,
  cap: number | null | undefined,
): number {
  if (!finite(cap)) return dynamicFar;
  return Math.max(neededFar, Math.min(dynamicFar, cap));
}

const mixHex = (a: number, b: number, t: number): number => {
  const c = (s: number) =>
    Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * t);
  return (c(16) << 16) | (c(8) << 8) | c(0);
};

export interface DayNight {
  day: number;
  night: number;
}

// Card option background: '#rrggbb' for both, or { day, night } -> { day, night } hex numbers.
// Missing or invalid colours fall back to the defaults (dark grey by day, near black at night).
export const BACKGROUND_DEFAULTS: Readonly<DayNight> = Object.freeze({
  day: 0x2a2d30,
  night: 0x0e0f10,
});
const parseHex = (v: unknown): number | null => {
  const m =
    typeof v === "string" && /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return parseInt(h, 16);
};
export function backgroundColors(opt: unknown): DayNight {
  const d = BACKGROUND_DEFAULTS;
  const o: { day?: unknown; night?: unknown } =
    typeof opt === "string"
      ? { day: opt, night: opt }
      : (opt as { day?: unknown; night?: unknown }) || {};
  return { day: parseHex(o.day) ?? d.day, night: parseHex(o.night) ?? d.night };
}

// Background at night 0..1 (hex).
export const backgroundAt = (bg: DayNight, night: unknown): number =>
  mixHex(bg.day, bg.night, Math.max(0, Math.min(1, Number(night) || 0)));

export interface SkyLights {
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  sunColor: number;
  sunIntensity: number;
}

// Day / night blend (night 0..1) of the merged settings -> colours (hex) and intensities before weather.
export function skyLights(
  render: Pick<RenderSettings, "day" | "night">,
  night: unknown,
): SkyLights {
  const t = Math.max(0, Math.min(1, Number(night) || 0)),
    d = render.day,
    n = render.night;
  return {
    hemiSky: mixHex(d.hemi[0], n.hemi[0], t),
    hemiGround: mixHex(d.hemi[1], n.hemi[1], t),
    hemiIntensity: d.hemi[2] + (n.hemi[2] - d.hemi[2]) * t,
    sunColor: mixHex(d.sun[0], n.sun[0], t),
    sunIntensity: d.sun[1] + (n.sun[1] - d.sun[1]) * t,
  };
}

// Card option surround_light: ambient light of the city around the house, outside the rooms only (the
// rooms keep their own light). true | { day, night } intensities -> settings or null (off).
export const SURROUND_DEFAULTS: Readonly<DayNight> = Object.freeze({
  day: 0.25,
  night: 0.2,
});
// sky / ground colours: bright sky by day; by night a dim city sky above and the warm street lights below
export const SURROUND_COLORS = Object.freeze({
  day: Object.freeze({ sky: 0xc4d6ff, ground: 0xb0a492 }),
  night: Object.freeze({ sky: 0x8e9ac4, ground: 0xd09060 }),
});
export function normSurroundLight(opt: unknown): DayNight | null {
  if (!opt) return null;
  const o = opt === true ? {} : typeof opt === "object" ? (opt as Obj) : null;
  if (!o) return null;
  const val = (k: keyof DayNight) => {
    const v = Number(o[k]);
    return o[k] === undefined || !Number.isFinite(v)
      ? SURROUND_DEFAULTS[k]
      : Math.min(4, Math.max(0, v));
  };
  return { day: val("day"), night: val("night") };
}

// Settings (or null) and night 0..1 -> { sky, ground (hex), intensity }.
export function surroundLight(
  settings: DayNight | null,
  night: unknown,
): { sky: number; ground: number; intensity: number } {
  const t = Math.max(0, Math.min(1, Number(night) || 0)),
    C = SURROUND_COLORS;
  return {
    sky: mixHex(C.day.sky, C.night.sky, t),
    ground: mixHex(C.day.ground, C.night.ground, t),
    intensity: settings
      ? settings.day + (settings.night - settings.day) * t
      : 0,
  };
}

export interface CityLights {
  windows: string[];
  glow: string[];
  share: number;
  strength: number;
  street: number;
  glass: number;
}

// Card option city_lights: lights of the city at night. true | { windows: [mesh / material names or layers
// with lit windows], glow: [the same, lit glass: lobby, shop fronts], share (of the windows lit), strength
// (windows), street (street lamp light), glass (lit glass) } -> settings or null (off).
export const CITY_DEFAULTS = Object.freeze({
  windows: Object.freeze(["neighbors"]),
  glow: Object.freeze([] as string[]),
  share: 0.45,
  strength: 0.6,
  street: 1.2,
  glass: 0.35,
});
export function normCityLights(opt: unknown): CityLights | null {
  if (!opt) return null;
  const o = opt === true ? {} : typeof opt === "object" ? (opt as Obj) : null;
  if (!o) return null;
  const num = (k: "share" | "strength" | "street" | "glass") => {
    const v = Number(o[k]);
    return o[k] === undefined || !Number.isFinite(v)
      ? CITY_DEFAULTS[k]
      : Math.min(k === "share" ? 1 : 10, Math.max(0, v));
  };
  const list = (k: "windows" | "glow"): string[] =>
    o[k] === undefined
      ? [...CITY_DEFAULTS[k]]
      : ([] as unknown[])
          .concat(o[k])
          .filter((x): x is string => typeof x === "string" && !!x);
  return {
    windows: list("windows"),
    glow: list("glow"),
    share: num("share"),
    strength: num("strength"),
    street: num("street"),
    glass: num("glass"),
  };
}

// How a model mesh lights up at night: 'glow' or 'windows' when its name, a material's or a parent's name or
// one of its layers is in that list (glow first), else null.
export function cityLitFor(
  names: string[],
  layers: string[],
  city: CityLights | null,
): "glow" | "windows" | null {
  if (!city) return null;
  const hit = (list: string[]) =>
    list.some((w) => names.includes(w) || layers.includes(w));
  return hit(city.glow) ? "glow" : hit(city.windows) ? "windows" : null;
}

// Night 0..1 -> how much the city lights are on (after dusk, full by night).
export const cityLightsOn = (night: unknown): number => {
  const t = Math.max(0, Math.min(1, (Number(night) - 0.35) / 0.4));
  return t * t * (3 - 2 * t);
};

// --- card option render: recipe source, quality tier, tone mapping ---

/** Quality tiers, cheapest first. 'high' is the default; 'standard' is the look before tiers existed (the cheap tier). */
export type Quality = "standard" | "high" | "still";
/** What a tier turns on. A new effect adds a field here, off in 'standard', so 'standard' stays as it was. */
export interface QualityTier {
  /** Tone mapping when the card sets none (null: the recipe's). */
  toneMapping: string | null;
  /** Image-based light from the sky (view/env-light.ts). */
  envLight: boolean;
  /** Hemisphere light factor: 1 without envLight; 0 with it (the sky's environment light is the fill, and indoors the
   * room probes: a hemisphere light on top lit every surface a second time, unoccluded, closed rooms included). */
  hemiScale: number;
  /** Lamps in physical units: blackbody colour from color_temp_kelvin, candela from lumens (photometry.ts). */
  physicalLights: boolean;
  /** Bloom of emissive things only (lamp glows, screens), skipped while none is in view (bloom.ts). */
  bloom: boolean;
  /** Spread of the sun shadow's PCF taps in shadow-map texels at clear sky (three's PCFShadowMap, shadow.radius; clouds
   * widen it, weather.ts cloudLight). A uniform: a tier change redraws nothing and recompiles no shader. */
  sunShadowRadius: number;
  /** Soft dark grounding where things meet the floors, baked per storey when the casters change (contact-shadow.ts). */
  contactShadows: boolean;
  /** Per-room light probes: each room's captured light (sun through windows, lamps, sky) as its ambient fill (light-probes.ts). */
  lightProbes: boolean;
  /** Lightmaps baked into the model (extras fp_lightmap on a second UV set) as the ambient light of their surfaces (lightmap.ts). */
  bakedLightmaps: boolean;
  /** Idle progressive path tracing: the view traced and faded in once the camera has been still (still.ts). */
  pathTrace: boolean;
}
export const QUALITY_TIERS: Readonly<Record<Quality, Readonly<QualityTier>>> =
  Object.freeze({
    standard: Object.freeze({
      toneMapping: null,
      envLight: false,
      hemiScale: 1,
      physicalLights: false,
      bloom: false,
      sunShadowRadius: 1.5,
      contactShadows: false,
      lightProbes: false,
      bakedLightmaps: false,
      pathTrace: false,
    }),
    high: Object.freeze({
      toneMapping: "AgX",
      envLight: true,
      hemiScale: 0,
      physicalLights: true,
      bloom: true,
      sunShadowRadius: 3,
      contactShadows: true,
      lightProbes: true,
      bakedLightmaps: true,
      pathTrace: false,
    }),
    // experimental (desktop GPUs): 'high' while the camera moves; path traced once the view is idle (still.ts)
    still: Object.freeze({
      toneMapping: "AgX",
      envLight: true,
      hemiScale: 0,
      physicalLights: true,
      bloom: true,
      sunShadowRadius: 3,
      contactShadows: true,
      lightProbes: true,
      bakedLightmaps: true,
      pathTrace: true,
    }),
  });
export const QUALITIES = Object.keys(QUALITY_TIERS) as Quality[];
/** Card option render.quality: a tier, or 'auto' (high, stepping down to standard and back by the measured
 * frame times; auto-quality.ts). */
export type QualityOption = Quality | "auto";
export const QUALITY_OPTIONS: readonly QualityOption[] = Object.freeze([
  "auto",
  ...QUALITIES,
]);

// Card YAML names of the tone mappings (lower case) -> three's names (TONE_MAPPINGS).
export const TONE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  none: "None",
  linear: "Linear",
  reinhard: "Reinhard",
  cineon: "Cineon",
  aces: "ACESFilmic",
  acesfilmic: "ACESFilmic",
  agx: "AgX",
  neutral: "Neutral",
});
const TONE_NAMES = Object.keys(TONE_ALIASES).filter((a) => a !== "acesfilmic");

/** Card option render, normalised: which recipe, the quality tier, the tone mapping (null: tier / recipe), the
 * physical material rules (set only when given; they come after the model's and apply at the next model load). */
export interface RenderOption {
  recipe: "model" | "default";
  quality: QualityOption;
  toneMapping: string | null;
  materials?: MaterialRule[];
}
export const RENDER_OPTION_DEFAULTS: Readonly<RenderOption> = Object.freeze({
  recipe: "model",
  quality: "auto",
  toneMapping: null,
});

// Card option render: 'model' | 'default' (the recipe only, as before), or { recipe: 'model' | 'default',
// quality: 'auto' (default: high, adapting to the frame times; auto-quality.ts) | 'high' | 'standard' (cheaper, the look before tiers) | 'still' (experimental: idle path tracing, for desktop GPUs; still.ts), tone_mapping: 'aces' | 'agx' | 'neutral' | 'reinhard' | 'cineon' | 'linear' | 'none',
// materials: { '<selector>': glass | floor | fabric | none } }
// -> { option, warnings }. An invalid value keeps its default and adds a warning; unknown keys add one too.
export function normRenderOption(opt: unknown): {
  option: RenderOption;
  warnings: string[];
} {
  const option: RenderOption = { ...RENDER_OPTION_DEFAULTS },
    warnings: string[] = [];
  if (opt === undefined || opt === null) return { option, warnings };
  const recipe = (v: unknown, at: string) => {
    if (v === "model" || v === "default") option.recipe = v;
    else warnings.push(`${at}: "${String(v)}" is not one of model, default`);
  };
  if (typeof opt === "string") {
    recipe(opt, "render");
    return { option, warnings };
  }
  if (!isObj(opt)) {
    warnings.push("render: needs model, default or an object");
    return { option, warnings };
  }
  for (const [k, v] of Object.entries(opt)) {
    if (v === undefined || v === null) continue;
    if (k === "recipe") recipe(v, "render.recipe");
    else if (k === "quality") {
      if (QUALITY_OPTIONS.includes(v as QualityOption))
        option.quality = v as QualityOption;
      else
        warnings.push(
          `render.quality: "${String(v)}" is not one of ${QUALITY_OPTIONS.join(", ")}`,
        );
    } else if (k === "tone_mapping") {
      const name =
        typeof v === "string"
          ? TONE_ALIASES[v.trim().toLowerCase()]
          : undefined;
      if (name) option.toneMapping = name;
      else
        warnings.push(
          `render.tone_mapping: "${String(v)}" is not one of ${TONE_NAMES.join(", ")}`,
        );
    } else if (k === "materials") {
      const m = normMaterialRules(v, "render.materials");
      warnings.push(...m.warnings);
      option.materials = m.rules;
    } else warnings.push(`render.${k}: unknown option, ignored`);
  }
  return { option, warnings };
}

const sat = (x: number) => Math.max(0, Math.min(1, x));

// three's tone mapping curves (tonemapping_pars_fragment, r169) for a grey input (their matrices keep
// greys grey): scene value x (exposure applied) -> display-linear 0..1.
export function toneGrey(toneMapping: string, x: number): number {
  switch (toneMapping) {
    case "None":
    case "Linear":
      return sat(x);
    case "Reinhard":
      return sat(x / (1 + x));
    case "Cineon": {
      const c = Math.max(0, x - 0.004);
      return Math.pow(
        (c * (6.2 * c + 0.5)) / (c * (6.2 * c + 1.7) + 0.06),
        2.2,
      );
    }
    case "AgX": {
      const v = sat(
        (Math.log2(Math.max(x, 1e-10)) + 12.47393) / (4.026069 + 12.47393),
      );
      const v2 = v * v,
        v4 = v2 * v2;
      const s =
        15.5 * v4 * v2 -
        40.14 * v4 * v +
        31.96 * v4 -
        6.868 * v2 * v +
        0.4298 * v2 +
        0.1191 * v -
        0.00232;
      return sat(Math.pow(Math.max(0, s), 2.2));
    }
    case "Neutral": {
      const start = 0.8 - 0.04,
        d = 1 - start;
      let c = x - (x < 0.08 ? x - 6.25 * x * x : 0.04);
      if (c < start) return c;
      const peak = c,
        np = 1 - (d * d) / (peak + d - start);
      c *= np / peak;
      const g = 1 - 1 / (0.15 * (peak - np) + 1);
      return c + (np - c) * g;
    }
    default: {
      // ACESFilmic
      const v = x / 0.6;
      return sat(
        (v * (v + 0.0245786) - 0.000090537) /
          (v * (0.983729 * v + 0.432951) + 0.238081),
      );
    }
  }
}

// Exposure for tone mapping `to` that shows mid grey (0.18) as `from` at `exposure` does (bisection: the
// curves rise monotonically), within the recipe's exposure range.
export function matchExposure(
  from: string,
  exposure: number,
  to: string,
): number {
  if (from === to) return exposure;
  const [lo0, hi0] = NUM.exposure,
    want = toneGrey(from, 0.18 * exposure);
  if (toneGrey(to, 0.18 * hi0) <= want) return hi0;
  if (toneGrey(to, 0.18 * lo0) >= want) return lo0;
  let lo = lo0,
    hi = hi0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (toneGrey(to, 0.18 * mid) < want) lo = mid;
    else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 1000) / 1000;
}

// Tone mapping and exposure on screen: the card's tone_mapping, else the tier's, else the recipe's. Another
// tone mapping than the recipe's gets the exposure that keeps mid grey where the recipe had it. quality: the tier
// in use ('auto' picks one; without it 'auto' counts as high).
export function renderTone(
  render: Pick<RenderSettings, "toneMapping" | "exposure">,
  option: RenderOption,
  quality: Quality = option.quality === "auto" ? "high" : option.quality,
): { toneMapping: string; exposure: number } {
  const toneMapping =
    option.toneMapping ??
    QUALITY_TIERS[quality].toneMapping ??
    render.toneMapping;
  return {
    toneMapping,
    exposure: matchExposure(render.toneMapping, render.exposure, toneMapping),
  };
}
