> **Superseded by [model-builder-guide.md](model-builder-guide.md)** (model contract v2: tagged levels, rooms, zones and objects, all assigned in the card). This page describes the v1 format (`floor:<id>` groups + separate layout JSON), which keeps working.

# House model spec

What a house design (for example a Three.js scene) should produce so floorplan3d-card can use it.
Two files: the room plan (required) and a visual model (optional, but without it the card shows
only the markers and room labels).

## Coordinates

- Units: **metres**.
- Plan axes: **x = east, y = north** (y grows north, not down as on screens/SVG).
- Origin (0, 0): south-west corner of the house's outer walls. Use the same origin in both files.
- 3D (glTF, Y up): plan point (x, y) at height h is world **(x, h, -y)**, so north is -Z.

## 1. `house-layout.json` – room plan (required)

Paste it under the card YAML's `layout:` (JSON is valid YAML), or write it in YAML there.

```json
{ "version": 1,
  "floors": [
    { "id": "ground", "name": "Ground floor", "elevation": 0,   "height": 2.7 },
    { "id": "first",  "name": "First floor",  "elevation": 3.0, "height": 2.5 } ],
  "rooms": [
    { "id": "r1", "area_id": "kitchen", "floor_id": "ground",
      "polygon": [[0,0],[4,0],[4,3],[0,3]],
      "doors": [[2,0]], "outdoor": false } ],
  "pins": {}, "hidden": [], "mower": null }
```

- `version`: the layout format, 1 or 2 (the card writes 2; version 1 is migrated when the card reads it).
- `polygon`: inner floor outline of the room, corners in order, no repeated closing point.
  Neighbouring rooms should share exact corner coordinates on common walls.
- `doors`: a point on the wall line in the middle of each door opening (door sensors are placed there).
- `outdoor: true` for terrace, garden, driveway.
- The card draws no walls or room fills: a room places the markers of its area and gets a room label;
  the house itself is the model.
- `area_id`: the Home Assistant area id (Settings → Areas, snake_case such as `living_room`).
  Devices assigned to that area appear in the room automatically.
- `floor_id`: the Home Assistant floor id. Optional when the area already has that floor.
- Floors: `elevation` = finished floor height above the ground floor, `height` = ceiling height.
  Floors that exist in Home Assistant are picked up automatically (elevation = level × 3 m);
  entries here override elevation and height.

## 2. `house.glb` – visual model (optional)

Copy it to `/config/www/` and set `model: /local/house.glb` in the card.

- glTF binary, Y up, metres, same origin as the JSON (see Coordinates).
- One top-level group per storey named **`floor:<floor_id>`**, using the Home Assistant floor id
  (e.g. `floor:floor1`), containing everything on that
  storey: slab, walls, windows, stairs, furniture. The card shows only the selected storey's group.
  Groups with other names still work: they are matched bottom-up and can be reassigned with the
  card option `model_floors` (`{ <level id>: <HA floor id> }`; `bun run check-model` lists the level ids). A storey HA has no floor for (an unused attic) is shown with every floor and cut away.
- Roof in a group named `roof`, terrain in `site`. An untagged model is cut at the top of the
  selected storey (elevation + storey height), so full-height walls and the roof are fine.
- Optional: room groups named `room:<area_id>` inside their floor group.
- Ground planes, roads and terrain belong in `site`, never in a `floor:` group. Leave out a
  "world" ground plane altogether (the card draws its own background).
- No lights, cameras, helpers, grids or HTML labels. Keep it under ~10 MB: merge meshes, simple
  materials, no huge textures.

To export an existing Three.js scene, use [tools/export-glb.js](../tools/export-glb.js): add
`window.scene = scene;` to the design, open it in the browser, paste the file into the console.
It drops lights and helpers, reports size and origin, and downloads `house.glb`.

If the model's origin or orientation doesn't match, fix it in the card instead of re-exporting:
`model_position: [x, y, z]` (plan metres), `model_rotation` (degrees, counter-clockwise),
`model_scale`.

## Do not model

Lights, sensors, switches and other smart devices. The card places them from Home Assistant
(every device assigned to an area appears in its room, positioned by type) and they can be
pinned to their exact spot in the layout's `pins`.
