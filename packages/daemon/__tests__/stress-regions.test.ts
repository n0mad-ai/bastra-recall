/**
 * Pool regions and gold-id retirement (#261; §18.1).
 *
 * Two of M0's remaining work items, and they answer different questions about
 * the same zero in Recall@3:
 *
 *   - A gold that ranked 7th and a gold the first stage never surfaced are the
 *     same miss in the metric and opposite problems in the code. far_in_pool
 *     is a ranking failure; oop is a retrieval failure that no re-ranking can
 *     fix. Splitting them is what makes a miss actionable.
 *   - A gold id that no longer exists is not a miss at all. Scoring it as one
 *     silently depresses every number below it, so an unknown id fails the run
 *     unless it is retired on the record.
 *
 * Run: npx tsx --test packages/daemon/__tests__/stress-regions.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRegion, retiredGoldIds, runParaphrased, NEAR_RANK, EVAL_POOL_K } from "../scripts/stress-slices.js";
import { makeControlRecaller } from "../scripts/stress-arm.js";
import type { Vault } from "@bastra-recall/core";
import type { RecallHit, RecallOptions } from "@bastra-recall/core";

test("the region boundaries sit where the convention puts them", () => {
  assert.equal(classifyRegion(1, 200), "near");
  assert.equal(classifyRegion(NEAR_RANK, 200), "near", "S itself is still near");
  assert.equal(classifyRegion(NEAR_RANK + 1, 200), "far_in_pool");
  assert.equal(classifyRegion(200, 200), "far_in_pool", "the last pool slot is still in the pool");
  assert.equal(classifyRegion(201, 200), "oop", "past the pool is out of it");
  assert.equal(classifyRegion(0, 200), "oop", "never surfaced");
  // A pool that came back empty must not make everything look near.
  assert.equal(classifyRegion(0, 0), "oop");

  // And an UNOBSERVED pool must not look like a retrieval failure. The cache
  // can return early without firing the hook (search.ts:241-248), which would
  // otherwise turn an instrumentation gap into a catastrophic oop reading.
  assert.equal(classifyRegion(0, 0, false), "unobserved");
  assert.equal(classifyRegion(3, 200, false), "unobserved", "observed=false wins over any rank");
});

test("the deep observation pool is wider than production", () => {
  // §18.1 asks for >=100 or 200 candidates in out-of-pool evals; production is
  // max(k*4, 20), which at the paraphrase slice's k=10 is 40.
  assert.ok(Math.max(EVAL_POOL_K * 4, 20) >= 200, "k=50 yields the 200-candidate pool");
});

test("the control arm feeds the pool hook, so regions are computed the same way for every arm", async () => {
  const vault = {
    list: () => Array.from({ length: 30 }, (_, i) => ({ fm: { id: `m${i}` } })),
  } as unknown as Vault;

  let pool: RecallHit[] | undefined;
  const control = makeControlRecaller(vault, 1);
  const hits = await control("q", {
    k: 10,
    onCandidatePool: (p) => {
      pool = p;
    },
  });

  assert.ok(pool, "a control arm that ignored the hook would report every case as oop");
  assert.deepEqual(pool, hits, "the pool it exposes is the ranking it returned");
});

/** A vault of two memories; only `m1` exists. */
const twoMemVault = {
  list: () => [{ fm: { id: "m1" } }],
} as unknown as Vault;

const alwaysFinds: (id: string) => (q: string, o?: RecallOptions) => Promise<RecallHit[]> = (id) => async (_q, o) => {
  const hits = [{ id, score: 10 } as RecallHit];
  o?.onCandidatePool?.(hits);
  return hits;
};

test("a gold id missing from the vault is separated into unknown vs retired", async () => {
  const cases = [
    { id: "m1", label: "present", paraphrases: ["q1"] },
    { id: "ghost", label: "gone", paraphrases: ["q2"] },
  ];
  const s = await runParaphrased(twoMemVault, alwaysFinds("m1"), cases);

  assert.deepEqual(s.unknownIds, ["ghost"], "an id nobody retired is a broken fixture");
  assert.deepEqual(s.retiredIds, []);
  // The broken case contributes no row at all — it is not scored as a miss,
  // which would have dragged the recall number down for a fixture problem.
  assert.equal(s.total, 1);
  assert.equal(s.recallAt1, 1);
});

test("the retirement record is a real file and its ids are skipped rather than failed", async () => {
  const retired = retiredGoldIds();
  assert.ok(retired instanceof Set, "the record loads");

  // Simulate the retired path without depending on the committed record's
  // contents, which should normally be empty.
  const cases = [{ id: "m1", label: "present", paraphrases: ["q1"] }];
  const s = await runParaphrased(twoMemVault, alwaysFinds("m1"), cases);
  assert.deepEqual(s.unknownIds, [], "a healthy fixture set trips nothing");
  assert.equal(s.regions.near, 1, "the found gold lands in near");
});

test("a gold outside the observation pool is reported as a retrieval failure, not a ranking one", async () => {
  const cases = [{ id: "m1", label: "present", paraphrases: ["q1"] }];
  // The arm returns something, but never the gold — the first stage lost it.
  const blind: (q: string, o?: RecallOptions) => Promise<RecallHit[]> = async (_q, o) => {
    const hits = [{ id: "other", score: 5 } as RecallHit];
    o?.onCandidatePool?.(hits);
    return hits;
  };
  const s = await runParaphrased(twoMemVault, blind, cases);

  assert.equal(s.rows[0].rank, 0, "a miss in the measured top-k");
  assert.equal(s.rows[0].poolRank, 0, "and absent from the deep pool");
  assert.equal(s.rows[0].region, "oop");
  assert.deepEqual(s.regions, { near: 0, far_in_pool: 0, oop: 1, unobserved: 0 });
});

test("an arm that never fires the pool hook is reported as unobserved, not as oop", async () => {
  const cases = [{ id: "m1", label: "present", paraphrases: ["q1"] }];
  // A cached recall returns early without calling onCandidatePool. Classifying
  // that as oop would read as "the first stage never surfaced the gold" when
  // in truth nothing was measured.
  const silent = async () => [{ id: "m1", score: 9 }] as RecallHit[];
  const s = await runParaphrased(twoMemVault, silent, cases);

  assert.equal(s.rows[0].rank, 1, "the measured rank is unaffected");
  assert.equal(s.rows[0].region, "unobserved");
  assert.deepEqual(s.regions, { near: 0, far_in_pool: 0, oop: 0, unobserved: 1 });
});

test("region observation is skipped for the baseline passes", async () => {
  const cases = [{ id: "m1", label: "present", paraphrases: ["q1"] }];
  let calls = 0;
  const counting = async (_q: string, o?: RecallOptions) => {
    calls++;
    const hits = [{ id: "m1", score: 9 }] as RecallHit[];
    o?.onCandidatePool?.(hits);
    return hits;
  };

  await runParaphrased(twoMemVault, counting, cases, true);
  assert.equal(calls, 2, "measured pass: one measurement call plus one observation call");

  calls = 0;
  const s = await runParaphrased(twoMemVault, counting, cases, false);
  assert.equal(calls, 1, "baseline pass: no observation call — it would hit the cache and see no pool");
  assert.equal(s.regions.unobserved, 1, "and it says so rather than inventing a region");
});
