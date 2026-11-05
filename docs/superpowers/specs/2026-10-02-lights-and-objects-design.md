# Lights and objects (v0.4.0)

Status: approach approved in chat (objects layer with a type registry), spec awaiting review
Date: 2026-10-02
Builds on: `2026-10-01-model-contract-design.md` (part 2: objects, types, actions, popup, chain rule),
`2026-10-02-views-and-rooms-design.md`, `docs/prototype-view-rules.md`.

## Goal

The card looks and behaves like the model author's prototype: lamps are real lights that light walls
and the facade, with a glowing bulb; night is nearly dark and the lamps carry the scene; the sun
follows Home Assistant. Model objects (lamps, mower, dock, charger, climate) are the controls: tap a
lamp to toggle it, hold it for a small popup. Devices dragged in edit mode stick to the surface under
the cursor or attach to a model object. One release (v0.4.0), many commits.

Guiding rule from the user: **the tool must stay light and easy to understand.** Few options, good
defaults, everything works from the model's `fp` data without setup.

Success: with the user's house.glb uploaded, all 67 lamp fixtures bind to their HA lights from
`suggest.entity` without setup; at night with lamps on, rooms and facade are lit by real lights with
at most 4 shadows; a tap on a lamp toggles it; hold opens brightness/colour; the mower model drives
on the plan; the card stays smooth on a wall tablet.

## Non-goals

- Bloom / post-processing (optional later, desktop only).
- Other object types (cover, gate animation, fan, sprinkler, vacuum): they use the generic type now.
- Editing model geometry.

## 1. Objects and binding

- Objects come from the manifest (`kind: object`): `id`, `type`, `label`, `group`, `glow` (name of the
  glow mesh inside the object), `hints`, `suggest`, `ui`, `anchor`.
- **Binding:** `layout.objects[id] = { entity?, hidden? }`. Without an entry, the object binds
  automatically: `suggest.entity` if that entity exists in HA, else nothing (no guessing by area).
  Auto bindings are shown as "auto" in edit mode and can be changed.
- **Groups (multi-fixture circuits):** objects with the same `group` usually share one entity. A group
  can also have its own controller: `layout.groups[name] = { entity }`. **Chain rule:** a fixture is
  lit only if its own entity (if any) and its group controller (if any) are both on. Brightness and
  colour come from the first `light.*` in the chain (own entity first).
- **Markers:** a device whose primary entity is bound to an object gets no marker; the object is the
  control. Devices without an object keep their markers as today.

## 2. Types (`src/objects/`)

One small module per type with two functions: `prepare(node, fp, ctx)` (find the glow mesh, add
parts) and `update(state, ctx)` (apply the HA state). `objects/index.js` binds, evaluates chains,
assigns the light budget and routes taps. Pure logic (chain, colour, intensity, budget, sun) lives in
plain functions with unit tests.

| type          | look                                                                                                                                                                                                                              | tap / hold (defaults, `fp.ui` overrides)       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `light`       | glow mesh emissive in the light colour, `emissiveIntensity = bri/255 × 3`; real light per `hints` (budget §3)                                                                                                                     | toggle / popup (toggle, brightness, color)     |
| `light_strip` | whole glow mesh emissive along its length; no real light unless `hints.max` is set                                                                                                                                                | toggle / popup                                 |
| `mower`       | the model node follows the live position (existing Mower tab calibration), turns to its heading (from movement), status colour on the glow mesh (mowing green, returning amber, error red, docked dim); replaces the mower marker | popup (state, battery, start/dock) / more-info |
| `dock`        | `hints.led` mesh lit when the mower is docked                                                                                                                                                                                     | more-info / more-info                          |
| `ev_charger`  | LED mesh colour by state (charging green, ready blue, error red, idle dim) + a small label with power when charging                                                                                                               | more-info / popup (state, power, energy)       |
| `climate`     | a small label with current temperature; glow (if any) warm when heating, cool when cooling                                                                                                                                        | more-info / popup (temperature, mode)          |
| any other     | no change in look                                                                                                                                                                                                                 | more-info / popup (state)                      |

Colour: `rgb_color` → `hs_color` → `color_temp_kelvin` → warm white (h 30, s 50), converted with
`setRGB(…, SRGBColorSpace)`. Relay lamps (switch.*): fixed warm white, full brightness.

## 3. Lights and shadows

- **Light parts from `hints`:** `beam: point` (or `down`/`up`) → `PointLight(color, 0, distance, decay)`;
  `beam: spot` → `SpotLight(color, 0, distance, angle, penumbra, decay)` aimed at `hints.target`.
  Position: the glow mesh centre; wall lamps (glow within 0.1 m of a wall) offset 12 cm outward.
  Intensity `bri/255 × hints.max`.
- **Fixed pools so shaders never recompile:** 12 real lights (8 point, 4 spot) are created once and
  reused; unused pool lights have intensity 0. Every frame nothing changes unless state changes.
- **Which fixtures get a real light** (re-evaluated on state, view or section change): lit fixtures
  whose level is visible in the current view, sorted by `hints.max` (largest first); one light per
  group (the group's middle fixture, intensity × 1.5); the rest are emissive only.
- **Shadows:** at most 4 of the pool lights cast shadows (`mapSize 512`, `bias −0.004`,
  `camera.near 0.15`), chosen from single fixtures (no group) with `hints.castShadow !== false`,
  largest `max` first. `shadowMap.needsUpdate = true` on every budget or light change.
- Card option `lights: auto | off` (default auto). `off` = emissive only (weak devices).

## 4. Day, night and the sun

- Toolbar button cycles **Auto → Day → Night → Auto**; the choice is remembered per device
  (localStorage, wrapped in try/catch). Default Auto.
- **Auto:** from `sun.sun` (`elevation`, `azimuth`). Night factor `t = smoothstep(+6°, −6°, elevation)`.
  Hemisphere `lerp(0.9, 0.14, t)` (sky `#c4d6ff`, ground `#2a2520`), sun `lerp(2.6, 0, t)` (warm
  `#fff0dc`), background `lerp(#2a2d30, #0e0f10, t)`. Without `sun.sun`: Day.
- **Sun direction:** HA azimuth (degrees clockwise from true north) and elevation → world vector,
  rotated by the model's `fp.north` and the model alignment rotation. Shadows refresh when the sun
  moves more than 1° (not on every update).
- The current moonlight is removed; night relies on lamps (as the user asked: switch together).
- Without a model: today's behaviour (glow sprites, simple day/night).

## 5. Tap, hold and popup

- **Hit test:** screen-space nearest visible bound object anchor within **52 px (touch) / 30 px
  (mouse)**; objects win over markers within that radius; otherwise markers and the model as today.
- Tap = the type's tap action (`fp.ui.tap` overrides); hold 500 ms = hold action. Actions:
  `toggle`, `more-info`, `popup`, `none`.
- **Popup:** a small panel next to the object (repositioned when the camera moves), closes on outside
  tap or Esc. Rows from `fp.ui.popup` or the type default: `toggle`, `brightness` (slider),
  `color` (8 swatches + white), `state`, `battery`, `power`, `energy`, `temperature`, `mode`,
  `start_dock` (mower). Grouped fixtures show the chain (each controller with a toggle) and why a
  fixture is dark ("group switch is off").
- HA theme colours; works in light and dark theme.

## 6. Edit mode

- **Objects tab** (new): objects grouped by level → room; each row: label, type, entity (picker with
  "auto" shown), group, **Test** (toggle), hide. Clicking an object in 3D selects its row. Groups
  section: optional group controller entity.
- **Magnetic drag** (markers in the Devices tab): while dragging, the marker sticks to the model
  surface under the cursor: position = hit point + 5 cm along the surface normal; height and floor
  from the hit (floor = HA floor of the hit's level). Over a model object the object highlights; drop
  attaches: `pins[id] = { attach: objectId, offset: [dx, dy, dz] }` and the marker follows that
  object's anchor (incl. the mower). Hold **Alt** for today's free drag at the current height.
  "Detach" button on a selected attached marker.
- Floor stems keep showing where markers stand.

## 7. Model builder guide

Document what the card reads: `hints` keys (`beam`, `max`, `distance`, `decay`, `angle`, `penumbra`,
`target`, `castShadow`, `led`), `glow`, `group`, `suggest.entity`, `ui`; one glow mesh per fixture;
wall-lamp light point; decal offset 2–5 mm.

## 8. Error handling

- `suggest.entity` missing in HA → unbound, listed in the Objects tab as "entity not found".
- Object without a glow mesh → no emissive; light still placed at the object anchor.
- Unknown type → generic type. Invalid hints → defaults (point, max 5, distance 0, decay 2).
- More lit fixtures than the pool → emissive only for the rest (no error).

## 9. Testing

- Unit: binding (auto/explicit/missing), chain rule, colour conversion, intensity, light budget
  (visibility, groups, shadow picks), night factor and sun vector (north and alignment), screen-space
  hit test, magnetic drop → pin/attach.
- Headless (demo model gains a few lamps incl. a group and a spot, a mower, dock, charger, climate):
  lamps light up and toggle by tap; hold opens the popup and brightness changes the light; at most
  4 shadow casters and ≤ 12 real lights; night factor follows a mocked `sun.sun`; mower node moves;
  drag sticks a marker to a wall and attaches one to a lamp; device markers for bound lamps hidden.
