import { describe, it, expect } from "bun:test";
import * as THREE from "three";
import {
  pcssFrame,
  penumbraM,
  kernelTexels,
  pcssDirectional,
  PCSS_SUN_TAN,
  PCSS_MIN_TEXELS,
  PCSS_MAX_TEXELS,
} from "../src/soft-shadow.ts";
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

describe("soft sun shadows (PCSS)", () => {
  it("pcssFrame: depth range and map span of the orthographic shadow camera", () => {
    expect(pcssFrame({ near: 0.5, far: 60.5, left: -12, right: 12 })).toEqual([
      60,
      24,
      PCSS_SUN_TAN,
      1,
    ]);
    expect(
      pcssFrame({ near: 1, far: 1, left: 0, right: 0 }, 0.01)[0],
    ).toBeGreaterThan(0); // never 0
  });
  it("penumbra grows with the blocker distance, clouds widen it", () => {
    expect(penumbraM(0)).toBe(0);
    expect(penumbraM(3)).toBeCloseTo(3 * PCSS_SUN_TAN);
    expect(penumbraM(6)).toBeCloseTo(2 * penumbraM(3));
    expect(penumbraM(3, PCSS_SUN_TAN, 4)).toBeCloseTo(4 * penumbraM(3));
    expect(penumbraM(-1)).toBe(0);
  });
  it("kernel radius in texels, clamped", () => {
    expect(kernelTexels(0, 24, 2048)).toBe(PCSS_MIN_TEXELS);
    expect(kernelTexels(0.06, 24, 2048)).toBeCloseTo(5.12);
    expect(kernelTexels(5, 24, 2048)).toBe(PCSS_MAX_TEXELS);
  });
  it("pcssDirectional swaps only the directional lookup of three's light loop", () => {
    const src = THREE.ShaderChunk.lights_fragment_begin,
      out = pcssDirectional(src);
    expect(out).toContain("fpPcssShadow( directionalShadowMap[ i ]");
    expect(out).not.toContain("getShadow( directionalShadowMap");
    expect(out).toContain("getShadow( spotShadowMap[ i ]"); // lamps keep three's sampling
    expect(pcssDirectional("no light loop")).toBe(null);
  });
});

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
  it("standard: cache key and shader as before (no PCSS, no contact lookup)", () => {
    const m = new THREE.MeshStandardMaterial();
    patchCloudShadow(m, makeCloudUniforms());
    const key = m.customProgramCacheKey();
    expect(setTierVariant(m, { pcss: false, contact: false })).toBe(false); // nothing to change, userData untouched
    expect(m.userData.fpPcss).toBe(undefined);
    expect(m.customProgramCacheKey()).toBe(key);
    expect(tierKey(m)).toBe("");
    const sh = compile(m);
    expect(sh.fragmentShader).not.toContain("fpPcssShadow");
    expect(sh.fragmentShader).not.toContain("fpContactShade");
  });
  it("high: own cache key, PCSS for the directional lights and the contact lookup after the AO", () => {
    const m = new THREE.MeshStandardMaterial(),
      U = makeCloudUniforms();
    patchCloudShadow(m, U);
    const key = m.customProgramCacheKey(),
      v = m.version;
    expect(setTierVariant(m, { pcss: true, contact: true })).toBe(true);
    expect(m.version).toBeGreaterThan(v); // recompiles
    expect(m.customProgramCacheKey()).toBe(`${key}pc`);
    const sh = compile(m);
    expect(sh.fragmentShader).toContain(
      "fpPcssShadow( directionalShadowMap[ i ]",
    );
    expect(sh.fragmentShader).toContain("float fpPcssShadow(");
    expect(sh.fragmentShader).toMatch(
      /#include <aomap_fragment>\s*\{\s*float fpC = fpContactShade/,
    );
    expect(sh.uniforms.fpPcss).toBe(U.fpPcss);
    expect(sh.uniforms.fpContactMap).toBe(U.fpContactMap);
    expect(setTierVariant(m, { pcss: true, contact: false })).toBe(true);
    expect(m.customProgramCacheKey()).toBe(`${key}p`);
    expect(compile(m).fragmentShader).not.toContain("fpContactShade(");
  });
  it("unpatched materials are left alone", () => {
    const m = new THREE.MeshBasicMaterial();
    expect(setTierVariant(m, { pcss: true, contact: true })).toBe(false);
    expect(m.userData.fpPcss).toBe(undefined);
  });
});
