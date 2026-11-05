import { describe, it, expect } from "bun:test";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { lampPlugin, findLamp, lampOf } from "../src/objects/model-lamps.ts";
import { buildManifest, threeAdapter } from "../src/manifest.ts";
import { hintDefaults } from "../src/objects/types.ts";

// a glTF without buffers (nothing to fetch): two light objects with KHR_lights_punctual lamps, one stray sun
const doc = {
  asset: { version: "2.0" },
  extensionsUsed: ["KHR_lights_punctual"],
  extensions: {
    KHR_lights_punctual: {
      lights: [
        {
          type: "spot",
          intensity: 150,
          range: 7,
          spot: { innerConeAngle: 0.2, outerConeAngle: 0.4 },
        },
        { type: "point", intensity: 60 },
        { type: "directional", intensity: 3 },
      ],
    },
  },
  scene: 0,
  scenes: [{ nodes: [0, 2, 3] }],
  nodes: [
    {
      name: "desk_lamp",
      extras: { fp: { kind: "object", id: "desk_lamp", type: "light" } },
      children: [1],
    },
    {
      name: "bulb",
      translation: [0, 0.4, 0],
      extensions: { KHR_lights_punctual: { light: 0 } },
    },
    {
      name: "porch",
      translation: [3, 2.4, 0],
      extras: {
        fp: {
          kind: "object",
          id: "porch",
          type: "light",
          hints: { lumens: 900 },
        },
      },
      extensions: { KHR_lights_punctual: { light: 1 } },
    },
    { name: "sun", extensions: { KHR_lights_punctual: { light: 2 } } },
  ],
};

describe("model lamps (KHR_lights_punctual)", () => {
  it("GLTFLoader's lights become plain nodes the light objects read", async () => {
    const loader = new GLTFLoader().register(lampPlugin());
    const gltf = await loader.parseAsync(JSON.stringify(doc), "");
    const root = gltf.scene;
    let lights = 0;
    root.traverse((o) => {
      if (o.isLight) lights++;
    });
    expect(lights).toBe(0); // nothing lights the scene on its own
    const m = buildManifest(threeAdapter(root));
    expect(m.objects.map((o) => o.id).sort()).toEqual(["desk_lamp", "porch"]);
    const desk = m.objects.find((o) => o.id === "desk_lamp"),
      porch = m.objects.find((o) => o.id === "porch");
    const bulb = findLamp(desk.node);
    expect(bulb.name).toBe("bulb");
    expect(bulb.position.y).toBeCloseTo(0.4);
    expect(lampOf(bulb)).toEqual({
      beam: "spot",
      candela: 150,
      range: 7,
      angle: expect.closeTo((0.4 * 180) / Math.PI, 6),
      penumbra: expect.closeTo(0.5, 6),
    });
    expect(findLamp(porch.node)).toBe(porch.node); // the object node is the lamp itself
    expect(lampOf(porch.node)).toMatchObject({ beam: "point", candela: 60 });
    expect(porch.node.userData.fp.id).toBe("porch"); // its tag kept
    expect(findLamp(root.getObjectByName("sun"))).toBe(null); // a sun is not a lamp
    expect(gltf.parser.associations.get(bulb)).toEqual({ nodes: 1 });
    const h = hintDefaults(desk.hints, lampOf(bulb));
    expect(h).toMatchObject({ beam: "spot", distance: 7, candela: 150 });
    expect(h.angle).toBeCloseTo((0.4 * 180) / Math.PI);
    expect(hintDefaults(porch.hints, lampOf(porch.node))).toMatchObject({
      beam: "point",
      lumens: 900,
      candela: 60, // the file's intensity comes first; lumens is the fallback
    });
  });
});
