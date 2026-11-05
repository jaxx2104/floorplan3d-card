// Headless check of the demo page: fails on page errors, writes screenshots/demo-<view>.png.
//   bun scripts/screenshot.mjs [--view=3d|top] [--floor=id|all] [--out=file] [--logos=0]
import fs from "node:fs";
import path from "node:path";
import { openDemo, root, idle } from "./lib/demo-browser.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")),
);
const view = args.view || "3d";
// --logos=0 turns the integration logos off (they are on by default here, answered locally)
const logos = args.logos !== "0";
const { page, errors, close } = await openDemo(
  { view, floor: args.floor, logos: logos ? "1" : undefined },
  undefined,
  { brands: logos, test: false },
);
try {
  await idle(page, 30000); // settled (no camera tween, frame or update pending) instead of a fixed 300 ms
  const stats = await page.evaluate(() =>
    [...document.querySelectorAll("floorplan3d-card-impl")].map((c) => ({
      markers: c._view.markerObjects.size,
      drawn: c._view.sprites.layer.stats.drawn,
      labels: c._view.sprites.labels("room").length,
      badges: (() => {
        const f = [...c._faces.keys()].map((id) => c._markerView(id));
        return [
          f.filter((x) => x.logoLoaded).length,
          f.filter((x) => x.status).length,
          f.filter((x) => x.battery !== null).length,
        ];
      })(),
      chips: [...c.shadowRoot.querySelectorAll(".chip")].map(
        (b) => b.textContent + (b.classList.contains("on") ? "*" : ""),
      ),
    })),
  );
  console.log(JSON.stringify(stats));
  fs.mkdirSync(path.join(root, "screenshots"), { recursive: true });
  const out =
    args.out ||
    path.join(
      root,
      "screenshots",
      `demo-${view}${args.floor ? "-" + args.floor : ""}.png`,
    );
  await page.screenshot({ path: out });
  console.log("saved", out);
} finally {
  await close();
}
if (errors.length) {
  console.error("page errors:\n" + errors.join("\n"));
  process.exit(1);
}
