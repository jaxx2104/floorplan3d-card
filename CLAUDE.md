# floorplan3d-card — Home Assistant 3D floorplan

Custom Lovelace card (Three.js) that shows a house model (.glb) with every HA device on it: rooms come
from the model's fp tags and map to HA areas, devices of an area are placed by device type, and a robot
mower's live position (gps / xy through a calibration) is drawn on the lawn. The card is display only:
everything is configured by hand (through Claude Code) in the card YAML, nothing is edited or stored by
the card.

## Stack

- Vanilla custom element, Three.js 0.187 (WebGLRenderer), Bun.build bundle -> `dist/floorplan3d-card.js`
- Toolchain: bun (a dated canary pinned in mise.toml) for install, lint (`bun lint`, .oxlintrc.json),
  format (`bun fmt`), type check (`bun check`), tests (`bun test`, happy-dom) and build
- TypeScript (`bun check`, strict; shared contracts in `src/types/`).
  Relative imports use `.ts` specifiers (allowImportingTsExtensions); only erasable TS syntax
  (erasableSyntaxOnly), so bun (or node) runs src/ directly for scripts/ and tools/.
- Structure: `src/floorplan3d-card.*` is the element shell over `src/card-impl.ts` (lifecycle, hass
  update diff) and its parts in `src/card/`; when a part rebuilds or refreshes is the signal graph in
  `src/card/state.ts` (in-house core `src/signals.ts`: hass / config / layout / model in, one effect per
  step); `src/view.*` is the Three.js scene facade over `src/view/`.
- OrbitControls, GLTFLoader. Markers, room / object labels and the mower chip are GPU sprites (instanced
  billboards from a Canvas 2D atlas: `src/view/billboards.ts`, `src/marker-sprite.ts`); icons are read from a
  hidden `<ha-state-icon>` / `<ha-icon>` (`src/view/icons.ts`). No DOM overlays in the scene.
- Companion integration `custom_components/floorplan3d/`: serves the bundled card and registers it
  (add_extra_js_url), and serves `<config>/floorplan3d/models/<key>.glb` read only to logged-in users
  (`/api/floorplan3d/model/<key>`, fetched by the card with `hass.fetchWithAuth`). No storage, no
  websocket commands, no upload.
- Respect HA theme CSS vars (--card-background-color, --primary-color, --primary-text-color,
  --divider-color, --state-light-active-color). Light and dark themes must both look right.

## Modules worth knowing

- `placement.ts` — polygon geometry, type rules (domain/device_class -> anchor + height),
  `autoPlace(room, markers, roomHeight)`. Anchors: center (ceiling grid), wall, corner, door.
- `registry.ts` — builds markers from `hass.entities` / `hass.devices` / `hass.areas` /
  `hass.floors` (live, available to non-admin users, no websocket calls needed). Groups
  entities per device, picks primary entity by domain priority, skips config/diagnostic and
  hidden entities. Icons, active state, value display.
- `mower.ts` — read position from entity (gps: latitude/longitude attrs or "lat,lon" state;
  xy: configurable attributes, optional track attribute), calibration: 1 pt translate, 2 pts
  similarity, 3+ pts least-squares affine.
- `schema/layout.ts` / `schema/config.ts` — the contracts: parse, defaults, migrations, warnings for
  removed options. Unknown layout fields are kept as they are.

## Coordinates

Plan metres: x = east, y = north, z = height above floor. Three.js world:
`(x, floorElevation + z, -y)` so north is up in top view.

## Card YAML

The layout is part of the card config (`layout:`, parsed by `parseLayout`); a new config replaces it.

```yaml
type: custom:floorplan3d-card
height: 520px
group_by: device          # device | entity
model: /api/floorplan3d/model/default   # or /local/house.glb (public); cached by ETag / Last-Modified
model_position: [0, 0, 0]
model_rotation: 0
model_scale: 1
layout:
  pins:
    "device:abc123": { x: 1.2, y: 0.4, z: 2.6, floor_id: ground }
    "entity:sensor.living_climate": { attach: living_thermometer, offset: [0, 0, 0], floor_id: ground }
  hidden: ["device:xyz"]
  mower:
    entity: image.roborock_map
    source: xy              # gps | xy
    x_attr: vacuum_x
    y_attr: vacuum_y
    track_attr: path
    calibration:
      - { src: [26000, 25000], plan: [12.12, 7.32] }
```

Removed options (`layout_key`, `wall_height`, `ao`) are reported in the console and ignored. Floors
auto-sync from HA floors (`hass.floors`, elevation = level * 3); a room's floor defaults to the area's.

## Behaviour

- View chips (the model's views, linked to HA floors), 3D / Top view toggle, day / night, sun time.
- Marker tap: toggle for light/switch/fan/input_boolean, otherwise more-info.
  Long-press (500 ms): more-info (`hass-more-info` event, bubbles + composed).
- Model objects (lamps, mower, dock) bound to entities: real lights, tap actions, popup.
- Marker shows secondary sensor value (e.g. temperature) when the device has one.
- Mower: live position, heading from movement, driven track, dock, error / stuck warning, offline /
  rain chip, progress sensor in the popup.
- Click vs orbit: pointer move < 5 px counts as a click.
- Render loop only while connected; render when controls change or state dirty.
- Rebuild markers only when registry objects change identity; per-hass-update just refresh states.
- Billboards leave the sprite layer with their objects (`view._removeCss` / `_clearGroup`).

## Repo / delivery

- GitHub (`origin`) is the main remote; HACS installs it as an Integration from release
  `floorplan3d.zip` (integration with the card bundled; it registers the card via
  add_extra_js_url). Manual: copy `custom_components/floorplan3d/` after `bun run build`.
- CI: `.github/workflows/ci.yml` (lint, format, type check, bun test, build, headless checks, pytest);
  `release.yml` runs after every green CI on main: `scripts/next-version.mjs` picks the next
  version from the conventional commits since the last tag (feat -> minor, fix/perf/refactor ->
  patch, docs/chore/ci/test/style/build -> no release), stamps it into package.json, the manifest
  and `VERSION`, builds the zip and creates the tag + release. Never bump versions by hand: the
  repository keeps `0.0.0-dev`.
- `bun run deploy` scp's dist + integration to the HA host (host from .env, not committed).
- `demo/index.html` with a mock `hass` object (few areas, floors, lights, sensors, a fake mower
  moving in a circle; the layout in `demo/layout.js` is passed as `layout:`) for testing without HA.
  Verify with a headless browser screenshot.
