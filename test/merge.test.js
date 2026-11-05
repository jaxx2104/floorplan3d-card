import { describe, it, expect } from "bun:test";
import {
  mergeGroups,
  geometrySignature,
  fnv1a,
  mergedName,
  namedGroups,
} from "../src/merge.ts";

// fake three.js-like nodes
const attr = (count, itemSize = 3, Arr = Float32Array) => ({
  count,
  itemSize,
  normalized: false,
  array: new Arr(count * itemSize),
});
const geo = ({ count = 4, uv = true, index = true, color = false } = {}) => ({
  attributes: {
    position: attr(count),
    normal: attr(count),
    ...(uv ? { uv: attr(count, 2) } : {}),
    ...(color ? { color: attr(count, 4) } : {}),
  },
  index: index ? attr(6, 1, Uint16Array) : null,
  morphAttributes: {},
});
const mat = (uuid, extra = {}) => ({
  uuid,
  name: "",
  transparent: false,
  opacity: 1,
  userData: {},
  ...extra,
});
const group = (name, parent = null, extra = {}) => {
  const g = {
    name,
    parent,
    children: [],
    userData: {},
    visible: true,
    ...extra,
  };
  if (parent) parent.children.push(g);
  return g;
};
const mesh = (name, parent, material, extra = {}) => {
  const m = {
    isMesh: true,
    name,
    parent,
    children: [],
    userData: {},
    visible: true,
    material,
    geometry: geo(),
    castShadow: true,
    receiveShadow: true,
    renderOrder: 0,
    layers: { mask: 1 },
    ...extra,
  };
  if (parent) parent.children.push(m);
  return m;
};

function scene() {
  const root = group("Scene");
  const level = group("ground", root);
  const kitchen = group("kitchen", level);
  const living = group("living", level);
  const lamp = group("lamp", kitchen);
  const sub = group("", kitchen); // unnamed sub-part
  const tags = new Map([
    [level, "tag"],
    [kitchen, "tag"],
    [living, "tag"],
    [lamp, "object"],
  ]);
  return { root, level, kitchen, living, lamp, sub, tags };
}
const optsFor = (s, extra = {}) => ({
  root: s.root,
  kindOf: (n) => s.tags.get(n) || null,
  isOwner: () => false,
  keep: new Set(),
  ...extra,
});
const names = (groups) =>
  groups.map((g) =>
    g.meshes
      .map((m) => m.name)
      .sort()
      .join(","),
  );

describe("mergeGroups", () => {
  it("groups meshes of one owner and material, nearest tagged ancestor owns (unnamed groups pass through)", () => {
    const s = scene(),
      wood = mat("wood");
    mesh("a", s.kitchen, wood);
    mesh("b", s.sub, wood);
    mesh("c", s.kitchen, wood);
    const g = mergeGroups(
      [...s.kitchen.children, ...s.sub.children].filter((m) => m.isMesh),
      optsFor(s),
    );
    expect(g).toHaveLength(1);
    expect(g[0].owner).toBe(s.kitchen);
    expect(names(g)).toEqual(["a,b,c"]);
    expect(g[0].vertices).toBe(12);
  });

  it("different materials and different owners never share a group", () => {
    const s = scene(),
      wood = mat("wood"),
      tile = mat("tile");
    const ms = [
      mesh("k1", s.kitchen, wood),
      mesh("k2", s.kitchen, wood),
      mesh("k3", s.kitchen, tile),
      mesh("k4", s.kitchen, tile),
      mesh("l1", s.living, wood),
      mesh("l2", s.living, wood),
    ];
    const g = mergeGroups(ms, optsFor(s));
    expect(names(g).sort()).toEqual(["k1,k2", "k3,k4", "l1,l2"]);
    expect(g.find((x) => x.meshes[0].name === "l1").owner).toBe(s.living);
  });

  it("a group of one is not returned", () => {
    const s = scene();
    expect(
      mergeGroups(
        [mesh("a", s.kitchen, mat("a")), mesh("b", s.kitchen, mat("b"))],
        optsFor(s),
      ),
    ).toEqual([]);
  });

  it("meshes without a tagged ancestor are owned by the root", () => {
    const s = scene(),
      m = mat("m");
    const loose = group("", s.root);
    const g = mergeGroups(
      [mesh("a", loose, m), mesh("b", s.root, m)],
      optsFor(s),
    );
    expect(g).toHaveLength(1);
    expect(g[0].owner).toBe(s.root);
  });

  it("excludes the subtree of an object (lamp, glow) even below a layer group", () => {
    const s = scene(),
      m = mat("m");
    const shade = group("shade", s.lamp, {
      userData: { fp: { layer: "light" } },
    });
    const ms = [
      mesh("glow", s.lamp, m),
      mesh("bulb", s.lamp, m),
      mesh("s1", shade, m),
      mesh("s2", shade, m),
    ];
    expect(
      mergeGroups(ms, optsFor(s, { isOwner: (n) => n === shade })),
    ).toEqual([]);
  });

  it("excludes transparent, see-through and glass meshes", () => {
    const s = scene();
    const clear = mat("clear", { transparent: true }),
      half = mat("half", { opacity: 0.5 }),
      ghost = mat("ghost", { userData: { wasTransparent: true } });
    const glassMat = mat("g", { name: "Glass" }),
      trans = mat("t", { transmission: 1 }),
      plain = mat("p");
    const ms = [
      mesh("a", s.kitchen, clear),
      mesh("b", s.kitchen, clear),
      mesh("c", s.kitchen, half),
      mesh("d", s.kitchen, half),
      mesh("e", s.kitchen, ghost),
      mesh("f", s.kitchen, ghost),
      mesh("g", s.kitchen, glassMat),
      mesh("h", s.kitchen, glassMat),
      mesh("i", s.kitchen, trans),
      mesh("j", s.kitchen, trans),
      mesh("window_pane", s.kitchen, plain),
      mesh("window glass", s.kitchen, plain),
      mesh("k", s.kitchen, plain, { userData: { seeThrough: true } }),
      mesh("l", s.kitchen, plain, { userData: { seeThrough: true } }),
    ];
    expect(mergeGroups(ms, optsFor(s))).toEqual([]);
  });

  it("excludes room floor meshes (<id>_floor), also by the glTF name in userData", () => {
    const s = scene(),
      m = mat("m");
    const ms = [
      mesh("kitchen_floor", s.kitchen, m),
      mesh("kitchenfloor", s.kitchen, m, {
        userData: { name: "living_floor" },
      }),
      mesh("x", s.kitchen, m),
    ];
    expect(mergeGroups(ms, optsFor(s))).toEqual([]);
  });

  it("excludes meshes referenced by a node selector; a referenced group becomes an owner", () => {
    const s = scene(),
      m = mat("m");
    const sofa = group("Sofa", s.living);
    const a = mesh("a", s.living, m),
      b = mesh("b", s.living, m),
      c = mesh("c", s.living, m);
    const s1 = mesh("s1", sofa, m),
      s2 = mesh("s2", sofa, m);
    const g = mergeGroups(
      [a, b, c, s1, s2],
      optsFor(s, { keep: new Set([c, sofa]) }),
    );
    expect(names(g).sort()).toEqual(["a,b", "s1,s2"]);
    expect(g.find((x) => x.meshes.includes(s1)).owner).toBe(sofa);
  });

  it("layer groups own their meshes; a mesh's own layers are part of the key and kept on the group", () => {
    const s = scene(),
      m = mat("m");
    const furn = group("", s.living, {
      userData: { fp: { layer: "furniture" } },
    });
    const f1 = mesh("f1", furn, m),
      f2 = mesh("f2", furn, m);
    const w1 = mesh("w1", s.living, m, { userData: { fp: { layer: "wall" } } }),
      w2 = mesh("w2", s.living, m, { userData: { fp: { layer: ["wall"] } } });
    const p1 = mesh("p1", s.living, m);
    const g = mergeGroups(
      [f1, f2, w1, w2, p1],
      optsFor(s, { isOwner: (n) => !!(n.userData.fp && n.userData.fp.layer) }),
    );
    expect(names(g).sort()).toEqual(["f1,f2", "w1,w2"]);
    expect(g.find((x) => x.meshes.includes(f1)).owner).toBe(furn);
    expect(g.find((x) => x.meshes.includes(w1)).layers).toEqual(["wall"]);
  });

  it("excludes tagged meshes, meshes with children, hidden, helpers, skinned / instanced / morph and multi-material meshes", () => {
    const s = scene(),
      m = mat("m");
    const tagged = mesh("t", s.kitchen, m);
    s.tags.set(tagged, "tag");
    const parentMesh = mesh("p", s.kitchen, m);
    mesh("child", parentMesh, mat("other"));
    const morph = mesh("mo", s.kitchen, m);
    morph.geometry.morphAttributes = { position: [attr(4)] };
    const ms = [
      tagged,
      parentMesh,
      morph,
      mesh("h", s.kitchen, m, { visible: false }),
      mesh("hp", s.kitchen, m, { userData: { helper: true } }),
      mesh("sk", s.kitchen, m, { isSkinnedMesh: true }),
      mesh("in", s.kitchen, m, { isInstancedMesh: true }),
      mesh("mi", s.kitchen, m, { morphTargetInfluences: [0] }),
      mesh("ar", s.kitchen, [m, m]),
      mesh("ok", s.kitchen, m),
    ];
    expect(mergeGroups(ms, optsFor(s))).toEqual([]);
  });

  it("excludes quantized (non-float) positions and normals", () => {
    const s = scene(),
      m = mat("m");
    const q = (n, k) => {
      const x = mesh(n, s.kitchen, m);
      x.geometry.attributes[k] = attr(4, 3, Int16Array);
      return x;
    };
    expect(
      mergeGroups(
        [
          q("a", "position"),
          q("b", "position"),
          q("c", "normal"),
          q("d", "normal"),
        ],
        optsFor(s),
      ),
    ).toEqual([]);
  });

  it("splits by geometry attribute set, shadow flags, render order and three.js layers", () => {
    const s = scene(),
      m = mat("m");
    const ms = [
      mesh("uv1", s.kitchen, m),
      mesh("uv2", s.kitchen, m),
      mesh("nouv1", s.kitchen, m, { geometry: geo({ uv: false }) }),
      mesh("nouv2", s.kitchen, m, { geometry: geo({ uv: false }) }),
      mesh("noidx", s.kitchen, m, { geometry: geo({ index: false }) }),
      mesh("col", s.kitchen, m, { geometry: geo({ color: true }) }),
      mesh("nocast", s.kitchen, m, { castShadow: false }),
      mesh("ro", s.kitchen, m, { renderOrder: 2 }),
      mesh("lay", s.kitchen, m, { layers: { mask: 2 } }),
    ];
    expect(names(mergeGroups(ms, optsFor(s))).sort()).toEqual([
      "nouv1,nouv2",
      "uv1,uv2",
    ]);
  });

  it("chunks a group above the vertex limit; an oversize mesh stays alone", () => {
    const s = scene(),
      m = mat("m");
    const big = (n, count) =>
      mesh(n, s.kitchen, m, { geometry: geo({ count }) });
    const ms = [
      big("a", 40),
      big("b", 40),
      big("c", 40),
      big("d", 40),
      big("e", 40),
      big("huge", 500),
    ];
    const g = mergeGroups(ms, optsFor(s, { maxVertices: 100 }));
    expect(names(g)).toEqual(["a,b", "c,d"]); // e alone in the third chunk, huge over the limit
    expect(g.every((x) => x.vertices <= 100)).toBe(true);
  });

  it("geometrySignature reflects attribute names, item sizes, types and the index", () => {
    expect(geometrySignature(geo())).toBe(geometrySignature(geo()));
    expect(geometrySignature(geo())).not.toBe(
      geometrySignature(geo({ uv: false })),
    );
    expect(geometrySignature(geo())).not.toBe(
      geometrySignature(geo({ index: false })),
    );
    const g = geo();
    g.attributes.uv = attr(4, 2, Uint16Array);
    expect(geometrySignature(g)).not.toBe(geometrySignature(geo()));
    expect(geometrySignature({ attributes: {} })).toBe(null);
  });

  it("a mesh over 30 m is never merged", () => {
    const s = scene(),
      m = mat("m");
    const boxOf = (x) => ({
      cx: 0,
      cz: 0,
      size: x.name === "terrain" ? 31 : 1,
    });
    const g = mergeGroups(
      [
        mesh("terrain", s.kitchen, m),
        mesh("a", s.kitchen, m),
        mesh("b", s.kitchen, m),
      ],
      optsFor(s, { boxOf }),
    );
    expect(names(g)).toEqual(["a,b"]);
  });

  it("spatial owners split their meshes into 10 m cells; other owners do not", () => {
    const s = scene(),
      m = mat("m");
    const at = {
      a: [1, 1],
      b: [9, 2],
      c: [12, 1],
      d: [13, 4],
      e: [-1, 1],
      f: [-2, 2],
    };
    const boxOf = (x) => ({
      cx: at[x.name[0]][0],
      cz: at[x.name[0]][1],
      size: 1,
    });
    const loose = Object.keys(at).map((k) => mesh(k, s.root, m));
    const g = mergeGroups(
      loose,
      optsFor(s, { boxOf, spatial: (o) => o === s.root }),
    );
    expect(names(g).sort()).toEqual(["a,b", "c,d", "e,f"]);
    const room = Object.keys(at).map((k) => mesh(k + "r", s.kitchen, m));
    expect(
      names(
        mergeGroups(room, optsFor(s, { boxOf, spatial: (o) => o === s.root })),
      ),
    ).toEqual(["ar,br,cr,dr,er,fr"]);
  });

  it('named groups with two or more meshes below them are owners (not unnamed, "?" or one-mesh groups)', () => {
    const s = scene(),
      m = mat("m");
    const sofa = group("Sofa", s.living),
      cushions = group("", sofa);
    mesh("s1", sofa, m);
    mesh("s2", cushions, m);
    const one = group("Lamp shade", s.living);
    mesh("x", one, m);
    const q = group("?", s.living);
    mesh("q1", q, m);
    mesh("q2", q, m);
    const set = namedGroups(s.root);
    expect(set.has(sofa)).toBe(true);
    expect(set.has(cushions)).toBe(false);
    expect(set.has(one)).toBe(false);
    expect(set.has(q)).toBe(false);
    expect(set.has(s.root)).toBe(false); // the root is the owner of last resort anyway
  });
});

describe("merged mesh names", () => {
  it("fnv1a is 8 hex digits and stable", () => {
    expect(fnv1a("")).toBe("811c9dc5");
    expect(fnv1a("a")).toBe("e40c292c");
    expect(fnv1a("hello")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("mergedName depends on material and source paths, not their order", () => {
    const a = mergedName("Wood", ["g/Room/Chair#0", "g/Room/Chair#1"]);
    expect(a).toMatch(/^fp_merged_[0-9a-f]{8}$/);
    expect(mergedName("Wood", ["g/Room/Chair#1", "g/Room/Chair#0"])).toBe(a);
    expect(mergedName("Oak", ["g/Room/Chair#0", "g/Room/Chair#1"])).not.toBe(a);
    expect(mergedName("Wood", ["g/Room/Chair#0", "g/Room/Chair#2"])).not.toBe(
      a,
    );
  });
});
