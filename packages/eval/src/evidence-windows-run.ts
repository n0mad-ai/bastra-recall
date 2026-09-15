/** Local JSON replay CLI. Inputs and per-case output can contain private evidence. */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { EVIDENCE_ARMS, packEvidence, coversSpan, type EvidenceSource, type EvidenceSpan, type EvidenceArm } from "./evidence-windows.js";

export interface EvidenceCase {
  id: string;
  query: string;
  sources: EvidenceSource[];
  /** Annotation-only canonical sources. Never passed to packing or the reader. */
  reference_sources?: EvidenceSource[];
  expected_ids: string[];
  no_answer?: boolean;
  /** Missing means unlabelled, never a successful empty conjunction. */
  required_spans?: EvidenceSpan[];
}
interface EvidenceRow {
  id: string; arm: EvidenceArm; budget: number; ms: number; tokens: number;
  no_answer: boolean; any_source: boolean; all_sources: boolean; all_spans: boolean | null;
  returned_sources: number; omitted_sources: number; partial_sources: number;
}
export function validateEvidenceCases(cases: EvidenceCase[]): void {
  if (!Array.isArray(cases) || !cases.length) throw new Error("nonempty case array required");
  const ids = new Set<string>();
  for (const c of cases) {
    if (!c.id || ids.has(c.id) || typeof c.query !== "string" || !Array.isArray(c.sources)
      || !Array.isArray(c.expected_ids) || c.expected_ids.some(id => typeof id !== "string" || !id)) throw new Error("invalid/duplicate case");
    ids.add(c.id);
    if (c.sources.some(s => typeof s.id !== "string" || !s.id || typeof s.text !== "string")) throw new Error("invalid source");
    if (c.reference_sources !== undefined && !Array.isArray(c.reference_sources)) throw new Error("invalid reference sources");
    const references = new Map<string, EvidenceSource>();
    for (const source of [...c.sources, ...(c.reference_sources ?? [])]) {
      if (typeof source.id !== "string" || !source.id || typeof source.text !== "string") throw new Error("invalid reference source");
      const previous = references.get(source.id);
      if (previous && previous.text !== source.text) throw new Error("reference/source revision mismatch");
      references.set(source.id, source);
    }
    if (c.no_answer !== undefined && typeof c.no_answer !== "boolean") throw new Error("invalid no-answer flag");
    if (c.required_spans !== undefined && !Array.isArray(c.required_spans)) throw new Error("invalid span labels");
    if (c.no_answer && (c.expected_ids.length || c.required_spans?.length)) throw new Error("contradictory no-answer labels");
    if (!c.no_answer && !c.expected_ids.length) throw new Error("answerable case requires expected sources");
    if (c.required_spans && !c.required_spans.length) throw new Error("empty span labels: omit for unlabelled cases");
    for (const span of c.required_spans ?? []) {
      const source = references.get(span.id);
      if (!source || !c.expected_ids.includes(span.id) || !Number.isSafeInteger(span.start)
        || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start
        || span.end > source.text.length || source.text.slice(span.start, span.end) !== span.text) throw new Error("invalid required span");
    }
  }
}

export function runEvidenceExperiment(cases: EvidenceCase[], budgets = [1024, 4096]) {
  validateEvidenceCases(cases);
  if (!budgets.length || new Set(budgets).size !== budgets.length) throw new Error("nonempty unique budgets required");
  const rows: EvidenceRow[] = [];
  // Initialize/warm encoding outside the measured selection path.
  packEvidence([], "", "whole-prefix", 1024);
  for (const budget of budgets) for (const c of cases) for (const arm of EVIDENCE_ARMS) {
    const start = performance.now();
    const packed = packEvidence(c.sources, c.query, arm, budget);
    const ms = performance.now() - start;
    const ids = new Set(packed.payload.evidence.map(e => e.id));
    rows.push({ id: c.id, arm, budget, ms, tokens: packed.tokens,
      no_answer: c.no_answer ?? false,
      any_source: c.expected_ids.some(id => ids.has(id)),
      all_sources: c.expected_ids.length > 0 && c.expected_ids.every(id => ids.has(id)),
      all_spans: c.required_spans ? c.required_spans.every(s => coversSpan(packed.payload.evidence, s)) : null,
      returned_sources: ids.size, omitted_sources: packed.omittedSources, partial_sources: packed.partialSources });
  }
  const summary = budgets.flatMap(budget => EVIDENCE_ARMS.map(arm => {
    const selected = rows.filter(r => r.arm === arm && r.budget === budget);
    const positive = selected.filter(r => !r.no_answer);
    const labelled = positive.filter(r => r.all_spans !== null);
    const times = selected.map(r => r.ms).sort((a, b) => a - b);
    return { arm, budget, answerable: positive.length, span_labelled: labelled.length,
      any_source_hits: positive.filter(r => r.any_source).length,
      all_source_hits: positive.filter(r => r.all_sources).length,
      all_span_hits: labelled.length ? labelled.filter(r => r.all_spans).length : null,
      no_answer_returned_evidence: selected.filter(r => r.no_answer && r.returned_sources > 0).length,
      no_answer_cases: selected.filter(r => r.no_answer).length,
      selection_p50_ms: times[Math.floor(times.length / 2)],
      selection_p95_ms: times[Math.ceil(times.length * .95) - 1],
      maximum_tokens: Math.max(...selected.map(r => r.tokens)) };
  }));
  return { version: "evidence-windows-563-v2", promotion: "not_evaluable" as const,
    reason: "Diagnostic replay only; independent span labels, transfer and answer-quality gates remain mandatory.",
    summary, rows };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--input" || args[2] !== "--out") throw new Error("usage: evidence-windows --input local-cases.json --out local-result.json");
  const input = readFileSync(args[1], "utf8");
  const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
  const report = { input_sha256: createHash("sha256").update(input).digest("hex"),
    registration_sha256: hash(readFileSync(new URL("../registrations/evidence-windows.json", import.meta.url), "utf8")),
    implementation_sha256: hash(readFileSync(new URL("./evidence-windows.ts", import.meta.url), "utf8")
      + readFileSync(new URL("./evidence-windows-run.ts", import.meta.url), "utf8")),
    runtime: process.version,
    ...runEvidenceExperiment(JSON.parse(input)) };
  // Exclusive creation prevents an accidental overwrite of input or another artifact.
  writeFileSync(args[3], JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ promotion: report.promotion, summary: report.summary }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
