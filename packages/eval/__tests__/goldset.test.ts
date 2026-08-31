/**
 * The M0 gold set's two-step discipline (#262, §19).
 *
 * The rule these tests defend: a query is fixed BEFORE anyone opens the memory
 * it is supposed to retrieve. A paraphrase written while looking at its target
 * is a paraphrase of the answer, and measuring retrieval against it measures
 * how well the index finds text derived from itself.
 *
 * Run: npx tsx --test packages/eval/__tests__/goldset.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkGoldCases,
  checkGoldShape,
  checkLabels,
  checkStaged,
  coverage,
  detectLang,
  hasIdentifier,
  originRefHash,
  stagedId,
  type GoldCase,
  type GoldLabel,
  type StagedQuery,
} from "../src/goldset.js";
import { harvestFromEvents } from "../src/goldset-harvest.js";
import { mergeCases, templateFor } from "../src/goldset-label.js";
import { stageBlind } from "../src/goldset-blind.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const staged = (q: string, over: Partial<StagedQuery> = {}): StagedQuery => ({
  id: stagedId(q),
  query: q,
  origin_type: "user_query",
  authoring_mode: "verbatim from a real recall",
  origin_ref_hash: originRefHash("ref"),
  lang: detectLang(q),
  has_identifier: hasIdentifier(q),
  ...over,
});

const label = (id: string, over: Partial<GoldLabel> = {}): GoldLabel => ({
  staged_id: id,
  expected_ids: ["m1"],
  acceptable_alternatives: [],
  expected_zone: "orbit",
  no_answer: false,
  scope: null,
  time_view: null,
  allowed_retrieval_depth: 10,
  rationale: "m1 is the only memory stating this rule",
  kind: "descriptive",
  labelled_at: "2026-07-26",
  labelled_by: "Daniel",
  ...over,
});

test("a staged query carries provenance and no gold — the type cannot hold one", () => {
  const s = staged("wie war die regel für force pushes");
  assert.deepEqual(checkStaged([s]), []);
  // The gold is genuinely absent, not merely empty: there is no field for it.
  assert.equal("expected_ids" in s, false);
  assert.equal(s.id, stagedId(s.query), "the id is the query's hash, so re-harvesting is idempotent");
});

test("provenance is enforced, not decorative", () => {
  assert.ok(
    checkStaged([staged("q", { origin_type: "vibes" as unknown as StagedQuery["origin_type"] })])
      .some((i) => /five §19 sources/.test(i.problem)),
  );
  assert.ok(checkStaged([staged("q", { authoring_mode: "" })]).some((i) => /authoring_mode/.test(i.problem)));
  assert.ok(
    checkStaged([staged("q", { origin_ref_hash: "not-a-hash" })]).some((i) => /sha256/.test(i.problem)),
    "the reference must be hashed — raw local paths never travel (§19)",
  );

  const s = staged("q");
  assert.ok(
    checkStaged([s, { ...s }]).some((i) => /duplicate/.test(i.problem)),
    "the same query twice is one case, not two",
  );
});

test("a label that grades nothing, or contradicts itself, is rejected", () => {
  const s = staged("wie war die regel für force pushes");
  assert.deepEqual(checkLabels([label(s.id)], [s]), []);

  const bad = (over: Partial<GoldLabel>) => checkLabels([label(s.id, over)], [s]).map((i) => i.problem).join(" | ");
  assert.match(bad({ rationale: "" }), /rationale is mandatory/);
  assert.match(bad({ no_answer: true }), /no_answer case cannot expect ids/);
  assert.match(bad({ expected_ids: [] }), /grades nothing/);
  assert.match(bad({ allowed_retrieval_depth: 0 }), /positive integer/);
  assert.match(
    bad({ expected_ids: ["m1"], acceptable_alternatives: ["m1"] }),
    /both expected and merely acceptable/,
  );
  assert.match(
    checkLabels([label("no-such-query")], [s]).map((i) => i.problem).join(" | "),
    /the two steps drifted apart/,
    "a label pointing at nothing means the staged file changed under it",
  );
});

test("a no-answer case is a real case: no ids expected, and it still needs a rationale", () => {
  const s = staged("what did we decide about the kubernetes migration");
  const l = label(s.id, { no_answer: true, expected_ids: [], rationale: "nothing in the vault covers kubernetes" });
  assert.deepEqual(checkLabels([l], [s]), []);
});

test("language detection keeps `mixed` meaningful instead of swallowing keyword chains", () => {
  assert.equal(detectLang("wie war die regel für force pushes"), "de");
  assert.equal(detectLang("how should the daemon handle a restart"), "en");
  assert.equal(detectLang("wie ist das mit dem daemon restart handling and why"), "mixed");
  // The case that forced the fourth value: a hook-built keyword chain is not in
  // a language at all, and filing it as `mixed` put 94% of a real harvest into
  // one bucket.
  assert.equal(detectLang("memory format schema json yaml markdown frontmatter structure"), "neutral");
});

test("identifier detection finds the exact-lookup cases §19 asks for", () => {
  assert.ok(hasIdentifier("warum wirft packages/core/src/search.ts einen fehler"));
  assert.ok(hasIdentifier("was war der fix in #253"));
  assert.ok(hasIdentifier("recall-when-expanded boost drift"));
  assert.ok(hasIdentifier("commit 7a891d8 was war da"));
  assert.equal(hasIdentifier("wie war das mit dem pinnen"), false);
});

test("the harvester takes queries from telemetry and never a gold id", () => {
  const dir = mkdtempSync(join(tmpdir(), "goldset-harvest-"));
  const file = join(dir, "events-2026-07-26.jsonl");
  writeFileSync(
    file,
    [
      // A deliberate MCP recall and a hook-derived one map to different origins.
      JSON.stringify({ kind: "recall", query: "wie war die regel für force pushes", recall_id: "r1", ts: 1 }),
      JSON.stringify({ kind: "hook_recall", query: "daemon restart nach core-änderung", recall_id: "r2", ts: 2 }),
      // The event also records what the system answered. Carrying that over
      // would bias selection toward queries the system already handles.
      JSON.stringify({ kind: "recall", query: "pinning und floors lifecycle regeln", hits: ["m1", "m2"], ts: 3 }),
      JSON.stringify({ kind: "recall", query: "kurz", ts: 4 }),
      JSON.stringify({ kind: "recall", query: "wie war die regel für force pushes", ts: 5 }),
      JSON.stringify({ kind: "save", query: "not a recall", ts: 6 }),
      "{ not json",
    ].join("\n") + "\n",
    "utf8",
  );

  const r = harvestFromEvents([file], 100, 12);
  assert.equal(r.staged.length, 3, "two duplicates and one too-short query drop out");
  assert.equal(r.skippedDuplicate, 1);
  assert.equal(r.skippedShort, 1);
  assert.deepEqual(checkStaged(r.staged), []);

  for (const s of r.staged) {
    assert.equal("hits" in s, false, "the system's own answer never reaches the staged query");
    assert.equal("expected_ids" in s, false);
  }
  const origins = new Set(r.staged.map((s) => s.origin_type));
  assert.ok(origins.has("user_query") && origins.has("session_transcript"), "the event kind decides the origin");
});

test("the template offers every §19 field empty, so none is silently skipped", () => {
  const s = staged("wie war die regel für force pushes");
  const t = templateFor(s);
  assert.equal(t.staged_id, s.id);
  assert.equal(t.rationale, "", "empty and required — the checker refuses it until it is filled");
  assert.equal(t.labelled_by, "");
  assert.ok(checkLabels([t], [s]).some((i) => /rationale is mandatory/.test(i.problem)));
});

test("merging joins the two steps and the coverage names what is still missing", () => {
  const a = staged("wie war die regel für force pushes");
  const b = staged("what did we decide about the kubernetes migration");
  const cases = mergeCases(
    [a, b],
    [
      label(a.id, { kind: "descriptive" }),
      label(b.id, { kind: "associative", no_answer: true, expected_ids: [], rationale: "nothing covers it" }),
    ],
  );

  assert.equal(cases.length, 2);
  assert.equal(cases[0].query, a.query, "the query travels from step 1");
  assert.equal(cases[0].origin_type, "user_query", "and so does its provenance");
  assert.equal("staged_id" in cases[0], false, "the join key does not survive into the case");

  const cov = coverage(cases as GoldCase[]);
  assert.equal(cov.total, 2);
  assert.equal(cov.no_answer, 1);
  assert.equal(cov.by_kind.descriptive, 1);
  assert.equal(cov.by_kind.associative, 1);
  assert.equal(cov.non_application, 0, "C-036 cases are still missing, and the count says so");
  assert.equal(cov.probes, 0, "nothing here is a probe");
  assert.equal(cov.total_with_probes, 2, "and so the two totals agree");
});

test("a probe is counted beside the set, never inside it", () => {
  const real = staged("wie war die regel für force pushes");
  const noise = staged("zebra quantum marmalade orchestra");
  const diag = staged("body-loss diagnostic interleave churn four connection state");
  const cases = mergeCases(
    [real, noise, diag],
    [
      label(real.id),
      label(noise.id, {
        no_answer: true, expected_ids: [], rationale: "none of the tokens occurs in the vault",
        probe_group: "gibberish-probe",
      }),
      label(diag.id, { probe_group: "body-loss" }),
    ],
  );

  const cov = coverage(cases as GoldCase[]);
  assert.equal(cov.total, 1, "the main denominator is the one query somebody actually asked");
  assert.equal(cov.total_with_probes, 3, "while the file still holds three cases");
  assert.equal(cov.probes, 2);
  assert.deepEqual(cov.by_probe_group, { "gibberish-probe": 1, "body-loss": 1 });
  assert.equal(
    cov.no_answer, 0,
    "a nonsense string must not make the set's no-answer share look healthier than it is",
  );
  assert.equal(cov.by_kind.descriptive, 1, "and probes do not pad the kind counts either");
});

test("probe_group is optional, but a typo in it is not silently accepted", () => {
  const s = staged("wie war die regel für force pushes");
  assert.deepEqual(checkLabels([label(s.id)], [s]), [], "absent is the normal case");
  assert.deepEqual(
    checkLabels([label(s.id, { probe_group: "body-loss" })], [s]), [],
    "a known group passes",
  );
  assert.match(
    checkLabels([label(s.id, { probe_group: "bodyloss" as GoldLabel["probe_group"] })], [s])
      .map((i) => i.problem).join(" | "),
    /unknown probe_group/,
    "a typo would silently move the case out of the main denominator",
  );
});

test("the no-answer aid is derived from the engine's verdict and stays OUT of step 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "goldset-aid-"));
  const file = join(dir, "events-2026-07-26.jsonl");
  writeFileSync(
    file,
    [
      // Never answered: a genuine no-answer candidate.
      JSON.stringify({ kind: "recall", query: "was haben wir zu kubernetes entschieden", hit_count: 0, ts: 1 }),
      // Answered once, empty another time — NOT a candidate. Only the full
      // history shows that, which is why every occurrence is tracked.
      JSON.stringify({ kind: "recall", query: "wie war die regel für force pushes", hit_count: 0, ts: 2 }),
      JSON.stringify({ kind: "recall", query: "wie war die regel für force pushes", top_score: 140, ts: 3 }),
      // Above the floor throughout.
      JSON.stringify({ kind: "recall", query: "pinning und floors lifecycle regeln", top_score: 120, ts: 4 }),
    ].join("\n") + "\n",
    "utf8",
  );

  const r = harvestFromEvents([file], 100, 12);
  assert.deepEqual(
    r.noAnswerCandidates,
    [stagedId("was haben wir zu kubernetes entschieden")],
    "a query answered even once is not a no-answer candidate",
  );
  for (const s of r.staged) {
    assert.equal("no_answer" in s, false, "the engine's verdict never becomes a field on a staged query");
    assert.equal("no_answer_candidate" in s, false);
  }
});

test("the blind intake stamps who and how, and refuses a harvested origin", () => {
  const lines = [
    "# paraphrases",
    "wie war die regel für force pushes nochmal",
    "",
    "what did we decide about the kubernetes migration",
    "wie war die regel für force pushes nochmal",
  ];
  const staged = stageBlind(lines, "second_person", "Sali", "wrote them from memory, vault closed", "q.txt");

  assert.equal(staged.length, 2, "comments, blanks and the repeat drop out");
  assert.deepEqual(checkStaged(staged), []);
  assert.match(staged[0].authoring_mode, /vault closed/);
  assert.match(staged[0].authoring_mode, /authored by Sali/, "a blind batch is only as good as who vouches for it");
  assert.equal(staged[0].origin_type, "second_person");
  assert.equal(staged[0].lang, "de");
  assert.equal(staged[1].lang, "en", "the language balance a harvest cannot deliver comes from here");
});

test("hook-composed strings are not formulations and never reach the set", () => {
  const dir = mkdtempSync(join(tmpdir(), "goldset-tmpl-"));
  const file = join(dir, "events-2026-07-26.jsonl");
  writeFileSync(
    file,
    [
      // The PreToolUse hook composes these from file type + tags. Real traffic,
      // worth measuring — but nobody formulated them, and on the live logs they
      // were 112 of 400 staged queries.
      JSON.stringify({ kind: "hook_recall", query: "editing ts involving typescript, daemon, testing", ts: 1 }),
      JSON.stringify({ kind: "hook_recall", query: "writing css involving css, styles, flexbox, layout", ts: 2 }),
      JSON.stringify({ kind: "hook_recall", query: "CarNexus active context project-facts decisions", ts: 3 }),
      JSON.stringify({ kind: "hook_recall", query: "bastra-pro preferences user-preference active context", ts: 4 }),
      // A question somebody actually asked survives.
      JSON.stringify({ kind: "recall", query: "readabilityHandler subprocess pipe blocking read", ts: 5 }),
    ].join("\n") + "\n",
    "utf8",
  );

  const r = harvestFromEvents([file], 100, 12);
  assert.equal(r.skippedTemplate, 4);
  assert.deepEqual(
    r.staged.map((s) => s.query),
    ["readabilityHandler subprocess pipe blocking read"],
    "a quarter of the set being one machine sentence with the nouns swapped is not coverage",
  );
});

/**
 * A finished, well-formed gold case — the shape a gold FILE holds, not the two
 * halves the authoring pipeline joins. Overrides are deliberately typed loosely
 * so a test can put a wrong TYPE in a field, which is the whole point of #434.
 */
const goldCase = (q: string, over: Record<string, unknown> = {}): unknown => ({
  ...staged(q),
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

test("a well-formed gold case passes both validation layers (#434)", () => {
  assert.deepEqual(checkGoldCases([goldCase("wie war die regel für force pushes")]), []);
});

test("wrong field TYPES are caught before the semantic checks see them (#434)", () => {
  // Codex' repro cases: each of these returned zero issues on ea3a910, because
  // checkStaged/checkLabels answer "is this label admissible", not "is this the
  // right type".
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["has_identifier", { has_identifier: "false" }, /has_identifier must be a boolean/],
    ["scope", { scope: 42 }, /scope must be a string or null/],
    ["labelled_at", { labelled_at: "yesterday" }, /labelled_at must be a YYYY-MM-DD date/],
    ["no_answer", { no_answer: "nein" }, /no_answer must be a boolean/],
    ["time_view", { time_view: 7 }, /time_view must be a string or null/],
    ["allowed_retrieval_depth", { allowed_retrieval_depth: "3" }, /allowed_retrieval_depth must be a number/],
    ["labelled_by", { labelled_by: "  " }, /labelled_by must be a non-empty string/],
    ["probe_group", { probe_group: 1 }, /probe_group must be a string when present/],
    ["non_application", { correct_answer_is_non_application: "ja" }, /correct_answer_is_non_application must be a boolean/],
  ];
  for (const [field, over, expected] of cases) {
    const issues = checkGoldCases([goldCase("eine frage", over)]);
    assert.ok(issues.length > 0, `${field} with a wrong type must be reported`);
    assert.match(issues.map((i) => i.problem).join(" | "), expected);
  }
});

test("an unknown language is reported rather than counted (#434)", () => {
  // `lang` had no value check anywhere: the shape guard sees a string and waves
  // it through, so the enum check belongs with the other §19 enums.
  const issues = checkGoldCases([goldCase("eine frage", { lang: "englisch" })]);
  assert.match(issues.map((i) => i.problem).join(" | "), /lang `englisch` is not one of de, en, mixed, neutral/);
  for (const lang of ["de", "en", "mixed", "neutral"]) {
    assert.deepEqual(checkGoldCases([goldCase("eine frage", { lang })]), [], `${lang} is admissible`);
  }
});

test("a missing or non-array id list is a dataset error, never an exception (#434)", () => {
  // These used to throw MID-validation: every later check reads .length or
  // .filter on them, so the caller got a TypeError instead of a report.
  for (const over of [
    { expected_ids: undefined },
    { expected_ids: "m1" },
    { expected_ids: ["m1", 7] },
    { acceptable_alternatives: undefined },
    { acceptable_alternatives: {} },
  ]) {
    const field = "expected_ids" in over ? "expected_ids" : "acceptable_alternatives";
    let issues: ReturnType<typeof checkGoldCases> = [];
    assert.doesNotThrow(() => { issues = checkGoldCases([goldCase("eine frage", over)]); }, `${field} must not throw`);
    assert.match(issues.map((i) => i.problem).join(" | "), new RegExp(`${field} must be an array of strings`));
  }
});

test("a case that is not an object at all is reported by position (#434)", () => {
  for (const raw of [null, 42, "a string", ["nested"]]) {
    const issues = checkGoldShape([raw]);
    assert.deepEqual(issues, [{ where: "case #0", problem: "is not a JSON object" }]);
  }
});

test("a broken shape short-circuits the semantic checks (#434)", () => {
  // Both layers would have something to say here; only the shape layer reports,
  // because the semantic checks cannot be trusted on input they never expected.
  const issues = checkGoldCases([goldCase("eine frage", { expected_ids: undefined, kind: "erzaehlend" })]);
  assert.match(issues.map((i) => i.problem).join(" | "), /expected_ids must be an array of strings/);
  assert.ok(
    !issues.some((i) => /unknown kind/.test(i.problem)),
    "the semantic layer does not run on a broken shape",
  );
});

test("the three composed families the English regex missed are filtered too (#413)", () => {
  const dir = mkdtempSync(join(tmpdir(), "goldset-tmpl-413-"));
  const file = join(dir, "events-2026-08-29.jsonl");
  writeFileSync(
    file,
    [
      // The language-neutral default of #231 — the SHIPPED composition since
      // then, and the one the old three regexes let through completely.
      JSON.stringify({ kind: "hook_recall", query: "html markup daemon input form button", ts: 1 }),
      JSON.stringify({ kind: "hook_recall", query: "css styles daemon overflow scrollbar", ts: 2 }),
      JSON.stringify({ kind: "hook_recall", query: "mjs javascript esm script sql query crypto", ts: 3 }),
      // The English template with an empty topic list: no ` involving `, so the
      // first regex never matched it.
      JSON.stringify({ kind: "hook_recall", query: "editing command", ts: 4 }),
      JSON.stringify({ kind: "hook_recall", query: "writing CODEOWNERS", ts: 5 }),
      // The bash lane before 22.08.2026 padded a command label with filler.
      JSON.stringify({ kind: "hook_recall", query: "git reset --hard safety workflow user-preference", ts: 6 }),
      JSON.stringify({ kind: "hook_recall", query: "DROP TABLE safety workflow user-preference", ts: 7 }),
      // And the queries a person actually typed survive — including a keyword
      // chain, which is what most real telemetry queries look like. Separating
      // those from a composed one is exactly why the filter reads the hook's
      // vocabulary instead of the shape.
      JSON.stringify({ kind: "recall", query: "readabilityHandler subprocess pipe blocking read", ts: 8 }),
      JSON.stringify({ kind: "recall", query: "wie war die regel für force pushes", ts: 9 }),
    ].join("\n") + "\n",
    "utf8",
  );

  const r = harvestFromEvents([file], 100, 12);
  assert.equal(r.skippedTemplate, 7, "all three composed families are recognised");
  assert.deepEqual(
    r.staged.map((s) => s.query),
    ["readabilityHandler subprocess pipe blocking read", "wie war die regel für force pushes"],
    "and nothing a person formulated is dropped with them",
  );
});

test("a keyword chain outside the hook vocabulary is a real query (#413)", () => {
  const dir = mkdtempSync(join(tmpdir(), "goldset-tmpl-vocab-"));
  const file = join(dir, "events-2026-08-29.jsonl");
  writeFileSync(
    file,
    [
      // Same SHAPE as the neutral composition — lowercase words joined by
      // spaces — but the words are not the hook's. A shape rule would have
      // eaten this; membership does not.
      JSON.stringify({ kind: "recall", query: "chokidar glob watcher silently stops", ts: 1 }),
      // One token from the vocabulary is not enough either.
      JSON.stringify({ kind: "recall", query: "daemon restart nach dem deploy vergessen", ts: 2 }),
    ].join("\n") + "\n",
    "utf8",
  );

  const r = harvestFromEvents([file], 100, 12);
  assert.equal(r.skippedTemplate, 0);
  assert.equal(r.staged.length, 2, "the language-neutral cases the set needs must survive");
});

test("German prose without the old fifteen markers is German, not neutral (#423)", () => {
  // The issue's own example: not one of der|die|das|und|nicht|wie|warum|beim|
  // nach|für|mit|von|ist|wird|soll appears in it.
  assert.equal(detectLang("Welcher Fehler hat mich einen ganzen Samstag gekostet?"), "de");
  for (const q of [
    "Was zählt als echter Beleg dafür, dass eine Erinnerung geholfen hat",
    "Welche Semantik hat CURATOR_DEMOTION_MULTIPLIER in search.ts",
    "Worauf achten wir, bevor wir zwei Auswertungen nebeneinanderstellen",
  ]) {
    assert.equal(detectLang(q), "de", q);
  }
  for (const q of [
    "What makes cloud-mounted vaults switch to polling",
    "What decides whether embeddings use Ollama, OpenAI, or nothing",
  ]) {
    assert.equal(detectLang(q), "en", q);
  }
});

test("a borrowed identifier does not make a sentence bilingual (#423)", () => {
  // Identifier fragments split like words and would vote like them: `by` out of
  // `survival-by-id`, `no` out of `no-answer`. A second language needs weight.
  assert.equal(detectLang("Welche Garantie prüft survival-by-id.test.ts beim Entpinnen"), "de");
  assert.equal(detectLang("Warum wurde #230 als no-answer Problem eröffnet"), "de");
  assert.equal(detectLang("Wie konnte das Anheben einer fremden Abhängigkeit still etwas lahmlegen"), "de");
  // A genuinely bilingual query still reads as one.
  assert.equal(detectLang("what is the diff für diese Datei"), "mixed");
});

test("keyword chains stay neutral — the bucket exists for them (#423)", () => {
  // 94% of a harvest is this shape, and calling it a language would make the
  // language balance meaningless.
  for (const q of [
    "memory format schema json yaml markdown frontmatter structure",
    "readabilityHandler subprocess pipe blocking read",
    "NSPanel resignKey Observer attachedSheet",
  ]) {
    assert.equal(detectLang(q), "neutral", q);
  }
});
