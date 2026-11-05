// Physical materials (render quality 'high', QualityTier.physicalMaterials): which model materials are glass,
// floors or fabric. Pure: the facts are gathered from the scene once per model load (view/look.ts), the
// classes decided here, so the heuristics and the explicit rules are unit tested without three.js.
//
// Precedence per material: a material the file already made physical (glTF KHR_materials_*) and model
// objects (the card drives their glow) are never touched; then the explicit rules (the material's extras
// fp_surface, the model's fp.render.materials, the card's render.materials: the later wins); then the name
// heuristics (the material's name, else every mesh that uses it must agree), floor surfaces the card knows
// and see-through untextured materials (thin glass).

import { GLASS_RE } from "./render-rules.ts";
import { matches, parseSelector, type NodeInfo } from "./views.ts";

export type Surface = "glass" | "floor" | "fabric";
/** An explicit rule's class: a surface, or 'none' (opted out: stays as modelled). */
export type SurfaceRule = Surface | "none";
export const SURFACE_RULES: readonly SurfaceRule[] = [
  "glass",
  "floor",
  "fabric",
  "none",
];

/** One explicit rule: a selector (views.ts syntax, plus material:<name>) and what it makes the materials. */
export interface MaterialRule {
  sel: string;
  surface: SurfaceRule;
}

// glass / glazing / pane(s) as a word: glass even when other words say fabric ("glass curtain wall"); a
// bare "window" yields to fabric words ("window_curtain"). Words: letters only, so "bedroom" is no bed.
const GLASS_WORD_RE = /(?<![a-z])(glass|glazing|panes?)(?![a-z])/i;
// rugs and carpets are fabric (sheen), never a clear-coated floor
export const FABRIC_RE =
  /(?<![a-z])(sofas?|couch(es)?|beds?|mattress(es)?|curtains?|drapes?|fabrics?|textiles?|upholstery|cushions?|pillows?|blankets?|rugs?|carpets?|carpeting)(?![a-z])/i;
export const FLOOR_RE =
  /(?<![a-z])(floors?|flooring|parquet|laminate|tiles?|tiled|wood|wooden)(?![a-z])/i;

// The class one name suggests, or null.
export function nameSurface(name: string | null | undefined): Surface | null {
  const n = String(name || "");
  if (!n) return null;
  if (GLASS_WORD_RE.test(n)) return "glass";
  if (FABRIC_RE.test(n)) return "fabric";
  if (GLASS_RE.test(n)) return "glass"; // window, not its frame or sill
  if (FLOOR_RE.test(n)) return "floor";
  return null;
}

/** A selector match target: the mesh and its ancestors (views.ts NodeInfo fields). */
export type SelectorNode = Pick<NodeInfo, "tag" | "layers" | "path">;

/** One mesh that uses the material, as the heuristics see it. */
export interface MeshFacts {
  /** The mesh's own name. */
  name: string;
  /** Names of its untagged ancestors up to the first tagged node (the "Sofa" group of a cushion). */
  groups: string[];
  /** fp.layer of the mesh and its ancestors. */
  layers: string[];
  /** Inside a model object (kind: object). */
  object: boolean;
  /** Inside a room or a storey / basement level, not in a zone, an exterior or roof level, not terrain. */
  indoor: boolean;
  /** A floor surface the card knows: flat, its top at its level's floor height, inside a room. */
  floorTop: boolean;
  /** The mesh and its ancestors, for the rules' selectors. */
  chain: SelectorNode[];
}

/** A model material as the heuristics see it. */
export interface MaterialFacts {
  name: string;
  /** Already a MeshPhysicalMaterial from the file (KHR_materials_*): left as the file says. */
  physical: boolean;
  /** The material's extras fp_surface (glTF material extras), if any. */
  extras?: unknown;
  transparent: boolean;
  opacity: number;
  textured: boolean;
  emissive: boolean;
  uses: MeshFacts[];
}

// '*' within a material name (case-insensitive).
const nameGlob = (pattern: string): RegExp =>
  new RegExp(
    "^" +
      pattern
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, "\\$&"))
        .join(".*") +
      "$",
    "i",
  );

// Does the rule's selector pick this material? material:<name> by the material name, the view selectors
// when any of its meshes (or one of their ancestors) matches.
export function ruleMatches(
  sel: string,
  m: Pick<MaterialFacts, "name" | "uses">,
): boolean {
  if (sel.startsWith("material:"))
    return nameGlob(sel.slice("material:".length)).test(m.name || "");
  const s = parseSelector(sel);
  if (!s) return false;
  return (
    s.kind === "all" || m.uses.some((u) => u.chain.some((n) => matches(s, n)))
  );
}

// The material's class under the rules, or null (stays a plain standard material).
export function classifyMaterial(
  m: MaterialFacts,
  rules: readonly MaterialRule[] = [],
): Surface | null {
  if (m.physical || m.uses.some((u) => u.object)) return null;
  let explicit: SurfaceRule | null = SURFACE_RULES.includes(
    m.extras as SurfaceRule,
  )
    ? (m.extras as SurfaceRule)
    : null;
  for (const r of rules) if (ruleMatches(r.sel, m)) explicit = r.surface;
  if (explicit) return explicit === "none" ? null : explicit;
  if (!m.uses.length) return null;
  const indoor = (s: Surface | null): Surface | null =>
    s === "floor" && !m.uses.every((u) => u.indoor) ? null : s;
  const own = nameSurface(m.name);
  if (own) return indoor(own);
  // every mesh that uses it must say the same (a material shared by a floor and a wall stays as it is)
  const per = m.uses.map((u): Surface | null => {
    const byName = nameSurface(u.name);
    if (byName) return byName;
    if (u.layers.some((l) => String(l).toLowerCase() === "glass"))
      return "glass";
    if (u.groups.some((g) => nameSurface(g) === "fabric")) return "fabric";
    if (u.floorTop) return "floor";
    return null;
  });
  const first = per[0];
  if (first && per.every((p) => p === first)) return indoor(first);
  // see-through, untextured, not glowing: thin glass
  if (m.transparent && m.opacity <= 0.6 && !m.textured && !m.emissive)
    return "glass";
  return null;
}

// Card YAML render.materials / the model's fp.render.materials: { '<selector>': glass | floor | fabric | none }
// (later keys win) -> { rules, warnings }. Invalid selectors and classes are skipped with a warning.
export function normMaterialRules(
  raw: unknown,
  at = "render.materials",
): { rules: MaterialRule[]; warnings: string[] } {
  const rules: MaterialRule[] = [],
    warnings: string[] = [];
  if (raw === undefined || raw === null) return { rules, warnings };
  if (typeof raw !== "object" || Array.isArray(raw))
    return {
      rules,
      warnings: [
        `${at}: needs an object of selector: ${SURFACE_RULES.join(" | ")}`,
      ],
    };
  for (const [sel, v] of Object.entries(raw as Record<string, unknown>)) {
    const okSel = /^material:.+/.test(sel) || !!parseSelector(sel);
    if (!okSel) {
      warnings.push(
        `${at}: "${sel}" is not a selector (material:<name>, layer:<name>, node:<path>, room:<id>, level:<id>, role:<role>, all ...)`,
      );
      continue;
    }
    const surface = typeof v === "string" ? v.trim().toLowerCase() : v;
    if (!SURFACE_RULES.includes(surface as SurfaceRule)) {
      warnings.push(
        `${at}.${sel}: "${String(v)}" is not one of ${SURFACE_RULES.join(", ")}`,
      );
      continue;
    }
    rules.push({ sel, surface: surface as SurfaceRule });
  }
  return { rules, warnings };
}
