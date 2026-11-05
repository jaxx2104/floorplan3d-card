// @vitest-environment happy-dom
// (the router itself needs no DOM, but it loads the edit tabs and lit; in a serial run (bun test
// --coverage) a DOM-less first load is shared with edit-panel and breaks it)
import { describe, it, expect, vi } from "bun:test";
import {
  clickRoute,
  keyRoute,
  onKeyDown,
  canvasDown,
  canvasUp,
  CLICK_SLOP_PX,
} from "../src/edit/router.ts";

const ed = (o = {}) => ({
  tab: "rooms",
  view: { model: null },
  drawing: null,
  picking: null,
  pivoting: false,
  aligning: null,
  colorPick: false,
  calibrating: null,
  menu: null,
  doorMode: false,
  selectedRoom: null,
  selectedMarker: null,
  ...o,
});
const model = { model: {} };

describe("edit click precedence", () => {
  it("the first armed tool wins", () => {
    const all = {
      pivoting: true,
      aligning: {},
      colorPick: "bg",
      calibrating: {},
      picking: {},
      tab: "views",
      view: model,
    };
    expect(clickRoute(ed(all))).toBe("pivot");
    expect(clickRoute(ed({ ...all, pivoting: false }))).toBe("align");
    expect(clickRoute(ed({ ...all, pivoting: false, aligning: null }))).toBe(
      "color",
    );
    expect(
      clickRoute(
        ed({ ...all, pivoting: false, aligning: null, colorPick: false }),
      ),
    ).toBe("calibrate");
    expect(
      clickRoute(
        ed({
          ...all,
          pivoting: false,
          aligning: null,
          colorPick: false,
          calibrating: null,
        }),
      ),
    ).toBe("pick-room");
    expect(clickRoute(ed({ tab: "views", view: model }))).toBe("views");
  });

  it("picking and the model tabs give way to drawing", () => {
    const drawing = { points: [] };
    expect(clickRoute(ed({ picking: {}, drawing }))).toBe("plan");
    for (const tab of ["objects", "views", "model"]) {
      expect(clickRoute(ed({ tab, view: model }))).toBe(tab);
      expect(clickRoute(ed({ tab, view: model, drawing }))).toBe("plan");
      expect(clickRoute(ed({ tab, view: { model: null } }))).toBe("plan"); // no model: plan clicks
    }
    expect(clickRoute(ed({ picking: {}, tab: "objects", view: model }))).toBe(
      "pick-room",
    );
  });

  it("canvasUp only clicks within the slop of the press, left button only", () => {
    // the colour tool's click asks the view for the map pixel: a stand-in for "a click happened"
    const e = ed({
      colorPick: "bg",
      view: { model: null, mapHit: vi.fn(() => null) },
      render: vi.fn(),
    });
    const press = (button, dx) => {
      canvasDown(e, { button, clientX: 10, clientY: 10 });
      canvasUp(e, { clientX: 10 + dx, clientY: 10 });
    };
    press(0, CLICK_SLOP_PX);
    expect(e.view.mapHit).not.toHaveBeenCalled();
    press(2, 0);
    expect(e.view.mapHit).not.toHaveBeenCalled();
    press(0, CLICK_SLOP_PX - 1);
    expect(e.view.mapHit).toHaveBeenCalledTimes(1);
    canvasUp(e, { clientX: 10, clientY: 10 }); // no press: no click
    expect(e.view.mapHit).toHaveBeenCalledTimes(1);
  });
});

describe("edit key precedence", () => {
  const input = { tagName: "INPUT" };
  it("typing in a field is ignored", () => {
    expect(keyRoute(ed({ drawing: { points: [] } }), "Escape", input)).toBe(
      null,
    );
  });
  it("menu Esc > pivoting > picking > drawing > Esc cascade", () => {
    const all = {
      menu: {},
      pivoting: true,
      picking: {},
      drawing: { points: [] },
      colorPick: true,
    };
    expect(keyRoute(ed(all), "Escape")).toEqual({ kind: "menu" });
    expect(keyRoute(ed(all), "Enter")).toBe(null); // pivoting only listens to Esc
    expect(keyRoute(ed({ ...all, menu: null }), "Escape")).toEqual({
      kind: "pivot",
    });
    expect(
      keyRoute(
        ed({ ...all, menu: null, pivoting: false, drawing: null }),
        "Escape",
      ),
    ).toEqual({ kind: "pick" });
    expect(
      keyRoute(ed({ ...all, menu: null, pivoting: false }), "Enter"),
    ).toEqual({ kind: "draw-finish" }); // drawing wins over picking
    expect(keyRoute(ed({ drawing: { points: [] } }), "Escape")).toEqual({
      kind: "draw-cancel",
    });
    expect(keyRoute(ed({ drawing: { points: [] } }), "Backspace")).toEqual({
      kind: "draw-undo",
    });
    expect(keyRoute(ed({ drawing: { points: [] } }), "a")).toBe(null);
  });
  it("the Esc cascade undoes one thing at a time", () => {
    const all = {
      colorPick: "bg",
      aligning: {},
      doorMode: true,
      selectedRoom: "r",
      selectedMarker: "m",
    };
    expect(keyRoute(ed(all), "Escape")).toEqual({
      kind: "esc",
      step: "colorPick",
    });
    expect(keyRoute(ed({ ...all, colorPick: false }), "Escape").step).toBe(
      "aligning",
    );
    expect(
      keyRoute(ed({ ...all, colorPick: false, aligning: null }), "Escape").step,
    ).toBe("doorMode");
    expect(
      keyRoute(ed({ selectedRoom: "r", selectedMarker: "m" }), "Escape").step,
    ).toBe("selectedRoom");
    expect(keyRoute(ed({ selectedMarker: "m" }), "Escape").step).toBe(
      "selectedMarker",
    );
    expect(keyRoute(ed(), "Escape")).toEqual({ kind: "esc", step: null });
    expect(keyRoute(ed(), "Enter")).toBe(null);
  });

  const key = (k, target = { tagName: "DIV" }) => ({
    key: k,
    composedPath: () => [target],
    preventDefault: vi.fn(),
  });
  it("the Esc cascade re-renders without preventDefault; drawing keys prevent it", () => {
    const e = ed({
      view: null,
      colorPick: true,
      _syncStageClasses: vi.fn(),
      render: vi.fn(),
    });
    const ev = key("Escape");
    onKeyDown(e, ev);
    expect(e.colorPick).toBe(false);
    expect(e.render).toHaveBeenCalledTimes(1);
    expect(ev.preventDefault).not.toHaveBeenCalled();

    const sel = ed({
      view: null,
      selectedMarker: "m",
      selectMarker: vi.fn(),
      _syncStageClasses: vi.fn(),
      render: vi.fn(),
    });
    onKeyDown(sel, key("Escape"));
    expect(sel.selectMarker).toHaveBeenCalledWith(null);

    const d = ed({
      view: null,
      drawing: {
        points: [
          [0, 0],
          [1, 0],
        ],
      },
      render: vi.fn(),
      _syncStageClasses: vi.fn(),
    });
    const bs = key("Backspace");
    onKeyDown(d, bs);
    expect(d.drawing.points).toEqual([[0, 0]]);
    expect(d.render).toHaveBeenCalledTimes(1);
    expect(bs.preventDefault).toHaveBeenCalled();

    const typed = key("Backspace", { tagName: "TEXTAREA" });
    onKeyDown(d, typed);
    expect(d.drawing.points).toEqual([[0, 0]]);
    expect(typed.preventDefault).not.toHaveBeenCalled();
  });
});
