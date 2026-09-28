/**
 * #129 — the held-out check (learned-recall/verify.ts) on a synthetic
 * candidate-pool log with a fixed ranker:
 *
 *   - a bridge minted in the training folds lifts a held-out far case whose
 *     gold was outside the logged pool (out-of-pool stratum);
 *   - a bridge that pushes a near case out of the top SERVING_K is a regression
 *     and is not eligible for contribution;
 *   - evidence counts independent occasions, not repeats of one signal;
 *   - the contribution gate names every reason a bridge stays home.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/bridge-verify.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { harvestBridges, reconstructReaches, type TelemetryEvent } from "../src/learned-recall/harvest.js";
import { mintBridge, type Bridge } from "../src/learned-recall/bridges.js";
import { contributionVerdict, foldOf, heldOutCases, verifyBridges, type BridgeVerdict } from "../src/learned-recall/verify.js";

const TERMS: Record<string, string[]> = {
  panel: ["nspanel", "resignkey", "observer"],
  other: ["zebra", "yakherde"],
};
const getMemoryTerms = (id: string): string[] => TERMS[id] ?? [];

/** Queries sharing most of their words, placed in the folds a test needs. */
function queryInFold(fold: number, folds: number, taken: Set<string>): string {
  for (let i = 0; i < 500; i++) {
    const q = `warum schließt sich das fenster beim dialog variante${i}`;
    if (!taken.has(q) && foldOf(q, folds) === fold) {
      taken.add(q);
      return q;
    }
  }
  throw new Error("no query for fold");
}

const DISTRACTORS = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"];

/** Fixed ranker: `panel` is only found when a panel term is in the query;
 *  `other` ranks first unless a panel term crowds it down to rank 7. */
function rank(q: string): string[] {
  const t = q.toLowerCase();
  const panelTerm = TERMS.panel.some((w) => t.includes(w));
  if (panelTerm) return ["panel", ...DISTRACTORS.slice(0, 5), "other", ...DISTRACTORS.slice(5)];
  return ["other", ...DISTRACTORS];
}

let n = 0;
function reach(query: string, gold: string, session: string, pool: string[]): TelemetryEvent[] {
  const recall_id = `r${++n}`;
  const ts = "2026-09-20T10:00:00.000Z";
  return [
    {
      kind: "hook_recall",
      ts,
      recall_id,
      query,
      tool_name: "UserPromptSubmit",
      dimensions: { hook_source: "prompt", experiment_session: session },
      candidate_pool: pool.map((id, i) => ({ id, score: 50 - i })),
    },
    { kind: "recall_episode", ts, recall_id, memory_id: gold, acted_on: true },
  ];
}

test("#129 k-fold: a bridge from the training folds lifts a held-out out-of-pool far case; a near regression blocks the other", () => {
  const taken = new Set<string>();
  const qa = queryInFold(0, 2, taken);
  const qb = queryInFold(1, 2, taken);
  const qc = queryInFold(0, 2, taken);
  const events = [
    ...reach(qa, "panel", "s1", ["d1", "d2"]),
    ...reach(qa, "panel", "s2", ["d1", "d2"]),
    ...reach(qb, "panel", "s1", ["d1", "d2"]),
    ...reach(qb, "panel", "s2", ["d1", "d2"]),
    ...reach(qc, "other", "s3", ["other", "d1"]),
  ];
  assert.equal(heldOutCases(events, 2).length, 3, "one case per (query, gold)");

  const report = verifyBridges({ events, getMemoryTerms, rank, folds: 2 });
  const bridgeA = mintBridge(qa, TERMS.panel)!;
  const bridgeB = mintBridge(qb, TERMS.panel)!;

  // A is minted in fold 1's training data and measured on qb (fold 1): panel 0 → 1.
  const a = report.perBridge.get(bridgeA.id)!;
  assert.equal(a.fires, 1);
  assert.equal(a.lift, 1);
  assert.equal(a.byStratum["far-out-of-pool"].fired, 1, "gold outside the logged pool = the out-of-pool stratum");
  assert.equal(contributionVerdict({ ...bridgeA, evidence: 2 }, a).eligible, true);

  // B is measured on qa (lift) AND on qc, whose near gold it pushes to rank 7.
  const b = report.perBridge.get(bridgeB.id)!;
  assert.equal(b.fires, 2);
  assert.equal(b.byStratum.near.regressions, 1);
  const vb = contributionVerdict({ ...bridgeB, evidence: 2 }, b);
  assert.equal(vb.eligible, false);
  assert.ok(vb.reasons.some((r) => r.includes("near hit")), vb.reasons.join("; "));

  // Pool level: the near slice reports the regression too.
  assert.equal(report.pool.near.cases, 1);
  assert.equal(report.pool.near.regressions, 1);
  assert.equal(report.pool["far-out-of-pool"].cases, 2);
});

test("#129 evidence: repeats inside one session are one confirmation, other sessions add", () => {
  const q = "warum schließt sich das fenster beim dialog";
  const same = reconstructReaches([...reach(q, "panel", "s1", ["d1"]), ...reach(q, "panel", "s1", ["d1"]), ...reach(q, "panel", "s1", ["d1"])]);
  assert.equal(harvestBridges(same, getMemoryTerms).bridges[0].evidence, 1);
  const spread = reconstructReaches([...reach(q, "panel", "s1", ["d1"]), ...reach(q, "panel", "s2", ["d1"]), ...reach(q, "panel", "s3", ["d1"])]);
  assert.equal(harvestBridges(spread, getMemoryTerms).bridges[0].evidence, 3);
});

test("#129 evidence: without a session the day is the occasion; without either, rows confirm nothing", () => {
  const q = "warum schließt sich das fenster beim dialog";
  const days = [
    { query: q, memoryId: "panel", ts: "2026-09-01T10:00:00Z" },
    { query: q, memoryId: "panel", ts: "2026-09-01T18:00:00Z" },
    { query: q, memoryId: "panel", ts: "2026-09-02T10:00:00Z" },
  ];
  assert.equal(harvestBridges(days, getMemoryTerms).bridges[0].evidence, 2);
  const bare = [{ query: q, memoryId: "panel" }, { query: q, memoryId: "panel" }];
  assert.equal(harvestBridges(bare, getMemoryTerms).bridges[0].evidence, 1);
});

function verdict(over: Partial<BridgeVerdict>): BridgeVerdict {
  const slice = { cases: 0, fired: 0, liftSum: 0, regressions: 0 };
  return {
    id: "x",
    fires: 1,
    lift: 0.5,
    nullLift: 0,
    nullFires: 0,
    byStratum: { near: { ...slice }, "far-in-pool": { ...slice }, "far-out-of-pool": { cases: 1, fired: 1, liftSum: 0.5, regressions: 0 } },
    ...over,
  };
}

test("#129 gate: demoted, unconfirmed, unmeasured, negative slice and below-null each keep a bridge home", () => {
  const b: Bridge = { id: "x", lang: "de", trigger_terms: ["fenster", "dialog"], expansion_terms: ["nspanel"], evidence: 2 };
  assert.deepEqual(contributionVerdict(b, verdict({})), { eligible: true, reasons: [] });
  assert.match(contributionVerdict({ ...b, demoted_at: "2026-09-01T00:00:00Z" }, verdict({})).reasons.join(), /demoted/);
  assert.match(contributionVerdict({ ...b, evidence: 1 }, verdict({})).reasons.join(), /unconfirmed/);
  assert.match(contributionVerdict(b, undefined).reasons.join(), /unmeasured/);
  const negative = verdict({
    byStratum: {
      near: { cases: 0, fired: 0, liftSum: 0, regressions: 0 },
      "far-in-pool": { cases: 2, fired: 2, liftSum: 1, regressions: 0 },
      "far-out-of-pool": { cases: 1, fired: 1, liftSum: -0.2, regressions: 0 },
    },
  });
  assert.match(contributionVerdict(b, negative).reasons.join(), /far-out-of-pool/, "an out-of-pool loss is not hidden by an in-pool gain");
  assert.match(contributionVerdict(b, verdict({ lift: 0.1, nullLift: 0.3, nullFires: 1 })).reasons.join(), /null/);
});
