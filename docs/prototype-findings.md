# Prototype findings: house floorplan prototype (template.html)

Source analysed: `proto/template.html` (165,974 chars). Layout of the file: lines 1-476 are markup plus an inline `<x-dc>` UI template (fonts, panels, buttons); lines 477-1503 are one `<script type="text/x-dc">` block holding a React-style `class Component extends DCLogic` (all app logic). The only external script tag is a runtime bundle (`f942728e...js`) that supplies `React` and `DCLogic`; no app logic lives there. Three.js 0.160.0, OrbitControls, BufferGeometryUtils, GLTFExporter and JSZip are imported at runtime from jsDelivr.

Offsets below are 0-based character offsets into template.html (approximate, from `String.find`). Anonymisation: a person's first name appears in one room id, one light id, one room label and one light name in the source. In this document it is replaced by the placeholder `room_a` / "Room A". Nothing else personal is reproduced (the street address in the page title and the cadastral parcel number are deliberately left out).

Coordinate system used by the prototype ("model metres"): x along the house (west to east), z from the terrace (back) side toward the entrance (front) side, y up, ground floor top = 0.000. Outer wall faces sit at x -0.27..15.87 and z -0.27..10.27.

---

## 1. Scene graph

Declared in `initThree` (offset ~68046). Everything is added directly to `scene` unless noted.

| Node                                                   | Contents                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ground` Mesh                                          | `PlaneGeometry(200,200)`, `mat.ground` (0x3a3b36), y = -0.25 (offset ~73510)                                                                                                                                                                                                                                                                                                                                      |
| loose static meshes (scene children)                   | plinth `B(16.14,0.3,10.54,...)`, thin floor tile boxes, deck, terrace posts and beam, porch slab, paving, white paver rows, curbs, road plane, all ground-floor exterior and interior walls (`Wall()` builds each wall from several boxes around openings), glass panes, window frames, door, facade lamps, downpipes, chimney, etc. After the merge step (see Q2) these are collapsed into one mesh per material |
| `Item` Groups (not merged)                             | each has `userData={id,name,editable:true}`. Furniture (`sofa_living`, `dining_table`, kitchen items, beds, wardrobes, bathtub, ...), `ev_totem`, `sunseeker_x3` (mower), `sunseeker_dock`, `heat_pump`, and later `stairs` (scene) and `stair_wall` (upper). Added/duplicated items get `userData.type/added/src/floor`                                                                                          |
| `upper` Group                                          | Attic (offset ~97068, `base=2.89`, then 3.25)                                                                                                                                                                                                                                                                                                                                                                     |
| `roofG` Group                                          | Roof (offset ~101143)                                                                                                                                                                                                                                                                                                                                                                                             |
| `compass` Group (contains `rose`)                      | ring, 4 arrows, N/E/S/W-style letters Z/A/D/R, at (22,-0.2,13)                                                                                                                                                                                                                                                                                                                                                    |
| `labels` Group                                         | 4 facade-number sprites, numbered side names                                                                                                                                                                                                                                                                                                                                                                      |
| `hemi`, `sun`, `sun.target`                            | lights                                                                                                                                                                                                                                                                                                                                                                                                            |
| `helper`                                               | `Box3Helper` selection box (edit mode)                                                                                                                                                                                                                                                                                                                                                                            |
| `roomLabels` Group, `roomDims` Group                   | room name planes and dimension bars/tags (Q9)                                                                                                                                                                                                                                                                                                                                                                     |
| `garden` Group (built by `buildGarden`, y offset -0.1) | lawn ShapeGeometry, lawn edging, fences, gates, well, cabinet, mulch, fire pit, optional mower-map image plane, 3D neighbour-outbuilding boxes. Rebuilt on prop change, not merged                                                                                                                                                                                                                                |
| `topo` Group                                           | `LineSegments` named `survey`, `features`, `boundaries`, `utilities` (loaded from `topo-lines.json`, y = -0.055)                                                                                                                                                                                                                                                                                                  |
| `markers` Group                                        | red spheres for "Pick points"                                                                                                                                                                                                                                                                                                                                                                                     |
| fixture parts                                          | per light: PointLight/SpotLight, bulb mesh (`bm` material), invisible 0.45 m hit sphere; parented to `scene` (ground/exterior lights) or `upper` (attic light)                                                                                                                                                                                                                                                    |
| a `THREE.Line`                                         | festoon string line (black, 0x151515)                                                                                                                                                                                                                                                                                                                                                                             |

### Ceilings and slabs between storeys

- There is **no ceiling per ground-floor room**. The only separation between storeys is the attic slab, which lives in `upper`:
  - `rects(0.15,15.45,-0.27,10.27,[holes])` at `base=2.89`, each rect `B(q-p, 0.36, b-a, ..., mat.plaster)`, so the slab occupies y 2.89..3.25 (0.36 thick). Holes: terrace niche `[-1,4.925,-1,1.125]`, entrance niche `[5.475,10.125,9.275,11]`, stair hole `HOLE_STAIR=[5.36,8.654,2.86,4.76]`.
  - Attic floor finish: `rects(0.15,15.45,0.15,9.85,[...])` with `B(...,0.02,...,mat.oak)` at base 3.25.
- Terrace ceiling: board ceiling `B(TX+0.27,0.02,-0.27-ZE,...,CEIL-0.001,...,mat.woodS)` with `CEIL = 0.04+2.37 = 2.41`. It is added while `target=roofG`, so it belongs to **roofG** and disappears with the roof in non-exterior views. Also in roofG: terrace ceiling boards at the niche (`B(5.195,0.02,1.395,...)`), roof underside boards (`under()`), soffits, fascia, gutters, rake boards, eave boxes, chimney cladding.
- Entrance-niche board ceiling at +3.000 (`B(4.65,0.02,0.995,7.8,2.98,9.7725,mat.wood)`) is a plain scene mesh.
- Attic extras in `upper`: knee walls (`KW` t=0.42, height `U(z)-3.22`), `kneeX` extruded trapezoids, chimney, posts and top plates at z 3.05 / 6.95 (h=1.6 m zone), the `lowZone` sub-group (translucent amber planes `mat.lowZone`, opacity 0.22, y=3.27, renderOrder 3), gable end walls (`gable()` extrusions with window holes, glass and frames).

### Node by node: what each view shows or hides

The only visibility switches are in `applyLights` (offset ~133772) and `applyTopo`:

```js
t.upper.visible = view!=='ground';
t.roofG.visible = view==='exterior' || this.state.side;
t.compass.visible = view==='exterior' && !this.exporting;
t.labels.visible  = view==='exterior' && !this.exporting && props.showFacadeNumbers!==false;
// applyTopo:
roomLabels.visible = props.showRoomNames!==false && view==='ground' && !exporting;
roomDims.visible   = props.showRoomDims!==false  && view==='ground' && !exporting;
topo.visible       = props.showTopo && view==='exterior';
```

| Node                                                                                    | Exterior                | Ground floor            | Attic                                     |
| --------------------------------------------------------------------------------------- | ----------------------- | ----------------------- | ----------------------------------------- |
| ground plane, plinth, ground-floor walls (3.24 m), floors, deck, porch, furniture Items | shown                   | shown                   | shown (ground-floor walls are not cut)    |
| `upper` (attic slab, knee walls, gables, attic floor, attic light)                      | shown                   | **hidden**              | shown                                     |
| `roofG` (roof, soffits, terrace ceiling, gutters)                                       | shown                   | hidden                  | hidden (shown only if Side section is on) |
| `compass`, `labels` (facade numbers)                                                    | shown                   | hidden                  | hidden                                    |
| `roomLabels`, `roomDims`                                                                | hidden                  | shown (if props on)     | hidden                                    |
| `topo`                                                                                  | shown if `showTopo`     | hidden                  | hidden                                    |
| `garden` group (lawn, fences, well, fire pit)                                           | shown (if `showGarden`) | shown                   | shown (not view-dependent)                |
| Lights listed/clickable                                                                 | all 18                  | only `floor==='ground'` | only `floor==='upper'`                    |

Day/Night does not change visibility, only light intensities and `scene.background` (Q5).
Side-section button: forces `view='upper'` if currently `ground`, makes `roofG` visible, and enables a clipping plane (Q11).
`Wall()` has no storey-based cutaway; "Ground floor" works only by hiding `upper` and `roofG`.

---

## 2. Merging of static geometry

Yes, `BGU.mergeGeometries` is used once (offset ~114001), log message `static meshes merged before → after` (offset ~114177).

- Scope: only **direct children** of three containers: `scene`, `upper`, `roofG`.
- Candidates: `o.isMesh && o.visible && !o.renderOrder && !bms.has(o.material)` (so lamp bulb materials, renderOrder-tagged helpers/labels and invisible meshes are excluded).
- Per mesh: `toNonIndexed()` (or clone), `applyMatrix4(o.matrix)`, keep only `position`, `normal`, `uv` (creates a zero UV if missing), `clearGroups()`.
- Grouping key: `o.material.uuid + '|' + o.castShadow + '|' + o.receiveShadow`. So merge is **per material (plus shadow flags), per container**, not per storey or room.
- Not merged: `Item` groups (furniture, EV totem, mower, dock, heat pump, stairs), lights/bulbs, `lowZone` group, `garden`, `topo`, compass, labels, roomLabels, roomDims (these are groups or added after the merge).
- Room floor slabs are **not** separate meshes after merge. Room floors are thin boxes (`B(w,0.02,d,x,0.002,z,mat.tile)` for 7 tiled zones, listed in the `[[3.5,2.4,2.15,8.45],...]` array near offset ~74000) plus a deck box; they merge into the single `mat.tile` / `mat.deck` meshes. Before merging each is a separate Mesh with no name or userData. There is no per-room floor object.
- Before the merge, a prior pass rewrites UVs of box meshes using `boardMat` (board texture) to metre-based UVs, and swaps thin (<=30 mm) board panels to `boardThin` (polygonOffset -4) to avoid z-fighting.

---

## 3. Layer or category tagging

- No `Object3D.layers` use. No `name` on individual meshes. Tagging is limited to:
  - Items: `userData = {id, name, editable:true}` (+ `type`, `added`, `src`, `floor` for catalogue items). Ids are stable strings such as `sofa_living`, `ev_totem`, `sunseeker_x3`, `sunseeker_dock`, `heat_pump`, `stairs`, `stair_wall`.
  - Group names: `lowZone`, `roomLabels`, `roomDims`, `topo` (children named `survey/features/boundaries/utilities`).
  - Light hit spheres: `userData.id = 'light.xxx'`.
- No fence/terrain/furniture/roof/ceiling category tags exist at runtime. The category is implied only by which container a mesh sits in (`roofG` = roof) and, at export, by position tests (Q3 export tags, Q12).

### userData.fp tags written by "floorplan3d-card (house.glb)" export (`fp3dExport`, offset ~147936)

All tags are objects in `userData.fp` (GLTFExporter writes them as `extras.fp`). Common helper: plan transform `PL([x,z]) = [z+0.27, x+0.27]` (x_plan = model z + 0.27, y_plan = model x + 0.27), origin at the SW outer wall corner (model -0.27,-0.27).

1. **Level groups** (`lvl()`): `g.rotation.y = Math.PI/2; g.position.set(0.27,0,-0.27)`; `userData.fp = {kind:'level', id, ...}`
   - `ground`: `{role:'storey', order:0, elevation:0, height:2.89, label:'1. stāvs'}`
   - `attic`: `{role:'storey', order:1, elevation:3.25, height:2.5, label:'Mansards'}`
   - `exterior`: `{role:'exterior', label:'Ārpuse'}`
   - `roof`: `{role:'roof'}`
2. **Rooms and zones** (`grp()`): `{kind:'room'|'zone', id, label:id, outline:[[x,y]...] (plan metres), doors:[[x,y]...], suggest:{area:id}}`.
   - 13 entries from `FP3D_ROOMS`; the last (terrace, flag `true`) becomes `kind:'zone'` under `exterior`; the others `kind:'room'` under their storey. `doors` = `FP3D_DOORS` midpoints lying on the polygon edge (tolerance 0.02 m); attic has none.
   - Extra zones under `exterior`: `driveway` (label "Bruģis", outline `PAVING`, `suggest:{area:'driveway'}`), `garden` (label "Dārzs", outline `PARCEL`, `suggest:{area:'garden'}`).
3. **Objects**: `{kind:'object', type, id, label, hints, suggest, ...}`
   - Special items: `sunseeker_x3` -> `type:'mower', id:'mower', hints:{front:'-z'}, suggest:{domain:'lawn_mower'}`; `sunseeker_dock` -> `type:'dock', id:'mower_dock', suggest:{domain:'lawn_mower'}`; `ev_totem` -> `type:'ev_charger', id:'ev_charger', suggest:{domain:'sensor'}`; `heat_pump` -> `type:'climate', id:'heat_pump', suggest:{domain:'climate'}`. `label` = the item's display name.
   - Light fixtures: `type:'light'` (or `'light_strip'` for string/strip fixtures), `id` = slug of entity without domain (`living_room`; multi-point circuits get suffix `_1`, `_2`, ...), `label`, `glow:'glow'` (name of the child mesh), optional `group:<base id>` for multi-fixture circuits, `hints:{beam:'spot'|'down'|'point', range:round(max)}`, `suggest:{domain:'switch'|'light', entity:'light.xxx'}`, `ui:{tap:{action:'toggle'}, hold:{action:'popup'}, popup:[...]}` where popup = `['toggle','brightness','color']` (bulb), `['toggle','brightness']` (dimmer), `['toggle']` (relay).
   - Each fixture is a Group at the bulb world position with a child mesh named `glow` (cloned bulb with cloned material, `emissiveIntensity = 0`).
4. Everything else exported is untagged geometry placed under the level/room/zone it falls in (garden group goes under `garden` zone; exterior meshes detected by bounding box outside x -0.27..15.87 / z -0.27..10.27 go under `exterior`; roof group under `roof`).

---

## 4. Renderer (offset ~68500)

```js
new THREE.WebGLRenderer({antialias:true, preserveDrawingBuffer:true});
renderer.setPixelRatio(Math.min(1.5, devicePixelRatio||1));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.25;
renderer.outputColorSpace = THREE.SRGBColorSpace;
camera = new THREE.PerspectiveCamera(35, 1, 0.3, 260);
```

- Sun shadow: `sun.shadow.mapSize.set(2048,2048)`, `bias = -0.0005`, ortho shadow camera `left/bottom -34, right/top 34, near 1, far 120`, `castShadow = true`.
- Point/spot shadows (when enabled): `mapSize 512`, `bias -0.004`, `camera.near 0.15`.
- Environment map: not found (no PMREM, no `scene.environment`). Fog: not found.
- Background per view: not view-dependent; depends on mode only: day `0x2a2d30`, night `0x0e0f10` (`scene.background = new THREE.Color(...)`).
- Render loop renders only when `controls.update()` returns true or `needsRender` is set. Side-section uses `renderer.clippingPlanes`.
- Export renders: pixel ratio forced to 1, JPEG 0.9 for lamp renders, PNG for House Plan backgrounds.

---

## 5. Sun and sky

```js
const nA = (props.north ?? 63.6) * Math.PI/180;      // north slider
t.rose.rotation.y = -nA;                             // compass
const sA = nA + 0.35;                                // +0.35 rad (~20 deg) offset
t.sun.position.set(7 - Math.sin(sA)*38, 34, -6 + Math.cos(sA)*38);
// sun.target fixed at (7, 0, -6); initial creation: sun.position(-6,34,43), colour 0xfff0dc
```

|                                 | Day                                              | Night                                       |
| ------------------------------- | ------------------------------------------------ | ------------------------------------------- |
| Hemisphere light                | sky 0xc4d6ff, ground 0x2a2520, intensity **0.9** | **0.14** (initial value in creation is 0.1) |
| Sun (DirectionalLight 0xfff0dc) | intensity **2.6**                                | **0**                                       |
| Ambient light                   | not found                                        | not found                                   |
| Background                      | 0x2a2d30                                         | 0x0e0f10                                    |

No night fill or moonlight light exists in this file (only the hemisphere 0.14 at night). All building light at night comes from the fixtures (Q7). Default north value 63.6 degrees (prop range 0..359, step 0.1). Compass is a rotating rose, sun azimuth is derived from the same angle.

---

## 6. Materials and textures

All via helper `M(color, roughness, extra) = MeshStandardMaterial` (offset ~69305).

### Procedural textures (all canvas based, `CanvasTexture`, sRGB)

- `makeSeams(base, hi, lo, rep)`: 64x4 canvas, base fill, 3 px highlight column + 2 px dark groove column; `wrap=Repeat`, `repeat.set(rep,1)`, anisotropy 8. Used for board cladding (`rep = 1/0.145`, i.e. 145 mm boards, UVs rescaled to metres), terrace deck/ceiling boards, roof panels (`'#33373a','#4a4f53','#232628'`, repeat 36 for main roof, 23 for terrace roof), thermowood totem (`1/0.105`).
- `makeGrass`: 512x512, base `#4a7433`, 16000 random hsl blades (hue 82-110, sat 38-60%, light 20-40%), faint light bands, `repeat 1/6`, anisotropy 8, rotated with the garden (`grassTex.rotation = -rot`).
- `makePavers`: 256x256, base `#8f8e8a`, 8 rows x 5 bricks, hsl(40,3%,50-58%), `repeat 1/1.28`.
- `makePebbles`: 256x256, base `#8e8a82`, 2600 ellipses, repeat 0.9 (3,3 for the gravel strip).
- Fence textures: 105x4, 65x4, 32x8 canvases with `alphaTest 0.35-0.5`, `NearestFilter` for the board fences, `generateMipmaps=false` for the 3D-mesh panel.
- Logo canvas 256x48 on the heat pump. Label canvases (Q9).

### Material table (colour, roughness, extras)

| Material                                                       | Colour                                    | Rough                    | Metal | Notes                                                             |
| -------------------------------------------------------------- | ----------------------------------------- | ------------------------ | ----- | ----------------------------------------------------------------- |
| wall (interior partitions)                                     | 0xebe7df                                  | 0.92                     | -     |                                                                   |
| plaster (exterior walls, slab, knee walls)                     | 0xeeece7                                  | 0.9                      | -     |                                                                   |
| plinth                                                         | 0x6b6157                                  | 0.94                     | -     |                                                                   |
| wood/board (cladding, all wood variants unified to `boardMat`) | 0xffffff + seams map                      | 0.92                     | -     | `userData.boards = true`; `boardThin` clone with polygonOffset -4 |
| oak (attic floor, posts)                                       | 0xa07a55                                  | 0.55                     | -     | polygonOffset -4                                                  |
| tile (floors)                                                  | 0xcfcbc3                                  | 0.35                     | -     | polygonOffset -4                                                  |
| deck                                                           | 0x7d6149                                  | 0.8                      | -     | polygonOffset                                                     |
| concrete                                                       | 0x9c988f                                  | 0.95                     | -     | polygonOffset                                                     |
| paving (plain) / pavers                                        | 0x4a4e51 / 0xffffff + map                 | 0.94 / 0.9               | -     |                                                                   |
| ground                                                         | 0x3a3b36                                  | 1                        | -     |                                                                   |
| roof (and roofT)                                               | 0xffffff + seam map                       | 0.45                     | 0.3   |                                                                   |
| tin (gutters, chimney)                                         | 0x33373a                                  | 0.45                     | 0.3   |                                                                   |
| frame (window frames, rust-orange)                             | 0xbe752d                                  | 0.58                     | -     |                                                                   |
| door                                                           | 0x39352f                                  | 0.55                     | 0.25  |                                                                   |
| lamp (facade lamp bodies)                                      | 0x141414                                  | 0.42                     | 0.3   |                                                                   |
| glass                                                          | 0x9fb6c4                                  | 0.05                     | 0.1   | `transparent:true, opacity:0.25`; no `transmission` anywhere      |
| grass (lawn)                                                   | 0xffffff + grass map                      | 0.95                     | -     |                                                                   |
| mulch, soil, hedge, fence                                      | 0xb08a5e / 0x3b2a1f / 0x3d5a2f / 0xa9a6a0 | 1 / 1 / 0.9 / 0.95       | -     |                                                                   |
| metal                                                          | 0x2a2a2a                                  | 0.35                     | 0.8   |                                                                   |
| fabric / linen / white / ceramic                               | 0x5d6670 / 0xe8e4dc / 0xf0eee9 / 0xf4f4f2 | 0.95 / 0.95 / 0.5 / 0.15 | -     |                                                                   |
| screen                                                         | 0x0b0c0d                                  | 0.15                     | -     |                                                                   |
| lowZone                                                        | 0xe3b56b, MeshBasicMaterial               | -                        | -     | transparent, opacity 0.22, depthWrite false                       |

Other transparency: `mowerImage` plane (MeshBasicMaterial, additive blending, opacity prop 0.85). No transmission, no clearcoat.

---

## 7. Lamps

### Per-fixture data (state array `lights`, offset ~51000)

Fields: `id, floor ('ground'|'upper'), name, rgb (bool), on, bri (1..255), h (hue deg), s (sat %), pos [x,y,z], max, pts[], dir[], strip[], string, beads[], spot, aim, aims[]`. `max` is the maximum PointLight intensity (the number multiplied by brightness fraction).

| Entity id                 | floor  | type                                                                                   | max | notes                            |
| ------------------------- | ------ | -------------------------------------------------------------------------------------- | --- | -------------------------------- |
| light.living_room         | ground | point                                                                                  | 34  | rgb, pos (2.9,2.55,3.6)          |
| light.dining_table        | ground | point                                                                                  | 12  | rgb, (2.1,1.8,5.75)              |
| light.kitchen             | ground | point                                                                                  | 24  | not rgb                          |
| light.laundry_room        | ground | point                                                                                  | 20  | "Technical room", off by default |
| light.room_a (anonymised) | ground | point                                                                                  | 26  | rgb                              |
| light.bedroom             | ground | point                                                                                  | 26  | rgb                              |
| light.bedroom_2           | ground | point                                                                                  | 26  | rgb                              |
| light.hallway             | ground | point                                                                                  | 24  |                                  |
| light.entrance            | ground | point                                                                                  | 16  |                                  |
| light.bathroom            | ground | point                                                                                  | 20  |                                  |
| light.terrace             | ground | point, 1 pt, dir [0,-1]                                                                | 6   |                                  |
| light.entrance_led        | ground | 3 points + 3 emissive strip boxes (hidden bulbs)                                       | 2.5 | LED coves                        |
| light.terrace_string      | ground | `string:true`, 6 point lights (`STRING(4)`) + 13 emissive bead spheres (`STRING(1.0)`) | 3   | festoon around terrace ceiling   |
| light.terrace_uplights    | ground | `spot:true`, 3 SpotLights (post uplights)                                              | 10  |                                  |
| light.back_facade_lamp    | ground | point, dir [0,-1]                                                                      | 5   |                                  |
| light.facade_lamps        | ground | 4 points                                                                               | 5   |                                  |
| light.bedroom_end_lamps   | ground | 2 points, dir [1,0]                                                                    | 5   |                                  |
| light.attic               | upper  | point                                                                                  | 30  | rgb                              |

Light objects (offset ~107600):

```js
const pl = l.spot ? new THREE.SpotLight(0xffffff, 0, 7, 0.42, 0.6, 1.4)  // intensity, distance 7, angle 0.42 rad, penumbra 0.6, decay 1.4
                  : new THREE.PointLight(0xffffff, 0, 0, 2);              // distance 0 (infinite), decay 2
pl.shadow.mapSize.set(512,512); pl.shadow.bias=-0.004; pl.shadow.camera.near=0.15;
// spot target: l.aims[i] (explicit) else (x, 2.2, l.aim); aim = POST_Z-0.55 for uplights
```

Multi-point fixtures are offset by `dir*0.12` from the bulb mesh. Spot target is parented to `upper` or `scene`.

### Glowing mesh and colour handling

- One material `bm = MeshStandardMaterial({color:0x222222, roughness:0.4, emissive:0xffffff, emissiveIntensity:0})` is shared by all bulb meshes of a fixture. Geometries: single lamps = sphere r 0.08; strings = sphere r 0.04 (beads); spot = box 0.09x0.006x0.09; wall lamps = 0.03x0.17x0.05 or 0.05x0.17x0.03; strips = thin boxes; strip bulbs hidden.
- Per update (`applyLights`):

```js
const [r,g,b] = hsv(s.h??0, s.s??0);        // custom HSV(value=1) -> RGB, h deg, s %
const f = s.on ? s.bri/255 : 0;
o.pls.forEach(pl => { pl.color.setRGB(r,g,b,THREE.SRGBColorSpace); pl.intensity = f*l.max; pl.castShadow=false; });
o.bm.emissive.setRGB(r,g,b,THREE.SRGBColorSpace); o.bm.emissiveIntensity = f*3;
```

- hs_color maps directly to (h,s) (`hs_color` also appears in the exported YAML). Colour temperature or mireds/kelvin: **not found**. "Warm white" is just a swatch preset `['Warm white',35,45]` (h 35, s 45); "Cool white" `210,6`. Other presets: Red 0/100, Amber 28/100, Magenta 315/85, Violet 265/80, Blue 220/90, Teal 175/85.
- Relay warm white: choosing Relejs sets `h:30` and `s: min(s,45)`; Dimmer keeps `h` and clamps `s` to 45; Gudrā spuldze leaves colour alone.

### Real-light budget

- All 31 lights (11 single + 20 multi-point incl. 3 spots) exist permanently with intensity 0 when off (no add/remove).
- Shadow casting: `shadowBudget = 4`. Only single-point fixtures (`!l.pts`) that are on and in the current view cast shadows, first 4 in array order; all others `castShadow=false`. (Comment in source says the GPU sampler limit is 8.)

### Modes ("Relejs / Dimmer / Gudrā spuldze") and "Fiksēta"

`ctrlOf(l) = l.ctrl || (l.rgb ? 'bulb' : 'relay')`.

- UI: Relejs hides the brightness slider and swatches; Dimmer shows slider (1..255); Gudrā spuldze shows slider + 8 colour swatches. Persisted in localStorage `house-layout-v1` under `lightCfg[id] = {ctrl, locked}`.
- 3D rendering: the mode does **not** change intensity maths (brightness still scales intensity even in relay mode); it only affects the controls and colour clamp described above.
- HA attributes in exported YAML (`buildYaml`, offset ~136700): relay: overlay opacity `state==='on' ? '1' : '0'`; dimmer and bulb: opacity `brightness/255` (default 255); bulb additionally `filter: hue-rotate(hs_color[0] deg) saturate(hs_color[1]%)`. In the house.glb export: relay -> `suggest.domain:'switch'`, others `'light'`; `ui.popup` as in Q3.
- "Fiksēta" (fixed) / "Pārvietojama" (movable) toggle: `locked` flag (default true). A locked light cannot be dragged in Edit layout (`nearLight(e,movable)` skips locked), lets the user reposition fixtures after unlocking.
- There is no real HA connection: state is local component state; the HA bits are produced only as YAML text.

---

## 8. Camera presets and controls

No tween or easing exists (the word is not used for camera animation); `setCam(p, target)` sets position and target instantly and calls `controls.update()`. Perspective camera: fov 35, near 0.3, far 260.

| Preset (function)                          | Position                 | Target             | Distance / polar (from vertical) / azimuth (from +z toward +x) [computed] |
| ------------------------------------------ | ------------------------ | ------------------ | ------------------------------------------------------------------------- |
| Perspective, ground or attic (`resetView`) | (7.8, 17, 21)            | (7.8, 0, 5)        | 23.3 m / 43.3 deg / 0 deg                                                 |
| Perspective, exterior with garden          | (24, 26, 34)             | (7.8, 0, 5)        | 42.2 m / 51.9 deg / 29.2 deg                                              |
| Perspective, exterior without garden       | (7.8, 12, 30)            | (7.8, 1.5, 5)      | 27.1 m / 67.2 deg / 0 deg                                                 |
| Top down, exterior with garden             | (7.8, 64, 5.02)          | (7.8, 0, 5)        | 64 m / ~0 deg                                                             |
| Top down, other cases                      | (7.8, 26, 5.02)          | (7.8, 0, 5)        | 26 m / ~0 deg                                                             |
| Side section                               | (sectionX+20, 4.6, 5.01) | (sectionX, 3.8, 5) | ~20 m / ~88 deg / 90 deg (looks along -x)                                 |

OrbitControls: `enableDamping=true`, `maxPolarAngle = Math.PI*0.47` (about 84.6 deg, camera cannot go below the horizon), `minDistance 4`, `maxDistance 130`; no azimuth limits, no pan limits.
Export cameras: `orthoCam(ORTHO_BOX = [-6,29,-30,20])` looking down from y=80, `up=(0,0,-1)`, near 1, far 200 (see Q12).

---

## 9. Room labels and dimension lines

Both are flat canvas-textured planes lying on the floor (not DOM, not sprites), `rotation.x = -PI/2`, `depthTest:false`, `depthWrite:false`, only shown in Ground-floor view (props `showRoomNames`, `showRoomDims`, both default true) and hidden during exports.

**Room names (`roomLabels`, offset ~107800)**: canvas per label, font `600 56px "IBM Plex Sans", sans-serif`; width = text width + 48, height 56+36; background `rgba(17,18,19,0.72)` rounded rect radius 18; text colour `#f3efe6`, centred. World height 0.5 m (width scaled by aspect), at y = 0.05, `renderOrder 20`. 11 labels from `ROOM_NAMES` (name, x, z).

**Dimension guides (`roomDims`)**: for each of the 6 measured rooms in `ROOM_RECTS`:

- Orange bar (colour 0xe3b56b) along x (length), at z0+0.3, with end ticks (0.035 x 0.25 m); tag text `'garums ' + Math.round((x1-x0)*1000)`, (pill `#e3b56b`, text `#111213`).
- Teal bar (colour 0x5cc8c0) along z (depth), at x0+0.3; tag text `'dziļums ' + Math.round((z1-z0)*1000)`, pill `#5cc8c0`, rotated 90 deg (rot = PI/2), offset +0.9 along the bar.
- Tag canvas font `600 44px "IBM Plex Sans"`, pill radius 12, height 0.46 m, y = 0.06, `renderOrder 21`. Bars: BoxGeometry(L, 0.01, 0.06) at y=0.055, `MeshBasicMaterial depthTest:false`.
- Content is millimetres of inner room size. The word "platums" is **not found**; the terms are "garums" (length along the terrace facade) and "dziļums" (depth terrace to entrance).

Facade labels (exterior): 4 world-scaled `Sprite`s (IBM Plex Sans, light background, `depthTest false`, renderOrder 10) with numbered side names.

---

## 10. Lights panel

- Visible lights = lights whose floor matches the view (`inView`: exterior shows all, ground shows ground, attic shows upper). Header line: `<View name> · N of M lights on` or "All lights off".
- Grouping: by model-derived area (attic / room rectangles by light position / outdoor bands by z), not by HA area.
- In Exterior view an extra card list shows the wallbox and the mower.
- Each light card: dot + glow in the lamp colour, name, on/off switch, mode segmented control, "Fiksēta/Pārvietojama" button, brightness slider (`type=range 1..255`, setting brightness also turns the light on), colour swatches (8 presets).
- Four mode buttons:
  - **Relejs** (`ctrl:'relay'`): on/off only; sets h=30, s<=45.
  - **Dimmer** (`'dimmer'`): on/off + brightness; s<=45, hue kept.
  - **Gudrā spuldze** (`'bulb'`): on/off + brightness + colour; colour untouched.
  - **Fiksēta / Pārvietojama**: not a mode; locks or unlocks dragging of that light's position in Edit layout.
- Top bar buttons related: "All off" turns every light off.

---

## 11. Toolbar and view tools

- **Pick points** (`togglePick`): enters pick mode (turns Edit off, shows panel). Click on the model (movement < 12 px counts as a click in pick mode) raycasts all visible meshes; adds a red sphere marker (r 0.07, renderOrder 12, depthTest off) and a point record `{n:'P1'.., what, x,y,z}` where mm = round(coordinate*1000) with +0.27 added to x and z (so values are measured from the living-room outer corner; y from ground floor 0). `what` = nearest ancestor `userData.name`, else "roof" / "attic / roof" / "house". Each point can be tagged with one of `PT_TAGS` (Latvian labels: delete / niche / opening without door / door / move here, with colours 0xff5a4f, 0x5cc8c0, 0xe3b56b, 0x7ac46b, 0xb38cff). "Copy for chat" writes lines such as `P1 (house) [Durvis]: X .., Y .., Z .. mm` to the clipboard (textarea fallback); "Clear" removes markers.
- **Edit layout** (`toggleEdit`): select furniture, garden element or light (nearest light within 30 px, 52 px for touch), drag on a horizontal plane (position snapped to 0.01 m), keys: R rotate 90 (Shift = -90), Delete, arrows nudge 0.05 m, Esc deselect; buttons for rotation +-15/90, duplicate, delete, lights raise/lower 0.1 m, catalogue Add (17 types), Reset layout (clears localStorage and reloads). Persists in `localStorage['house-layout-v1']` as `{items:{id:{x,z,ry}|{deleted}}, added:[], lights:{id:[x,y,z]}, lightCfg:{id:{ctrl,locked}}}`.
- **Side section** (`sideView`, prop `sectionX` default 7.0, range 0..15.6 m step 0.1): toggles a clipping plane `Plane((-1,0,0), sectionX)` on the renderer so everything east of x=sectionX is cut; forces Attic view if Ground was active, shows roof, moves camera to (sectionX+20, 4.6, 5.01) looking at (sectionX, 3.8, 5). Toggling off calls `resetView`.
- **Top down** (`topView`): turns Side off, camera straight above (table in Q8).
- **Perspective** button = `resetView` (turns Side off).
- **Compass**: group `compass` at (22,-0.2,13) in the exterior view only; ring r 1.7-1.82, orange north arrow plus three grey arrows, letters Z, A, D, R at 2.4 m (Latvian cardinal abbreviations). `rose.rotation.y = -north`.
- **north slider** (prop `north`, "Orientation" section, default 63.6 deg, 0..359, step 0.1): rotates the compass rose and the sun azimuth (Q5). It does not rotate the house.
- Mower-map alignment (`toggleAlign`/`alignClick`/`fitMap`): code exists (2 pairs = similarity, 3+ = affine fit, stored in `house-mowerfit-v1`) but the markup does not render a button for it in this file ("alignHint" is computed but unused in the template).

---

## 12. Exports

### "Export for Home Assistant" (`openExport` / `download`)

Opens a modal with YAML text from `buildYaml`, plus a "Download renders + YAML (.zip)" button. Produces `<view>_floorplan.zip` containing: `<view>_base.jpg` (all lights off, night), one `<view>_<light_slug>.jpg` per light in the view (that light on, bri 255, red-hue 0/100 for bulb mode, mower hidden), and `<view>_floorplan.yaml`. Render: width 1920, JPEG 0.9, current camera (or orthographic top view if prop `exportTopOrtho` and Exterior).
YAML: `type: custom:config-template-card` wrapping a `picture-elements` card: base image `/local/floorplan/<view>_base.jpg`, one `type: image` element per light with `mix-blend-mode: lighten` and templated opacity/hue-rotate (Q7), one `state-icon` per light (position = projected screen % of `l.pos`, tap `toggle`), and, for Exterior, conditional Wallbox and Sunseeker markers plus (in ortho mode) a camera image overlay with a CSS matrix computed from the mower-map fit.

### "floorplan3d-card (house.glb)" (`fp3dExport`)

Builds a new `THREE.Scene` containing level groups `ground`, `attic`, `exterior`, `roof` with room/zone/object groups tagged with `userData.fp` (Q3), clones scene meshes into them (skips lights, sprites, lines, helpers, `lowZone`, light-entity items, transparent meshes with opacity <0.6 such as glass, and planes >=100 m wide i.e. ground), runs `GLTFExporter.parseAsync(root,{binary:true,maxTextureSize:2048,onlyVisible:false})`. Output: `house_house_glb.zip` with `house.glb` and a README noting levels ground (0 / 2.89) and attic (3.25 / 2.5), objects (lamp fixtures, mower, mower_dock, ev_charger, heat_pump), "plan north = house long axis", `environment.north = -26.4` (true north is 26.4 degrees west of model north; = 333.6), and instructions `model: /local/house.glb`. Plan coordinates: x = model z + 0.27, y = model x + 0.27.

### "House Plan backgrounds (PNG)" (`housePlanExport`)

For three jobs (ground, attic, exterior) it switches view, forces Day mode, all lights off, hides labels/dims/markers/helper, renders an **orthographic top-down PNG** with `orthoCam(B)`:

- ground and attic: box `HB = [-1.0,16.6,-3.0,11.2]` at 150 px/m -> 2340 x 2130 px; files `house_ground.png`, `house_attic.png`;
- exterior: `ORTHO_BOX = [-6,29,-30,20]` at 60 px/m -> 2100 x 3000 px; `house_site.png`.
  Zip `house_houseplan.zip` also contains `README.txt` (Latvian) listing each image's pixel size, px/m and covered model x/z extent (top = terrace side) and steps for the "House Plan" HACS card (create a space per storey, upload PNG, outline rooms, bind HA areas). Afterwards the original view/mode is restored.

---

## Rooms, ids and entities

Room names, measured room rectangles, door points, entity ids and map-fit constants of the real house are
intentionally not recorded here. The model export writes rooms with stable ids and outlines (`fp.outline`,
`fp.doors`); bind them to HA areas in the card.
