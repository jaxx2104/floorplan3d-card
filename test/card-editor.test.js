// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'bun:test';

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

describe('card editor: render option', () => {
  let mod;
  beforeAll(async () => {
    if (!customElements.get('ha-form')) customElements.define('ha-form', class extends HTMLElement {});
    mod = await import('../src/card-editor.ts');
  });

  it('splits the string and object forms into the flat fields', () => {
    expect(mod.splitRender(undefined)).toEqual({ render: 'model', render_quality: 'high', render_tone_mapping: 'auto' });
    expect(mod.splitRender('default')).toMatchObject({ render: 'default', render_quality: 'high' });
    expect(mod.splitRender({ quality: 'standard' })).toMatchObject({ render: 'model', render_quality: 'standard' });
    expect(mod.splitRender({ quality: 'high', tone_mapping: 'agx' })).toEqual({ render: 'model', render_quality: 'high', render_tone_mapping: 'agx' });
  });

  it('joins back to the shortest form and keeps YAML-only keys', () => {
    const d = { render: 'model', render_quality: 'high', render_tone_mapping: 'auto' };
    expect(mod.joinRender(d, undefined)).toBeUndefined();
    expect(mod.joinRender({ ...d, render_quality: 'standard' }, undefined)).toEqual({ quality: 'standard' });
    expect(mod.joinRender({ ...d, render: 'default' }, undefined)).toBe('default');
    expect(mod.joinRender({ ...d, render_quality: 'still' }, 'model')).toEqual({ quality: 'still' });
    expect(mod.joinRender({ ...d, render: 'default', render_tone_mapping: 'aces' }, undefined)).toEqual({ recipe: 'default', tone_mapping: 'aces' });
    const materials = { 'name:Window*': 'glass' };
    expect(mod.joinRender({ ...d, render_quality: 'standard' }, { quality: 'high', materials })).toEqual({ materials, quality: 'standard' });
    expect(mod.joinRender(d, { quality: 'standard', materials })).toEqual({ materials });
  });

  it('round-trips through the form', () => {
    const el = document.createElement('floorplan3d-card-editor');
    document.body.append(el);
    el.setConfig({ type: 'custom:floorplan3d-card', render: { quality: 'standard' } });
    const form = el.querySelector('ha-form');
    expect(form.data).toMatchObject({ render: 'model', render_quality: 'standard', render_tone_mapping: 'auto' });
    expect(form.schema.flatMap((x) => x.schema || [x]).find((x) => x.name === 'render_quality').selector.select.options.map((o) => o.value))
      .toEqual(['high', 'standard', 'still']);
    let got;
    el.addEventListener('config-changed', (e) => { got = e.detail.config; });
    form.dispatchEvent(new CustomEvent('value-changed', { detail: { value: { ...form.data, render_tone_mapping: 'neutral' } } }));
    expect(got).toEqual({ type: 'custom:floorplan3d-card', render: { quality: 'standard', tone_mapping: 'neutral' } });
    form.dispatchEvent(new CustomEvent('value-changed', { detail: { value: { ...form.data, render_quality: 'high', render_tone_mapping: 'auto' } } }));
    expect(got).toEqual({ type: 'custom:floorplan3d-card' });
  });
});
