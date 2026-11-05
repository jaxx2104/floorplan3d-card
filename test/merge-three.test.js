import { describe, it, expect } from "bun:test";
import * as THREE from "three";
import { mergeStaticMeshes } from "../src/view.ts";
import { buildManifest, threeAdapter } from "../src/manifest.ts";
import {
  nodeIndex,
  parseSelector,
  matches,
  resolveVisibility,
} from "../src/views.ts";

// Scene > ground (level) > Room (room) > three "Chair" meshes + a table, one material
function house({ mirrored = false } = {}) {
  const root = new THREE.Group();
  root.name = "Scene";
  const level = new THREE.Group();
  level.name = "ground";
  level.userData.fp = { kind: "level", id: "ground" };
  const room = new THREE.Group();
  room.name = "Room";
  room.userData.fp = { kind: "room", id: "room" };
  root.add(level);
  level.add(room);
  const wood = new THREE.MeshStandardMaterial({ name: "Wood" });
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1, 0.5), wood);
    c.name = "Chair";
    c.position.set(i, 0.5, 0);
    room.add(c);
  }
  const t = new THREE.Mesh(new THREE.BoxGeometry(2, 0.1, 1), wood);
  t.name = "Table";
  if (mirrored) t.scale.x = -1;
  room.add(t);
  return { root, room, wood };
}
const pathsOf = (root, manifest) => nodeIndex(threeAdapter(root), manifest);
const match = (index, s) =>
  index.nodes.filter((n) => matches(parseSelector(s), n));

describe("mergeStaticMeshes", () => {
  it("a node: rule on Chair#2 still matches the kept chair after its siblings are merged", () => {
    const { root, room } = house();
    const manifest = buildManifest(threeAdapter(root));
    const before = match(pathsOf(root, manifest), "node:ground/Room/Chair#2")[0]
      .node;
    const res = mergeStaticMeshes(root, manifest, ["node:ground/Room/Chair#2"]);
    expect(res.merged).toBe(3); // Chair#0, Chair#1, Table
    expect(room.children.filter((c) => c.name === "Chair")).toEqual([before]);
    const index = pathsOf(root, manifest);
    expect(match(index, "node:ground/Room/Chair#2").map((n) => n.node)).toEqual(
      [before],
    );
    const vis = resolveVisibility(index, [
      { hide: "node:ground/Room/Chair#2" },
    ]);
    expect(vis[index.nodes.findIndex((n) => n.node === before)]).toBe(false);
  });

  it("a rule made after the merge for the kept chair survives a reload", () => {
    const a = house();
    const ma = buildManifest(threeAdapter(a.root));
    mergeStaticMeshes(a.root, ma, ["node:ground/Room/Chair#1"]);
    const ia = pathsOf(a.root, ma);
    const kept = ia.nodes.find((n) => n.name === "Chair");
    const rule = "node:" + kept.path;
    expect(rule).toBe("node:ground/Room/Chair#1");
    const b = house(); // reload: same model, the new rule is in the layout now
    const mb = buildManifest(threeAdapter(b.root));
    mergeStaticMeshes(b.root, mb, ["node:ground/Room/Chair#1", rule]);
    const hit = match(pathsOf(b.root, mb), rule);
    expect(hit).toHaveLength(1);
    expect(hit[0].node.isMesh && !hit[0].node.userData.merged).toBe(true);
  });

  it("merged names are stable across reloads and come from the contents", () => {
    const name = () => {
      const { root } = house();
      mergeStaticMeshes(root, buildManifest(threeAdapter(root)), []);
      return root
        .getObjectByProperty("type", "Mesh")
        .parent.children.filter((c) => c.userData.merged)
        .map((c) => c.name);
    };
    const n1 = name();
    expect(n1).toHaveLength(1);
    expect(n1[0]).toMatch(/^fp_merged_[0-9a-f]{8}$/);
    expect(name()).toEqual(n1);
  });

  it("mirrored parts: winding and tangent w are flipped; drawRange is respected", () => {
    const { root, room, wood } = house({ mirrored: true });
    const table = room.children.find((c) => c.name === "Table");
    table.geometry.computeTangents();
    for (const c of room.children)
      if (c !== table) c.geometry.computeTangents();
    const idx0 = Array.from(table.geometry.index.array.slice(0, 3));
    const w0 = table.geometry.attributes.tangent.getW(0);
    // a chair drawing only its first 12 indices (2 triangles)
    const chair = room.children.find((c) => c.name === "Chair");
    chair.geometry.setDrawRange(0, 12);
    const chairVerts = chair.geometry.attributes.position.count;
    mergeStaticMeshes(root, buildManifest(threeAdapter(root)), []);
    const merged = room.children.find((c) => c.userData.merged);
    expect(merged.material).toBe(wood);
    const g = merged.geometry;
    // sources in order: 3 chairs (first drawRange-limited), then the table
    expect(g.index.count).toBe(12 + 36 * 2 + 36);
    expect(g.attributes.position.count).toBe(chairVerts * 3 + 24);
    const off = chairVerts * 3,
      t0 = 12 + 72;
    expect(Array.from(g.index.array.slice(t0, t0 + 3))).toEqual([
      idx0[0] + off,
      idx0[2] + off,
      idx0[1] + off,
    ]);
    expect(g.attributes.tangent.getW(off)).toBe(-w0);
  });
});
