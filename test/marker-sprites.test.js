// @vitest-environment happy-dom
// The GPU markers on the card's marker layer and the view's sprites with a fake view: a state change dirties
// the view only when something a marker shows changes; a tap point maps to the marker drawn on top.
import { describe, it, expect, beforeAll } from "bun:test";
import * as THREE from "three";
import { ViewSprites } from "../src/view/sprites.ts";
import { Billboard } from "../src/view/billboards.ts";
import { MarkerLayer } from "../src/card/marker-layer.ts";
import { readGlyph } from "../src/view/icons.ts";
import { stateOf } from "./helpers/hass.js";

// <ha-icon> stand-in (as the demo's): the icon name as the path data, rendered at once
beforeAll(() => {
  if (customElements.get("ha-icon")) return;
  customElements.define(
    "ha-icon",
    class extends HTMLElement {
      static get observedAttributes() {
        return ["icon"];
      }
      attributeChangedCallback() {
        this.innerHTML = `<svg viewBox="0 0 24 24"><path d="M0 0 ${this.getAttribute("icon")}"/></svg>`;
      }
    },
  );
});

function fakeView() {
  const container = document.createElement("div");
  document.body.append(container);
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 200,
    height: 200,
    right: 200,
    bottom: 200,
  });
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  camera.position.set(0, 50, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  const view = {
    container,
    dirty: false,
    markerObjects: new Map(),
    scene: new THREE.Scene(),
    camera,
    model: null,
    renderer: { domElement: canvas },
    occlusion: { active: () => false, pointHidden: () => false },
    cam: { pixelsPerMetre: () => 100 },
    setGlows() {},
  };
  view.sprites = new ViewSprites(view);
  view.setMarkerSprite = (id, spec, alert) =>
    view.sprites.setMarkerSprite(id, spec, alert);
  view.markersAt = (x, y) => view.sprites.markersAt(x, y);
  view.markerScreen = (id) => view.sprites.markerScreen(id);
  return view;
}

function addMarker(view, id, x, y, z) {
  const b = view.sprites.layer.add(new Billboard());
  b.pickId = id;
  b.position.set(x, y, z);
  view.scene.add(b);
  view.markerObjects.set(id, { obj: b, floorId: "g" });
  return b;
}

const marker = (id, entityId, extra = {}) => ({
  id,
  entityId,
  domain: entityId.split(".")[0],
  deviceId: null,
  areaId: null,
  name: id,
  entities: [entityId],
  secondaryId: null,
  ...extra,
});

function setup(states) {
  const view = fakeView();
  const card = {
    _view: view,
    _hass: { states, entities: {} },
    _layout: {},
    _config: {},
    _theme: { dark: false },
    _boundEntities: new Set(),
  };
  const layer = new MarkerLayer(card);
  return { view, card, layer };
}

describe("marker state refresh and the view's dirty flag", () => {
  it("a state of an entity no marker shows draws nothing; the marker's value or icon does", () => {
    let states = {
      "switch.kettle": stateOf("switch.kettle", "off"),
      "sensor.kettle_power": stateOf("sensor.kettle_power", "0", {
        unit_of_measurement: "W",
      }),
      "sensor.elsewhere": stateOf("sensor.elsewhere", "18"),
    };
    const { view, card, layer } = setup(states);
    addMarker(view, "device:kettle", 0, 1, 0);
    layer._markers = [
      marker("device:kettle", "switch.kettle", {
        secondaryId: "sensor.kettle_power",
      }),
    ];
    layer._refreshStates();
    expect(layer._faces.get("device:kettle").value).toBe("0W");
    view.dirty = false;
    const update = (patch) => {
      states = { ...states, ...patch };
      card._hass = { states, entities: {} };
      layer._refreshStates();
    };
    // ten updates of a sensor nothing shows
    for (let i = 0; i < 10; i++)
      update({
        "sensor.elsewhere": stateOf("sensor.elsewhere", String(19 + i)),
      });
    expect(view.dirty).toBe(false);
    // the same states again (a new hass object)
    update({});
    expect(view.dirty).toBe(false);
    // the marker's secondary value
    update({
      "sensor.kettle_power": stateOf("sensor.kettle_power", "1800", {
        unit_of_measurement: "W",
      }),
    });
    expect(view.dirty).toBe(true);
    // the marker's icon (the entity's icon attribute): the resolver reads the new path, the view redraws
    view.dirty = false;
    const before = view.sprites.icons.version("state:device:kettle");
    update({
      "switch.kettle": stateOf("switch.kettle", "off", { icon: "mdi:kettle" }),
    });
    expect(view.sprites.icons.version("state:device:kettle")).toBe(before + 1);
    expect(view.dirty).toBe(true);
  });

  it("a resolved icon is read from the element's svg path; none yet = placeholder", () => {
    const el = document.createElement("span");
    expect(readGlyph(el)).toBeNull();
    el.innerHTML =
      '<svg viewBox="0 0 48 48"><path d="M1 1"/><path class="secondary-path" d="M2 2"/></svg>';
    expect(readGlyph(el)).toEqual({
      paths: [
        { d: "M1 1", opacity: 1 },
        { d: "M2 2", opacity: 0.5 },
      ],
      viewBox: [0, 0, 48, 48],
    });
  });
});

describe("picking markers", () => {
  it("a client point maps to the marker drawn on top; hidden / untappable ones are skipped", () => {
    const states = {
      "light.a": stateOf("light.a", "on"),
      "light.b": stateOf("light.b", "off"),
    };
    const { view, card, layer } = setup(states);
    // top view, 10 px per metre: world (x, z) -> client (100 + 10 x, 100 + 10 z)
    addMarker(view, "device:a", 0, 1, 0); // lower
    addMarker(view, "device:b", 2, 2.5, 0); // higher: nearer the camera
    layer._markers = [
      marker("device:a", "light.a"),
      marker("device:b", "light.b"),
    ];
    layer._refreshStates();
    view.sprites.applyMarkerDraw();
    expect(layer._markerAt(100, 100).id).toBe("device:a");
    expect(layer._markerAt(110, 100).id).toBe("device:b"); // overlap: the nearer one
    expect(layer._markerAt(160, 100)).toBeNull();
    expect(view.markersAt(110, 100)).toEqual(["device:b", "device:a"]);
    // view mode: one the model hides takes no tap, the one under it does
    view.occlusion = {
      active: () => true,
      pointHidden: (w) => w.y > 2,
    };
    expect(layer._markerAt(110, 100).id).toBe("device:a");
    // a floor hidden: its markers are not drawn and not picked
    view.markerObjects.get("device:a").obj.visible = false;
    expect(layer._markerAt(100, 100)).toBeNull();
    expect(card._view.sprites.markerScreen("device:a")).toBeNull();
    const r = layer._markerRect("device:b"); // the dot on screen (31 px: 28 + the border)
    expect(r.x).toBeCloseTo(120 - 15.5);
    expect(r.y).toBeCloseTo(100 - 15.5);
    expect(r.width).toBeCloseTo(31);
  });
});
