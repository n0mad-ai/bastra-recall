import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EVIDENCE_ARMS, coversSpan, evidenceTokens, packEvidence, paragraphRanges, selectEvidenceWindow, sourceRevision } from "../src/evidence-windows.js";
import { runEvidenceExperiment, validateEvidenceCases, type EvidenceCase } from "../src/evidence-windows-run.js";

test("all arms count the serialized envelope and preserve exact source offsets", () => {
  const sources = [
    { id: "quote-\"\\", text: 'Emoji 🧠, 中文, "quotes", \\ and <|endoftext|>.\r\n\r\n'.repeat(90) },
    { id: "b", text: "The duration is 19 days.\n\nExcept legal holds: do not delete those." },
  ];
  for (const arm of EVIDENCE_ARMS) for (const budget of [evidenceTokens(JSON.stringify({ evidence: [] })), 100, 1024, 4096]) {
    const packed = packEvidence(sources, "duration legal holds", arm, budget);
    assert.ok(packed.tokens <= budget);
    assert.equal(packed.tokens, evidenceTokens(packed.serialized));
    assert.deepEqual(JSON.parse(packed.serialized), packed.payload);
    for (const e of packed.payload.evidence) {
      const source = sources.find(s => s.id === e.id)!;
      assert.equal(e.text, source.text.slice(e.start, e.end));
      assert.equal(e.revision, sourceRevision(source.text));
      assert.doesNotThrow(() => encodeURIComponent(e.text)); // throws URIError on lone surrogates, same check as String#isWellFormed (ES2024, outside eval's ES2022 lib)
    }
  }
});

test("query window includes complete adjacent exceptions and never silently clips it", () => {
  const text = "Introduction.\n\nOld guidance.\n\nThe retention duration is now 19 days.\n\nException: legal holds must never be deleted.\n\nFooter.";
  const e = selectEvidenceWindow({ id: "policy", text }, "retention duration", "query-window");
  assert.ok(e.text.includes("Old guidance."));
  assert.ok(e.text.includes("Exception: legal holds must never be deleted."));
  const tiny = packEvidence([{ id: "policy", text }], "retention duration", "query-window", 20);
  assert.equal(tiny.payload.evidence.length, 0);
});

test("paragraph ranges handle CRLF, blank whitespace and leading/trailing blanks", () => {
  const text = "\n\nFirst.\r\n \r\nSecond.\n\n";
  assert.deepEqual(paragraphRanges(text).map(r => text.slice(r.start, r.end)), ["First.", "Second."]);
});

test("expansion spends slack on complete sources without evicting selected evidence", () => {
  const sources = [{ id: "a", text: "Header.\n\nRetention duration: 19 days.\n\nDetails.\n\nMore details.\n\nRemote exception: no deletion under legal hold." },
    { id: "b", text: "Approval: archive team." }];
  const window = packEvidence(sources, "retention duration", "query-window", 1024);
  assert.ok(!window.payload.evidence[0].text.includes("Remote exception"));
  const expanded = packEvidence(sources, "retention duration", "query-expand", 1024);
  assert.deepEqual(expanded.payload.evidence.map(e => e.id), ["a", "b"]);
  assert.equal(expanded.payload.evidence[0].text, sources[0].text);
  assert.equal(expanded.partialSources, 0);
});

test("packing preserves source rank, deduplicates identical sources, rejects conflicting versions", () => {
  const a = { id: "a", text: "First small note." }, b = { id: "b", text: "Second small note." };
  assert.deepEqual(packEvidence([a, b, a], "", "query-window", 1024).payload.evidence.map(e => e.id), ["a", "b"]);
  assert.throws(() => packEvidence([a, { ...a, text: "Changed" }], "", "query-window", 1024), /conflicting/);
  for (const budget of [0, 1, NaN, Infinity, 3.5]) assert.throws(() => packEvidence([], "", "query-window", budget));
});

test("source presence cannot stand in for complete multi-source or qualified evidence", () => {
  const sources = [{ id: "a", text: "Duration is 19 days.\n\nException applies." }, { id: "b", text: "Owner is the archive team." }];
  const spans = sources.map(s => ({ id: s.id, start: 0, end: s.text.length, text: s.text }));
  const packed = packEvidence(sources.slice(0, 1), "duration", "whole-prefix", 1024);
  assert.equal(coversSpan(packed.payload.evidence, spans[0]), true);
  assert.equal(coversSpan(packed.payload.evidence, spans[1]), false);
  assert.equal(coversSpan(packed.payload.evidence, { ...spans[0], text: "wrong" }), false);
});

test("unlabelled and no-answer cases never become answer-accuracy successes", () => {
  const cases: EvidenceCase[] = [
    { id: "unlabelled", query: "Duration?", sources: [{ id: "a", text: "19 days" }], expected_ids: ["a"] },
    { id: "absent", query: "Missing?", sources: [{ id: "a", text: "19 days" }], expected_ids: ["missing"] },
    { id: "negative", query: "Else?", sources: [{ id: "a", text: "19 days" }], expected_ids: [], no_answer: true },
  ];
  const result = runEvidenceExperiment(cases, [1024]);
  assert.equal(result.promotion, "not_evaluable");
  for (const summary of result.summary) {
    assert.equal(summary.span_labelled, 0);
    assert.equal(summary.all_span_hits, null);
    assert.equal(summary.any_source_hits, 1);
    assert.equal(summary.no_answer_returned_evidence, 1);
  }
  assert.throws(() => validateEvidenceCases([{ ...cases[0], required_spans: [] }]), /empty span/);
  assert.throws(() => validateEvidenceCases([{ ...cases[2], expected_ids: ["a"] }]), /contradictory/);
  assert.throws(() => validateEvidenceCases([{ ...cases[0], required_spans: [{ id: "a", start: 0, end: 8, text: "19 days" }] }]), /invalid required/);
});

test("public adversarial fixtures validate and retain nontrivial span denominators", () => {
  const cases = JSON.parse(readFileSync(new URL("../fixtures/evidence-windows/cases.json", import.meta.url), "utf8")) as EvidenceCase[];
  validateEvidenceCases(cases);
  assert.ok(cases.filter(c => c.required_spans).length >= 8);
  const report = runEvidenceExperiment(cases, [1024]);
  for (const row of report.summary) assert.ok(row.span_labelled >= 8);
  assert.equal(report.promotion, "not_evaluable");
});

test("unretrieved labelled sources remain span failures and cannot leak into evidence", () => {
  const reference = { id: "secret-gold", text: "The archive duration is 19 days." };
  const c: EvidenceCase = { id: "missing-target", query: "Archive duration?",
    sources: [{ id: "unrelated", text: "A separate maintenance note." }], expected_ids: [reference.id],
    reference_sources: [reference], required_spans: [{ ...reference, start: 0, end: reference.text.length }] };
  const report = runEvidenceExperiment([c], [1024]);
  for (const row of report.rows) { assert.equal(row.all_spans, false); assert.equal(row.any_source, false); }
  assert.equal(report.summary[0].span_labelled, 1);
  assert.throws(() => validateEvidenceCases([{ ...c, sources: [{ ...reference, text: "A different revision." }] }]), /revision mismatch/);
});

test("rejected lexical arm: adding a retrieval cue can displace the actual answer", () => {
  const fact = "The retention duration is 19 days. Legal holds must never be deleted.";
  const body = `\n\nOperational overview.\n\n${fact}\n\n` +
    Array.from({ length: 200 }, () => "Routine inventory housekeeping is recorded separately from this policy.").join("\n\n");
  const plain = { id: "policy", text: "title: Archive note" + body };
  const cued = { id: "policy", text: "title: Archive note\nrecall_when: retention duration exception" + body };
  const query = "What retention duration and exception apply?";
  const hasFact = (source: typeof plain, arm: "whole-prefix" | "query-expand") =>
    packEvidence([source], query, arm, 1024).payload.evidence.some(e => e.text.includes(fact));
  assert.equal(hasFact(plain, "query-expand"), true);
  assert.equal(hasFact(cued, "whole-prefix"), true);
  assert.equal(hasFact(cued, "query-expand"), false);
  // A reproducible rejection witness, not permission to promote this frozen arm.
});
