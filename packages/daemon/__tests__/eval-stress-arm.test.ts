/**
 * Arm-plumbing guard for the stress harness (#261, M0 gate "no silent arm
 * fallback").
 *
 * The bug this pins: `--hybrid` used to ask `search.hasEmbeddings()` while
 * nothing ever called `useEmbeddings()`, so the answer was always false and the
 * harness reported BM25 numbers under a hybrid label — `stress-report.md` even
 * printed "Search provider: BM25-only" for a run invoked with `--hybrid`. Every
 * measurement taken through that flag was mislabelled, and every gate that
 * rests on those measurements rested on nothing.
 *
 * The guard is the negative case, because it needs no Ollama and it is the one
 * that must never regress: with the provider unreachable the run ABORTS. A
 * harness that quietly measures the wrong arm is worse than one that refuses.
 *
 * Run: npx tsx --test packages/daemon/__tests__/eval-stress-arm.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "eval-stress.ts");
const FIXTURE_VAULT = resolve(import.meta.dirname, "..", "..", "eval", "fixtures", "eval-vault");

// #542: `typeof spawnSync<string>` isn't valid — spawnSync is overloaded, not
// generic, so its type can't take a type argument this way.
//
// #446: every spawned harness gets its own BASTRA_EVAL_RUNS_DIR. A successful
// run writes a real artifact, and without this a direct run of this file (no
// scripts/test-env.mjs) deposited it in ~/.bastra/eval-runs next to the cited
// baselines — 475 fixture runs had piled up there.
function runStress(args: string[], env: Record<string, string>): SpawnSyncReturns<string> & { runs: string[] } {
  const runsDir = mkdtempSync(join(tmpdir(), "bastra-stress-arm-runs-"));
  try {
    const res = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, BASTRA_VAULT_PATH: FIXTURE_VAULT, BASTRA_EVAL_RUNS_DIR: runsDir, ...env },
    });
    return Object.assign(res, { runs: readdirSync(runsDir) });
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
}

test("--hybrid aborts when the embedding provider is unreachable — it never reports BM25 as hybrid", () => {
  const res = runStress(["--slice", "anti", "--hybrid"], {
    // A port nothing listens on: the dense leg cannot be built.
    BASTRA_OLLAMA_URL: "http://127.0.0.1:1",
  });

  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  assert.notEqual(res.status, 0, "an unbuildable hybrid arm must fail the run");
  assert.match(out, /--hybrid/, "the failure names the flag that could not be honoured");
  assert.doesNotMatch(
    out,
    /Provider: \*\*BM25-only\*\*/,
    "a --hybrid run must never emit a BM25-only report — that is the silent fallback the M0 gate forbids",
  );
});

test("without --hybrid the harness reports BM25-only and says so in the report", () => {
  const res = runStress(["--slice", "anti"], {});

  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  assert.match(out, /Provider: \*\*BM25-only\*\*/, "the lexical run labels itself honestly");
  // #261: the candidate pool caps what any slice can retrieve, so it belongs
  // next to the numbers rather than in the reader's head.
  assert.match(out, /Candidate pool per slice/, "the production pool formula is stated in the report");
  assert.match(out, /max\(k\*4, 20\)/);
  assert.equal(res.runs.length, 1, "the run artifact lands in the test's own BASTRA_EVAL_RUNS_DIR (#446)");
});

test("--out refuses a path inside a git working tree", () => {
  // Same leak class as the tracked stress-report.md: the JSON carries every
  // paraphrase query and gold id, and --out resolves against the cwd, which is
  // normally this checkout. Refusing costs nothing — results.json in the run
  // artifact holds the identical data.
  const res = runStress(["--slice", "anti", "--out", "./should-never-exist.json"], {});

  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  assert.notEqual(res.status, 0, "writing vault-derived rows into the repo must fail the run");
  assert.match(out, /points inside a git working tree/);
  assert.match(out, /eval-runs/, "the message names where the data already is");
  assert.equal(
    existsSync(resolve(import.meta.dirname, "..", "..", "..", "should-never-exist.json")),
    false,
    "and nothing was written",
  );
});
