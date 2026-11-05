// @vitest-environment happy-dom
// The card element as a facade over its parts: delegated members keep their names and identities.
import { describe, it, expect, vi, afterEach } from "bun:test";
import "../src/card-impl.ts";
import { defineDelegates } from "../src/card/delegates.ts";
import { ActionRunner } from "../src/card/action-runner.ts";

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
  it("keeps the members edit mode and the headless checks use", () => {
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
      "_objectTapsOn",
      "_syncHints",
      "objectLabel",
      "testObject",
      "setSunTime",
      "_commit",
      "longTasks",
    ]) {
      expect(typeof c[name], name).toBe("function");
    }
  });
});

describe("ActionRunner", () => {
  afterEach(() => vi.useRealTimers());
  const host = (hass) => {
    const stage = document.createElement("div");
    const toastEl = document.createElement("div");
    toastEl.hidden = true;
    return {
      _hass: hass,
      _stage: stage,
      _toastEl: toastEl,
      dispatchEvent: vi.fn(),
      _openObjectPopup: vi.fn(),
    };
  };
  it("a failing service call shows a toast for 4 s", async () => {
    vi.useFakeTimers();
    const h = host({
      callService: () => Promise.reject(new Error("Service not found")),
    });
    const a = new ActionRunner(h);
    a._callService("light", "toggle", { entity_id: "light.x" });
    await Promise.resolve();
    await Promise.resolve();
    expect(h._toastEl.hidden).toBe(false);
    expect(h._toastEl.textContent).toBe("Service not found");
    vi.advanceTimersByTime(4000);
    expect(h._toastEl.hidden).toBe(true);
  });
  it("more-info fires hass-more-info on the card", () => {
    const h = host({});
    new ActionRunner(h)._moreInfo("light.x");
    const ev = h.dispatchEvent.mock.calls[0][0];
    expect(ev.type).toBe("hass-more-info");
    expect(ev.detail).toEqual({ entityId: "light.x" });
    expect(ev.bubbles && ev.composed).toBe(true);
  });
  it("the confirmation runs on OK only; dispose() drops it", () => {
    const h = host({});
    const a = new ActionRunner(h);
    const ok = vi.fn();
    a._confirm("Sure?", ok);
    expect(h._stage.querySelector(".fp-confirm-text").textContent).toBe(
      "Sure?",
    );
    h._stage.querySelector("[data-c=yes]").click();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(h._stage.querySelector(".fp-confirm")).toBeNull();
    a._confirm("Again?", ok);
    a.dispose();
    expect(h._stage.querySelector(".fp-confirm")).toBeNull();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
