import { describe, it, expect } from "bun:test";
import * as THREE from "three";
import {
  contactTileSize,
  contactDarkness,
  contactFloors,
  CONTACT_HEIGHT_M,
  CONTACT_MAX_FLOORS,
  CONTACT_TILE_MIN,
  CONTACT_TILE_MAX,
} from "../src/contact-shadow.ts";
import {
  patchCloudShadow,
  makeCloudUniforms,
  setTierVariant,
  tierKey,
} from "../src/cloud-shadow.ts";

describe("contact shadows", () => {
  it("tile size: about 3 cm texels, power of two, bounded", () => {
    expect(contactTileSize(14)).toBe(512);
    expect(contactTileSize(1)).toBe(CONTACT_TILE_MIN);
    expect(contactTileSize(200)).toBe(CONTACT_TILE_MAX);
  });
  it("darkness fades with height, full inside a solid", () => {
    expect(contactDarkness(0)).toBe(1);
    expect(contactDarkness(CONTACT_HEIGHT_M)).toBe(0);
    expect(contactDarkness(CONTACT_HEIGHT_M / 2)).toBeCloseTo(0.25);
    expect(contactDarkness(2)).toBe(0);
    expect(contactDarkness(2, false)).toBe(1);
  });
  it("floors: lowest first, split levels and extra storeys dropped", () => {
    const f = (y) => ({ y, minX: 0, maxX: 1, minZ: 0, maxZ: 1 });
    expect(contactFloors([f(3), f(0), f(0.3), f(NaN)]).map((x) => x.y)).toEqual(
      [0, 3],
    );
    expect(contactFloors([0, 3, 6, 9, 12, 15].map(f))).toHaveLength(
      CONTACT_MAX_FLOORS,
    );
    expect(contactFloors([])).toEqual([]);
  });
});

describe("quality tier shader variants of the patched model materials", () => {
  const compile = (m) => {
    const sh = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    };
    m.onBeforeCompile(sh, null);
    return sh;
  };
  it("standard: cache key and shader as before (no contact lookup)", () => {
    const m = new THREE.MeshStandardMaterial();
    patchCloudShadow(m, makeCloudUniforms());
    const key = m.customProgramCacheKey();
    expect(setTierVariant(m, { contact: false })).toBe(false); // nothing to change, userData untouched
    expect(m.userData.fpContact).toBe(undefined);
    expect(m.customProgramCacheKey()).toBe(key);
    expect(tierKey(m)).toBe("");
    const sh = compile(m);
    expect(sh.fragmentShader).not.toContain("fpContactShade");
  });
  it("high: own cache key, three's shadow lookups untouched, the contact lookup after the AO", () => {
    const m = new THREE.MeshStandardMaterial(),
      U = makeCloudUniforms();
    patchCloudShadow(m, U);
    const key = m.customProgramCacheKey(),
      v = m.version;
    expect(setTierVariant(m, { contact: true })).toBe(true);
    expect(m.version).toBeGreaterThan(v); // recompiles
    expect(m.customProgramCacheKey()).toBe(`${key}c`);
    const sh = compile(m);
    // soft sun shadows are three's PCF taps (shadow.radius): its getShadow, no lookup of ours
    expect(sh.fragmentShader).toContain("getShadow( directionalShadowMap[ i ]");
    expect(sh.fragmentShader).toContain("getPointShadow( pointShadowMap[ i ]");
    expect(sh.fragmentShader).toMatch(
      /#include <aomap_fragment>\s*\{\s*float fpC = fpContactShade/,
    );
    expect(sh.uniforms.fpContactMap).toBe(U.fpContactMap);
    expect(setTierVariant(m, { contact: false })).toBe(true);
    expect(m.customProgramCacheKey()).toBe(key);
    expect(compile(m).fragmentShader).not.toContain("fpContactShade(");
  });
  it("unpatched materials are left alone", () => {
    const m = new THREE.MeshBasicMaterial();
    expect(setTierVariant(m, { contact: true })).toBe(false);
    expect(m.userData.fpContact).toBe(undefined);
  });
});
