// Visual editor for the card options (Lovelace "Show visual editor"), built on HA's ha-form.
// Rooms, devices, mower and model are edited on the card itself (its Edit button).

import type { CardConfig } from './types/config.ts';
import type { Hass } from './types/ha.ts';

/** One ha-form schema entry (HA frontend: a field with a selector, or a grid / expandable of fields). */
export interface FormSchema {
  name: string;
  type?: 'grid' | 'expandable';
  title?: string;
  selector?: Record<string, unknown>;
  schema?: FormSchema[];
}

/** HA's ha-form element: the properties this editor sets. */
interface HaForm extends HTMLElement {
  hass?: Hass;
  schema: FormSchema[];
  data: Record<string, unknown>;
  computeLabel: (s: FormSchema) => string;
  computeHelper: (s: FormSchema) => string;
}

const DEFAULTS: Record<string, unknown> = { layout_key: 'default', height: '520px', group_by: 'device', wall_height: 1.0, view: '3d', room_labels: 'size', zoom_to: 'center', occlusion: true, lights: 'auto', render: 'model', merge: true, sky_bodies: true, clouds: true };

export const SCHEMA: FormSchema[] = [
  { name: 'height', selector: { text: {} } },
  {
    type: 'grid', name: '', schema: [
      { name: 'view', selector: { select: { mode: 'dropdown', options: [{ value: '3d', label: '3D' }, { value: 'top', label: 'Top (north up)' }] } } },
      { name: 'floor', selector: { floor: {} } },
      { name: 'wall_height', selector: { number: { min: 0.2, max: 3, step: 0.05, mode: 'box', unit_of_measurement: 'm' } } },
      { name: 'group_by', selector: { select: { mode: 'dropdown', options: [{ value: 'device', label: 'One marker per device' }, { value: 'entity', label: 'One marker per entity' }] } } },
      { name: 'zoom_to', selector: { select: { mode: 'dropdown', options: [{ value: 'center', label: 'Centre of the view' }, { value: 'cursor', label: 'Mouse cursor' }] } } },
      { name: 'lights', selector: { select: { mode: 'dropdown', options: [{ value: 'auto', label: 'Real lights' }, { value: 'off', label: 'Glow only (weak devices)' }] } } },
      { name: 'render', selector: { select: { mode: 'dropdown', options: [{ value: 'model', label: 'From the model (render recipe)' }, { value: 'default', label: 'Card defaults' }] } } },
      { name: 'render_quality', selector: { select: { mode: 'dropdown', options: [{ value: 'standard', label: 'Standard' }, { value: 'high', label: 'High (bloom, soft shadows, materials)' }, { value: 'still', label: 'Still (path tracing when idle, experimental)' }] } } },
      { name: 'render_tone_mapping', selector: { select: { mode: 'dropdown', options: [{ value: 'auto', label: 'Auto (quality / model)' }, { value: 'agx', label: 'AgX' }, { value: 'aces', label: 'ACES filmic' }, { value: 'neutral', label: 'Neutral' }, { value: 'reinhard', label: 'Reinhard' }, { value: 'cineon', label: 'Cineon' }, { value: 'linear', label: 'Linear' }, { value: 'none', label: 'None' }] } } },
      { name: 'room_labels', selector: { select: { mode: 'dropdown', options: [{ value: 'size', label: 'Name and size' }, { value: 'name', label: 'Name only' }, { value: 'none', label: 'None' }] } } },
    ],
  },
  { name: 'occlusion', selector: { boolean: {} } },
  { name: 'merge', selector: { boolean: {} } },
  { name: 'sky_bodies', selector: { boolean: {} } },
  { name: 'clouds', selector: { boolean: {} } },
  { name: 'weather', selector: { entity: { domain: 'weather' } } },
  { name: 'idle_reset', selector: { number: { min: 0, max: 3600, step: 5, mode: 'box', unit_of_measurement: 's' } } },
  { name: 'idle_orbit', selector: { number: { min: -30, max: 30, step: 0.5, mode: 'box', unit_of_measurement: '°/s' } } },
  { name: 'furniture', selector: { select: { mode: 'dropdown', options: [{ value: 'color', label: 'As modelled' }, { value: 'white', label: 'White' }] } } },
  { name: 'night_markers', selector: { select: { mode: 'dropdown', options: [{ value: 'show', label: 'Show' }, { value: 'hide', label: 'Hide until touched' }] } } },
  { name: 'debug', selector: { boolean: {} } },
  { name: 'layout_key', selector: { text: {} } },
  {
    type: 'expandable', name: '', title: 'Model from a URL (instead of uploading in the card)', schema: [
      { name: 'model', selector: { text: {} } },
      {
        type: 'grid', name: '', schema: [
          { name: 'model_rotation', selector: { number: { min: -180, max: 180, step: 0.5, mode: 'box', unit_of_measurement: '°' } } },
          { name: 'model_scale', selector: { number: { min: 0.0001, step: 0.0001, mode: 'box' } } },
          { name: 'model_opacity', selector: { number: { min: 0.1, max: 1, step: 0.05, mode: 'slider' } } },
        ],
      },
    ],
  },
];

const LABELS: Record<string, string> = {
  height: 'Card height',
  view: 'Start view',
  floor: 'Start floor',
  wall_height: 'Cut-away wall height',
  occlusion: 'Dim markers behind walls',
  merge: 'Merge model parts (faster)',
  sky_bodies: 'Sun and moon in the sky',
  clouds: 'Cloud shadows, rain and snow',
  weather: 'Weather entity',
  idle_reset: 'Return to the start view when idle',
  idle_orbit: 'Turn slowly after returning',
  furniture: 'Furniture colours',
  night_markers: 'Markers at night',
  debug: 'Performance overlay (debug)',
  group_by: 'Markers',
  room_labels: 'Room labels',
  zoom_to: 'Zoom towards',
  lights: 'Model lamps',
  render: 'Render settings',
  render_quality: 'Render quality',
  render_tone_mapping: 'Tone mapping',
  layout_key: 'Layout name',
  model: 'Model URL (.glb)',
  model_rotation: 'Model rotation',
  model_scale: 'Model scale',
  model_opacity: 'Model opacity',
};

const HELPERS: Record<string, string> = {
  height: 'CSS height, e.g. 520px or 60vh',
  wall_height: 'Drawn walls only; a model is cut at the top of the storey',
  occlusion: 'With a 3D model: markers hidden by a wall from the current angle are shown faint',
  merge: 'With a 3D model: static parts of a room / layer with the same material are drawn as one (fewer draw calls). Turn off to keep every part separate.',
  sky_bodies: 'With a 3D model: show the sun and the moon (position and phase from your Home Assistant location)',
  clouds: 'With a 3D model: cloud shadows over the surroundings and rain / snow around the house from the weather entity, never over the rooms (the light follows the weather either way)',
  weather: 'Empty: the first weather entity. In YAML, weather: none ignores the weather.',
  floor: 'Empty: the first floor that has rooms',
  idle_orbit: 'With idle reset, in 3D: degrees a second the camera turns around the start view\'s centre until touched (negative: clockwise). Empty or 0: off',
  furniture: 'White: parts whose glTF material carries extras fp_white ([r, g, b] linear) show in that colour, a white model look',
  night_markers: 'Hide: at night the markers fade out (alerts stay) and a touch shows them for the idle reset time (30 s without it)',
  idle_reset: 'Seconds without a touch before the card returns to its start view and camera (wall tablets). Empty or 0: off',
  zoom_to: 'Centre: zoom and rotate around the view\'s rotation centre (Edit → Views)',
  lights: 'With a 3D model: lamps light the house (auto) or only glow (off)',
  render: 'With a 3D model: use its render recipe (exposure, camera, shadows, day / night light) or ignore it',
  render_quality: 'High and still cost more GPU time; still is meant for desktop GPUs. Material rules (render.materials) are set in YAML.',
  render_tone_mapping: 'Auto: AgX in high / still, otherwise the model\'s recipe',
  layout_key: 'Cards with the same name share one plan. Letters, digits, - and _.',
  model: 'e.g. /local/house.glb. Leave empty to upload a model on the card (Edit → Model).',
};

// The card option render is a string (the recipe) or an object { recipe, quality, tone_mapping, materials }; the
// form shows it as three flat fields. YAML-only keys (materials, unknown ones) pass through untouched.
const RENDER_FIELDS = { render_quality: 'quality', render_tone_mapping: 'tone_mapping' } as const;
const RENDER_FIELD_DEFAULTS = { render: 'model', render_quality: 'standard', render_tone_mapping: 'auto' } as const;

/** config.render -> the form's flat fields. */
export function splitRender(render: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...RENDER_FIELD_DEFAULTS };
  if (typeof render === 'string') out.render = render;
  else if (render && typeof render === 'object') {
    const r = render as Record<string, unknown>;
    if (r.recipe !== undefined) out.render = r.recipe;
    if (r.quality !== undefined) out.render_quality = r.quality;
    if (r.tone_mapping !== undefined) out.render_tone_mapping = r.tone_mapping;
  }
  return out;
}

/** The form's flat fields (+ the previous config.render for its YAML-only keys) -> config.render: the short
 * string form when only the recipe is set, undefined when everything is default. */
export function joinRender(value: Record<string, unknown>, prev: unknown): unknown {
  const obj: Record<string, unknown> = prev && typeof prev === 'object' ? { ...(prev as Record<string, unknown>) } : {};
  delete obj.recipe;
  const recipe = value.render || RENDER_FIELD_DEFAULTS.render;
  for (const [field, key] of Object.entries(RENDER_FIELDS)) {
    const v = value[field];
    if (v === undefined || v === '' || v === RENDER_FIELD_DEFAULTS[field as keyof typeof RENDER_FIELD_DEFAULTS]) delete obj[key];
    else obj[key] = v;
  }
  if (!Object.keys(obj).length) return recipe === RENDER_FIELD_DEFAULTS.render ? undefined : recipe;
  return recipe === RENDER_FIELD_DEFAULTS.render ? obj : { recipe, ...obj };
}

// Drop empty values and defaults so the YAML stays short.
export function cleanConfig<C extends Record<string, unknown>>(config: C): Partial<C> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined || v === null || v === '') continue;
    if (k !== 'type' && DEFAULTS[k] === v) continue;
    out[k] = v;
  }
  return out as Partial<C>;
}

export class Floorplan3dCardEditor extends HTMLElement {
  // set by setConfig / the hass setter / the first render (declare: no own field before then)
  declare _config: CardConfig;
  declare _hass: Hass | undefined;
  declare _form: HaForm | undefined;

  setConfig(config: CardConfig): void {
    this._config = config;
    this._render();
  }

  set hass(hass: Hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render(): void {
    if (!customElements.get('ha-form')) {
      this.textContent = 'Edit this card in YAML (the visual editor needs a newer Home Assistant).';
      return;
    }
    if (!this._form) {
      const form = document.createElement('ha-form') as HaForm; // HA's element (registered by the frontend)
      this._form = form;
      form.computeLabel = (s) => LABELS[s.name] || s.name;
      form.computeHelper = (s) => HELPERS[s.name] || '';
      form.addEventListener('value-changed', (e) => {
        e.stopPropagation();
        const raw = (e as CustomEvent<{ value: Record<string, unknown> }>).detail.value;
        const value = { ...raw };
        for (const f of Object.keys(RENDER_FIELDS)) delete value[f]; // folded back into render
        const render = joinRender(raw, this._config.render);
        const config = cleanConfig({ ...this._config, ...value, render, type: this._config.type }) as CardConfig; // type kept
        this._config = config;
        this.dispatchEvent(new CustomEvent('config-changed', { detail: { config }, bubbles: true, composed: true }));
      });
      const hint = document.createElement('p');
      hint.style.cssText = 'margin: 16px 0 0; color: var(--secondary-text-color); font-size: 13px;';
      hint.textContent = 'Rooms, devices, the mower and the 3D model are set up on the card itself: save, then use its Edit button.';
      this.append(form, hint);
    }
    const form = this._form;
    form.hass = this._hass;
    form.schema = SCHEMA;
    form.data = { ...DEFAULTS, ...this._config, ...splitRender(this._config.render) };
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'floorplan3d-card-editor': Floorplan3dCardEditor;
  }
}

if (!customElements.get('floorplan3d-card-editor')) customElements.define('floorplan3d-card-editor', Floorplan3dCardEditor);
