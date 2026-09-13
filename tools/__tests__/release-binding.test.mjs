/**
 * #548 — a publish run must be bound to the release it claims to publish.
 *
 * The gate proved one thing: that the staging release is still a draft (#524).
 * Nothing tied the run to WHICH commit that draft points at, and every job
 * checked out the workflow-dispatch ref. Draft `v1.0.0` staged on commit A,
 * `main` moved on to B, dispatch on B → npm packages, stub binaries and the
 * .mcpb bundle all built from B and attached to a release whose tag comes to
 * rest on A. Nothing went red, because nothing ever compared the two.
 *
 * Same class as #528, one level out: there the built `dist` was not proven to
 * belong to HEAD and the fix was a stamp the build writes and the command
 * verifies. Here the stamp is the commit the gate resolves from the draft: it
 * is handed to every job as `needs.gate.outputs.sha`, and a dispatch that has
 * drifted away from the draft is refused outright.
 *
 * The decision used to live in workflow YAML, where the only assertion
 * available is "the file says X". It now lives in
 * `scripts/verify-release-binding.mjs`, which takes `gh` from PATH — so the
 * tests below drive the real decision against a stub and require a REFUSAL. No
 * release, no tag and no registry is touched.
 *
 * Runner: node --test tools/__tests__/release-binding.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const BINDING = join(REPO, "scripts", "verify-release-binding.mjs");
const WORKFLOW = join(REPO, ".github", "workflows", "publish-npm.yml");
const VERSION = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/**
 * A stub `gh`.
 *  - `release view <tag> --json isDraft,…` → $DRAFT_JSON (exit $DRAFT_STATUS)
 *  - `api repos/<r>/commits/<ref> --jq .sha` → $RESOLVED_SHA
 */
const GH_STUB = `#!/usr/bin/env bash
echo "gh $*" >> "$GH_LOG"
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  printf '%s\\n' "\${DRAFT_JSON:-}"
  exit "\${DRAFT_STATUS:-0}"
fi
if [ "$1" = "api" ]; then printf '%s\\n' "\${RESOLVED_SHA:-}"; exit 0; fi
exit 0
`;

/** Runs the gate script with a stubbed `gh` on PATH and nothing else from the host. */
async function runGate(env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-release-548-"));
  try {
    const bin = join(dir, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "gh"), GH_STUB, { mode: 0o755 });
    const ghLog = join(dir, "gh.log");
    const outputs = join(dir, "outputs");
    await writeFile(ghLog, "");
    await writeFile(outputs, "");
    const child = spawn(process.execPath, [BINDING], {
      cwd: REPO,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        GH_LOG: ghLog,
        GITHUB_OUTPUT: outputs,
        GITHUB_REPOSITORY: "n0mad-ai/bastra-recall",
        DRY_RUN: "false",
        TAG: `v${VERSION}`,
        GITHUB_SHA: SHA_A,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const code = await new Promise((r) => child.on("close", r));
    return {
      code,
      out,
      gh: await readFile(ghLog, "utf8"),
      outputs: await readFile(outputs, "utf8"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const draft = (overrides = {}) =>
  JSON.stringify({
    isDraft: true,
    targetCommitish: SHA_A,
    tagName: `v${VERSION}`,
    ...overrides,
  });

test("#548 gate: a dispatch on a commit the draft does not point at is refused", async () => {
  // The exact drift the issue describes: draft staged on A, `main` moved to B,
  // dispatch runs on B. Everything built here would be B's code under A's tag.
  const { code, out, outputs } = await runGate({ DRAFT_JSON: draft(), GITHUB_SHA: SHA_B });
  assert.notEqual(code, 0, `a diverged dispatch was allowed to publish:\n${out}`);
  assert.match(out, new RegExp(SHA_A));
  assert.match(out, new RegExp(SHA_B));
  assert.ok(
    !outputs.includes("publish=true"),
    `the gate still authorised publishing:\n${outputs}`,
  );
});

test("#548 gate: the dispatch commit is accepted only when it IS the draft's commit", async () => {
  const { code, out, outputs } = await runGate({ DRAFT_JSON: draft() });
  assert.equal(code, 0, out);
  assert.match(outputs, /publish=true/);
  assert.match(outputs, new RegExp(`tag=v${VERSION.replace(/\./g, "\\.")}`));
  // The resolved commit is handed downstream, so every job builds this one tree
  // even if the branch keeps moving during the run.
  assert.match(outputs, new RegExp(`sha=${SHA_A}`));
});

test("#548 gate: a branch target is resolved to a commit before it is compared", async () => {
  // `--target main` records the branch NAME. A branch is not a commit, so it is
  // resolved once and the resolved commit is what the run is bound to.
  const ok = await runGate({
    DRAFT_JSON: draft({ targetCommitish: "main" }),
    RESOLVED_SHA: SHA_A,
  });
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.gh, /gh api repos\/n0mad-ai\/bastra-recall\/commits\/main/);
  assert.match(ok.outputs, new RegExp(`sha=${SHA_A}`));

  const drifted = await runGate({
    DRAFT_JSON: draft({ targetCommitish: "main" }),
    RESOLVED_SHA: SHA_B,
  });
  assert.notEqual(drifted.code, 0, `a branch that moved away was accepted:\n${drifted.out}`);
});

test("#548 gate: a staging release that is no longer a draft is refused", async () => {
  const { code, out } = await runGate({ DRAFT_JSON: draft({ isDraft: false }) });
  assert.notEqual(code, 0, `a public release was published over:\n${out}`);
  assert.match(out, /is not a draft/);
});

test("#548 gate: a tag whose version the tree does not carry is refused", async () => {
  // Draft tagged v99.0.0 on a commit whose package.json still says something
  // else: npm would get that other version, GitHub would tag it v99.0.0.
  const { code, out, outputs } = await runGate({
    TAG: "v99.0.0",
    DRAFT_JSON: draft({ tagName: "v99.0.0" }),
  });
  assert.notEqual(code, 0, `a tag/version mismatch was published:\n${out}`);
  assert.match(out, /package\.json/);
  assert.match(out, /v99\.0\.0/);
  assert.ok(!outputs.includes("publish=true"));
});

test("#548 gate: every published package's version is checked, not only the root's", async () => {
  // One release is one version everywhere; bump.mjs keeps them in lockstep and
  // the gate is where a hand-edited tree stops being publishable.
  const source = await readFile(BINDING, "utf8");
  for (const pkg of [
    "packages/core",
    "packages/statusline",
    "packages/daemon",
    "packages/bastra-recall",
  ]) {
    assert.ok(source.includes(`${pkg}/package.json`), `${pkg} is outside the version check`);
  }
});

test("#548 gate: a rehearsal needs no release and authorises nothing", async () => {
  const { code, out, gh, outputs } = await runGate({
    DRY_RUN: "true",
    TAG: "",
    GITHUB_SHA: SHA_B,
  });
  assert.equal(code, 0, out);
  assert.match(outputs, /publish=false/);
  assert.equal(gh.trim(), "", `a rehearsal talked to GitHub:\n${gh}`);
});

test("#548 workflow (regression guard, not the acceptance test): every job builds the gate's commit", async () => {
  const yml = await readFile(WORKFLOW, "utf8");
  const names = ["stub", "publish", "desktop-extension", "installer-scripts", "promote"];
  const starts = names.map((n) => ({ n, at: yml.indexOf(`\n  ${n}:`) }));
  for (const { n, at } of starts) {
    assert.ok(at > 0, `job ${n} disappeared from the publish workflow`);
    const next = starts.map((s) => s.at).filter((x) => x > at);
    const block = yml.slice(at, next.length ? Math.min(...next) : yml.length);
    assert.ok(
      block.includes("ref: ${{ needs.gate.outputs.sha }}"),
      `job ${n} checks out the dispatch ref instead of the commit the gate resolved`,
    );
  }
});
