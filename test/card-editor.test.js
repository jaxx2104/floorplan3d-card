// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';

// stand-in for HA's ha-form
class FakeForm extends HTMLElement {}

describe('card editor', () => {
  let mod;
  beforeAll(async () => {
    customElements.define('ha-form', FakeForm);
    mod = await import('../src/card-editor.ts');
  });

  it('drops empty values and defaults', () => {
    expect(mod.cleanConfig({ type: 'custom:floorplan3d-card', height: '520px', view: 'top', model: '', floor: undefined, wall_height: 1.2 }))
      .toEqual({ type: 'custom:floorplan3d-card', view: 'top', wall_height: 1.2 });
  });

  it('offers room_labels name / size / none (size is the default)', () => {
    const field = mod.SCHEMA.flatMap((x) => x.schema || [x]).find((x) => x.name === 'room_labels');
    expect(field.selector.select.options.map((o) => o.value).sort()).toEqual(['name', 'none', 'size']);
    expect(mod.cleanConfig({ room_labels: 'size' })).toEqual({});
    expect(mod.cleanConfig({ room_labels: 'none' })).toEqual({ room_labels: 'none' });
  });

  it('offers zoom_to center / cursor (center is the default)', () => {
    const field = mod.SCHEMA.flatMap((x) => x.schema || [x]).find((x) => x.name === 'zoom_to');
    expect(field.selector.select.options.map((o) => o.value)).toEqual(['center', 'cursor']);
    expect(mod.cleanConfig({ zoom_to: 'center' })).toEqual({});
    expect(mod.cleanConfig({ zoom_to: 'cursor' })).toEqual({ zoom_to: 'cursor' });
  });

  it('offers lights auto / off (auto is the default)', () => {
    const field = mod.SCHEMA.flatMap((x) => x.schema || [x]).find((x) => x.name === 'lights');
    expect(field.selector.select.options.map((o) => o.value)).toEqual(['auto', 'off']);
    expect(mod.cleanConfig({ lights: 'auto' })).toEqual({});
    expect(mod.cleanConfig({ lights: 'off' })).toEqual({ lights: 'off' });
  });

  it('offers merge as a boolean (true is the default)', () => {
    const field = mod.SCHEMA.flatMap((x) => x.schema || [x]).find((x) => x.name === 'merge');
    expect(field.selector).toEqual({ boolean: {} });
    expect(mod.cleanConfig({ merge: true })).toEqual({});
    expect(mod.cleanConfig({ merge: false })).toEqual({ merge: false });
  });

  it('renders ha-form with defaults and emits cleaned config', () => {
    const el = document.createElement('floorplan3d-card-editor');
    document.body.append(el);
    el.setConfig({ type: 'custom:floorplan3d-card', view: 'top' });
    el.hass = { states: {} };
    const form = el.querySelector('ha-form');
    expect(form.data).toMatchObject({ view: 'top', height: '520px', layout_key: 'default' });
    expect(form.schema).toBe(mod.SCHEMA);
    expect(form.hass).toEqual({ states: {} });
    expect(form.computeLabel({ name: 'wall_height' })).toBe('Cut-away wall height');

    let got;
    el.addEventListener('config-changed', (e) => { got = e.detail.config; });
    form.dispatchEvent(new CustomEvent('value-changed', { detail: { value: { ...form.data, height: '600px', view: '3d' } } }));
    expect(got).toEqual({ type: 'custom:floorplan3d-card', height: '600px' });
  });
});
