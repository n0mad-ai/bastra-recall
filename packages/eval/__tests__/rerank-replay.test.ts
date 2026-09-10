import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  mean,
  pairedComparison,
  recallAny,
  firstExpectedRank,
  rerankWindow,
  seededRandom,
  sliceBy,
} from "../src/rerank-metrics.js";
import {
  BODY_CHARS,
  CACHE_DIR,
  MODELS,
  assertLanguagesAllowed,
  passageFor,
  type PairScorer,
} from "../src/rerank-model.js";
import {
  PRIMARY,
  NS,
  partitionCases,
  rankArm,
  checkBatchInvariance,
  vaultFingerprint,
} from "../src/rerank-replay.js";
import {
  ASSOCIATIVE_MIN_N,
  MIN_SLICE_N,
  assignPoolBuckets,
  noAnswerGuard,
  reportArm,
  served,
  type ArmRanking,
  type CaseRow,
} from "../src/rerank-report.js";
import type { GoldCase } from "../src/goldset.js";
import type { Memory, RecallHit } from "@bastra-recall/core";

/**
 * Guards for the #501 rerank decision harness.
 *
 * Nothing here touches Ollama or downloads a model: the parts that decide what
 * a number MEANS are pure (`rerank-metrics.ts`, `rerank-report.ts`), and the
 * model is reached through `PairScorer`, which a stub satisfies. That split is
 * the reason these can exist at all — a statistic nobody can test without a
 * 400 MB ONNX session is a statistic nobody tests.
 *
 * Where a test drives production code, it drives the REAL function. An earlier
 * version re-implemented `rankArm`'s loop inside the test, which is precisely
 * the shape in which an off-by-one in the score index survives a green suite.
 */

const POOL = ["a", "b", "c", "d", "e"];

/** A pooled hit at a given RRF score — the floor needs real scores. */
function hit(id: string, score = 100): RecallHit {
  return { id, title: id, type: "lesson", scope: "s", summary: "", topic_path: [], score, matched_terms: [] } as unknown as RecallHit;
}

// ── rerankWindow: the window, the tail, and the ties ────────────────────────

test("rerankWindow reorders the window and leaves the tail alone", () => {
  assert.deepEqual(rerankWindow(POOL, 3, (_x, i) => i), ["c", "b", "a", "d", "e"]);
});

test("rerankWindow keeps the tail even when it is longer than the window", () => {
  const out = rerankWindow(POOL, 2, () => 0);
  assert.equal(out.length, POOL.length);
  assert.deepEqual(out.slice(2), ["c", "d", "e"]);
});

test("rerankWindow: a tie keeps pool order — a model that cannot separate two candidates has said nothing", () => {
  assert.deepEqual(rerankWindow(POOL, 4, () => 1), POOL);
});

test("rerankWindow with n >= pool size reorders everything and loses nothing", () => {
  assert.deepEqual(rerankWindow(POOL, 30, (_x, i) => -i), POOL);
});

test("rerankWindow with n <= 0 is the identity — no window, no rerank", () => {
  assert.deepEqual(rerankWindow(POOL, 0, () => 99), POOL);
});

// ── the metrics ────────────────────────────────────────────────────────────

test("recallAny is 1 only when an expected id is inside the cut", () => {
  const exp = new Set(["d"]);
  assert.equal(recallAny(POOL, exp, 3), 0);
  assert.equal(recallAny(POOL, exp, 4), 1);
  assert.equal(recallAny(POOL, new Set<string>(), 5), 0);
});

test("firstExpectedRank is 1-based and 0 when nothing matches", () => {
  assert.equal(firstExpectedRank(POOL, new Set(["c"])), 3);
  assert.equal(firstExpectedRank(POOL, new Set(["zz"])), 0);
});

test("mean of an empty slice is 0, not NaN — an empty slice has no lift", () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([1, 0, 1, 0]), 0.5);
});

// ── resampling ─────────────────────────────────────────────────────────────

test("seededRandom is deterministic on the same seed and differs on another", () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const c = seededRandom(43);
  const xs = [a(), a(), a()];
  assert.deepEqual(xs, [b(), b(), b()]);
  // The earlier version of this test compared a 3-element array to a
  // 1-element one, so the second assertion could never fail.
  assert.notDeepEqual(xs, [c(), c(), c()]);
});

test("pairedComparison on all-zero deltas reports no effect and a wide-open p", () => {
  const r = pairedComparison(new Array(200).fill(0), { iterations: 2000 });
  assert.equal(r.delta, 0);
  assert.equal(r.unchanged, 200);
  assert.equal(r.p, 1);
});

test("pairedComparison finds a real effect: CI excludes 0 and p is small", () => {
  const r = pairedComparison([...new Array(40).fill(1), ...new Array(60).fill(0)], { iterations: 4000 });
  assert.equal(r.better, 40);
  assert.equal(r.worse, 0);
  assert.ok(r.ci95[0] > 0, `CI lower bound should be above 0, got ${r.ci95[0]}`);
  assert.ok(r.p < 0.01, `p should be small, got ${r.p}`);
});

test("pairedComparison does not manufacture significance from a wash", () => {
  const r = pairedComparison([...new Array(50).fill(1), ...new Array(50).fill(-1)], { iterations: 4000 });
  assert.equal(r.delta, 0);
  assert.ok(r.ci95[0] < 0 && r.ci95[1] > 0, `CI should straddle 0, got ${JSON.stringify(r.ci95)}`);
  assert.ok(r.p > 0.5, `p should be large, got ${r.p}`);
});

test("pairedComparison never reports p = 0 — no permutation test licenses that", () => {
  assert.ok(pairedComparison(new Array(300).fill(1), { iterations: 1000 }).p > 0);
});

test("pairedComparison is reproducible across calls with the same seed", () => {
  const d = [1, 0, 1, -1, 0, 1, 0, 0, 1, -1];
  assert.deepEqual(pairedComparison(d, { iterations: 1000, seed: 7 }), pairedComparison(d, { iterations: 1000, seed: 7 }));
});

test("pairedComparison on an empty sample is neutral, not a crash", () => {
  const r = pairedComparison([]);
  assert.equal(r.n, 0);
  assert.equal(r.p, 1);
});

test("sliceBy partitions without dropping or duplicating a row", () => {
  const out = sliceBy([{ l: "de" }, { l: "en" }, { l: "de" }], (r) => r.l);
  assert.equal(Object.values(out).flat().length, 3);
  assert.equal(out.de.length, 2);
});

// ── the production cut: serve k, then floor ────────────────────────────────

test("served applies the cut BEFORE the floor and never backfills from deeper", () => {
  const hits = [hit("a", 160), hit("b", 20), hit("c", 150)];
  // k=2 takes a and b; b is under the floor and drops. c must NOT move up.
  assert.deepEqual(served(hits, 2, 30), ["a"]);
});

test("served drops sub-floor hits — a promotion from below the floor is invisible in production", () => {
  assert.deepEqual(served([hit("a", 29), hit("b", 31)], 10, 30), ["b"]);
});

test("a rerank that lifts a sub-floor candidate to rank 1 scores no hit", () => {
  // The exact failure the floor exists to stop: without it this would count.
  const pool = [hit("wrong", 160), hit("gold", 10)];
  const reranked = rerankWindow(pool, 2, (h) => (h.id === "gold" ? 99 : 0));
  assert.equal(reranked[0].id, "gold", "the rerank did promote it");
  assert.equal(recallAny(served(reranked, 10, 30), new Set(["gold"]), 3), 0, "but production never shows it");
  assert.equal(recallAny(reranked.map((h) => h.id), new Set(["gold"]), 3), 1, "the floor-free upper bound does");
});

// ── the case partition ─────────────────────────────────────────────────────

function goldCase(over: Partial<GoldCase>): GoldCase {
  return {
    id: "x", query: "q", origin_type: "harvested", authoring_mode: "test", origin_ref_hash: "h",
    lang: "de", has_identifier: false, expected_ids: ["m1"], acceptable_alternatives: [],
    expected_zone: "core", no_answer: false, scope: null, time_view: null,
    allowed_retrieval_depth: 3, rationale: "r", kind: "descriptive",
    labelled_at: "2026-09-09", labelled_by: "test", ...over,
  } as GoldCase;
}

test("partitionCases: probes out, no_answer apart, and the three buckets add up", () => {
  const cases = [
    goldCase({ id: "a" }),
    goldCase({ id: "b", no_answer: true, expected_ids: [] }),
    goldCase({ id: "c", probe_group: "gibberish-probe" } as Partial<GoldCase>),
    goldCase({ id: "d" }),
  ];
  const p = partitionCases(cases);
  assert.deepEqual(p.answerable.map((c) => c.id), ["a", "d"]);
  assert.deepEqual(p.noAnswer.map((c) => c.id), ["b"]);
  assert.equal(p.probes, 1);
  assert.equal(p.answerable.length + p.noAnswer.length + p.malformed.length + p.probes, cases.length);
});

test("partitionCases surfaces a malformed case instead of dropping it silently", () => {
  const p = partitionCases([goldCase({ id: "a", expected_ids: [] })]);
  assert.equal(p.answerable.length, 0);
  assert.deepEqual(p.malformed.map((c) => c.id), ["a"], "it must land somewhere the runner can refuse");
});

// ── passages ───────────────────────────────────────────────────────────────

function memo(over: Partial<{ title: string; summary: string; body: string }> = {}): Memory {
  return {
    fm: { title: over.title ?? "Titel", summary: over.summary ?? "Zusammenfassung" },
    body: over.body ?? "B".repeat(1000),
  } as unknown as Memory;
}

test("passageFor short mode omits the body entirely — the 80-token variant", () => {
  const p = passageFor(memo(), "short");
  assert.equal(p, "Titel\nZusammenfassung");
});

test("passageFor body mode adds exactly BODY_CHARS of body", () => {
  const p = passageFor(memo(), "body");
  assert.equal(p.length - "Titel\nZusammenfassung\n".length, BODY_CHARS);
});

test("passageFor drops empty fields rather than emitting blank lines", () => {
  assert.equal(passageFor(memo({ summary: "" }), "short"), "Titel");
});

// ── the language guard, which has to actually run ──────────────────────────

test("the language guard REFUSES ms-marco on a set carrying German", () => {
  // The regression this pins: `languages` used to be a metadata field nothing
  // read, so `--models ms-marco --gold <german>` ran over 272 German cases and
  // would have reported the null as a statement about reranking.
  assert.throws(
    () => assertLanguagesAllowed(MODELS["ms-marco"], ["de", "neutral"]),
    /does not speak the language|was measured in/,
    "an English-only model must not be scorable on a German set",
  );
});

test("the language guard lets ms-marco through on an English set", () => {
  assert.doesNotThrow(() => assertLanguagesAllowed(MODELS["ms-marco"], ["en", "neutral"]));
});

test("the language guard ignores neutral and mixed — they belong to no language pool", () => {
  // 205 of 584 cases are `neutral` keyword chains; refusing them would rule out
  // every model on every set.
  assert.doesNotThrow(() => assertLanguagesAllowed(MODELS["ms-marco"], ["neutral", "mixed"]));
});

test("the bilingual arm passes on both languages", () => {
  assert.doesNotThrow(() => assertLanguagesAllowed(MODELS["en-de"], ["de", "en", "neutral"]));
  assert.equal(MODELS["en-de"].dtype, "fp32", "its repo ships no quantized ONNX");
});

// ── the primary endpoint ───────────────────────────────────────────────────

test("the primary endpoint is the cheapest cell — the only one that can pass the latency bar", () => {
  assert.equal(PRIMARY.n, Math.min(...NS));
  assert.equal(PRIMARY.passage, "short");
  assert.equal(PRIMARY.model, "en-de");
  assert.equal(PRIMARY.cut, "r@3");
});

// ── rankArm, driven for real ───────────────────────────────────────────────

/** Scores by position so the last candidate in the window always wins. */
const lastWins: PairScorer = {
  id: "stub-last-wins",
  loadMs: 0,
  async score(_q, passages) {
    return passages.map((_p, i) => i);
  },
  close() {},
};

function row(id: string, poolIds: string[], expected: string[], over: Partial<CaseRow> = {}): CaseRow {
  return {
    id,
    query: "q",
    lang: "de",
    kind: "descriptive",
    expected: new Set(expected),
    expectedAny: new Set(expected),
    baseline: poolIds.map((p) => hit(p)),
    poolSize: poolIds.length,
    weakResult: false,
    ...over,
  };
}

const MEMS = (id: string): Memory => memo({ title: id, summary: id });

test("rankArm reranks through the real function and rescues a buried gold", async () => {
  const pool = ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"];
  const rows = [row("c1", pool, ["m9"])];
  const rankings = await rankArm(lastWins, "short", rows, MEMS, "t", [10]);
  const after = rankings.get("c1")![10];
  assert.equal(after[0].id, "m9", "the last candidate scored highest and must lead");
  assert.equal(recallAny(rows[0].baseline.map((h) => h.id), rows[0].expected, 3), 0, "baseline: outside the top 3");
  assert.equal(recallAny(after.map((h) => h.id), rows[0].expected, 3), 1, "reranked: inside");
});

test("rankArm maps score i to candidate i — an off-by-one here would be invisible in the aggregate", async () => {
  const pool = ["a", "b", "c", "d"];
  const rows = [row("c1", pool, ["a"])];
  const rankings = await rankArm(lastWins, "short", rows, MEMS, "t", [4]);
  // lastWins gives score j to the j-th passage, so the exact reversal is the
  // only correct answer. Any index shift produces a different permutation.
  assert.deepEqual(rankings.get("c1")![4].map((h) => h.id), ["d", "c", "b", "a"]);
});

test("one deep pass yields the same windows as separate shallow passes — the harness's core claim", async () => {
  const pool = Array.from({ length: 30 }, (_, i) => `m${i}`);
  const rows = [row("c1", pool, ["m29"])];
  const deep = await rankArm(lastWins, "short", rows, MEMS, "t", [10, 20, 30]);
  for (const n of [10, 20, 30]) {
    const separate = await rankArm(lastWins, "short", rows, MEMS, "t", [n]);
    assert.deepEqual(
      deep.get("c1")![n].map((h) => h.id),
      separate.get("c1")![n].map((h) => h.id),
      `N=${n} derived from the deep pass must equal a dedicated N=${n} pass`,
    );
  }
});

test("checkBatchInvariance reports a stable order for a batch-invariant scorer", async () => {
  const pool = Array.from({ length: 30 }, (_, i) => `m${i}`);
  const r = await checkBatchInvariance(lastWins, "short", row("c1", pool, ["m0"]), MEMS);
  assert.equal(r.maxAbsDelta, 0);
  assert.equal(r.orderStable, true);
});

test("checkBatchInvariance catches a scorer whose order depends on the batch size", async () => {
  const batchDependent: PairScorer = {
    id: "stub-batch-dependent",
    loadMs: 0,
    async score(_q, passages) {
      // Reverses its ranking once the batch is deep — the exact failure the
      // "one pass covers every N" claim would hide.
      return passages.map((_p, i) => (passages.length > 10 ? -i : i));
    },
    close() {},
  };
  const pool = Array.from({ length: 30 }, (_, i) => `m${i}`);
  const r = await checkBatchInvariance(batchDependent, "short", row("c1", pool, ["m0"]), MEMS);
  assert.equal(r.orderStable, false);
});

// ── the report ─────────────────────────────────────────────────────────────

function ranked(rows: CaseRow[], order: (r: CaseRow) => string[]): Map<string, ArmRanking> {
  const m = new Map<string, ArmRanking>();
  for (const r of rows) {
    const byId = new Map(r.baseline.map((h) => [h.id, h]));
    m.set(r.id, Object.fromEntries(NS.map((n) => [n, order(r).map((id) => byId.get(id)!)])) as ArmRanking);
  }
  return m;
}

test("a slice below MIN_SLICE_N is reported as not evaluable, never as a number", () => {
  const rows = [row("c1", ["a", "b"], ["a"], { lang: "mixed" })];
  const rep = reportArm({
    model: "en-de", passage: "short", n: 10, primary: true,
    rows, rankings: ranked(rows, (r) => r.baseline.map((h) => h.id)),
    floor: 30, serveK: 10, seed: 1, poolSplit: assignPoolBuckets([...rows], 40),
  });
  assert.ok(rep.by_lang.mixed.not_evaluable, "mixed (n=4 in the real set) must not carry an interval");
  assert.equal(rep.by_lang.mixed.at, undefined);
  assert.ok(MIN_SLICE_N > 4);
});

test("rank_regression_share counts a gold that fell out of the served list", () => {
  const rows = [row("c1", ["gold", "x", "y"], ["gold"])];
  // Push the gold to the back; with serveK=1 it leaves the served list entirely.
  const rankings = ranked(rows, () => ["x", "y", "gold"]);
  const rep = reportArm({
    model: "en-de", passage: "short", n: 10, primary: true,
    rows, rankings, floor: 30, serveK: 1, seed: 1, poolSplit: assignPoolBuckets([...rows], 40),
  });
  assert.equal(rep.rank_regression_share, 1);
});

test("the no_answer guard counts a changed top-1 and says so as a share", () => {
  const rows = [row("g1", ["a", "b"], [])];
  assert.equal(noAnswerGuard(rows, ranked(rows, () => ["b", "a"]), 10, 10, 30).top1_changed, 1);
  assert.equal(noAnswerGuard(rows, ranked(rows, () => ["a", "b"]), 10, 10, 30).share, 0);
});

test("assignPoolBuckets splits at the in-run median, not at a chosen number", () => {
  const rows = [
    row("a", ["1"], ["1"], { poolSize: 5 }),
    row("b", ["1"], ["1"], { poolSize: 10 }),
    row("c", ["1"], ["1"], { poolSize: 40 }),
  ];
  const split = assignPoolBuckets(rows, 40);
  assert.equal(split.median, 10);
  assert.equal(split.degenerate, undefined);
  assert.deepEqual(rows.map((r) => r.poolBucket), ["small", "large", "large"]);
});

test("assignPoolBuckets flags a constant pool — the split that silently does not split", () => {
  // The predicted shape on this vault: HOP_SEED_POOL caps every pool at 40, so
  // poolSize is 40 everywhere, the median is 40, every case lands in `large`
  // and `small` is empty. Without this flag the artifact would read
  // `by_pool: { large: { n: 584 } }` and look like a finished split.
  const rows = Array.from({ length: 20 }, (_, i) => row(`c${i}`, ["1"], ["1"], { poolSize: 40 }));
  const split = assignPoolBuckets(rows, 40);
  assert.ok(split.degenerate, "a one-sided split must be flagged");
  assert.equal(split.small, 0);
  assert.equal(split.large, 20);
});

test("assignPoolBuckets flags a median sitting on the pool cap even when both buckets fill", () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => row(`s${i}`, ["1"], ["1"], { poolSize: 39 })),
    ...Array.from({ length: 6 }, (_, i) => row(`l${i}`, ["1"], ["1"], { poolSize: 40 })),
  ];
  const split = assignPoolBuckets(rows, 40);
  assert.ok(split.degenerate?.includes("cap"), "a cap-driven split is an artefact, not query difficulty");
});

test("a degenerate pool split makes both by_pool buckets not evaluable — including the full one", () => {
  const rows = Array.from({ length: 40 }, (_, i) => row(`c${i}`, ["a", "b"], ["a"], { poolSize: 40 }));
  const split = assignPoolBuckets(rows, 40);
  const rep = reportArm({
    model: "en-de", passage: "short", n: 10, primary: true,
    rows, rankings: ranked(rows, (r) => r.baseline.map((h) => h.id)),
    floor: 30, serveK: 10, seed: 1, poolSplit: split,
  });
  assert.ok(rep.by_pool.small, "the empty bucket must still appear");
  assert.ok(rep.by_pool.large, "the full bucket must appear");
  assert.ok(rep.by_pool.large.not_evaluable, "and must NOT carry an interval when the split degenerated");
  assert.equal(rep.by_pool.large.at, undefined);
  assert.ok(rep.pool_split.degenerate);
});

// ── the cache location ─────────────────────────────────────────────────────

test("the model cache is not under node_modules — npm ci must not throw away half a gigabyte per model", () => {
  assert.ok(!CACHE_DIR.includes("node_modules"), `cache dir must live outside node_modules, got ${CACHE_DIR}`);
});

test("env.cacheDir is assigned BEFORE the first from_pretrained", () => {
  // A source-order assertion, deliberately. The behaviour it protects is only
  // observable by loading a real model, and the regression it catches is
  // somebody moving the assignment below the first call — after which the
  // first model lands in node_modules and the cache silently lives in two
  // places. A test that only checks the constant's value stays green through
  // exactly that change.
  const src = readFileSync(resolve(import.meta.dirname, "..", "src", "rerank-model.ts"), "utf8");
  const assign = src.indexOf("env.cacheDir = CACHE_DIR");
  // `.from_pretrained(` — the CALL. Matching the bare name would also hit the
  // comment that explains the ordering, which sits above the assignment.
  const firstLoad = src.indexOf(".from_pretrained(");
  assert.ok(assign > 0, "the assignment must exist");
  assert.ok(firstLoad > 0, "there must be a from_pretrained call to order against");
  assert.ok(assign < firstLoad, "the assignment must precede the first from_pretrained call");
});

test("the eval package declares transformers.js as a devDependency and nothing else does", () => {
  const root = resolve(import.meta.dirname, "..", "..");
  const evalPkg = JSON.parse(readFileSync(join(root, "eval", "package.json"), "utf8"));
  assert.ok(evalPkg.devDependencies["@huggingface/transformers"], "eval must declare it");
  assert.equal(evalPkg.dependencies?.["@huggingface/transformers"], undefined, "never a runtime dependency");
  for (const p of ["core", "daemon"]) {
    const pkg = JSON.parse(readFileSync(join(root, p, "package.json"), "utf8"));
    assert.equal(pkg.dependencies?.["@huggingface/transformers"], undefined, `${p} must not carry it at runtime`);
    assert.equal(pkg.devDependencies?.["@huggingface/transformers"], undefined, `${p} must not carry it at all`);
  }
});

test("§18.1: the associative axis under its registered minimum is NOT EVALUABLE, never a null finding", () => {
  // 137 answerable associative cases against a registered minimum of 150. The
  // bar lives in code because a report writer can forget a rule; a checker
  // cannot. Above MIN_SLICE_N=30, so nothing else would have caught this.
  const rows = Array.from({ length: 137 }, (_, i) =>
    row(`a${i}`, ["gold", "x"], ["gold"], { kind: "associative" }),
  );
  const rep = reportArm({
    model: "en-de", passage: "short", n: 10, primary: true,
    rows, rankings: ranked(rows, (r) => r.baseline.map((h) => h.id)),
    floor: 30, serveK: 10, seed: 1, poolSplit: assignPoolBuckets([...rows], 40),
  });
  assert.ok(rep.by_kind.associative.not_evaluable?.includes("§18.1"), JSON.stringify(rep.by_kind.associative));
  assert.ok(rep.by_kind.associative.not_evaluable?.includes("never as a null finding"));
  assert.equal(rep.by_kind.associative.at, undefined, "no interval may be emitted for it");
  assert.equal(rep.by_kind.associative.n, 137);
  assert.ok(137 < ASSOCIATIVE_MIN_N, "the real gold set is 13 cases short of the registered minimum");
});

test("the descriptive axis is NOT bound by the associative minimum", () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    row(`d${i}`, ["gold", "x"], ["gold"], { kind: "descriptive" }),
  );
  const rep = reportArm({
    model: "en-de", passage: "short", n: 10, primary: true,
    rows, rankings: ranked(rows, (r) => r.baseline.map((h) => h.id)),
    floor: 30, serveK: 10, seed: 1, poolSplit: assignPoolBuckets([...rows], 40),
  });
  assert.ok(rep.by_kind.descriptive.at, "60 descriptive cases clear MIN_SLICE_N and must be measured");
});

test("the vault fingerprint changes when a memory is added AND when one is edited", () => {
  // Both cases, because the incident that prompted this was growth (+2
  // memories) but an edit to an existing file would be just as invisible to a
  // bare count — and just as capable of moving BM25 document frequencies.
  const mem = (id: string, updated: string) => ({ fm: { id, updated } });
  const fake = (items: { fm: { id: string; updated: string } }[]) =>
    ({ list: () => items, size: () => items.length }) as unknown as Parameters<typeof vaultFingerprint>[0];

  const base = fake([mem("a", "2026-09-01"), mem("b", "2026-09-02")]);
  const grown = fake([mem("a", "2026-09-01"), mem("b", "2026-09-02"), mem("c", "2026-09-03")]);
  const edited = fake([mem("a", "2026-09-01"), mem("b", "2026-09-09")]);

  const f = vaultFingerprint(base);
  assert.equal(f.size, 2);
  assert.notEqual(vaultFingerprint(grown).ids_updated_sha256, f.ids_updated_sha256, "growth must show");
  assert.notEqual(vaultFingerprint(edited).ids_updated_sha256, f.ids_updated_sha256, "an edit must show too");
  assert.equal(vaultFingerprint(edited).size, f.size, "and the count alone would NOT have shown it");
});

test("the vault fingerprint does not depend on listing order", () => {
  const mem = (id: string, updated: string) => ({ fm: { id, updated } });
  const fake = (items: { fm: { id: string; updated: string } }[]) =>
    ({ list: () => items, size: () => items.length }) as unknown as Parameters<typeof vaultFingerprint>[0];
  const a = fake([mem("a", "2026-09-01"), mem("b", "2026-09-02")]);
  const b = fake([mem("b", "2026-09-02"), mem("a", "2026-09-01")]);
  assert.equal(vaultFingerprint(a).ids_updated_sha256, vaultFingerprint(b).ids_updated_sha256);
});
