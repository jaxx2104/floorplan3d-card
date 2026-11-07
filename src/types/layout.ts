// Stored layout types, derived from the schemas in src/schema/layout.ts (the contract: parse,
// defaults, migrations). Every stored object also keeps fields this card does not know (Rest).
// Plus the plain geometry / view types the layout readers share.

import type { Infer } from "../schema/core.ts";
import type * as S from "../schema/layout.ts";

/** Plan point in metres: [x east, y north]. */
export type PlanPoint = [number, number];

/** World-space vector [x, y, z] (three.js frame, y up). */
export type Vec3 = [number, number, number];

/** RGB colour as stored by the colour pickers ([r, g, b], 0..255). */
export type RgbColor = [number, number, number] | number[];

/** "Light on wall" setting of a lamp or a tag. */
export type WashDir = "down" | "up" | "both" | "none";

/** HA-style action ({ action, ... }); the fields depend on the action (see actions.ts). */
export interface ActionConfig {
  action: string;
  [key: string]: unknown;
}

export interface ViewCamera {
  position: Vec3;
  target: Vec3;
}

/** Top-view camera: centre in plan metres and zoom (1 = 10 m half height). */
export interface TopCamera {
  center: [number, number];
  zoom: number;
}

/** The whole stored layout after parseLayout: defaults present, migrated to the current version. */
export type Layout = S.NormalisedLayout;
/** Same as Layout (kept as the name for "parsed, defaults present"). */
export type NormalisedLayout = S.NormalisedLayout;

export type LayoutFloor = Infer<typeof S.floorSchema>;
export type LayoutRoom = Infer<typeof S.roomSchema>;
export type LayoutPin = Infer<typeof S.pinSchema>;
export type LayoutMower = Infer<typeof S.mowerSchema>;
export type MowerCalibrationPoint = NonNullable<
  LayoutMower["calibration"]
>[number];
export type LayoutModel = Infer<typeof S.modelSchema>;
export type SavedLevelBinding = Infer<typeof S.levelBindingSchema>;
export type SavedRoomBinding = Infer<typeof S.roomBindingSchema>;
export type LayoutObject = Infer<typeof S.objectSchema>;
export type ObjectUi = Infer<typeof S.objectUiSchema>;
export type LayoutTag = Infer<typeof S.tagSchema>;
export type LayoutView = Infer<typeof S.viewSchema>;
export type ViewRule = Infer<typeof S.viewRuleSchema>;
export type LayoutBadges = Infer<typeof S.badgesSchema>;

/** A floor after merging HA floors with the layout (see mergeFloors). */
export interface Floor {
  id: string;
  name: string;
  elevation: number;
  height: number;
}
