// Reads the fp tags of a house model (docs/model-builder-guide.md). Works on any node tree
// through an adapter, so the card (three.js nodes) and tools/check-model.mjs (glTF JSON) share it.
import { normSection, normTopCamera } from "./views.ts";
import { badTargets, aimWarning, aimsUp } from "./objects/aim.ts";
import { normRender } from "./render-recipe.ts";
import { normCutaway } from "./cutaway.ts";

import type {
  LevelRole,
  Manifest,
  ManifestEntry,
  ManifestLevel,
  ManifestObject,
  ManifestRoom,
  ManifestSuggest,
  ManifestView,
  ModelAdapter,
} from "./types/manifest.ts";
import type { PlanPoint, Vec3 } from "./types/layout.ts";

export type {
  LevelRole,
  Manifest,
  ManifestEntry,
  ManifestKind,
  ManifestLevel,
  ManifestObject,
  ManifestRoom,
  ManifestView,
  ModelAdapter,
} from "./types/manifest.ts";

/** A node's fp tag (extras.fp or an fp:<kind>:<id> name). */
export interface FpTag {
  kind?: string;
  id?: unknown;
  type?: string;
  role?: string;
  label?: string;
  source: "extras" | "name";
  [key: string]: unknown;
}

export const KINDS = ["level", "room", "zone", "object"];
export const ROLES: readonly LevelRole[] = [
  "storey",
  "basement",
  "exterior",
  "roof",
];
const isRole = (r: string): r is LevelRole =>
  (ROLES as readonly string[]).includes(r);
export const ID_RE = /^[a-z0-9_-]{1,64}$/;

const isPoint = (p: unknown): p is number[] =>
  Array.isArray(p) &&
  p.length >= 2 &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// Tag of one node: extras.fp, else an "fp:<kind|type>:<id>" name.
export function readTag(
  name: string | null | undefined,
  extras: Record<string, unknown> | null | undefined,
): FpTag | null {
  const fp = extras && extras.fp;
  if (fp && typeof fp === "object" && !Array.isArray(fp))
    return { ...fp, source: "extras" };
  const m = /^fp:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(name || "");
  if (m) {
    const k = m[1].toLowerCase();
    return KINDS.includes(k)
      ? { kind: k, id: m[2], source: "name" }
      : { kind: "object", type: k, id: m[2], source: "name" };
  }
  return null;
}

export function buildManifest<N>(adapter: ModelAdapter<N>): Manifest<N> {
  const byNode = new Map<N, ManifestEntry<N>>();
  const m: Manifest<N> = {
    levels: [],
    rooms: [],
    objects: [],
    views: [],
    errors: [],
    warnings: [],
    byNode,
    ownerOf: () => null,
    render: null,
    renderKeys: 0,
    cutaways: [],
  };
  const seen: Record<"level" | "room" | "object", Set<unknown>> = {
    level: new Set(),
    room: new Set(),
    object: new Set(),
  };
  m.ownerOf = (node) => {
    for (
      let n: N | null | undefined = node;
      n !== null && n !== undefined;
      n = adapter.parent(n)
    ) {
      const e = m.byNode.get(n);
      if (e) return e;
    }
    return null;
  };

  // an fp object without a kind (layer-only, views-only) is not a tag
  const tagOf = (node: N): FpTag | null => {
    const t = readTag(adapter.name(node), adapter.extras(node));
    return t && t.kind === undefined ? readTag(adapter.name(node), null) : t;
  };
  let tops = adapter.roots();
  if (tops.length === 1 && !tagOf(tops[0])) {
    tops = adapter.children(tops[0]); // a single untagged wrapper (e.g. "Scene")
  }

  type Fp = { views?: unknown; render?: unknown };
  const fpOf = (n: N): Fp | undefined => {
    const e = adapter.extras(n);
    return e ? (e.fp as Fp | undefined) : undefined;
  };
  const viewHolder = adapter.roots().find((r) => {
    const fp = fpOf(r);
    return fp && Array.isArray(fp.views);
  });
  const isNum3 = (a: unknown): a is Vec3 =>
    Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  const strs = (a: unknown): string[] =>
    Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  type RawView =
    | {
        id?: unknown;
        label?: unknown;
        show?: unknown;
        hide?: unknown;
        camera?: { position?: unknown; target?: unknown };
        section?: unknown;
        camera_top?: unknown;
      }
    | null
    | undefined;
  const rawViews = (
    viewHolder !== undefined ? fpOf(viewHolder)!.views : []
  ) as RawView[]; // checked by find()
  for (const v of rawViews) {
    // glTF node 0 is a holder too
    if (!v || typeof v.id !== "string" || !ID_RE.test(v.id)) {
      m.warnings.push(`view "${v && v.id}": invalid id`);
      continue;
    }
    if (m.views.some((x) => x.id === v.id)) {
      m.warnings.push(`view "${v.id}": duplicate id`);
      continue;
    }
    const cam =
      v.camera && isNum3(v.camera.position) && isNum3(v.camera.target)
        ? { position: v.camera.position, target: v.camera.target }
        : null;
    const view: ManifestView = {
      id: v.id,
      label: typeof v.label === "string" ? v.label : v.id,
      show: strs(v.show),
      hide: strs(v.hide),
      camera: cam,
    };
    const section = normSection(v.section);
    if (section) view.section = section;
    else if (v.section !== undefined)
      m.warnings.push(
        `view "${v.id}": invalid section (needs normal [x, y, z] and a constant)`,
      );
    const top = normTopCamera(v.camera_top);
    if (top) view.camera_top = top;
    else if (v.camera_top !== undefined)
      m.warnings.push(
        `view "${v.id}": invalid camera_top (needs center [x, y] and zoom > 0)`,
      );
    m.views.push(view);
  }
  // render recipe (extras.fp.render on a root): validated, warnings for invalid values
  const renderHolder = adapter.roots().find((r) => {
    const fp = fpOf(r);
    return fp && fp.render !== undefined;
  });
  const rr = normRender(
    renderHolder !== undefined ? fpOf(renderHolder)!.render : undefined,
  );
  m.render = rr.recipe;
  m.renderKeys = rr.keys;
  m.warnings.push(...rr.warnings);

  type Ctx = { level: string | null; room: string | null };
  const add = (
    node: N,
    tag: FpTag,
    ctx: Ctx,
    path: string,
  ): ManifestEntry<N> | null => {
    const where = `${tag.kind} "${tag.id}"`;
    if (!tag.kind || !KINDS.includes(tag.kind)) {
      m.errors.push(`${path}: unknown kind "${tag.kind}"`);
      return null;
    }
    if (typeof tag.id !== "string" || !ID_RE.test(tag.id)) {
      m.errors.push(
        `${path}: invalid id "${tag.id}" (use a-z, 0-9, _ and -, at most 64)`,
      );
      return null;
    }
    const ns = (tag.kind === "zone" ? "room" : tag.kind) as
      "level" | "room" | "object"; // a KINDS member // rooms and zones share one id namespace
    if (seen[ns].has(tag.id)) {
      m.errors.push(
        `${path}: duplicate ${ns === "room" ? "room/zone" : tag.kind} id "${tag.id}"`,
      );
      return null;
    }
    seen[ns].add(tag.id);
    const base = {
      id: tag.id,
      label: tag.label || tag.id,
      node,
      path,
      source: tag.source,
    };
    let entry: ManifestEntry<N>;
    if (tag.kind === "level") {
      let role = tag.role || "storey";
      if (!isRole(role)) {
        m.warnings.push(`${where}: unknown role "${role}", using storey`);
        role = "storey";
      }
      if (ctx.level)
        m.warnings.push(
          `${where} is inside level "${ctx.level}"; levels should be top-level`,
        );
      const level: ManifestLevel<N> = {
        ...base,
        kind: "level",
        role: role as LevelRole,
        order: num(tag.order),
        elevation: num(tag.elevation),
        height: num(tag.height),
      };
      m.levels.push(level);
      entry = level;
    } else if (tag.kind === "room" || tag.kind === "zone") {
      if (!ctx.level) m.errors.push(`${where} is not inside a level`);
      let outline: PlanPoint[] | null = null;
      if (tag.outline !== undefined) {
        if (
          Array.isArray(tag.outline) &&
          tag.outline.length >= 3 &&
          tag.outline.every(isPoint)
        )
          outline = tag.outline.map((p): PlanPoint => [p[0], p[1]]);
        else
          m.warnings.push(`${where}: outline needs at least 3 [x, y] points`);
      }
      const doors = Array.isArray(tag.doors)
        ? tag.doors.filter(isPoint).map((p): PlanPoint => [p[0], p[1]])
        : [];
      const room: ManifestRoom<N> = {
        ...base,
        kind: tag.kind,
        level: ctx.level,
        outline,
        doors,
        suggest: (tag.suggest as ManifestSuggest) || {},
      };
      m.rooms.push(room);
      entry = room;
    } else {
      if (!ctx.level) m.errors.push(`${where} is not inside a level`);
      const obj: ManifestObject<N> = {
        // tag fields are the model author's JSON: passed through as before
        ...base,
        kind: "object",
        type: tag.type || "generic",
        level: ctx.level,
        room: ctx.room,
        group: (tag.group as string) || null,
        glow: (tag.glow as string) || null,
        anchor: isPoint(tag.anchor) ? tag.anchor : null,
        hints: (tag.hints as Record<string, unknown>) || {},
        suggest: (tag.suggest as ManifestSuggest) || {},
        ui: (tag.ui as Record<string, unknown>) || {},
      };
      m.objects.push(obj);
      entry = obj;
    }
    m.byNode.set(node, entry);
    return entry;
  };

  const walk = (node: N, ctx: Ctx, parentPath: string): void => {
    const name = adapter.name(node);
    const path = parentPath ? `${parentPath}/${name}` : name;
    const tag = tagOf(node);
    const fp = (adapter.extras(node) || {}).fp as
      { cutaway?: unknown } | undefined;
    if (fp && typeof fp === "object" && fp.cutaway !== undefined) {
      const c = normCutaway(fp.cutaway);
      if (typeof c === "string") m.warnings.push(`${path}: ${c}`);
      else m.cutaways.push({ ...c, node });
    }
    let next = ctx;
    if (tag) {
      const e = add(node, tag, ctx, path);
      if (e && e.kind === "level") next = { level: e.id, room: null };
      else if (e && (e.kind === "room" || e.kind === "zone"))
        next = { ...ctx, room: e.id };
    }
    for (const c of adapter.children(node)) walk(c, next, path);
  };
  for (const t of tops) walk(t, { level: null, room: null }, "");
  if (adapter.position) {
    const position = adapter.position;
    const v3 = (a: unknown): a is number[] =>
      Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
    const spots = m.objects.flatMap((o) => {
      const target = o.hints && o.hints.target;
      if (
        !o.hints ||
        (o.hints.beam !== "spot" && o.hints.beam !== "up") ||
        !v3(target)
      )
        return [];
      return [
        {
          id: o.id,
          group: o.group,
          pos: position(o.node),
          target,
          distance: o.hints.distance,
          up: aimsUp(o),
          targetOk: o.hints.target_ok === true,
        },
      ];
    });
    const w = aimWarning(badTargets(spots));
    if (w) m.warnings.push(w);
  }
  return m;
}

// p (node frame) -> parent frame: scale, rotate (quaternion [x, y, z, w]), translate; or a column-major matrix.
type Transform =
  | { matrix: number[]; t?: undefined; q?: undefined; s?: undefined }
  | { matrix?: undefined; t: number[]; q: number[]; s: number[] };
function toParent(p: number[], { t, q, s, matrix }: Transform): number[] {
  if (matrix) {
    const e = matrix;
    return [
      e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12],
      e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13],
      e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14],
    ];
  }
  const v = [p[0] * s[0], p[1] * s[1], p[2] * s[2]];
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1],
    iy = w * v[1] + z * v[0] - x * v[2],
    iz = w * v[2] + x * v[1] - y * v[0],
    iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y + t[0],
    iy * w + iw * -y + iz * -x - ix * -z + t[1],
    iz * w + iw * -z + ix * -y - iy * -x + t[2],
  ];
}

/** The parts of a three.js node the adapter reads. */
export interface ThreeNodeLike {
  name: string;
  userData: Record<string, unknown>;
  children: ThreeNodeLike[];
  parent: ThreeNodeLike | null;
  position: { toArray(): number[] };
  quaternion: { toArray(): number[] };
  scale: { toArray(): number[] };
}

export function threeAdapter<N extends ThreeNodeLike>(
  root: N,
): ModelAdapter<N> {
  return {
    // children / parents of an N tree are N nodes again
    roots: () => root.children as N[],
    children: (n) => n.children as N[],
    name: (n) => (n.userData && (n.userData.name as string)) || n.name || "", // GLTFLoader strips ':' from n.name
    extras: (n) => n.userData || {},
    parent: (n) => (n.parent && n.parent !== root ? (n.parent as N) : null),
    // node origin in the root's frame
    position: (n) => {
      let p = [0, 0, 0];
      for (let x: ThreeNodeLike | null = n; x && x !== root; x = x.parent)
        p = toParent(p, {
          t: x.position.toArray(),
          q: x.quaternion.toArray(),
          s: x.scale.toArray(),
        });
      return p;
    },
  };
}

/** The glTF JSON fields the adapter reads. */
export interface GltfNode {
  name?: string;
  children?: number[];
  extras?: Record<string, unknown>;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
export interface GltfJson {
  nodes?: GltfNode[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
}

export function gltfAdapter(json: GltfJson): ModelAdapter<number> {
  const nodes = json.nodes || [];
  const parent = new Map<number, number>();
  nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));
  const scene = (json.scenes || [])[json.scene ?? 0] || { nodes: [] };
  return {
    roots: () => scene.nodes || [],
    children: (i) => nodes[i].children || [],
    name: (i) => nodes[i].name || "",
    extras: (i) => nodes[i].extras || {},
    parent: (i) => parent.get(i) ?? null,
    // node origin in the scene's frame
    position: (i) => {
      let p = [0, 0, 0];
      for (
        let x: number | undefined = i;
        x !== undefined && x !== null && nodes[x];
        x = parent.get(x)
      ) {
        const n = nodes[x];
        p = toParent(
          p,
          Array.isArray(n.matrix) && n.matrix.length === 16
            ? { matrix: n.matrix }
            : {
                t: n.translation || [0, 0, 0],
                q: n.rotation || [0, 0, 0, 1],
                s: n.scale || [1, 1, 1],
              },
        );
      }
      return p;
    },
  };
}

export function summarize(m: Pick<Manifest, "levels" | "rooms" | "objects">): {
  levels: number;
  rooms: number;
  zones: number;
  objects: Record<string, number>;
} {
  const objects: Record<string, number> = {};
  for (const o of m.objects) objects[o.type] = (objects[o.type] || 0) + 1;
  return {
    levels: m.levels.length,
    rooms: m.rooms.filter((r) => r.kind === "room").length,
    zones: m.rooms.filter((r) => r.kind === "zone").length,
    objects,
  };
}
