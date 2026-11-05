// @vitest-environment happy-dom
// The edit panel's fields on HA's <ha-selector> (a stand-in element here): selector configs, the
// value-changed round trip, and the native fallbacks' markup being replaced.
import { describe, it, expect, vi } from "bun:test";
import { render, html } from "lit";
import {
  checkField,
  entityField,
  entityInput,
  entityList,
  floorField,
  haSelectors,
  selectField,
} from "../src/edit/html.ts";

class FakeSelector extends HTMLElement {}

const ed = {
  hass: {
    floors: { ground: { floor_id: "ground", name: "Ground", level: 0 } },
    states: {},
    entities: {},
  },
  floors: [{ id: "ground", name: "Ground" }],
  drafts: new Map(),
  card: { _theme: { dark: false } },
  render: vi.fn(),
};

const mount = (tpl) => {
  const box = document.createElement("div");
  document.body.append(box);
  render(tpl, box);
  return box;
};
const change = (el, value) =>
  el.dispatchEvent(
    new CustomEvent("value-changed", { detail: { value }, bubbles: true }),
  );

describe("edit fields on HA's selectors", () => {
  it("native before ha-selector exists, HA's once it does", () => {
    expect(haSelectors()).toBe(false);
    const box = mount(
      selectField(ed, {
        name: "s",
        label: "S",
        value: "",
        options: [["", "None"]],
        onChange: () => {},
      }),
    );
    expect(box.querySelector("select[name=s]")).toBeTruthy();
    customElements.define("ha-selector", FakeSelector);
    expect(haSelectors()).toBe(true);
  });

  it("select: a dropdown select selector; the empty option round-trips", () => {
    const onChange = vi.fn();
    const box = mount(
      selectField(ed, {
        name: "s",
        label: "Source",
        value: "",
        options: [
          ["", "Default"],
          ["xy", "XY"],
        ],
        onChange,
      }),
    );
    const el = box.querySelector("ha-selector[name=s]");
    expect(el.label).toBe("Source");
    expect(el.selector.select.mode).toBe("dropdown");
    expect(el.selector.select.options.map((o) => o.label)).toEqual([
      "Default",
      "XY",
    ]);
    expect(el.value).toBe(el.selector.select.options[0].value); // "" has a stand-in value
    change(el, "xy");
    change(el, el.selector.select.options[0].value);
    expect(onChange.mock.calls).toEqual([["xy"], [""]]);
    expect(ed.render).toHaveBeenCalled();
  });

  it("entity: domain filter, no datalist; a none switch for unbound", () => {
    const onChange = vi.fn();
    const box = mount(
      html`${entityList(ed, "l", ["light.a"])}${entityInput(ed, {
        name: "e",
        id: "o1",
        list: "l",
        domains: ["light", "switch"],
        none: "No entity",
        value: "",
        onChange,
      })}`,
    );
    expect(box.querySelector("datalist")).toBe(null);
    const [pick, none] = box.querySelectorAll("ha-selector");
    expect(pick.selector).toEqual({
      entity: { filter: { domain: ["light", "switch"] } },
    });
    expect(pick.dataset.id).toBe("o1");
    expect(none.selector).toEqual({ boolean: {} });
    change(pick, "light.a");
    change(pick, undefined); // cleared
    change(none, true);
    expect(onChange.mock.calls).toEqual([["light.a"], [""], ["none"]]);
    const off = mount(
      entityField(ed, "Entity", {
        name: "e2",
        list: "l",
        none: "No entity",
        value: "none",
        onChange,
      }),
    );
    const [p2, n2] = off.querySelectorAll("ha-selector");
    expect(p2.label).toBe("Entity");
    expect(p2.disabled).toBe(true);
    expect(n2.value).toBe(true);
  });

  it("boolean and floor selectors", () => {
    const onCheck = vi.fn(),
      onFloor = vi.fn();
    const box = mount(
      html`${checkField(ed, {
        name: "c",
        label: "Outdoor",
        checked: true,
        onChange: onCheck,
      })}${floorField(ed, { name: "f", label: "Floor", value: "ground", onChange: onFloor })}`,
    );
    const c = box.querySelector("ha-selector[name=c]");
    expect([c.label, c.value, c.selector]).toEqual([
      "Outdoor",
      true,
      { boolean: {} },
    ]);
    change(c, false);
    expect(onCheck).toHaveBeenCalledWith(false);
    const f = box.querySelector("ha-selector[name=f]");
    expect(f.selector).toEqual({ floor: {} });
    change(f, "ground");
    expect(onFloor).toHaveBeenCalledWith("ground");
    // a layout floor HA doesn't know: a select of the layout floors
    const custom = { ...ed, floors: [{ id: "attic", name: "Attic" }] };
    const b2 = mount(
      floorField(custom, {
        name: "f2",
        label: "Floor",
        value: "attic",
        onChange: onFloor,
      }),
    );
    expect(
      b2.querySelector("ha-selector[name=f2]").selector.select,
    ).toBeTruthy();
  });
});
