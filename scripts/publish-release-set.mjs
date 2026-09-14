#!/usr/bin/env node
/**
 * publish-release-set.mjs — publish the four npm packages of one release as a
 * set, resumably (#524).
 *
 *   node scripts/publish-release-set.mjs --tag v1.0.0   # publish what is missing
 *   node scripts/publish-release-set.mjs --verify       # assert the set is complete
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
 *     have published (same name, same version, same internal dependency pins,
 *     and the same tarball digest) and skip it; a mismatch is a hard failure,
 *     never a silent skip
 *
 * `--verify` publishes nothing. It asserts that every package of the set is on
 * the registry at this version AND carries the `latest` dist-tag — the gate the
 * workflow's `promote` job runs before it moves GitHub `/releases/latest`, which
 * is what the Homebrew tap updater and the one-click installers consume.
 *
 * #549 — the publish is the LAST irreversible step of a release, not the first.
 *
 * Each package went straight to `--tag latest` while the desktop extension, the
 * installers and the completeness of the set were still unverified. A later
 * failure left GitHub hidden as a draft and npm users already holding the new,
 * incomplete set: `npm install -g bastra-recall` handed them a version whose
 * assets did not exist. That contradicts the whole point of staging in private.
 *
 * npm's OIDC trusted publishing issues publish-scoped credentials — `npm
 * dist-tag add` is rejected with them and `npm stage approve` needs 2FA — so a
 * staging dist-tag promoted afterwards would mean putting a long-lived npm token
 * back into the release path. Instead the irreversible step is moved to the end
 * and given a precondition: publishing requires the release tag, and refuses to
 * publish a single package while that release is still missing any required
 * asset. The stub binaries, the checksums, the .mcpb bundle and the Finder
 * installers therefore all exist before `latest` moves anywhere.
 *
 * A partial failure inside the publish itself keeps the #524 behaviour, which is
 * why the order matters: packages go out in dependency order with the unscoped
 * `bastra-recall` wrapper LAST, so a run that dies part-way has not moved the
 * documented install path at all — `npm install -g bastra-recall` still resolves
 * to the previous release, whose exact pins point at packages that are still
 * there. A rerun skips what is genuinely published (digest-verified) and
 * finishes the rest, and GitHub stays a draft until `promote`.
 *
 * The `npm` and `gh` binaries are taken from PATH, so the whole thing is
 * exercisable against stubs in tests.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertCompleteAssets } from "./release-assets.mjs";

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

/** The tag of the staged release this publish belongs to (#549). */
function readTag() {
  const flag = process.argv.indexOf("--tag");
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1].trim();
  const inline = process.argv.find((a) => a.startsWith("--tag="));
  if (inline) return inline.slice("--tag=".length).trim();
  return (process.env.RELEASE_TAG ?? "").trim();
}

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
 * The digest of the tarball this checkout would publish for `pkg`. `npm pack`
 * normalizes entry metadata, so the same sources packed by the same npm give
 * the same bytes — which is what makes this comparable to the registry's.
 */
function packDigest(name) {
  const res = npm(["pack", "--dry-run", "--json", `--workspace=${name}`]);
  if (res.status !== 0) {
    throw new Error(
      `npm pack --dry-run ${name} failed (${res.status}):\n${`${res.stdout ?? ""}${res.stderr ?? ""}`.trim()}`,
    );
  }
  // npm prints the JSON array on stdout; lifecycle output may precede it.
  const text = (res.stdout ?? "").trim();
  const start = text.indexOf("[");
  const parsed = JSON.parse(start >= 0 ? text.slice(start) : text);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return { integrity: entry?.integrity ?? null, shasum: entry?.shasum ?? null };
}

/**
 * Is an already-published artifact the one this checkout would have published?
 *
 * Metadata alone does not answer that (#524): another commit built with the
 * same version and the same internal pins produces a package that compares
 * equal on every field here while shipping entirely different code. So the
 * candidate is packed and its tarball digest compared against the registry's
 * `dist` — different bytes are a different artifact, whatever the manifest says.
 */
function mismatchReason(pkg, published, digest) {
  if (published.name !== pkg.name) return `name is ${published.name}`;
  if (published.version !== pkg.version) return `version is ${published.version}`;
  const theirs = published.dependencies ?? {};
  for (const [dep, want] of Object.entries(pkg.dependencies)) {
    if (!dep.startsWith("@bastra-recall/") && dep !== "bastra-recall") continue;
    if (theirs[dep] !== want) {
      return `dependency ${dep} is ${theirs[dep] ?? "absent"}, expected ${want}`;
    }
  }
  if (!digest) return null;
  const dist = published.dist ?? {};
  // Fail closed: an artifact whose bytes cannot be compared is not verified.
  if (digest.integrity && dist.integrity) {
    return digest.integrity === dist.integrity
      ? null
      : `tarball integrity is ${dist.integrity}, this checkout packs ${digest.integrity}`;
  }
  if (digest.shasum && dist.shasum) {
    return digest.shasum === dist.shasum
      ? null
      : `tarball shasum is ${dist.shasum}, this checkout packs ${digest.shasum}`;
  }
  return `the registry artifact carries no comparable tarball digest`;
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
/**
 * How long `--verify` waits for the registry to show what was just published,
 * and how often it asks. The registry accepts a publish before its read side
 * serves it: on the real v1.0.0 run, `publish` reported all four packages
 * written and `--verify`, seconds later in the next job, still saw two of them
 * as absent — while a direct fetch a few minutes on showed all four at
 * `latest`. A single question therefore does not distinguish "not published"
 * from "not visible yet", and treating the second as the first fails a release
 * that actually succeeded.
 *
 * Overridable so the tests can drive the same convergence without sleeping.
 */
const VERIFY_ATTEMPTS = Number(process.env.BASTRA_VERIFY_ATTEMPTS ?? 12);
const VERIFY_INTERVAL_MS = Number(process.env.BASTRA_VERIFY_INTERVAL_MS ?? 5000);

/** Block this process without a timer — the script is synchronous throughout. */
function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Wait until the registry shows `pkg` at this version AND serves it as
 * `latest`. Only ever converges toward success: it re-asks while the answer is
 * "not there", and the last answer is what gets reported. `published` is the
 * preflight's reading, so a set that is already visible costs no extra call.
 */
function awaitVisible(pkg, published) {
  let seen = published;
  for (let attempt = 1; ; attempt++) {
    if (seen) {
      const latest = fetchLatestTag(pkg.name);
      if (latest === pkg.version) return { ok: true };
      if (attempt >= VERIFY_ATTEMPTS) {
        return { ok: false, reason: `dist-tag latest is ${latest ?? "unset"}, expected ${pkg.version}` };
      }
    } else if (attempt >= VERIFY_ATTEMPTS) {
      return { ok: false, reason: "is not on the registry" };
    }
    sleepSync(VERIFY_INTERVAL_MS);
    seen = fetchPublished(pkg.name, pkg.version);
  }
}

console.log(`Release set v${version} — ${verifyOnly ? "verifying" : "publishing"} ${pkgs.length} package(s).`);

// #549: npm is the one side of a release that cannot be taken back, and it used
// to go first. Nothing is published until the release it belongs to already
// carries every other part of the set. Fail closed: without a tag there is
// nothing to check the set against, so there is nothing to publish either.
if (!verifyOnly) {
  const tag = readTag();
  if (!tag) {
    console.error(
      "error: refusing to publish without --tag <release tag>.\n" +
        "       npm `latest` must not move before the release it belongs to is complete,\n" +
        "       and without the tag that completeness cannot be checked.",
    );
    process.exit(1);
  }
  try {
    assertCompleteAssets(tag, process.env.GITHUB_REPOSITORY);
  } catch (err) {
    console.error(
      `error: ${err.message}\n` +
        `       Publishing now would move npm \`latest\` to a release whose downloads do\n` +
        `       not exist. Let the asset jobs finish and rerun — nothing has been published.`,
    );
    process.exit(1);
  }
  console.log(`Release ${tag} carries every required asset — safe to move npm latest.`);
}

// Preflight every target before the first publish, so a set that is already
// inconsistent fails without adding another immutable version to the mess.
const state = [];
for (const pkg of pkgs) {
  const published = fetchPublished(pkg.name, pkg.version);
  if (published) {
    // Only the publishing run decides whether to SKIP a package, and only it
    // has the built workspace `npm pack` needs; `--verify` runs from a plain
    // checkout in the promote job and stays on the manifest comparison.
    const reason = mismatchReason(pkg, published, verifyOnly ? null : packDigest(pkg.name));
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
    const seen = awaitVisible(pkg, published);
    if (seen.ok) {
      console.log(`✓ ${pkg.name}@${pkg.version} published and tagged latest`);
      continue;
    }
    console.error(`✗ ${pkg.name}@${pkg.version} ${seen.reason}`);
    failed = true;
  }
  process.exit(failed ? 1 : 0);
}

for (const { pkg, published } of state) {
  if (published) {
    console.log(`↷ ${pkg.name}@${pkg.version} already published — skipping (same manifest, same tarball digest)`);
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
