// Indirect light of the model (every render quality): light probe grids per storey (light-probes.ts) and
// lightmaps baked into the GLB (lightmap.ts). The grids are baked here, with the view's overlays hidden and the whole
// house shown (every level, no cut), so a room sees its ceiling and the storey above even while the plan shows
// one floor; the bake neither draws a shadow map (those are the frame's) nor uses the probes it builds.
import * as THREE from "three";
import {
  LightProbes,
  probeRooms,
  lampKeys,
  lightStep,
  PROBE_MAX_FLOORS,
  type ProbeInputs,
  type ProbeSetup,
} from "../light-probes.ts";
import {
  normLightmap,
  lightmapTexCoord,
  uvAttribute,
  bakedRooms,
  type LightmapSpec,
  type BakeMesh,
} from "../lightmap.ts";
import { ENV_DAY } from "./env-light.ts";
import { isMesh, meshMaterials } from "./core.ts";
import type { FloorplanView } from "../view.ts";

/** A material's baked lightmap: its spec, the texture once loaded, the aoMap it had and whether it is applied. */
export interface LightmapEntry {
  mat: THREE.MeshStandardMaterial;
  spec: LightmapSpec;
  tex: THREE.Texture | null;
  aoBase: THREE.Texture | null;
  aoIntensity: number;
  applied: boolean;
}
/** The glTF parser's texture loading (GLTFLoader's parser.getDependency). */
export interface LightmapParser {
  getDependency(type: string, index: number): Promise<unknown>;
}

type Std = THREE.MeshStandardMaterial;
const isStd = (m: THREE.Material): m is Std =>
  !!(m as Partial<Std>).isMeshStandardMaterial;

// The lightmap texture of a spec from its source: a copy (its own colour space and UV set; the image is shared).
function lightmapTexture(
  src: THREE.Texture,
  spec: LightmapSpec,
  channel: number,
): THREE.Texture {
  const t = src.clone();
  t.colorSpace =
    spec.colorSpace === "srgb" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.channel = channel;
  t.flipY = false; // glTF textures are never flipped
  t.needsUpdate = true;
  return t;
}

// The materials of a loaded model with extras fp_lightmap, checked (standard material, the UV set on every mesh
// that uses it, the texture) and their textures loading (onReady once one has arrived). Invalid ones are warned
// about and left as they are. Runs once per model load, before anything is applied.
export function prepareLightmaps(
  root: THREE.Object3D,
  parser: LightmapParser | null,
  onReady: () => void,
): LightmapEntry[] {
  const users = new Map<THREE.Material, THREE.Mesh[]>();
  root.traverse((o) => {
    if (!isMesh(o)) return;
    for (const m of meshMaterials(o))
      if (m && m.userData && m.userData.fp_lightmap !== undefined)
        users.set(m, [...(users.get(m) || []), o]);
  });
  const out: LightmapEntry[] = [];
  for (const [m, meshes] of users) {
    const where = `material "${m.name || m.uuid}"`;
    const { spec, warnings } = normLightmap(m.userData.fp_lightmap);
    for (const w of warnings) console.warn(`floorplan3d: ${where} ${w}`);
    if (!spec) continue;
    if (!isStd(m)) {
      console.warn(
        `floorplan3d: ${where} fp_lightmap needs a PBR (standard) material`,
      );
      continue;
    }
    if (spec.texture === "occlusion" && !m.aoMap) {
      console.warn(
        `floorplan3d: ${where} fp_lightmap "occlusion" without an occlusionTexture`,
      );
      continue;
    }
    const channel = lightmapTexCoord(spec, m.aoMap ? m.aoMap.channel : null),
      uv = uvAttribute(channel);
    const missing = meshes.filter(
      (o) => !(o.geometry && o.geometry.attributes[uv]),
    );
    if (missing.length) {
      console.warn(
        `floorplan3d: ${where} fp_lightmap: ${missing.length} mesh(es) have no ${uv} (TEXCOORD_${channel}); not applied`,
      );
      continue;
    }
    const e: LightmapEntry = {
      mat: m,
      spec,
      tex: null,
      aoBase: m.aoMap,
      aoIntensity: m.aoMapIntensity,
      applied: false,
    };
    if (spec.texture === "occlusion")
      e.tex = lightmapTexture(m.aoMap!, spec, channel);
    else if (parser) {
      const index = spec.texture;
      parser
        .getDependency("texture", index)
        .then((t) => {
          if (!(t as Partial<THREE.Texture>).isTexture)
            throw new Error(`texture ${index} not found`);
          e.tex = lightmapTexture(t as THREE.Texture, spec, channel);
          onReady();
        })
        .catch((err) =>
          console.warn(
            `floorplan3d: ${where} fp_lightmap texture ${index} could not be loaded`,
            err,
          ),
        );
    } else continue;
    out.push(e);
  }
  return out;
}

// Apply (on) or restore a lightmap; sky: the environment's brightness relative to a clear day (a light map follows
// it). -> true when the material changed in a way that recompiles it.
export function applyLightmap(e: LightmapEntry, on: boolean, sky = 1): boolean {
  const m = e.mat,
    want = on && !!e.tex;
  if (want && e.spec.type === "light")
    m.lightMapIntensity = e.spec.intensity * sky;
  if (want === e.applied) return false;
  e.applied = want;
  if (want) {
    if (e.spec.type === "light") {
      m.lightMap = e.tex;
      if (e.spec.texture === "occlusion") m.aoMap = null; // the occlusion slot carried light, not occlusion
    } else {
      m.aoMap = e.tex;
      m.aoMapIntensity = e.spec.intensity;
    }
  } else {
    if (e.spec.type === "light") m.lightMap = null;
    m.aoMap = e.aoBase;
    m.aoMapIntensity = e.aoIntensity;
  }
  m.needsUpdate = true;
  return true;
}

export class IndirectLight {
  view: FloorplanView;
  probes: LightProbes | null;
  /** the loaded model's lightmaps (prepareLightmaps), for that model's root */
  lightmaps: { root: THREE.Object3D; entries: LightmapEntry[] } | null;
  _setupFor: {
    rooms: unknown;
    floors: unknown;
    model: unknown;
    baked: string;
    spacing: number;
  } | null;
  _roomsKey: string;

  constructor(view: FloorplanView) {
    this.view = view;
    this.probes = null;
    this.lightmaps = null;
    this._setupFor = null;
    this._roomsKey = "";
  }

  // A model was loaded: its lightmaps (checked, textures loading). Applied by sync().
  setModel(root: THREE.Object3D, parser: LightmapParser | null): void {
    if (this.lightmaps)
      for (const e of this.lightmaps.entries) if (e.tex) e.tex.dispose(); // the previous model's copies
    const entries = prepareLightmaps(root, parser, () => {
      if (!this.lightmaps || this.lightmaps.root !== root) return;
      if (this._syncLightmaps()) this.view.dirty = true;
    });
    this.lightmaps = { root, entries };
  }

  // The probes and lightmaps on with a model (made on first use), else off (freed / restored); a tier change
  // regrids the probes at its spacing (the next step). Runs on model load and look changes.
  sync(): void {
    const on = !!this.view.model;
    if (on && !this.probes) {
      this.probes = new LightProbes(
        this.view.renderer,
        this.view.skyLayer._cloudU,
        () => {
          this.view.dirty = true;
        },
      );
      this.view.scene.add(this.probes.group); // the grids are lights: three samples them in every lit material
      this._setupFor = null; // its rooms at the next step
      this._roomsKey = "";
    }
    if (!on && this.probes) {
      this.probes.dispose();
      this.probes = null;
      this.view.dirty = true;
    }
    this._syncLightmaps(); // other look changes (theme, day / night) keep the probes: their inputs decide
  }

  // Lightmaps applied with the model, restored without it; their light follows the sky. -> any recompiles.
  _syncLightmaps(): boolean {
    const lm = this.lightmaps,
      model = this.view.model;
    if (!lm) return false;
    const on = !!model && model.root === lm.root;
    const sky = this.view.scene.environmentIntensity / ENV_DAY;
    let changed = false;
    for (const e of lm.entries) if (applyLightmap(e, on, sky)) changed = true;
    if (changed) this._setupFor = null; // baked rooms changed
    return changed;
  }

  // The sky's brightness changed (lights): the baked light follows it (uniform values, no recompile).
  skyChanged(): void {
    const lm = this.lightmaps;
    if (!lm) return;
    const sky = this.view.scene.environmentIntensity / ENV_DAY;
    for (const e of lm.entries)
      if (e.applied && e.spec.type === "light")
        e.mat.lightMapIntensity = e.spec.intensity * sky;
  }

  // After a frame: the probes' inputs checked, the next slice of a due pass baked. -> the probes baked.
  step(): number {
    const p = this.probes,
      v = this.view;
    if (!p || !v.model) return 0;
    const env = v.look._env;
    if (env && !env.built) return 0; // the sky environment's first build comes first
    this._ensureSetup();
    p.request(this._inputs());
    return p.step((bake) => this._capture(bake));
  }

  // The probe rooms for the view's rooms, floors, model and baked rooms (rebuilt when any of them changed).
  _ensureSetup(): void {
    const v = this.view,
      lm = this.lightmaps;
    const baked = lm
      ? lm.entries.filter((e) => e.applied && e.spec.type === "light").length +
        ":" +
        lm.entries.length
      : "";
    const spacing = v.look.tier().probeSpacing;
    const f = this._setupFor;
    if (
      f &&
      f.rooms === v._rooms &&
      f.floors === v.floors &&
      f.model === v.model &&
      f.baked === baked &&
      f.spacing === spacing
    )
      return;
    this._setupFor = {
      rooms: v._rooms,
      floors: v.floors,
      model: v.model,
      baked,
      spacing,
    };
    const { rooms, storeys } = probeRooms(v._rooms, v.floors);
    // a storey whose rooms are all baked gets no grid
    const bakedSet =
      baked && !baked.startsWith("0:")
        ? bakedRooms(rooms, this._bakeMeshes())
        : new Set<number>();
    const skip = new Set<number>();
    for (let s = 0; s < Math.min(storeys.length, PROBE_MAX_FLOORS); s++) {
      const on = rooms
        .map((r, i) => [r, i] as const)
        .filter(([r]) => r.storey === s);
      if (on.length && on.every(([, i]) => bakedSet.has(i))) skip.add(s);
    }
    const key = JSON.stringify([
      v.model ? v.model.id : null,
      rooms.map((r) => [r.key, r.polygon, r.y0, r.y1]),
      [...skip],
      spacing,
    ]);
    if (key === this._roomsKey && this.probes!.setup) return; // the same rooms again (a new structure, same content)
    this._roomsKey = key;
    const setup: ProbeSetup = { rooms, storeys, skip, spacing };
    this.probes!.setRooms(setup);
  }

  // Every model mesh by its world box centre, baked when its material has an applied light map.
  _bakeMeshes(): BakeMesh[] {
    const out: BakeMesh[] = [],
      box = new THREE.Box3(),
      c = new THREE.Vector3();
    const baked = new Set<THREE.Material>(
      (this.lightmaps ? this.lightmaps.entries : [])
        .filter((e) => e.applied && e.spec.type === "light")
        .map((e) => e.mat),
    );
    this.view.modelGroup.updateMatrixWorld(true);
    this.view.model!.root.traverse((o) => {
      if (!isMesh(o)) return;
      box.setFromObject(o);
      if (box.isEmpty()) return;
      box.getCenter(c);
      out.push({
        x: c.x,
        y: c.y,
        z: c.z,
        baked: meshMaterials(o).some((m) => baked.has(m)),
      });
    });
    return out;
  }

  // What the probes see: rooms, sky builds, lamps that are on, light levels.
  _inputs(): ProbeInputs {
    const v = this.view,
      env = v.look._env,
      layer = v.objectLayer;
    const lamps = lampKeys(
      layer ? [...layer.pool.points, ...layer.pool.spots] : [],
      this.probes ? this.probes.ranges() : [],
    );
    const light = [
      v.sun.intensity,
      v.moonLight.intensity,
      v.scene.environmentIntensity,
    ]
      .map(lightStep)
      .join(",");
    return { rooms: this._roomsKey, sky: env ? env.builds : 0, lamps, light };
  }

  // Bake with the scene as a probe sees it: the house whole (every level, no cut or section), lit as now, without the
  // view's overlays and sky sprites, the sky environment as the background (seen through the windows), no shadow-map
  // pass (the grid's bake asks for one; the frame's maps are kept), the probes themselves off (LightProbes.step: one
  // bounce, no feedback).
  _capture(bake: (scene: THREE.Scene) => void): void {
    const v = this.view,
      r = v.renderer,
      s = v.scene,
      model = v.model!;
    const hidden: THREE.Object3D[] = [];
    for (const c of s.children) {
      if (
        c === v.modelGroup ||
        c === v.objectsGroup ||
        (this.probes && c === this.probes.group) || // hiding the grids would change every lit program
        (c as Partial<THREE.Light>).isLight ||
        !c.visible
      )
        continue;
      c.visible = false;
      hidden.push(c);
    }
    // the house whole: hidden levels and the nodes a view hides (the roof, ceilings) shown for the capture
    const nodes = [
      ...model.manifest.levels.map((l) => l.node),
      ...(v._modelVisibility
        ? v._modelVisibility.index.nodes.map((n) => n.node)
        : []),
    ];
    const levels = [...new Set(nodes)].filter((n) => !n.visible);
    for (const n of levels) n.visible = true;
    const auto = r.autoClear,
      shadow = r.shadowMap.needsUpdate,
      cut = v.modelClip.constant;
    const clear = r.getClearColor(new THREE.Color()),
      alpha = r.getClearAlpha();
    const bg = s.background,
      bgI = s.backgroundIntensity,
      bgB = s.backgroundBlurriness;
    const shadowMap = r.shadowMap;
    r.autoClear = true;
    r.setClearColor(0x000000, 1);
    v.modelClip.constant = 1e6;
    s.background = s.environment;
    s.backgroundIntensity = s.environmentIntensity;
    s.backgroundBlurriness = 0;
    // the bake sets needsUpdate to draw the shadow maps once: held false for it
    Object.defineProperty(shadowMap, "needsUpdate", {
      configurable: true,
      get: () => false,
      set: () => {},
    });
    try {
      bake(s);
    } finally {
      Object.defineProperty(shadowMap, "needsUpdate", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: shadow,
      });
      for (const c of hidden) c.visible = true;
      for (const n of levels) n.visible = false;
      r.autoClear = auto;
      r.setClearColor(clear, alpha);
      v.modelClip.constant = cut;
      s.background = bg;
      s.backgroundIntensity = bgI;
      s.backgroundBlurriness = bgB;
    }
  }

  dispose(): void {
    if (this.probes) this.probes.dispose();
    this.probes = null;
    if (this.lightmaps)
      for (const e of this.lightmaps.entries) {
        applyLightmap(e, false);
        if (e.tex) e.tex.dispose();
      }
    this.lightmaps = null;
    this._setupFor = null;
  }
}
