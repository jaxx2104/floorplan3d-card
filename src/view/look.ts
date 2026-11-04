// Render look of the floorplan view: the render recipe, tone mapping, sun / sky light and the sun's
// shadow box, the house dome, city lights, plant sway, surround light, ambient occlusion and the frame
// finish (bokeh / grade), furniture colours and animated screens. The light objects (hemi, sun,
// moonLight) stay on the view.

import * as THREE from 'three';
import { paintFurniture } from '../furniture.js';
import { screenOn, frameAt, showFrame, setScreenOn } from '../screens.js';
import { domeRadius } from '../sky.js';
import { mergeRender, skyLights, deviceShadowCap, lampShadowSlots, lampMapSize, backgroundColors, backgroundAt, normSurroundLight, surroundLight, normCityLights, cityLitFor, cityLightsOn } from '../render-recipe.js';
import { cloudLight } from '../weather.js';
import { AmbientOcclusion, normAo } from '../ao.js';
import { ScreenFinish, normBokeh, normGrade } from '../finish.js';
import { normSway, swayLean } from '../cloud-shadow.js';
import { shadowInfo, sunDirection } from '../render-rules.js';
import { frameInterval, isMesh, type Drawable } from './core.js';
import type { FloorplanView } from '../view.js';
import type { Manifest } from './model.js';
import type { RenderSettings, DayNight, CityLights } from '../render-recipe.js';
import type { SwaySettings } from '../cloud-shadow.js';
import type { FinishSettings } from '../finish.js';
import type { DepthPrepass } from '../depth-pass.js';
import type { Screen } from '../screens.js';
import type { HassEntity } from '../types/ha.js';
import type { Vec3 } from './core.js';

/** Sky state: night 0..1, unit vector toward the sun (world) or null, sun strength factor. */
export interface SkyState { night: number; sunDir?: Vec3 | null; sun?: number }

const TONE: Record<string, THREE.ToneMapping> = {
  None: THREE.NoToneMapping, Linear: THREE.LinearToneMapping, Reinhard: THREE.ReinhardToneMapping, Cineon: THREE.CineonToneMapping,
  ACESFilmic: THREE.ACESFilmicToneMapping, AgX: THREE.AgXToneMapping, Neutral: THREE.NeutralToneMapping,
};

const SHADOW_MESH_M = 30; // untagged models: meshes up to this size make the sun's shadow box
const SHADOW_MARGIN_M = 4;
// Frame interval (ms) of the plants' sway.
const SWAY_FRAME_MS = 66;

export class RenderLook {
  view: FloorplanView;
  render: RenderSettings;
  renderOption: 'model' | 'default';
  renderFrom: { keys: number } | null;
  background: DayNight;
  furniture: 'color' | 'white';
  daylight: boolean;
  sky: SkyState;
  _modelLook: boolean;
  _cityModel: FloorplanView['model'];
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
    this.renderOption = 'model'; // card option render: model | default (ignore the recipe)
    this.renderFrom = null; // { keys } while the loaded model's recipe is in use
    this.background = backgroundColors(null); // card option background: { day, night } hex
    this.furniture = 'color'; // card option furniture: 'color' (as modelled) | 'white' (each material's extras fp_white)
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

  // Card option render: 'model' (the model's fp.render recipe) or 'default' (ignore it). Applied at the next model load.
  // A change with a model loaded re-applies the look now (the lamp pool size follows at the next load).
  setRenderOption(opt: unknown): void {
    const next = opt === 'default' ? 'default' : 'model';
    if (next === this.renderOption) return;
    this.renderOption = next;
    if (!this.view.model) return;
    this._useRecipe(this.view.model.manifest);
    if (this.view.objectLayer) this.view.objectLayer._shadowLook();
    this._applyLook();
  }

  // Pixel ratio: 1 in test mode, else the device's up to the recipe's pixelRatioMax.
  _pixelRatio(): number {
    return this.view.test ? 1 : Math.min(window.devicePixelRatio || 1, this.render.pixelRatioMax);
  }

  // Lamp shadow maps this device affords: { max, mapSize } (see deviceShadowCap).
  shadowCap(): { max: number; mapSize: number } {
    const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    return deviceShadowCap({ touch, dpr: window.devicePixelRatio || 1, cores: navigator.hardwareConcurrency });
  }

  // Shadow-capable lamp slots for the loaded settings: min(recipe max, device max, texture units - 9).
  lampShadowCount(): number {
    return lampShadowSlots(this.render.lampShadows.max, this.shadowCap(), this.view.renderer.capabilities.maxTextures);
  }

  // The loaded model's recipe (unless render: default) -> this.render; renderer pixel ratio and camera fov / near.
  _useRecipe(manifest: Manifest): void {
    const recipe = this.renderOption === 'default' ? null : manifest.render;
    this.renderFrom = recipe ? { keys: manifest.renderKeys || Object.keys(recipe).length } : null;
    this._setRender(mergeRender(recipe));
  }

  _setRender(render: RenderSettings): void {
    render.lampShadows.mapSize = lampMapSize(render.lampShadows.mapSize, this.shadowCap()); // at most 1024 and the device cap
    this.render = render;
    const pr = this._pixelRatio();
    if (this.view.renderer.getPixelRatio() !== pr) {
      this.view.renderer.setPixelRatio(pr);
      if (this.view.size) this.view.cam.resize(this.view.size.w, this.view.size.h);
      if (this.view.onPixelRatio) this.view.onPixelRatio(pr);
    }
    const cam = this.view.persp;
    if (cam.fov !== render.camera.fov) { cam.fov = render.camera.fov; cam.updateProjectionMatrix(); }
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
  setSky({ night = 0, sunDir = null, sun = 1 }: Partial<SkyState> = {}, { shadow = true }: { shadow?: boolean } = {}): void {
    const old = this.sky;
    this.sky = { night, sunDir, sun };
    this.daylight = night < 0.5;
    if (!this.view.model) { if (!this.view.modelLayer._modelId) this._applyLook(); return; } // a model on its way applies its look
    this._applyLights();
    const a = old.sunDir, b = sunDir;
    let moved = (!!a !== !!b);
    if (a && b) moved = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) > Math.PI / 180;
    if (moved) this._fitShadow({ redraw: shadow });
    else if (this._sunStale && shadow) this._sunShadow(); // the sun came up: its map was skipped while it was down
    this.view.dirty = true;
  }

  _applyLights(): void {
    const t = Math.max(0, Math.min(1, this.sky.night)), hemi = this.view.hemi, sun = this.view.sun;
    const k = skyLights(this.render, t); // the recipe's day / night colours and intensities
    hemi.color.setHex(k.hemiSky);
    hemi.groundColor.setHex(k.hemiGround);
    const L = cloudLight(this.view.skyLayer.weather.applied || 0, t);
    hemi.intensity = k.hemiIntensity * L.hemi;
    sun.color.setHex(k.sunColor);
    // cloud shadows on: the sun keeps its clear-sky strength (the patches and the rooms' shade dim it)
    sun.intensity = k.sunIntensity * (this.sky.sun ?? 1) * (this.view.skyLayer._cloudShadowsOn() ? 1 : L.sun);
    // softer, fainter sun shadow under clouds: uniforms only (radius has no effect with PCFSoftShadowMap)
    sun.shadow.radius = L.shadowRadius;
    sun.shadow.intensity = L.shadowIntensity;
    this.view.skyLayer._applyMoonLight();
    this.view.skyLayer._cloudLook();
    // the city around the house: its sky / ground light outside the rooms, dimmed by clouds like the sky light
    const out = surroundLight(this._surround, t), U = this.view.skyLayer._cloudU;
    U.fpOutSky.value.setHex(out.sky).multiplyScalar(out.intensity * L.hemi);
    U.fpOutGround.value.setHex(out.ground).multiplyScalar(out.intensity * L.hemi);
    const city = this._city;
    U.fpCity.value = city ? cityLightsOn(t) : 0;
    if (city) U.fpCityParams.value.set(city.share, city.strength, city.street, city.glass);
    this.view.renderer.setClearColor(backgroundAt(this.background, t), 1);
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
    const want = new Map<THREE.Material, { lit: 'glow' | 'windows' | null; sway: boolean }>();
    const root = this.view.model!.root; // callers checked view.model
    root.traverse((o) => {
      if (!isMesh(o)) return;
      const info = shadowInfo(o);
      const lit = cityLitFor(info.names, info.layers, this._city);
      const sway = !!this._sway && this._sway.plants.some((p) => info.names.includes(p) || info.layers.includes(p));
      for (const m of ([] as (THREE.Material | undefined)[]).concat(o.material)) {
        if (!m || !m.userData.fpCloud) continue;
        const w = want.get(m) || { lit: null, sway: false };
        want.set(m, { lit: w.lit || lit, sway: w.sway || sway });
      }
    });
    for (const [m, { lit, sway }] of want) {
      if ((m.userData.fpCityLit || null) === lit && !!m.userData.fpSway === sway) continue;
      m.userData.fpCityLit = lit;
      m.userData.fpSway = sway;
      m.needsUpdate = true;
    }
    const box = new THREE.Box3().setFromObject(root);
    this.view.skyLayer._cloudU.fpCityGround.value = box.isEmpty() ? 0 : box.min.y;
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
    this.view.skyLayer._cloudU.fpSway.value = next ? swayLean(this.view.skyLayer.weather.wind, next.strength) : 0;
    if (!this.view.model) return;
    this._cityWindows();
    this.view.dirty = true;
  }

  _stepSway(): void {
    const S = this._swayClock || (this._swayClock = { at: 0 });
    if (!this._sway || !this.view.model || !this.view.onScreen || this.view.test || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) { S.at = 0; return; }
    const now = performance.now();
    if (S.at && now - S.at < frameInterval(SWAY_FRAME_MS, this.view._maxFps)) return;
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

  // Card option ao (true or { intensity, radius, resolution }): ambient occlusion over the model, see ao.js.
  setAo(opt: unknown): void {
    const next = normAo(opt);
    if (JSON.stringify(next) === JSON.stringify(this._ao ? this._ao.settings : null)) return;
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
    const next: FinishSettings = { bokeh: opts.bokeh || null, grade: opts.grade || null };
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    this._finishOpts = next;
    if (this._finish) this._finish.dispose();
    this._finish = next.bokeh || next.grade ? new ScreenFinish(this.view.renderer, next) : null;
    this.view.dirty = true;
  }

  // The box the lens focuses on: the rooms on the visible floors, floor to ceiling (else the house box).
  _focusBox(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const solid of this.view.skyLayer._roomSolids()) box.setFromPoints(solid.concat(box.isEmpty() ? [] : [box.min.clone(), box.max.clone()]));
    return box;
  }

  // Card option background ('#rrggbb' or { day, night }). Re-applied now with a model loaded.
  setBackground(opt: unknown): void {
    const next = backgroundColors(opt);
    if (next.day === this.background.day && next.night === this.background.night) return;
    this.background = next;
    if (!this.view.model) return;
    this._applyLights();
    this.view.dirty = true;
  }

  // Card option furniture: 'white' shows every material that carries extras fp_white ([r, g, b] linear, the
  // model's white look) in that colour instead of its own; anything else ('color', unset) the modelled colour.
  setFurniture(opt: unknown): void {
    const next = opt === 'white' ? 'white' : 'color';
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
    for (const s of this._screens || []) if (setScreenOn(s, screenOn(s.anim, this._screenStates))) changed = true;
    return changed;
  }

  // Advance the playing screens to the frame for now; only a changed frame asks for a render.
  _stepScreens(): void {
    if (!this._screens || !this._screens.length || !this.view.onScreen) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const t = performance.now() / 1000;
    for (const s of this._screens) if (s.on && showFrame(s, frameAt(s.anim, t))) this.view.dirty = true;
  }

  _applyFurniture(): boolean {
    return !!this.view.model && paintFurniture(this.view.model.root, this.furniture === 'white') > 0;
  }

  // Renderer, light and shadow settings for model / no model and day / night.
  _applyLook(): void {
    const r = this.view.renderer, day = this.view.model ? this.daylight : true, sun = this.view.sun, hemi = this.view.hemi;
    this._modelLook = !!this.view.model;
    if (this.view.model) {
      if (this._cityModel !== this.view.model) { this._cityModel = this.view.model; this._cityWindows(); } // once per model
      const rd = this.render;
      r.toneMapping = TONE[rd.toneMapping] ?? THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = rd.exposure;
      r.outputColorSpace = rd.outputColorSpace === 'srgb-linear' ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
      r.shadowMap.enabled = true;
      r.shadowMap.autoUpdate = false; // re-rendered on demand (needsUpdate), not every frame
      this._shadowDirty();
      r.shadowMap.type = THREE.PCFSoftShadowMap;
      this._applyLights();
      sun.castShadow = true; // stays on (toggling recompiles shaders); night = intensity 0
      sun.shadow.autoUpdate = false; // redrawn only when flagged, and only while the sun is up
      const sm = this.view.test ? Math.min(512, rd.sun.shadowMapSize) : rd.sun.shadowMapSize;
      if (sun.shadow.mapSize.x !== sm) {
        sun.shadow.mapSize.set(sm, sm);
        if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } // re-created at the new size
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
      sun.position.set(-12, 30, 18);
      sun.target.position.set(0, 0, 0);
    }
    // toneMapping / shadowMap changes need the shaders rebuilt
    this.view.scene.traverse((obj) => {
      const o = obj as Drawable;
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
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
      if (l.role === 'storey' || l.role === 'basement' || l.role === 'roof') box.union(new THREE.Box3().setFromObject(l.node));
    }
    if (box.isEmpty()) {
      model.root.traverse((o) => {
        if (!isMesh(o)) return;
        const b = new THREE.Box3().setFromObject(o);
        if (Math.max(b.max.x - b.min.x, b.max.z - b.min.z) <= SHADOW_MESH_M) box.union(b);
      });
    }
    if (box.isEmpty()) box = new THREE.Box3().setFromObject(this.view.modelGroup);
    if (box.isEmpty()) return;
    const ground = Math.min(Math.max(0, box.min.y), box.max.y);
    const hc = box.getCenter(new THREE.Vector3());
    this._dome = { centre: new THREE.Vector3(hc.x, ground, hc.z), radius: domeRadius(Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2) };
    this.view.skyLayer._placeSkyBodies();
    this._houseBox = box.clone(); // the sky keep-out without room polygons
    const all = new THREE.Box3().setFromObject(this.view.modelGroup); // rain / snow fall down to the model's bottom (not a far-off ground plane)
    this._modelBottom = all.isEmpty() ? box.min.y : Math.max(all.min.y, box.min.y - 40);
    box.expandByScalar(SHADOW_MARGIN_M);
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
    this._shadowBox = { centre: centre.clone(), radius };
    this.view.skyLayer._applyMoonLight();
    const dir = new THREE.Vector3(...(this.sky.sunDir || sunDirection(model.north, this.view.modelGroup.rotation.y)));
    sun.target.position.copy(centre);
    sun.position.copy(centre).addScaledVector(dir, radius * 2.5);
    const cam = sun.shadow.camera;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    cam.near = 0.5;
    cam.far = radius * 5;
    cam.updateProjectionMatrix();
    sun.target.updateMatrixWorld();
    if (redraw) this._sunShadow();
    else this._sunStale = true; // redrawn once the time scrubber settles
    this.view.stats.shadow++;
    this.view.dirty = true;
  }

  // The shadow casters changed (model, visibility, cut, section): the sun's map (while it is up) and
  // every lit pool shadow map. Dark lights are redrawn when they light up.
  _shadowDirty(): void {
    this._sunShadow();
    if (this.view.objectLayer) this.view._flagShadows(this.view.objectLayer.shadowsStale());
    this.view.stats.shadow++;
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

  // Ambient occlusion, the finish and the depth pass (view.dispose).
  dispose(): void {
    this.setAo(null);
    this._setFinish({ bokeh: null, grade: null });
    if (this._depthPass) this._depthPass.dispose();
    this._depthPass = null;
  }
}
