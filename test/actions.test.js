import { describe, it, expect, vi, afterEach } from "bun:test";
import {
  normAction,
  resolveActions,
  hassActionDetail,
  validateAction,
  popupLinks,
  TapSequencer,
  DOUBLE_TAP_MS,
} from "../src/actions.ts";

const light = {
  tap_action: { action: "toggle" },
  hold_action: { action: "popup" },
  popup: ["toggle"],
};

describe("normAction", () => {
  it("accepts objects, strings and the legacy call-service", () => {
    expect(normAction({ action: "toggle" })).toEqual({ action: "toggle" });
    expect(normAction("more-info")).toEqual({ action: "more-info" });
    expect(
      normAction({
        action: "call-service",
        service: "light.turn_on",
        service_data: { brightness: 3 },
      }),
    ).toEqual({
      action: "perform-action",
      perform_action: "light.turn_on",
      data: { brightness: 3 },
    });
    expect(normAction({ action: "bogus" })).toBe(null);
    expect(normAction(null)).toBe(null);
    expect(normAction(42)).toBe(null);
  });
});

describe("resolveActions", () => {
  it("type defaults when nothing is set; no double tap", () => {
    const r = resolveActions({
      kind: "object",
      id: "lamp",
      typeDefaults: light,
    });
    expect(r.tap).toEqual({ action: "toggle" });
    expect(r.hold).toEqual({ action: "popup" });
    expect(r.double_tap).toBe(null);
    expect(r.popup).toEqual(["toggle"]);
  });

  it("merge order: model < layout < YAML", () => {
    const modelUi = {
      tap_action: { action: "none" },
      hold_action: { action: "more-info" },
      double_tap_action: { action: "popup" },
    };
    const layoutUi = {
      tap_action: { action: "navigate", navigation_path: "/a" },
      hold_action: { action: "toggle" },
    };
    const yaml = {
      "object:lamp": { tap_action: { action: "url", url_path: "https://x" } },
    };
    const r = resolveActions({
      modelUi,
      layoutUi,
      yaml,
      kind: "object",
      id: "lamp",
      typeDefaults: light,
    });
    expect(r.tap).toEqual({ action: "url", url_path: "https://x" });
    expect(r.hold).toEqual({ action: "toggle" });
    expect(r.double_tap).toEqual({ action: "popup" });
  });

  it("legacy fp.ui tap / hold keys (string and object)", () => {
    const r = resolveActions({
      modelUi: { tap: "none", hold: { action: "more-info" } },
      kind: "object",
      id: "x",
      typeDefaults: light,
    });
    expect(r.tap).toEqual({ action: "none" });
    expect(r.hold).toEqual({ action: "more-info" });
    // invalid legacy value: the default stays
    expect(
      resolveActions({
        modelUi: { hold: "bogus" },
        kind: "object",
        id: "x",
        typeDefaults: light,
      }).hold,
    ).toEqual({ action: "popup" });
  });

  it("legacy type defaults ({ tap, hold } strings) still read", () => {
    const r = resolveActions({
      kind: "object",
      id: "x",
      typeDefaults: { tap: "more-info", hold: "popup" },
    });
    expect(r.tap).toEqual({ action: "more-info" });
    expect(r.hold).toEqual({ action: "popup" });
  });

  it("YAML keys: device < entity < object for objects; device / entity for markers", () => {
    const yaml = {
      "device:d1": {
        tap_action: { action: "none" },
        hold_action: { action: "none" },
      },
      "light.a": { tap_action: { action: "more-info" } },
      "object:lamp": { tap_action: { action: "popup" } },
    };
    const o = resolveActions({
      yaml,
      kind: "object",
      id: "lamp",
      entityId: "light.a",
      deviceId: "d1",
      typeDefaults: light,
    });
    expect(o.tap).toEqual({ action: "popup" });
    expect(o.hold).toEqual({ action: "none" });
    const m = resolveActions({
      yaml,
      kind: "marker",
      id: "device:d1",
      entityId: "light.a",
      deviceId: "d1",
      typeDefaults: light,
    });
    expect(m.tap).toEqual({ action: "more-info" });
    expect(m.hold).toEqual({ action: "none" });
    // object:<id> keys never apply to markers
    const m2 = resolveActions({
      yaml: { "object:lamp": { tap_action: { action: "none" } } },
      kind: "marker",
      id: "lamp",
      entityId: "light.b",
      typeDefaults: light,
    });
    expect(m2.tap).toEqual({ action: "toggle" });
  });

  it("popup list: later source replaces", () => {
    const r = resolveActions({
      modelUi: { popup: ["state"] },
      yaml: { "object:x": { popup: ["history"] } },
      kind: "object",
      id: "x",
      typeDefaults: light,
    });
    expect(r.popup).toEqual(["history"]);
  });

  it("popupSource: where the popup list came from", () => {
    const base = { kind: "object", id: "x" };
    expect(resolveActions({ ...base, typeDefaults: light }).popupSource).toBe(
      "type",
    );
    expect(resolveActions({ ...base }).popupSource).toBe("type");
    expect(
      resolveActions({
        ...base,
        typeDefaults: light,
        modelUi: { popup: ["toggle"] },
      }).popupSource,
    ).toBe("model");
    expect(
      resolveActions({
        ...base,
        typeDefaults: light,
        modelUi: { popup: ["toggle"] },
        layoutUi: { popup: ["toggle"] },
      }).popupSource,
    ).toBe("layout");
    expect(
      resolveActions({
        ...base,
        typeDefaults: light,
        layoutUi: { popup: ["toggle"] },
        yaml: { "object:x": { popup: ["state"] } },
      }).popupSource,
    ).toBe("yaml");
    // a layout ui without a popup list leaves the model's source
    expect(
      resolveActions({
        ...base,
        typeDefaults: light,
        modelUi: { popup: ["toggle"] },
        layoutUi: { tap_action: "none" },
      }).popupSource,
    ).toBe("model");
  });

  it("a double_tap_action none means no double tap", () => {
    const r = resolveActions({
      layoutUi: { double_tap_action: { action: "none" } },
      kind: "object",
      id: "x",
      typeDefaults: light,
    });
    expect(r.double_tap).toBe(null);
  });
});

describe("validateAction", () => {
  it("navigate / url / perform-action need their field", () => {
    expect(validateAction({ action: "navigate" })).toMatch(/navigation_path/);
    expect(
      validateAction({ action: "navigate", navigation_path: "/lovelace/2" }),
    ).toBe(null);
    expect(validateAction({ action: "url" })).toMatch(/url_path/);
    expect(validateAction({ action: "perform-action" })).toMatch(
      /perform_action/,
    );
    expect(
      validateAction({ action: "perform-action", perform_action: "nodot" }),
    ).toMatch(/domain\.action/);
    expect(
      validateAction({
        action: "perform-action",
        perform_action: "light.turn_on",
      }),
    ).toBe(null);
    expect(validateAction({ action: "toggle" })).toBe(null);
    expect(validateAction(null)).toBe(null);
  });

  it("legacy call-service is checked after normAction", () => {
    expect(
      validateAction(
        normAction({ action: "call-service", service: "script.good_night" }),
      ),
    ).toBe(null);
  });

  it("url: only http(s) or a local path", () => {
    expect(validateAction({ action: "url", url_path: "http://x" })).toBe(null);
    expect(validateAction({ action: "url", url_path: "/local/x.html" })).toBe(
      null,
    );
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      " JavaScript:x",
      "ftp://x",
      "//evil.example",
    ]) {
      expect(validateAction({ action: "url", url_path: bad })).toMatch(
        /url_path/,
      );
    }
  });
});

describe("hassActionDetail", () => {
  it("the action as tap_action, the target as config.entity", () => {
    const a = { action: "toggle", confirmation: { text: "Sure?" } };
    expect(hassActionDetail(a, "light.a")).toEqual({
      config: { entity: "light.a", tap_action: a },
      action: "tap",
    });
  });
  it("the action's own entity wins (HA toggles config.entity)", () => {
    expect(
      hassActionDetail({ action: "toggle", entity: "switch.b" }, "light.a")
        .config.entity,
    ).toBe("switch.b");
  });
  it("no entity: no config.entity (navigate, perform-action, assist)", () => {
    expect(
      hassActionDetail({ action: "navigate", navigation_path: "/x" }, null)
        .config,
    ).toEqual({ tap_action: { action: "navigate", navigation_path: "/x" } });
  });
});

describe("popupLinks", () => {
  it("history, logbook, statistics and custom rows", () => {
    const rows = popupLinks(
      [
        "state",
        "history",
        "logbook",
        "statistics",
        { label: "Plan", navigate: "/lovelace/plan" },
        { label: "Docs", url: "https://x" },
        { label: "bad" },
      ],
      "light.a",
    );
    expect(rows).toEqual([
      {
        kind: "link",
        label: "History",
        action: {
          action: "navigate",
          navigation_path: "/history?entity_id=light.a",
        },
      },
      {
        kind: "link",
        label: "Logbook",
        action: {
          action: "navigate",
          navigation_path: "/logbook?entity_id=light.a",
        },
      },
      {
        kind: "link",
        label: "Statistics",
        action: { action: "more-info", entity: "light.a" },
      },
      {
        kind: "link",
        label: "Plan",
        action: { action: "navigate", navigation_path: "/lovelace/plan" },
      },
      {
        kind: "link",
        label: "Docs",
        action: { action: "url", url_path: "https://x" },
      },
    ]);
  });

  it("entity links need an entity; ids are URL-encoded", () => {
    expect(popupLinks(["history", "statistics"], null)).toEqual([]);
    expect(
      popupLinks(["history"], "sensor.a b")[0].action.navigation_path,
    ).toBe("/history?entity_id=sensor.a%20b");
  });
});

describe("TapSequencer", () => {
  afterEach(() => vi.useRealTimers());

  it("no double tap action: single tap runs at once", () => {
    vi.useFakeTimers();
    const s = new TapSequencer();
    const single = vi.fn();
    s.tap("a", false, single, vi.fn());
    expect(single).toHaveBeenCalledTimes(1);
  });

  it("with a double tap action: single waits 250 ms; two taps within it -> double only", () => {
    vi.useFakeTimers();
    const s = new TapSequencer();
    const single = vi.fn(),
      dbl = vi.fn();
    s.tap("a", true, single, dbl);
    vi.advanceTimersByTime(DOUBLE_TAP_MS - 1);
    expect(single).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(single).toHaveBeenCalledTimes(1);
    s.tap("a", true, single, dbl);
    vi.advanceTimersByTime(100);
    s.tap("a", true, single, dbl);
    expect(dbl).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(single).toHaveBeenCalledTimes(1);
  });

  it("a pending double-tap target never delays taps elsewhere", () => {
    vi.useFakeTimers();
    const s = new TapSequencer();
    const singleA = vi.fn(),
      singleB = vi.fn();
    s.tap("a", true, singleA, vi.fn());
    s.tap("b", false, singleB, vi.fn());
    expect(singleB).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    expect(singleA).toHaveBeenCalledTimes(1);
  });

  it("cancel drops pending taps", () => {
    vi.useFakeTimers();
    const s = new TapSequencer();
    const single = vi.fn();
    s.tap("a", true, single, vi.fn());
    s.cancel();
    vi.advanceTimersByTime(1000);
    expect(single).not.toHaveBeenCalled();
  });
});
