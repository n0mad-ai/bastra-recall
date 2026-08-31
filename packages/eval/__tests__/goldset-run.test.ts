import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controlRecaller,
  gatedHybridRecaller,
  metricsFor,
  scoreCases,
  type CaseResult,
} from "../src/goldset-run.js";
import { datasetHash, loadGoldFiles, unknownGoldIds } from "../src/goldset-dataset.js";
import type { RecallHit, StageListener } from "@bastra-recall/core";
import { originRefHash, stagedId, type GoldCase } from "../src/goldset.js";

const row = (over: Partial<CaseResult> = {}): CaseResult => ({
  id: "c1",
  query: "q",
  no_answer: false,
  kind: "descriptive",
  zone: "orbit",
  origin: "user_query",
  lang: "de",
  allowed_depth: 3,
  rank_expected: 1,
  rank_any: 1,
  top_id: "m1",
  top_score: 163.934,
  gold_score: 163.934,
  abstained: false,
  unknown_ids: [],
  top_mode: "hybrid",
  ...over,
});

test("rank 0 means the gold never surfaced and counts nowhere", () => {
  const m = metricsFor([row({ rank_expected: 0, rank_any: 0 })]);
  assert.equal(m.recall_at_1, 0);
  assert.equal(m.recall_at_10, 0);
  assert.equal(m.mrr, 0, "a miss contributes no reciprocal rank");
});

test("the allowed depth comes from the case, not from a global k", () => {
  // Same rank, different labels: one case allows depth 10, the other only 3.
  const deep = metricsFor([row({ rank_expected: 5, allowed_depth: 10 })]);
  const shallow = metricsFor([row({ rank_expected: 5, allowed_depth: 3 })]);
  assert.equal(deep.recall_at_allowed_depth, 1, "rank 5 is inside a depth of 10");
  assert.equal(shallow.recall_at_allowed_depth, 0, "and outside a depth of 3");
  assert.equal(deep.recall_at_3, shallow.recall_at_3, "while Recall@3 does not move with the label");
});

test("acceptable alternatives are scored apart from expected ids (§19)", () => {
  // The expected id is missing; only an acceptable one came back.
  const m = metricsFor([row({ rank_expected: 0, rank_any: 2 })]);
  assert.equal(m.recall_at_3, 0, "expected_ids is the strict metric");
  assert.equal(m.recall_at_3_incl_acceptable, 1, "and the lenient one is reported beside it, never merged");
});

test("MRR is the mean reciprocal rank over the slice", () => {
  const m = metricsFor([row({ rank_expected: 1 }), row({ rank_expected: 4 }), row({ rank_expected: 0 })]);
  assert.equal(m.mrr, Number(((1 + 0.25 + 0) / 3).toFixed(4)));
  assert.equal(m.n, 3);
});

const gold = (q: string, over: Partial<GoldCase> = {}): GoldCase => ({
  id: stagedId(q),
  query: q,
  origin_type: "user_query",
  authoring_mode: "verbatim from a real recall",
  origin_ref_hash: originRefHash("ref"),
  lang: "de",
  has_identifier: false,
  expected_ids: ["m1"],
  acceptable_alternatives: [],
  expected_zone: "orbit",
  no_answer: false,
  scope: null,
  time_view: null,
  allowed_retrieval_depth: 3,
  rationale: "m1 is the only memory stating this rule",
  kind: "descriptive",
  labelled_at: "2026-08-28",
  labelled_by: "Daniel",
  ...over,
});

const goldFile = (name: string, cases: GoldCase[], over: Record<string, unknown> = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), "bastra-goldset-run-"));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ schema_version: 1, cases, ...over }));
  return path;
};

test("the runner validates the gold file itself, not its creation history (#434)", () => {
  const clean = goldFile("gold.json", [gold("wie war die regel für force pushes")]);
  assert.equal(loadGoldFiles([clean]).cases.length, 1);

  // A truthy typo in probe_group used to pass straight through and silently
  // remove the case from the main denominator.
  const typo = goldFile("gold.json", [
    gold("wie war die regel für force pushes", {
      probe_group: "gibbersih-probe" as unknown as GoldCase["probe_group"],
    }),
  ]);
  assert.throws(() => loadGoldFiles([typo]), /violate §19/);

  // The same for the other rules the authoring pipeline enforces.
  const rewritten = goldFile("gold.json", [gold("q", { query: "someone edited this by hand" })]);
  assert.throws(() => loadGoldFiles([rewritten]), /violate §19/);
  const graded = goldFile("gold.json", [gold("nach was fragt das hier", { expected_ids: [] })]);
  assert.throws(() => loadGoldFiles([graded]), /violate §19/);
  const shallow = goldFile("gold.json", [gold("wie tief darf das gehen", { allowed_retrieval_depth: 0 })]);
  assert.throws(() => loadGoldFiles([shallow]), /violate §19/);
});

test("a foreign schema version and an empty file are refused (#434)", () => {
  const other = goldFile("gold.json", [gold("eine frage")], { schema_version: 2 });
  assert.throws(() => loadGoldFiles([other]), /schema_version/);
  const empty = goldFile("gold.json", []);
  assert.throws(() => loadGoldFiles([empty]), /no cases/);
});

test("two gold files of the same name cannot overwrite each other in the source map (#430)", () => {
  const a = goldFile("gold-tel-1.json", [gold("erste frage")]);
  const b = goldFile("gold-tel-1.json", [gold("zweite frage"), gold("dritte frage")]);
  assert.throws(() => loadGoldFiles([a, b]), /are named/);

  // Different names still add up, and both counts survive.
  const c = goldFile("gold-tel-2.json", [gold("zweite frage"), gold("dritte frage")]);
  const loaded = loadGoldFiles([a, c]);
  assert.equal(loaded.cases.length, 3);
  assert.deepEqual(loaded.sources, { "gold-tel-1.json": 1, "gold-tel-2.json": 2 });
});

test("duplicate case ids across files are still refused (#434)", () => {
  const a = goldFile("gold-a.json", [gold("dieselbe frage")]);
  const b = goldFile("gold-b.json", [gold("dieselbe frage")]);
  assert.throws(() => loadGoldFiles([a, b]), /duplicate/);
});

test("the dataset hash moves with query and labels, not only with the ids (#430)", () => {
  const base = [gold("wie war die regel für force pushes"), gold("wo liegt der installer")];
  const sources = { "gold.json": 2 };
  const h = datasetHash(sources, base);

  // Same ids, rewritten query — two materially different evaluations that used
  // to share one citation identity.
  const rewritten = base.map((c, i) => (i === 0 ? { ...c, query: "etwas ganz anderes" } : c));
  assert.notEqual(datasetHash(sources, rewritten), h, "a rewritten query is a different dataset");

  for (const over of [
    { expected_ids: ["m2"] },
    { acceptable_alternatives: ["m9"] },
    { no_answer: true },
    { probe_group: "gibberish-probe" as const },
    { allowed_retrieval_depth: 10 },
    { kind: "associative" as const },
    { expected_zone: "core" as const },
    { origin_type: "second_person" as const },
    { lang: "en" as const },
  ]) {
    const relabelled = base.map((c, i) => (i === 0 ? { ...c, ...over } : c));
    assert.notEqual(
      datasetHash(sources, relabelled),
      h,
      `relabelling ${Object.keys(over)[0]} must change the dataset identity`,
    );
  }

  // What only records who wrote the label down does not move it, and neither
  // does the order the files were concatenated in.
  const reprosed = base.map((c) => ({ ...c, rationale: "same label, better prose", labelled_by: "Sali" }));
  assert.equal(datasetHash(sources, reprosed), h, "prose about the label is not the label");
  assert.equal(datasetHash(sources, [...base].reverse()), h, "file order is not part of the dataset");
});

test("unknown gold ids are collected before scoring, deduplicated and sorted (#432)", () => {
  const cases = [
    gold("erste frage", { expected_ids: ["m1", "gone-b"] }),
    gold("zweite frage", { expected_ids: ["gone-b"], acceptable_alternatives: ["gone-a"] }),
  ];
  const known = new Set(["m1"]);
  assert.deepEqual(unknownGoldIds(cases, known), ["gone-a", "gone-b"]);
  assert.deepEqual(unknownGoldIds(cases, new Set(["m1", "gone-a", "gone-b"])), []);
});

const VAULT_IDS = Array.from({ length: 40 }, (_, i) => `m${String(i).padStart(2, "0")}`);

test("the control draw follows the case, not its position in the input (#426)", async () => {
  const seed = 20260828;
  const drawFor = async (ids: string[], caseIds: string[]): Promise<Record<string, string[]>> => {
    const r = controlRecaller(ids, seed);
    const out: Record<string, string[]> = {};
    for (const id of caseIds) out[id] = (await r("q", id)).map((h) => h.id);
    return out;
  };

  const forward = await drawFor(VAULT_IDS, ["c1", "c2", "c3"]);
  const reordered = await drawFor(VAULT_IDS, ["c3", "c1", "c2"]);
  // The bug: seeding from a running counter tied case n's ranking to n, so
  // concatenating the gold files differently moved the null baseline.
  assert.deepEqual(reordered.c1, forward.c1, "the same case must draw the same ranking");
  assert.deepEqual(reordered.c3, forward.c3);
  assert.notDeepEqual(forward.c1, forward.c2, "different cases still draw differently");

  // Nor may the vault's enumeration order move it.
  const shuffledPool = await drawFor([...VAULT_IDS].reverse(), ["c1"]);
  assert.deepEqual(shuffledPool.c1, forward.c1, "the id pool is sorted before the draw");

  // The seed is still what makes the control arm reproducible.
  const other = controlRecaller(VAULT_IDS, 1);
  assert.notDeepEqual((await other("q", "c1")).map((h) => h.id), forward.c1);
});

/** A `recallHybrid` stand-in that emits the stages the real one emits. */
const fakeHybrid = (hits: RecallHit[], degraded?: string) =>
  async (_q: string, o: { k: number; onStage: StageListener }): Promise<RecallHit[]> => {
    o.onStage({ name: "bm25.search", startedAtMs: 0, meta: { raw_hit_count: hits.length } });
    o.onStage({
      name: "done",
      startedAtMs: 0,
      meta: { hit_count: hits.length, ...(degraded ? { degraded } : {}) },
    });
    return hits;
  };

const hit = (id: string, score: number, mode = "hybrid"): RecallHit =>
  ({ id, score, mode } as RecallHit);

test("a per-query fallback to BM25 stops the run instead of entering a hybrid artifact (#428)", async () => {
  const healthy = gatedHybridRecaller(fakeHybrid([hit("m01", 120)]));
  assert.deepEqual((await healthy("q", "c1")).map((h) => h.id), ["m01"]);

  // A fused hit that only one arm carried is NOT a degradation — `top_mode`
  // alone could never tell the two apart.
  const oneArmTop = gatedHybridRecaller(fakeHybrid([hit("m01", 120, "bm25")]));
  assert.equal((await oneArmTop("q", "c1")).length, 1);

  for (const reason of ["vector-arm-timeout", "vector-arm-error", "vector-arm-empty"]) {
    const fallen = gatedHybridRecaller(fakeHybrid([hit("m01", 1997.3, "bm25")], reason));
    await assert.rejects(() => fallen("q", "c7"), new RegExp(`case c7:.*${reason}`));
  }
});

test("the row carries the served top-k, so the ranks can be re-derived (#417)", async () => {
  const served = [hit("m01", 120), hit("m02", 90), hit("m03", 40), hit("m04", 12)];
  const cases = [gold("eine frage", { expected_ids: ["m03"], acceptable_alternatives: ["m02"] })];
  const rows = await scoreCases(cases, async () => served, new Set(VAULT_IDS), true);

  // Only what cleared the floor is served, and that is what the ranks are read
  // off — m04 at score 12 is below SCORE_FLOOR and appears nowhere.
  assert.deepEqual(rows[0].top_k, [
    { id: "m01", score: 120 },
    { id: "m02", score: 90 },
    { id: "m03", score: 40 },
  ]);

  // The point of the field: an independent checker re-derives the runner's own
  // ranks instead of having to trust them at every position but the first.
  const expected = new Set(cases[0].expected_ids);
  const any = new Set([...cases[0].expected_ids, ...cases[0].acceptable_alternatives]);
  assert.equal(rows[0].top_k.findIndex((h) => expected.has(h.id)) + 1, rows[0].rank_expected);
  assert.equal(rows[0].top_k.findIndex((h) => any.has(h.id)) + 1, rows[0].rank_any);
  assert.equal(rows[0].rank_expected, 3, "and the rank sits where only top_k can show it");
});
