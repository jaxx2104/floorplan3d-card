import { describe, it, expect } from "bun:test";
import {
  isDocked,
  dockWord,
  dockFrontAxis,
  dockPose,
  rememberPosition,
  lastPosition,
  mowerDockGroup,
  groupedTapId,
  groupedHidden,
  dockRows,
} from "../src/mower-track.ts";

describe("docked state", () => {
  it("lawn_mower docked / charging", () => {
    expect(isDocked("docked")).toBe(true);
    expect(isDocked("Charging")).toBe(true);
    expect(isDocked("mowing")).toBe(false);
    expect(isDocked("returning")).toBe(false);
  });
  it("a Mower status sensor saying Docked / Charging", () => {
    expect(isDocked("mowing", "Docked")).toBe(true);
    expect(isDocked("unknown", "Charging")).toBe(true);
    expect(isDocked("paused", "In dock")).toBe(true);
    expect(isDocked("returning", "Returning to dock")).toBe(false);
    expect(isDocked("mowing", "Leaving dock")).toBe(false);
    expect(isDocked("mowing", "Working")).toBe(false);
    expect(isDocked(null, null)).toBe(false);
  });
  it("word for the status line", () => {
    expect(dockWord("docked")).toBe("docked");
    expect(dockWord("docked", "Charging")).toBe("charging");
  });
});

describe("dock pose", () => {
  it("front axis: +Z by default, hints.front wins", () => {
    expect(dockFrontAxis(null)).toEqual([0, 0, 1]);
    expect(dockFrontAxis({ front: "-x" })).toEqual([-1, 0, 0]);
    expect(dockFrontAxis({ front: "up" })).toEqual([0, 0, 1]);
  });
  it("world anchor and direction -> plan point and heading", () => {
    const p = dockPose({ x: 13, y: 0.15, z: -1.5 }, { x: 0, z: 1 }); // world +z = plan south
    expect(p.x).toBe(13);
    expect(p.y).toBe(1.5);
    expect(p.heading).toBeCloseTo(-Math.PI / 2);
    expect(dockPose({ x: 0, y: 0, z: 0 }, { x: 1, z: 0 }).heading).toBeCloseTo(
      0,
    ); // east
    expect(dockPose({ x: 0, y: 0, z: 0 }, { x: 0, z: -2 }).heading).toBeCloseTo(
      Math.PI / 2,
    ); // north
    expect(dockPose({ x: 0, y: 0, z: 0 }, { x: 0, z: 0 }).heading).toBe(null);
  });
});

describe("last known position", () => {
  it("kept per layout key, copies out", () => {
    rememberPosition("a", { x: 1, y: 2 });
    const p = lastPosition("a");
    p.x = 9;
    expect(lastPosition("a")).toEqual({ x: 1, y: 2 });
    expect(lastPosition("b")).toBe(null);
    rememberPosition("a", null);
    expect(lastPosition("a")).toBe(null);
  });
});

describe("mower and dock as one when docked", () => {
  it("groups only when docked with both objects", () => {
    expect(mowerDockGroup({ docked: true, mowerId: "m", dockId: "d" })).toEqual(
      { mower: "m", dock: "d" },
    );
    expect(
      mowerDockGroup({ docked: false, mowerId: "m", dockId: "d" }),
    ).toBeNull();
    expect(
      mowerDockGroup({ docked: true, mowerId: null, dockId: "d" }),
    ).toBeNull();
    expect(
      mowerDockGroup({ docked: true, mowerId: "m", dockId: null }),
    ).toBeNull();
    expect(
      mowerDockGroup({ docked: true, mowerId: "x", dockId: "x" }),
    ).toBeNull();
  });
  it("a tap on the dock goes to the mower; the dock has no tap dot of its own", () => {
    const g = { mower: "m", dock: "d" };
    expect(groupedTapId("d", g)).toBe("m");
    expect(groupedTapId("m", g)).toBe("m");
    expect(groupedTapId("lamp", g)).toBe("lamp");
    expect(groupedTapId("d", null)).toBe("d");
    expect(groupedHidden("d", g)).toBe(true);
    expect(groupedHidden("m", g)).toBe(false);
    expect(groupedHidden("d", null)).toBe(false);
  });
  it("dock rows for the mower popup: charging / docked and the battery", () => {
    expect(dockRows("charging", 85)).toEqual([
      { kind: "info", label: "Dock", value: "Charging · 85 %" },
    ]);
    expect(dockRows("docked", null)).toEqual([
      { kind: "info", label: "Dock", value: "Docked" },
    ]);
    expect(dockRows("docked", "100")).toEqual([
      { kind: "info", label: "Dock", value: "Docked · 100 %" },
    ]);
  });
});
