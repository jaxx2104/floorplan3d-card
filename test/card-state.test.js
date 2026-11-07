// The card's state flow (src/card/state.ts) with stub steps: which hass updates, layout edits and
// model loads rebuild what, and that a burst of writes runs each step once.
import { describe, it, expect } from "bun:test";
import { CardState } from "../src/card/state.ts";
import { batch } from "../src/signals.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const calls = [];
  const count = (name) => calls.filter((c) => c === name).length;
  const st = new CardState();
  let bindingsChanged = false;
  let viewsResult = false;
  let mb = null;
  const steps = {
    applyTheme: () => calls.push("theme"),
    modelBindings: () => mb,
    modelKey: (m) => (m ? JSON.stringify(m.levels) : ""),
    resolveViews: () => {
      const r = viewsResult;
      viewsResult = false;
      return r;
    },
    checkMergeKeep: () => calls.push("mergeKeep"),
    buildStructure: () => calls.push("structure"),
    refreshViews: () => calls.push("views"),
    syncBindings: () => {
      const r = bindingsChanged;
      bindingsChanged = false;
      return r;
    },
    buildMarkers: () => calls.push("markers"),
    loadModel: () => calls.push("load"),
    mowerConfig: () => calls.push("mower"),
    refreshStates: () => calls.push("states"),
    tail: (rebuilt) => calls.push(rebuilt ? "tail:rebuilt" : "tail"),
  };
  st.connect(steps);
  const hass = {
    states: { "light.a": { state: "on" } },
    entities: {},
    devices: {},
    areas: { kitchen: { area_id: "kitchen" } },
    floors: {},
    themes: { darkMode: false },
  };
  const layout = {
    version: 1,
    floors: [],
    rooms: [],
    pins: {},
    hidden: [],
  };
  return {
    st,
    calls,
    count,
    hass,
    layout,
    reset: () => (calls.length = 0),
    bindings: () => (bindingsChanged = true),
    viewsOnly: () => (viewsResult = "views"),
    setMb: (v) => (mb = v),
  };
}

async function ready() {
  const t = setup();
  batch(() => {
    t.st.config.value = { layout_key: "default" };
    t.st.hass.value = t.hass;
    t.st.layout.value = t.layout;
    t.st.rendered.value = true;
  });
  await tick();
  return t;
}

describe("card state flow", () => {
  it("nothing runs until the view, hass and the layout are there", async () => {
    const t = setup();
    t.st.hass.value = t.hass;
    t.st.layout.value = t.layout;
    await tick();
    expect(t.calls).toEqual([]);
    t.st.rendered.value = true;
    await tick();
    // the old _update order, each once
    expect(t.calls).toEqual([
      "theme",
      "structure",
      "markers",
      "mower",
      "states",
      "tail:rebuilt",
    ]);
  });

  it("a hass update that only changes states does not rebuild markers", async () => {
    const t = await ready();
    t.reset();
    t.st.hass.value = { ...t.hass, states: { "light.a": { state: "off" } } };
    await tick();
    expect(t.calls).toEqual(["states", "tail"]);
  });

  it("a hass push with nothing new runs only the per-update tail", async () => {
    const t = await ready();
    t.reset();
    t.st.hass.value = { ...t.hass };
    await tick();
    expect(t.calls).toEqual(["tail"]);
  });

  it("an areas identity change rebuilds structure and markers once", async () => {
    const t = await ready();
    t.reset();
    t.st.hass.value = { ...t.hass, areas: { ...t.hass.areas } };
    await tick();
    expect(t.calls).toEqual(["structure", "markers", "states", "tail:rebuilt"]);
  });

  it("an entities identity change rebuilds markers, not the structure", async () => {
    const t = await ready();
    t.reset();
    t.st.hass.value = { ...t.hass, entities: {} };
    await tick();
    expect(t.calls).toEqual(["markers", "states", "tail:rebuilt"]);
  });

  it("a theme change applies the theme and rebuilds", async () => {
    const t = await ready();
    t.reset();
    t.st.hass.value = { ...t.hass, themes: { darkMode: true } };
    await tick();
    expect(t.calls.slice(0, 3)).toEqual(["theme", "structure", "markers"]);
  });

  it("a layout edit of the rooms rebuilds the structure once", async () => {
    const t = await ready();
    t.reset();
    t.st.layout.value = { ...t.layout, rooms: [{ id: "r1" }] };
    await tick();
    expect(t.count("structure")).toBe(1);
    expect(t.count("markers")).toBe(1);
  });

  it("a pin edit rebuilds markers only", async () => {
    const t = await ready();
    t.reset();
    t.st.layout.value = { ...t.layout, pins: { a: { x: 1, y: 1 } } };
    await tick();
    expect(t.calls).toEqual(["markers", "states", "tail:rebuilt"]);
  });

  it("an overlay slider edit (mower part, same entity) refreshes states, no markers", async () => {
    const t = await ready();
    const mower = { entity: "lawn_mower.m", floor_id: "g", overlay: {} };
    t.st.layout.value = { ...t.layout, mower };
    await tick();
    t.reset();
    t.st.layout.value = {
      ...t.st.layout.peek(),
      mower: { ...mower, overlay: { opacity: 0.5 } },
    };
    await tick();
    expect(t.calls).toEqual(["mower", "states", "tail"]);
  });

  it("a burst of writes in one tick runs each step once", async () => {
    const t = await ready();
    t.reset();
    for (let i = 0; i < 5; i++)
      t.st.layout.value = { ...t.layout, rooms: [{ id: `r${i}` }] };
    t.st.hass.value = { ...t.hass, areas: {} };
    await tick();
    expect(t.count("structure")).toBe(1);
    expect(t.count("markers")).toBe(1);
    expect(t.count("states")).toBe(1);
  });

  it("views-only changes refresh the view list without a rebuild", async () => {
    const t = await ready();
    t.reset();
    t.viewsOnly();
    t.st.layout.value = { ...t.layout, views: { a: {} } };
    await tick();
    expect(t.calls).toEqual(["mergeKeep", "views", "tail:rebuilt"]);
  });

  it("changed object bindings rebuild markers", async () => {
    const t = await ready();
    t.reset();
    t.bindings();
    t.st.hass.value = { ...t.hass, states: {} };
    await tick();
    expect(t.calls).toEqual(["markers", "states", "tail:rebuilt"]);
  });

  it("a loaded model rebuilds once its bindings key changes", async () => {
    const t = await ready();
    t.reset();
    t.setMb({ manifest: {}, levels: { a: 1 } });
    t.st.model.value = {};
    await tick();
    expect(t.count("structure")).toBe(1);
    t.reset();
    t.st.schedule(); // same model, nothing new
    await tick();
    expect(t.calls).toEqual(["tail"]);
  });

  it("a layout model replaced loads it; the first build does not reload", async () => {
    const t = await ready();
    expect(t.count("load")).toBe(0);
    t.st.layout.value = { ...t.layout, model: { file: "a.glb" } };
    await tick();
    expect(t.count("load")).toBe(1);
  });

  it("a reconnect refreshes states once", async () => {
    const t = await ready();
    t.reset();
    t.st.reconnects.value++;
    await tick();
    expect(t.calls).toEqual(["states"]);
  });

  it("pending() reports waiting work", async () => {
    const t = await ready();
    expect(t.st.pending()).toBe(false);
    t.st.hass.value = { ...t.hass };
    expect(t.st.pending()).toBe(true);
    await tick();
    expect(t.st.pending()).toBe(false);
  });
});
