/**
 * #524 — the stable release recipe must not create a prerelease, and npm
 * publication of the four-package set must be resumable.
 *
 * Two halves of one failure:
 *
 * 1. `scripts/bump.mjs` printed `gh release create … --prerelease` for EVERY
 *    version. The publish workflow publishes npm under `latest` on any release,
 *    while the Homebrew tap updater and both one-click installers read GitHub
 *    `/releases/latest`, which excludes prereleases — so following the printed
 *    command for 1.0.0 would have put npm on 1.0.0 and left every non-developer
 *    install path on 0.9.2. A stable version now gets a stable command, and the
 *    staging object is a DRAFT: `--latest=false` only held `/releases/latest`
 *    back, while the release page and the tag were public from creation and
 *    stayed that way through every asset job and a still-failable npm publish.
 *    A draft has no page and no tag; both come into existence in `promote`,
 *    after the whole set is verified. A draft fires no release event either, so
 *    the workflow is started explicitly with the draft's tag instead.
 *
 * 2. Four independent `npm publish` steps against an immutable registry: a
 *    failure in the third left the first two published, and the rerun died on
 *    the first one. `scripts/publish-release-set.mjs` preflights every target,
 *    skips a package only after verifying the published artifact is this
 *    release — name, version, internal pins AND tarball digest, because another
 *    commit can match every field of the manifest and still ship other bytes —
 *    and publishes the rest with the unscoped wrapper last.
 *
 * The publish half runs against a stub `npm` on PATH — no registry is touched,
 * nothing is published, and the assertions are on which publishes the script
 * would have issued, in which order.
 *
 * Runner: node --test tools/__tests__/release-set.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const BUMP = join(REPO, "scripts", "bump.mjs");
const PUBLISH = join(REPO, "scripts", "publish-release-set.mjs");
const WORKFLOW = join(REPO, ".github", "workflows", "publish-npm.yml");
const VERSION = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;

/* ------------------------------------------------------------------ bump.mjs */

/** `--dry-run` so no package.json is touched; the handoff is printed either way. */
async function bump(version) {
  const { stdout } = await execFileAsync(process.execPath, [BUMP, version, "--dry-run"], {
    cwd: REPO,
  });
  return stdout;
}

test("#524 bump.mjs: a stable version gets a stable release command", async () => {
  const out = await bump("99.0.0");
  assert.ok(
    !out.includes("--prerelease"),
    `stable bump still recommends a prerelease:\n${out}`,
  );
  assert.match(out, /gh release create v99\.0\.0 .*--generate-notes/);
});

test("#524 bump.mjs: the staging release is a draft, not a public page held back from Latest", async () => {
  const out = await bump("99.0.0");
  // A published release is a public page and a public tag from the moment it is
  // created — while the asset jobs are still running and npm can still fail.
  // Only a draft keeps the half-built set invisible.
  assert.match(out, /gh release create v99\.0\.0 --draft\b/);
  assert.ok(
    !out.includes("--latest=false"),
    `the staging release is still a published one merely held back from Latest:\n${out}`,
  );
});

test("#524 bump.mjs: the handoff starts the workflow itself, since a draft fires no release event", async () => {
  const out = await bump("99.0.0");
  assert.match(out, /gh workflow run publish-npm\.yml -f tag=v99\.0\.0 -f dry_run=false/);
});

test("#524 bump.mjs: a prerelease version still gets --prerelease, and is staged as a draft too", async () => {
  const out = await bump("99.0.0-rc.1");
  assert.match(out, /gh release create v99\.0\.0-rc\.1 --draft --prerelease/);
  assert.ok(!out.includes("--latest=false"), `a prerelease must not be staged as latest:\n${out}`);
});

/* ------------------------------------------------ publish-release-set.mjs */

/**
 * A stub `npm`.
 *  - `view <name>@<v> --json` → the manifest when $PUBLISHED lists <name>, else E404
 *  - `view <name> dist-tags.latest` → $LATEST_TAG when published
 *  - `pack --dry-run --json` → the digest this checkout would publish
 *  - `publish …` → success, logged
 *
 * $PUBLISHED_INTEGRITY is the registry artifact's tarball digest, $PACK_INTEGRITY
 * the candidate's — equal by default, so the two can be pulled apart to stand for
 * "same metadata, other bytes".
 */
const NPM_STUB = `#!/usr/bin/env bash
echo "npm $*" >> "$NPM_LOG"
is_published() {
  case " \${PUBLISHED:-} " in *" $1 "*) return 0 ;; esac
  return 1
}
if [ "$1" = "view" ]; then
  if [ "\${3:-}" = "dist-tags.latest" ]; then
    if is_published "$2"; then echo "\${LATEST_TAG:-$SET_VERSION}"; exit 0; fi
    exit 1
  fi
  spec="$2"
  name="\${spec%@*}"
  version="\${spec##*@}"
  if is_published "$name"; then
    pin="\${PUBLISHED_PIN:-$version}"
    dist="\${PUBLISHED_INTEGRITY-sha512-SAMEBYTES==}"
    dsum="\${PUBLISHED_SHASUM-abc123}"
    echo "{\\"name\\":\\"$name\\",\\"version\\":\\"$version\\",\\"dependencies\\":{\\"@bastra-recall/core\\":\\"$pin\\",\\"@bastra-recall/statusline\\":\\"$pin\\",\\"@bastra-recall/daemon\\":\\"$pin\\"},\\"dist\\":{\\"integrity\\":\\"$dist\\",\\"shasum\\":\\"$dsum\\"}}"
    exit 0
  fi
  echo "npm error code E404" >&2
  exit 1
fi
if [ "$1" = "pack" ]; then
  echo "[{\\"integrity\\":\\"\${PACK_INTEGRITY:-sha512-SAMEBYTES==}\\",\\"shasum\\":\\"abc123\\"}]"
  exit 0
fi
if [ "$1" = "publish" ]; then exit 0; fi
exit 0
`;

async function runPublish(args, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-release-524-"));
  try {
    const bin = join(dir, "bin");
    await mkdir(bin, { recursive: true });
    const log = join(dir, "npm.log");
    await writeFile(join(bin, "npm"), NPM_STUB, { mode: 0o755 });
    await writeFile(log, "");
    const child = spawn(process.execPath, [PUBLISH, ...args], {
      cwd: REPO,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        NPM_LOG: log,
        SET_VERSION: VERSION,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const code = await new Promise((resolve) => child.on("close", resolve));
    return { code, out, calls: await readFile(log, "utf8") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const publishedWorkspaces = (calls) =>
  calls
    .split("\n")
    .filter((l) => l.startsWith("npm publish"))
    .map((l) => /--workspace=(\S+)/.exec(l)?.[1]);

test("#524 publish set: a rerun after a partial publish skips what is already on the registry", async () => {
  const { code, out, calls } = await runPublish([], {
    PUBLISHED: "@bastra-recall/core @bastra-recall/statusline",
  });
  assert.equal(code, 0, `rerun failed on an already-published package:\n${out}`);
  assert.deepEqual(publishedWorkspaces(calls), [
    "@bastra-recall/daemon",
    "bastra-recall",
  ]);
});

test("#524 publish set: the unscoped wrapper is published last", async () => {
  const { code, calls, out } = await runPublish([], { PUBLISHED: "" });
  assert.equal(code, 0, out);
  const order = publishedWorkspaces(calls);
  assert.equal(order.length, 4);
  assert.equal(order.at(-1), "bastra-recall");
  assert.ok(
    order.indexOf("@bastra-recall/core") < order.indexOf("@bastra-recall/daemon"),
    `core must precede the daemon: ${order.join(", ")}`,
  );
});

test("#524 publish set: an already-published package that is NOT this release is a hard failure", async () => {
  const { code, out, calls } = await runPublish([], {
    PUBLISHED: "@bastra-recall/core @bastra-recall/statusline @bastra-recall/daemon",
    PUBLISHED_PIN: "0.0.1",
  });
  assert.notEqual(code, 0, `a foreign artifact was skipped silently:\n${out}`);
  assert.match(out, /NOT this release/);
  assert.deepEqual(publishedWorkspaces(calls), []);
});

test("#524 publish set: matching metadata with foreign bytes is NOT skipped as this release", async () => {
  // Another commit can produce the same name, the same version and the same
  // internal pins while shipping entirely different code. Metadata alone
  // therefore proves nothing; the tarball digest does.
  const { code, out, calls } = await runPublish([], {
    PUBLISHED: "@bastra-recall/core @bastra-recall/statusline @bastra-recall/daemon bastra-recall",
    PUBLISHED_INTEGRITY: "sha512-FROMANOTHERCOMMIT==",
    PACK_INTEGRITY: "sha512-THISCHECKOUT==",
  });
  assert.notEqual(code, 0, `foreign bytes were skipped as verified:\n${out}`);
  assert.match(out, /NOT this release/);
  assert.match(out, /integrity/);
  assert.deepEqual(publishedWorkspaces(calls), []);
});

test("#524 publish set: the skip is taken only after the candidate has actually been packed", async () => {
  const { code, out, calls } = await runPublish([], {
    PUBLISHED: "@bastra-recall/core",
  });
  assert.equal(code, 0, out);
  assert.match(
    calls,
    /npm pack --dry-run --json --workspace=@bastra-recall\/core/,
    `the already-published package was skipped without comparing bytes:\n${calls}`,
  );
});

test("#524 publish set: a registry artifact without a comparable digest is not verified", async () => {
  const { code, out } = await runPublish([], {
    PUBLISHED: "@bastra-recall/core",
    PUBLISHED_INTEGRITY: "",
    PUBLISHED_SHASUM: "",
  });
  assert.notEqual(code, 0, `an unverifiable artifact was skipped as verified:\n${out}`);
  assert.match(out, /no comparable tarball digest/);
});

test("#524 publish set: --verify fails while any package of the set is missing", async () => {
  const { code, out } = await runPublish(["--verify"], {
    PUBLISHED: "@bastra-recall/core @bastra-recall/statusline @bastra-recall/daemon",
  });
  assert.notEqual(code, 0, `an incomplete set verified as complete:\n${out}`);
  assert.match(out, /bastra-recall@/);
});

test("#524 publish set: --verify fails while the registry still serves an older `latest`", async () => {
  const { code, out } = await runPublish(["--verify"], {
    PUBLISHED:
      "@bastra-recall/core @bastra-recall/statusline @bastra-recall/daemon bastra-recall",
    LATEST_TAG: "0.0.1",
  });
  assert.notEqual(code, 0, `a stale dist-tag verified as promoted:\n${out}`);
  assert.match(out, /dist-tag latest is 0\.0\.1/);
});

test("#524 publish set: --verify passes on a complete, promoted set and publishes nothing", async () => {
  const { code, out, calls } = await runPublish(["--verify"], {
    PUBLISHED:
      "@bastra-recall/core @bastra-recall/statusline @bastra-recall/daemon bastra-recall",
  });
  assert.equal(code, 0, out);
  assert.deepEqual(publishedWorkspaces(calls), []);
});

/* ------------------------------------------------------------- the workflow */

test("#524 workflow: the release set is published only after the whole set is verified", async () => {
  const yml = await readFile(WORKFLOW, "utf8");
  // The promotion must be gated on every job that contributes to the set —
  // npm, the stub binaries, the .mcpb bundle and the Finder entry points.
  const promote = yml.slice(yml.indexOf("\n  promote:"));
  assert.ok(promote.length > 0, "no promote job in the publish workflow");
  assert.match(promote, /needs: \[gate, stub, publish, desktop-extension, installer-scripts\]/);
  assert.match(promote, /publish-release-set\.mjs --verify/);
  // Publishing the draft is what creates the tag and the public page.
  assert.match(promote, /gh release edit "\$TAG" --draft=false --latest\b/);
  // And the old split-brain publish steps must be gone.
  assert.ok(
    !/npm publish --workspace=/.test(yml),
    "the workflow still publishes packages in independent, non-resumable steps",
  );
});

test("#524 workflow: nothing is driven by a public release event", async () => {
  const yml = await readFile(WORKFLOW, "utf8");
  // A `release:` trigger can only fire for a release that is already public —
  // page and tag — while the set is still being assembled. The run is started
  // explicitly against the staged draft instead.
  assert.ok(
    !/^\s{2}release:/m.test(yml),
    "the workflow still hangs off a public release event",
  );
  assert.ok(
    !/github\.event\.release/.test(yml),
    "the workflow still reads release-event data, so it needs a public release",
  );
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /tag:/);
});

test("#524 workflow: the gate refuses to run against a staging release that is not a draft", async () => {
  const yml = await readFile(WORKFLOW, "utf8");
  const gate = yml.slice(yml.indexOf("\n  gate:"), yml.indexOf("\n  stub:"));
  assert.ok(gate.length > 0, "no gate job in the publish workflow");
  assert.match(gate, /--json isDraft/);
  assert.match(gate, /is not a draft/);
  // Every job that attaches, publishes or promotes hangs off this decision.
  for (const job of ["stub", "publish", "desktop-extension", "installer-scripts", "promote"]) {
    assert.ok(
      new RegExp(`\\n  ${job}:`).test(yml),
      `job ${job} disappeared from the publish workflow`,
    );
  }
  assert.ok(
    yml.split("needs.gate.outputs.publish == 'true'").length - 1 >= 5,
    "not every publishing step is gated on the draft check",
  );
});
