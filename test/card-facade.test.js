// @vitest-environment happy-dom
// The card element as a facade over its parts: delegated members keep their names and identities.
import { describe, it, expect, vi } from "bun:test";
import "../src/card-impl.ts";
import { defineDelegates } from "../src/card/delegates.ts";
import { ActionRunner } from "../src/card/action-runner.ts";

describe("setConfig", () => {
  it("the layout is the YAML's layout:, replaced with each config", () => {
    const c = document.createElement("floorplan3d-card-impl");
    c.setConfig({});
    expect(c._layout.hidden).toEqual([]);
    c.setConfig({ layout: { hidden: ["device:a"] } });
    expect(c._layout.hidden).toEqual(["device:a"]);
    c.setConfig({ layout: { hidden: ["device:b"] } });
    expect(c._layout.hidden).toEqual(["device:b"]);
  });
});

describe("defineDelegates", () => {
  it("forwards methods with their arguments and this of the part", () => {
    class Part {
      constructor() {
        this.k = 2;
      }
      twice(x) {
        return x * this.k;
      }
    }
    class Host {
      constructor() {
        this.part = new Part();
      }
    }
    defineDelegates(Host.prototype, "part", { methods: ["twice"] });
    expect(new Host().twice(21)).toBe(42);
  });
  it("fields read and write the part, the same object comes back", () => {
    class Host {
      constructor() {
        this.part = { m: new Map() };
      }
    }
    defineDelegates(Host.prototype, "part", { fields: ["m"] });
    const h = new Host();
    expect(h.m).toBe(h.part.m);
    const n = new Map();
    h.m = n;
    expect(h.part.m).toBe(n);
    expect(Object.keys(h)).toEqual(["part"]); // no own copy on the host
  });
  it("refuses a name the prototype already has", () => {
    class Host {
      own() {}
    }
    expect(() =>
      defineDelegates(Host.prototype, "part", { methods: ["own"] }),
    ).toThrow(/own/);
  });
});

describe("Floorplan3dCard facade", () => {
  const card = () => document.createElement("floorplan3d-card-impl");
  it("keeps the members the headless checks use", () => {
    const c = card();
    for (const name of [
      "_refreshMower",
      "_updateMowerWarning",
      "_warningText",
      "_dockGroup",
      "mapInfo",
      "mapZone",
      "mowerStatus",
      "mowerStatusText",
      "mowerHeading",
      "mowerAuto",
      "_mowerFloor",
      "_mapRefreshSec",
      "_loadModel",
      "_modelFresh",
      "modelBindings",
      "_modelAlign",
      "_setMode",
      "_setView",
      "_setFloor",
      "setSection",
      "saveViewPatch",
      "currentView",
      "viewIndex",
      "leaveSection",
      "sectionPlaneNow",
      "previewSection",
      "_stateFor",
      "_resetCamera",
      "_applyMarkerSelection",
      "badgeOpts",
      "_refreshAttached",
      "_buildMarkers",
      "_refreshStates",
      "_objectHit",
      "_runObjectAction",
      "_openObjectPopup",
      "_syncHints",
      "objectLabel",
      "testObject",
      "setSunTime",
      "longTasks",
    ]) {
      expect(typeof c[name], name).toBe("function");
    }
  });
});

describe("ActionRunner", () => {
  const host = (hass = {}) => ({
    _hass: hass,
    dispatchEvent: vi.fn(),
    _openObjectPopup: vi.fn(),
  });
  const fired = (h) => h.dispatchEvent.mock.calls.map((c) => c[0]);
  it("an action goes to HA as hass-action (bubbles, composed)", () => {
    const h = host();
    const a = { action: "toggle", confirmation: true };
    new ActionRunner(h)._runAction(a, { entity: "light.x" });
    const [ev] = fired(h);
    expect(ev.type).toBe("hass-action");
    expect(ev.detail).toEqual({
      config: { entity: "light.x", tap_action: a },
      action: "tap",
    });
    expect(ev.bubbles && ev.composed).toBe(true);
  });
  it("a missing field is an HA toast, no action", () => {
    const h = host();
    new ActionRunner(h)._runAction(
      { action: "perform-action", perform_action: "turn_on" },
      {},
    );
    const evs = fired(h);
    expect(evs.map((e) => e.type)).toEqual(["hass-notification"]);
    expect(evs[0].detail.message).toMatch(/domain\.action/);
  });
  it("popup opens the object's popup, else more-info; none does nothing", () => {
    const h = host();
    const r = new ActionRunner(h);
    r._runAction({ action: "popup" }, { entity: "light.x", objectId: "o1" });
    expect(h._openObjectPopup).toHaveBeenCalledWith("o1");
    r._runAction("popup", { entity: "light.x" });
    r._runAction("none", { entity: "light.x" });
    const evs = fired(h);
    expect(evs.length).toBe(1);
    expect(evs[0].detail.config).toEqual({
      entity: "light.x",
      tap_action: { action: "more-info" },
    });
  });
});
