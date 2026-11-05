import { describe, it, expect } from "bun:test";
import * as THREE from "three";
import {
  makeSky,
  envSky,
  groundColor,
  skyUniforms,
  ENV_GROUND,
  ENV_GROUND_GAIN,
} from "../src/view/env-light.ts";

// The sky environment is three's Sky as it ships (no shader patch) plus a ground mesh below the horizon.
describe("sky environment scene", () => {
  it("three's Sky without its sun disc, its shader untouched, a ground below the horizon inside it", () => {
    const { sky, ground } = makeSky(),
      m = sky.material,
      plain = new sky.constructor();
    expect(m.uniforms.showSunDisc.value).toBe(0);
    expect(m.fragmentShader).toBe(plain.material.fragmentShader);
    expect(m.vertexShader).toBe(plain.material.vertexShader);
    expect(Object.keys(m.uniforms).filter((k) => k.startsWith("fp"))).toEqual(
      [],
    );
    // the ground: below the horizon only, inside the sky's box, seen from inside
    ground.geometry.computeBoundingBox();
    const b = ground.geometry.boundingBox;
    expect(b.max.y).toBeLessThanOrEqual(1e-6);
    expect(b.min.y).toBeLessThan(-1);
    expect(Math.max(-b.min.x, b.max.x)).toBeLessThan(sky.scale.x / 2);
    expect(ground.material.side).toBe(THREE.BackSide);
    for (const o of [sky, ground]) {
      o.geometry.dispose();
      o.material.dispose();
    }
    plain.geometry.dispose();
    plain.material.dispose();
  });
  it("clouds through the Sky's own uniforms: none when clear, more with the cover", () => {
    const up = [0, 1, 0],
      clear = skyUniforms(envSky(0, up, null, 0)),
      half = skyUniforms(envSky(0, up, null, 50)),
      over = skyUniforms(envSky(0, up, null, 100));
    expect(clear.cloudCoverage).toBe(0);
    expect(half.cloudCoverage).toBeGreaterThan(0);
    expect(over.cloudCoverage).toBeGreaterThan(half.cloudCoverage);
    expect(over.cloudCoverage).toBeLessThanOrEqual(1);
    expect(over.turbidity).toBeGreaterThan(clear.turbidity);
    expect(over.mieCoefficient).toBeGreaterThan(clear.mieCoefficient);
  });
  it("ground: the given colour scaled into the sky's units, darker with a low sun, black with it down", () => {
    const at = (deg, ground) =>
      envSky(
        0,
        [0, Math.sin((deg * Math.PI) / 180), -Math.cos((deg * Math.PI) / 180)],
        null,
        0,
        ground,
      );
    const noon = groundColor(at(60)),
      dusk = groundColor(at(3)),
      night = groundColor(at(-10));
    const g = new THREE.Color(ENV_GROUND);
    // the Sky's sun strength: about half at 60 degrees, all of it only at the zenith
    expect(noon.r / g.r).toBeCloseTo(0.516 * ENV_GROUND_GAIN, 1);
    expect(groundColor(at(90)).r).toBeGreaterThan(noon.r);
    expect(groundColor(at(90)).r / g.r).toBeLessThanOrEqual(ENV_GROUND_GAIN);
    expect(noon.b / noon.r).toBeCloseTo(g.b / g.r); // the colour's hue kept
    expect(dusk.r).toBeLessThan(noon.r / 4);
    expect(night.getHex()).toBe(0);
    expect(groundColor(at(60, 0x000000)).getHex()).toBe(0);
    expect(at(60, 0x123456).ground).toBe(0x123456);
  });
});
