/**
 * #549 — npm `latest` must be the LAST thing a release moves, not the first.
 *
 * `publish-release-set.mjs` sent every package straight out with `--tag latest`
 * while the desktop extension, the Finder installers and the completeness of the
 * set were still unverified. A failure in one of those later jobs left GitHub
 * hidden as a draft — and npm users already holding the new, incomplete set:
 * `npm install -g bastra-recall` handed them a version whose downloads did not
 * exist. That is the half of #524 that was never finished.
 *
 * The npm side cannot be fixed with a staging dist-tag promoted afterwards: npm
 * OIDC trusted publishing issues publish-scoped credentials, `npm dist-tag add`
 * is rejected with them, and `npm stage approve` needs 2FA. Promotion would mean
 * a long-lived npm token back in the release path. So the irreversible step is
 * moved to the end instead, and given a precondition it can actually check: the
 * publish refuses while the release it belongs to is missing any required asset.
 *
 * The tests drive that decision against stubbed `gh` and `npm` — a late job that
 * has not delivered must PUBLISH NOTHING — and the partial-failure case, where a
 * run dies mid-set and the documented install path must be untouched. Nothing is
 * published and no registry is contacted.
 *
 * Runner: node --test tools/__tests__/release-latest-last.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { REQUIRED_ASSETS, missingAssets } from "../../scripts/release-assets.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PUBLISH = join(REPO, "scripts", "publish-release-set.mjs");
const VERSION = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;

/** What a complete release carries — the real list, plus the versioned bundle. */
const COMPLETE_ASSETS = [
  ...REQUIRED_ASSETS,
  `bastra-recall-${VERSION}.mcpb`,
  `bastra-recall-${VERSION}.mcpb.sha256`,
];

/** A stub `gh`: `release view <tag> --json assets --jq …` → $ASSETS, one per line. */
const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "\${ASSETS:-}"
`;

/**
 * A stub `npm` — nothing is published yet, and $FAIL_PUBLISH makes a chosen
 * workspace's publish die so a set can be stopped part-way.
 */
const NPM_STUB = `#!/usr/bin/env bash
echo "npm $*" >> "$NPM_LOG"
if [ "$1" = "view" ]; then
  if [ "\${3:-}" = "dist-tags.latest" ]; then exit 1; fi
  echo "npm error code E404" >&2
  exit 1
fi
if [ "$1" = "pack" ]; then
  echo "[{\\"integrity\\":\\"sha512-SAMEBYTES==\\",\\"shasum\\":\\"abc123\\"}]"
  exit 0
fi
if [ "$1" = "publish" ]; then
  for w in \${FAIL_PUBLISH:-}; do
    case " $* " in *" --workspace=$w "*) echo "npm error 403" >&2; exit 1 ;; esac
  done
  exit 0
fi
exit 0
`;

async function runPublish(args, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-release-549-"));
  try {
    const bin = join(dir, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "gh"), GH_STUB, { mode: 0o755 });
    await writeFile(join(bin, "npm"), NPM_STUB, { mode: 0o755 });
    const npmLog = join(dir, "npm.log");
    await writeFile(npmLog, "");
    const child = spawn(process.execPath, [PUBLISH, ...args], {
      cwd: REPO,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        NPM_LOG: npmLog,
        GITHUB_REPOSITORY: "n0mad-ai/bastra-recall",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const code = await new Promise((r) => child.on("close", r));
    return { code, out, npm: await readFile(npmLog, "utf8") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const publishedWorkspaces = (calls) =>
  calls
    .split("\n")
    .filter((l) => l.startsWith("npm publish"))
    .map((l) => /--workspace=(\S+)/.exec(l)?.[1]);

test("#549 release assets: the required set covers binaries, checksums, extension and installers", () => {
  assert.deepEqual(missingAssets(COMPLETE_ASSETS), []);
  // Every single omission has to be named — a release is not "mostly" complete.
  for (const name of REQUIRED_ASSETS) {
    assert.deepEqual(missingAssets(COMPLETE_ASSETS.filter((a) => a !== name)), [name]);
  }
  assert.deepEqual(missingAssets(COMPLETE_ASSETS.filter((a) => !a.endsWith(".mcpb"))), [
    "*.mcpb",
  ]);
});

test("#549 publish set: a late job that has not delivered its asset stops the publish", async () => {
  // The desktop-extension job failed: the bundle is not attached. Under the old
  // order npm `latest` had already moved by this point.
  const { code, out, npm } = await runPublish(["--tag", `v${VERSION}`], {
    ASSETS: COMPLETE_ASSETS.filter((a) => !a.endsWith(".mcpb")).join("\n"),
  });
  assert.notEqual(code, 0, `an incomplete release was published to npm:\n${out}`);
  assert.match(out, /missing/i);
  assert.match(out, /mcpb/);
  assert.deepEqual(publishedWorkspaces(npm), [], `npm latest moved anyway:\n${npm}`);
});

test("#549 publish set: a missing installer script stops the publish just as hard", async () => {
  const { code, out, npm } = await runPublish(["--tag", `v${VERSION}`], {
    ASSETS: COMPLETE_ASSETS.filter((a) => a !== "Install.Bastra.command").join("\n"),
  });
  assert.notEqual(code, 0, out);
  assert.match(out, /Install\.Bastra\.command/);
  assert.deepEqual(publishedWorkspaces(npm), [], `npm latest moved anyway:\n${npm}`);
});

test("#549 publish set: publishing without the release tag is refused, not guessed", async () => {
  // Fail closed: with no tag there is nothing to check completeness against, so
  // there is nothing safe to publish either.
  const { code, out, npm } = await runPublish([], { ASSETS: COMPLETE_ASSETS.join("\n") });
  assert.notEqual(code, 0, `the asset gate was skipped for want of a tag:\n${out}`);
  assert.match(out, /--tag/);
  assert.deepEqual(publishedWorkspaces(npm), []);
});

test("#549 publish set: a complete release does publish, wrapper last", async () => {
  const { code, out, npm } = await runPublish(["--tag", `v${VERSION}`], {
    ASSETS: COMPLETE_ASSETS.join("\n"),
  });
  assert.equal(code, 0, out);
  assert.deepEqual(publishedWorkspaces(npm), [
    "@bastra-recall/core",
    "@bastra-recall/statusline",
    "@bastra-recall/daemon",
    "bastra-recall",
  ]);
});

test("#549 publish set: a publish that dies part-way leaves the documented install path alone", async () => {
  // This is the partial-failure case. `npm install -g bastra-recall` is the
  // documented entry point and the unscoped wrapper is published LAST — so a run
  // that dies in the middle has not moved it, and that install still resolves to
  // the previous release, whose exact pins point at packages that are still on
  // the registry. Moving a dist-tag is repeatable where a publish is not, so the
  // rerun from #524 finishes the rest.
  const { code, out, npm } = await runPublish(["--tag", `v${VERSION}`], {
    ASSETS: COMPLETE_ASSETS.join("\n"),
    FAIL_PUBLISH: "@bastra-recall/daemon",
  });
  assert.notEqual(code, 0, `a failed publish reported success:\n${out}`);
  assert.ok(
    !publishedWorkspaces(npm).includes("bastra-recall"),
    `the unscoped wrapper's latest moved despite a failed set:\n${npm}`,
  );
  assert.match(out, /Rerun this script/);
});

test("#549 publish set: --verify still needs no tag and still publishes nothing", async () => {
  // The promote job runs this from a plain checkout; it must not have acquired a
  // dependency on the asset check, which promote runs as its own step.
  const { code, npm } = await runPublish(["--verify"], {});
  assert.notEqual(code, 0); // the stub registry has nothing published
  assert.deepEqual(publishedWorkspaces(npm), []);
});
