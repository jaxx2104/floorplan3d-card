// @vitest-environment happy-dom
// While one model replaces another (a merge reload) the card keeps the model look.
import { describe, it, expect, vi } from "bun:test";
import { ViewController } from "../src/card/view-controller.ts";
import { ModelLayer } from "../src/view/model.ts";

describe("ModelLayer.isModelSwapping", () => {
  const swapping = (model, modelId, modelLook) =>
    ModelLayer.prototype.isModelSwapping.call({
      view: { model, look: { _modelLook: modelLook } },
      _modelId: modelId,
    });
  it("is true only while a model is on its way with the model look kept", () => {
    expect(swapping(null, "m2", true)).toBe(true); // reload: old model gone, look kept
    expect(swapping(null, "m1", false)).toBe(false); // first load: the plan look
    expect(swapping({ id: "m1" }, "m1", true)).toBe(false); // shown
    expect(swapping(null, null, false)).toBe(false); // no model at all
  });
});

describe("_pushStructure", () => {
  const push = (model, swap) => {
    const setStructure = vi.fn();
    const host = {
      _view: { model, isModelSwapping: () => swap, setStructure },
      _config: {},
      _layout: {},
      _stage: document.createElement("div"),
    };
    const v = new ViewController(host);
    v._floors = [];
    v._roomList = [];
    v._pushStructure();
    return { calls: setStructure.mock.calls.length, stage: host._stage };
  };
  it("keeps the model look (has-model) while a model is swapped for another", () => {
    expect(push(null, false).stage.classList.contains("has-model")).toBe(false);
    expect(push(null, true).stage.classList.contains("has-model")).toBe(true);
    expect(push({ id: "m" }, false).calls).toBe(1);
  });
});
