// Render look of the floorplan view: the render recipe, tone mapping, sun / sky light and the sun's
// shadow box, the house dome, city lights, plant sway, surround light, ambient occlusion and the frame
// finish (bokeh / grade), furniture colours and animated screens. The light objects (hemi, sun,
// moonLight) stay on the view.

import * as THREE from "three";
import { paintFurniture } from "../furniture.ts";
import { screenOn, frameAt, showFrame, setScreenOn } from "../screens.ts";
import { domeRadius } from "../sky.ts";
import {
  mergeRender,
  normRenderOption,
  renderTone,
  QUALITY_TIERS,
  skyLights,
  deviceShadowCap,
  lampShadowSlots,
  lampMapSize,
  backgroundColors,
  backgroundAt,
  normSurroundLight,
  surroundLight,
  normCityLights,
  cityLitFor,
  cityLightsOn,
} from "../render-recipe.ts";
import { cloudLight } from "../weather.ts";
import { AmbientOcclusion, normAo } from "../ao.ts";
import { ScreenFinish, normBokeh, normGrade } from "../finish.ts";
import { normSway, swayLean } from "../cloud-shadow.ts";
import { shadowInfo, sunDirection } from "../render-rules.ts";
import { EnvLight, envSky, envIntensity } from "./env-light.ts";
import { SelectiveBloom } from "../bloom.ts";
import { ContactShadows, type ContactFloor } from "../contact-shadow.ts";
import { setTierVariant } from "../cloud-shadow.ts";
import { pcssFrame } from "../soft-shadow.ts";
import { measuredElevations } from "../bindings.ts";
import {
  classifyMaterial,
  type MaterialFacts,
  type MaterialRule,
} from "../material-class.ts";
import { materialFacts, setSurface, surfaceOf } from "../physical-materials.ts";
import { frameInterval, isMesh, type Drawable } from "./core.ts";
import { IndirectLight } from "./indirect.ts";
import { levelQuality } from "./auto-quality.ts";
import type { FloorplanView } from "../view.ts";
import type { ModelManifest } from "./model.ts";
import type { AutoLevel } from "../auto-quality.ts";
import type {
  RenderSettings,
  RenderOption,
  Quality,
  QualityTier,
  DayNight,
  CityLights,
} from "../render-recipe.ts";
import type { SwaySettings } from "../cloud-shadow.ts";
import type { FinishSettings } from "../finish.ts";
import type { DepthPrepass } from "../depth-pass.ts";
import type { Screen } from "../screens.ts";
import type { HassEntity } from "../types/ha.ts";
import type { Vec3 } from "../types/layout.ts";

/** Sky state: night 0..1, unit vector toward the sun (world) or null, sun strength factor. */
export interface SkyState {
  night: number;
  sunDir?: Vec3 | null;
  sun?: number;
}

const TONE: Record<string, THREE.ToneMapping> = {
  None: THREE.NoToneMapping,
  Linear: THREE.LinearToneMapping,
  Reinhard: THREE.ReinhardToneMapping,
  Cineon: THREE.CineonToneMapping,
  ACESFilmic: THREE.ACESFilmicToneMapping,
  AgX: THREE.AgXToneMapping,
  Neutral: THREE.NeutralToneMapping,
};

// PCF tap spread of the sun's shadow (texels at clear sky): about the softness of r169's PCFSoftShadowMap
export const SUN_PCF_RADIUS = 1.5;
const SHADOW_MESH_M = 30; // untagged models: meshes up to this size make the sun's shadow box
const SHADOW_MARGIN_M = 4;
// Frame interval (ms) of the plants' sway.
const SWAY_FRAME_MS = 66;

export class RenderLook {
  view: FloorplanView;
  render: RenderSettings;
  renderOption: "model" | "default";
  /** card option render, normalised: recipe, quality tier, tone mapping */
  renderOpt: RenderOption;
  _renderWarned: string;
  _env: EnvLight | null;
  _bloom: SelectiveBloom | null;
  _contact: ContactShadows | null;
  _surfFacts: {
    model: unknown;
    facts: Map<THREE.Material, MaterialFacts>;
  } | null;
  /** per-room light probes and baked lightmaps (quality high) */
  indirect: IndirectLight;
  renderFrom: { keys: number } | null;
  background: DayNight;
  furniture: "color" | "white";
  daylight: boolean;
  sky: SkyState;
  _modelLook: boolean;
  _cityModel: FloorplanView["model"];
  _city: CityLights | null;
  _sway: SwaySettings | null;
  _swayClock: { at: number } | null;
  _surround: DayNight | null;
  _ao: AmbientOcclusion | null;
  _finishOpts: FinishSettings | null;
  _finish: ScreenFinish | null;
  _depthPass: DepthPrepass | null;
  _screens: Screen[] | null;
  _screenStates: Record<string, HassEntity> | null;
  _dome: { centre: THREE.Vector3; radius: number } | null;
  _houseBox: THREE.Box3 | null;
  _modelBottom: number | null;
  _shadowBox: { centre: THREE.Vector3; radius: number } | null;
  _sunStale: boolean;

  constructor(view: FloorplanView) {
    this.view = view;
    // render settings: the card's defaults, replaced by the model's fp.render recipe while one is loaded
    this.render = mergeRender(null);
    this.renderOption = "model"; // card option render: model | default (ignore the recipe)
    this.renderOpt = normRenderOption(null).option; // card option render: recipe, quality, tone_mapping
    this._renderWarned = ""; // the warnings last logged for the option
    this._env = null; // EnvLight while the tier lights the model from the sky (made on first use)
    this._bloom = null; // SelectiveBloom while the tier blooms emissive surfaces (made on first use)
    this._contact = null; // ContactShadows while the tier grounds things on the floors (made on first use)
    this._surfFacts = null; // { model, facts }: the loaded model's material facts (physical materials, gathered once)
    this.indirect = new IndirectLight(view); // light probes and lightmaps while the tier asks for them
    this.renderFrom = null; // { keys } while the loaded model's recipe is in use
    this.background = backgroundColors(null); // card option background: { day, night } hex
    this.furniture = "color"; // card option furniture: 'color' (as modelled) | 'white' (each material's extras fp_white)
    this.daylight = true;
    this.sky = { night: 0, sunDir: null, sun: 1 };
    this._modelLook = false; // the renderer has the model look (tone mapping, shadows)
    this._cityModel = null; // the model _cityWindows last ran for
    this._city = null; // card option city_lights (normalised) or null
    this._sway = null; // card option sway (normalised) or null
    this._swayClock = null; // { at }: last sway frame
    this._surround = null; // card option surround_light (normalised) or null
    this._ao = null; // AmbientOcclusion or null
    this._finishOpts = null; // { bokeh, grade } (normalised)
    this._finish = null; // ScreenFinish or null
    this._depthPass = null; // DepthPrepass for ao / finish, created on first use
    this._screens = null; // fp_anim screens of the model
    this._screenStates = null; // hass.states for the screens
    this._dome = null; // { centre: Vector3 (house centre on the ground), radius }
    this._houseBox = null; // the sun's shadow box before the margin (the sky keep-out without room polygons)
    this._modelBottom = null; // rain / snow fall down to here
    this._shadowBox = null; // { centre, radius } of the sun's shadow camera
    this._sunStale = false; // the sun's map was skipped while it was down (or the scrubber moved)
  }

  // Card option render: 'model' | 'default' (the recipe: the model's fp.render or none), or { recipe, quality,
  // tone_mapping } (normRenderOption). A recipe change applies at the next model load, with a model loaded
  // now too (the lamp pool size follows at the next load); quality / tone mapping apply now.
  setRenderOption(opt: unknown): void {
    const { option, warnings } = normRenderOption(opt);
    const w = warnings.join("; ");
    if (w && w !== this._renderWarned)
      console.warn(`floorplan3d: card YAML ${w}`);
    this._renderWarned = w;
    const prev = this.renderOpt;
    this.renderOpt = option;
    this.renderOption = option.recipe;
    const recipe = option.recipe !== prev.recipe,
      look =
        option.quality !== prev.quality ||
        option.toneMapping !== prev.toneMapping ||
        JSON.stringify(option.materials || []) !==
          JSON.stringify(prev.materials || []);
    this.view.auto.sync(option.quality === "auto");
    this._syncPixelRatio(); // the 'auto' level reduced caps it
    if (!this.view.model || (!recipe && !look)) return;
    if (recipe) {
      this._useRecipe(this.view.model.manifest);
      if (this.view.objectLayer) this.view.objectLayer._shadowLook();
    }
    this._applyLook();
  }

  // The quality tier in use: the card's, or under 'auto' the one of its current level (high until it has one).
  quality(): Quality {
    const q = this.renderOpt.quality;
    if (q !== "auto") return q;
    const level = this.view.auto.level;
    return level ? levelQuality(level) : "high";
  }

  // What the quality tier in use turns on (QUALITY_TIERS).
  tier(): Readonly<QualityTier> {
    return QUALITY_TIERS[this.quality()];
  }

  // Pixel ratio: 1 in test mode, else the device's up to the recipe's pixelRatioMax (1 at the 'auto' level reduced).
  _pixelRatio(): number {
    const cap =
      this.renderOpt.quality === "auto" && this.view.auto.level === "reduced"
        ? 1
        : Infinity;
    return this.view.test
      ? 1
      : Math.min(window.devicePixelRatio || 1, this.render.pixelRatioMax, cap);
  }

  // The renderer at _pixelRatio() (the canvas resized with it).
  _syncPixelRatio(): void {
    const pr = this._pixelRatio();
    if (this.view.renderer.getPixelRatio() === pr) return;
    this.view.renderer.setPixelRatio(pr);
    if (this.view.size)
      this.view.cam.resize(this.view.size.w, this.view.size.h);
    if (this.view.onPixelRatio) this.view.onPixelRatio(pr);
    this.view.dirty = true;
  }

  // Render quality 'auto' switched levels (view/auto-quality.ts, the view idle): the tier's look when the tier
  // changed, the pixel ratio when it did.
  _applyAutoLevel(from: AutoLevel, to: AutoLevel): void {
    if (levelQuality(from) !== levelQuality(to) && this.view.model)
      this._applyLook();
    this._syncPixelRatio();
    this.view.dirty = true;
  }

  // Lamp shadow maps this device affords: { max, mapSize } (see deviceShadowCap).
  shadowCap(): { max: number; mapSize: number } {
    const touch =
      typeof matchMedia === "function" &&
      matchMedia("(pointer: coarse)").matches;
    return deviceShadowCap({
      touch,
      dpr: window.devicePixelRatio || 1,
      cores: navigator.hardwareConcurrency,
    });
  }

  // Shadow-capable lamp slots for the loaded settings: min(recipe max, device max, texture units - 9).
  lampShadowCount(): number {
    return lampShadowSlots(
      this.render.lampShadows.max,
      this.shadowCap(),
      this.view.renderer.capabilities.maxTextures,
    );
  }

  // The loaded model's recipe (unless render: default) -> this.render; renderer pixel ratio and camera fov / near.
  _useRecipe(manifest: ModelManifest): void {
    const recipe = this.renderOption === "default" ? null : manifest.render;
    this.renderFrom = recipe
      ? { keys: manifest.renderKeys || Object.keys(recipe).length }
      : null;
    this._setRender(mergeRender(recipe));
  }

  _setRender(render: RenderSettings): void {
    render.lampShadows.mapSize = lampMapSize(
      render.lampShadows.mapSize,
      this.shadowCap(),
    ); // at most 1024 and the device cap
    this.render = render;
    this._syncPixelRatio();
    const cam = this.view.persp;
    if (cam.fov !== render.camera.fov) {
      cam.fov = render.camera.fov;
      cam.updateProjectionMatrix();
    }
  }

  setDaylight(day: unknown): void {
    this.daylight = !!day;
    this.sky = { night: day ? 0 : 1, sunDir: null };
    if (this.view.model || !this.view.modelLayer._modelId) this._applyLook(); // a model on its way applies its look
  }

  // night 0..1 and the unit vector toward the sun (world) or null (fixed bearing from fp.north).
  // With a model only the light values change; shadows are re-rendered when the sun moved > 1 degree
  // or night entered / left 1 (sun.castShadow stays true, so no shader recompile).
  // shadow: false (time scrubber dragging): lights move now, the sun's shadow map is redrawn at the next
  // setSky with shadow true (the scrubber settled).
  setSky(
    { night = 0, sunDir = null, sun = 1 }: Partial<SkyState> = {},
    { shadow = true }: { shadow?: boolean } = {},
  ): void {
    const old = this.sky;
    this.sky = { night, sunDir, sun };
    this.daylight = night < 0.5;
    if (!this.view.model) {
      if (!this.view.modelLayer._modelId) this._applyLook();
      return;
    } // a model on its way applies its look
    this._applyLights();
    const a = old.sunDir,
      b = sunDir;
    let moved = !!a !== !!b;
    if (a && b)
      moved =
        Math.acos(
          Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])),
        ) >
        Math.PI / 180;
    if (moved) this._fitShadow({ redraw: shadow });
    else if (this._sunStale && shadow) this._sunShadow(); // the sun came up: its map was skipped while it was down
    this.view.dirty = true;
  }

  _applyLights(): void {
    const t = Math.max(0, Math.min(1, this.sky.night)),
      hemi = this.view.hemi,
      sun = this.view.sun;
    const k = skyLights(this.render, t); // the recipe's day / night colours and intensities
    hemi.color.setHex(k.hemiSky);
    hemi.groundColor.setHex(k.hemiGround);
    const L = cloudLight(this.view.skyLayer.weather.applied || 0, t);
    hemi.intensity = k.hemiIntensity * L.hemi * this.tier().hemiScale;
    sun.color.setHex(k.sunColor);
    // cloud shadows on: the sun keeps its clear-sky strength (the patches and the rooms' shade dim it)
    sun.intensity =
      k.sunIntensity *
      (this.sky.sun ?? 1) *
      (this.view.skyLayer._cloudShadowsOn() ? 1 : L.sun);
    // softer, fainter sun shadow under clouds: uniforms only (the PCF taps spread by the radius, PCSS widens by it)
    sun.shadow.radius =
      (this.tier().softShadows ? 1 : SUN_PCF_RADIUS) * L.shadowRadius;
    sun.shadow.intensity = L.shadowIntensity;
    this.view.skyLayer._applyMoonLight();
    this.view.skyLayer._cloudLook();
    // the city around the house: its sky / ground light outside the rooms, dimmed by clouds like the sky light
    const out = surroundLight(this._surround, t),
      U = this.view.skyLayer._cloudU;
    U.fpOutSky.value.setHex(out.sky).multiplyScalar(out.intensity * L.hemi);
    U.fpOutGround.value
      .setHex(out.ground)
      .multiplyScalar(out.intensity * L.hemi);
    const city = this._city;
    U.fpCity.value = city ? cityLightsOn(t) : 0;
    if (city)
      U.fpCityParams.value.set(
        city.share,
        city.strength,
        city.street,
        city.glass,
      );
    this.view.renderer.setClearColor(backgroundAt(this.background, t), 1);
    if (this._env) this._skyEnv();
    this.indirect.skyChanged(); // baked light follows the sky's brightness
  }

  // The tier's environment light from the sky: on with a model when the tier asks for it (made then), else
  // off (freed). Changes of the sky ask for a rebuild (throttled, see env-light.ts); the brightness follows now.
  _syncEnv(): void {
    const on = !!this.view.model && this.tier().envLight;
    if (!on) {
      if (this._env) {
        this._env.dispose();
        this._env = null;
        this.view.dirty = true;
      }
      return;
    }
    if (!this._env)
      this._env = new EnvLight(this.view.renderer, this.view.scene, () => {
        this.view.dirty = true;
      });
    this._skyEnv();
  }

  // The tier's selective bloom, physical lamp light, soft sun shadows, contact shadows and physical materials: on
  // with a model when the tier asks for them. A change of the lamp model re-evaluates the lamps (the card's object
  // update); the shadow variants and material upgrades recompile the model materials that changed (the callers flag
  // every material anyway).
  _syncTierLook(): void {
    const t = this.tier(),
      model = this.view.model;
    if (model && t.bloom && !this._bloom)
      this._bloom = new SelectiveBloom(this.view.renderer);
    if (!(model && t.bloom) && this._bloom) {
      this._bloom.dispose();
      this._bloom = null;
    }
    if (model && t.contactShadows && !this._contact)
      this._contact = new ContactShadows(
        this.view.renderer,
        this.view.skyLayer._cloudU,
      );
    if (!(model && t.contactShadows) && this._contact) {
      this._contact.dispose();
      this._contact = null;
    }
    if (model) {
      const variant = {
        pcss: t.softShadows,
        contact: t.contactShadows,
        probe: t.lightProbes || t.bakedLightmaps,
      };
      model.root.traverse((o) => {
        if (!isMesh(o)) return;
        for (const m of ([] as (THREE.Material | undefined)[]).concat(
          o.material,
        ))
          if (m) setTierVariant(m, variant);
      });
      this._syncSurfaces(t.physicalMaterials);
    }
    this.indirect.sync(); // after the upgrades: a probe applies to the physical materials too
    this.view.still.sync(); // the path tracer (quality still) freed in the other tiers and without a model
    const layer = this.view.objectLayer;
    if (layer && layer.setPhysical(t.physicalLights))
      this.view._objectsInvalid();
  }

  // Physical materials (quality high): glass, floors and fabric upgraded in place (physical-materials.ts), or all
  // restored. The facts are gathered at the model's first look, before its static meshes are merged; the classes
  // follow the rules: the model's fp.render.materials (unless render: default), then the card's render.materials.
  // Runs on model load and look changes (tier, rules), never per frame. -> materials changed.
  _syncSurfaces(on: boolean): number {
    const model = this.view.model!; // callers checked view.model
    if (!this._surfFacts || this._surfFacts.model !== model)
      this._surfFacts = {
        model,
        facts: materialFacts(model.root, model.manifest),
      };
    const facts = this._surfFacts.facts;
    const rules: MaterialRule[] = [
      ...((this.renderOption !== "default" &&
        model.manifest.render &&
        model.manifest.render.materials) ||
        []),
      ...(this.renderOpt.materials || []),
    ];
    let n = 0;
    const seen = new Set<THREE.Material>();
    model.root.traverse((o) => {
      if (!isMesh(o)) return;
      for (const m of ([] as (THREE.Material | undefined)[]).concat(
        o.material,
      )) {
        if (!m || seen.has(m)) continue;
        seen.add(m);
        const f = facts.get(m);
        // a material made later (a clone of an upgraded one) keeps its class in high and is restored otherwise
        const want = !on ? null : f ? classifyMaterial(f, rules) : surfaceOf(m);
        if (setSurface(m, want)) n++;
      }
    });
    this.view.stats.materialSwaps += n;
    return n;
  }

  _skyEnv(): void {
    const env = this._env!,
      model = this.view.model;
    if (!model) return;
    const t = Math.max(0, Math.min(1, this.sky.night)),
      moon = this.view.skyLayer.skyBodies.moon,
      cover = this.view.skyLayer.weather.applied || 0;
    const sunDir =
      this.sky.sunDir ||
      sunDirection(model.north, this.view.modelGroup.rotation.y); // as the sun light (_fitShadow)
    const sky = envSky(t, sunDir, moon, cover);
    env.request(sky);
    this.view.scene.environmentIntensity = envIntensity(
      t,
      cover,
      moon ? moon.illumination : 0,
      sky.body,
    );
  }

  // Card option city_lights (true or { windows, glow, share, strength, street, glass }): lit windows, lit
  // glass and street light at night, see cloud-shadow.js.
  setCityLights(opt: unknown): void {
    const next = normCityLights(opt);
    if (JSON.stringify(next) === JSON.stringify(this._city || null)) return;
    this._city = next;
    if (!this.view.model) return;
    this._cityWindows();
    this._applyLights();
    this.view.dirty = true;
  }

  // Which model materials draw lit windows or lit glass, and which sway (shader defines: recompiled only when
  // they change), and the site's ground height for the street light and the sway. A material shared by a
  // plant and something else sways as a whole outside the rooms.
  _cityWindows(): void {
    // per material: lit by the first mesh that asks for it, sways when any of its meshes does
    const want = new Map<
      THREE.Material,
      { lit: "glow" | "windows" | null; sway: boolean }
    >();
    const root = this.view.model!.root; // callers checked view.model
    root.traverse((o) => {
      if (!isMesh(o)) return;
      const info = shadowInfo(o);
      const lit = cityLitFor(info.names, info.layers, this._city);
      const sway =
        !!this._sway &&
        this._sway.plants.some(
          (p) => info.names.includes(p) || info.layers.includes(p),
        );
      for (const m of ([] as (THREE.Material | undefined)[]).concat(
        o.material,
      )) {
        if (!m || !m.userData.fpCloud) continue;
        const w = want.get(m) || { lit: null, sway: false };
        want.set(m, { lit: w.lit || lit, sway: w.sway || sway });
      }
    });
    for (const [m, { lit, sway }] of want) {
      if (
        (m.userData.fpCityLit || null) === lit &&
        !!m.userData.fpSway === sway
      )
        continue;
      m.userData.fpCityLit = lit;
      m.userData.fpSway = sway;
      m.needsUpdate = true;
    }
    const box = new THREE.Box3().setFromObject(root);
    this.view.skyLayer._cloudU.fpCityGround.value = box.isEmpty()
      ? 0
      : box.min.y;
  }

  // Card option sway (true or { plants, strength }): the plants outside sway in the wind (weather wind_speed),
  // redrawn at up to 1000 / SWAY_FRAME_MS frames a second while the card is on screen.
  // Card option max_fps: frames a second of the animations (null: their own defaults, 15-30).
  setMaxFps(fps: unknown): void {
    this.view._maxFps = Number(fps) > 0 ? Number(fps) : null;
  }

  setSway(opt: unknown): void {
    const next = normSway(opt);
    if (JSON.stringify(next) === JSON.stringify(this._sway || null)) return;
    this._sway = next;
    this.view.skyLayer._cloudU.fpSway.value = next
      ? swayLean(this.view.skyLayer.weather.wind, next.strength)
      : 0;
    if (!this.view.model) return;
    this._cityWindows();
    this.view.dirty = true;
  }

  _stepSway(): void {
    const S = this._swayClock || (this._swayClock = { at: 0 });
    if (
      !this._sway ||
      !this.view.model ||
      !this.view.onScreen ||
      this.view.test ||
      (typeof document !== "undefined" && document.visibilityState === "hidden")
    ) {
      S.at = 0;
      return;
    }
    const now = performance.now();
    if (S.at && now - S.at < frameInterval(SWAY_FRAME_MS, this.view._maxFps))
      return;
    S.at = now;
    this.view.skyLayer._cloudU.fpTime.value = (now / 1000) % 3600;
    this.view.dirty = true;
  }

  // Card option surround_light (true or { day, night }): ambient light around the house, not in the rooms.
  setSurroundLight(opt: unknown): void {
    const next = normSurroundLight(opt);
    if (JSON.stringify(next) === JSON.stringify(this._surround || null)) return;
    this._surround = next;
    if (!this.view.model) return;
    this._applyLights();
    this.view.dirty = true;
  }

  // The ao pass of a frame: the card option's, in the tiers without the room probes and contact shadows only.
  // Those already shade the corners, wall feet and the floor under furniture, and on top of them the pass (which
  // multiplies the finished frame, the lamps' and the sun's direct light included) darkened a quarter of the demo's
  // interior views to 0.65 of their light, the probes' corners a second time.
  aoPass(): AmbientOcclusion | null {
    const t = this.tier();
    return this._ao && !(t.lightProbes || t.contactShadows) ? this._ao : null;
  }

  // Card option ao (true or { intensity, radius, resolution }): ambient occlusion over the model, see ao.js.
  setAo(opt: unknown): void {
    const next = normAo(opt);
    if (
      JSON.stringify(next) ===
      JSON.stringify(this._ao ? this._ao.settings : null)
    )
      return;
    if (this._ao) this._ao.dispose();
    this._ao = null;
    if (next) {
      this._ao = new AmbientOcclusion(this.view.renderer, next);
      this.view.scene.add(this._ao.object);
    }
    this.view.dirty = true;
  }

  // Card options bokeh (true or { strength, start, range, tilt }) and grade (true or { saturation, contrast,
  // vignette }): the finish over the frame, see finish.js.
  setBokeh(opt: unknown): void {
    this._setFinish({ ...this._finishOpts, bokeh: normBokeh(opt) });
  }

  setGrade(opt: unknown): void {
    this._setFinish({ ...this._finishOpts, grade: normGrade(opt) });
  }

  _setFinish(opts: Partial<FinishSettings>): void {
    const prev = this._finishOpts || { bokeh: null, grade: null };
    const next: FinishSettings = {
      bokeh: opts.bokeh || null,
      grade: opts.grade || null,
    };
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    this._finishOpts = next;
    if (this._finish) this._finish.dispose();
    this._finish =
      next.bokeh || next.grade
        ? new ScreenFinish(this.view.renderer, next)
        : null;
    this.view.dirty = true;
  }

  // The box the lens focuses on: the rooms on the visible floors, floor to ceiling (else the house box).
  _focusBox(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const solid of this.view.skyLayer._roomSolids())
      box.setFromPoints(
        solid.concat(box.isEmpty() ? [] : [box.min.clone(), box.max.clone()]),
      );
    return box;
  }

  // Card option background ('#rrggbb' or { day, night }). Re-applied now with a model loaded.
  setBackground(opt: unknown): void {
    const next = backgroundColors(opt);
    if (
      next.day === this.background.day &&
      next.night === this.background.night
    )
      return;
    this.background = next;
    if (!this.view.model) return;
    this._applyLights();
    this.view.dirty = true;
  }

  // Card option furniture: 'white' shows every material that carries extras fp_white ([r, g, b] linear, the
  // model's white look) in that colour instead of its own; anything else ('color', unset) the modelled colour.
  setFurniture(opt: unknown): void {
    const next = opt === "white" ? "white" : "color";
    if (next === this.furniture) return;
    this.furniture = next;
    if (this._applyFurniture()) this.view.dirty = true;
  }

  // hass.states for the animated screens (fp_anim): each plays while its entity is on.
  setScreenStates(states: Record<string, HassEntity> | null | undefined): void {
    this._screenStates = states || null;
    if (this._applyScreens()) this.view.dirty = true;
  }

  _applyScreens(): boolean {
    let changed = false;
    for (const s of this._screens || [])
      if (setScreenOn(s, screenOn(s.anim, this._screenStates))) changed = true;
    return changed;
  }

  // Advance the playing screens to the frame for now; only a changed frame asks for a render.
  _stepScreens(): void {
    if (!this._screens || !this._screens.length || !this.view.onScreen) return;
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    )
      return;
    const t = performance.now() / 1000;
    for (const s of this._screens)
      if (s.on && showFrame(s, frameAt(s.anim, t))) this.view.dirty = true;
  }

  _applyFurniture(): boolean {
    return (
      !!this.view.model &&
      paintFurniture(this.view.model.root, this.furniture === "white") > 0
    );
  }

  // Renderer, light and shadow settings for model / no model and day / night.
  _applyLook(): void {
    const r = this.view.renderer,
      day = this.view.model ? this.daylight : true,
      sun = this.view.sun,
      hemi = this.view.hemi;
    this._modelLook = !!this.view.model;
    if (this.view.model) {
      if (this._cityModel !== this.view.model) {
        this._cityModel = this.view.model;
        this._cityWindows();
      } // once per model
      const rd = this.render;
      const tone = renderTone(rd, this.renderOpt, this.quality()); // the recipe's unless the card or its quality tier sets one
      r.toneMapping = TONE[tone.toneMapping] ?? THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = tone.exposure;
      r.outputColorSpace =
        rd.outputColorSpace === "srgb-linear"
          ? THREE.LinearSRGBColorSpace
          : THREE.SRGBColorSpace;
      r.shadowMap.enabled = true;
      r.shadowMap.autoUpdate = false; // re-rendered on demand (needsUpdate), not every frame
      this._shadowType(
        this.tier().softShadows ? THREE.BasicShadowMap : THREE.PCFShadowMap,
      );
      this._shadowDirty();
      this._syncEnv(); // before the lights: they set its brightness
      this._syncTierLook();
      this._applyLights();
      sun.castShadow = true; // stays on (toggling recompiles shaders); night = intensity 0
      sun.shadow.autoUpdate = false; // redrawn only when flagged, and only while the sun is up
      const sm = this.view.test
        ? Math.min(512, rd.sun.shadowMapSize)
        : rd.sun.shadowMapSize;
      if (sun.shadow.mapSize.x !== sm) {
        sun.shadow.mapSize.set(sm, sm);
        if (sun.shadow.map) {
          sun.shadow.map.dispose();
          sun.shadow.map = null;
        } // re-created at the new size
      }
      sun.shadow.bias = rd.sun.bias;
      sun.shadow.normalBias = rd.sun.normalBias; // against acne on roofs
      this._fitShadow();
    } else {
      r.toneMapping = THREE.NoToneMapping;
      r.toneMappingExposure = 1;
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.shadowMap.enabled = false;
      r.setClearColor(0x000000, 0);
      hemi.color.setHex(0xffffff);
      hemi.groundColor.setHex(0x8a8a8a);
      hemi.intensity = day ? 2.2 : 0.6;
      sun.color.setHex(0xffffff);
      sun.intensity = day ? 1.4 : 0;
      sun.castShadow = false;
      this.view.moonLight.intensity = 0;
      this._syncEnv(); // no model: no environment
      this._syncTierLook();
      sun.position.set(-12, 30, 18);
      sun.target.position.set(0, 0, 0);
    }
    // toneMapping / shadowMap changes need the shaders rebuilt
    this.view.scene.traverse((obj) => {
      const o = obj as Drawable;
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material])
        m.needsUpdate = true;
    });
    this.view.dirty = true;
  }

  // Fit the sun's shadow camera to the house: storey / basement / roof levels (untagged: meshes up
  // to 30 m across) + 4 m, not the whole plot, so the 2048² map stays sharp. Sun azimuth from fp.north.
  _fitShadow({ redraw = true }: { redraw?: boolean } = {}): void {
    const model = this.view.model;
    if (!model) return;
    const sun = this.view.sun;
    this.view.modelGroup.updateMatrixWorld(true);
    let box = new THREE.Box3();
    for (const l of model.manifest.levels) {
      if (l.role === "storey" || l.role === "basement" || l.role === "roof")
        box.union(new THREE.Box3().setFromObject(l.node));
    }
    if (box.isEmpty()) {
      model.root.traverse((o) => {
        if (!isMesh(o)) return;
        const b = new THREE.Box3().setFromObject(o);
        if (Math.max(b.max.x - b.min.x, b.max.z - b.min.z) <= SHADOW_MESH_M)
          box.union(b);
      });
    }
    if (box.isEmpty())
      box = new THREE.Box3().setFromObject(this.view.modelGroup);
    if (box.isEmpty()) return;
    const ground = Math.min(Math.max(0, box.min.y), box.max.y);
    const hc = box.getCenter(new THREE.Vector3());
    this._dome = {
      centre: new THREE.Vector3(hc.x, ground, hc.z),
      radius: domeRadius(
        Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2,
      ),
    };
    this.view.skyLayer._placeSkyBodies();
    this._houseBox = box.clone(); // the sky keep-out without room polygons
    const all = new THREE.Box3().setFromObject(this.view.modelGroup); // rain / snow fall down to the model's bottom (not a far-off ground plane)
    this._modelBottom = all.isEmpty()
      ? box.min.y
      : Math.max(all.min.y, box.min.y - 40);
    box.expandByScalar(SHADOW_MARGIN_M);
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
    this._shadowBox = { centre: centre.clone(), radius };
    this.view.skyLayer._applyMoonLight();
    const dir = new THREE.Vector3(
      ...(this.sky.sunDir ||
        sunDirection(model.north, this.view.modelGroup.rotation.y)),
    );
    sun.target.position.copy(centre);
    sun.position.copy(centre).addScaledVector(dir, radius * 2.5);
    const cam = sun.shadow.camera;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    cam.near = 0.5;
    cam.far = radius * 5;
    cam.updateProjectionMatrix();
    this.view.skyLayer._cloudU.fpPcss.value.set(...pcssFrame(cam)); // soft shadows (quality high): metres per depth / uv
    sun.target.updateMatrixWorld();
    if (redraw) this._sunShadow();
    else this._sunStale = true; // redrawn once the time scrubber settles
    this.view.stats.shadow++;
    this.view.dirty = true;
  }

  // The shadow casters changed (model, visibility, cut, section): the sun's map (while it is up) and
  // every lit pool shadow map. Dark lights are redrawn when they light up.
  _shadowDirty(): void {
    if (this._contact) this._contact.stale = true; // rebuilt before the next frame (view loop)
    this._sunShadow();
    if (this.view.objectLayer)
      this.view._flagShadows(this.view.objectLayer.shadowsStale());
    this.view.stats.shadow++;
  }

  // The renderer's shadow map type: PCF (hardware compare, soft by shadow.radius), or Basic for the soft-shadow
  // tier (raw depths for its PCSS blocker search, soft-shadow.ts). The maps of the other type are dropped, also of
  // lights that are not drawn now (the sun by night, unlit lamps): a map of the old type under the new samplers
  // fails every draw. They are re-created when they are next drawn (_shadowDirty flags what is lit).
  _shadowType(type: THREE.ShadowMapType): void {
    const r = this.view.renderer;
    if (r.shadowMap.type === type) return;
    r.shadowMap.type = type;
    this.view.scene.traverse((o) => {
      const shadow = (o as Partial<THREE.DirectionalLight | THREE.PointLight>)
        .shadow;
      if (!shadow || !shadow.map) return;
      if (shadow.map.depthTexture) shadow.map.depthTexture.dispose();
      shadow.map.dispose();
      shadow.map = null;
    });
  }

  // Sun map: redraw now when the sun is up, else once it rises (setSky).
  _sunShadow(): void {
    if (this.view.sun.intensity > 0) {
      this._sunStale = false;
      this.view._flagShadows([this.view.sun]);
    } else {
      this._sunStale = true;
    }
  }

  // lights: the pool lights whose shadow maps must be redrawn (lit, moved or reassigned).
  requestShadowUpdate(lights: THREE.Light[] | null | undefined): void {
    this.view._flagShadows(lights);
    this.view.stats.shadow++;
    this.view.dirty = true;
  }

  // The storeys to ground (contact shadows): each storey / basement level's floor height (its elevation, else
  // measured from its geometry, model space -> world) and footprint (world x / z).
  _contactFloors(): ContactFloor[] {
    const model = this.view.model;
    if (!model) return [];
    this.view.modelGroup.updateMatrixWorld(true);
    const levels = model.manifest.levels,
      meas = measuredElevations(levels),
      out: ContactFloor[] = [];
    for (const l of levels) {
      if (l.role !== "storey" && l.role !== "basement") continue;
      const e =
        l.elevation !== null &&
        l.elevation !== undefined &&
        Number.isFinite(l.elevation)
          ? l.elevation
          : meas[l.id]?.elevation;
      if (e === undefined || !Number.isFinite(e)) continue;
      const box = new THREE.Box3().setFromObject(l.node);
      if (box.isEmpty()) continue;
      const y = model.root.localToWorld(new THREE.Vector3(0, e, 0)).y;
      out.push({
        y,
        minX: box.min.x,
        maxX: box.max.x,
        minZ: box.min.z,
        maxZ: box.max.z,
      });
    }
    return out;
  }

  // Contact shadows due (the casters changed): rebuild them now, before the frame. -> true when rebuilt.
  _updateContact(): boolean {
    const c = this._contact;
    if (!c || !c.stale || !this.view.model) return false;
    c.update(this.view.scene, this._contactFloors());
    return true;
  }

  // Ambient occlusion, the finish and the depth pass (view.dispose).
  dispose(): void {
    if (this._env) this._env.dispose();
    this._env = null;
    if (this._bloom) this._bloom.dispose();
    this._bloom = null;
    if (this._contact) this._contact.dispose();
    this._contact = null;
    this.indirect.dispose();
    this.setAo(null);
    this._setFinish({ bokeh: null, grade: null });
    if (this._depthPass) this._depthPass.dispose();
    this._depthPass = null;
  }
}
