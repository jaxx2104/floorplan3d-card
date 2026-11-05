// @vitest-environment happy-dom
import { describe, it, expect } from "bun:test";
import { ObjectPopup } from "../src/objects/popup.ts";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("object popup DOM", () => {
  it("rows that change their labels are rebuilt", () => {
    const root = document.createElement("div");
    document.body.append(root);
    let extra = [
      { label: "Rain", value: "Dry" },
      { label: "Wifi", value: "-61 dBm" },
    ];
    const states = {
      "sensor.x": { entity_id: "sensor.x", state: "5", attributes: {} },
    };
    const p = new ObjectPopup(root, {
      resolve: () => ({
        obj: { id: "o", type: "other", label: "O", ui: { popup: ["state"] } },
        chain: { entities: ["sensor.x"], lit: false },
        states,
        groups: {},
        extra,
        hass: { states },
      }),
    });
    p.open({ id: "o", label: "O" }, null);
    const rows = () =>
      [...root.querySelectorAll(".fp-pop-row")].map((r) =>
        r.textContent.replace(/\s+/g, "").trim(),
      );
    expect(rows()).toEqual(["sensor.x5", "RainDry", "Wifi-61dBm"]); // fallback tile: name and state
    extra = [
      { label: "Offline", value: "since 3 min" },
      { label: "Rain", value: "Dry" },
    ];
    p.update();
    expect(rows().slice(-2)).toEqual(["Offlinesince3min", "RainDry"]);
    p.close();
  });

  it("without HA's card helpers: a switch (toggle) and the name (more-info)", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const links = [];
    const states = {
      "light.a": { entity_id: "light.a", state: "on", attributes: {} },
    };
    const p = new ObjectPopup(root, {
      onLink: (a) => links.push(a),
      resolve: () => ({
        obj: { id: "o", type: "light" },
        chain: { entities: ["light.a"], lit: true },
        states,
        hass: { states },
      }),
    });
    p.open({ id: "o" }, null);
    const sw = root.querySelector(".fp-pop-row.tile .fp-switch");
    expect(sw.classList.contains("on")).toBe(true);
    sw.click();
    root.querySelector(".fp-pop-row.tile .fp-pop-name").click();
    expect(links).toEqual([
      { action: "toggle", entity: "light.a" },
      { action: "more-info", entity: "light.a" },
    ]);
    p.close();
  });

  it("with HA's card helpers: a tile card per row, hass forwarded on updates", async () => {
    const configs = [];
    window.loadCardHelpers = async () => ({
      createCardElement: (config) => {
        configs.push(config);
        const el = document.createElement("div");
        el.className = "stub-tile";
        return el;
      },
    });
    const root = document.createElement("div");
    document.body.append(root);
    let hass = { states: {} };
    const states = {
      "light.a": {
        entity_id: "light.a",
        state: "on",
        attributes: { supported_color_modes: ["brightness"] },
      },
      "switch.g": { entity_id: "switch.g", state: "on", attributes: {} },
    };
    hass.states = states;
    const p = new ObjectPopup(root, {
      resolve: () => ({
        obj: { id: "o", type: "light", group: "g" },
        chain: {
          entities: ["light.a", "switch.g"],
          controllers: [{ tag: "g", entity: "switch.g" }],
          lit: true,
        },
        states,
        groups: { g: { entity: "switch.g", label: "Circuit" } },
        hass,
      }),
    });
    p.open({ id: "o" }, null);
    await flush();
    await flush();
    const tiles = [...root.querySelectorAll(".fp-pop-row.ha .stub-tile")];
    expect(tiles.length).toBe(2);
    expect(configs.map((c) => [c.entity, c.name, c.features])).toEqual([
      ["light.a", undefined, [{ type: "light-brightness" }]],
      ["switch.g", "Circuit", []],
    ]);
    expect(tiles[0].hass).toBe(hass);
    hass = { states };
    p.update();
    expect(tiles.every((t) => t.hass === hass)).toBe(true);
    p.close();
    delete window.loadCardHelpers;
  });
});
