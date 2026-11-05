// Baked lightmaps (every render quality): light the owner baked in Blender, shipped in
// the GLB on a second UV set. A material says so in its glTF extras:
//
//   "fp_lightmap": "occlusion"
//       the material's occlusionTexture is the lightmap (the slot Blender's glTF exporter can fill: the glTF
//       Material Output's Occlusion socket), on the texture's own texCoord (1 for a second UV map)
//   "fp_lightmap": { "texture": <index into the glTF textures> | "occlusion", "texCoord": 1, "intensity": 1,
//                    "type": "light" | "ao", "colorSpace": "srgb" | "linear" }
//
// type light (the default): baked ambient light (sky and bounces, with the sun and the lamps off in the bake, as
// the card lights those live), used as three's lightMap in place of the sky environment's diffuse fill and of the
// light probe grid (light-probes.ts; a storey whose rooms are all baked gets no grid). It follows the sky's
// brightness (dark at night). type ao: baked ambient occlusion, used as the aoMap. Standard ignores the extras:
// the occlusionTexture stays the glTF occlusion it is to every viewer.
//
// No three.js here: tools/check-model.mjs validates the same extras.

export type LightmapType = "light" | "ao";
/** A validated fp_lightmap. texture: a glTF texture index, or the material's occlusionTexture. */
export interface LightmapSpec {
  texture: number | "occlusion";
  texCoord: number | null;
  intensity: number;
  type: LightmapType;
  colorSpace: "srgb" | "linear";
}

/** UV sets a lightmap may use (three: uv, uv1, uv2, uv3). */
export const LIGHTMAP_MAX_TEXCOORD = 3;
/** Lightmap side (px) above which check-model warns, and above which it fails (many phones stop at 4096). */
export const LIGHTMAP_WARN_PX = 2048;
export const LIGHTMAP_MAX_PX = 4096;
/** Share of a room's meshes (by their centre) that must be baked for the room to count as baked (light-probes.ts). */
export const BAKED_ROOM_SHARE = 0.5;

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const KEYS = ["texture", "texCoord", "intensity", "type", "colorSpace"];

// extras fp_lightmap -> { spec | null, warnings } (an invalid value: no lightmap and a warning; unknown keys warn).
export function normLightmap(raw: unknown): {
  spec: LightmapSpec | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (raw === undefined || raw === null || raw === false)
    return { spec: null, warnings };
  const o: Record<string, unknown> | null =
    raw === "occlusion" || raw === true
      ? { texture: "occlusion" }
      : isObj(raw)
        ? raw
        : null;
  if (!o)
    return {
      spec: null,
      warnings: ['fp_lightmap: needs "occlusion" or an object'],
    };
  for (const k of Object.keys(o))
    if (!KEYS.includes(k)) warnings.push(`fp_lightmap.${k}: unknown key`);
  const t = o.texture === undefined ? "occlusion" : o.texture;
  if (!(t === "occlusion" || (Number.isInteger(t) && (t as number) >= 0)))
    return {
      spec: null,
      warnings: [
        ...warnings,
        'fp_lightmap.texture: needs a texture index or "occlusion"',
      ],
    };
  let texCoord: number | null = null;
  if (o.texCoord !== undefined) {
    if (
      Number.isInteger(o.texCoord) &&
      (o.texCoord as number) >= 0 &&
      (o.texCoord as number) <= LIGHTMAP_MAX_TEXCOORD
    )
      texCoord = o.texCoord as number;
    else
      return {
        spec: null,
        warnings: [
          ...warnings,
          `fp_lightmap.texCoord: needs 0..${LIGHTMAP_MAX_TEXCOORD}`,
        ],
      };
  }
  let intensity = 1;
  if (o.intensity !== undefined) {
    if (typeof o.intensity === "number" && Number.isFinite(o.intensity))
      intensity = Math.min(10, Math.max(0, o.intensity));
    else warnings.push("fp_lightmap.intensity: needs a number, using 1");
  }
  let type: LightmapType = "light";
  if (o.type !== undefined) {
    if (o.type === "light" || o.type === "ao") type = o.type;
    else
      warnings.push(
        `fp_lightmap.type: "${String(o.type)}" is not one of light, ao; using light`,
      );
  }
  if (type === "ao" && t === "occlusion")
    return {
      spec: null,
      warnings: [
        ...warnings,
        "fp_lightmap: an occlusion texture is the ambient occlusion already (every tier); nothing to add",
      ],
    };
  let colorSpace: "srgb" | "linear" = "srgb";
  if (o.colorSpace !== undefined) {
    if (o.colorSpace === "srgb" || o.colorSpace === "linear")
      colorSpace = o.colorSpace;
    else
      warnings.push(
        `fp_lightmap.colorSpace: "${String(o.colorSpace)}" is not one of srgb, linear; using srgb`,
      );
  }
  return {
    spec: {
      texture: t as number | "occlusion",
      texCoord,
      intensity,
      type,
      colorSpace,
    },
    warnings,
  };
}

// The texCoord a spec reads: its own, else the occlusionTexture's (occlusion source), else 1 (a second UV map).
export const lightmapTexCoord = (
  spec: LightmapSpec,
  occlusionTexCoord?: number | null,
): number =>
  spec.texCoord ??
  (spec.texture === "occlusion" && Number.isInteger(occlusionTexCoord)
    ? (occlusionTexCoord as number)
    : 1);

// three's attribute name of a UV set (GLTFLoader: TEXCOORD_0 -> uv, TEXCOORD_n -> uvn).
export const uvAttribute = (texCoord: number): string =>
  texCoord ? `uv${texCoord}` : "uv";

/** A room to test meshes against: plan polygon and world floor / top height. */
export interface BakeRoom {
  polygon: readonly (readonly number[])[];
  y0: number;
  y1: number;
}
/** A mesh by its world bounding-box centre (card world: x, y up, z = -plan y) and whether it is baked. */
export interface BakeMesh {
  x: number;
  y: number;
  z: number;
  baked: boolean;
}

// Point in polygon (plan metres, even-odd).
export function insidePolygon(
  x: number,
  y: number,
  poly: readonly (readonly number[])[],
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

// Rooms whose surfaces are baked: at least BAKED_ROOM_SHARE of the meshes centred in the room (plan polygon,
// floor to top) carry a light-type lightmap. -> room indices.
export function bakedRooms(
  rooms: readonly BakeRoom[],
  meshes: readonly BakeMesh[],
): Set<number> {
  const all = new Array(rooms.length).fill(0),
    baked = new Array(rooms.length).fill(0);
  for (const m of meshes) {
    const i = rooms.findIndex(
      (r) =>
        m.y >= r.y0 - 0.05 &&
        m.y <= r.y1 + 0.05 &&
        insidePolygon(m.x, -m.z, r.polygon),
    );
    if (i < 0) continue;
    all[i]++;
    if (m.baked) baked[i]++;
  }
  const out = new Set<number>();
  rooms.forEach((_, i) => {
    if (all[i] && baked[i] / all[i] >= BAKED_ROOM_SHARE) out.add(i);
  });
  return out;
}
