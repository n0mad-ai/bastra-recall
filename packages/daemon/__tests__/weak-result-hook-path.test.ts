/**
 * #249 — the "nothing really matched" flag has to reach the hook path.
 *
 * `/api/v1/recall` reported `weak_result`; `/hook/recall` never formed it. That
 * is the path writing `<recall-hints>` into the agent's context on every Bash
 * and Edit, so the formatters labelled everything above the threshold "Strong
 * matches" — including hits that only ranked first because a list always has a
 * first element. In a live session the same unrelated memories surfaced at
 * 150-160 for every `rm -rf` and every file edit.
 *
 * The measurement that made it urgent: over 3,126 real recalls in a week,
 * `weak_result: true` appeared **zero** times. Not because recall was healthy —
 * because the hook path never formed it and nothing wrote it to telemetry.
 *
 * Runner: `tsx --test __tests__/weak-result-hook-path.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RecallHit } from "@bastra-recall/core";
import { isWeakResult, isNoHome, hitTitleMatches } from "@bastra-recall/core";

const hit = (over: Partial<RecallHit> = {}): RecallHit => ({
  id: "some-memory",
  title: "Ein Memory über Deployment",
  type: "lesson",
  scope: "proj",
  summary: "Zusammenfassung",
  topic_path: ["proj"],
  score: 160,
  matched_terms: [],
  ...over,
});

test("#249: hits that only rank — no trigger, no title match — are weak", () => {
  const hits = [hit({ matched_terms: ["xqzptv"] }), hit({ id: "other", matched_terms: ["xqzptv"] })];
  assert.equal(isWeakResult(hits, true), true, "a high score alone is not a match");
});

test("#249: a recall_when match is never weak — the author declared that trigger", () => {
  const hits = [hit({ matched_recall_when: true, matched_terms: [] })];
  assert.equal(isWeakResult(hits, true), false);
});

test("#249: a title match is never weak", () => {
  const hits = [hit({ matched_terms: ["deployment"] })];
  assert.equal(isWeakResult(hits, true), false, "'deployment' is in the title");
});

test("#249: ONE anchored hit is enough — the block carries real signal", () => {
  const hits = [
    hit({ id: "noise-1", matched_terms: ["xqzptv"] }),
    hit({ id: "real", matched_recall_when: true }),
    hit({ id: "noise-2", matched_terms: ["xqzptv"] }),
  ];
  assert.equal(isWeakResult(hits, false || true), false);
});

test("#249: BM25-only mode is never weak — there the score is a real BM25 quantity", () => {
  const hits = [hit({ matched_terms: ["xqzptv"] })];
  assert.equal(
    isWeakResult(hits, false),
    false,
    "the flag is hybrid-only; in BM25 mode the floor already does this job",
  );
});

test("#249: no hits is not weak — that is a different (and honest) answer", () => {
  assert.equal(isWeakResult([], true), false, "empty means empty, not 'answered with noise'");
});

test("#249: title matching absorbs stemming in both directions", () => {
  assert.equal(hitTitleMatches(hit({ matched_terms: ["deploy"] })), true, "prefix of a title token");
  assert.equal(hitTitleMatches(hit({ matched_terms: ["deploymentstrategie"] })), true, "title token is the prefix");
  assert.equal(hitTitleMatches(hit({ matched_terms: ["kamera"] })), false, "unrelated term");
});

test("#249: no matched_terms at all cannot be a title match", () => {
  assert.equal(hitTitleMatches(hit({ matched_terms: [] })), false);
  assert.equal(hitTitleMatches(hit({ matched_terms: undefined })), false);
});

test("#249: title matching is diacritic- and case-tolerant", () => {
  const h = hit({ title: "Größe der Lösung", matched_terms: ["größe"] });
  assert.equal(hitTitleMatches(h), true);
  assert.equal(hitTitleMatches(hit({ title: "Größe der Lösung", matched_terms: ["GRÖSSE"] })), false,
    "ß and SS are different tokens — the tolerance is about case and stemming, not transliteration");
});

// ─── #230: no_home — the stricter claim ──────────────────────────────────
// Not just "nothing anchored" but "this fact has no home in the vault". The
// distinction matters because a miss splits in two: rank-1-of-WRONG (a real
// both-arms pair on the wrong document — engine-invisible, client-side) and
// rank-1-of-NOTHING (the top hit lives in one arm only). Only the second is
// detectable from the score, and only via the rank pair — a "flat score
// distribution" heuristic INVERTS on real data, because a genuine home spikes
// to the both-arms ceiling with siblings crowding just behind it.

const withRrf = (rank_bm25: number | null, rank_vector: number | null, over: Partial<RecallHit> = {}) =>
  hit({ matched_terms: ["xqzptv"], rrf: { rank_bm25, rank_vector, raw: 0.016 }, ...over });

test("#230: a top hit in ONE arm only is no_home", () => {
  assert.equal(isNoHome([withRrf(1, null)], true), true, "BM25 only");
  assert.equal(isNoHome([withRrf(null, 1)], true), true, "vector only");
});

test("#230: a both-arms top hit is NOT no_home — that is rank-1-of-wrong, not of nothing", () => {
  // The `arch firewall` case: a legitimate pair (rank 1 + rank 4) on the wrong
  // document. No score-only signal can catch it, and claiming otherwise would
  // make the flag lie.
  assert.equal(isNoHome([withRrf(1, 4)], true), false);
});

test("#230: no_home is a STRICT SUBSET of weak_result", () => {
  // An anchored hit is never weak, so it can never be no_home either — no
  // matter what its rank pair looks like.
  const anchored = withRrf(1, null, { matched_recall_when: true });
  assert.equal(isWeakResult([anchored], true), false);
  assert.equal(isNoHome([anchored], true), false, "no_home must not fire where weak_result does not");
});

test("#230: commons hits carry no rrf block and must not read as one-armed", () => {
  // Commons results come through the BM25 path without an rrf block. Treating
  // "no rank pair" as "one arm" would flag every commons-fused recall.
  const commonsHit = hit({ matched_terms: ["xqzptv"] }); // no .rrf
  assert.equal(isWeakResult([commonsHit], true), true, "still weak — nothing anchored");
  assert.equal(isNoHome([commonsHit], true), false, "but not no_home: we cannot tell");
});

test("#230: BM25-only mode is never no_home", () => {
  assert.equal(isNoHome([withRrf(1, null)], false), false);
});

test("#230: only the TOP hit decides — lower hits do not vote", () => {
  const hits = [withRrf(1, 2), withRrf(null, 5, { id: "second" })];
  assert.equal(isNoHome(hits, true), false, "the top hit is in both arms, so there is a home");
});
