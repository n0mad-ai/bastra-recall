/**
 * Baselines and run artifacts for the stress harness (#261, M0 gate
 * "Label-Shuffle-Null und Kontrollarm vorhanden").
 *
 * These two are what give a headline number a scale. "45.2% Recall@3" is
 * unreadable on its own: the control arm says what the metric prints with no
 * retrieval signal at all, and the label-shuffle null says what it prints when
 * the queries and the gold ids are both real but no longer belong together.
 * Both must be seeded, or they cannot be cited beside the number they qualify.
 *
 * Run: npx tsx --test packages/daemon/__tests__/stress-baselines.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeControlRecaller, seededShuffle, seededDerangement, seededRandom } from "../scripts/stress-arm.js";
import { runCrossMemory, shuffleCrossLabels, shuffleParaphrasedLabels } from "../scripts/stress-slices.js";
import { computeHashes, hashVault, runDirFor, writeRunArtifact, type RunManifest } from "../scripts/stress-artifact.js";
import type { Vault } from "@bastra-recall/core";

const IDS = Array.from({ length: 20 }, (_, i) => `m${i}`);
const fakeVault = { list: () => IDS.map((id) => ({ fm: { id } })) } as unknown as Vault;

test("the seeded draw is reproducible and a real permutation", () => {
  assert.deepEqual(seededShuffle(IDS, 42), seededShuffle(IDS, 42), "same seed, same order");
  assert.notDeepEqual(seededShuffle(IDS, 42), seededShuffle(IDS, 43), "different seed, different order");
  assert.deepEqual([...seededShuffle(IDS, 42)].sort(), [...IDS].sort(), "nothing gained, nothing lost");
  assert.notDeepEqual(seededShuffle(IDS, 42), IDS, "and it actually moved");

  const draws = Array.from({ length: 5 }, () => seededRandom(7)());
  assert.equal(new Set(draws).size, 1, "the generator is a pure function of its seed");
});

test("the control arm ranks at random, respects k, and does not reuse one order for every query", async () => {
  const control = makeControlRecaller(fakeVault, 20260726);

  const a = await control("deploy staging", { k: 5 });
  assert.equal(a.length, 5, "k is honoured");
  assert.deepEqual(
    a.map((h) => h.score),
    [5, 4, 3, 2, 1],
    "scores descend so rank logic downstream behaves normally",
  );
  assert.deepEqual(await control("deploy staging", { k: 5 }), a, "same query, same ranking");

  // A single fixed order per run would quietly favour whatever gold ids sit
  // near its front — the permutation is drawn per query.
  const b = await control("something else entirely", { k: 5 });
  assert.notDeepEqual(b.map((h) => h.id), a.map((h) => h.id));
});

test("the label shuffle keeps every query and every gold id, and only breaks the pairing", () => {
  const cases = IDS.slice(0, 8).map((id, i) => ({ id, label: `l${i}`, paraphrases: [`q${i}`] }));
  const shuffled = shuffleParaphrasedLabels(cases, 20260726);

  assert.equal(shuffled.length, cases.length);
  assert.deepEqual(shuffled.map((c) => c.id).sort(), cases.map((c) => c.id).sort(), "same gold ids in play");
  assert.deepEqual(shuffled.map((c) => c.paraphrases), cases.map((c) => c.paraphrases), "queries untouched");
  assert.ok(
    shuffled.some((c, i) => c.id !== cases[i].id),
    "at least one pairing broke — a null that changed nothing tests nothing",
  );
  assert.deepEqual(shuffleParaphrasedLabels(cases, 20260726), shuffled, "seeded, so it is citable");
});

test("the cross shuffle moves whole expected sets between queries", () => {
  const cases = [
    { query: "a", expected: ["m1", "m2"] },
    { query: "b", expected: ["m3"] },
    { query: "c", expected: ["m4", "m5", "m6"] },
  ];
  const shuffled = shuffleCrossLabels(cases, 20260726);

  assert.deepEqual(shuffled.map((c) => c.query), ["a", "b", "c"], "queries stay put");
  assert.deepEqual(
    shuffled.flatMap((c) => c.expected).sort(),
    cases.flatMap((c) => c.expected).sort(),
    "the same ids remain in play",
  );
  // Sets travel intact: a query keeps a plausible cardinality instead of a
  // sample of loose ids.
  assert.deepEqual(
    shuffled.map((c) => c.expected.length).sort(),
    [1, 2, 3],
    "set sizes are preserved, only their owners change",
  );
});

test("the vault hash tracks the corpus, not the reading order", () => {
  const a = [{ fm: { id: "m1", updated: "2026-07-01" } }, { fm: { id: "m2", updated: "2026-07-02" } }];
  const reordered = [a[1], a[0]];
  assert.equal(hashVault(a), hashVault(reordered), "order of iteration is not identity");

  const edited = [{ fm: { id: "m1", updated: "2026-07-09" } }, a[1]];
  assert.notEqual(hashVault(a), hashVault(edited), "an edit that moved `updated` is a different corpus");

  const removed = [a[0]];
  assert.notEqual(hashVault(a), hashVault(removed), "a removal is a different corpus");
});

test("the run artifact records the raw output, and Maps survive the JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-eval-runs-"));
  const prev = process.env.BASTRA_EVAL_RUNS_DIR;
  process.env.BASTRA_EVAL_RUNS_DIR = dir;
  try {
    const manifest: RunManifest = {
      run_date: "2026-07-26T12:00:00.000Z",
      vault_path: "/tmp/vault",
      vault_size: 2,
      provider: "BM25-only",
      command: "node eval-stress.ts --slice all",
      hashes: computeHashes({
        mems: [{ fm: { id: "m1", updated: "2026-07-01" } }],
        provider: "BM25-only",
        config: { slices: ["anti"] },
        dataset: { cases: 1 },
      }),
      seed: 20260726,
    };

    assert.match(runDirFor(manifest), /2026-07-26-[0-9a-f]{12}$/, "one directory per run, dated and hashed");

    const out = await writeRunArtifact({
      manifest,
      stdout: "# report\nline two\n",
      stderr: "[stress] noise\n",
      // perMemory is a Map — JSON.stringify turns one into {} unless handled.
      results: { perMemory: new Map([["m1", { hits: 3, tests: 4 }]]) },
    });

    assert.equal(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")).seed, 20260726);
    assert.equal(await readFile(join(out, "stdout.txt"), "utf8"), "# report\nline two\n", "raw, not reconstructed");
    assert.equal(await readFile(join(out, "stderr.txt"), "utf8"), "[stress] noise\n");
    assert.match(await readFile(join(out, "command.txt"), "utf8"), /--slice all/);

    const results = JSON.parse(await readFile(join(out, "results.json"), "utf8"));
    assert.deepEqual(results.perMemory, { m1: { hits: 3, tests: 4 } }, "the Map is data, not an empty object");
  } finally {
    if (prev === undefined) delete process.env.BASTRA_EVAL_RUNS_DIR;
    else process.env.BASTRA_EVAL_RUNS_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("the label shuffle is a derangement — no case keeps its own gold", () => {
  // A fixed point is a pairing that was never broken, and it is scored as a
  // genuine hit. Fisher-Yates has one in expectation for ANY n, and at the
  // default seed the real 25-case fixture had exactly one — 4 of 100 null rows
  // carrying the true pairing, which read as ~4% against a true null near 0.5%.
  for (const n of [2, 3, 10, 25, 100]) {
    const items = Array.from({ length: n }, (_, i) => `m${i}`);
    for (const seed of [1, 20260726, 999_983]) {
      const d = seededDerangement(items, seed);
      assert.deepEqual([...d].sort(), [...items].sort(), `n=${n} seed=${seed}: still a permutation`);
      const fixed = d.filter((v, i) => v === items[i]);
      assert.deepEqual(fixed, [], `n=${n} seed=${seed}: no element may keep its place`);
    }
  }
  assert.deepEqual(seededDerangement(["a", "b", "c"], 7), seededDerangement(["a", "b", "c"], 7), "still seeded");

  // The plain shuffle keeps its uniform semantics — it is what the control arm
  // needs, where a fixed point is meaningless.
  assert.equal(typeof seededShuffle, "function");
});

test("the real fixture had a fixed point under the old shuffle and has none now", async () => {
  const { PARAPHRASED_CASES } = await import("../scripts/stress-fixtures/paraphrased.js");
  const ids = PARAPHRASED_CASES.map((c) => c.id);
  const SEED = 20260726;

  const uniform = seededShuffle(ids, SEED);
  assert.ok(
    uniform.some((id, i) => id === ids[i]),
    "regression anchor: the uniform shuffle really did leave a case paired with itself at this seed",
  );

  const deranged = seededDerangement(ids, SEED);
  assert.deepEqual(deranged.filter((id, i) => id === ids[i]), []);
});

// #799: a cross slice with nothing left to grade is not a PASS.
test("a cross slice whose every case is retired or unknown does not pass on 0 === 0", async () => {
  const emptyVault = { list: () => [] } as unknown as Vault;
  const res = await runCrossMemory(emptyVault, async () => [], [{ query: "q", expected: ["gone-1", "gone-2"] }]);
  assert.equal(res.rows.length, 0, "nothing was left to grade");
  assert.equal(res.pass, false, "an empty slice grades nothing; it must not read as PASS");
});
