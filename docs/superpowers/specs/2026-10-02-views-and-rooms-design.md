# Views and rooms: choose what each floor shows, frame the house, pick rooms from the model

Status: design approved in chat, spec awaiting review
Date: 2026-10-02
Builds on: `2026-10-01-model-contract-design.md` (levels, rooms, bindings) and the model look work (v0.2.x).

## Goal

Make every floor view look the way the user wants without typing metres:

- The floor buttons are **views owned by the house model** (any number: Exterior, Ground floor,
  Attic…), each **linked to HA floors** so HA's own floor structure stays the source of truth for other
  cards and automations. Each view has **element choices**: any part of the model (levels, rooms,
  zones, objects, layers, or plain model groups on untagged models) can be shown or hidden in it, by
  clicking it in a tree or in the 3D view. The same element (lawn, mower, driveway) can be in several
  views.
- **No metres or elevations to type.** Floor heights come from the model.
- Each floor opens with the **house framed**, and the user can **save the current camera** as that
  floor's default.
- Rooms can be **picked from the model** (click a room's floor) instead of drawn.
- Everything set in the UI is shared (layout); YAML can override per card.

Success looks like: on the user's current untagged model, they hide the ceiling slab and the ground
plane on Floor1 with two clicks, save a nice camera, pick the kitchen floor to create the Kitchen room,
and never see an elevation field; after a re-export with `fp` tags the same views keep working.

## Non-goals

- Lamp lights, object behaviour, popups, light chains (next step, "objects and light").
- Custom views that are not HA floors.
- Editing model geometry.

## 1. Views (owned by the model, linked to HA floors)

- **Source, in order:** (1) the model's own `views` (root `extras.fp.views`, see §8); (2) if the model
  has none, generated views: one per `storey`/`basement` level (label = level label, id = level id) plus
  `all` ("All"); (3) without a model: one view per HA floor plus `all` (today's behaviour).
- **Each view** has: `id`, `label`, ordered `rules` (§2), `camera`, `floors` (linked HA floor ids),
  `cut` (untagged models only).
- **Linking to HA floors:** `floors` defaults to the HA floors of the levels the view shows by default
  (level → HA floor binding from the Model tab, unchanged); the user can change it (multi-select).
  An exterior-only view may link to no floor. One HA floor may be linked to several views.
- **Overrides:** the UI stores edits per view id in `layout.views[id]` (label, rules appended after the
  model's, camera, floors, cut, `hidden: true` to drop a model view); card YAML `views:` overrides the
  same keys per card. The UI can also add views (`layout.views[id].added = true`).
- **Which devices show in a view:** (a) a device whose area is linked to a room/zone that is visible in
  the view; else (b) a device whose area's HA floor is linked to the view (covers pins and areas
  without a room); else hidden. In a storey view (some storey or the roof hidden) devices on storeys
  below the view's top visible storey are hidden, not faded; outdoor devices show in every view. An
  overview (every storey and the roof visible) shows every device. (Ruling during implementation.)
- The level dropdown in the Model tab becomes "belongs to HA floor" (auto | floor | none).

## 2. Visibility model

### Selectors

| selector                                  | matches                                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `all`                                     | the whole model                                                                                                 |
| `level:<id>`                              | a level node (manifest level)                                                                                   |
| `role:<storey\|basement\|exterior\|roof>` | every level with that role                                                                                      |
| `room:<id>` / `zone:<id>`                 | a room or zone node                                                                                             |
| `object:<id>`                             | an object node                                                                                                  |
| `type:<type>`                             | every object of a type                                                                                          |
| `group:<name>`                            | every object with that `group`                                                                                  |
| `layer:<name>`                            | every node whose `fp.layer` is (or contains) the name                                                           |
| `node:<path>`                             | a node by path (names from the model root, `/`-separated; `*` matches within one segment, `**` across segments) |

Model views use the same selectors in their `show`/`hide` lists.
Unknown or non-matching selectors are ignored (listed as "not in this model" in the UI).

### Resolution (per floor view)

1. **Default** visibility per level from the existing rules (`levelVisible`: storeys stack, exterior
   always, roof only in All, plus the level → floor mapping), and today's cut for untagged models when
   the floor's "cut at wall height" is on (default: on for untagged models, off for tagged).
2. **Rules**: the floor's rules in order — layout rules first, then card-YAML rules — each
   `{ show: selector }` or `{ hide: selector }`. A rule applies to the node it matches and cascades to
   its descendants; for every node the **latest rule (in order) among those matching the node or any
   ancestor** decides, so a later broad rule (`hide layer:furniture`) overrides an earlier, more
   specific show; nodes with no matching rule use step 1. (Ruling during implementation: the
   "hide all + show list" model views need the cascade.)
3. **Applying to three.js** (rules only re-run when the view, rules or model change): a node's `visible` = its resolved value OR any descendant resolved
   visible (so `hide level:ground` + `show room:kitchen` shows only the kitchen inside the ground
   level; siblings without their own rule stay hidden because they inherit the hidden value).

Markers and glows follow the floor exactly as today (they belong to HA floors, not model nodes).
Picking ignores hidden nodes (already the case).

### Storage

```json
"views": {
  "ground": {
    "rules": [{ "hide": "layer:ceiling" }, { "hide": "node:floor:ground/mesh_177" }],
    "camera": { "position": [4.1, 18.3, 21.0], "target": [5.2, 0.9, -8.0] },
    "floors": ["floor1"]
  },
  "exterior": { "label": "Garden", "floors": [] },
  "night_garden": { "added": true, "label": "Night garden", "rules": [{ "show": "role:exterior" }] }
}
```

`layout.views[viewId]`: `label`, `rules` (appended after the model's), `camera` (world coordinates),
`floors`, `cut`, `hidden`, `added`. Card YAML `views:` uses the same keys per view id; its `rules` are
appended last, other keys replace for that card only.

### Migration

Existing layouts have no views: they get generated views (§1). The level dropdown's show modes (`layout.model.levels[id].show`) become view rules on load:
`hidden` → `hide level:<id>` on every view; `always` → `show level:<id>` on every view; `all-only` →
`hide level:<id>` on every floor view; `only` → `hide level:<id>` on floor views above its floor.
The binding keeps only the floor (`{ floor }` or auto). The Model tab's level dropdown becomes
"belongs to floor: auto | <floor>".

## 3. Edit → Views tab (new; the Model tab keeps upload, alignment, level→floor, rooms, report)

- View picker (defaults to the selected view chip; switching it switches the chip), with add, rename,
  hide and reorder, and the view's linked HA floors (multi-select).
- **Element tree** of the loaded model: levels → rooms/zones → objects; a "Layers" section listing the
  model's `fp.layer` names; for untagged parts the model's own groups two levels deep. Each row has a
  three-state eye: default (inherits), shown, hidden. Rows show the resolved state.
- **Click in 3D** (Views tab open): the picked part is highlighted and a small menu offers
  "Hide in this view", "Show in this view", "Hide in all views", "Reveal in tree". Picks walk up to
  the nearest tagged node; untagged meshes pick the deepest named group (not single meshes) so a click
  hides a meaningful part.
- **Camera**: "Save current view as this floor's start" and "Reset camera".
- **Cut at wall height** checkbox (shown only for untagged models).
- **Reset this floor** (removes its rules and camera).
- Every view: a label field.

## 4. No metres

- Floor elevation and height for a floor bound to a model level: from the level's `fp` (tagged) or,
  for untagged levels, measured: elevation = max(0, level minY) rounded to 0.05 for the lowest storey
  bound to a floor at/above ground, other storeys' elevation = their minY rounded to 0.05;
  height = (next storey's elevation − this elevation) or 2.7 when it is the top storey.
- The Rooms tab's elevation/height inputs move into a collapsed "Advanced (no model)" section, shown
  only when no model is loaded. Stored overrides still apply when present (existing layouts).

## 5. Camera

- Default framing per floor view: the house — union of rooms on visible floors excluding outdoor
  zones; without rooms, the bounding box of visible storey levels' meshes (≤ 60 m each). "All" frames
  the visible model (meshes ≤ 60 m).
- A saved `camera` replaces the default for that view (3D mode; top view keeps fit-to-house).
- Switching floors tweens to the next view's camera (existing 400 ms tween).

## 6. Pick a room from the model

- Rooms tab: each missing area gets "Pick" next to "Draw". Pick mode: crosshair; click a floor surface
  in the model.
- If the hit belongs to a tagged room/zone → that model room is bound to the area (Model tab binding);
  no drawn room is created.
- Otherwise the outline is computed from the hit mesh: take its triangles with a world normal within
  25° of up whose centroid height is within 0.05 m of the hit point's height; boundary edges = edges
  used by exactly one of those triangles; chain them into closed loops; choose the loop containing the
  hit point; simplify collinear points (tolerance 0.02 m); snap to 0.05 m. If that fails (no loop,
  fewer than 3 points), fall back to the mesh's plan bounding rectangle and say so.
- Limitation (from `docs/prototype-findings.md`): the prototype merges static geometry per material, so
  on an **untagged** export one floor mesh can span several rooms and the traced loop may cover them
  all. The pick then shows the traced outline for confirmation ("Use" / "Draw instead"), and the user
  can reshape it. Tagged exports (the prototype's "floorplan3d-card (house.glb)" export writes
  `fp` room groups with outlines) avoid this entirely: rooms appear without picking.
- The polygon is in plan coordinates of the current alignment (inverse of the model alignment is not
  needed: rooms are stored in plan space). The room is created on the selected floor, selected, and can
  be reshaped like a drawn room.

## 7. Room labels with size

Room labels (edit mode with a model; always without a model) show the name and the plan size:
"Kitchen · 2.7 × 3.8 m" (bounding size, 0.1 m precision) or the area for non-rectangles
("Hallway · 14.2 m²"). Card option `room_labels: name | size | none` (default `size`).

## 8. Model builder guide additions

- `fp.layer` on any node (string or array): `furniture`, `fence`, `terrain`, `ceiling`, `roof`,
  `facade`, `decoration`, `glass`, `stairs` (others allowed).
- Ceilings/slabs between storeys belong to the storey above.
- Each room's floor slab is its own mesh inside its room group. Merge geometry per room or per layer,
  never across rooms or storeys.
- No world ground plane inside a storey (exterior `layer: terrain` instead).
- Optional `fp.label`, `fp.area_m2` on rooms (display only).
- **Views in the model:** root node (or the single wrapper) may carry
  `extras.fp.views = [{ id, label, show: [selectors], hide: [selectors], camera?: { position, target } }]`
  in display order, e.g. Exterior `{ show: ['all'] }`, Ground floor
  `{ show: ['level:ground', 'role:exterior'], hide: ['level:attic', 'role:roof'] }`, Attic
  `{ show: ['level:ground', 'level:attic', 'role:exterior'], hide: ['role:roof'] }`.
- Concrete look values (renderer, sun, materials, lamps, cameras, labels) come from the prototype's
  source, summarised in `docs/prototype-findings.md`; they feed the objects-and-light step.

## 9. Error handling

- Selectors that match nothing: kept, shown greyed in the tree with "not in this model".
- Picking with no model loaded / no hit: message "Click on a room's floor".
- Outline extraction failure: bounding-rectangle fallback with a notice.
- YAML `views` with unknown view ids: ignored with a console warning.

## 10. Testing

- Unit (pure, on generic node trees): view sources and merge order (model → generated → layout →
  YAML), device-in-view rule (room visible / linked floor / hidden), selector parsing and matching (incl. `*`/`**`), rule resolution
  (last match wins, inheritance, ancestor-visible-for-shown-descendant), migration of level show modes,
  YAML merge, measured elevations, outline extraction from triangle lists (rectangle, L-shape, hole-free
  with extra faces, failure → null), label formatting.
- Headless: Views tab tree toggles hide/show a level and a layer on the demo model; click-in-3D
  "Hide in this view" hides the clicked group only on that floor; saved camera restores after
  switching floors and on reload; pick a room on the demo model creates a polygon matching the room's
  outline within 0.1 m; untagged demo copy: no elevation inputs visible, elevation derived; legacy
  `floor:` model: cut checkbox present and default on.
