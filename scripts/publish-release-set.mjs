#!/usr/bin/env node
/**
 * publish-release-set.mjs — publish the four npm packages of one release as a
 * set, resumably (#524).
 *
 *   node scripts/publish-release-set.mjs            # publish what is missing
 *   node scripts/publish-release-set.mjs --verify   # assert the set is complete
 *
 * Why: the publish workflow used to run four independent `npm publish` steps.
 * npm versions are immutable, so a failure in a later step left a release whose
 * first packages were on the registry and whose last ones were not — and a
 * rerun died on the first, already-published package before it ever reached the
 * missing ones. The only repair was manual.
 *
 * This walks the same four packages in the same order (the unscoped wrapper
 * stays LAST, so its exact internal dependency pins can never point users at
 * packages that were not published) and, for each:
 *
 *   - not on the registry  → publish it
 *   - already on the registry → verify it is the artifact this checkout would
 *     have published (same name, same version, same internal dependency pins)
 *     and skip it; a mismatch is a hard failure, never a silent skip
 *
 * `--verify` publishes nothing. It asserts that every package of the set is on
 * the registry at this version AND carries the `latest` dist-tag — the gate the
 * workflow's `promote` job runs before it moves GitHub `/releases/latest`, which
 * is what the Homebrew tap updater and the one-click installers consume.
 *
 * The `npm` binary is taken from PATH, so the whole thing is exercisable
 * against a stub registry in tests.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Publication order. The wrapper depends on the daemon, which depends on core
// and statusline — publishing in dependency order means a partially published
// set never resolves to something that is not there yet.
const WORKSPACE_DIRS = [
  "packages/core",
  "packages/statusline",
  "packages/daemon",
  "packages/bastra-recall",
];

const verifyOnly = process.argv.includes("--verify");

function readPkg(dir) {
  const path = resolve(repoRoot, dir, "package.json");
  const json = JSON.parse(readFileSync(path, "utf8"));
  return { dir, name: json.name, version: json.version, dependencies: json.dependencies ?? {} };
}

function npm(args) {
  return spawnSync("npm", args, { cwd: repoRoot, encoding: "utf8" });
}

/**
 * The registry's view of `name@version`, or null when it is not published.
 * Anything that is neither "here it is" nor "404" is an infrastructure failure
 * and must not be mistaken for "not published" — publishing over a network
 * blip is how a set gets half-written in the first place.
 */
function fetchPublished(name, version) {
  const res = npm(["view", `${name}@${version}`, "--json"]);
  if (res.status === 0) {
    const text = (res.stdout ?? "").trim();
    if (!text) return null;
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
  }
  const err = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (/E404|is not in this registry|no such package/i.test(err)) return null;
  throw new Error(`npm view ${name}@${version} failed (${res.status}):\n${err.trim()}`);
}

/** The version the registry currently serves as `latest` for `name`. */
function fetchLatestTag(name) {
  const res = npm(["view", name, "dist-tags.latest"]);
  if (res.status !== 0) return null;
  return (res.stdout ?? "").trim() || null;
}

/**
 * Is an already-published artifact the one this checkout would have published?
 * The tarball's bytes are not reproducible here, but the thing that actually
 * breaks users is a published package whose internal pins differ from this
 * release's — so that is what gets compared.
 */
function mismatchReason(pkg, published) {
  if (published.name !== pkg.name) return `name is ${published.name}`;
  if (published.version !== pkg.version) return `version is ${published.version}`;
  const theirs = published.dependencies ?? {};
  for (const [dep, want] of Object.entries(pkg.dependencies)) {
    if (!dep.startsWith("@bastra-recall/") && dep !== "bastra-recall") continue;
    if (theirs[dep] !== want) {
      return `dependency ${dep} is ${theirs[dep] ?? "absent"}, expected ${want}`;
    }
  }
  return null;
}

const pkgs = WORKSPACE_DIRS.map(readPkg);

// Preflight: one release is one version. A set whose package.json files
// disagree is a broken bump, and finding that out after two publishes is too
// late — npm versions cannot be taken back.
const versions = new Set(pkgs.map((p) => p.version));
if (versions.size !== 1) {
  console.error(
    `error: the release set is not on one version:\n` +
      pkgs.map((p) => `  ${p.name}: ${p.version}`).join("\n"),
  );
  process.exit(1);
}
const version = pkgs[0].version;
console.log(`Release set v${version} — ${verifyOnly ? "verifying" : "publishing"} ${pkgs.length} package(s).`);

// Preflight every target before the first publish, so a set that is already
// inconsistent fails without adding another immutable version to the mess.
const state = [];
for (const pkg of pkgs) {
  const published = fetchPublished(pkg.name, pkg.version);
  if (published) {
    const reason = mismatchReason(pkg, published);
    if (reason) {
      console.error(
        `error: ${pkg.name}@${pkg.version} is already published but is NOT this release: ${reason}.\n` +
          `       npm versions are immutable — this needs a new version, not a rerun.`,
      );
      process.exit(1);
    }
  }
  state.push({ pkg, published: Boolean(published) });
}

if (verifyOnly) {
  let failed = false;
  for (const { pkg, published } of state) {
    if (!published) {
      console.error(`✗ ${pkg.name}@${pkg.version} is not on the registry`);
      failed = true;
      continue;
    }
    const latest = fetchLatestTag(pkg.name);
    if (latest !== pkg.version) {
      console.error(`✗ ${pkg.name} dist-tag latest is ${latest ?? "unset"}, expected ${pkg.version}`);
      failed = true;
      continue;
    }
    console.log(`✓ ${pkg.name}@${pkg.version} published and tagged latest`);
  }
  process.exit(failed ? 1 : 0);
}

for (const { pkg, published } of state) {
  if (published) {
    console.log(`↷ ${pkg.name}@${pkg.version} already published — skipping (verified as this release)`);
    continue;
  }
  console.log(`→ publishing ${pkg.name}@${pkg.version}`);
  const res = npm([
    "publish",
    `--workspace=${pkg.name}`,
    "--access",
    "public",
    "--provenance",
    "--tag",
    "latest",
  ]);
  process.stdout.write(res.stdout ?? "");
  process.stderr.write(res.stderr ?? "");
  if (res.status !== 0) {
    console.error(
      `error: publishing ${pkg.name}@${pkg.version} failed.\n` +
        `       Rerun this script — packages already on the registry are skipped.`,
    );
    process.exit(res.status || 1);
  }
}
console.log(`Release set v${version} published.`);
