import { describe, it, expect } from "bun:test";
import {
  moonPosition,
  moonLight,
  moonLitRight,
  domeRadius,
} from "../src/sky.ts";

// Reference: suncalc's published test values (2013-03-05 UTC, 50.5 N, 30.5 E):
// getMoonPosition azimuth -0.9783999522438226 rad (from south), altitude 0.014551482243892251 rad;
// getMoonIllumination fraction 0.4848068202456373, phase 0.7548368838538762.
const REF = new Date("2013-03-05UTC");

describe("moonPosition", () => {
  it("matches the suncalc reference (azimuth from north, clockwise)", () => {
    const m = moonPosition(REF, 50.5, 30.5);
    expect(m.azimuth).toBeCloseTo(
      (-0.9783999522438226 * 180) / Math.PI + 180,
      4,
    );
    expect(m.elevation).toBeCloseTo((0.014551482243892251 * 180) / Math.PI, 4);
    expect(m.illumination).toBeCloseTo(0.4848068202456373, 6);
    expect(m.phase).toBeCloseTo(0.7548368838538762, 6);
  });

  it("azimuth is in 0..360", () => {
    for (let h = 0; h < 24; h += 3) {
      const m = moonPosition(new Date(Date.UTC(2024, 5, 1, h)), 52, 5);
      expect(m.azimuth).toBeGreaterThanOrEqual(0);
      expect(m.azimuth).toBeLessThan(360);
    }
  });

  it("is full around 2024-04-23 and new around 2024-04-08", () => {
    const full = moonPosition(new Date("2024-04-23T23:49:00Z"), 52, 5);
    expect(full.illumination).toBeGreaterThan(0.98);
    expect(Math.abs(full.phase - 0.5)).toBeLessThan(0.03);
    const nu = moonPosition(new Date("2024-04-08T18:21:00Z"), 52, 5);
    expect(nu.illumination).toBeLessThan(0.02);
    expect(Math.min(nu.phase, 1 - nu.phase)).toBeLessThan(0.03);
  });

  it("waxes before full (phase < 0.5) and wanes after", () => {
    expect(
      moonPosition(new Date("2024-04-16T12:00:00Z"), 52, 5).phase,
    ).toBeLessThan(0.5);
    expect(
      moonPosition(new Date("2024-04-30T12:00:00Z"), 52, 5).phase,
    ).toBeGreaterThan(0.5);
  });

  it("rises and sets within a day", () => {
    let pos = 0,
      neg = 0;
    for (let h = 0; h < 25; h++) {
      const e = moonPosition(
        new Date(Date.UTC(2024, 3, 23, h)),
        52,
        5,
      ).elevation;
      if (e > 0) pos++;
      else neg++;
    }
    expect(pos).toBeGreaterThan(0);
    expect(neg).toBeGreaterThan(0);
  });

  it("full moon at local midnight is high in the south", () => {
    // 2024-04-23 full moon, 52 N 5 E: around 23:40 UTC the moon transits (south, low in spring)
    const m = moonPosition(new Date("2024-04-24T00:30:00Z"), 52, 5);
    expect(m.azimuth).toBeGreaterThan(150);
    expect(m.azimuth).toBeLessThan(230);
    expect(m.elevation).toBeGreaterThan(5);
  });

  it("accepts ms timestamps and rejects bad input", () => {
    const t = REF.getTime();
    expect(moonPosition(t, 50.5, 30.5)).toEqual(moonPosition(REF, 50.5, 30.5));
    expect(moonPosition(NaN, 50, 5)).toBeNull();
    expect(moonPosition(REF, undefined, 5)).toBeNull();
  });
});

describe("moonLight", () => {
  it("is off by day, without a moon or with the moon down", () => {
    expect(moonLight(0.3, { dir: [0, 0.5, 0.8], illumination: 1 })).toBe(0);
    expect(moonLight(1, null)).toBe(0);
    expect(moonLight(1, { dir: [0, -0.1, 1], illumination: 1 })).toBe(0);
  });
  it("is 0.05 + 0.15 x illumination x night", () => {
    expect(moonLight(1, { dir: [0, 0.5, 0.8], illumination: 1 })).toBeCloseTo(
      0.2,
    );
    expect(
      moonLight(0.8, { dir: [0, 0.5, 0.8], illumination: 0.5 }),
    ).toBeCloseTo(0.05 + 0.15 * 0.5 * 0.8);
  });
});

describe("dome", () => {
  it("radius is 1.4 x the house radius, at least 12 m", () => {
    expect(domeRadius(20)).toBeCloseTo(28);
    expect(domeRadius(3)).toBe(12);
    expect(domeRadius(undefined)).toBe(12);
  });
});

describe("moonLitRight", () => {
  it("waxing is lit on the right in the north, on the left in the south", () => {
    expect(moonLitRight(0.2, 52)).toBe(true);
    expect(moonLitRight(0.8, 52)).toBe(false);
    expect(moonLitRight(0.2, -34)).toBe(false);
    expect(moonLitRight(0.8, -34)).toBe(true);
    expect(moonLitRight(0.2)).toBe(true); // no latitude: northern view
  });
});

// Reference: suncalc's published test value (2013-03-05 UTC, 50.5 N, 30.5 E):
// getPosition azimuth -2.5003175907168385 rad (from south), altitude -0.7000406838781611 rad.
