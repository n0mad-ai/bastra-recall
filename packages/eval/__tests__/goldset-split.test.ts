import { test } from "node:test";
import assert from "node:assert/strict";
import { splitGoldCases } from "../src/goldset-split.js";
import type { GoldCase } from "../src/goldset.js";

const REGISTERED = { seed: 20260828, selectionShare: 0.3, stratifyBy: ["origin_type", "lang"] } as const;

const c = (id: string, over: Partial<GoldCase> = {}): GoldCase => ({
  id,
  query: `q-${id}`,
  origin_type: "session_transcript",
  authoring_mode: "test",
  origin_ref_hash: "0".repeat(64),
  lang: "neutral",
  has_identifier: false,
  expected_ids: ["m1"],
  acceptable_alternatives: [],
  expected_zone: "orbit",
  no_answer: false,
  scope: null,
  time_view: null,
  allowed_retrieval_depth: 10,
  rationale: "test",
  kind: "descriptive",
  labelled_at: "2026-08-28",
  labelled_by: "test",
  ...over,
});

/** 100 cases across two origins and two languages. */
const corpus = (): GoldCase[] => [
  ...Array.from({ length: 40 }, (_, i) => c(`a${i}`, { origin_type: "session_transcript", lang: "neutral" })),
  ...Array.from({ length: 30 }, (_, i) => c(`b${i}`, { origin_type: "second_person", lang: "de" })),
  ...Array.from({ length: 20 }, (_, i) => c(`c${i}`, { origin_type: "second_person", lang: "en" })),
  ...Array.from({ length: 10 }, (_, i) => c(`d${i}`, { origin_type: "user_query", lang: "neutral" })),
];

test("the same seed reproduces the same split, byte for byte", () => {
  const one = splitGoldCases(corpus(), REGISTERED);
  const two = splitGoldCases(corpus(), REGISTERED);
  assert.deepEqual(one.selection.map((x) => x.id), two.selection.map((x) => x.id));
  assert.deepEqual(one.holdout.map((x) => x.id), two.holdout.map((x) => x.id));

  // A split that moves between runs is not a registered split.
  const other = splitGoldCases(corpus(), { ...REGISTERED, seed: 1 });
  assert.notDeepEqual(one.selection.map((x) => x.id), other.selection.map((x) => x.id));
});

test("input order does not change the split", () => {
  const forward = splitGoldCases(corpus(), REGISTERED);
  const shuffled = splitGoldCases([...corpus()].reverse(), REGISTERED);
  assert.deepEqual(
    forward.selection.map((x) => x.id).sort(),
    shuffled.selection.map((x) => x.id).sort(),
    "concatenating the gold files in a different order must not move a single case",
  );
});

test("the proportions hold inside every stratum, not just in the aggregate", () => {
  const r = splitGoldCases(corpus(), REGISTERED);
  assert.equal(r.strata.length, 4, "two origins x two languages, as they occur");
  for (const s of r.strata) {
    assert.equal(s.selection, Math.round(s.total * 0.3), `${s.key} keeps its share`);
    assert.equal(s.selection + s.holdout, s.total, "no case falls between the parts");
  }
  // This is the point of stratifying: the hard origin is split like every other.
  const blind = r.strata.filter((s) => s.key.startsWith("second_person"));
  const blindSel = blind.reduce((a, s) => a + s.selection, 0);
  const blindTotal = blind.reduce((a, s) => a + s.total, 0);
  assert.equal(blindTotal, 50);
  assert.equal(blindSel, 15, "an unstratified draw could put anywhere from 0 to 50 of these on one side");
});

test("probes and no-answer cases never enter the split, and are reported", () => {
  const cases = [
    ...corpus(),
    c("p1", { probe_group: "gibberish-probe", no_answer: true, expected_ids: [] }),
    c("p2", { probe_group: "body-loss" }),
    c("n1", { no_answer: true, expected_ids: [] }),
  ];
  const r = splitGoldCases(cases, REGISTERED);
  assert.deepEqual(r.excluded, { probes: 2, no_answer: 1 });
  const all = [...r.selection, ...r.holdout].map((x) => x.id);
  assert.equal(all.length, 100, "only the eligible cases are split");
  for (const id of ["p1", "p2", "n1"]) assert.ok(!all.includes(id), `${id} stays out`);
});

test("a split without strata or with a degenerate share is refused", () => {
  assert.throws(
    () => splitGoldCases(corpus(), { ...REGISTERED, stratifyBy: [] }),
    /at least one field/,
    "a seed makes an unbalanced draw reproducible, not balanced",
  );
  for (const share of [0, 1, 1.5]) {
    assert.throws(() => splitGoldCases(corpus(), { ...REGISTERED, selectionShare: share }), /strictly between/);
  }
});

test("a stratifyBy field that does not vary over the pool is refused (#444)", () => {
  // `kind` passes the length check and names a factor that is not there: every
  // eligible case is descriptive, so the draw is unstratified with a seed.
  assert.throws(
    () => splitGoldCases(corpus(), { ...REGISTERED, stratifyBy: ["origin_type", "kind"] }),
    /`kind` is constant over the eligible pool/,
  );
  // The check runs on the ELIGIBLE pool: a field that varies only across the
  // excluded cases still names nothing the split can balance.
  const withProbe = [
    ...corpus(),
    c("p1", { probe_group: "gibberish-probe", kind: "associative" }),
  ];
  assert.throws(
    () => splitGoldCases(withProbe, { ...REGISTERED, stratifyBy: ["origin_type", "kind"] }),
    /`kind` is constant over the eligible pool/,
  );
  // And the registered configuration is unaffected.
  assert.equal(splitGoldCases(corpus(), REGISTERED).strata.length, 4);
});

test("a stratum too small for both halves is coalesced, not silently one-sided (#444)", () => {
  // The shape the real gold set has: `user_query|en` holds exactly one case,
  // and round(1 x 0.3) puts it entirely in the holdout.
  const cases = [...corpus(), c("lonely", { origin_type: "user_query", lang: "en" })];
  const r = splitGoldCases(cases, REGISTERED);

  for (const s of r.strata) {
    assert.ok(s.selection > 0 && s.holdout > 0, `${s.key} reaches both halves`);
  }
  assert.ok(
    !r.strata.some((s) => s.key === "user_query|en"),
    "the stratum of one does not survive as its own stratum",
  );

  // It merged into its largest sibling under the same origin — origin is the
  // factor the M0 variance sits on, so `lang` is what gets backed off.
  const target = r.strata.find((s) => s.coalesced_from?.includes("user_query|en"));
  assert.ok(target, "the merge is reported, not dropped");
  assert.equal(target.key, "user_query|neutral", "the largest sibling under the same origin");
  assert.equal(target.total, 11, "the lonely case is inside it");

  // The case itself is still split, exactly once.
  const all = [...r.selection, ...r.holdout].map((x) => x.id);
  assert.equal(all.filter((id) => id === "lonely").length, 1);
  assert.equal(all.length, 101);
});

test("a pool too small for the split is refused rather than coalesced into a lottery (#444)", () => {
  // Two cases under two different origins. Coalescing them would fuse the very
  // factor the split balances, so the leading field is never backed off and
  // this is refused instead of quietly becoming an unstratified draw.
  const tiny = [
    c("x1", { origin_type: "user_query", lang: "de" }),
    c("x2", { origin_type: "second_person", lang: "en" }),
  ];
  assert.throws(() => splitGoldCases(tiny, REGISTERED), /cannot reach both halves even after coalescing/);
});
