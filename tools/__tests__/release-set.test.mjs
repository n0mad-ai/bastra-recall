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
 *    install path on 0.9.2. A stable version now gets a stable command, staged
 *    with `--latest=false` so the tap's source only moves after the `promote`
 *    job has verified the whole set.
 *
 * 2. Four independent `npm publish` steps against an immutable registry: a
 *    failure in the third left the first two published, and the rerun died on
 *    the first one. `scripts/publish-release-set.mjs` preflights every target,
 *    skips a package only after verifying the published artifact is this
 *    release, and publishes the rest with the unscoped wrapper last.
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

test("#524 bump.mjs: the stable release is staged, not made Latest on creation", async () => {
  const out = await bump("99.0.0");
  // /releases/latest is what the Homebrew tap updater consumes — it may only
  // move once the workflow's promote job has verified the complete set.
  assert.match(out, /--latest=false/);
});

test("#524 bump.mjs: a prerelease version still gets --prerelease", async () => {
  const out = await bump("99.0.0-rc.1");
  assert.match(out, /gh release create v99\.0\.0-rc\.1 --prerelease/);
  assert.ok(!out.includes("--latest=false"), `a prerelease must not be staged as latest:\n${out}`);
});

/* ------------------------------------------------ publish-release-set.mjs */

/**
 * A stub `npm`.
 *  - `view <name>@<v> --json` → the manifest when $PUBLISHED lists <name>, else E404
 *  - `view <name> dist-tags.latest` → $LATEST_TAG when published
 *  - `publish …` → success, logged
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
    echo "{\\"name\\":\\"$name\\",\\"version\\":\\"$version\\",\\"dependencies\\":{\\"@bastra-recall/core\\":\\"$pin\\",\\"@bastra-recall/statusline\\":\\"$pin\\",\\"@bastra-recall/daemon\\":\\"$pin\\"}}"
    exit 0
  fi
  echo "npm error code E404" >&2
  exit 1
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

test("#524 workflow: /releases/latest moves only after the whole release set is verified", async () => {
  const yml = await readFile(WORKFLOW, "utf8");
  // The promotion must be gated on every job that contributes to the set —
  // npm, the stub binaries, the .mcpb bundle and the Finder entry points.
  const promote = yml.slice(yml.indexOf("\n  promote:"));
  assert.ok(promote.length > 0, "no promote job in the publish workflow");
  assert.match(promote, /needs: \[stub, publish, desktop-extension, installer-scripts\]/);
  assert.match(promote, /publish-release-set\.mjs --verify/);
  assert.match(promote, /gh release edit "\$TAG" --latest/);
  // And the old split-brain publish steps must be gone.
  assert.ok(
    !/npm publish --workspace=/.test(yml),
    "the workflow still publishes packages in independent, non-resumable steps",
  );
});
