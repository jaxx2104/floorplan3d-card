# Model contract v2: self-describing house models, controlled from Home Assistant

Status: design approved in chat, spec awaiting review
Date: 2026-10-01

## Goal

A house model (.glb) is built once by a separate design session and uploaded to the card. It
describes _what exists_ (levels, rooms, outdoor zones, fixtures such as lamps, a charging
station, the mower). Everything that connects it to Home Assistant (which HA floor a level is,
which area a room is, which entity drives a lamp, what a tap does, what a popup shows) is set in
the card and stored in the shared layout. Regenerating the model never loses those settings.

Success looks like:

- The design session follows one guide (`docs/model-builder-guide.md`) and its model plugs in
  without HA ids baked in.
- In the card you click a level, room or object and assign it; lamps then glow when on, the
  mower object drives with the live position, the gate opens, and a tap or popup controls them.
- Re-exporting the model with a moved lamp or a new object keeps all existing assignments; new
  objects show up as unassigned, removed ones as missing.
- A new object type is one module in the card plus a registry line.

## Non-goals (this spec)

- Editing geometry in the card (the model is read-only; only alignment, visibility, bindings).
- User-scripted behaviours (rules engine). Types are code modules.
- Animations beyond what a type defines (no keyframe playback from the glTF).
- Multiple models per layout.

## Sub-projects and order

Each gets its own implementation plan; they share the vocabulary in this spec.

1. **Manifest + levels/rooms/zones**: read `fp` tags, assign levels to HA floors, rooms/zones to
   areas, derive room outlines from the model, regeneration diff, validator script.
2. **Objects + type registry + actions/popup**: click objects, bind entities, types v1,
   tap/hold/double-tap actions, popup panel.
3. **Environment**: sun and weather, true-north offset.
4. **Built-in object library**: place default objects (lamps, charger, …) where the model has none.
5. **Guide**: `docs/model-builder-guide.md` (written with this spec, updated as types land).

## 1. The model contract

### Coordinates and units

Unchanged from today: metres, glTF Y up, plan x = east, plan y = north = -Z. "North" is the
model's north (usually along the house); the real compass offset is set in the card (section 6).

### `fp` tags

Any node may carry `extras.fp` (glTF node extras). GLTFLoader exposes them as `userData.fp`.
Fields common to all kinds:

| field   | required | meaning                                                                                                    |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `kind`  | yes      | `level` \| `room` \| `zone` \| `object`                                                                    |
| `id`    | yes      | stable id, `[a-z0-9_-]{1,64}`, unique per kind. Bindings hang on it. Never reuse an id for something else. |
| `label` | no       | human name shown in the card (falls back to `id`)                                                          |

Per kind:

**level**: a storey or a layer of the scene.

| field       | meaning                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------- |
| `role`      | `storey` (default) \| `basement` \| `exterior` \| `roof`                                  |
| `order`     | integer, bottom-up (basement -1, ground 0, first 1 …). Used for automatic floor matching. |
| `elevation` | finished floor height in metres (top of slab)                                             |
| `height`    | clear ceiling height in metres                                                            |

Everything belonging to a level is a descendant of the level node. Levels are top-level nodes
(or children of a single wrapper node). Exterior (garden, drive, fence, lawn) is a level with
`role: exterior`; the roof is a level with `role: roof`.

**room** (indoor) and **zone** (outdoor area: terrace, garden, driveway):

| field     | meaning                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `outline` | polygon `[[x, y], …]` in plan metres, inner floor outline, no closing point |
| `doors`   | optional `[[x, y], …]` points on the outline where openings are             |
| `suggest` | optional `{ "area": "<ha area id>" }`                                       |

A room/zone node must be inside a level node. Its descendants are the room's own geometry
(floor slab, optional furniture). Rooms derived from the model replace drawn rooms for the same
area (section 3).

**object**: a fixture or device.

| field     | meaning                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| `type`    | id from the type catalogue (section 5); unknown types fall back to `generic`                                    |
| `group`   | optional: objects with the same group can be bound in one go                                                    |
| `glow`    | optional: name of the child mesh (or material) that lights up / changes colour; default: the whole object       |
| `anchor`  | optional `[x, y, z]` local point for labels, light origin, popup anchor; default: bounding-box centre           |
| `hints`   | type-specific settings (section 5)                                                                              |
| `suggest` | optional `{ "entity": "light.x", "domain": "light", "area": "terrace" }`                                        |
| `ui`      | optional default controls: `{ "tap": <action>, "hold": <action>, "double_tap": <action>, "popup": [<row>, …] }` |

An object node belongs to the level (and room/zone) it sits under.

### Name fallback

Tools that cannot write extras may encode the tag in the node name:
`fp:<kind>:<id>` for level/room/zone and `fp:<type>:<id>` for objects (the token is an object
type when it is not one of the four kinds). The legacy `floor:<id>` name is read as
`kind: level, id: <id>`; `roof` and `site` top-level names as levels with roles `roof` and
`exterior`. Extras win over names.

### Untagged nodes

Allowed. They are scenery of the level they sit under. In the card any mesh can still be
clicked and turned into an object; that binding is stored by node path (section 2) and
survives a re-export only while the path is unchanged.

## 2. Bindings (stored in the layout)

`layout.model` keeps today's fields (`version`, `name`, `size`, `uploaded`, `position`,
`rotation`, `scale`, `opacity`) and gains:

```json
"levels":  { "ground": { "floor": "floor1" }, "exterior": { "show": "with", "floor": "floor1" },
             "roof": { "show": "all-only" }, "attic": { "show": "hidden" } },
"rooms":   { "kitchen": { "area": "kitchen" }, "terrace": { "area": "terrace" } },
"objects": {
  "terrace_ceiling_1": {
    "type": "light",
    "entity": "light.terrace_ceiling",
    "entities": ["sensor.terrace_temperature"],
    "hints": { "range": 5 },
    "tap": { "action": "toggle" },
    "hold": { "action": "popup" },
    "popup": ["toggle", "brightness", "color", "entity:sensor.terrace_temperature"]
  },
  "path:floor:ground/Kitchen/Hood": { "type": "fan", "entity": "fan.hood" }
},
"groups":  { "facade": { "entity": "switch.facade_main" }, "outdoor": { "entity": "switch.breaker_outside" },
             "terrace": { "entity": "light.terrace_main", "group": "outdoor" } },
"orphans": { "old_lamp_3": { "type": "light", "entity": "light.x" } }
```

- `levels[id]`: `{ floor }` puts the level on an HA floor (shown when that floor is
  selected). `show` refines it: `with` (default: shown when the selected floor is the level's
  floor or any floor above it, so floors stack) \| `only` (only on its own floor) \| `always` \|
  `hidden` \| `all-only` (only in "All"). In "All" every non-hidden level shows. Default when
  unbound: exact id match with an HA floor, else storeys by `order` onto HA floors by level;
  `exterior` is `always` (it keeps the lowest storey's floor for its zones); `roof` is
  `all-only`. Tagged models are never cut; legacy models keep the cut at wall height.
- `rooms[id].area`: HA area. Default when unbound: `suggest.area` if that area exists, else an
  area whose id equals the room id, else unassigned.
- `objects[id]`: any field present overrides the model's tag. Default `entity` when unbound:
  `suggest.entity` if it exists in HA; otherwise unassigned (the card offers candidates by
  `suggest.domain` / `suggest.area` / type domains).
- `groups[id]`: controller for every object tagged with that `group` (and for nested groups via
  `group`). **Chain rule:** an object is active only when every controller up its chain is on:
  its own `entity` (if any) AND its group's entity AND that group's parent group's entity … An
  object without its own entity follows its group. Brightness/colour come from the nearest
  `light.*` in the chain (own entity first); `switch.*`/`input_boolean.*` only gate on/off.
  Example: facade lamps 1–2 on `switch.facade_left`, 3 on `switch.facade_right`, 4 with no own
  controller, group `facade` on `switch.facade_main`: main off → all dark; main on, left off →
  1–2 dark, 3–4 lit. Cycles in group parents are ignored (chain stops at the repeat).
- `path:<node path>` keys bind untagged nodes (path = names from the level node down).
- `orphans`: bindings whose id is no longer in the uploaded model, kept so a later model that
  brings the id back restores them; listed in the card with "remove".

The legacy `model.floor_map` (v0.1.4) is migrated into `levels` on load.

## 3. Rooms from the model

On load the card builds rooms from the manifest: for each `room`/`zone` with an outline, a room
`{ id: 'm:<id>', area_id: <binding>, floor_id: <level's HA floor>, polygon: outline transformed
by the model alignment, doors, outdoor: kind === 'zone' }`. These are not stored; they are
recomputed from the manifest + bindings. Drawn rooms (`layout.rooms`) stay for areas the model
does not cover; if both exist for one area the model room is used. Auto-placement, walls,
labels and markers work on the combined list unchanged. A room without `outline` falls back to
its floor geometry's bounding rectangle and the validator warns.

Elevation and height of an HA floor that has a level bound to it come from the level's
`elevation`/`height` (unless the user set an override in the Rooms tab).

## 4. Selecting and assigning in the card

The Model tab gains three lists: **Levels**, **Rooms & zones**, **Objects**, each with status
(assigned / unassigned / missing in model) and filter. Clicking on the 3D view in edit mode with
the Model tab open picks the nearest tagged ancestor of the hit mesh (object > room/zone >
level); untagged meshes offer "Make this an object". The picked node is outlined and its panel
opens:

- level: HA floor select + show mode
- room/zone: HA area select (with "create area" link to HA)
- object: type select, entity picker (candidates first), extra entities, hints (generated from
  the type's hint schema), actions (tap/hold/double-tap), popup rows, "test" button

`group`: the object panel shows the group and its controller (set once for the whole group,
optionally a parent group). Each member keeps its own optional controller. Default tap toggles
the object's own controller if it has one, else the group controller; the popup lists the whole
chain (each controller with its state and a toggle) and says why the object is dark ("off
because Facade left is off").

Outside edit mode objects are live: their type behaviour runs, actions fire on tap/hold/double-tap
(pointer slop and long-press timing as for markers), and an object's marker is not drawn (the
object replaces it). Markers for devices not bound to any object still appear as today.

## 5. Types

### Module interface

```js
export default {
  id: 'light', label: 'Light',
  domains: ['light'],                          // entity candidates
  hints: { beam: { type: 'enum', values: ['point', 'spot', 'up', 'down'], default: 'point' },
           range: { type: 'number', min: 0.5, max: 30, default: 4, unit: 'm' } },
  defaults: { tap: { action: 'toggle' }, hold: { action: 'popup' },
              popup: ['toggle', 'brightness', 'color'] },
  create(ctx) { /* returns per-object state */ },
  update(state, ctx) { /* called on entity/theme/environment change */ },
  dispose(state) {},
};
```

`ctx` gives: the object node, its glow meshes, anchor (world), resolved hints, primary and extra
state objects, theme, environment (night factor, sun), and helpers `addLight`, `addSprite`,
`addParticles`, `addLabel`, `setEmissive`, `requestFrame` (for animating types). Types are
registered in `src/types/index.js`; adding a type is one file plus one import.

Budget: at most 8 real lights in the scene (closest/brightest win); other lit lamps use emissive
material + glow sprite. Particle systems capped (2 000 particles each). Animated types only
request frames while animating.

### Catalogue v1

| type                                 | domains                           | behaviour                                                                                    | hints                                                                       | default tap / hold / popup                   |
| ------------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| `light`                              | light                             | glow mesh emissive + light in HA colour (rgb/hs/colour temp) and brightness                  | `beam` point/spot/up/down, `range`, `angle`                                 | toggle / popup / toggle, brightness, color   |
| `light_strip`                        | light                             | whole glow mesh emissive along its length                                                    | —                                                                           | toggle / popup / toggle, brightness, color   |
| `mower`                              | lawn_mower                        | follows the live position (Mower tab calibration), turns to heading, status colour           | `front` +x/-x/+z/-z                                                         | popup / more-info / mower_controls, battery  |
| `vacuum`                             | vacuum                            | same as mower, indoors (position from the vacuum's attributes if present, else stays docked) | `front`                                                                     | popup / more-info / vacuum_controls, battery |
| `dock`                               | binary_sensor, sensor, lawn_mower | LED colour: charging / docked / error / idle                                                 | `led` mesh name                                                             | more-info / more-info / state                |
| `ev_charger`                         | sensor, switch, binary_sensor     | LED + charge level ring                                                                      | —                                                                           | popup / more-info / state, attributes        |
| `door` `window` `gate` `garage_door` | binary_sensor, cover, lock        | opens on hinge/track; partial with `current_position`; else colour when open                 | `opens` swing/slide/roll/tilt, `hinge` [x,y,z], `axis`, `travel` (deg or m) | more-info / more-info / state                |
| `cover`                              | cover                             | slides/rolls to `current_position`                                                           | `direction`, `travel`                                                       | popup / more-info / cover_controls           |
| `fan`                                | fan                               | spins around `axis`, speed from `percentage`                                                 | `axis`                                                                      | toggle / popup / toggle, speed               |
| `climate`                            | climate                           | warm/cool glow while heating/cooling                                                         | —                                                                           | more-info / more-info / —                    |
| `screen`                             | media_player                      | screen mesh lights while playing                                                             | —                                                                           | more-info / more-info / —                    |
| `sprinkler`                          | valve, switch                     | spray particles while on                                                                     | `direction`, `reach`                                                        | toggle / popup / toggle                      |
| `camera`                             | camera                            | view cone; tap opens the stream                                                              | `fov`, `range`                                                              | more-info / more-info / —                    |
| `display`                            | sensor, any                       | floating value label at the anchor                                                           | `format` (e.g. `{state} {unit}`)                                            | more-info / more-info / —                    |
| `generic`                            | any                               | highlight when the state is "on-like"                                                        | —                                                                           | more-info / more-info / state                |

Popup rows: `toggle`, `brightness`, `color`, `color_temp`, `speed`, `cover_controls`,
`mower_controls`, `vacuum_controls`, `battery`, `state`, `attributes`,
`attribute:<name>`, `entity:<entity_id>` (a full row for another entity).

Actions (same shape as HA dashboard actions):
`{ action: 'toggle' }`, `{ action: 'more-info', entity? }`, `{ action: 'popup' }`,
`{ action: 'perform-action', perform_action: 'light.turn_on', data: {…}, target: {…} }`,
`{ action: 'navigate', navigation_path }`, `{ action: 'url', url_path }`, `{ action: 'none' }`.

## 6. Environment

`layout.environment = { sun: 'sun.sun', weather: 'weather.home', north: 26, shadows: false }`.

- `north`: degrees clockwise from model north to true north (set in the card, with a compass
  preview). Also offered to the Mower tab as the default GPS rotation.
- sun: directional light from `azimuth`/`elevation` corrected by `north`; sky/background tint and
  a night factor (elevation < 0) that dims ambient light so lit lamps stand out. Optional shadows.
- weather: condition → rain / snow / hail / fog / cloud dimming; `wind_bearing` tilts particles.
  Only drawn over `exterior` and roof levels' bounds.

## 7. Built-in object library

"Add object" in the Model tab (or without a model): choose a built-in mesh (ceiling lamp, wall
lamp, bollard, spot, LED strip, mower, charging station, sensor puck, camera), click a spot
(height from the selected floor + default per mesh), then bind like a model object. Stored in
`layout.placed = [{ id, mesh, type, floor_id, x, y, z, rotation }]` and treated as tagged
objects with those ids.

## 8. Validator

`node tools/check-model.mjs house.glb [--json]` reads the GLB JSON chunk only (no dependencies):
lists levels (order, elevation), rooms/zones (outline area), objects by type; errors for
duplicate ids, invalid ids, rooms/objects outside a level, unknown `kind`; warnings for
unknown types, rooms without outline, meshes over 60 m inside storey levels, missing
`exterior`/`roof` roles, textures over 2048 px, file over 20 MB. Exit code 1 on errors. The Model
tab shows the same report after upload (shared code in `src/manifest.js`).

## 9. Error handling

- Unknown type → `generic`, warning in the Model tab.
- Bound entity missing in HA → object shown dimmed, listed as "entity missing".
- Model upload whose ids changed → regeneration summary: kept / new / missing counts.
- Type `update` throwing → logged once per object, object falls back to `generic` for the session.

## 10. Testing

- Unit (vitest): manifest reader from glTF JSON and from three.js nodes (extras, name fallback,
  legacy names); binding resolution (3 layers, defaults, migration of `floor_map`); regeneration
  diff (kept/new/missing/orphans); action resolution; each type's `update` with fake nodes;
  validator on fixture GLBs.
- Integration (pytest): none new (bindings travel in the existing layout).
- Headless (Chrome): demo model v2 with tags. Levels map to floors, exterior shows with
  ground, a `light` object glows and toggles on tap, popup opens on hold, mower object moves,
  re-upload with a moved lamp keeps the binding, new object shows unassigned.
