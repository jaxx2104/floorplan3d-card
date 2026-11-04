import { describe, it, expect } from 'vitest';
import { buildMarkers, floorsFromHA, iconFor, isActive, displayValue } from '../src/registry.ts';

const st = (state, attributes = {}) => ({ state, attributes });
const hass = {
  areas: { kitchen: { area_id: 'kitchen', name: 'Kitchen', floor_id: 'ground' } },
  floors: {
    up: { floor_id: 'up', name: 'Upstairs', level: 1 },
    ground: { floor_id: 'ground', name: 'Ground', level: 0 },
  },
  devices: {
    d1: { id: 'd1', name: 'Plug', name_by_user: 'Kettle plug', area_id: 'kitchen' },
    d2: { id: 'd2', name: 'Thermo', area_id: 'kitchen' },
  },
  entities: {
    'switch.plug': { entity_id: 'switch.plug', device_id: 'd1' },
    'sensor.plug_power': { entity_id: 'sensor.plug_power', device_id: 'd1' },
    'sensor.plug_temp': { entity_id: 'sensor.plug_temp', device_id: 'd1' },
    'update.plug_fw': { entity_id: 'update.plug_fw', device_id: 'd1' },
    'sensor.plug_rssi': { entity_id: 'sensor.plug_rssi', device_id: 'd1', entity_category: 'diagnostic' },
    'sensor.thermo_h': { entity_id: 'sensor.thermo_h', device_id: 'd2' },
    'sensor.thermo_t': { entity_id: 'sensor.thermo_t', device_id: 'd2' },
    'light.hall': { entity_id: 'light.hall', area_id: 'hall', device_id: 'd2' },
    'light.hidden': { entity_id: 'light.hidden', area_id: 'kitchen', hidden: true },
    'light.no_state': { entity_id: 'light.no_state', area_id: 'kitchen' },
  },
  states: {
    'switch.plug': st('on'),
    'sensor.plug_power': st('12.345', { device_class: 'power', unit_of_measurement: 'W' }),
    'sensor.plug_temp': st('21', { device_class: 'temperature', unit_of_measurement: '°C' }),
    'update.plug_fw': st('off'),
    'sensor.plug_rssi': st('-60'),
    'sensor.thermo_h': st('40', { device_class: 'humidity' }),
    'sensor.thermo_t': st('20.5', { device_class: 'temperature', friendly_name: 'Thermo T' }),
    'light.hall': st('off', { friendly_name: 'Hall light' }),
    'light.hidden': st('on'),
  },
};

describe('buildMarkers', () => {
  const markers = buildMarkers(hass, { hidden: [] });
  const byId = Object.fromEntries(markers.map((m) => [m.id, m]));

  it('groups entities per device and skips hidden, diagnostic, skipped-domain and stateless entities', () => {
    expect(Object.keys(byId).sort()).toEqual(['device:d1', 'device:d2', 'entity:light.hall']);
    expect(byId['device:d1'].entities.map((e) => e.eid)).not.toContain('sensor.plug_rssi');
    expect(byId['device:d1'].entities.map((e) => e.eid)).not.toContain('update.plug_fw');
  });

  it('picks the primary entity by domain priority, then sensor class', () => {
    expect(byId['device:d1']).toMatchObject({ entityId: 'switch.plug', domain: 'switch', name: 'Kettle plug', areaId: 'kitchen' });
    expect(byId['device:d2']).toMatchObject({ entityId: 'sensor.thermo_t', deviceClass: 'temperature', name: 'Thermo' });
  });

  it('chooses a secondary sensor for value display', () => {
    expect(byId['device:d1'].secondaryId).toBe('sensor.plug_temp');
    expect(byId['device:d2'].secondaryId).toBe('sensor.thermo_h');
  });

  it('splits entities with their own area off the device', () => {
    expect(byId['entity:light.hall']).toMatchObject({ areaId: 'hall', name: 'Hall light' });
  });

  it('honours the hidden list (marker id or entity id)', () => {
    const ids = buildMarkers(hass, { hidden: ['device:d1', 'light.hall'] }).map((m) => m.id);
    expect(ids).toEqual(['device:d2']);
  });

  it('groups by entity when asked', () => {
    const ids = buildMarkers(hass, {}, { group_by: 'entity' }).map((m) => m.id);
    expect(ids).toContain('entity:switch.plug');
    expect(ids).toContain('entity:sensor.plug_temp');
  });
});

describe('helpers', () => {
  it('sorts floors by level', () => {
    expect(floorsFromHA(hass).map((f) => f.id)).toEqual(['ground', 'up']);
    expect(floorsFromHA({})).toEqual([]);
  });

  it('picks icons from attributes, device class, then domain', () => {
    const h = { states: { 'light.a': st('on', { icon: 'mdi:ceiling-light' }), 'sensor.t': st('1', { device_class: 'temperature' }), 'fan.f': st('on') }, entities: {} };
    expect(iconFor(h, 'light.a')).toBe('mdi:ceiling-light');
    expect(iconFor(h, 'sensor.t')).toBe('mdi:thermometer');
    expect(iconFor(h, 'fan.f')).toBe('mdi:fan');
    expect(iconFor(h, 'foo.bar')).toBe('mdi:checkbox-blank-circle-outline');
  });

  it('knows active states', () => {
    expect(isActive(st('on'))).toBe(true);
    expect(isActive(st('off'))).toBe(false);
    expect(isActive(undefined)).toBe(false);
  });

  it('formats values', () => {
    expect(displayValue(hass, 'sensor.plug_power')).toBe('12.3W');
    expect(displayValue(hass, 'sensor.missing')).toBe('');
    const h = { states: { 'climate.a': st('heat', { current_temperature: 21 }), 'climate.b': st('off', { current_temperature: null }), 'sensor.s': st('unavailable') } };
    expect(displayValue(h, 'climate.a')).toBe('21°');
    expect(displayValue(h, 'climate.b')).toBe('');
    expect(displayValue(h, 'sensor.s')).toBe('unavailable');
  });
});
