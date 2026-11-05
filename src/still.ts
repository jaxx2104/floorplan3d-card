// Idle progressive path tracing (render quality 'still', QualityTier.pathTrace): the rules, without three or the
// path tracer. While the camera moves the 'still' tier draws exactly what 'high' draws. Once the view has been
// idle for STILL_IDLE_MS (no frame was due: the render loop is asleep) and nothing holds the trace off, the
// current view is path traced (three-gpu-pathtracer, loaded on demand: src/path-tracer.ts) at STILL_SCALE of
// the drawing buffer, one tile a frame. The traced image never shows worse than the raster frame: nothing is
// drawn before STILL_FADE_FROM samples (the raster frame stays as it is), then the denoised trace fades in until
// STILL_FADE_TO and keeps refining to STILL_MAX_SAMPLES or STILL_MAX_MS; the last image then stays on screen with
// the loop asleep again. A device too slow to reach STILL_FADE_FROM within the time keeps the raster frame. Any frame that is due (camera, hass state, lamp, sun step, edit mode, resize: everything
// that sets view.dirty) ends the session first, so the raster frame that follows replaces the traced image.

/** Idle time (ms) before a trace starts. */
export const STILL_IDLE_MS = 3000;
/** Budget of a session: samples per pixel and time (ms), whichever comes first. */
export const STILL_MAX_SAMPLES = 512;
export const STILL_MAX_MS = 60000;
/** The fade: the trace shows from STILL_FADE_FROM samples (noise-free enough once denoised), fully at STILL_FADE_TO. */
export const STILL_FADE_FROM = 128;
export const STILL_FADE_TO = 256;
/** Headless checks (SwiftShader is slow): a few samples only, the fade from the first to the last. */
export const STILL_TEST_SAMPLES = 3;
/** Denoise of the traced image (path-tracer.ts): a-trous passes (steps 1, 2, 4, ... texels of the trace), depth
 * tolerance (share of the depth per step), luminance tolerance (tone-mapped 0..1: keeps shadow edges), normal
 * sharpness (power of the normals' cosine). The first pass also cuts fireflies to their neighbours' brightest. */
export const STILL_DENOISE = Object.freeze({
  passes: 3,
  depth: 0.02,
  luminance: 0.15,
  normal: 32,
});
/** A path's radiance (linear luminance) is capped at this before it is accumulated (fireflies). */
export const STILL_SAMPLE_MAX = 6;
/** Trace resolution: this share of the drawing buffer per side (upscaled when drawn). */
export const STILL_SCALE = 0.5;
/** Tiles per sample (a tile per frame keeps every frame short). */
export const STILL_TILES = 2;
/** Bounces of a path (transmissive: through glass). */
export const STILL_BOUNCES = 5;
export const STILL_TRANSMISSIVE_BOUNCES = 3;

/** What a session may spend, and when its image shows (samples). */
export interface StillBudget {
  samples: number;
  ms: number;
  fadeFrom: number;
  fadeTo: number;
}

// The budget: in test mode a few samples (the fade from the first sample, full at the last), else
// STILL_MAX_SAMPLES / STILL_MAX_MS with the fade from STILL_FADE_FROM to STILL_FADE_TO.
export function stillBudget(test: boolean): StillBudget {
  if (test)
    return {
      samples: STILL_TEST_SAMPLES,
      ms: STILL_MAX_MS,
      fadeFrom: 1,
      fadeTo: STILL_TEST_SAMPLES,
    };
  return {
    samples: STILL_MAX_SAMPLES,
    ms: STILL_MAX_MS,
    fadeFrom: STILL_FADE_FROM,
    fadeTo: STILL_FADE_TO,
  };
}

/** Why no trace runs now (null: one may). */
export type StillHold =
  "tier" | "model" | "offscreen" | "hidden" | "edit" | "clip" | "idle" | null;

/** Inputs of the start decision. */
export interface StillState {
  /** the quality tier traces ('still') */
  tier: boolean;
  /** a model is loaded (the tiers' effects are for models) */
  model: boolean;
  /** the card is on screen (IntersectionObserver) */
  onScreen: boolean;
  /** the page is visible */
  visible: boolean;
  /** edit mode is open */
  editing: boolean;
  /** a cut-away plane or the side section clips the model (the path tracer cannot clip) */
  clipped: boolean;
  /** ms since the last frame was drawn */
  idleFor: number;
  idleMs?: number;
}

// Whether a trace may start now, else what holds it off (checked in this order).
export function stillHold(s: StillState): StillHold {
  if (!s.tier) return "tier";
  if (!s.model) return "model";
  if (!s.onScreen) return "offscreen";
  if (!s.visible) return "hidden";
  if (s.editing) return "edit";
  if (s.clipped) return "clip";
  if (!(s.idleFor >= (s.idleMs ?? STILL_IDLE_MS))) return "idle";
  return null;
}

// Opacity of the traced image over the raster frame: 0 below budget.fadeFrom samples (nothing drawn), rising to 1
// at budget.fadeTo.
export function stillFade(samples: number, budget: StillBudget): number {
  if (!(samples >= budget.fadeFrom)) return 0;
  if (!(budget.fadeTo > budget.fadeFrom)) return 1;
  return Math.min(
    1,
    (samples - budget.fadeFrom) / (budget.fadeTo - budget.fadeFrom),
  );
}

// The session has spent its budget.
export const stillDone = (
  samples: number,
  elapsedMs: number,
  budget: StillBudget,
): boolean => samples >= budget.samples || elapsedMs >= budget.ms;

// Trace resolution for a drawing buffer (px): STILL_SCALE per side, at least 1 px.
export function stillSize(
  w: number,
  h: number,
  scale = STILL_SCALE,
): [number, number] {
  return [
    Math.max(1, Math.floor(w * scale)),
    Math.max(1, Math.floor(h * scale)),
  ];
}
