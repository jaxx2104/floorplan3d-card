// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { buildRegistry, dispatchAct, dispatchField, dispatchInput } from '../src/edit/tabs/index.ts';
import { REGISTRY } from '../src/edit/panel.ts';

const fakeEd = () => ({ message: { text: 'old' }, _syncStageClasses: vi.fn(), render: vi.fn() });

describe('edit registry', () => {
  it('throws on an act, field, input or range registered twice', () => {
    const a = { id: 'a', acts: { x: () => {} } };
    expect(() => buildRegistry([a, { id: 'b', acts: { x: () => {} } }])).toThrow(/duplicate edit acts handler "x" \(b\)/);
    expect(() => buildRegistry([{ id: 'a', fields: { f: () => {} } }, { id: 'b', fields: { f: () => {} } }])).toThrow(/fields/);
    expect(() => buildRegistry([{ id: 'a', inputs: { f: () => {} } }, { id: 'b', inputs: { f: () => {} } }])).toThrow(/inputs/);
    expect(() => buildRegistry([{ id: 'a', ranges: { 'p-': () => {} } }, { id: 'b', ranges: { 'p-': () => {} } }])).toThrow(/ranges/);
    // the same name in different kinds is fine (vw-sec-pos: change saves, input previews)
    expect(() => buildRegistry([{ id: 'a', fields: { f: () => {} } }, { id: 'b', inputs: { f: () => {} } }])).not.toThrow();
  });

  it('the panel registry builds and covers the tab bar and every tab', () => {
    for (const act of ['tab', 'draw', 'place', 'tag-rm', 'cal-add', 'vw-add', 'md-ack', 'export']) expect(REGISTRY.acts.has(act), act).toBe(true);
    expect([...REGISTRY.ranges.keys()].sort()).toEqual(['md-', 'ov-']);
    expect(REGISTRY.inputs.has('vw-sec-pos') && REGISTRY.fields.has('vw-sec-pos')).toBe(true);
  });

  it('every data-act / data-field written in the panel markup has a handler', () => {
    const dir = path.resolve(__dirname, '../src/edit');
    const files = fs.readdirSync(dir, { recursive: true }).filter((f) => /\.[jt]s$/.test(f) && !f.includes('view-menu'));
    const acts = new Set(), fields = new Set();
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of text.matchAll(/data-act="([a-z-]+)"/g)) acts.add(m[1]);
      for (const m of text.matchAll(/data-field="([a-z-]+)"/g)) fields.add(m[1]);
    }
    expect(acts.size).toBeGreaterThan(60);
    for (const a of acts) expect(REGISTRY.acts.has(a), a).toBe(true);
    for (const f of fields) expect(REGISTRY.fields.has(f) || REGISTRY.inputs.has(f), f).toBe(true);
  });

  it('a click clears the message; "render" re-syncs the stage and renders once, nothing else does not', () => {
    const calls = [];
    const reg = buildRegistry([{ id: 't', acts: { a: (ed, btn) => { calls.push(btn); return 'render'; }, b: () => {} } }]);
    let ed = fakeEd();
    dispatchAct(ed, reg, 'a', 'btn');
    expect(ed.message).toBe(null);
    expect(calls).toEqual(['btn']);
    expect(ed._syncStageClasses).toHaveBeenCalledTimes(1);
    expect(ed.render).toHaveBeenCalledTimes(1);
    expect(ed._syncStageClasses.mock.invocationCallOrder[0]).toBeLessThan(ed.render.mock.invocationCallOrder[0]);
    ed = fakeEd();
    dispatchAct(ed, reg, 'b', 'btn');
    expect(ed.message).toBe(null);
    expect(ed._syncStageClasses).not.toHaveBeenCalled();
    expect(ed.render).not.toHaveBeenCalled();
    ed = fakeEd();
    dispatchAct(ed, reg, 'unknown', 'btn');
    expect(ed.message).toBe(null);
    expect(ed.render).not.toHaveBeenCalled();
  });

  it('the message is cleared before the handler runs (handlers set their own)', () => {
    const reg = buildRegistry([{ id: 't', acts: { a: (ed) => { ed.message = { text: 'new' }; } } }]);
    const ed = fakeEd();
    dispatchAct(ed, reg, 'a', {});
    expect(ed.message).toEqual({ text: 'new' });
  });

  it('fields dispatch by data-field; inputs try the exact name, then a range prefix', () => {
    const seen = [];
    const reg = buildRegistry([{
      id: 't',
      fields: { f: () => seen.push('field') },
      inputs: { 'ov-exact': () => seen.push('exact') },
      ranges: { 'ov-': () => seen.push('ov'), 'md-': () => seen.push('md') },
    }]);
    const el = (field, type = 'range') => ({ type, dataset: field ? { field } : {} });
    dispatchField({}, reg, el('f'));
    dispatchField({}, reg, el('nope'));
    dispatchInput({}, reg, el('ov-exact'));
    dispatchInput({}, reg, el('ov-x'));
    dispatchInput({}, reg, el('md-y'));
    dispatchInput({}, reg, el('ov-x', 'text')); // a prefix only matches a range
    dispatchInput({}, reg, el(undefined));
    expect(seen).toEqual(['field', 'exact', 'ov', 'md']);
  });
});
