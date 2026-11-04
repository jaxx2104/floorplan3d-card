// Idle progressive path tracing (render quality 'still', QualityTier.pathTrace): the rules, without three or the
// path tracer. While the camera moves the 'still' tier draws exactly what 'high' draws. Once the view has been
// idle for STILL_IDLE_MS (no frame was due: the render loop is asleep) and nothing holds the trace off, the
// current view is path traced (three-gpu-pathtracer, loaded on demand: src/path-tracer.ts) at STILL_SCALE of
// the drawing buffer, one tile a frame, and faded in over the raster frame as its samples add up. The budget
// ends a session at STILL_MAX_SAMPLES samples or STILL_MAX_MS; the last image then stays on screen with the
// loop asleep again. Any frame that is due (camera, hass state, lamp, sun step, edit mode, resize: everything
// that sets view.dirty) ends the session first, so the raster frame that follows replaces the traced image.

/** Idle time (ms) before a trace starts. */
export const STILL_IDLE_MS = 3000;
/** Budget of a session: samples per pixel and time (ms), whichever comes first. */
export const STILL_MAX_SAMPLES = 256;
export const STILL_MAX_MS = 30000;
/** Headless checks (SwiftShader is slow): a few samples only. */
export const STILL_TEST_SAMPLES = 3;
/** Trace resolution: this share of the drawing buffer per side (upscaled when drawn). */
export const STILL_SCALE = 0.5;
/** Tiles per sample (a tile per frame keeps every frame short). */
export const STILL_TILES = 2;
/** Samples to the full fade-in (the noisy first ones blend with the raster frame). */
export const STILL_FADE_SAMPLES = 16;
/** Bounces of a path (transmissive: through glass). */
export const STILL_BOUNCES = 5;
export const STILL_TRANSMISSIVE_BOUNCES = 3;

/** What a session may spend. */
export interface StillBudget { samples: number; ms: number; fade: number }

// The budget: in test mode a few samples (fully faded in at the last), else STILL_MAX_SAMPLES / STILL_MAX_MS.
export function stillBudget(test: boolean): StillBudget {
  const samples = test ? STILL_TEST_SAMPLES : STILL_MAX_SAMPLES;
  return { samples, ms: STILL_MAX_MS, fade: Math.min(STILL_FADE_SAMPLES, samples) };
}

/** Why no trace runs now (null: one may). */
export type StillHold = 'tier' | 'model' | 'offscreen' | 'hidden' | 'edit' | 'clip' | 'idle' | null;

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
  if (!s.tier) return 'tier';
  if (!s.model) return 'model';
  if (!s.onScreen) return 'offscreen';
  if (!s.visible) return 'hidden';
  if (s.editing) return 'edit';
  if (s.clipped) return 'clip';
  if (!(s.idleFor >= (s.idleMs ?? STILL_IDLE_MS))) return 'idle';
  return null;
}

// Opacity of the traced image over the raster frame: 0 before the first sample, 1 at budget.fade samples.
export function stillFade(samples: number, budget: StillBudget): number {
  if (!(samples > 0)) return 0;
  return Math.min(1, samples / Math.max(1, budget.fade));
}

// The session has spent its budget.
export const stillDone = (samples: number, elapsedMs: number, budget: StillBudget): boolean =>
  samples >= budget.samples || elapsedMs >= budget.ms;

// Trace resolution for a drawing buffer (px): STILL_SCALE per side, at least 1 px.
export function stillSize(w: number, h: number, scale = STILL_SCALE): [number, number] {
  return [Math.max(1, Math.floor(w * scale)), Math.max(1, Math.floor(h * scale))];
}
