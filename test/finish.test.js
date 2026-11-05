import { describe, it, expect } from "bun:test";
import * as THREE from "three";
import {
  normBokeh,
  normGrade,
  cocAt,
  tiltStep,
  gradeUniforms,
  screenBand,
  focusLine,
  BOKEH_DEFAULTS,
  GRADE_DEFAULTS,
  TILT_FULL,
} from "../src/finish.ts";

describe("normBokeh", () => {
  it("off unless asked for, or with no strength", () => {
    for (const v of [undefined, null, false, 0, "yes", { strength: 0 }])
      expect(normBokeh(v)).toBe(null);
  });
  it("true: the defaults; an object: its valid keys, clamped", () => {
    expect(normBokeh(true)).toEqual({ ...BOKEH_DEFAULTS });
    expect(normBokeh({ strength: 99, range: 0, start: "x", tilt: 3 })).toEqual({
      strength: 20,
      start: BOKEH_DEFAULTS.start,
      range: 0.5,
      tilt: 1,
    });
  });
});

describe("cocAt", () => {
  const s = { start: 1, range: 10 };
  it("sharp up to start, full blur from start + range, smooth between", () => {
    expect(cocAt(0, s)).toBe(0);
    expect(cocAt(1, s)).toBe(0);
    expect(cocAt(6, s)).toBeCloseTo(0.5);
    expect(cocAt(11, s)).toBe(1);
    expect(cocAt(50, s)).toBe(1);
    expect(cocAt(3, s)).toBeLessThan(cocAt(4, s));
  });
});

describe("normGrade", () => {
  it("off unless asked for; true: the defaults; values clamped", () => {
    for (const v of [undefined, null, false, "yes"])
      expect(normGrade(v)).toBe(null);
    expect(normGrade(true)).toEqual({ ...GRADE_DEFAULTS });
    expect(normGrade({ saturation: 5, vignette: -1 })).toEqual({
      ...GRADE_DEFAULTS,
      saturation: 2,
      vignette: 0,
    });
  });
});

describe("tiltStep", () => {
  it("the tilt shaders' outermost tap (4 steps) at TILT_FULL from the line: tilt x the bokeh radius", () => {
    const h = tiltStep(10, 0.5, 1000);
    expect(4 * h * TILT_FULL * 1000).toBeCloseTo(5);
    expect(tiltStep(10, 0, 1000)).toBe(0);
  });
});

describe("gradeUniforms", () => {
  it("saturation 1, contrast 0, vignette 0: the shaders change nothing", () => {
    const g = gradeUniforms({ saturation: 1, contrast: 0, vignette: 0 });
    expect(g.saturation).toBeCloseTo(0, 2);
    expect(g.contrast).toBe(0);
    expect(g.offset).toBe(0);
  });
  it("saturation k: HueSaturationShader scales the chroma by k", () => {
    const factor = (s) => (s > 0 ? 1 / (1.001 - s) : 1 + s); // the shader's mix towards / away from grey
    for (const k of [0, 0.5, 1.15, 2])
      expect(
        factor(gradeUniforms({ ...GRADE_DEFAULTS, saturation: k }).saturation),
      ).toBeCloseTo(k, 2);
  });
  it("contrast 1: slope 2 through mid grey; vignette v: the corners v darker", () => {
    const g = gradeUniforms({ saturation: 1, contrast: 1, vignette: 0.25 });
    expect(1 / (1 - g.contrast)).toBeCloseTo(2);
    expect(0.5 * g.offset * g.offset * g.darkness).toBeCloseTo(0.25);
  });
});

describe("screenBand", () => {
  it("the screen heights a box covers, null behind the camera or for an empty box", () => {
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    cam.position.set(0, 0, 10);
    cam.updateMatrixWorld();
    const [y0, y1] = screenBand(
      new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
      cam,
    );
    expect(y0).toBeLessThan(0.5);
    expect(y1).toBeGreaterThan(0.5);
    expect(y0 + y1).toBeCloseTo(1);
    expect(
      screenBand(
        new THREE.Box3(
          new THREE.Vector3(-1, -1, 11),
          new THREE.Vector3(1, 1, 12),
        ),
        cam,
      ),
    ).toBe(null);
    expect(screenBand(new THREE.Box3(), cam)).toBe(null);
  });
});

describe("focusLine", () => {
  it("the middle of the rooms' band, null without one", () => {
    expect(focusLine([0.2, 0.8])).toBeCloseTo(0.5);
    expect(focusLine(null)).toBe(null);
  });
});
