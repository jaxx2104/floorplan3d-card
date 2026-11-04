import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { normRenderOption, renderTone, matchExposure, toneGrey, QUALITY_TIERS, QUALITIES, RENDER_OPTION_DEFAULTS, RENDER_DEFAULTS, TONE_MAPPINGS } from '../src/render-recipe.ts';
import { envSky, envChanged, envIntensity, skyUniforms, EnvLight, ENV_ANGLE_DEG, ENV_THROTTLE_MS, ENV_DAY, ENV_NIGHT, ENV_DARK } from '../src/view/env-light.ts';

describe('normRenderOption', () => {
  it('defaults to the model recipe, standard quality, the recipe tone mapping', () => {
    expect(normRenderOption(undefined)).toEqual({ option: { recipe: 'model', quality: 'standard', toneMapping: null }, warnings: [] });
    expect(normRenderOption(null).option).toEqual(RENDER_OPTION_DEFAULTS);
  });
  it('keeps the string form (model | default)', () => {
    expect(normRenderOption('default').option.recipe).toBe('default');
    expect(normRenderOption('model').option.recipe).toBe('model');
    const bad = normRenderOption('fancy');
    expect(bad.option).toEqual(RENDER_OPTION_DEFAULTS);
    expect(bad.warnings[0]).toMatch(/render: "fancy"/);
  });
  it('reads the object form', () => {
    expect(normRenderOption({ recipe: 'default', quality: 'high', tone_mapping: 'Neutral' }).option).toEqual({ recipe: 'default', quality: 'high', toneMapping: 'Neutral' });
    expect(normRenderOption({ tone_mapping: 'aces' }).option.toneMapping).toBe('ACESFilmic');
    expect(normRenderOption({ tone_mapping: ' AgX ' }).option.toneMapping).toBe('AgX');
    expect(normRenderOption({ quality: 'high' }).option).toEqual({ recipe: 'model', quality: 'high', toneMapping: null });
  });
  it('warns on bad values and unknown keys, keeping the defaults', () => {
    const r = normRenderOption({ quality: 'ultra', tone_mapping: 'filmic', recipe: 3, bloom: true });
    expect(r.option).toEqual(RENDER_OPTION_DEFAULTS);
    expect(r.warnings).toHaveLength(4);
    expect(r.warnings.join('\n')).toMatch(/render.quality: "ultra" is not one of standard, high/);
    expect(r.warnings.join('\n')).toMatch(/render.tone_mapping: "filmic"/);
    expect(r.warnings.join('\n')).toMatch(/render.recipe/);
    expect(r.warnings.join('\n')).toMatch(/render.bloom: unknown option/);
    expect(normRenderOption(5).warnings[0]).toMatch(/needs model, default or an object/);
  });
  it('tiers: standard turns nothing on, high the sky environment with AgX', () => {
    expect(QUALITIES).toEqual(['standard', 'high']);
    expect(QUALITY_TIERS.standard).toEqual({ toneMapping: null, envLight: false, hemiScale: 1, physicalLights: false, bloom: false });
    expect(QUALITY_TIERS.high.physicalLights).toBe(true);
    expect(QUALITY_TIERS.high.bloom).toBe(true);
    expect(QUALITY_TIERS.high.toneMapping).toBe('AgX');
    expect(QUALITY_TIERS.high.envLight).toBe(true);
    expect(QUALITY_TIERS.high.hemiScale).toBeLessThan(1);
  });
});

describe('tone mapping and exposure', () => {
  it('standard keeps the recipe tone mapping and exposure exactly', () => {
    for (const toneMapping of TONE_MAPPINGS) {
      expect(renderTone({ toneMapping, exposure: 1.1 }, RENDER_OPTION_DEFAULTS)).toEqual({ toneMapping, exposure: 1.1 });
    }
    expect(renderTone(RENDER_DEFAULTS, RENDER_OPTION_DEFAULTS)).toEqual({ toneMapping: 'ACESFilmic', exposure: 1.25 });
  });
  it('high defaults to AgX; the card tone_mapping wins over the tier', () => {
    expect(renderTone(RENDER_DEFAULTS, { ...RENDER_OPTION_DEFAULTS, quality: 'high' }).toneMapping).toBe('AgX');
    expect(renderTone(RENDER_DEFAULTS, { ...RENDER_OPTION_DEFAULTS, quality: 'high', toneMapping: 'ACESFilmic' })).toEqual({ toneMapping: 'ACESFilmic', exposure: 1.25 });
    expect(renderTone(RENDER_DEFAULTS, { ...RENDER_OPTION_DEFAULTS, toneMapping: 'Neutral' }).toneMapping).toBe('Neutral');
  });
  it('curves rise from black towards white', () => {
    for (const t of TONE_MAPPINGS) {
      let prev = -1;
      for (const x of [0.001, 0.01, 0.05, 0.18, 0.5, 1, 4, 16]) {
        const y = toneGrey(t, x);
        expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(y).toBeLessThanOrEqual(1);
        prev = y;
      }
    }
    expect(toneGrey('ACESFilmic', 0)).toBeCloseTo(0, 3);
  });
  it('another tone mapping gets the exposure that keeps mid grey where the recipe had it', () => {
    for (const exposure of [0.8, 1.1, 1.25, 1.6]) {
      for (const to of ['AgX', 'Neutral', 'Reinhard', 'Cineon', 'Linear']) {
        const e = matchExposure('ACESFilmic', exposure, to);
        expect(toneGrey(to, 0.18 * e)).toBeCloseTo(toneGrey('ACESFilmic', 0.18 * exposure), 3);
      }
    }
    // the demo / default recipes: AgX needs a little more exposure than ACES for the same mid grey
    const agx = renderTone(RENDER_DEFAULTS, { ...RENDER_OPTION_DEFAULTS, quality: 'high' }).exposure;
    expect(agx).toBeGreaterThan(1.25);
    expect(agx).toBeLessThan(1.6);
  });
  it('clamps to the recipe exposure range', () => {
    expect(matchExposure('ACESFilmic', 4, 'Reinhard')).toBe(4);
    expect(matchExposure('AgX', 0.05, 'Linear')).toBeGreaterThanOrEqual(0.05);
  });
});

describe('sky environment: inputs and triggers', () => {
  const up = [0, 1, 0];
  it('by day the sun, at night the moon when it is up, else a dark sky', () => {
    expect(envSky(0, [0, 2, 0], null, 0)).toEqual({ body: 'sun', dir: [0, 1, 0], coverage: 0 });
    expect(envSky(0.49, up, { dir: [0, 1, 0] }, 30).body).toBe('sun');
    expect(envSky(0.5, up, { dir: [1, 1, 0] }, 30)).toMatchObject({ body: 'moon', coverage: 30 });
    expect(envSky(1, up, { dir: [1, -0.1, 0] }, 0).body).toBe('dark');
    expect(envSky(1, up, null, 0).body).toBe('dark');
    expect(envSky(0, up, null, 250).coverage).toBe(100);
  });
  it('rebuilds for a first build, a body change, clouds, or a move over ENV_ANGLE_DEG only', () => {
    const a = envSky(0, up, null, 0);
    expect(envChanged(null, a)).toBe(true);
    expect(envChanged(a, { ...a })).toBe(false);
    const r = (deg) => [Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180), 0];
    expect(envChanged(a, envSky(0, r(ENV_ANGLE_DEG * 0.8), null, 0))).toBe(false);
    expect(envChanged(a, envSky(0, r(ENV_ANGLE_DEG * 1.2), null, 0))).toBe(true);
    expect(envChanged(a, envSky(0, up, null, 5))).toBe(true);
    expect(envChanged(a, envSky(1, up, { dir: up }, 0))).toBe(true);
  });
  it('brightness: the day sky, the moon sky dimmer by phase and clouds, a moonless one dimmer still', () => {
    expect(envIntensity(0, 0)).toBeCloseTo(ENV_DAY);
    expect(envIntensity(0, 100)).toBeGreaterThan(ENV_DAY); // like the hemisphere fill under clouds
    const full = envIntensity(1, 0, 1, 'moon'), newMoon = envIntensity(1, 0, 0, 'moon'), cloudy = envIntensity(1, 100, 1, 'moon');
    expect(full).toBeCloseTo(ENV_DAY * ENV_NIGHT);
    expect(newMoon).toBeLessThan(full);
    expect(cloudy).toBeLessThan(full);
    expect(envIntensity(1, 0, 0, 'dark')).toBeCloseTo(ENV_DAY * ENV_DARK);
    expect(full).toBeLessThan(envIntensity(0, 0) / 4);
  });
  it('sky shader: hazier and greyer under clouds, a cool tint at night', () => {
    const clear = skyUniforms(envSky(0, up, null, 0)), overcast = skyUniforms(envSky(0, up, null, 100));
    expect(overcast.turbidity).toBeGreaterThan(clear.turbidity);
    expect(overcast.grey).toBeGreaterThan(clear.grey);
    expect(clear.tint).toEqual([1, 1, 1]);
    expect(skyUniforms(envSky(1, up, { dir: up }, 0)).tint[2]).toBeGreaterThan(skyUniforms(envSky(1, up, { dir: up }, 0)).tint[0]);
  });
});

describe('EnvLight throttle', () => {
  afterEach(() => vi.useRealTimers());
  // a stand-in for the GPU work: _build records the sky
  const make = () => {
    const due = vi.fn();
    const env = new EnvLight(/** renderer */ null, new THREE.Scene(), due);
    env._build = function (sky) { this.built = sky; this._at = performance.now(); this.builds++; };
    return { env, due };
  };
  const sun = (deg) => envSky(0, [Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180), 0], null, 0);
  it('builds the first sky at once, then nothing for an unchanged sky', () => {
    const { env, due } = make();
    env.request(sun(0));
    expect(due).toHaveBeenCalledTimes(1);
    expect(env.flush()).toBe(true);
    expect(env.builds).toBe(1);
    env.request(sun(0.5));
    expect(env.pending).toBeNull();
    expect(env.flush()).toBe(false);
    expect(env.builds).toBe(1);
  });
  it('a moved sun within the throttle waits for it, a day / night flip does not', () => {
    vi.useFakeTimers();
    const { env, due } = make();
    env.request(sun(0));
    env.flush();
    env.request(sun(10));
    expect(env.flush()).toBe(false); // throttled: the timer brings it back
    vi.advanceTimersByTime(ENV_THROTTLE_MS + 10);
    expect(due).toHaveBeenCalledTimes(2);
    expect(env.flush()).toBe(true);
    expect(env.builds).toBe(2);
    env.request(envSky(1, [0, 1, 0], { dir: [0, 1, 0] }, 0)); // night: at once
    expect(due).toHaveBeenCalledTimes(3);
    expect(env.flush()).toBe(true);
    expect(env.builds).toBe(3);
  });
  it('dispose clears the scene environment and the pending build', () => {
    const { env } = make();
    const tex = new THREE.Texture();
    env._target = { texture: tex, dispose: vi.fn() };
    env.scene.environment = tex;
    env.pending = sun(0);
    env.dispose();
    expect(env.scene.environment).toBeNull();
    expect(env.pending).toBeNull();
  });
});
