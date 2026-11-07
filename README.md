# Floorplan 3D for Home Assistant

A Lovelace card that shows your home as a 3D floorplan with every device on it. Each room of
the house model (or of the card's `layout:`) is linked to a Home Assistant area. After that,
every device assigned to the area appears in the room by itself, placed by type: lights on the
ceiling, door sensors by the door, other sensors on the walls. Pin any of them to its exact spot
in the card YAML. Also shows a robot mower's live position.

- Floors from Home Assistant, a chip per floor plus "All", 3D and north-up top view; with a
  3D model the chips are the model's views (Exterior, Ground floor, …), linked to HA floors
- Tap toggles lights, switches, fans and input booleans; other devices (and long-press) open
  the more-info dialog
- Markers show a value next to the icon (temperature, power, …); their shape tells what a tap does:
  circles act, rounded squares show readings, diamonds are alarms, pictures for people and players
- The layout (rooms, pins, hidden devices, mower, bindings, views) is written in the card YAML, so
  every user and device sees the same plan
- Robot mower: live position from GPS or map x / y with point calibration, driven track, dock,
  error / stuck warning
- 3D model of the house (.glb): views per storey (upper storeys and the roof hidden), cameras per
  view, rooms and zones from the model's tags, and a Day / Night button for lighting
- Day / Night button cycles Auto, Day, Night (remembered per device). Auto follows `sun.sun`: the
  sun's light and shadows point where the real sun is (using the model's `north`), and the house
  darkens smoothly through dusk; without `sun.sun` it stays Day
- Sun and moon in the sky (3D view with a model): the sun where `sun.sun` puts it, the moon from
  your Home Assistant location (`latitude` / `longitude`) with its current phase, and faint cool
  moonlight on moonlit nights; in Auto a clock button scrubs today's sun and moon from 00:00 to 24:00
- Model objects are the controls: lamps glow and really light rooms and the facade (night is dark,
  the lamps carry it), tap a lamp to toggle it, hold it for brightness and colour; the mower model
  drives on the plan, the dock, EV charger and climate units show their state. Objects bind to
  their entities from the model's suggestions without setup. Every lit lamp lights its wall (a real
  light, or a light decal once the real lights are used up), and tags (model groups, HA labels) give groups of lamps a shared controller
- Follows the HA theme, light and dark

## Install

The repository is a Home Assistant integration that also serves the card, so one install
covers both. The integration only serves the card and loads it on every dashboard; it stores
nothing (the layout is part of the card YAML, the model a file under `/config/www/`).

### HACS

1. HACS → ⋮ → Custom repositories → add `https://github.com/istals/floorplan3d-card`,
   type **Integration**.
2. Search for **Floorplan 3D** in HACS and download it.
3. Restart Home Assistant.
4. Settings → Devices & services → **Add integration** → **Floorplan 3D** → Submit.
5. Reload the browser.

### Manual

1. Download `floorplan3d.zip` from the [latest release](https://github.com/istals/floorplan3d-card/releases)
   and extract it to `/config/custom_components/floorplan3d/`
   (or build it yourself: `bun install && bun run build`, then copy `custom_components/floorplan3d/`).
2. Restart, then Settings → Devices & services → Add integration → **Floorplan 3D**.

`floorplan3d:` in `configuration.yaml` also works; it is imported as the integration entry.

The card is loaded on every dashboard automatically; you do not need to add a resource. Only a
small entry (a few kB) loads with every page: the card itself, with three.js, is fetched when a
dashboard shows it.

If you only want the card without the integration, extract `floorplan3d-card.tar.gz` from the
release (or copy the whole contents of `dist/` after `bun run build`) to `/config/www/floorplan3d/`,
so `floorplan3d-card.js` and its `chunks/` directory sit side by side, and add
`/local/floorplan3d/floorplan3d-card.js` as a dashboard resource (Settings → Dashboards → ⋮ →
Resources, type JavaScript module). The entry alone does not work without its chunks. The card
works the same without the integration.

## Add the card

Dashboard → Edit → Add card → search **Floorplan 3D** (or Manual: `type: custom:floorplan3d-card`).
The options below can be set in the visual editor or in YAML; `layout:` is YAML only (see
[The layout](#the-layout)).

| Option           | Default                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layout`         |                          | The plan: rooms, pins, hidden devices, mower, model bindings, views (see [The layout](#the-layout)). YAML only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `layout_key`     | –                        | Removed. The layout is the card's `layout:`; nothing is stored. A card that still sets it logs a warning once and is shown with its `layout:` (empty without one).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `height`         | `520px`                  | Card height in masonry and panel views. In a sections view the card fills its grid cell instead: it starts at the rows closest to `height` (56 px rows, at least 4) and is resized there like any card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `group_by`       | `device`                 | `device`: one marker per device. `entity`: one per entity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `wall_height`    | –                        | Removed with the drawn walls; a model is cut at its storey height. A card that still sets it logs a warning once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `occlusion`      | `true`                   | With a model: a marker whose spot is hidden behind a wall from the current camera angle is shown faint (25 %) and can't be tapped. Decided every frame on the GPU from the scene's depth at the marker's point (glass and see-through parts hide nothing; a marker is never hidden by the wall it hangs on); not in top view. `false` turns it off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `merge`          | `true`                   | With a model: static parts that share a room / zone / level / layer group and a material are merged into one mesh when the model loads (far fewer draw calls). Objects, glass and other transparent parts, `<room>_floor` pieces and parts named by a `node:` view rule stay separate. `false` keeps every part (reloads the model).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `sky_bodies`     | `true`                   | With a model: sun and moon discs on a dome around the house with a compass ring (moon position and phase from the HA location) and faint moonlight at night. `false` hides the discs and the ring. Turns the cloud shadows, rain and snow off too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `weather`        | first `weather.*` entity | Weather entity for the cloud shadows, rain / snow and light, or `none`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `clouds`         | `true`                   | With a model: cloud shadows drifting over the surroundings and rain / snow around the house, never over the rooms. `false` turns them off; the light still follows the weather.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `background`     | dark grey / near black   | With a model: the sky colour behind the house, `#rrggbb` for day and night, or `{ day: '#ebedf2', night: '#0e0f10' }`. Blends between the two with the day / night state. Defaults: `#2a2d30` by day, `#0e0f10` at night.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ao`             | –                        | Removed. The light probe grids and contact shadows shade corners, wall feet and the floor under furniture in every render quality; a card that still sets `ao` logs `floorplan3d: card YAML ao: no longer used; ignored` once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `bokeh`          | off                      | With a model: focus on the home. The rooms stay sharp from any camera; the surroundings (the facade below, the neighbours, the site, the sky) blur with their distance from the rooms. `true` for the defaults, or `{ strength: 10, start: 0.5, range: 10, tilt: 0 }`: the largest blur radius in px, the distance in metres from the rooms that stays sharp, the metres after that to the full blur, and `tilt` (0..1) for a tilt-shift look (three's tilt-shift shaders): the picture also blurs above and below a line through the rooms' middle on screen, growing with the distance from it (rooms included), like a photo of a miniature. Bright points weigh more (bokeh highlights at night). Labels stay sharp.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `grade`          | off                      | With a model: the colour finish of a photo of a model. `true` for the defaults, or `{ saturation: 1.15, contrast: 0.25, vignette: 0.25 }`: saturation (1 = as rendered), contrast (0..1: a straight line through mid grey, slope 1 to 2) and darker corners (0..1), with three's `HueSaturationShader`, `BrightnessContrastShader` and `VignetteShader`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `surround_light` | off                      | With a model: ambient light of the city around the house, outside the rooms only (the rooms keep their own light). `true` for the defaults, or `{ day: 0.25, night: 0.2 }` intensities: a bright sky by day; by night a dim sky above and the warm street lights below. Dimmed by clouds like the sky light.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `city_lights`    | off                      | With a model, at night (fading in after dusk): the city's lights. `true` for the defaults, or `{ windows: ['neighbors'], glow: [], share: 0.45, strength: 0.6, street: 1.2, glass: 0.35 }`. `windows`: mesh names, material names or layers whose walls get lit windows (about `share` of them, warm or white, storeys of 3 m); `glow`: the same for lit glass (a lobby or shop front, bays a little uneven); `street`: pools of warm street light on and near the ground. Never inside the rooms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `sway`           | off                      | With a model: the plants outside sway in the wind of the weather entity (`wind_speed`), more the higher they reach; never inside the rooms. `true` for the `decoration` layer, or `{ plants: ['decoration'], strength: 1 }` (mesh / material names or layers). Redrawn at about 15 frames a second while the card is on screen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `idle_reset`     | off                      | Seconds without a touch, wheel or key on the card before it returns to how it opened: start view and mode, the view's camera, live sun time; an open popup closes. For wall tablets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `idle_orbit`     | off                      | With `idle_reset`, in 3D: after returning, the camera turns around the view's rotation centre at this many degrees a second (negative: clockwise) until the next touch, wheel or key or a drag. At most 20 frames a second, only while the card is on screen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `max_fps`        | off                      | Frames a second of the animations: idle orbit, cloud shadow drift, rain / snow and sway (by default 20, 20, 30 and about 15). `60` for a smooth wall tablet; the GPU works that much more. Only caps them: a slower device draws what it can.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `furniture`      | `color`                  | `white`: every material whose glTF extras carry `fp_white: [r, g, b]` (linear, 0..1) is shown in that colour instead of its own, so a model with real furniture colours can switch to a white model look. Materials without `fp_white` (walls, plants, lights) stay as they are. Switches live.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `night_markers`  | `show`                   | `hide`: at night (sun down, or the night toggle) the device markers fade out so the lit rooms carry the plan; red / yellow alerts stay. A touch, wheel or key shows them for `idle_reset` seconds (30 without it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `view`           | `3d`                     | Start in `3d` or `top` view.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `floor`          | first floor with rooms   | Floor id (or view id) to show first, or `all`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `view_id`        |                          | View to show first (with a model: a view id such as `ground`). Wins over `floor`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `room_labels`    | `size`                   | Room labels: `size` (name and size, e.g. `Office · 4.5 × 5.0 m`, or `m²` for other shapes), `name`, or `none`. Also `layout.room_labels`; the option wins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `debug`          | `false`                  | Small performance overlay (bottom-left): FPS, frame ms, the longest main-thread task of the last minute, shadow-map updates and renders a minute, the render quality in use (`auto`: its level, the median frame it measured and the display's refresh).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `zoom_to`        | `center`                 | Zoom pivot: `center` zooms (and rotates) around the view's rotation centre, `cursor` zooms towards the mouse pointer. A view can override it (see Camera).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `views`          |                          | Per-view overrides by view id (see Views).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `model`          |                          | URL of a `.glb` model: `/api/floorplan3d/model/<key>` (login only) or `/local/house.glb` (see [3D model](#3d-model)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `model_position` | `[0, 0, 0]`              | Model offset in plan metres `[east, north, up]`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `model_rotation` | `0`                      | Model rotation in degrees, counter-clockwise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `model_scale`    | `1`                      | Model scale (e.g. `0.01` for a centimetre model).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `model_opacity`  | `1`                      | Model opacity, `0`–`1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `lights`         | `auto`                   | With a model: `auto` gives lit lamps real lights (4 with shadows, or up to 6 when the model's render recipe asks and the device allows (4 on touch / dense screens / 4 cores or fewer), plus 4 point lights and 4 spots); `off` keeps them glowing only (for weak tablets).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `render`         | `model`                  | With a model: `model` applies the model's render recipe (`fp.render`: exposure, camera, shadows, day / night light); `default` ignores it. Or an object: `{ recipe: model \| default, quality: auto (default) \| high \| standard \| still (experimental), tone_mapping: aces \| agx \| neutral \| reinhard \| cineon \| linear \| none, materials: { '<selector>': glass \| floor \| fabric \| none } }`. Every quality has the same light; the tiers differ only in what it costs (see [Render quality](#render-quality)). `quality: auto` (the default) renders `high` and steps down to `standard` when the device cannot keep up. `materials` opts materials in or out: `{ 'material:Glass_*': glass, 'layer:rugs': fabric, 'node:**/Worktop': none }` (a material name with `*`, or any view selector: `layer:`, `node:`, `room:`, `zone:`, `level:`, `role:`, `all`), later keys winning, after the model's own `fp.render.materials` and a material's glTF extras `fp_surface`, applied at the next model load (see [the model builder guide](docs/model-builder-guide.md#physical-materials)). `tone_mapping` replaces AgX; another tone mapping than the recipe's gets the exposure that keeps mid grey where the recipe had it. Invalid values are logged to the browser console and fall back to the defaults. The visual card editor sets the recipe, `quality` and `tone_mapping` and keeps `materials` from YAML. |
| `actions`        |                          | Tap / hold / double tap actions for objects and markers (see [Actions](#actions)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `badges`         | from the layout          | Device badges per card, overriding `layout.badges` per key: `{ integration: true, status: true, battery: true }` (each key optional).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `model_floors`   | auto                     | Which HA floor each model level belongs to, e.g. `{ground: floor1, attic: floor2}`. `layout.model.levels` wins over it per level.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## The layout

The plan is the card's `layout:`, written by hand in the card YAML (the visual editor keeps it
but does not edit it). It has the same shape as the layout older versions stored and exported
(schema: `src/schema/layout.ts`), so an exported layout JSON can be pasted under `layout:` as it is.
Values that do not fit are dropped with a warning in the browser console
(`floorplan3d: card YAML layout: <path>: ...`); keys the card does not know are kept. A changed
`layout:` replaces the running card's layout.

```yaml
type: custom:floorplan3d-card
model: /local/house.glb
layout:
  pins:
    # marker id: device:<device id> (or entity:<entity id> with group_by: entity)
    device:3f1c0d9e5b7a4c21a8e6f0b2d4c6e8a1: { x: 2.4, y: 1.1, z: 2.5, floor_id: ground }
    # attached to the model object lamp_hall: follows it, offset in metres from its anchor
    device:8a2e4f6b1c9d0e37b5a3c1e9f7d5b3a2:
      { x: 6.0, y: 3.2, floor_id: ground, attach: lamp_hall, offset: [0, 0.15, 0] }
  hidden:
    - device:5c7d9e1f3a2b4c6d8e0f1a3b5c7d9e2f
    - entity:sensor.hall_uptime
  mower:
    entity: vacuum.garden_robot
    source: xy
    x_attr: vacuum_x
    y_attr: vacuum_y
    floor_id: ground
    calibration:
      - { src: [25510, 25480], plan: [8.2, -3.0] }
      - { src: [31200, 27950], plan: [14.0, -5.5] }
      - { src: [27400, 33100], plan: [10.1, -10.8] }
  model:
    levels: { ground: { floor: ground_floor }, attic: { floor: null } }
    rooms: { living: { area: living_room } }
  objects:
    lamp_hall: { entity: light.hall, label: Hall lamp }
  tags:
    facade: { entity: switch.facade_relay, label: Facade switch }
  tap_hints: near
```

Coordinates are metres, x = east, y = north, z = height above the floor. The keys:

- `pins`: marker id → fixed position. The device id is the last part of the device page's URL
  (Settings → Devices & services → Devices → the device). `x`, `y` (plan metres) and `floor_id`
  place it (without `floor_id`: the first floor), `z` is its height above that floor (default
  1.2 m). With
  `attach: <object id>` the marker follows that model object's position (not its rotation, e.g.
  the mower's heading), `offset` from the object's anchor in metres; `x` / `y` are used while the
  object is not there.
- `hidden`: marker ids not shown.
- `mower`: see [Robot mower](#robot-mower).
- `rooms`: rooms that do not come from the model: `{ area_id, floor_id, polygon: [[x, y], ...],
doors: [[x, y]], outdoor }`. Normally rooms come from the model's tags (see
  [3D model](#3d-model)); a room here places the markers of its area and gets a room label, but is
  not drawn. `floor_id` defaults to the area's floor, `doors` are spots near an edge for door
  sensors, `outdoor: true` for a terrace or garden.
- `floors`: overrides of the HA floors (`id`, `name`, `elevation`, `height`) and floors HA does
  not have. HA floors are picked up by themselves (Settings → Areas → Floors) with elevation =
  level × 3 m; with a model the heights come from the model.
- `model`: the model's bindings. `levels.<level id>.floor`: the HA floor that shows a level
  (`null`: no floor; wins over the card option `model_floors`); `rooms.<room or zone id>.area`:
  its HA area (`null`: none). Unset ones follow level order and the tag's suggested area, so most
  of it is automatic. Level ids are listed by `bun run check-model house.glb`; room, zone and
  object ids are the model's `fp.id` tags (see
  [docs/model-builder-guide.md](docs/model-builder-guide.md)).
- `objects`: per model object, see [Lamps and objects](#lamps-and-objects).
- `tags`: per tag, a controller entity, a label and `wash` (see [Lamps and objects](#lamps-and-objects)).
- `views`, `view_order`: per view, see [Views](#views).
- `badges`, `room_labels`, `tap_hints`: below; the card options `badges` and `room_labels` win.

Every device with an area appears in that area's room, placed by type. With a model, auto-placed
(not pinned) devices sit on the model's real surfaces: wall, corner and door devices on the nearest
wall of their room (within 2.5 m), ceiling devices (lights, fans, smoke) 5 cm below the ceiling,
floor devices (vacuum, mower) on the floor. Where no surface is found the computed spot stays.
Without a model the card shows only the markers and the room labels.

**Marker shapes** follow what a tap does: controllable devices (lights, switches, fans, covers,
locks, climate, media players, …) are **circles**; a sensor with a value is a **rounded square**
showing the value; a binary sensor a rounded square with its state icon (door open / closed, …);
alarm classes (smoke, gas, safety, moisture, carbon monoxide: red; problem, tamper: yellow) are
**diamonds**, coloured while active; devices that only open more-info get a rounded square with a
small "i". People, media players, image entities and lawn mowers with an `entity_picture` show the
picture in a circle (the icon when it fails to load).

State text, icons and colours come from Home Assistant, as on its own cards: a marker's value is
HA's formatted state (`hass.formatEntityState`: display precision, unit, language; a climate's
current temperature through `formatEntityAttributeValue`), the icon is HA's `<ha-state-icon>` (the
entity's own icon, else HA's icon for the domain, device class and state; the mower marker keeps
`mdi:robot-mower`), and an active or alerting marker takes HA's state colour theme variables
(`--state-<domain>-<device_class>-<state>-color`, `--state-<domain>-<state>-color`,
`--state-<domain>-active-color`, `--state-active-color`), so a theme that recolours them recolours
the markers. A lit light keeps its own colour. Outside HA (the demo) the card falls back to its own
text, icon table and colours.

Markers, room labels, object labels and the mower chip are drawn by the GPU: one instanced draw of
billboards from an atlas texture the card paints with the theme's colours (painted again when the
theme changes). They keep their screen size and are drawn over the picture (no grading, blur or tone
mapping on them). The icon comes from HA's own `<ha-state-icon>` / `<ha-icon>` (kept hidden, its
resolved SVG path is read), so icon translations and custom icon sets work; a small ring shows until
it has loaded. Entity pictures and integration logos are loaded with CORS (HA's own URLs and
`brands.home-assistant.io` allow it); a picture from a server that does not allow it shows the icon instead.
Hovering a marker with the mouse enlarges it a little and shows its name as the tooltip.

Tap hints (`layout.tap_hints`): a small dot on every tappable model object, filled (in the lamp's
colour while lit) when a tap works, hollow grey when the object or its device is offline or a
controller in its chain is off. `always`, `near` (default: the dots fade in within about 120 px of
the mouse; on touch they show for 3 s after a touch) or `off`. On desktop the object under the
mouse gets an outline and a pointer cursor.

Badges (`layout.badges`, `{ integration, status, battery }`; the card option `badges:` overrides
per key):

- `integration` (off by default): the integration's logo from `brands.home-assistant.io` (the
  dark variant in dark themes, falling back to the normal one), 14 px at the marker's top right. A
  platform without a logo shows nothing (and is not asked again).
- `status` (on): a dot at the bottom right: green = on / active or a sensor with a value, grey =
  off / idle, red = unavailable or unknown, yellow = low battery or a `problem` binary sensor of
  the device that is on.
- `battery` (on): a "12 %" chip above the marker when a battery sensor of the device is under 20 %.

Model objects show the status dot and the logo in their popup header. Badges are only redrawn when
their inputs change.

### Objects and tags

With a model that has objects, `layout.objects.<object id>` overrides one object:

- `entity`: the bound entity. Unset: automatic, from the model's `suggest.entity` (mower and dock
  objects whose suggested entity is missing use `layout.mower.entity`); `null` or `''`: no entity.
  An entity that does not exist in HA leaves the object unbound.
- `hidden: true`: ignored as a control (dark, and its device gets its marker back).
- `label`: its name in the popup (empty: the model's label).
- `tags`: its tags, replacing the defaults (its model group `fp.group` and the
  [HA labels](https://www.home-assistant.io/docs/organizing/labels/) of its entity).
- `wash`: which way a lamp washes its wall: `down`, `up`, `both` or `none` (unset: the model's
  `hints.beam`).
- `ui`: `tap_action`, `hold_action`, `double_tap_action` and `popup`, as in [Actions](#actions).

`layout.tags.<name>` gives a tag a controller entity (e.g. the facade's `switch.*` relay), a
`label` and a `wash`: an object is lit only while its own entity and the controllers of all its
tags are on; an unknown entity is ignored. Objects sharing a controller tag share the real-light
budget like a model group, and views (`tag:<name>`) and `actions:` (`tag:<name>`) can select them.
An object's own `wash` wins over its tags', a tag's over the model's. Layouts from before 0.4.5
keep their group controllers (`groups:` loads as `tags:`). See [Lamps and objects](#lamps-and-objects).

## Robot mower

`layout.mower` follows any entity that reports a position:

- `source: gps`: `latitude` / `longitude` attributes (device trackers), or a `"lat,lon"` state
- `source: xy`: map coordinates in two attributes, `x_attr` / `y_attr` (default `x` and `y`),
  e.g. a Roborock's `vacuum_x` / `vacuum_y`

```yaml
layout:
  mower:
    entity: device_tracker.mower_position
    source: gps
    floor_id: ground                 # usually the ground floor
    calibration:
      - { src: [59.43712, 24.74531], plan: [3.0, -8.5] }   # [latitude, longitude] -> [x, y]
      - { src: [59.43698, 24.74580], plan: [30.5, -22.0] }
    track_attr: path                 # xy source: optional driven path
    error_entity: sensor.mower_error_code
    stuck_minutes: 5
```

Calibrate by hand: put the mower on a few spots you can find on the plan (a corner of the lawn,
the charging station), spread far apart. At each spot read the raw reading in Developer tools →
States → the mower entity (`latitude` / `longitude` for gps, the `x_attr` / `y_attr` attributes for
xy) and write a pair `{ src: [raw u, raw v], plan: [x, y] }` with the spot's plan metres (x east,
y north, as for pins). One point only shifts the reading (gps: north-up, in metres around the
point; xy: the reading must already be metres along the plan's axes), two points also fix
rotation and scale, three or more also correct skew (least squares). Without calibration points an
xy reading is taken as plan metres; gps needs at least one point.

The other keys:

- `ground: floor`: the mower drives on its floor's level instead of on the model's lawn.
- `track_attr` (xy source): an attribute with the path driven so far (`[[u, v], ...]`, or a list of
  such segments), drawn on the ground with `track_color`, `track_width` and `track_opacity`. Hidden
  while docked unless `track_show: always`.
- `error_entity`, `ok_values`, `stuck_minutes`: the warning, below.

While the mower is docked or charging (lawn_mower state, or a _Mower status_ sensor) it stands at
the model's dock object, turned as the dock (front = its +Z or `hints.front`); after undocking it is
tracked from there. While docked the mower and the dock act as one object: a tap on either opens
the mower popup (with a _Dock_ row: charging / docked and the battery) and the dock shows no tap dot
of its own; once it mows they are two again. Without a reading it stays at its last known position.

A pulsing warning appears over the mower (marker or model, also in top view): red when the mower
entity's state is `error` or `error_entity` reports a problem; yellow _Stuck?_ when the state is
`mowing` and the position moved less than 0.3 m for `stuck_minutes` minutes (default 5, 0 = off;
never while docked, paused or returning, offline, or waiting for the rain). Tap it for the mower
popup with the error text and Start / Dock.

Error codes. Without `error_entity`, a `sensor` of the mower's device whose id or name contains
_error code_ / _errorcode_ is used. The rules:

- a `binary_sensor`: on = problem;
- a number: `0` = OK, anything else is an error code (the popup shows _Error code 12_);
- empty, `unknown`, `unavailable`: no problem;
- text: `ok`, `none`, `no error`, `no_error`, `normal`, `working`, `mowing`, `charging`, `docked`,
  `idle`, `returning`, `paused`, `standby`, `sleeping`, `ready`, `home`, `off` are OK (any case);
  anything else is a problem. `ok_values` (`"a, b"` or a list) adds your own words.

Mower device rows. The mower popup lists the device's own entities when they exist (popup item
`device`, in the default list; leave it out of a custom popup list to hide them): mower status,
progress, battery, rain (_Wet_ / _Drying, 12 min left_), work region with that zone's area,
estimated time, _≈ N min left_ (estimated × (1 − progress)) and started / finished, wifi strength,
robot signal, cutter time left, total area, work records, error code, online. A progress sensor
(id / name with _progress_, unit %) is the _Mowed_ value. When the device's connectivity sensor is
off, the mower marker is dimmed and an _offline_ chip shows next to it (popup: _Offline since …_, no
warning); when its rain sensor is _Wet_, a rain chip (`mdi:weather-rainy`), while drying
`mdi:weather-partly-rainy` with the minutes left.

A mower object in the 3D model (type `mower`) replaces the mower device's marker: the model itself drives
around, turned to its direction of travel (`hints.front`: `+x` default, `-x`, `+z` or `-z` for the model's
front axis). Its popup shows its tile (state, start / pause, dock) and the battery.

## 3D model

Two places for the `.glb`:

- Logged-in users only (for a model of the inside of a home): copy it to
  `/config/floorplan3d/models/<key>.glb` (e.g. with `scp`) and set
  `model: /api/floorplan3d/model/<key>`. The integration serves it read only; the card fetches it
  with the user's token.
- Public: put it under `/config/www/` and set `model: /local/house.glb` (files in `www` are
  readable without login).

Line it up with `model_position`, `model_rotation` and `model_scale`.

Tag the model's parts (levels, rooms, zones, objects) so the card can use them: top-level
levels become floors, tagged rooms and zones become the card's rooms and their outlines place the
markers. Format and examples: [docs/model-builder-guide.md](docs/model-builder-guide.md).
Untagged models still load and show whole. Check a model before copying it with
`bun run check-model house.glb`.

Loading: the browser keeps the model file (Cache Storage, or IndexedDB when HA is served over plain http),
so the next load skips the download until the file's ETag / Last-Modified changes. While the model
loads, a line drawing of the floor plan replaces the stage (it blocks taps and camera input until
the model is ready): the room outlines of the last loaded model (or the layout's rooms, or a simple
house when nothing is known yet) are traced in step with the download, with the progress text under
it, and fade out when the model is ready. A download that takes over 60 s stops with an error; a
cached copy that fails to load is dropped and downloaded again once. Everything stays in this
browser; clearing site data removes it.

Each level belongs to an HA floor and each room or zone to an HA area. Defaults follow level order
and the tag's suggested area, so most of it is automatic; `layout.model.levels` / `.rooms` (or the
card option `model_floors`) set the rest by id, so they survive re-exports (see
[The layout](#the-layout)). A tagged model shows whole levels and is never clipped; only an
untagged model is cut, at the top of the view's highest storey (its elevation + storey height,
2.7 m when unknown; per view `cut: false` turns it off, see [Views](#views)).

Rendering notes for model authors:

- **Shadows:** every mesh receives shadows; glass does not cast them, so light reaches rooms
  behind windows. No shadow is cast by meshes that are transparent, have opacity < 1 or
  transmission, are named like _glass / window / pane / glazing_, sit on an `fp.layer` of
  `glass`, `terrain`, `floor`, `decal` or `label`, or are flat (< 2 cm thick) overlays.
- **Render recipe:** `fp.render` on the model root sets tone mapping, exposure, pixel ratio cap,
  texture filtering, camera fov, sun and lamp shadow quality, day / night light colours and the
  glow strength (format: [model-builder-guide](docs/model-builder-guide.md#render-recipe)).
- The sun's shadow box covers the storey / basement / roof levels + 4 m (an untagged model:
  meshes up to 30 m across), not the whole plot, so shadows stay sharp. If the model root (or a
  top node) has `fp.north` (degrees), the sun's azimuth follows it (north + 0.35 rad).
- Meshes on an `fp.layer` of `decal` / `edging`, or named like _decal / edging / overlay_, are
  drawn in front of the surface under them (polygon offset), so they don't flicker.
- With `model_opacity` below 1 the model is blended but keeps writing depth, so overlapping
  parts don't vanish; originally transparent materials (glass) keep their own opacity.

### Render quality

With a model every quality tier lights it the same way:

- Fill light: the sky. An environment map from a physical sky model (three's `Sky`, its own clouds from the weather, a
  ground below the horizon in the recipe's hemisphere ground colour) for the current sun (by night the moon, dimmer),
  rebuilt only when the sun / moon moved more than 2°, the clouds changed or day turned to night (at most every 2 s,
  never per frame). There is no hemisphere light with a model: on top of the sky it lit every surface a second time,
  closed rooms included.
- Indoors: three's light probe grid (`LightProbeGridWebGL`, an irradiance volume per storey over its rooms, each probe
  moved off the walls into its room) instead of the open sky: what the probes see (the sun through the windows, the
  lamps that are on, the sky through the openings), so a room is brighter by its window or lamp and darker in its
  corners. The grid blends between neighbouring probes, so within about one probe spacing of a wall a bright room's
  light shows a little on the dark side. The grids are rebaked in slices of a few milliseconds a frame when the rooms,
  the sky environment or the light levels change (every storey) or a lamp changes (its storey only), and swapped in
  when done, never while nothing changes. Lightmaps baked into the model (material extras `fp_lightmap`, on a second
  UV map) replace the grid where present (see [the model builder guide](docs/model-builder-guide.md#baked-lightmaps)).
- Contact shadows: things standing on a floor (walls, furniture, model objects that cast shadows) get a soft dark
  grounding where they meet it, baked per storey when the model, the shown storeys or the objects change, never per
  frame. (The screen-space `ao` pass is gone: it multiplied the finished frame, the lamps' and the sun's light
  included, and shaded the corners a second time.)
- Physical lamps: their colour is the one HA reports (`rgb_color`, which HA fills in colour temperature mode too), a
  lamp that reports no colour at all is a 2700 K blackbody bulb; the intensity is in candela, from the model's own lamp
  (a glTF `KHR_lights_punctual` light inside the light object, see
  [the model builder guide](docs/model-builder-guide.md#lamps-in-the-file-khr_lights_punctual)) or else from the lamp's
  flux (`hints.lumens`, default 800 lm, spots 300 lm), times its brightness, with inverse-square fall-off.
- Physical materials: glass, floors and fabric of the model are built as physical materials while the model loads,
  never swapped afterwards: glass is thin glass (smooth, reflecting the sky, more opaque at grazing angles; not three's
  transmission, which costs an extra render pass every frame), floors get a subtle clear coat, sofas, beds, curtains,
  rugs and other fabric a sheen. They are found by name (`glass`, `window`, `floor`, `parquet`, `tile`, `wood`,
  `sofa`, `bed`, `curtain`, `rug`, `carpet`…), the `glass` layer, the room floors the model tags, and see-through
  untextured materials; materials the file already makes physical (`KHR_materials_*`) or unlit and model objects are
  left alone.
- AgX tone mapping (unless `tone_mapping` sets another), with the exposure matched to the recipe's.
- The sun's shadow: three's PCF shadow map, softer under clouds; its type and size and when it is redrawn are the same
  in every tier, so a tier change recompiles no shader.

The tiers only set what that costs:

| Tier       | Bloom | Sun shadow edge     | Light probes                  | Path tracing |
| ---------- | ----- | ------------------- | ----------------------------- | ------------ |
| `standard` | off   | PCF taps 1.5 texels | every 1 m (a quarter to bake) | no           |
| `high`     | on    | PCF taps 3 texels   | every 0.5 m                   | no           |
| `still`    | on    | PCF taps 3 texels   | every 0.5 m                   | when idle    |

Bloom: emissive surfaces (lamp glows of lamps that are on, screens, LEDs) get a soft bloom (three's
`UnrealBloomPass` over the emissive surfaces alone, no threshold); lit walls do not, and nothing runs while none is in
view. `auto`'s lowest level is `standard` at pixel ratio 1 (on screens with a pixel ratio above 1).

`quality: still` (experimental; for desktop GPUs) is `high` while anything moves and, once the view has been still for
3 s, path traces it: real shadows, bounce light and reflections
([three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer), loaded only for this tier), at half
resolution, one tile a frame. Nothing of the trace shows until it has 128 samples per pixel; then the denoised trace
(an edge-aware blur that keeps edges) fades in over the `high` frame until 256 samples and keeps refining up to 512
samples or 60 s (the image then stays). A GPU too slow to reach 128 samples in 60 s keeps the `high` frame. The instant
the camera moves or anything changes (a state, a lamp, the sun's step, a resize) the `high` frame is back;
nothing is traced while the card is off screen, while a cut-away or section clips the model, or while
something animates (drifting clouds, rain / snow, sway, animated screens keep the view from being idle). The trace
takes the model, the sun, the moon, the lamps and the sky environment; clear coats (traced as plain glossy floors), the
card's `model_opacity`, the surround light, city windows and the post effects (bloom, `bokeh`, `grade`) are not
traced. `max_fps` limits its frames too. Tracing keeps the GPU fully busy for up to a minute after each change: use
`still` on a desktop with a discrete or recent integrated GPU, not on a wall tablet that runs all day or on battery.

`quality: auto` starts at `high` (or at the level this browser settled on last time, remembered in `localStorage`) and
measures the frames the card really draws: the time between two animation frames that both rendered (orbiting,
zooming, a camera glide), which includes the GPU's share, never the idle time between on-demand frames, a hidden tab,
or the first 3 s after a load or a switch (shader compiles). When the median of 60 such frames is over 40 ms (below
about 25 fps) it steps down: `high` to `standard`, then, on screens with a pixel ratio above 1, `standard` at pixel
ratio 1. It steps back up only after 60 s at the lower level with frames at the display's refresh rate (median within
1.25 refresh intervals); an up that has to come back down within 60 s doubles the wait for the next try, and after two
such tries it stays down for the session (remembered for a day). At most one switch per 20 s, applied only at a quiet
moment (no pointer on the plan, the camera still for 1 s), never mid-gesture; each switch is logged once to the
browser console (`floorplan3d: render quality auto: high -> standard (...)`), and `debug: true` shows the level, the
measured median and the refresh. `auto` never picks `still`. A switch regrids the light probes at the tier's spacing
(one bake pass) and recompiles nothing.

### Lamps and objects

Objects tagged in the model (see the [model builder guide](docs/model-builder-guide.md#objects))
bind to Home Assistant entities by themselves (`suggest.entity`), and a device bound to an object
has no marker: the object is the control.

- **Lamps** (`light`, `light_strip`): the bulb glows in the light's colour and brightness and a real
  light lights the rooms and facade around it. The card uses a fixed pool of 12 real lights
  (8 point, 4 spot) for the lit lamps in view, largest first, and at most 4 of them cast shadows;
  each fixture group competes with one light in its middle (never with shadows), and a group of up to
  6 lamps gets one light per lamp when the non-shadow slots left over have room for all of them. When
  the pool is full, a group may keep its glow only. Other lit lamps only glow. `lights: off` keeps glow only and
  takes the light pool out of the shaders (the switch recompiles them once). Shadow maps are
  redrawn only for lit lamps that changed and for the sun while it is up.
- **Wall washes:** since only a few real lights exist, every lit lamp left without a real light washes
  the surface next to it with a soft additive light decal in its colour and brightness instead: the nearest
  wall within 0.6 m (a cone below a down light, above an uplight, an oval around a `point` lamp), else a pool
  on the floor (or the ceiling for an uplight); spots light a pool where they aim. Size follows
  `hints.max` / `hints.distance`. Lamps that got a real light draw no wash: the real light lights that wall or
  floor itself, and the decal on top of it blew the surface out. A wash is
  placed the first time its lamp is lit (and again after the model is moved); turning lamps on and
  off only shows and hides them, no shader is rebuilt. `hints.beam: "updown"` (or `"both"`), or
  `wash: both` in `layout.objects` / `layout.tags`, draws two washes, a cone below and one above the
  lamp; `wash: none` (or `hints.beam: "none"`, for a broad fixture such as a ceiling panel) draws none. A real point light is kept at least 0.15 m off the wall it faces, so a
  lamp next to a door does not burn a hot spot into it.
- **Glow:** a lamp's glow mesh glows with its colour and brightness; large glow meshes (a big shade,
  a long strip) glow less per unit of brightness than small bulbs (by their size, down to a quarter),
  so they keep their colour instead of blowing out to white. The real light is unchanged.
- **Day / Night:** the toolbar button cycles Auto, Day, Night. Auto follows `sun.sun`: by night
  the house is nearly dark and the lamps carry the scene; the sun's direction and shadows follow
  the real sun.
- **Sun time:** in Auto (3D, with a model and an HA location) the clock button next to Day / Night
  opens a slider for today, 00:00 to 24:00 in 15 minute steps. The sun (computed in the browser from
  `hass.config.latitude` / `longitude`) and the moon move to that time: light, shadows, sky and clouds
  follow; the sun's shadow is redrawn once the slider rests (150 ms). Times are in HA's time zone.
  **Now**, closing the popover, 2 minutes without slider input or coming back to the tab return to
  `sun.sun`. The time is not stored.
- **Sun and moon:** with a model the sun (down to 2° below the horizon) and the moon (while above
  it) sit on a dome around the house: house centre + their direction × the dome radius (1.4 × the
  house's half width, at least 12 m), so a low sun is near the faint compass ring on the ground
  (with an "N" at true north) and a high sun stands above the house; the house hides a disc behind
  it. Top view shows their azimuth on the ring (the top view frames the ring). Auto: the sun from
  `sun.sun`, the moon computed in the browser from the HA location (`hass.config.latitude` /
  `longitude`, low-precision formulas, well under 1° off) every 60 s, with the lit part by its
  illumination, lit on the right while waxing. At night (night factor > 0.5) a moon above the
  horizon adds a faint shadowless light from its direction (0.05 + 0.15 × illumination). Manual
  Day shows the sun at azimuth 200°, 40° high; manual Night a moon at 160°, 35° high, 80 % lit.
  Both use the model's `north` and alignment rotation. `sky_bodies: false` hides both discs and the ring.
- **Clouds and weather:** the cloud coverage comes from the weather entity (option `weather`, default
  the first `weather.*` entity; `weather: none` ignores it): its `cloud_coverage` attribute, else the
  condition (sunny / clear-night 0 %, partlycloudy 40 %, cloudy 85 %, fog / rain / snow / lightning /
  hail 100 %, windy 30 %, exceptional 50 %). A 3D camera framing the rooms looks down past the
  horizon, so the weather is shown on the model rather than in the sky:
  - Cloud shadows: the lit model materials shade the sun and moon (not the lamps) with a soft pattern
    in world x / z that drifts with the wind (at most 20 frames a second, only while the card is on
    screen and the tab visible); about a share c of the ground is in shade at coverage c, a cloud
    leaving 10 % of the sun. Between the patches the sun keeps its clear-sky strength. The rooms
    (their polygons, from the floor up) get no patches but the average dimming: the sun there is
    × (1 − 0.75 c).
  - Rain (rainy, pouring, lightning-rainy, hail) and snow (snowy; snowy-rainy both) fall around the
    house from above the rooms to the bottom of the model, at up to 30 frames a second while they
    fall. No drop starts over a room, and nothing is drawn over the rooms on screen.
  - The sun's shadow gets fainter (intensity 1 → 0.35), the daytime sky fill × (1 + 0.35 c), the sun
    disc × (1 − 0.8 c) and the moon and moonlight × (1 − 0.7 c). The sun / moon discs never cover
    the rooms on screen and in 3D sit behind the surroundings. Changes under 5 points are ignored.
    `clouds: false` turns the shadows, rain and snow off; the light still follows the coverage.
- **Tap** a lamp to toggle it, **hold** (500 ms) for a small popup with Home Assistant's own tile
  cards: one for the object's entity and one per tag controller (named by the tag label), and why a
  lamp is dark ("Facade switch is off"). A tap on an object that can't act does nothing but say why:
  "Not reachable (offline)" or "Turn on first: <controller>" (hold still opens the popup).
  The tile carries HA's tile features for what the entity supports: brightness and colour
  temperature for lights, open / close and position for covers, speed for fans, HVAC modes and
  target temperature for climate, lock / unlock, media volume, start / pause and dock for mowers and
  vacuums. Colour, effects and everything else are in HA's more-info dialog: tap the tile (its icon
  toggles). Popup items: `toggle`, `state`, `brightness`, `color`, `color_temp`, `effect`, `start`,
  `dock` show the tile; `battery`, `power`, `energy`, `temperature`, `mode` add a value row below it;
  links come last. A list from the model or the type default is automatic (the tile with every
  feature the entity supports); a list from the layout or the YAML `popup:` is taken as written (features only
  for listed `brightness`, `color_temp`, `start` / `dock`; `popup: [toggle]` in `layout.objects.<id>.ui` is the tile
  without features).
  Esc or a tap outside closes it. Taps near an object (30 px, 52 px on touch) hit the object
  before markers. Other objects: mower popup (tile with start / pause and dock, battery), climate
  (temperature, mode), EV charger (state, power, energy); `fp.ui` in the model, `layout.objects.<id>.ui` or the card YAML
  can change tap / hold / double tap and the rows (see [Actions](#actions)).
- **Mower, dock, charger, climate:** the mower model drives where the mower is; the dock LED is
  lit while docked; the charger LED shows charging / ready / error with the power as a label; a
  climate unit shows its temperature and glows warm or cool while heating or cooling.
- **Covers:** a `cover` object follows `current_position`: a curtain gathers towards its origin as it
  opens (on a bent rail, `hints.path`, its pleats slide along the rail), a desk top
  (`hints.motion: "lift"`) moves up and down and carries what is mounted on it. Tap toggles, hold opens more-info.
- **Spots and uplights:** `hints.beam: "spot"` is a spot aimed at `hints.target`; `beam: "up"` is a
  spot (24°, penumbra 0.6) aimed straight up from the lamp; `beam: "down"` stays a point light. A
  target farther from the lamp than `hints.distance` (8 m without one) is ignored, and so is a target
  shared by two or more lamps of one group when it also looks wrong (the origin `[0, 0, 0]`, or more
  than 60° off vertical for an uplight); `hints.target_ok: true` keeps a target as it is. An ignored target: the spot then aims straight up (beam up, or an id / label with
  "uplight", "up_light", "uplighter") or straight down. `bun run check-model` warns
  "spot target looks wrong (shared / too far): <ids>".
- Labels: `layout.objects.<id>.label` (empty: the model's label) names the object in its popup. A tag can have a
  label too (`layout.tags.<name>.label`), shown in popups on its controller row.
- Bindings: `layout.objects.<id>.entity` binds an object to another entity (see
  [Objects and tags](#objects-and-tags)); a pin with `attach: <object id>` makes a device's marker follow an object.
- **Animated screens:** a material whose glTF extras carry `fp_anim: { frames, fps, entity, above }`
  plays a loop on its textures (`map` / `emissiveMap`): the frames are stacked top to bottom in one image
  and the UVs cover frame 0 (the top `1/frames`), so other viewers show frame 0 still. It plays at `fps`
  while `entity` is on (state `on`, or a number above `above` when given, e.g. a desk plug's power for
  monitors); off, its glow goes dark. No `entity`: always on. Only while the card is on screen.

### Actions

Objects and markers take Home Assistant's standard action config: `tap_action`, `hold_action`
(500 ms) and `double_tap_action`, each `{ action: ... }` with `toggle`, `more-info` (optional
`entity`), `navigate` (`navigation_path`, `navigation_replace`), `url` (`url_path`: `http(s)://…` or
a path starting with `/`; other schemes are refused), `perform-action` (`perform_action`, `data`,
`target`; the older `call-service` / `service` / `service_data` work too), `assist`, `none`, plus
the card's own `popup` (the object's popup). The card detects the gesture and hands the action to
Home Assistant's frontend (the `hass-action` event), so it runs exactly as on HA's own cards:
`confirmation: true` (or `{ text: ..., exemptions: [{ user: <user id> }] }`) shows HA's confirmation
dialog, URLs open the way HA opens them, toggles use HA's toggle and haptics follow HA's settings.
An action's own `entity` is the one `toggle` and `more-info` act on; without one they act on the
object's entity (or its group controller, see the popup chain).
Later wins: the model's `fp.ui` (old `tap` / `hold` keys still work) → `layout.objects.<id>.ui` → the card
YAML `actions:`, keyed `object:<id>` (model objects), `<entity_id>`, `tag:<name>` (objects with that
tag) or `device:<device_id>` (objects and markers); `object:` wins over the entity, the entity over
`tag:`, `tag:` over `device:`:

```yaml
actions:
  object:lamp_hall:
    hold_action: { action: navigate, navigation_path: /lovelace/lights }
    double_tap_action:
      action: perform-action
      perform_action: light.turn_on
      target: { entity_id: light.hall }
      data: { brightness_pct: 100 }
  binary_sensor.front_door:
    tap_action: { action: more-info }
  tag:facade:
    hold_action: { action: more-info, entity: switch.facade }
  object:mower:
    popup: [state, battery, start, dock, history, { label: Mower map, navigate: /lovelace/garden }]
```

Defaults: lamps toggle on tap and open the popup on hold; markers toggle lights / switches / fans /
input booleans and open more-info otherwise, hold opens more-info. A single tap waits 250 ms for a
second tap only on objects or markers that have a `double_tap_action`; everything else reacts at
once. An action missing a field (e.g. `navigate` without `navigation_path`) does nothing and shows
an HA toast; a failed service call shows HA's own error toast. Popup rows can end with links: `history`, `logbook` (open HA's history / logbook for
the entity), `statistics` (the entity's more-info) and custom `{ label, navigate }` or `{ label, url }`.

### Views

With a model, the chips on the card are **views**. They come from the model (`fp.views`, see the
[model builder guide](docs/model-builder-guide.md#views)); a model without views gets one view per
storey (lower storeys stacked under it) plus _All_. Each view is linked to HA floors (by default
the floor of its top storey):

- In a storey view, devices in the visible rooms of that storey and outdoor devices are shown;
  devices of lower storeys are hidden. An overview (every storey and the roof visible, e.g.
  Exterior) shows every device.
- A pin belongs to the model room or zone under it (on its floor), so a pin dropped in the garden
  shows wherever the garden zone shows. The live mower is outdoors: it shows in every view where
  part of an exterior level is visible.
- Devices outside every model room and zone (pins off the plan, areas without a room) follow
  their HA floor: they show in views linked to that floor, and are hidden in views above it.
- Room labels (name and size) appear in storey views for the rooms of that storey.
- Switching views keeps the camera, unless the view has a camera. **Reset view** (the
  crosshair button) returns to the view's camera or frames the house.

A view is changed by id in the card YAML `views:` or in `layout.views` (same keys; the card YAML
wins per key, rules of both are added after the model's). `label`, `hidden: true`, `floors` (the
linked HA floors), `rules` (show / hide selectors, later wins), `camera`, `camera_top`, `zoom_to`,
`section` and `cut` (untagged models: cut at the storey height, default on except in _All_). Only
`layout.views` can add a view (`added: true`, starting empty) and `layout.view_order` lists the
view ids in chip order. `{ hide: <selector>, keep_objects: true }` hides a level, room, zone or group
but keeps the model objects inside it (e.g. wall lamps exported inside a paved zone) visible, lit
and tappable; an object-level hide (`object:`, `type:`, `group:`, `tag:`) still hides those objects.
Selectors: see [the model builder guide](docs/model-builder-guide.md#views). A YAML view id that
matches no view is reported in the console and ignored.

```yaml
views:
  ground:
    label: Downstairs
    floors: [ground_floor]
    rules:
      - hide: layer:furniture
      - hide: node:house/level0/sofa
      - hide: tag:garden_lights      # objects carrying a tag (layout.tags, model groups, HA labels)
      - hide: zone:driveway          # the paving goes, the lamps nested in it stay
        keep_objects: true
    camera: { position: [18, 22, 16], target: [6, 0, -4] }
    camera_top: { center: [6, 4], zoom: 1.5 }   # plan metres
    zoom_to: cursor
    section: { normal: [-1, 0, 0], constant: 7 }   # card world: keeps x <= 7 m
  exterior:
    hidden: true
```

#### Camera

- `camera: { position, target }`: the view's 3D camera in card world metres (`[x, height, -y]` of
  the plan, Y up). The card tweens to it when the view is opened and on Reset view; `target` is the
  rotation centre the camera orbits and zooms around. Without one the camera stays where it is.
- Zoom towards: card option `zoom_to` (`center` by default, or `cursor`), per view `zoom_to`.
- Top view camera: `camera_top: { center: [x, y], zoom }` (plan metres; zoom 1 shows 20 m
  vertically, the horizontal extent follows the card width). Switching views in Top uses it, else
  keeps the current top camera. Models may give `fp.views[*].camera_top`.
- Reset view (the crosshair button) returns to the view's camera (Top: `camera_top`), else frames
  the view.
- Cameras from the model (`fp.views[*].camera` / `camera_top`) are in model coordinates and follow
  the model when `model_position` / `model_rotation` / `model_scale` change. Cameras and section
  planes in the card YAML or `layout.views` are in card coordinates and stay put when the model is
  realigned later: adjust them afterwards.

#### Side section

The Section button (box cutter, 3D view with a model) cuts the house with one vertical plane
and turns the camera to look at the cut face: every storey and the roof are shown while it is on,
devices beyond the cut are hidden, and cut walls read solid. Turning it off, switching views,
Reset view or Top clears the cut and returns to the view. Where the cut runs is the view's
`section` (`{ normal: [-1, 0, 0], constant: 7 }`, a three.js plane in card world: the side where
`normal · p + constant ≥ 0` stays, here x ≤ 7 m), else the model's `fp.views[*].section` (in model
coordinates), else the west half is kept, cut through the middle of the house. The camera looks at
the cut face from the removed half.

Model builders: [docs/model-builder-guide.md](docs/model-builder-guide.md) (format, selectors,
layers) and [docs/prototype-view-rules.md](docs/prototype-view-rules.md) (reference view set,
camera presets for `fp.views[*].camera`, controls).

To export an existing Three.js design: add `window.scene = scene;` to its code, open it in the
browser, paste [tools/export-glb.js](tools/export-glb.js) into the developer console. It drops
lights and helpers, prints size and origin, and downloads `house.glb`.

## Development

```sh
bun install           # bun is pinned in mise.toml (mise install)
bun run demo          # http://localhost:8765/demo/  (mock HA, add ?model=1 for the 3D model with views)
bun run make-demo-model  # regenerate demo/house.glb (views, layers, tagged rooms)
bun run test          # unit tests (bun test --parallel; plain bun test works too)
bun lint
bun check             # type check
bun fmt               # format (bun fmt --check in CI)
bun run check:all     # build + headless Chrome checks of the view and the model
bun run check:model --only views,mower   # some model check groups (--list, --shard 1/3, --jobs N)
python -m pytest      # integration tests (pip install -r requirements-test.txt first)
bun run deploy        # build and scp the integration to HA (settings in .env, see .env.example)
```

The demo page has no Home Assistant frontend: `demo/demo-tile.js` stands in for HA's card helpers
with a minimal tile card (name, state, the brightness / colour temperature / cover / mower / vacuum
features), so the object popup works there too.

Releases are automatic: every green CI run on `main` picks the next version from the
conventional commits since the last tag, stamps it into `package.json`, the manifest and
`src/floorplan3d-card.ts`, and publishes `floorplan3d.zip` (the integration with the card inside,
for HACS) and `floorplan3d-card.tar.gz` (the card entry and its chunks). The repository keeps
`0.0.0-dev`.

The build (`scripts/build.mjs`) splits the card: `src/floorplan3d-card.ts` is a small shell entry
(`dist/floorplan3d-card.js`) that imports `src/card-impl.ts` (the card, element
`floorplan3d-card-impl`) on first show and hosts it; the visual editor and the path tracer are chunks
of their own in `dist/chunks/`. `test/entry-size.test.js` keeps the entry under 15 kB and free of three.js.

Layout: `src/placement.ts` (auto placement), `src/registry.ts` (HA registries to markers),
`src/layout.ts` (floors, positions), `src/view.ts` (Three.js; markers and labels:
`src/view/billboards.ts`, `src/marker-sprite.ts`, `src/sprite-atlas.ts`), `src/mower.ts` (mower
math), `custom_components/floorplan3d/` (integration, serves the card).
`src/schema/` is the contract for the card YAML: the layout schema with its versioned migrations
(`layout.ts`, for `layout:`) and the card options (`config.ts`), built from small combinators
(`core.ts`). The types in `src/types/layout.ts` and `config.ts` are derived from it. Changing the layout shape
means bumping `LAYOUT_VERSION`, adding a migration and a fixture under `test/fixtures/layouts`
(`UPDATE_GOLDEN=1 bun run test` rewrites the expected results in `golden/`).

## Troubleshooting

- **Card not found** after install: restart HA, then reload the browser (clear cache on mobile app).
- The plan is empty after updating: the layout is no longer stored; copy it into the card's
  `layout:` (an older version's Data → Export JSON pastes as it is). `layout_key` and `wall_height`
  are ignored with a console warning.
- A device is missing: give it an area whose room is in the model (or in `layout.rooms`), or pin
  it; check `layout.hidden`. Diagnostic and configuration entities are never shown.
- Mower not on the plan: GPS sources need at least one calibration point; compare the entity's
  reading in Developer tools → States with the `src` values. Layout warnings are in the browser
  console.
