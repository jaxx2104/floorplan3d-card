// @vitest-environment jsdom
// The edit panel rendered with lit-html: tabs render into the panel element of a real EditMode on a fake
// card; clicks / changes / inputs are dispatched on the rendered controls.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'lit';
import { EditMode } from '../src/edit-mode.ts';
import { slider, entityInput } from '../src/edit/html.ts';
import { roomsTab } from '../src/edit/tabs/rooms.ts';
import { onStates } from '../src/edit/panel.ts';

const flush = () => new Promise((r) => setTimeout(r, 0)); // queued microtask renders have run

function setup(layout = {}) {
  const view = { model: null, setOverlay: vi.fn(), setPivotMarker: vi.fn(), highlightModelNode: vi.fn(), setStems: vi.fn(), pixelsPerMetre: () => 50 };
  const hass = {
    areas: { kitchen: { area_id: 'kitchen', name: 'Kitchen', floor_id: 'ground' }, garage: { area_id: 'garage', name: 'Garage', floor_id: 'ground' } },
    floors: { ground: { floor_id: 'ground', name: 'Ground', level: 0 } },
    states: { 'sensor.kettle': { entity_id: 'sensor.kettle', state: '1', attributes: { friendly_name: 'Kettle' } }, 'sensor.plain': { entity_id: 'sensor.plain', state: '1', attributes: {} } },
    entities: { 'sensor.kettle': { entity_id: 'sensor.kettle', platform: 'sonoff' } },
  };
  const card = {
    _layout: { version: 1, rooms: [{ id: 'r1', area_id: 'kitchen', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], doors: [] }], pins: {}, hidden: [], ...layout },
    _hass: hass, _view: view, _floors: [{ id: 'ground', name: 'Ground', elevation: 0, height: 2.7 }],
    _config: { layout_key: 'default' }, _store: { backend: 'shared' }, _built: { theme: { dark: false, primary: 0 } },
    _modelRooms: [], _floor: 'ground', _viewState: null, _mode: '3d', _editing: true, _stage: document.createElement('div'),
    _setFloor: vi.fn(), _setMode: vi.fn(), _applyMarkerSelection: vi.fn(), modelBindings: () => null,
    _mowerFloor: () => 'ground', mowerAuto: () => null, mapInfo: () => ({}), _mowerLive: null,
  };
  const ed = new EditMode(card);
  // a commit rebuilds the card, which re-renders the panel
  card._commit = vi.fn((l) => { card._layout = l; ed.afterUpdate(); });
  document.body.append(ed.panel);
  ed.renderNow();
  return { ed, card, panel: ed.panel };
}
const buttons = (root, text) => [...root.querySelectorAll('button')].filter((b) => b.textContent.trim() === text);
const button = (root, text) => buttons(root, text)[0];
const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });

describe('edit panel (lit-html)', () => {
  it('renders the tab bar and the Rooms tab with every area', () => {
    const { panel } = setup();
    expect([...panel.querySelectorAll('.tabs button')].map((b) => b.textContent)).toEqual(['Rooms', 'Devices', 'Mower', 'Views', 'Model', 'Data']);
    expect(panel.querySelector('.tabs button.on').textContent).toBe('Rooms');
    const rows = [...panel.querySelectorAll('ul.list li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim());
    expect(rows).toEqual(['Garage missing Draw', 'Kitchen drawn Select']);
  });

  it('a tab click clears the message, syncs the stage and renders the tab in a fresh body', async () => {
    const { ed, panel } = setup();
    ed.message = { text: 'old' };
    ed.renderNow();
    const body = panel.querySelector('.tab-body');
    expect(body.querySelector('.msg').textContent).toBe('old');
    const sync = vi.spyOn(ed, '_syncStageClasses');
    button(panel, 'Data').click();
    expect(ed.tab).toBe('data');
    expect(ed.message).toBe(null);
    expect(sync).toHaveBeenCalled();
    await flush();
    expect(panel.querySelector('.tabs button.on').textContent).toBe('Data');
    expect(panel.querySelector('.tab-body')).not.toBe(body); // a new tab starts scrolled to the top
    expect(panel.querySelector('.msg')).toBe(null);
    expect(panel.querySelector('[name=import]')).toBeTruthy();
  });

  it('re-renders keep the elements: a select and a button stay the same nodes', async () => {
    const { ed, panel } = setup();
    const sel = panel.querySelector('[name=room-labels]');
    const draw = button(panel, 'Draw');
    ed.render();
    ed.render();
    await flush();
    expect(panel.querySelector('[name=room-labels]')).toBe(sel);
    expect(button(panel, 'Draw')).toBe(draw);
  });

  it('renders are coalesced: many requests, one render per task', async () => {
    const { ed } = setup();
    const view = vi.spyOn(ed.card, 'modelBindings'); // read once per panel render (objectsAvailable)
    ed.card._view.model = {};
    for (let i = 0; i < 5; i++) ed.render();
    expect(view).not.toHaveBeenCalled();
    await flush();
    expect(view).toHaveBeenCalledTimes(1);
  });

  it('select a room, change its fields, and the two-step delete', async () => {
    const { ed, card, panel } = setup();
    button(panel, 'Select').click();
    await flush();
    expect(ed.selectedRoom).toBe('r1');
    const outdoor = panel.querySelector('[name=room-outdoor]');
    outdoor.checked = true;
    fire(outdoor, 'change');
    expect(card._commit).toHaveBeenLastCalledWith(expect.objectContaining({ rooms: [expect.objectContaining({ id: 'r1', outdoor: true })] }));
    await flush();
    expect(panel.querySelector('[name=room-outdoor]').checked).toBe(true);
    button(panel, 'Add door').click();
    await flush();
    expect(ed.doorMode).toBe(true);
    expect(button(panel, 'Click a wall on the plan…').classList.contains('primary')).toBe(true);
    button(panel, 'Delete room').click();
    await flush();
    expect(ed.confirmDelete).toBe(true);
    expect(card._layout.rooms).toHaveLength(1);
    button(panel, 'Really delete?').click();
    await flush();
    expect(card._layout.rooms).toEqual([]);
    expect(ed.selectedRoom).toBe(null);
    expect(button(panel, 'Delete room')).toBeUndefined();
  });

  it('a checkbox the code does not change follows the layout (live)', async () => {
    const { ed, card, panel } = setup();
    ed.selectRoom('r1');
    await flush();
    const outdoor = panel.querySelector('[name=room-outdoor]');
    card._commit.mockImplementation(() => ed.afterUpdate()); // the commit is refused: the layout stays
    outdoor.checked = true;
    fire(outdoor, 'change');
    await flush();
    expect(outdoor.checked).toBe(false);
  });

  it('Draw starts drawing: the tab shows the drawing box with its buttons', async () => {
    const { ed, panel } = setup();
    button(panel, 'Draw').click();
    await flush();
    expect(ed.drawing).toMatchObject({ areaId: 'garage', floorId: 'ground', points: [] });
    expect(panel.querySelector('h3').textContent).toBe('Drawing: Garage');
    expect(button(panel, 'Finish').disabled).toBe(true);
    button(panel, 'Cancel').click();
    await flush();
    expect(ed.drawing).toBe(null);
    expect(button(panel, 'Draw')).toBeTruthy();
  });

  it('a tab template renders into any container', () => {
    const { ed } = setup();
    const box = document.createElement('div');
    render(roomsTab(ed), box);
    expect(box.querySelector('[name=room-labels]').value).toBe('size');
  });

  it('only a live tab re-renders on hass updates, once per frame', async () => {
    const { ed } = setup();
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    onStates(ed);
    expect(raf).not.toHaveBeenCalled();
    ed.tab = 'mower';
    onStates(ed);
    onStates(ed);
    expect(raf).toHaveBeenCalledTimes(1);
    expect(ed._renderQueued).toBe('frame');
    raf.mock.calls[0][0]();
    expect(ed._renderQueued).toBe(null);
    expect(ed.panel.querySelector('.mower-live').textContent).toContain('Pick the entity');
    raf.mockRestore();
  });
});

describe('panel parts', () => {
  const mount = (ed, tpl) => { const box = document.createElement('div'); document.body.append(box); const r = () => render(tpl(), box); r(); return { box, r }; };

  it('slider: input moves live, the number follows, the range node stays; typed numbers are clamped and rounded', async () => {
    const { ed } = setup();
    let value = 10;
    const onInput = vi.fn(), onChange = vi.fn((v) => { value = v; }); // saved: the next render shows it
    ed.render = () => r(); // re-render the part on request
    const { box, r } = mount(ed, () => slider(ed, { name: 's', label: 'S', min: 0, max: 50, step: 0.5, value, unit: 'm', onInput, onChange }));
    const range = box.querySelector('input[type=range]'), num = box.querySelector('input.slnum[data-for=s]');
    expect([range.value, num.value, box.querySelector('.unit').textContent]).toEqual(['10', '10', 'm']);
    range.value = '20';
    fire(range, 'input');
    expect(onInput).toHaveBeenLastCalledWith(20);
    expect(onChange).not.toHaveBeenCalled();
    expect(num.value).toBe('20'); // the draft value while dragged
    expect(box.querySelector('input[type=range]')).toBe(range);
    fire(range, 'change');
    expect(onChange).toHaveBeenLastCalledWith(20);
    num.value = '99';
    fire(num, 'change');
    expect(onChange).toHaveBeenLastCalledWith(50);
    expect(num.value).toBe('50');
    num.value = '12,26';
    num.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onChange).toHaveBeenLastCalledWith(12.5);
    expect(num.value).toBe('12.5');
    num.value = 'x';
    fire(num, 'change');
    expect(num.value).toBe('12.5'); // not a number: back to the slider's value
  });

  it('slider: arrow keys step at once, saved 400 ms after the last key', () => {
    vi.useFakeTimers();
    const { ed } = setup();
    const onChange = vi.fn();
    ed.render = () => {};
    const { box } = mount(ed, () => slider(ed, { name: 's', label: 'S', min: 0, max: 10, step: 0.5, value: 3, onChange }));
    const num = box.querySelector('input.slnum');
    num.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    num.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(num.value).toBe('4');
    vi.advanceTimersByTime(300);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('entity input: the logo follows what is typed, the value is saved on change', () => {
    const { ed } = setup();
    const onChange = vi.fn();
    ed.render = () => r();
    const { box, r } = mount(ed, () => entityInput(ed, { name: 'e', list: 'l', value: '', onChange }));
    const input = box.querySelector('input[name=e]');
    const logo = () => input.previousElementSibling.querySelector('img.fp-logo');
    expect(input.previousElementSibling.classList.contains('lg')).toBe(true);
    expect(logo()).toBe(null);
    input.value = 'sensor.kettle';
    fire(input, 'input');
    expect(logo().src).toContain('/sonoff/icon.png');
    expect(logo().title).toBe('Sonoff');
    expect(onChange).not.toHaveBeenCalled();
    input.value = 'sensor.plain';
    fire(input, 'input');
    expect(logo()).toBe(null);
    fire(input, 'change');
    expect(onChange).toHaveBeenCalledWith('sensor.plain');
    expect(box.querySelector('input[name=e]')).toBe(input);
  });
});
