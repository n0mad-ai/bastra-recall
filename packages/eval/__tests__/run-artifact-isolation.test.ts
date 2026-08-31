/**
 * Test runs must not write into the real artifact directory (#420).
 *
 * Both artifact writers resolve their output as
 * `BASTRA_EVAL_RUNS_DIR ?? ~/.bastra/eval-runs` — `goldset-run.ts` and
 * `packages/daemon/scripts/stress-artifact.ts`. Without a redirect a suite pass
 * deposits fixture runs beside the registered baselines: measured on one
 * `npm test`, two fresh directories appeared, both with
 * `vault_path: packages/eval/fixtures/eval-vault`, in a directory that had grown
 * past 490 entries. The M0 baseline and the M1 reference runs live there and are
 * cited by path from `m1-tolerances.json`, so a broad cleanup could delete
 * evidence a release condition depends on.
 *
 * The assertion runs in a CHILD process rather than against this process's own
 * environment on purpose: the guarantee belongs to `scripts/test-env.mjs`, and a
 * test that only read `process.env` here would pass or fail depending on whether
 * someone ran the file through the suite harness or on its own.
 *
 * Run: npx tsx --test packages/eval/__tests__/run-artifact-isolation.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

/**
 * What a child sees for `name` after `scripts/test-env.mjs` has been imported.
 *
 * `NODE_TEST_CONTEXT` is stripped from the child on purpose: the same module
 * caps string writes to stdout under that variable (#414, so application output
 * cannot corrupt the runner's frame pipe), and an inherited one would swallow
 * the very line this helper reads back.
 */
function envUnderTestHarness(name: string, preset?: string): string {
  const env = { ...process.env, [name]: preset ?? "" };
  delete env.NODE_TEST_CONTEXT;
  return execFileSync(
    process.execPath,
    ["--import", "./scripts/test-env.mjs", "-e", `process.stdout.write(String(process.env.${name}))`],
    { cwd: repoRoot, encoding: "utf8", env },
  ).trim();
}

test("the test harness redirects run artifacts away from the real directory (#420)", () => {
  const dir = envUnderTestHarness("BASTRA_EVAL_RUNS_DIR");
  assert.notEqual(dir, "undefined", "test-env.mjs must fill in a default");
  assert.ok(dir.startsWith(tmpdir()), `expected a tmpdir, got ${dir}`);
  assert.ok(
    !dir.startsWith(join(homedir(), ".bastra", "eval-runs")),
    "the registered baselines live there — a suite pass must never write into it",
  );
});

test("a deliberately chosen artifact directory is left alone (#420)", () => {
  // Same contract as BASTRA_LOG_PATH above it: the harness fills in a default,
  // it does not override a caller who chose one. A real measurement run that
  // redirects its output on purpose must keep that choice.
  const chosen = join(tmpdir(), "bastra-deliberate-eval-runs");
  assert.equal(envUnderTestHarness("BASTRA_EVAL_RUNS_DIR", chosen), chosen);
});
