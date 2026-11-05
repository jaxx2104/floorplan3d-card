// Build and copy the integration (it serves the bundled card) to a Home Assistant host over SSH.
// Settings come from .env (not committed), see .env.example:
//   HA_SSH=root@homeassistant.local   HA_CONFIG=/config   HA_SSH_PORT=22
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const env = { HA_CONFIG: "/config", HA_SSH_PORT: "22" };
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
Object.assign(
  env,
  Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith("HA_")),
  ),
);
if (!env.HA_SSH) {
  console.error(
    "Set HA_SSH (e.g. root@homeassistant.local) in .env; see .env.example",
  );
  process.exit(1);
}
const run = (cmd, args) => {
  console.log("$", cmd, args.join(" "));
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
};
run(process.execPath, ["scripts/build.mjs"]); // bun: the build uses Bun.build
const port = ["-P", env.HA_SSH_PORT];
run("ssh", [
  "-p",
  env.HA_SSH_PORT,
  env.HA_SSH,
  `mkdir -p ${env.HA_CONFIG}/custom_components`,
]);
run("scp", [
  ...port,
  "-r",
  "custom_components/floorplan3d",
  `${env.HA_SSH}:${env.HA_CONFIG}/custom_components/`,
]);
console.log(
  "Deployed. Restart Home Assistant if the integration changed; for card-only changes reload the browser.",
);
