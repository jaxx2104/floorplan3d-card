# View switching rules — Exterior / Ground floor / Attic

This is exactly what the Sample House model does when the view changes. Nothing is cut by height. Every object belongs to one of four buckets, and a view only switches whole buckets on or off.

## Buckets (scene structure)

| Bucket                                           | Contains                                                                                                                                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ground** (scene root)                          | ground slab, all ground-floor walls (full height to the ceiling at +2.89), windows, doors, ground furniture, stairs, terrace deck, facade cladding up to +3.0, porch, chimney base                                |
| **exterior** (scene root, outside the footprint) | lawn, paving, road, fences, gates, trees, shrubs, flower beds, mower, dock, EV charger, heat pump                                                                                                                 |
| **attic** (`upper` group)                        | attic slab at +3.25 (the ceiling of the ground floor, see below), attic walls, knee walls, attic furniture, stair wall + railing, chimney through the attic, the zones under 1.6 m (posts + plate + shaded floor) |
| **roof** (`roofG` group)                         | roof planes, ridge, fascia, gable barge boards, soffits/eaves boxes, terrace roof **and the terrace ceiling boards**                                                                                              |

Key rule: **the slab between storeys belongs to the storey above.** Hiding the attic removes the ground floor's ceiling too, so you look straight into the rooms, and the wall tops end cleanly at +2.89.

## Visibility per view

|                  | ground | exterior | attic | roof |
| ---------------- | ------ | -------- | ----- | ---- |
| **Exterior**     | ✓      | ✓        | ✓     | ✓    |
| **Ground floor** | ✓      | ✓        | –     | –    |
| **Attic**        | ✓      | ✓        | ✓     | –    |

General rule for N storeys: show the selected storey and every storey below it (not ghosted, the slab above them hides the interior), hide all storeys above it, show the roof only in Exterior/All, and always show the exterior.

## What follows the view

- **Lights / devices:** a device is shown and clickable in the view if `view == 'exterior'` OR `device.floor == view`. So Exterior shows everything. Ground floor shows only ground devices plus outdoor ones (outdoor devices count as floor `ground`). Attic shows only attic devices.
- **Real light sources** stay physically on in every view (light from a ground lamp still shows through the windows). Only markers, hit areas and shadow budget follow the view: at most 4 shadow-casting lights, chosen only from lamps that are visible in the current view.
- **Labels:** facade numbers and the compass only in Exterior. Room names and dimension lines only in Ground floor.
- **Picking:** only against visible buckets (a raycast skips hidden parents). The light tap uses a screen-space nearest-marker search over visible lamps: 52 px on touch, 30 px with a mouse.

## Camera per view (model world, Y up, metres; house centre ≈ (7.8, 0, 5))

| View                   | position                               | target        |
| ---------------------- | -------------------------------------- | ------------- |
| Exterior (with garden) | (24, 26, 34)                           | (7.8, 0, 5)   |
| Exterior (no garden)   | (7.8, 12, 30)                          | (7.8, 1.5, 5) |
| Ground floor           | (7.8, 17, 21)                          | (7.8, 0, 5)   |
| Attic                  | (7.8, 17, 21)                          | (7.8, 0, 5)   |
| Top down               | straight above the target, same target |               |

The camera keeps its current position when you switch view. It moves only on "Reset view" / "Top down". A tween of about 400 ms is recommended for the card.

## Camera: rotation, zoom, pan (exact settings)

three.js `PerspectiveCamera` + `OrbitControls` (examples/jsm). The settings are:

```js
const camera = new THREE.PerspectiveCamera(35, aspect, 0.3, 260); // narrow 35° FOV = less distortion, more "architectural"
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;           // inertia, default dampingFactor 0.05 — call controls.update() every frame
controls.maxPolarAngle = Math.PI * 0.47; // ~85°: can't orbit below the ground plane
controls.minDistance = 4;                // m, closest zoom to the target
controls.maxDistance = 130;              // m, whole plot + street fits
```

Everything else is the OrbitControls default:

- **Rotate:** left mouse drag or one finger. It orbits around `controls.target` (the house centre unless the user pans), with no azimuth limit (full 360°).
- **Zoom:** mouse wheel or pinch. It dollies toward the target (not toward the cursor), clamped to 4–130 m.
- **Pan:** right mouse drag, Ctrl/Shift + drag, or two fingers. It moves camera and target together, parallel to the screen (`screenSpacePanning = true`).
- **Top down:** the camera goes straight above the target (+0.02 m z offset, so OrbitControls keeps a defined "up"). Height: 26 m for floors, 64 m for exterior with garden.
- **Reset view:** jumps to the preset for the current view (table above). Switching view tabs does **not** move the camera.

Interaction with tapping and editing:

- A press counts as a **tap** (toggle a lamp, add a pick point) only if the pointer moved less than 5 px (12 px in pick mode). Otherwise it was an orbit or pan.
- In **edit mode**, a press on a movable object turns OrbitControls off (`controls.enabled = false`) for the drag. The object moves on a horizontal plane at the hit height. Controls come back on pointer-up. A press on empty space still orbits.

Performance: render on demand only. Render when `controls.update()` reports movement (it keeps returning true while damping settles), on the `change` event, on pointer or wheel input, and on any state change. Nothing is rendered while the camera is still. The pixel ratio is capped at 1.5.

Card recommendations:

- Keep the same limits.
- Add a ~400 ms tween for Reset and Top down.
- Optionally clamp the panned target to the plot bounds, so users can't lose the house.
- Optionally set `zoomToCursor = true` (three r155+) for easier zooming on a wall tablet.

## Attaching lights and devices so they never drift

Everything a device draws is a **real 3D object in the scene graph**, parented to the same node as the building part it belongs to. Nothing is an HTML overlay positioned in screen space. Rotation and zoom only move the camera, so every marker keeps its 3D location by construction.

### Hierarchy (per light)

```
level node (ground → scene root, attic → upper group)
 └─ fixture parts, all children of the SAME level node, positions in model metres:
     ├─ bulb mesh   — small real-size geometry (Ø 4–9 cm), MeshStandardMaterial, emissive = glow
     ├─ PointLight / SpotLight at the bulb (+ SpotLight.target object, also parented to the level)
     └─ hit sphere  — r = 0.45 m, visible=false, userData.id = entity_id (for raycasts)
```

- **Parent to the level, not to a wall mesh or furniture.** When the level is hidden, its devices hide with it. A device is never re-parented on view change.
- **Positions are fixed metres** in the level's local space. They come from the model or from edit-mode drags, and are saved as `[x, y, z]` per entity.
- Moving a light in edit mode changes `position.x/z` of all its parts together (bulb, light and hit sphere move as one). Raise/lower changes `y` in 10 cm steps.
- **Multi-fixture circuits** (one HA entity driving 4 facade lamps) have one set of parts per fixture. They share one material, so one emissive change lights all of them.
- **Devices that are models** (mower, dock, EV charger, heat pump, furniture) are a `Group` with its pivot at the footprint centre, on the floor (y = level floor). Moving or rotating the group moves the whole thing.

### Scale on zoom: none for 3D parts

- Bulbs, hit spheres, labels on the floor (room names, dimension lines) and device models are **world-size**. They get bigger or smaller with perspective, exactly like the walls, so they read as part of the house.
- The only things that are effectively screen-constant are **interaction targets**. Lamp taps do **not** raycast the 0.45 m sphere. Instead, every visible lamp's world position is projected to screen pixels each tap, and the nearest one within **52 px (touch) / 30 px (mouse)** wins. So tapping is equally easy at 4 m and at 130 m, while the 3D marker stays where it is.

```js
const p = lamp.getWorldPosition(v).project(camera);           // NDC
if (p.z > 1) continue;                                        // behind camera
const sx = (p.x + 1) / 2 * rect.width + rect.left, sy = (1 - p.y) / 2 * rect.height + rect.top;
if (Math.hypot(sx - e.clientX, sy - e.clientY) < radiusPx) …  // nearest wins
```

- **Facade numbers** (Exterior only) are `THREE.Sprite` with world scale (`sizeAttenuation` on): they always face the camera, but stay at their 3D anchor and scale with distance.

### If the card wants screen-constant icons (HA-style badges)

Keep the anchor in 3D and only scale the visual:

```js
// per frame, for each icon sprite anchored at a fixed world position
const d = camera.position.distanceTo(icon.position);
const worldPerPx = 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / renderer.domElement.clientHeight;
icon.scale.setScalar(ICON_PX * worldPerPx);   // e.g. ICON_PX = 28 → always 28 px tall
```

- Or use `SpriteMaterial({ sizeAttenuation: false })` with `scale` in NDC units.
- Never position icons with CSS from a projected point unless you re-project **every frame** (including damping frames). A one-off projection drifts as soon as the camera eases.
- Put the icon **above** the fixture (e.g. +0.15 m) with `depthTest: true`, so walls hide icons of rooms behind them. Use `depthTest: false` only for the selected device or a highlight.
- Give icons `renderOrder` > building, and make them non-raycastable (or use the screen-space pick above).

### Why it stays stable

1. One coordinate system: model metres. glb, edit mode and HA pins all use plan metres, converted once (plan x,y → world x, h, −y in the glb).
2. Nothing is parented to the camera, and no object depends on screen size, except the optional icon scale computed from distance.
3. The render loop re-projects after `controls.update()` every frame, so anything screen-derived (pick radius, badge scale) is always current, including during damping.

## Shadows and light effects (why it looks good)

There are no post-processing passes, no baked lightmaps and no extra libraries. The look comes from five things working together.

### 1. Renderer: physically based, tone-mapped, sRGB

```js
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;      // soft-edged, filtered shadows
renderer.toneMapping = THREE.ACESFilmicToneMapping;     // film curve: highlights roll off instead of clipping
renderer.toneMappingExposure = 1.25;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(1.5, devicePixelRatio));
```

- **ACES is the main trick.** Many overlapping warm lamps add up in linear space, and ACES compresses them softly. You get a warm "pool" of light that fades out, instead of flat white patches. Without tone mapping, night scenes look like a game from 2005.
- **All colours are converted as sRGB:** `color.setRGB(r, g, b, THREE.SRGBColorSpace)` and `texture.colorSpace = SRGBColorSpace`. Mixing linear and sRGB is the most common reason for washed-out or too-dark lighting.
- All materials are `MeshStandardMaterial` (PBR) with high roughness (0.8–0.95) for plaster, wood, grass and concrete, and lower roughness (0.35–0.55) for tiles, metal and the roof. The roughness differences make light read differently on each surface.

### 2. Day vs night: two global lights only

```js
const hemi = new THREE.HemisphereLight(0xc4d6ff /*cool sky*/, 0x2a2520 /*warm ground bounce*/, 0.1);
const sun  = new THREE.DirectionalLight(0xfff0dc /*warm white*/, 0);
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left:-34, right:34, top:34, bottom:-34, near:1, far:120 }); // tight to the plot
sun.shadow.bias = -0.0005;
```

|       | hemi | sun | background |
| ----- | ---- | --- | ---------- |
| Day   | 0.9  | 2.6 | #2a2d30    |
| Night | 0.14 | 0   | #0e0f10    |

- **The hemisphere light acts as cheap ambient occlusion.** It has a cool top and a warm bottom, so surfaces facing up and surfaces facing down shade differently, and corners read without SSAO.
- **The sun's direction comes from true north:** `azimuth = north + 0.35 rad`, elevation about 40°, and the shadow falls the way it does on the real site. The shadow box only covers the plot (±34 m), so 2048² gives sharp shadows. Fitting the box tightly matters more than a bigger map.
- **At night the sun is 0 and its shadow costs nothing.** All mood comes from the lamps against an almost-black hemisphere.

### 3. Lamps = emissive mesh + real light (no bloom)

Per fixture:

```js
// glow you SEE
bulb.material.emissive.setRGB(r, g, b, SRGBColorSpace);
bulb.material.emissiveIntensity = (bri / 255) * 3;        // > 1 so ACES pushes it to near-white core + coloured edge
// light that LIGHTS the house
point = new THREE.PointLight(color, (bri/255) * max, 0 /*infinite*/, 2 /*physical decay*/);
spot  = new THREE.SpotLight(color, (bri/255) * max, 7 /*m*/, 0.42 /*≈24°*/, 0.6 /*penumbra*/, 1.4 /*decay*/);
```

- **The bulb is small** (Ø 8 cm, or a 4 cm bead for the festoon string). An emissive intensity of 3 overdrives it, and tone mapping turns that into a hot white centre, so it _reads_ as glowing without a bloom pass.
- **Physical decay (2) on point lights** gives a natural falloff: bright near the lamp, a soft gradient on the walls and floor. `max` is set per fixture, so a 5 W facade lamp and a 34 W living-room fitting look right next to each other.
- **Spots for facade, up-lights and floor lamps** use a wide penumbra (0.6) for soft edges. Each spot aims at a real target (the post it lights, or the wall below the lamp), which gives the scallop shapes on the cladding.
- **The light colour drives both the emissive and the light,** so an RGB bulb in HA tints its pool on the floor too.
- **Light sits 12 cm in front of wall lamps** (the bulb is 4.5 cm out), so the wall right behind the lamp doesn't blow out or hide behind its own shadow.

### 4. Shadow budget for lamps (key for performance and looks)

```js
pl.shadow.mapSize.set(512, 512); pl.shadow.bias = -0.004; pl.shadow.camera.near = 0.15;
```

- **At most 4 lamp lights cast shadows at once,** and only lamps that are on, visible in the current view, and single fixtures. A point-light shadow is a cube (6 maps), and WebGL has a limit of about 16 texture samplers. Above that, shaders fail to compile on phones.
- **Multi-fixture circuits** (4 facade lamps, the terrace string) never cast shadows. Their overlapping spots fill each other in, and that looks fine.
- **512² with bias −0.004** is enough for room-scale lights: soft, with no acne on walls. A larger map only shows aliasing on PCF soft edges.
- **The budget is re-evaluated on every state change,** so the shadow "moves" to whichever lamps you turn on.

### 5. Meshes set up for shadows

- `castShadow + receiveShadow` on walls, roof, furniture, fences and trees.
- **Floor overlays don't cast shadows:** lawn edging, labels, paving decals, glass and thin trims (`add(mesh, false)`). Otherwise they cause acne and cost shadow-pass draws.
- **Glass:** `transparent`, no shadow casting, so light passes through windows. Room light spills onto the terrace, and outside lamps light the rooms.
- **Merged static meshes** (by material) make the shadow pass cheap, about 10× fewer draw calls. That is why 4–5 shadowed lights still run at 60 fps on a phone.

### What to copy into the card

1. ACES + sRGB output + PCFSoft, exposure about 1.2.
2. Hemi (cool/warm) + one sun with a tight shadow box over the plot, rotated by `fp.north`.
3. Per light: emissive `glow` mesh with intensity ×3 of brightness + Point (decay 2) or Spot (penumbra about 0.6) using `hints` from the glb.
4. A shadow budget of about 4 shadowed lamps, chosen from visible + on, 512² maps, bias about −0.004.
5. Optional bloom only on desktop: `UnrealBloomPass` threshold about 0.9, strength 0.4, radius 0.3, emissive only. Off on mobile and wall tablets.

## Camera modes: Perspective, Top down, Side section

All coordinates are model world: Y up, metres. The house spans x −0.27…15.87 (long axis, west→east) and z −0.27…10.27 (terrace side → entrance side), so its centre is about **(7.8, 0, 5)**. Every mode uses the same `PerspectiveCamera(35°)` + OrbitControls. A mode only sets **position + target** (and for Section, one clipping plane). After that, the user can orbit freely again.

### 1. Perspective (default, "Reset view")

| View                 | position      | target        | feel                                                                              |
| -------------------- | ------------- | ------------- | --------------------------------------------------------------------------------- |
| Exterior + garden    | (24, 26, 34)  | (7.8, 0, 5)   | 3/4 aerial from the entrance/bedroom corner, about 38° down, whole plot visible   |
| Exterior, no garden  | (7.8, 12, 30) | (7.8, 1.5, 5) | front elevation, slightly from above, house fills the frame                       |
| Ground floor / Attic | (7.8, 17, 21) | (7.8, 0, 5)   | from the entrance side, about 45° down into the open rooms (attic or roof hidden) |

- **The target is always the house centre at floor level,** so orbiting turns around the middle of the plan.
- **A 35° FOV from 20–40 m** gives an "architectural model" look: little perspective distortion and nearly parallel walls.

### 2. Top down

| View               | position            | target      |
| ------------------ | ------------------- | ----------- |
| Exterior + garden  | (7.8, **64**, 5.02) | (7.8, 0, 5) |
| Floors / no garden | (7.8, **26**, 5.02) | (7.8, 0, 5) |

- **Straight down.** The tiny **+0.02 m z offset** is required: OrbitControls can't build a view matrix when the camera is exactly above the target (gimbal lock with `up = +Y`). With the offset, screen-up points to −z, which is the terrace side.
- **It is still a perspective camera.** Walls show a little lean at the edges, which helps you read the height. The user can orbit out of it at any time.
- **For pixel-exact plans** (House Plan backgrounds, mower overlay), the export uses an **OrthographicCamera** instead:

```js
const c = new THREE.OrthographicCamera(-w/2, w/2, h/2, -h/2, 1, 200);   // w,h = box size in metres
c.position.set(cx, 80, cz); c.up.set(0, 0, -1); c.lookAt(cx, 0, cz);   // up = −z → terrace side at the top
```

- **Floors:** box x −1…16.6, z −3…11.2, at 150 px/m.
- **Site:** box x −6…29, z −30…20, at 60 px/m (also 1920 px wide for the mower live-map YAML).
- **Pixel ↔ metre** is a plain linear mapping: `x = x0 + px/ppm`, `z = z0 + py/ppm`.

### 3. Side section

A vertical cut through the house, looked at from the side, to read the attic profile: knee walls, the zone under 1.6 m, roof build-up and stairs.

```js
cut = new THREE.Plane(new THREE.Vector3(-1, 0, 0), sectionX);   // keeps x < sectionX, removes everything east of it
renderer.clippingPlanes = [cut];                                 // global clip, all materials
camera.position.set(sectionX + 20, 4.6, 5.01); controls.target.set(sectionX, 3.8, 5);
```

- **`sectionX` defaults to 7.0 m** (through the stairs and the middle of the attic). It is a Tweak, 0–15.6 m.
- **The camera looks west at the cut face,** at eye level a bit above the attic floor (target y 3.8). That gives a true section elevation.
- **Section forces the roof and the attic visible.** From the Ground view it switches to Attic, because the point is to see storeys + roof in profile.
- **Wall caps:** the cut leaves walls hollow. Draw dark-grey caps with a stencil pass, or simply use double-sided interior materials so the inner faces read as a solid wall colour (the model's approach).
- **Turning Section off** (or pressing Reset / Top down) clears `clippingPlanes` and returns to the Perspective preset.
- **The only clipping in the whole model is this plane.** Level switching never clips.

### Card implementation

```js
const CAM = {
  perspective: { exterior: [[24,26,34],[7.8,0,5]], ground: [[7.8,17,21],[7.8,0,5]], attic: [[7.8,17,21],[7.8,0,5]] },
  top:         { exterior: [[7.8,64,5.02],[7.8,0,5]], ground: [[7.8,26,5.02],[7.8,0,5]], attic: [[7.8,26,5.02],[7.8,0,5]] },
  section:     x => [[x+20,4.6,5.01],[x,3.8,5]],
};
function go([p, t], ms = 400) { tween(camera.position, p, ms); tween(controls.target, t, ms); } // ease-in-out, call controls.update() per frame
```

- **Store presets per glb** in `fp.views[*].camera` (already exported for Perspective). Add `camera_top` and an optional `section: { normal:[-1,0,0], constant:7 }`, or compute Top down from the level bounding box: centre + height = max(w, d) / (2·tan(fov/2)) × 1.1.
- **Switching level tabs keeps the current camera;** only these buttons move it.
- **When converting to glTF coordinates for the card,** use the same mapping as the export: model (x, y, z) → glTF (z + 0.27, y, −x − 0.27).

## Mapping to the house.glb contract

The exported glb uses `extras.fp` levels: `ground` (storey, order 0), `attic` (storey, order 1), `exterior` (role exterior), `roof` (role roof). It has the same table as `fp.views`:

```
exterior: show [all]
ground:   show [level:ground, role:exterior]  hide [level:attic, role:roof]
attic:    show [level:ground, level:attic, role:exterior]  hide [role:roof]
```

Card implementation: on view change, set `node.visible` per level from the view's show/hide selectors. Filter markers by their level the same way. Restrict the raycast to visible levels. Don't use clipping planes.
