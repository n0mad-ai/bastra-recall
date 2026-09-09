import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mean,
  pairedComparison,
  recallAny,
  firstExpectedRank,
  rerankWindow,
  seededRandom,
  sliceBy,
} from "../src/rerank-metrics.js";
import { BODY_CHARS, MODELS, passageFor, type PairScorer } from "../src/rerank-model.js";
import { partitionCases } from "../src/rerank-replay.js";
import type { GoldCase } from "../src/goldset.js";
import type { Memory } from "@bastra-recall/core";

/**
 * Guards for the #501 rerank decision harness.
 *
 * None of this touches Ollama or downloads a model: the parts that decide what
 * the number MEANS are pure by construction (`rerank-metrics.ts`), and the
 * model is reached through the `PairScorer` interface, which a stub satisfies.
 * That is the whole reason the split exists — a statistic nobody can test
 * without a 400 MB ONNX session is a statistic nobody tests.
 */

// ── rerankWindow: the window, the tail, and the ties ────────────────────────

const POOL = ["a", "b", "c", "d", "e"];

test("rerankWindow reorders the window and leaves the tail alone", () => {
  // Reverse the first three by score; d and e must not move.
  const out = rerankWindow(POOL, 3, (_x, i) => i);
  assert.deepEqual(out, ["c", "b", "a", "d", "e"]);
});

test("rerankWindow keeps the tail even when it is longer than the window", () => {
  const out = rerankWindow(POOL, 2, () => 0);
  assert.equal(out.length, POOL.length);
  assert.deepEqual(out.slice(2), ["c", "d", "e"]);
});

test("rerankWindow: a tie keeps pool order — a model that cannot separate two candidates has said nothing", () => {
  const out = rerankWindow(POOL, 4, () => 1);
  assert.deepEqual(out, POOL);
});

test("rerankWindow with n >= pool size reorders everything and loses nothing", () => {
  const out = rerankWindow(POOL, 30, (_x, i) => -i);
  assert.deepEqual(out, POOL);
  assert.equal(out.length, 5);
});

test("rerankWindow with n <= 0 is the identity — no window, no rerank", () => {
  assert.deepEqual(rerankWindow(POOL, 0, () => 99), POOL);
});

// ── the metrics themselves ─────────────────────────────────────────────────

test("recallAny is 1 only when an expected id is inside the cut", () => {
  const exp = new Set(["d"]);
  assert.equal(recallAny(POOL, exp, 3), 0);
  assert.equal(recallAny(POOL, exp, 4), 1);
  // No expected id at all cannot be a hit — the no_answer cases live elsewhere.
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

// ── the resampling ─────────────────────────────────────────────────────────

test("seededRandom is deterministic — a CI that moves on unchanged data is not reportable", () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const xs = [a(), a(), a()];
  const ys = [b(), b(), b()];
  assert.deepEqual(xs, ys);
  assert.notDeepEqual(xs, [seededRandom(43)(), 0, 0].slice(0, 1));
});

test("pairedComparison on all-zero deltas reports no effect and a wide-open p", () => {
  const r = pairedComparison(new Array(200).fill(0), { iterations: 2000 });
  assert.equal(r.delta, 0);
  assert.equal(r.better, 0);
  assert.equal(r.worse, 0);
  assert.equal(r.unchanged, 200);
  assert.equal(r.p, 1);
});

test("pairedComparison finds a real effect: CI excludes 0 and p is small", () => {
  // 100 cases, 40 improved, none regressed — a lift nobody should miss.
  const deltas = [...new Array(40).fill(1), ...new Array(60).fill(0)];
  const r = pairedComparison(deltas, { iterations: 4000 });
  assert.equal(r.better, 40);
  assert.equal(r.worse, 0);
  assert.ok(r.ci95[0] > 0, `CI lower bound should be above 0, got ${r.ci95[0]}`);
  assert.ok(r.p < 0.01, `p should be small, got ${r.p}`);
});

test("pairedComparison does not manufacture significance from a wash", () => {
  // Equal numbers up and down: the mean is 0 and the interval must straddle it.
  const deltas = [...new Array(50).fill(1), ...new Array(50).fill(-1)];
  const r = pairedComparison(deltas, { iterations: 4000 });
  assert.equal(r.delta, 0);
  assert.ok(r.ci95[0] < 0 && r.ci95[1] > 0, `CI should straddle 0, got ${JSON.stringify(r.ci95)}`);
  assert.ok(r.p > 0.5, `p should be large, got ${r.p}`);
});

test("pairedComparison never reports p = 0 — no permutation test licenses that", () => {
  const r = pairedComparison(new Array(300).fill(1), { iterations: 1000 });
  assert.ok(r.p > 0, "p must be strictly positive");
});

test("pairedComparison is reproducible across calls with the same seed", () => {
  const deltas = [1, 0, 1, -1, 0, 1, 0, 0, 1, -1];
  const a = pairedComparison(deltas, { iterations: 1000, seed: 7 });
  const b = pairedComparison(deltas, { iterations: 1000, seed: 7 });
  assert.deepEqual(a, b);
});

test("pairedComparison on an empty sample is neutral, not a crash", () => {
  const r = pairedComparison([]);
  assert.equal(r.n, 0);
  assert.equal(r.delta, 0);
  assert.equal(r.p, 1);
});

test("sliceBy partitions without dropping or duplicating a row", () => {
  const rows = [{ l: "de" }, { l: "en" }, { l: "de" }];
  const out = sliceBy(rows, (r) => r.l);
  assert.equal(out.de.length, 2);
  assert.equal(out.en.length, 1);
  assert.equal(Object.values(out).flat().length, rows.length);
});

// ── the case partition ─────────────────────────────────────────────────────

function goldCase(over: Partial<GoldCase>): GoldCase {
  return {
    id: "x",
    query: "q",
    origin_type: "harvested",
    authoring_mode: "test",
    origin_ref_hash: "h",
    lang: "de",
    has_identifier: false,
    expected_ids: ["m1"],
    acceptable_alternatives: [],
    expected_zone: "core",
    no_answer: false,
    scope: null,
    time_view: null,
    allowed_retrieval_depth: 3,
    rationale: "r",
    kind: "descriptive",
    labelled_at: "2026-09-09",
    labelled_by: "test",
    ...over,
  } as GoldCase;
}

test("partitionCases: probes are excluded, no_answer is kept apart as the guard", () => {
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
});

test("partitionCases refuses a case that claims an answer but names no id", () => {
  const p = partitionCases([goldCase({ id: "a", expected_ids: [] })]);
  assert.equal(p.answerable.length, 0, "an empty expected_ids cannot be scored as a hit");
});

// ── passages: the registered free parameter ────────────────────────────────

function memo(over: Partial<{ title: string; summary: string; body: string }> = {}): Memory {
  return {
    fm: { title: over.title ?? "Titel", summary: over.summary ?? "Zusammenfassung" },
    body: over.body ?? "B".repeat(1000),
  } as unknown as Memory;
}

test("passageFor short mode omits the body entirely — the 80-token variant", () => {
  const p = passageFor(memo(), "short");
  assert.equal(p, "Titel\nZusammenfassung");
  assert.ok(!p.includes("B"));
});

test("passageFor body mode adds exactly BODY_CHARS of body", () => {
  const p = passageFor(memo(), "body");
  assert.ok(p.startsWith("Titel\nZusammenfassung\n"));
  assert.equal(p.length - "Titel\nZusammenfassung\n".length, BODY_CHARS);
});

test("passageFor drops empty fields rather than emitting blank lines", () => {
  assert.equal(passageFor(memo({ summary: "" }), "short"), "Titel");
});

// ── the model registry is a guard, not a catalogue ─────────────────────────

test("ms-marco is registered as English-only — measured, and the reason it is not the main arm", () => {
  assert.deepEqual([...MODELS["ms-marco"].languages], ["en"]);
  assert.ok(MODELS["en-de"].languages.includes("de"));
  assert.ok(MODELS["bge"].languages.includes("de"));
});

test("the main arm is pinned to fp32 — its repo ships no quantized ONNX", () => {
  assert.equal(MODELS["en-de"].dtype, "fp32");
});

// ── the seam that keeps the model out of the tests ─────────────────────────

test("a stub PairScorer drives the same rerank path the real model does", async () => {
  // Scores the pool so that the LAST candidate wins — the shape of the thing
  // #501 hopes for: a gold that RRF buried climbs to rank 1.
  const stub: PairScorer = {
    id: "stub",
    loadMs: 0,
    async score(_q, passages) {
      return passages.map((_p, i) => i);
    },
    close() {},
  };
  const scores = await stub.score("q", POOL.slice(0, 4));
  const ranked = rerankWindow(POOL, 4, (_x, i) => scores[i]);
  assert.equal(ranked[0], "d");
  assert.equal(recallAny(POOL, new Set(["d"]), 3), 0, "baseline: the gold was outside the top 3");
  assert.equal(recallAny(ranked, new Set(["d"]), 3), 1, "reranked: it is inside");
});
