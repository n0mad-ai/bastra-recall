#!/usr/bin/env node
/**
 * bump.mjs — set a new version across all workspace packages AND keep the
 * internal cross-dependency pins in lockstep.
 *
 * Why: `npm version --workspaces` bumps each package's own version but does
 * NOT rewrite the internal pins (e.g. the daemon's `"@bastra-recall/core":
 * "0.7.0-beta.1"`), so a publish would resolve a stale dependency version.
 * This rewrites the version of every workspace + root and every dependency
 * entry that points at an internal package, in one shot.
 *
 *   node scripts/bump.mjs <version> [--dry-run]
 *
 * Example:
 *   node scripts/bump.mjs 0.7.0-beta.2 --dry-run   # preview only
 *   node scripts/bump.mjs 0.7.0-beta.2             # apply
 *
 * Does NOT touch git — commit, tag and `gh release create` stay manual.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const version = args.find((a) => !a.startsWith("--"));

if (!version) {
  console.error("usage: node scripts/bump.mjs <version> [--dry-run]");
  process.exit(1);
}
// Coarse semver check: major.minor.patch (+ optional -prerelease / +build).
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`error: '${version}' is not a valid semver version`);
  process.exit(1);
}

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

// 1) Collect package.json paths: root + every workspace.
const rootPkgPath = resolve(repoRoot, "package.json");
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
const pkgPaths = [
  rootPkgPath,
  ...(rootPkg.workspaces ?? []).map((w) => resolve(repoRoot, w, "package.json")),
];

// 2) Load them all, then learn the internal package names from their `name`.
const pkgs = pkgPaths.map((path) => ({
  path,
  json: JSON.parse(readFileSync(path, "utf8")),
}));
const internalNames = new Set(pkgs.map((p) => p.json.name).filter(Boolean));

// 3) Set version + rewrite internal pins; record every change.
const changes = [];
for (const { path, json } of pkgs) {
  const rel = path.startsWith(repoRoot + "/")
    ? path.slice(repoRoot.length + 1)
    : path;
  let dirty = false;

  if (json.version !== version) {
    changes.push(`${rel}: version ${json.version} → ${version}`);
    json.version = version;
    dirty = true;
  }

  for (const field of DEP_FIELDS) {
    const deps = json[field];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (internalNames.has(name) && deps[name] !== version) {
        changes.push(`${rel}: ${field}.${name} ${deps[name]} → ${version}`);
        deps[name] = version;
        dirty = true;
      }
    }
  }

  if (!dryRun && dirty) {
    writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  }
}

// 3b) Guard: no hardcoded version literals in daemon source.
//
// This block used to REWRITE version constants in source files, because
// bump.mjs originally only touched package.json and the constants shipped
// stale. That kept failing in a quieter way: on the 0.8.9 bump it ran over
// part of the tree only, so cli/helpers.ts said 0.8.9 while index.ts still
// said 0.8.8 — and the daemon reported 0.8.8 in /health, in the MCP handshake,
// and to the update check, which then compared the wrong version against the
// published one.
//
// The constants now read package.json at runtime (packages/daemon/src/version.ts),
// so there is nothing left to rewrite. What remains is making sure nobody
// reintroduces a literal: bumping the package must stay the only way to bump
// the daemon.
const VERSION_LITERAL = /(?:VERSION|version)\s*[:=]\s*"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?"/;
const GUARDED_SOURCES = [
  "packages/daemon/src/index.ts",
  "packages/daemon/src/mcp-forwarder.ts",
  "packages/daemon/src/cli/helpers.ts",
  "packages/daemon/src/version.ts",
];
for (const relPath of GUARDED_SOURCES) {
  const src = readFileSync(resolve(repoRoot, relPath), "utf8");
  const hit = src.match(VERSION_LITERAL);
  if (hit) {
    console.error(
      `error: hardcoded version literal in ${relPath}: ${hit[0]}\n` +
        `       The daemon reads its version from package.json at runtime — remove the literal\n` +
        `       and import DAEMON_VERSION from ./version.js instead.`,
    );
    process.exit(1);
  }
}

// 4) The release handoff (#524).
//
// This used to end in `gh release create … --prerelease` for every version,
// stable ones included. That is the one release kind that keeps the primary
// non-developer install path stale: the publish workflow publishes npm under
// `latest` on any release, while the Homebrew tap updater and the one-click
// installers read GitHub `/releases/latest`, which excludes prereleases.
// Following the printed command for 1.0.0 would have shipped npm 1.0.0 while
// Homebrew and the Finder installer stayed on 0.9.2.
//
// So the flag now follows the semver: `--prerelease` only when the version
// itself has a prerelease component. A stable release is instead STAGED with
// `--latest=false`: the page and its tag exist so the workflow can build,
// publish and attach the whole set, but `/releases/latest` — the source the tap
// updater consumes — only moves in the workflow's `promote` job, after every
// npm version and every required asset has been verified. Until then a user
// opening the tap or the installer still gets the previous, coherent release
// rather than a 1.0 page whose npm packages are half-published.
const isPrerelease = version.includes("-");
const releaseCmd = isPrerelease
  ? `gh release create v${version} --prerelease --generate-notes`
  : `gh release create v${version} --generate-notes --latest=false`;
const stagingNote = isPrerelease
  ? "  # a prerelease never becomes /releases/latest, so the tap stays where it is"
  : "  # staged: `promote` moves /releases/latest once the whole set is verified";

function printHandoff() {
  console.log(
    `\nNext:\n  npm install            # refresh package-lock\n` +
      `  git commit -am "release: v${version}"\n` +
      `  ${releaseCmd}\n${stagingNote}`,
  );
}

// 5) Report.
if (changes.length === 0) {
  console.log(`Nothing to change — everything is already at ${version}.`);
} else {
  console.log(`${dryRun ? "[dry-run] would apply" : "applied"} ${changes.length} change(s):`);
  for (const c of changes) console.log("  " + c);
}
// Printed in dry-run too: the handoff is the part that was wrong, and a
// rehearsal that hides it cannot catch it again.
printHandoff();
