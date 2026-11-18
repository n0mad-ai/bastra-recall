import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLintBaseline } from "../../scripts/lint-baseline-ref.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const workflow = { id: 123, path: ".github/workflows/ci.yml" };
const repo = "example/project";

function execute(cwd, program, args, env = {}) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr };
}

function git(root, ...args) {
  const result = execute(root, "git", args);
  assert.equal(result.status, 0, result.output);
  return result.stdout.trim();
}

async function history(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bastra-lint-anchor-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  await mkdir(join(root, "scripts"));
  for (const name of [
    "check-lint-baselines.mjs",
    "lint-baseline-ref.mjs",
    "lint-knip-contract.mjs",
    "lint-knip-findings.mjs",
  ]) {
    await copyFile(join(repository, "scripts", name), join(root, "scripts", name));
  }
  await mkdir(join(root, "node_modules"));
  await symlink(
    await realpath(join(repository, "node_modules", "typescript")),
    join(root, "node_modules", "typescript"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  await writeFile(join(root, ".lint-cycle-baseline.json"), "[]");
  await writeFile(join(root, "clone-baseline.json"), "{}");
  const baseline = (value) =>
    writeFile(
      join(root, "eslint-structure-baseline.json"),
      JSON.stringify({ schema: 2, functions: { "file:f/complexity": value } })
    );
  const commit = (name) => {
    git(root, "add", ".");
    git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", name);
    return git(root, "rev-parse", "HEAD");
  };
  await baseline(17);
  const a = commit("A: green");
  await baseline(18);
  const b = commit("B: expanded baseline, cancelled or red CI");
  await writeFile(join(root, "marker"), "C");
  const c = commit("C: another push, unchanged expanded baseline");
  return { root, a, b, c, commit };
}

function green(sha, number, changes = {}) {
  return {
    workflow_id: workflow.id,
    path: workflow.path,
    head_branch: "main",
    head_repository: { full_name: repo },
    event: "push",
    status: "completed",
    conclusion: "success",
    run_number: number,
    head_sha: sha,
    ...changes,
  };
}

function resolve(fixture, pages, changes = {}) {
  let requests = 0;
  const readGithub = (endpoint, paginate) => {
    requests += 1;
    if (requests === 1) {
      assert.equal(endpoint, `repos/${repo}/actions/workflows/ci.yml`);
      assert.equal(paginate, undefined);
      return workflow;
    }
    assert.equal(endpoint, `repos/${repo}/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=100`);
    assert.equal(paginate, true);
    return pages;
  };
  return resolveLintBaseline(
    {
      eventName: "push",
      event: {},
      ref: "refs/heads/main",
      sha: fixture.c,
      repository: repo,
      cwd: fixture.root,
      ...changes,
    },
    readGithub
  );
}

function guard(root, base) {
  return execute(root, process.execPath, ["scripts/check-lint-baselines.mjs"], {
    GITHUB_ACTIONS: "true",
    LINT_BASE_REF: base,
  });
}

test("S1: a second push cannot hide a baseline expansion behind a cancelled or red first push", async (t) => {
  const fixture = await history(t);
  // This is the old event.before comparison: C against B incorrectly succeeds.
  assert.equal(guard(fixture.root, fixture.b).status, 0);
  for (const conclusion of ["cancelled", "failure"]) {
    const anchor = resolve(fixture, [{ workflow_runs: [green(fixture.b, 2, { conclusion }), green(fixture.a, 1)] }]);
    assert.equal(anchor, fixture.a);
    const result = guard(fixture.root, anchor);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /new\/increased exceptions/);
  }
});

test("S1: a newer successful main run cannot anchor an older queued checkout", async (t) => {
  const fixture = await history(t);
  await writeFile(join(fixture.root, "marker"), "D: later main");
  const d = fixture.commit("D: later main");
  git(fixture.root, "checkout", "--detach", fixture.c);
  const anchor = resolve(fixture, [{ workflow_runs: [green(d, 4), green(fixture.a, 1)] }]);
  assert.equal(anchor, fixture.a);
  assert.equal(guard(fixture.root, anchor).status, 1);
});

test("S1: only completed successes of the exact CI workflow and repository on main are trusted", async (t) => {
  const fixture = await history(t);
  const invalid = [
    { workflow_id: 999 },
    { path: ".github/workflows/other-ci.yml" },
    { head_branch: "feature" },
    { head_repository: { full_name: "someone/fork" } },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "cancelled" },
    { head_sha: "not-a-sha" },
    { run_number: "2" },
    { run_number: 0 },
  ];
  for (const fields of invalid) {
    assert.throws(() => resolve(fixture, [{ workflow_runs: [green(fixture.b, 2, fields)] }]), /No successful ancestor/);
  }
  assert.equal(resolve(fixture, [{ workflow_runs: [] }, { workflow_runs: [green(fixture.a, 1)] }]), fixture.a);
  assert.equal(
    resolve(fixture, [{ workflow_runs: [green(fixture.a, 1, { event: "workflow_dispatch" })] }], {
      eventName: "workflow_dispatch",
    }),
    fixture.a
  );
});

test("S1: runs are selected by workflow run order, not response array order", async (t) => {
  const fixture = await history(t);
  assert.equal(resolve(fixture, [{ workflow_runs: [green(fixture.a, 1), green(fixture.b, 2)] }]), fixture.b);
});

test("S1: missing, malformed or unfetched successful anchors fail closed", async (t) => {
  const fixture = await history(t);
  assert.throws(() => resolve(fixture, [{ workflow_runs: [] }]), /No successful ancestor/);
  assert.throws(() => resolve(fixture, [{ bad: [] }]), /Invalid successful CI run response/);
  assert.throws(
    () => resolve(fixture, [{ workflow_runs: [green("f".repeat(40), 2)] }]),
    /Cannot verify lint baseline ancestry/
  );
  assert.throws(() => resolve(fixture, [], { sha: fixture.a }), /checkout does not match/);
});

test("S1: pull requests use the merge base without consulting workflow runs", async (t) => {
  const fixture = await history(t);
  const neverGithub = () => assert.fail("a pull request must not require actions API access");
  const options = {
    eventName: "pull_request",
    event: { pull_request: { base: { sha: fixture.a } } },
    sha: fixture.c,
    cwd: fixture.root,
  };
  assert.equal(resolveLintBaseline(options, neverGithub), fixture.a);
  assert.throws(
    () => resolveLintBaseline({ ...options, event: { pull_request: { base: { sha: "HEAD^" } } } }, neverGithub),
    /Invalid pull-request base/
  );
});

test("S1: unknown events, refs and workflow identities cannot choose a fallback anchor", async (t) => {
  const fixture = await history(t);
  assert.throws(() => resolve(fixture, [], { eventName: "schedule" }), /requires a main run/);
  assert.throws(() => resolve(fixture, [], { ref: "refs/heads/feature" }), /requires a main run/);
  const options = {
    eventName: "push",
    event: {},
    ref: "refs/heads/main",
    sha: fixture.c,
    repository: repo,
    cwd: fixture.root,
  };
  assert.throws(() => resolveLintBaseline(options, () => ({ ...workflow, path: "other.yml" })), /workflow identity/);
  assert.throws(
    () =>
      resolveLintBaseline(options, () => {
        throw new Error("API denied");
      }),
    /API denied/
  );
});

test("S1: the CLI emits one validated SHA for GitHub outputs, and missing CI refs cannot disable the guard", async (t) => {
  const fixture = await history(t);
  const eventPath = join(fixture.root, "event.json");
  await writeFile(eventPath, JSON.stringify({ pull_request: { base: { sha: fixture.a } } }));
  const result = execute(fixture.root, process.execPath, ["scripts/lint-baseline-ref.mjs"], {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_SHA: fixture.c,
  });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.stdout, `sha=${fixture.a}\n`);
  assert.equal(result.stderr, "");
  const missing = guard(fixture.root, "");
  assert.equal(missing.status, 1);
  assert.match(missing.output, /requires an explicit trusted LINT_BASE_REF/);
});

test("S1: CI passes the resolved anchor to the ratchet instead of the previous push", async () => {
  const source = await readFile(join(repository, ".github/workflows/ci.yml"), "utf8");
  assert.match(source, /actions: read/);
  assert.match(source, /id: lint-baseline/);
  assert.match(source, /node scripts\/lint-baseline-ref\.mjs >> "\$GITHUB_OUTPUT"/);
  assert.match(source, /LINT_BASE_REF: \$\{\{ steps\.lint-baseline\.outputs\.sha \}\}/);
  assert.doesNotMatch(source, /github\.event\.before|HEAD\^/);
});
