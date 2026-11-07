import { describe, it, expect } from "bun:test";
import * as THREE from "three";
import {
  nameSurface,
  classifyMaterial,
  normMaterialRules,
  ruleMatches,
} from "../src/material-class.ts";
import {
  surfaceParams,
  surfacePlugin,
  SURFACE_LOOK,
  GLASS_FRESNEL,
} from "../src/physical-materials.ts";
import {
  gltfMaterialFacts,
  materialExtensions,
} from "../src/material-facts.ts";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  patchCloudShadow,
  makeCloudUniforms,
  tierKey,
} from "../src/cloud-shadow.ts";
import { normRender, normRenderOption } from "../src/render-recipe.ts";

// a mesh use as the heuristics see it
const use = (o = {}) => ({
  name: "",
  groups: [],
  layers: [],
  object: false,
  indoor: true,
  floorTop: false,
  chain: [],
  ...o,
});
const facts = (o = {}) => ({
  name: "",
  physical: false,
  transparent: false,
  opacity: 1,
  textured: false,
  emissive: false,
  uses: [use()],
  ...o,
});

describe("material classes: names", () => {
  it("glass, fabric and floor words", () => {
    expect(nameSurface("Glass")).toBe("glass");
    expect(nameSurface("window_pane_living")).toBe("glass");
    expect(nameSurface("Glazing.001")).toBe("glass");
    expect(nameSurface("sofa_body")).toBe("fabric");
    expect(nameSurface("Curtain_L")).toBe("fabric");
    expect(nameSurface("master_bed_body")).toBe("fabric");
    expect(nameSurface("Floor_Kitchen")).toBe("floor");
    expect(nameSurface("parquet")).toBe("floor");
    expect(nameSurface("Tiles2")).toBe("floor");
    expect(nameSurface("oak wood")).toBe("floor");
  });
  it("words only: bedroom, fiberglass, panel and window frames are none of them", () => {
    expect(nameSurface("bedroom_wall")).toBe(null);
    expect(nameSurface("fiberglass")).toBe(null);
    expect(nameSurface("panel")).toBe(null);
    expect(nameSurface("window_frame")).toBe(null);
    expect(nameSurface("Plaster")).toBe(null);
    expect(nameSurface("")).toBe(null);
  });
  it("rugs and carpets are fabric, not floors; a window curtain is fabric, a glass curtain wall glass", () => {
    expect(nameSurface("floor_rug")).toBe("fabric");
    expect(nameSurface("Carpet_floor")).toBe("fabric");
    expect(nameSurface("window_curtain")).toBe("fabric");
    expect(nameSurface("glass_curtain_wall")).toBe("glass");
  });
});

describe("material classes: heuristics", () => {
  it("the material name decides first", () => {
    expect(classifyMaterial(facts({ name: "Glass" }))).toBe("glass");
    expect(
      classifyMaterial(
        facts({ name: "Velvet_sofa", uses: [use({ name: "Cube.001" })] }),
      ),
    ).toBe("fabric");
  });
  it("else every mesh using it must agree", () => {
    expect(
      classifyMaterial(
        facts({
          uses: [use({ name: "sofa_body" }), use({ name: "bed_body" })],
        }),
      ),
    ).toBe("fabric");
    expect(
      classifyMaterial(
        facts({ uses: [use({ name: "sofa_body" }), use({ name: "wall" })] }),
      ),
    ).toBe(null);
    expect(
      classifyMaterial(
        facts({ uses: [use({ floorTop: true }), use({ floorTop: true })] }),
      ),
    ).toBe("floor");
    expect(
      classifyMaterial(
        facts({ uses: [use({ floorTop: true }), use({ name: "wall" })] }),
      ),
    ).toBe(null); // shared with a wall
  });
  it("a cushion inside a Sofa group is fabric; the glass layer is glass", () => {
    expect(
      classifyMaterial(
        facts({ uses: [use({ name: "Cube.003", groups: ["Sofa"] })] }),
      ),
    ).toBe("fabric");
    expect(
      classifyMaterial(
        facts({ uses: [use({ name: "Cube", layers: ["glass"] })] }),
      ),
    ).toBe("glass");
  });
  it("floors only indoors: paving outside keeps its look", () => {
    expect(
      classifyMaterial(
        facts({ name: "tiles", uses: [use({ indoor: false })] }),
      ),
    ).toBe(null);
    expect(
      classifyMaterial(
        facts({ uses: [use({ name: "exterior_floor_5", indoor: false })] }),
      ),
    ).toBe(null);
  });
  it("see-through untextured materials are thin glass", () => {
    expect(classifyMaterial(facts({ transparent: true, opacity: 0.35 }))).toBe(
      "glass",
    );
    expect(
      classifyMaterial(
        facts({ transparent: true, opacity: 0.35, textured: true }),
      ),
    ).toBe(null); // a decal
    expect(
      classifyMaterial(
        facts({ transparent: true, opacity: 0.35, emissive: true }),
      ),
    ).toBe(null);
    expect(classifyMaterial(facts({ transparent: true, opacity: 0.9 }))).toBe(
      null,
    );
  });
  it("KHR_materials_* / unlit (as the file says) and model objects are never touched, not even by rules", () => {
    const rules = [{ sel: "all", surface: "glass" }];
    expect(
      classifyMaterial(facts({ name: "Glass", physical: true }), rules),
    ).toBe(null);
    expect(
      classifyMaterial(
        facts({ name: "Glass", uses: [use({ object: true })] }),
        rules,
      ),
    ).toBe(null);
    expect(
      classifyMaterial(facts({ uses: [use(), use({ object: true })] }), rules),
    ).toBe(null);
  });
});

describe("material classes: explicit rules", () => {
  const chain = [
    { tag: null, layers: [], path: "house/level0/living_room/Rug" },
    {
      tag: {
        kind: "room",
        id: "living_room",
        role: null,
        type: null,
        group: null,
      },
      layers: [],
      path: "house/level0/living_room",
    },
  ];
  it("selectors: material:<name glob>, node:, room:, layer:", () => {
    const m = facts({ name: "Oak_Light", uses: [use({ chain })] });
    expect(ruleMatches("material:oak*", m)).toBe(true);
    expect(ruleMatches("material:Pine", m)).toBe(false);
    expect(ruleMatches("node:**/Rug", m)).toBe(true);
    expect(ruleMatches("room:living_room", m)).toBe(true); // an ancestor matches
    expect(ruleMatches("room:kitchen", m)).toBe(false);
    expect(
      ruleMatches(
        "layer:rugs",
        facts({
          uses: [use({ chain: [{ tag: null, layers: ["rugs"], path: "x" }] })],
        }),
      ),
    ).toBe(true);
  });
  it("opt in, opt out, later rules win, rules beat the heuristics", () => {
    const m = facts({ name: "Oak_Light", uses: [use({ chain })] });
    expect(classifyMaterial(m)).toBe(null);
    expect(
      classifyMaterial(m, [{ sel: "material:Oak*", surface: "floor" }]),
    ).toBe("floor"); // opt in
    expect(
      classifyMaterial(m, [
        { sel: "material:Oak*", surface: "floor" },
        { sel: "node:**/Rug", surface: "fabric" },
      ]),
    ).toBe("fabric");
    expect(
      classifyMaterial(facts({ name: "Glass" }), [
        { sel: "material:glass", surface: "none" },
      ]),
    ).toBe(null); // opt out
    expect(
      classifyMaterial(
        facts({ name: "tiles", uses: [use({ indoor: false })] }),
        [{ sel: "all", surface: "floor" }],
      ),
    ).toBe("floor"); // outdoors too
  });
  it("material extras fp_surface, overridden by the rules", () => {
    expect(classifyMaterial(facts({ name: "Plaster", extras: "floor" }))).toBe(
      "floor",
    );
    expect(classifyMaterial(facts({ name: "Glass", extras: "none" }))).toBe(
      null,
    );
    expect(
      classifyMaterial(facts({ name: "Plaster", extras: "floor" }), [
        { sel: "material:Plaster", surface: "none" },
      ]),
    ).toBe(null);
    expect(classifyMaterial(facts({ name: "Glass", extras: "bogus" }))).toBe(
      "glass",
    ); // invalid extras: ignored
  });
  it("normMaterialRules: selector -> class, in order, with warnings", () => {
    expect(
      normMaterialRules({
        "material:Glass*": "glass",
        "layer:rugs": "None",
        "node:**/Floor": "floor",
      }),
    ).toEqual({
      rules: [
        { sel: "material:Glass*", surface: "glass" },
        { sel: "layer:rugs", surface: "none" },
        { sel: "node:**/Floor", surface: "floor" },
      ],
      warnings: [],
    });
    const bad = normMaterialRules({
      "shiny:x": "glass",
      "layer:a": "metal",
      "material:": "glass",
    });
    expect(bad.rules).toEqual([]);
    expect(bad.warnings).toHaveLength(3);
    expect(normMaterialRules(["glass"]).warnings[0]).toMatch(/needs an object/);
    expect(normMaterialRules(undefined)).toEqual({ rules: [], warnings: [] });
  });
  it("the model recipe and the card option carry the rules", () => {
    const r = normRender({
      materials: { "material:Glass": "none", x: "glass" },
    });
    expect(r.recipe.materials).toEqual([
      { sel: "material:Glass", surface: "none" },
    ]);
    expect(r.warnings.join()).toMatch(/render.materials: "x"/);
    const o = normRenderOption({
      quality: "high",
      materials: { "layer:rugs": "fabric" },
    });
    expect(o.option.materials).toEqual([
      { sel: "layer:rugs", surface: "fabric" },
    ]);
    expect(o.warnings).toEqual([]);
    expect("materials" in normRenderOption({ quality: "high" }).option).toBe(
      false,
    ); // absent unless given
  });
});

// --- glTF documents: the facts read the JSON only (accessor min / max, no buffers) ---
const box = (min, max) => ({
  min,
  max,
  count: 3,
  type: "VEC3",
  componentType: 5126,
});
const level0 = {
  kind: "level",
  id: "level0",
  role: "storey",
  elevation: 0,
  height: 2.7,
};
const living = {
  kind: "room",
  id: "living",
  outline: [
    [0, 0],
    [4, 0],
    [4, 3],
    [0, 3],
  ],
};
function houseDoc() {
  return {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "level0", extras: { fp: level0 }, children: [1, 2] },
      { name: "living", extras: { fp: living }, children: [3, 4, 6] },
      { name: "wall", mesh: 1, translation: [0, 1.35, 0] },
      { name: "slab", mesh: 0, translation: [0, -0.1, 0] },
      { name: "Sofa", children: [5] },
      { name: "Cube.001", mesh: 2 },
      {
        name: "lamp",
        extras: { fp: { kind: "object", id: "lamp", type: "light" } },
        children: [7],
      },
      { name: "shade", mesh: 3 },
    ],
    meshes: [0, 1, 2, 3].map((i) => ({
      primitives: [{ attributes: { POSITION: i }, material: i }],
    })),
    accessors: [
      box([-2, -0.1, -1.5], [2, 0.1, 1.5]),
      box([-2, -1.35, -0.075], [2, 1.35, 0.075]),
      box([-0.5, 0, -0.25], [0.5, 0.2, 0.25]),
      box([-0.1, -0.1, -0.1], [0.1, 0.1, 0.1]),
    ],
    materials: [
      {},
      {},
      {},
      {
        name: "glass",
        alphaMode: "BLEND",
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.4] },
      },
    ],
  };
}

describe("material facts from the glTF JSON", () => {
  it("rooms, floor surfaces, objects, groups, as the classes see them", () => {
    const { materials: f } = gltfMaterialFacts(houseDoc());
    expect(f[0].uses[0]).toMatchObject({
      name: "slab",
      floorTop: true,
      indoor: true,
      object: false,
    });
    expect(f[1].uses[0]).toMatchObject({ floorTop: false, indoor: true });
    expect(f[2].uses[0].groups).toEqual(["Sofa"]);
    expect(f[3].uses[0].object).toBe(true);
    expect(f[3]).toMatchObject({
      name: "glass",
      transparent: true,
      opacity: 0.4,
    });
    expect(f[0].uses[0].chain.map((n) => n.path)).toEqual([
      "level0/living/slab",
      "level0/living",
      "level0",
    ]);
    expect(classifyMaterial(f[0])).toBe("floor");
    expect(classifyMaterial(f[1])).toBe(null);
    expect(classifyMaterial(f[2])).toBe("fabric");
    expect(classifyMaterial(f[3])).toBe(null); // the card drives objects
    expect(
      classifyMaterial(f[1], [{ sel: "level:level0", surface: "fabric" }]),
    ).toBe("fabric");
  });
  it("node transforms place the boxes; a level without elevation is measured", () => {
    const d = houseDoc();
    d.nodes[0].extras.fp = { ...level0, elevation: undefined };
    d.nodes[0].translation = [0, 3, 0]; // the slab top at 3: the measured storey floor
    expect(gltfMaterialFacts(d).materials[0].uses[0].floorTop).toBe(true);
    d.nodes[3].translation = [0, 0.5, 0]; // a shelf 0.6 m over the level's lowest point
    d.nodes[2].translation = [0, 1.35, 0];
    const f = gltfMaterialFacts(d).materials[0].uses[0];
    expect(f.floorTop).toBe(false);
  });
  it("multi-primitive meshes, shared and unused materials, KHR and unlit materials", () => {
    const d = houseDoc();
    d.meshes[2] = {
      name: "SofaMesh",
      primitives: [
        { attributes: { POSITION: 2 }, material: 2 },
        { attributes: { POSITION: 2 }, material: 1 },
      ],
    };
    d.nodes[5].name = "Couch";
    d.materials.push(
      {
        name: "Glass",
        extensions: { KHR_materials_transmission: { transmissionFactor: 1 } },
      },
      { name: "Glass", extensions: { KHR_materials_unlit: {} } },
      {
        name: "Glow",
        extensions: {
          KHR_materials_emissive_strength: { emissiveStrength: 5 },
        },
        emissiveFactor: [1, 1, 1],
      },
    );
    const { materials: f } = gltfMaterialFacts(d);
    expect(f[2].uses[0]).toMatchObject({
      name: "SofaMesh",
      groups: ["Couch", "Sofa"],
    });
    expect(f[1].uses).toHaveLength(2); // the wall and the second primitive
    expect(classifyMaterial(f[1])).toBe(null); // they disagree
    expect(f[4]).toMatchObject({ physical: true, uses: [] });
    expect(f[5].physical).toBe(true);
    expect(f[6]).toMatchObject({ physical: false, emissive: true });
    expect(materialExtensions(d)).toEqual({
      KHR_materials_transmission: 1,
      KHR_materials_unlit: 1,
      KHR_materials_emissive_strength: 1,
    });
  });
});

describe("physical materials at load (GLTFLoader plugin)", () => {
  it("surfaceParams: the class's look on the loader's parameters", () => {
    const g = { roughness: 0.3, metalness: 0.2, userData: { keep: 1 } };
    surfaceParams("glass", g);
    expect(g).toMatchObject({
      roughness: SURFACE_LOOK.glass.roughness,
      metalness: 0,
      ior: 1.5,
      specularIntensity: 1,
      userData: { keep: 1, fpSurface: "glass", fpGlass: true },
    });
    const f = { roughness: 0.6 };
    surfaceParams("floor", f);
    expect(f).toMatchObject({
      roughness: 0.6,
      clearcoat: 0.4,
      clearcoatRoughness: 0.2,
    });
    expect(f.userData).toEqual({ fpSurface: "floor" });
    const c = {};
    surfaceParams("fabric", c);
    expect(c.sheen).toBe(1);
    expect(c.sheenColor.r).toBeCloseTo(SURFACE_LOOK.fabric.sheenColor);
    const m = new THREE.MeshPhysicalMaterial(c);
    expect(m.sheenColor.r).toBeCloseTo(SURFACE_LOOK.fabric.sheenColor);
  });

  // one triangle in a GLB (the buffer in its BIN chunk, nothing fetched): GLTFLoader builds real materials
  const tri = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]).buffer);
  const glb = (json) => {
    const pad = (b, c) =>
      Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, c)]);
    const j = pad(Buffer.from(JSON.stringify(json)), 0x20),
      bin = pad(tri, 0);
    const chunk = (type, data) => {
      const h = Buffer.alloc(8);
      h.writeUInt32LE(data.length, 0);
      h.writeUInt32LE(type, 4);
      return Buffer.concat([h, data]);
    };
    const body = Buffer.concat([chunk(0x4e4f534a, j), chunk(0x004e4942, bin)]);
    const head = Buffer.alloc(12);
    head.write("glTF", 0, "ascii");
    head.writeUInt32LE(2, 4);
    head.writeUInt32LE(12 + body.length, 8);
    const all = Buffer.concat([head, body]);
    return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
  };
  function loadable(materials, rootExtras) {
    return {
      asset: { version: "2.0" },
      extensionsUsed: ["KHR_materials_transmission"],
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [
        {
          name: "house",
          extras: rootExtras,
          children: materials.map((_, i) => i + 1),
        },
        ...materials.map((_, i) => ({ name: `part${i}`, mesh: i })),
      ],
      meshes: materials.map((_, i) => ({
        primitives: [{ attributes: { POSITION: 0 }, material: i }],
      })),
      accessors: [{ ...box([0, 0, 0], [1, 0, 1]), bufferView: 0 }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
      materials,
    };
  }
  const MATS = [
    {
      name: "Window glass",
      alphaMode: "BLEND",
      pbrMetallicRoughness: {
        baseColorFactor: [0.8, 0.9, 1, 0.3],
        roughnessFactor: 0.5,
        metallicFactor: 0,
      },
    },
    { name: "Boards", extras: { fp_surface: "floor" } },
    {
      name: "Glass",
      extensions: { KHR_materials_transmission: { transmissionFactor: 1 } },
    },
    { name: "Sofa fabric" },
    { name: "Wall" },
  ];
  const load = async (opts, rootExtras) => {
    const loader = new GLTFLoader().register(surfacePlugin(opts));
    const gltf = await loader.parseAsync(glb(loadable(MATS, rootExtras)), "");
    const out = {};
    gltf.scene.traverse((o) => {
      if (o.isMesh) out[o.material.name] = o.material;
    });
    return { out, root: gltf.scene };
  };

  it("thin glass is its own program variant of the cloud patch", async () => {
    const { out } = await load();
    const std = out.Wall,
      glass = out["Window glass"];
    patchCloudShadow(std, makeCloudUniforms());
    patchCloudShadow(glass, makeCloudUniforms());
    expect(tierKey(std)).toBe("");
    expect(tierKey(glass)).toBe("g");
    const sh = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    };
    glass.onBeforeCompile(sh, null);
    expect(sh.fragmentShader).toContain(GLASS_FRESNEL.trim().split("\n")[0]);
    expect(sh.fragmentShader.indexOf("fpC")).toBeLessThan(
      sh.fragmentShader.indexOf("#include <opaque_fragment>"),
    );
  });
});
