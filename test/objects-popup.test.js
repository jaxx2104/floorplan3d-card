import { describe, it, expect } from "bun:test";
import {
  popupRows,
  actionTarget,
  rowsKey,
  tileFeatures,
  tileConfig,
} from "../src/objects/popup.ts";
import { resolveActions } from "../src/actions.ts";
import { typeOf } from "../src/objects/types.ts";
import { chainState } from "../src/objects/logic.ts";
import { st } from "./helpers/hass.js";

const kinds = (rows) => rows.map((r) => r.kind);
const types = (row) => row.features.map((f) => f.type);
const rowsOf = (obj, entity, states, groups = {}, popup = null, source) =>
  popupRows(
    obj,
    chainState(obj, { entity }, groups, states),
    states,
    groups,
    popup,
    source,
  );

describe("popupRows", () => {
  it("light defaults (exact list toggle, brightness, color): one tile with the brightness feature", () => {
    const states = {
      "light.a": st("on", {
        brightness: 128,
        supported_color_modes: ["hs", "color_temp"],
        friendly_name: "Lamp A",
      }),
    };
    const rows = rowsOf({ id: "l1", type: "light" }, "light.a", states);
    expect(kinds(rows)).toEqual(["tile"]);
    expect(rows[0]).toMatchObject({
      entity: "light.a",
      label: "Lamp A",
      value: true,
    });
    expect(types(rows[0])).toEqual(["light-brightness"]); // colour: the tile's more-info
  });

  it("no brightness feature on a relay or an on / off light", () => {
    const states = {
      "light.o": st("on", { supported_color_modes: ["onoff"] }),
      "switch.r": st("on"),
    };
    const obj = { id: "l1", type: "light" };
    expect(types(rowsOf(obj, "light.o", states)[0])).toEqual([]);
    const rows = rowsOf(obj, "switch.r", states);
    expect(kinds(rows)).toEqual(["tile"]);
    expect(rows[0]).toMatchObject({ entity: "switch.r", features: [] });
  });

  it("generic default [state]: the entity's tile", () => {
    const states = { "sensor.t": st("21.5", { unit_of_measurement: "°C" }) };
    const rows = rowsOf({ id: "x", type: "something" }, "sensor.t", states);
    expect(rows).toEqual([
      {
        kind: "tile",
        entity: "sensor.t",
        label: "sensor.t",
        value: false,
        features: [],
      },
    ]);
  });

  it("fp.ui.popup overrides the type default; value rows, unknown kinds dropped", () => {
    const states = {
      "light.a": st("on", { brightness: 255, supported_color_modes: ["rgb"] }),
      "sensor.p": st("5", { unit_of_measurement: "W" }),
    };
    const obj = {
      id: "l1",
      type: "light",
      ui: { popup: ["power", "bogus", "brightness"] },
    };
    expect(kinds(rowsOf(obj, "light.a", states))).toEqual(["tile"]);
    const p = { id: "p", type: "x", ui: { popup: ["power"] } };
    expect(rowsOf(p, "sensor.p", states)).toEqual([
      { kind: "power", entity: "sensor.p", label: "Power", value: "5 W" },
    ]);
  });

  it("link rows (history / logbook / statistics / custom) at the bottom; a resolved list wins over fp.ui", () => {
    const states = { "sensor.t": st("21", {}) };
    const obj = { id: "x", type: "something", ui: { popup: ["state"] } };
    const chain = chainState(obj, { entity: "sensor.t" }, {}, states);
    const rows = popupRows(obj, chain, states, {}, [
      "history",
      "state",
      { label: "Plan", navigate: "/lovelace/plan" },
    ]);
    expect(kinds(rows)).toEqual(["tile", "link", "link"]);
    expect(rows[1]).toMatchObject({
      label: "History",
      action: {
        action: "navigate",
        navigation_path: "/history?entity_id=sensor.t",
      },
    });
    expect(rows[2].label).toBe("Plan");
    // unavailable: the state row and the links
    const un = popupRows(obj, chain, { "sensor.t": st("unavailable") }, {}, [
      "state",
      "logbook",
    ]);
    expect(kinds(un)).toEqual(["state", "link"]);
  });

  it("grouped fixture: one chain tile per controller and a reason row when dark", () => {
    const states = {
      "light.a": st("on", {
        brightness: 200,
        supported_color_modes: ["brightness"],
      }),
      "switch.g": st("off", { friendly_name: "Group switch" }),
    };
    const groups = { hall: { entity: "switch.g" } };
    const obj = { id: "l1", type: "light", group: "hall" };
    const rows = rowsOf(obj, "light.a", states, groups);
    expect(kinds(rows)).toEqual(["tile", "chain", "reason"]);
    expect(rows[0].entity).toBe("light.a");
    expect(rows[1]).toMatchObject({
      entity: "switch.g",
      label: "Group switch",
      value: false,
      features: [],
    });
    expect(rows[2].label).toBe("Group switch is off");
  });

  it("grouped fixture: the group label names the chain tile and the reason", () => {
    const states = {
      "light.a": st("on", { supported_color_modes: ["onoff"] }),
      "switch.g": st("off", { friendly_name: "Group switch" }),
    };
    const groups = { hall: { entity: "switch.g", label: "Hall circuit" } };
    const rows = rowsOf(
      { id: "l1", type: "light", group: "hall" },
      "light.a",
      states,
      groups,
    );
    const chain = rows.find((r) => r.kind === "chain");
    expect(chain.label).toBe("Hall circuit");
    expect(tileConfig(chain)).toMatchObject({
      type: "tile",
      entity: "switch.g",
      name: "Hall circuit",
    });
    expect(rows.find((r) => r.kind === "reason").label).toBe(
      "Hall circuit is off",
    );
  });

  it("fixture without own entity: the tile is the controller's, no duplicate chain row", () => {
    const states = { "switch.g": st("off") };
    const groups = { hall: { entity: "switch.g" } };
    const obj = { id: "l1", type: "light", group: "hall" };
    const rows = popupRows(
      obj,
      chainState(obj, { entity: null }, groups, states),
      states,
      groups,
    );
    expect(kinds(rows)).toEqual(["tile", "reason"]);
    expect(rows[0].entity).toBe("switch.g");
  });

  it('unavailable or missing entity: single state row "unavailable"', () => {
    const states = { "light.a": st("unavailable") };
    const obj = { id: "l1", type: "light" };
    const one = [{ kind: "state", label: "State", value: "unavailable" }];
    expect(rowsOf(obj, "light.a", states)).toEqual(one);
    expect(
      popupRows(obj, chainState(obj, { entity: null }, {}, {}), {}),
    ).toEqual(one);
    expect(popupRows(obj, null, {})).toEqual(one);
  });

  it("grouped fixture with an unavailable own entity: controller tile and reason stay", () => {
    const groups = { hall: { entity: "switch.g" } };
    const obj = { id: "l1", type: "light", group: "hall" };
    let states = {
      "light.a": st("unavailable", { friendly_name: "Bulb" }),
      "switch.g": st("off", { friendly_name: "Relay" }),
    };
    const chainRow = (value) => ({
      kind: "chain",
      entity: "switch.g",
      label: "Relay",
      value,
      features: [],
    });
    expect(rowsOf(obj, "light.a", states, groups)).toEqual([
      chainRow(false),
      { kind: "reason", label: "Relay is off" },
    ]);
    states = { ...states, "switch.g": st("on", { friendly_name: "Relay" }) };
    expect(rowsOf(obj, "light.a", states, groups)).toEqual([
      chainRow(true),
      { kind: "reason", label: "Bulb is unavailable" },
    ]);
  });

  it("nothing in the chain usable: single unavailable row", () => {
    const groups = { hall: { entity: "switch.g" } };
    const obj = { id: "l1", type: "light", group: "hall" };
    const states = { "light.a": st("unavailable"), "switch.g": st("unknown") };
    expect(rowsOf(obj, "light.a", states, groups)).toEqual([
      { kind: "state", label: "State", value: "unavailable" },
    ]);
  });

  it("mower: a tile with start-pause / dock, then the battery", () => {
    const states = { "lawn_mower.m": st("docked", { battery_level: 87 }) };
    const rows = rowsOf({ id: "m", type: "mower" }, "lawn_mower.m", states);
    expect(kinds(rows)).toEqual(["tile", "battery"]);
    expect(rows[0].features).toEqual([
      { type: "lawn-mower-commands", commands: ["start_pause", "dock"] },
    ]);
    expect(rows[1].value).toBe("87 %");
  });

  it("a vacuum standing in for the mower gets vacuum commands", () => {
    const states = { "vacuum.v": st("docked", { battery_level: 100 }) };
    const rows = rowsOf({ id: "v", type: "mower" }, "vacuum.v", states);
    expect(types(rows[0])).toEqual(["vacuum-commands"]);
  });

  it("climate (automatic): tile with HVAC modes and target temperature, then temperature and mode", () => {
    const states = {
      "climate.c": st("heat", {
        current_temperature: 20.5,
        temperature_unit: "°C",
        hvac_modes: ["off", "heat"],
        supported_features: 1,
      }),
    };
    const rows = rowsOf(
      { id: "c", type: "climate" },
      "climate.c",
      states,
      {},
      null,
      "type",
    );
    expect(kinds(rows)).toEqual(["tile", "temperature", "mode"]);
    expect(rows[0].features).toEqual([
      { type: "climate-hvac-modes", hvac_modes: ["off", "heat"] },
      { type: "target-temperature" },
    ]);
    expect(rows[1].value).toBe("20.5 °C");
    expect(rows[2].value).toBe("heat");
  });

  it("climate with an exact list: value rows only", () => {
    const states = {
      "climate.c": st("heat", {
        current_temperature: 20.5,
        temperature_unit: "°C",
      }),
    };
    expect(
      kinds(rowsOf({ id: "c", type: "climate" }, "climate.c", states)),
    ).toEqual(["temperature", "mode"]);
  });
});

describe("object actions / actionTarget", () => {
  const act = (obj, which) =>
    resolveActions({
      modelUi: obj.ui,
      kind: "object",
      id: "x",
      typeDefaults: typeOf(obj.type).defaults,
    })[which].action;
  it("type defaults and fp.ui overrides (legacy keys), invalid falls back", () => {
    expect(act({ type: "light" }, "tap")).toBe("toggle");
    expect(act({ type: "light" }, "hold")).toBe("popup");
    expect(act({ type: "zzz" }, "tap")).toBe("more-info");
    expect(act({ type: "light", ui: { tap: "none" } }, "tap")).toBe("none");
    expect(act({ type: "light", ui: { hold: "bogus" } }, "hold")).toBe("popup");
    expect(
      act(
        { type: "light", ui: { tap_action: { action: "more-info" } } },
        "tap",
      ),
    ).toBe("more-info");
  });

  it("own entity first, else the group controller", () => {
    const groups = { g: { entity: "switch.g" } };
    expect(actionTarget({ group: "g" }, { entity: "light.a" }, groups)).toBe(
      "light.a",
    );
    expect(actionTarget({ group: "g" }, { entity: null }, groups)).toBe(
      "switch.g",
    );
    expect(actionTarget({}, null, groups)).toBe(null);
    expect(
      actionTarget({ group: "g" }, { entity: "light.a", hidden: true }, groups),
    ).toBe(null);
  });

  it("unavailable own entity falls back to a usable group controller", () => {
    const groups = { g: { entity: "switch.g" } };
    const states = { "light.a": st("unavailable"), "switch.g": st("off") };
    expect(
      actionTarget({ group: "g" }, { entity: "light.a" }, groups, states),
    ).toBe("switch.g");
    expect(
      actionTarget({ group: "g" }, { entity: "light.a" }, groups, {
        ...states,
        "light.a": st("on"),
      }),
    ).toBe("light.a");
    // controller not usable either: the own entity (the caller shows the popup)
    expect(
      actionTarget({ group: "g" }, { entity: "light.a" }, groups, {
        ...states,
        "switch.g": st("unknown"),
      }),
    ).toBe("light.a");
    expect(actionTarget({}, { entity: "light.a" }, {}, states)).toBe("light.a");
  });
});

describe("tileFeatures / automatic tiles", () => {
  const full = {
    supported_color_modes: ["hs", "color_temp"],
    color_mode: "hs",
    brightness: 200,
    effect_list: ["Rainbow"],
  };
  const rowsFor = (attrs, popup, source) =>
    rowsOf(
      { id: "l1", type: "light" },
      "light.a",
      { "light.a": st("on", attrs) },
      {},
      popup,
      source,
    );

  it("a model / type list [toggle] gets every light feature", () => {
    for (const src of ["model", "type"])
      expect(types(rowsFor(full, ["toggle"], src)[0])).toEqual([
        "light-brightness",
        "light-color-temp",
      ]);
  });

  it("a layout or YAML list is respected exactly; without a source too", () => {
    expect(types(rowsFor(full, ["toggle"], "layout")[0])).toEqual([]);
    expect(types(rowsFor(full, ["toggle"], "yaml")[0])).toEqual([]);
    expect(types(rowsFor(full, ["toggle"])[0])).toEqual([]);
    expect(types(rowsFor(full, ["color_temp"], "layout")[0])).toEqual([
      "light-color-temp",
    ]);
    // no tile item listed: no tile
    expect(kinds(rowsFor(full, ["history"], "layout"))).toEqual(["link"]);
  });

  it("only what the light supports", () => {
    const one = (modes) =>
      types(rowsFor({ supported_color_modes: modes }, ["toggle"], "model")[0]);
    expect(one(["onoff"])).toEqual([]);
    expect(one(["color_temp"])).toEqual([
      "light-brightness",
      "light-color-temp",
    ]);
  });

  it("other domains from supported_features", () => {
    const f = (e, state, attrs) =>
      tileFeatures(e, st(state, attrs)).map((x) => x.type);
    expect(f("cover.c", "open", { supported_features: 15 })).toEqual([
      "cover-open-close",
      "cover-position",
    ]);
    expect(f("cover.c", "open", { supported_features: 3 })).toEqual([
      "cover-open-close",
    ]);
    expect(f("fan.f", "on", { supported_features: 1 })).toEqual(["fan-speed"]);
    expect(f("fan.f", "on", {})).toEqual([]);
    expect(f("lock.l", "locked", {})).toEqual(["lock-commands"]);
    expect(f("media_player.m", "playing", { supported_features: 4 })).toEqual([
      "media-player-volume-slider",
    ]);
    expect(f("switch.s", "on", {})).toEqual([]);
    expect(
      tileFeatures("cover.c", st("open", {}), new Set(["toggle"])),
    ).toEqual([]);
    expect(tileFeatures("light.a", null)).toEqual([]);
  });

  it("rowsKey changes with the row set, the features and chain labels", () => {
    const a = rowsKey(rowsFor(full, ["toggle"], "model"));
    expect(rowsKey(rowsFor(full, ["toggle"], "layout"))).not.toBe(a);
    expect(
      rowsKey(
        rowsFor({ supported_color_modes: ["brightness"] }, ["toggle"], "model"),
      ),
    ).not.toBe(a);
    const chain = (label) => [
      { kind: "chain", entity: "switch.g", label, value: true, features: [] },
    ];
    expect(rowsKey(chain("A"))).not.toBe(rowsKey(chain("B")));
  });

  it("tileConfig: features at the bottom; the object's own tile keeps HA's name", () => {
    const row = rowsFor(full, ["toggle"], "model")[0];
    expect(tileConfig(row)).toEqual({
      type: "tile",
      entity: "light.a",
      features: [{ type: "light-brightness" }, { type: "light-color-temp" }],
      features_position: "bottom",
      vertical: false,
    });
  });
});
