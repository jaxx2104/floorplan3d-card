// The FloorplanView facade and the per-frame / timer logic of its parts (src/view/*), on fakes (no WebGL).
import { describe, it, expect, vi, afterEach } from "bun:test";
import * as THREE from "three";
import { FloorplanView } from "../src/view.ts";
import { CameraRig } from "../src/view/camera.ts";
import { MarkerOcclusion, OCCLUSION_DELAY_MS } from "../src/view/occlusion.ts";
import { RenderLook } from "../src/view/look.ts";
import { SkyLayer } from "../src/view/sky.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const clock = (start = 1000) => {
  let t = start;
  vi.spyOn(performance, "now").mockImplementation(() => t);
  return (dt) => {
    t += dt;
  };
};

// A view without a renderer: the prototype (facade) over fake parts.
const facade = () => {
  const v = Object.create(FloorplanView.prototype);
  Object.assign(v, {
    cam: {},
    modelLayer: {},
    look: {},
    skyLayer: {},
    structure: {},
    mower: {},
    occlusion: {},
  });
  return v;
};

describe("FloorplanView facade", () => {
  const fields = {
    cam: ["controls", "pivotMarker", "_tween", "_framed"],
    modelLayer: [
      "mergeStats",
      "pickHelper",
      "_preview",
      "_previewRing",
      "_previewFace",
      "_surfMeshes",
    ],
    look: ["render", "renderFrom", "sky", "_dome", "_sunStale"],
    skyLayer: ["skySprites", "skyRing", "weather", "_cloudU", "_precip"],
    structure: ["stems"],
    mower: ["mapPlane", "warning", "_ground", "_mowerGround"],
    occlusion: ["_occTimer", "_occFull"],
  };
  for (const [part, names] of Object.entries(fields)) {
    it(`${part} fields read and write the part's own objects`, () => {
      const v = facade();
      for (const n of names) {
        const a = { n };
        v[part][n] = a;
        expect(v[n]).toBe(a);
        const b = { n };
        v[n] = b;
        expect(v[part][n]).toBe(b);
      }
    });
  }

  it("lastCamera3d is read-only and forwards", () => {
    const v = facade();
    const cam = { position: [1, 2, 3], target: [0, 0, 0] };
    v.cam = {
      get lastCamera3d() {
        return cam;
      },
    };
    expect(v.lastCamera3d).toBe(cam);
  });

  it("methods delegate with their arguments and return the part result", () => {
    const v = facade();
    v.cam.setCamera = vi.fn(() => "moved");
    v.cam.fit = vi.fn();
    v.modelLayer.surfaceRays = vi.fn(() => []);
    v.look._shadowDirty = vi.fn();
    v.skyLayer._roomHull = vi.fn(() => [[1, 2]]);
    v.mower.setMapCanvas = vi.fn();
    v.occlusion._scheduleOcclusion = vi.fn();
    expect(v.setCamera({ position: [1, 1, 1] }, { instant: true })).toBe(
      "moved",
    );
    expect(v.cam.setCamera).toHaveBeenCalledWith(
      { position: [1, 1, 1] },
      { instant: true },
    );
    v.fit();
    expect(v.cam.fit).toHaveBeenCalledWith(undefined); // the part's own default applies
    expect(v.surfaceRays([0, 1, 0], [[0, -1, 0]], 3)).toEqual([]);
    expect(v.modelLayer.surfaceRays).toHaveBeenCalledWith(
      [0, 1, 0],
      [[0, -1, 0]],
      3,
    );
    v._shadowDirty();
    expect(v.look._shadowDirty).toHaveBeenCalledTimes(1);
    expect(v._roomHull()).toEqual([[1, 2]]);
    v.setMapCanvas("c", 4, 2);
    expect(v.mower.setMapCanvas).toHaveBeenCalledWith("c", 4, 2, undefined);
    v._scheduleOcclusion(0, "m1");
    expect(v.occlusion._scheduleOcclusion).toHaveBeenCalledWith(0, "m1");
  });
});

describe("CameraRig", () => {
  const rigView = () => ({
    mode: "3d",
    onScreen: true,
    _maxFps: null,
    dirty: false,
    persp: new THREE.PerspectiveCamera(),
    camera: null,
    _moveCamera: vi.fn(),
  });

  it("setCamera goes through view._moveCamera (a patched one sees the move) and relaxes the zoom limits", () => {
    const view = rigView();
    const rig = new CameraRig(view);
    rig.controls = { minDistance: 4, maxDistance: 130 };
    rig.setCamera(
      { position: [0, 0, 200], target: [0, 0, 0] },
      { instant: true },
    );
    expect(view._moveCamera).toHaveBeenCalledTimes(1);
    const [pos, target, instant] = view._moveCamera.mock.calls[0];
    expect(pos.toArray()).toEqual([0, 0, 200]);
    expect(target.toArray()).toEqual([0, 0, 0]);
    expect(instant).toBe(true);
    expect(rig.controls.maxDistance).toBe(200);
    rig.setCamera({ position: [0, 0, 1], target: [0, 0, 0] });
    expect(rig.controls.minDistance).toBe(1);
    view.mode = "top";
    rig.setCamera({ position: [0, 0, 5], target: [0, 0, 0] });
    expect(view._moveCamera).toHaveBeenCalledTimes(2); // top view: ignored
  });

  it("_moveCamera: the first move is instant, later ones tween", () => {
    const view = rigView();
    const rig = new CameraRig(view);
    rig.controls = { target: new THREE.Vector3(), update: vi.fn() };
    rig._moveCamera(new THREE.Vector3(0, 5, 5), new THREE.Vector3(), false);
    expect(rig._framed).toBe(true);
    expect(rig._tween).toBe(null);
    expect(view.persp.position.toArray()).toEqual([0, 5, 5]);
    rig._moveCamera(
      new THREE.Vector3(0, 9, 9),
      new THREE.Vector3(1, 0, 0),
      false,
    );
    expect(rig._tween.to.pos.toArray()).toEqual([0, 9, 9]);
    expect(view.dirty).toBe(true);
  });

  it("idle orbit: waits a frame, turns at speed degrees a second, stops in top view and on a drag", () => {
    const tick = clock();
    const view = rigView();
    view.camera = { position: { x: 2, y: 5, z: 0 } };
    const rig = new CameraRig(view);
    rig.controls = { target: { x: 1, y: 0, z: 0 }, update: vi.fn() };
    rig.startOrbit(90);
    rig._stepOrbit();
    expect(view.dirty).toBe(false); // first frame only starts the clock
    tick(20);
    rig._stepOrbit();
    expect(view.dirty).toBe(false); // under the 50 ms frame interval
    tick(980);
    rig._stepOrbit(); // 0.5 s at most per step: 45 degrees
    expect(view.dirty).toBe(true);
    expect(rig.controls.update).toHaveBeenCalledTimes(1);
    expect(
      Math.hypot(view.camera.position.x - 1, view.camera.position.z),
    ).toBeCloseTo(1);
    expect(view.camera.position.z).toBeCloseTo(-Math.SQRT1_2);
    view.mode = "top";
    rig._stepOrbit();
    expect(rig._orbit.frameAt).toBe(0);
    rig.stopOrbit();
    expect(rig._orbit).toBe(null);
  });

  it("a top-view tween is dropped once the view left top", () => {
    const view = rigView();
    const rig = new CameraRig(view);
    rig._tween = { top: true, t0: 0, from: {}, to: {} };
    rig._stepTween(100);
    expect(rig._tween).toBe(null);
  });
});

describe("MarkerOcclusion", () => {
  const occView = () => ({
    _disposed: false,
    _raf: 1,
    mode: "3d",
    model: null,
    cssObjects: [],
    stats: { occPasses: 0, occPartial: 0, occDone: 0 },
  });

  it("schedules nothing while the card is detached or disposed", () => {
    vi.useFakeTimers();
    const view = occView();
    const occ = new MarkerOcclusion(view);
    view._raf = null;
    occ._scheduleOcclusion(0);
    expect(occ._occTimer).toBe(null);
    view._raf = 1;
    view._disposed = true;
    occ._scheduleOcclusion(0);
    expect(occ._occTimer).toBe(null);
  });

  it("a full pass covers pending partial ones; partial ids collect until a full one", () => {
    vi.useFakeTimers();
    const occ = new MarkerOcclusion(occView());
    occ._scheduleOcclusion(OCCLUSION_DELAY_MS, "a");
    occ._scheduleOcclusion(OCCLUSION_DELAY_MS, "b");
    expect([...occ._occIds]).toEqual(["a", "b"]);
    expect(occ._occFull).toBe(false);
    const gen = occ._occGen;
    occ._scheduleOcclusion(0);
    expect(occ._occFull).toBe(true);
    expect(occ._occIds).toBe(null);
    expect(occ._occGen).toBe(gen + 1);
    occ._scheduleOcclusion(OCCLUSION_DELAY_MS, "c");
    expect(occ._occIds).toBe(null); // the pending full pass has it
    occ._cancelOcclusion();
    expect(occ._occTimer).toBe(null);
    expect(occ._occFull).toBe(false);
  });

  it("without a model a pass only clears the dimming", () => {
    vi.useFakeTimers();
    const view = occView();
    const remove = vi.fn();
    view.cssObjects = [
      { kind: "marker", obj: { element: { classList: { remove } } } },
      { kind: "label", obj: { element: { classList: { remove } } } },
    ];
    const occ = new MarkerOcclusion(view);
    occ._scheduleOcclusion(0);
    vi.runAllTimers();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("fp-occluded");
    expect(occ._occFull).toBe(false);
    expect(view.stats.occPasses).toBe(0);
  });
});

describe("RenderLook / SkyLayer frame clocks", () => {
  it("sway: needs the option, a model and the card on screen; one frame per interval", () => {
    const tick = clock(5000);
    const view = {
      model: null,
      onScreen: true,
      test: null,
      _maxFps: null,
      dirty: false,
    };
    view.skyLayer = new SkyLayer(view);
    const look = new RenderLook(view);
    look._sway = { plants: ["tree"], strength: 1 };
    look._stepSway();
    expect(view.dirty).toBe(false);
    view.model = {};
    look._stepSway();
    expect(view.dirty).toBe(true);
    expect(view.skyLayer._cloudU.fpTime.value).toBeCloseTo(5);
    view.dirty = false;
    tick(30);
    look._stepSway();
    expect(view.dirty).toBe(false); // under 66 ms
    look.setMaxFps(60);
    expect(view._maxFps).toBe(60);
    look._stepSway(); // 30 ms > 1000 / 60 - 2
    expect(view.dirty).toBe(true);
  });

  it("cloud drift: only while the shadows show (not in test mode unless asked), counts frames", () => {
    const tick = clock();
    const view = {
      onScreen: true,
      test: { drift: false },
      _maxFps: null,
      dirty: false,
      stats: { cloudFrames: 0 },
    };
    const sky = new SkyLayer(view);
    sky.weather.shown = 1;
    sky._cloudU.fpCloudStrength.value = 0.5;
    sky._driftClouds();
    tick(100);
    sky._driftClouds();
    expect(view.stats.cloudFrames).toBe(0);
    view.test.drift = true;
    sky._driftClouds(); // starts the clock
    tick(100);
    sky._driftClouds();
    expect(view.stats.cloudFrames).toBe(1);
    expect(sky.weather.t).toBeCloseTo(0.1);
    expect(view.dirty).toBe(true);
    sky._cloudU.fpCloudStrength.value = 0;
    sky._driftClouds();
    expect(sky.weather.frameAt).toBe(0);
  });
});
