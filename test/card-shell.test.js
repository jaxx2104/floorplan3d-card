// @vitest-environment jsdom
// The floorplan3d-card shell: HA's card API without the card module, which it imports on first connect
// and hosts as a floorplan3d-card-impl child that gets every config and hass.
import { describe, it, expect, vi } from 'vitest';
import '../src/floorplan3d-card.ts';

// jsdom has no WebGL: a stand-in impl records what the shell forwards (the real one is in card-facade)
vi.mock('../src/card-impl.ts', () => {
  class FakeImpl extends HTMLElement {
    constructor() { super(); this.configs = []; this.hasses = []; }
    setConfig(c) { this.configs.push(c); }
    set hass(h) { this.hasses.push(h); }
  }
  if (!customElements.get('floorplan3d-card-impl')) customElements.define('floorplan3d-card-impl', FakeImpl);
  return {};
});

const shell = () => document.createElement('floorplan3d-card');
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('floorplan3d-card shell', () => {
  it('answers HA before the card module loads', async () => {
    const C = customElements.get('floorplan3d-card');
    expect(C.getStubConfig()).toEqual({});
    const s = shell();
    expect(s.getCardSize()).toBe(10);
    s.setConfig({ type: 'custom:floorplan3d-card', height: '600px' });
    expect(s.getCardSize()).toBe(12);
    expect(s.getGridOptions()).toEqual({ columns: 'full', min_columns: 6, rows: 'auto' });
    expect(() => s.setConfig(null)).toThrow();
    await settle();
    expect(s.querySelector('floorplan3d-card-impl')).toBeNull(); // not connected: nothing loaded
    const ed = await C.getConfigElement();
    expect(ed.localName).toBe('floorplan3d-card-editor');
  });
  it('keeps the configured height while loading, then hosts the card with config and hass', async () => {
    const s = shell();
    const h1 = { states: {} };
    s.hass = h1; // hass may come first
    s.setConfig({ height: '300px' });
    expect(s.style.minHeight).toBe('300px');
    document.body.append(s);
    await settle();
    const impl = s.querySelector('floorplan3d-card-impl');
    expect(impl).toBeTruthy();
    expect(impl.configs).toEqual([{ height: '300px' }]);
    expect(impl.hasses).toEqual([h1]);
    expect(s.style.minHeight).toBe('');
    const h2 = { states: {} };
    s.hass = h2;
    s.setConfig({ height: '400px' });
    expect(impl.hasses).toEqual([h1, h2]);
    expect(impl.configs).toEqual([{ height: '300px' }, { height: '400px' }]);
    s.remove();
    document.body.append(s); // reconnect: the same child
    await settle();
    expect(s.querySelectorAll('floorplan3d-card-impl').length).toBe(1);
    s.remove();
  });
  it('a config arriving after connect loads the card too', async () => {
    const s = shell();
    document.body.append(s);
    await settle();
    expect(s.querySelector('floorplan3d-card-impl')).toBeNull(); // no config yet
    s.setConfig({});
    await settle();
    expect(s.querySelector('floorplan3d-card-impl').configs).toEqual([{}]);
    s.remove();
  });
});
