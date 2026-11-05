import { describe, it, expect } from "bun:test";
import * as THREE from "three";
import {
  pcssFrame,
  penumbraM,
  kernelTexels,
  pcssLightLoop,
  PCSS_HEAD,
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
  it("pcssLightLoop swaps the directional and point lookups of three's light loop", () => {
    const src = THREE.ShaderChunk.lights_fragment_begin,
      out = pcssLightLoop(src);
    expect(out).toContain("fpPcssShadow( directionalShadowMap[ i ]");
    expect(out).not.toContain("getShadow( directionalShadowMap");
    expect(out).toContain("fpPointShadow( pointShadowMap[ i ]");
    expect(out).not.toContain("getPointShadow( pointShadowMap");
    expect(out).toContain("getShadow( spotShadowMap[ i ]"); // spots cast no shadow here: three's lookup
    expect(pcssLightLoop("no light loop")).toBe(null);
  });
});

// A GLSL preprocessor just big enough for three's shadow chunks: #if / #ifdef / #ifndef / #elif / #else / #endif
// and object-like #define, over defines { NAME: value }. -> the active lines, defines added.
function preprocess(src, defines) {
  const defs = { ...defines },
    out = [],
    stack = []; // stack: { on, taken, parent }
  const active = () => stack.every((f) => f.on);
  const evalIf = (expr) => {
    const js = expr
      .replace(/defined\s*\(\s*(\w+)\s*\)|defined\s+(\w+)/g, (_, a, b) =>
        (a || b) in defs ? "1" : "0",
      )
      .replace(/\b[A-Za-z_]\w*\b/g, (n) =>
        n in defs && defs[n] !== "" ? String(Number(defs[n]) || 0) : "0",
      );
    return !!Function(`return (${js});`)();
  };
  for (const line of src.split("\n")) {
    const m = /^\s*#\s*(\w+)\s*(.*)$/.exec(line);
    if (!m) {
      if (active()) out.push(line);
      continue;
    }
    const [, dir, rest] = m;
    if (dir === "if" || dir === "ifdef" || dir === "ifndef") {
      const parent = active();
      const on =
        parent &&
        (dir === "if"
          ? evalIf(rest)
          : dir === "ifdef"
            ? rest.trim() in defs
            : !(rest.trim() in defs));
      stack.push({ on, taken: on });
    } else if (dir === "elif") {
      const f = stack.at(-1),
        parent = stack.slice(0, -1).every((x) => x.on);
      f.on = parent && !f.taken && evalIf(rest);
      f.taken ||= f.on;
    } else if (dir === "else") {
      const f = stack.at(-1),
        parent = stack.slice(0, -1).every((x) => x.on);
      f.on = parent && !f.taken;
      f.taken = true;
    } else if (dir === "endif") stack.pop();
    else if (dir === "define" && active()) {
      const [name, ...v] = rest.trim().split(/\s+/);
      defs[name] = v.join(" ");
      out.push(line);
    } else if (active()) out.push(line);
  }
  return { code: out.join("\n"), defs };
}

// Functions a GLSL fragment calls that it does not define (and that are not GLSL built-ins).
const BUILTINS = new Set([
  "texture2D",
  "textureCube",
  "texture",
  "step",
  "mix",
  "clamp",
  "sqrt",
  "cos",
  "sin",
  "fract",
  "dot",
  "normalize",
  "abs",
  "max",
  "min",
  "length",
  "cross",
  "vec2",
  "vec3",
  "vec4",
  "float",
  "int",
  "bool",
  "if",
  "for",
  "while",
  "return",
]);
const strip = (code) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const calls = (code) =>
  new Set([...strip(code).matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]));
const definedFns = (code) =>
  new Set(
    [
      ...code.matchAll(
        /\b(?:float|vec[234]|void|bool|int)\s+([A-Za-z_]\w*)\s*\(/g,
      ),
    ].map((m) => m[1]),
  );
// The declared type of a uniform array (e.g. directionalShadowMap) and the first parameter type of a function.
const uniformType = (code, name) =>
  (new RegExp(`uniform\\s+(\\w+)\\s+${name}\\s*\\[`).exec(code) || [])[1];
const firstParam = (code, fn) =>
  (new RegExp(`\\b${fn}\\s*\\(\\s*(\\w+)\\s+\\w+`).exec(code) || [])[1];

describe("soft shadow GLSL against three's shadow chunks", () => {
  const LIGHTS = {
    USE_SHADOWMAP: "",
    NUM_DIR_LIGHT_SHADOWS: 1,
    NUM_POINT_LIGHT_SHADOWS: 2,
    NUM_SPOT_LIGHT_SHADOWS: 0,
    NUM_SUN_LIGHT_SHADOWS: 0,
    NUM_SPOT_LIGHT_COORDS: 0,
    NUM_SPOT_LIGHT_MAPS: 0,
  };
  const build = (type) => {
    const defines = { ...LIGHTS, [type]: "" };
    const lib = preprocess(
      [
        THREE.ShaderChunk.common,
        THREE.ShaderChunk.packing,
        THREE.ShaderChunk.shadowmap_pars_fragment,
      ].join("\n"),
      defines,
    );
    const head = preprocess(PCSS_HEAD, lib.defs);
    return { lib: lib.code, head: head.code, defs: head.defs };
  };
  it("Basic maps (the soft-shadow tier): the functions take the sampler types three declares, and call only what exists", () => {
    const { lib, head } = build("SHADOWMAP_TYPE_BASIC");
    expect(uniformType(lib, "directionalShadowMap")).toBe("sampler2D");
    expect(firstParam(head, "fpPcssShadow")).toBe(
      uniformType(lib, "directionalShadowMap"),
    );
    expect(firstParam(head, "fpPointShadow")).toBe(
      uniformType(lib, "pointShadowMap"),
    );
    const known = new Set([
      ...BUILTINS,
      ...definedFns(lib),
      ...definedFns(head),
    ]);
    expect([...calls(head)].filter((f) => !known.has(f))).toEqual([]);
  });
  it("PCF maps (sampler2DShadow): three's lookups by name instead, no function of ours", () => {
    const { lib, head, defs } = build("SHADOWMAP_TYPE_PCF");
    expect(uniformType(lib, "directionalShadowMap")).toBe("sampler2DShadow");
    expect(definedFns(head).size).toBe(0);
    expect(defs.fpPcssShadow).toBe("getShadow");
    expect(defs.fpPointShadow).toBe("getPointShadow");
    expect(
      definedFns(lib).has("getShadow") && definedFns(lib).has("getPointShadow"),
    ).toBe(true);
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
