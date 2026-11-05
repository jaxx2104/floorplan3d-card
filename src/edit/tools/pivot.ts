// "Set rotation centre" (Views tab): arm, cancel, and the click that sets it.

import type { EditMode } from "../../edit-mode.ts";

export function cancelPivot(ed: EditMode) {
  ed.pivoting = false;
  ed._syncStageClasses();
  ed.render();
}

// "Set rotation centre": the clicked model point (else the view's floor plane) becomes the
// controls target; saved with the camera (3D) or as the top-view centre (top).
export function setPivot(ed: EditMode, e: PointerEvent) {
  const card = ed.card,
    v = card.currentView();
  card.leaveSection();
  const point = ed.view.pivotPoint(
    e.clientX,
    e.clientY,
    ed.view.floorElevation(card._floor),
  );
  if (!point || !v) {
    ed.message = { text: "Click on the model or the floor", warn: true };
    ed.render();
    return;
  }
  ed.pivoting = false;
  ed._syncStageClasses();
  if (card._mode === "top") {
    const cur = ed.view.getTopCamera()!; // top mode: the view returns the top camera
    const camera_top = {
      center: [
        Math.round(point[0] * 100) / 100 + 0,
        Math.round(-point[2] * 100) / 100 + 0,
      ],
      zoom: cur.zoom,
    };
    ed.view.setTopCamera(camera_top);
    ed.message = { text: `Top view of "${v.label}" now centres here.` };
    card.saveViewPatch(v.id, { camera_top });
  } else {
    const camera = ed.view.setPivot(point);
    ed.message = { text: `Rotation centre of "${v.label}" set.` };
    card.saveViewPatch(v.id, { camera });
  }
  ed.render();
}
