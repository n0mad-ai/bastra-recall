#!/usr/bin/env node
/**
 * verify-release-binding.mjs — bind one publish run to one release (#548).
 *
 *   node scripts/verify-release-binding.mjs      # reads TAG / DRY_RUN from env
 *
 * The gate used to check a single thing: that the staging release is still a
 * DRAFT (#524). Nothing tied the run to WHICH commit that draft points at. Every
 * job then checked out the workflow-dispatch ref — `main`, whatever `main`
 * happened to be at dispatch time. So a draft `v1.0.0` created on commit A and
 * dispatched after `main` had moved to B produced npm packages, stub binaries,
 * a .mcpb bundle and checksums built from B, all attached to a release whose tag
 * would come to rest on A. Every existing check stayed green, because no check
 * ever compared the two.
 *
 * This is #528 one level out: there the built `dist` was not proven to belong to
 * HEAD, and the fix was a stamp the build writes and the command verifies. Here
 * the stamp is the commit the gate resolves from the draft itself: it is written
 * to `GITHUB_OUTPUT` as `sha`, every job checks out exactly that commit, and a
 * dispatch whose ref has drifted away from the draft is refused outright rather
 * than quietly building something else.
 *
 * Checks, in order, for a publishing run:
 *   1. a tag was given
 *   2. the release exists and is still a draft (nothing public yet)
 *   3. its `targetCommitish` resolves to a commit
 *   4. that commit IS the commit this dispatch is running on
 *   5. the `package.json` version at that commit matches the tag
 *
 * A rehearsal (`dry_run` != "false") publishes nothing and needs no release, so
 * it stops after step 0 and simply reports the commit it is building.
 *
 * `gh` is taken from PATH, so the whole decision is exercisable against a stub.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every package.json that carries the release version. */
const VERSIONED = [
  "package.json",
  "packages/core/package.json",
  "packages/statusline/package.json",
  "packages/daemon/package.json",
  "packages/bastra-recall/package.json",
];

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function emit(pairs) {
  const text = Object.entries(pairs)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  console.log(text);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${text}\n`);
}

function gh(args) {
  const res = spawnSync("gh", args, { encoding: "utf8" });
  if (res.status !== 0) {
    die(
      `gh ${args.join(" ")} failed (${res.status}):\n` +
        `${`${res.stdout ?? ""}${res.stderr ?? ""}`.trim()}`,
    );
  }
  return (res.stdout ?? "").trim();
}

const tag = (process.env.TAG ?? "").trim();
const dryRun = (process.env.DRY_RUN ?? "true").trim() !== "false";
const repo = (process.env.GITHUB_REPOSITORY ?? "").trim();
const dispatchSha = (process.env.GITHUB_SHA ?? "").trim();

if (dryRun) {
  // A rehearsal attaches nothing, publishes nothing and promotes nothing. It
  // still pins the commit, so all of its jobs build the same tree even if the
  // branch moves mid-run.
  console.log("Rehearsal — building and testing only, nothing is published.");
  emit({ publish: "false", tag: "", sha: dispatchSha });
  process.exit(0);
}

if (!tag) die("dry_run=false needs the tag of the staged draft release");
if (!repo) die("GITHUB_REPOSITORY is not set — cannot resolve the draft release");
if (!dispatchSha) die("GITHUB_SHA is not set — cannot prove which commit this run builds");

const raw = gh([
  "release",
  "view",
  tag,
  "--repo",
  repo,
  "--json",
  "isDraft,targetCommitish,tagName",
]);
let release;
try {
  release = JSON.parse(raw);
} catch {
  die(`could not read the release metadata for ${tag}:\n${raw}`);
}

if (release.tagName && release.tagName !== tag) {
  die(`gh resolved ${tag} to a release tagged ${release.tagName}`);
}

// A published release here would mean the page and the tag are already public
// while the set is still being built — exactly the gate #524 is about.
if (release.isDraft !== true) {
  die(`${tag} is not a draft — the staging release must stay private until promote`);
}

const target = String(release.targetCommitish ?? "").trim();
if (!target) die(`${tag} has no target commit — the draft is not bound to anything`);

// `--target` may have been given a branch name rather than a commit. A branch
// is not a commit: it is whatever the branch points at right now, so it is
// resolved once, here, and the resolved commit is what the whole run uses.
const targetSha = /^[0-9a-f]{40}$/i.test(target)
  ? target.toLowerCase()
  : gh(["api", `repos/${repo}/commits/${target}`, "--jq", ".sha"]).toLowerCase();

if (!/^[0-9a-f]{40}$/.test(targetSha)) {
  die(`could not resolve the target of ${tag} ('${target}') to a commit`);
}

if (targetSha !== dispatchSha.toLowerCase()) {
  die(
    `${tag} points at ${targetSha}, but this dispatch runs on ${dispatchSha.toLowerCase()}.\n` +
      `       Everything this run builds would come from the dispatch ref while the\n` +
      `       published tag would come to rest on the draft's commit. Re-dispatch the\n` +
      `       workflow on a ref that points at ${targetSha}, or re-stage the draft on\n` +
      `       the commit you actually want to release.`,
  );
}

// The tag names a version; the tree has to agree. A draft `v1.0.0` on a commit
// whose package.json still says 0.9.2 would publish 0.9.2 to npm and tag it
// v1.0.0 on GitHub.
const want = tag.replace(/^v/, "");
for (const rel of VERSIONED) {
  let json;
  try {
    json = JSON.parse(readFileSync(resolve(repoRoot, rel), "utf8"));
  } catch (err) {
    die(`could not read ${rel} at ${targetSha}: ${err.message}`);
  }
  if (json.version !== want) {
    die(`${rel} at ${targetSha} is version ${json.version}, but the draft is tagged ${tag}`);
  }
}

console.log(`Publishing the staged draft ${tag} from ${targetSha}.`);
emit({ publish: "true", tag, sha: targetSha });
