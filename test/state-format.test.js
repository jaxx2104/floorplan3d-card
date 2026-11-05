// @vitest-environment happy-dom
import { describe, it, expect } from "bun:test";
import { displayValue, stateColorCss, markerColor } from "../src/registry.ts";
import { paintStateIcon } from "../src/card/state-icon.ts";

const st = (entity_id, state, attributes = {}) => ({
  entity_id,
  state,
  attributes,
});

describe("displayValue with HA's formatters", () => {
  const states = {
    "sensor.t": st("sensor.t", "21.456", { unit_of_measurement: "°C" }),
    "climate.c": st("climate.c", "heat", { current_temperature: 20.5 }),
    "climate.n": st("climate.n", "off", { current_temperature: null }),
  };
  const hass = {
    states,
    formatEntityState: (s) => `HA:${s.state}`,
    formatEntityAttributeValue: (s, a) => `HA:${s.attributes[a]}`,
  };
  it("sensor state via formatEntityState", () => {
    expect(displayValue(hass, "sensor.t")).toBe("HA:21.456");
  });
  it("climate current temperature via formatEntityAttributeValue", () => {
    expect(displayValue(hass, "climate.c")).toBe("HA:20.5");
    expect(displayValue(hass, "climate.n")).toBe("");
  });
  it("without the formatters: the card's own text", () => {
    expect(displayValue({ states }, "sensor.t")).toBe("21.5°C");
    expect(displayValue({ states }, "climate.c")).toBe("20.5°");
  });
});

describe("stateColorCss / markerColor", () => {
  it("HA's state colour chain, most specific first, fallback last", () => {
    expect(
      stateColorCss(
        st("binary_sensor.d", "on", { device_class: "door" }),
        "binary_sensor",
        "#f00",
      ),
    ).toBe(
      "var(--state-binary_sensor-door-on-color, var(--state-binary_sensor-on-color, var(--state-binary_sensor-active-color, var(--state-active-color, #f00))))",
    );
    expect(stateColorCss(st("climate.c", "heat_cool"), "climate", "x")).toBe(
      "var(--state-climate-heat_cool-color, var(--state-climate-active-color, var(--state-active-color, x)))",
    );
  });
  it("odd state strings become safe property names", () => {
    expect(stateColorCss(st("x.y", "A b/c"), "x", "z")).toContain(
      "--state-x-a_b_c-color",
    );
  });
  it("only active or alerting markers get a colour", () => {
    expect(markerColor(st("light.a", "off"), "light", null)).toBe("");
    expect(markerColor(undefined, "light", null)).toBe("");
    expect(markerColor(st("light.a", "on"), "light", null)).toMatch(
      /^var\(--state-light-on-color, .*#ffb74d\)+$/,
    );
    expect(markerColor(st("switch.a", "on"), "switch", null)).toMatch(
      /var\(--primary-color\)\)+$/,
    );
    const smoke = st("binary_sensor.s", "on", { device_class: "smoke" });
    expect(markerColor(smoke, "binary_sensor", "red")).toMatch(
      /^var\(--state-binary_sensor-smoke-on-color, .*#e53935\)+$/,
    );
  });
});

describe("paintStateIcon", () => {
  const hass = {
    states: { "light.a": st("light.a", "on") },
    entities: {},
  };
  it("ha-icon with the card's icon when ha-state-icon is not defined", () => {
    const host = document.createElement("div");
    paintStateIcon(host, hass, "light.a");
    const el = host.firstElementChild;
    expect(el.localName).toBe("ha-icon");
    expect(el.getAttribute("icon")).toBe("mdi:lightbulb");
    paintStateIcon(host, hass, "light.a", "mdi:robot-mower");
    expect(host.children.length).toBe(1);
    expect(el.getAttribute("icon")).toBe("mdi:robot-mower");
  });
  it("ha-state-icon with hass, stateObj and the override once HA defines it", () => {
    if (!customElements.get("ha-state-icon"))
      customElements.define("ha-state-icon", class extends HTMLElement {});
    const host = document.createElement("div");
    host.append(document.createElement("ha-icon")); // drawn before HA's element loaded
    paintStateIcon(host, hass, "light.a", "mdi:x");
    const el = host.firstElementChild;
    expect(host.children.length).toBe(1);
    expect(el.localName).toBe("ha-state-icon");
    expect(el.hass).toBe(hass);
    expect(el.stateObj).toBe(hass.states["light.a"]);
    expect(el.icon).toBe("mdi:x");
    paintStateIcon(host, hass, "light.a");
    expect(el.icon).toBe(undefined);
    // no state: the card's fallback icon
    paintStateIcon(host, hass, "light.gone");
    expect(host.firstElementChild.localName).toBe("ha-icon");
  });
});
