// Print the next release version from the commits since the latest v* tag (conventional commits),
// or nothing when no commit needs a release (docs, chore, ci, test, style, build only).
//   feat -> minor, fix/perf/refactor/revert and non-conventional subjects -> patch,
//   "type!:" or "BREAKING CHANGE" -> major (minor while below 1.0).
// The 0.4.9-jaxx.N fork series (a prerelease) moves on to the next minor: 0.5.0.
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const tags = git("tag", "--list", "v*", "--sort=-v:refname")
  .split("\n")
  .filter(Boolean);
const last = tags[0];
const range = last ? `${last}..HEAD` : "HEAD";
const commits = git("log", range, "--format=%s%n%b%x00")
  .split("\0")
  .map((c) => c.trim())
  .filter(Boolean);

const NO_RELEASE = /^(docs|chore|ci|test|style|build)(\(.+\))?:/;
let bump = 0; // 0 none, 1 patch, 2 minor, 3 major
for (const c of commits) {
  const subject = c.split("\n")[0];
  if (/^\w+(\(.+\))?!:/.test(subject) || /^BREAKING[ -]CHANGE:/m.test(c))
    bump = Math.max(bump, 3);
  else if (/^feat(\(.+\))?:/.test(subject)) bump = Math.max(bump, 2);
  else if (!NO_RELEASE.test(subject)) bump = Math.max(bump, 1);
}
if (!bump) process.exit(0);

const m = /^v(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(last || "v0.0.0");
if (!m) throw new Error(`unexpected tag ${last}`);
let [major, minor, patch] = m.slice(1, 4).map(Number);
if (m[4]) bump = Math.max(bump, 2);
if (bump === 3 && major === 0) bump = 2;
if (bump === 3) [major, minor, patch] = [major + 1, 0, 0];
else if (bump === 2) [minor, patch] = [minor + 1, 0];
else patch += 1;
console.log(`${major}.${minor}.${patch}`);
