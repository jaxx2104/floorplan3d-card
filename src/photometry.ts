// Physical lamp light (render quality 'high', QualityTier.physicalLights): colour from the light's colour
// temperature on the Planckian (blackbody) locus, intensity in candela (three r169's unit for point and spot
// lights) from a luminous flux scaled by HA brightness. Pure functions, unit-tested.
import type { HassEntity } from './types/ha.ts';

type Rgb = readonly number[];

export const KELVIN_RANGE: readonly [number, number] = [1667, 25000]; // where the locus fit below holds
/** Colour temperature of a lamp that reports neither colour nor colour temperature (a warm white bulb). */
export const DEFAULT_KELVIN = 2700;
/** Luminous flux (lm) at full brightness when the model sets none (hints.lumens): a 60 W-class LED bulb for a
 * point lamp, a typical spot / wall uplight for a spot. */
export const DEFAULT_LUMENS: Readonly<Record<'point' | 'spot', number>> = Object.freeze({ point: 800, spot: 300 });
/**
 * Candela -> scene units. The recipe's sun and sky are not in lux, so photometric lamps are brought into the
 * same range, like a camera's exposure for a lit interior at night: an 800 lm bulb (64 cd) shows as ~16, what
 * the recipes' ceiling lamps were tuned to, and every other lamp follows from its flux, beam and brightness.
 */
export const LAMP_EXPOSURE = 0.25;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// CIE 1931 xy of the Planckian locus at T kelvin (Kim et al. 2002 cubic fit, 1667 K .. 25000 K).
export function planckXy(kelvin: number): [number, number] {
  const T = clamp(Number(kelvin) || DEFAULT_KELVIN, KELVIN_RANGE[0], KELVIN_RANGE[1]);
  const t = 1e3 / T, t2 = t * t, t3 = t2 * t; // the fit's 1e9 / T³, 1e6 / T², 1e3 / T terms
  const x = T <= 4000
    ? -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t + 0.17991
    : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.24039;
  const x2 = x * x, x3 = x2 * x;
  const y = T <= 2222 ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
    : T <= 4000 ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
      : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

// Blackbody colour at T kelvin, linear sRGB (Rec. 709 primaries, D65), the brightest channel 1.
export function kelvinRgb(kelvin: number): [number, number, number] {
  const [x, y] = planckXy(kelvin);
  const X = x / y, Z = (1 - x - y) / y; // Y = 1
  const rgb = [
    3.2404542 * X - 1.5371385 - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 + 0.041556 * Z,
    0.0556434 * X - 0.2040259 + 1.0572252 * Z,
  ].map((v) => Math.max(0, v));
  const m = Math.max(...rgb);
  return rgb.map((v) => v / m) as [number, number, number];
}

const encode = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

// The same colour as sRGB 0..255 (what HA's rgb_color and the layer's colours use).
export function kelvinSrgb(kelvin: number): Rgb {
  return kelvinRgb(kelvin).map((c) => Math.round(clamp(encode(c), 0, 1) * 255));
}

const RGB_MODES = new Set(['hs', 'rgb', 'rgbw', 'rgbww', 'xy']);

/**
 * A lamp's colour for physical light, sRGB 0..255: its colour temperature on the blackbody locus when it
 * reports one (color_mode color_temp, or a colour temperature and no colour), its colour when it reports a
 * colour (rgb_color, else hs_color), else a warm white bulb (DEFAULT_KELVIN). rgb: the colour the standard
 * tier would use for rgb_color / hs_color (logic.ts lightColor), so both tiers agree on coloured light.
 */
export function physicalColor(s: Pick<HassEntity, 'attributes'> | null | undefined, rgb: (s: Pick<HassEntity, 'attributes'> | null | undefined) => Rgb): Rgb {
  const a: HassEntity['attributes'] = (s && s.attributes) || {};
  const k = Number(a.color_temp_kelvin), mode = typeof a.color_mode === 'string' ? a.color_mode : null;
  const hasColour = Array.isArray(a.rgb_color) || Array.isArray(a.hs_color);
  if (k > 0 && (mode === 'color_temp' || (!hasColour && !(mode && RGB_MODES.has(mode))))) return kelvinSrgb(k);
  if (hasColour) return rgb(s);
  return kelvinSrgb(DEFAULT_KELVIN);
}

/**
 * Luminous intensity (cd) of a lamp emitting `lumens`: a point light evenly over the whole sphere (Φ / 4π), a
 * spot as Φ / π (Filament's convention: a bulb in a reflector that loses what falls outside the cone, so a
 * narrower cone does not get brighter, and a spot reads like a point lamp of the same flux aimed one way).
 */
export function lumensToCandela(lumens: number, beam: 'point' | 'spot' = 'point'): number {
  const lm = Math.max(0, Number(lumens) || 0);
  return beam === 'spot' ? lm / Math.PI : lm / (4 * Math.PI);
}

/** Pool light intensity (scene units) of a lamp at HA brightness level 0..1; lumens null: DEFAULT_LUMENS. */
export const lampIntensity = (lumens: number | null | undefined, level: number, beam: 'point' | 'spot'): number =>
  lumensToCandela((lumens ?? DEFAULT_LUMENS[beam]) * clamp(Number(level) || 0, 0, 1), beam) * LAMP_EXPOSURE;
