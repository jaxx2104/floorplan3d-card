// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from "bun:test";
import { cardConfigSchema, parseCardConfig } from "../src/schema/config.ts";

// stand-in for HA's ha-form
class FakeForm extends HTMLElement {}

describe("card editor", () => {
  let mod;
  beforeAll(async () => {
    customElements.define("ha-form", FakeForm);
    mod = await import("../src/card-editor.ts");
  });

  it("drops empty values and defaults", () => {
    expect(
      mod.cleanConfig({
        type: "custom:floorplan3d-card",
        height: "520px",
        view: "top",
        model: "",
        floor: undefined,
        wall_height: 1.2,
      }),
    ).toEqual({
      type: "custom:floorplan3d-card",
      view: "top",
      wall_height: 1.2,
    });
  });

  // the leaf fields, through grids and expandables
  const leaves = (list) =>
    list.flatMap((x) => (x.schema ? leaves(x.schema) : [x]));
  const fields = () => leaves(mod.SCHEMA);
  const RENDER_FORM_FIELDS = ["render_quality", "render_tone_mapping"]; // folded into render

  it("every form field is a card option of the YAML contract", () => {
    const shape = Object.keys(cardConfigSchema.shape);
    const unknown = fields()
      .map((f) => f.name)
      .filter((n) => !shape.includes(n) && !RENDER_FORM_FIELDS.includes(n));
    expect(unknown).toEqual([]);
  });

  it("every value the form offers parses without a warning", () => {
    for (const f of fields()) {
      if (RENDER_FORM_FIELDS.includes(f.name)) continue;
      const values = f.selector?.select
        ? f.selector.select.options.map((o) => o.value)
        : f.selector?.boolean
          ? [true, false]
          : [];
      for (const v of values)
        expect(
          parseCardConfig({ [f.name]: v }).warnings,
          `${f.name}: ${v}`,
        ).toEqual([]);
    }
  });

  it("drops the contract's defaults, and the documented runtime defaults", () => {
    const contract = parseCardConfig({}).value;
    for (const [k, v] of Object.entries(contract))
      if (k !== "type") expect(mod.cleanConfig({ [k]: v }), k).toEqual({});
    // options without a schema default whose unset value means this
    for (const [k, dflt, other] of [
      ["room_labels", "size", "none"],
      ["zoom_to", "center", "cursor"],
      ["lights", "auto", "off"],
      ["merge", true, false],
    ]) {
      expect(mod.cleanConfig({ [k]: dflt })).toEqual({});
      expect(mod.cleanConfig({ [k]: other })).toEqual({ [k]: other });
    }
  });

  it("renders ha-form with defaults and emits cleaned config", () => {
    const el = document.createElement("floorplan3d-card-editor");
    document.body.append(el);
    el.setConfig({ type: "custom:floorplan3d-card", view: "top" });
    el.hass = { states: {} };
    const form = el.querySelector("ha-form");
    expect(form.data).toMatchObject({
      view: "top",
      height: "520px",
    });
    expect(form.schema).toBe(mod.SCHEMA);
    expect(form.hass).toEqual({ states: {} });
    expect(form.computeLabel({ name: "wall_height" })).toBe(
      "Cut-away wall height",
    );

    let got;
    el.addEventListener("config-changed", (e) => {
      got = e.detail.config;
    });
    form.dispatchEvent(
      new CustomEvent("value-changed", {
        detail: { value: { ...form.data, height: "600px", view: "3d" } },
      }),
    );
    expect(got).toEqual({ type: "custom:floorplan3d-card", height: "600px" });
  });
});

describe("card editor: render option", () => {
  let mod;
  beforeAll(async () => {
    if (!customElements.get("ha-form"))
      customElements.define("ha-form", class extends HTMLElement {});
    mod = await import("../src/card-editor.ts");
  });

  it("splits the string and object forms into the flat fields", () => {
    expect(mod.splitRender(undefined)).toEqual({
      render: "model",
      render_quality: "auto",
      render_tone_mapping: "auto",
    });
    expect(mod.splitRender("default")).toMatchObject({
      render: "default",
      render_quality: "auto",
    });
    expect(mod.splitRender({ quality: "standard" })).toMatchObject({
      render: "model",
      render_quality: "standard",
    });
    expect(mod.splitRender({ quality: "high", tone_mapping: "agx" })).toEqual({
      render: "model",
      render_quality: "high",
      render_tone_mapping: "agx",
    });
  });

  it("joins back to the shortest form and keeps YAML-only keys", () => {
    const d = {
      render: "model",
      render_quality: "auto",
      render_tone_mapping: "auto",
    };
    expect(mod.joinRender(d, undefined)).toBeUndefined();
    expect(
      mod.joinRender({ ...d, render_quality: "standard" }, undefined),
    ).toEqual({ quality: "standard" });
    expect(mod.joinRender({ ...d, render: "default" }, undefined)).toBe(
      "default",
    );
    expect(mod.joinRender({ ...d, render_quality: "still" }, "model")).toEqual({
      quality: "still",
    });
    expect(
      mod.joinRender(
        { ...d, render: "default", render_tone_mapping: "aces" },
        undefined,
      ),
    ).toEqual({ recipe: "default", tone_mapping: "aces" });
    const materials = { "name:Window*": "glass" };
    expect(
      mod.joinRender(
        { ...d, render_quality: "standard" },
        { quality: "high", materials },
      ),
    ).toEqual({ materials, quality: "standard" });
    expect(mod.joinRender(d, { quality: "standard", materials })).toEqual({
      materials,
    });
  });

  it("round-trips through the form", () => {
    const el = document.createElement("floorplan3d-card-editor");
    document.body.append(el);
    el.setConfig({
      type: "custom:floorplan3d-card",
      render: { quality: "standard" },
    });
    const form = el.querySelector("ha-form");
    expect(form.data).toMatchObject({
      render: "model",
      render_quality: "standard",
      render_tone_mapping: "auto",
    });
    expect(
      form.schema
        .flatMap((x) => x.schema || [x])
        .find((x) => x.name === "render_quality")
        .selector.select.options.map((o) => o.value),
    ).toEqual(["auto", "high", "standard", "still"]);
    let got;
    el.addEventListener("config-changed", (e) => {
      got = e.detail.config;
    });
    form.dispatchEvent(
      new CustomEvent("value-changed", {
        detail: { value: { ...form.data, render_tone_mapping: "neutral" } },
      }),
    );
    expect(got).toEqual({
      type: "custom:floorplan3d-card",
      render: { quality: "standard", tone_mapping: "neutral" },
    });
    form.dispatchEvent(
      new CustomEvent("value-changed", {
        detail: {
          value: {
            ...form.data,
            render_quality: "auto",
            render_tone_mapping: "auto",
          },
        },
      }),
    );
    expect(got).toEqual({ type: "custom:floorplan3d-card" });
  });
});
