/** Offline, extractive evidence delivery experiment (#563). Never a recall policy. */
import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";

export type EvidenceArm = "whole-prefix" | "fixed-prefix" | "query-window" | "query-expand";
export const EVIDENCE_ARMS: EvidenceArm[] = ["whole-prefix", "fixed-prefix", "query-window", "query-expand"];
export interface EvidenceSource { id: string; text: string }
export interface EvidenceSpan { id: string; start: number; end: number; text: string }
export interface EvidenceExcerpt extends EvidenceSpan { revision: string }
export interface EvidencePayload { evidence: EvidenceExcerpt[] }
const encoder = getEncoding("o200k_base");
// Treat literal special-token strings in source documents as ordinary text.
export const evidenceTokens = (text: string): number => encoder.encode(text, [], []).length;
export const serializeEvidence = (evidence: EvidenceExcerpt[]): string => JSON.stringify({ evidence });
export const sourceRevision = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

const stop = new Set("a an the and or is are was were to of for in on with what which when how does do i my our this that it be as at by from not der die das den dem des ein eine einer und oder ist sind war waren zu von für im in auf mit was welche welcher welches wann wie ich mein meine unser unsere es nicht als am bei aus".split(" "));
function terms(text: string): Set<string> {
  return new Set((text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
    .filter(t => t.length > 1 && !stop.has(t)));
}

/** UTF-16 offsets into the exact input text, including separators between paragraphs. */
export function paragraphRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  for (const match of text.matchAll(/\r?\n[\t ]*\r?\n/g)) {
    if (text.slice(start, match.index).trim()) ranges.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  if (text.slice(start).trim()) ranges.push({ start, end: text.length });
  return ranges;
}

export function selectEvidenceWindow(source: EvidenceSource, query: string, arm: EvidenceArm): EvidenceExcerpt {
  let start = 0, end = source.text.length;
  if (arm === "fixed-prefix") end = [...source.text].slice(0, 1200).join("").length;
  if (arm === "query-window" || arm === "query-expand") {
    const ranges = paragraphRanges(source.text);
    const queryTerms = terms(query);
    let best = 0, bestScore = 0;
    ranges.forEach((range, i) => {
      const paragraphTerms = terms(source.text.slice(range.start, range.end));
      const score = [...queryTerms].filter(t => paragraphTerms.has(t)).length;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    // No lexical match: deterministic first window, without a relevance claim.
    if (ranges.length) {
      start = ranges[Math.max(0, best - 1)].start;
      end = ranges[Math.min(ranges.length - 1, best + 1)].end;
    }
  }
  return { id: source.id, revision: sourceRevision(source.text), start, end, text: source.text.slice(start, end) };
}

export interface PackedEvidence {
  payload: EvidencePayload;
  serialized: string;
  tokens: number;
  omittedSources: number;
  partialSources: number;
}

/**
 * All arms receive the same ranked sources and pay for the entire JSON envelope.
 * Baseline reproduces rank-order prefix packing. Experimental windows are atomic:
 * an oversized window is skipped, never silently chopped into half an exception.
 * No source mutation, target labels, generated prose or ranking changes are allowed.
 */
export function packEvidence(sources: EvidenceSource[], query: string, arm: EvidenceArm, budget: number): PackedEvidence {
  if (!EVIDENCE_ARMS.includes(arm)) throw new Error("unknown evidence arm");
  if (!Number.isSafeInteger(budget) || budget < evidenceTokens(serializeEvidence([]))) {
    throw new Error("budget cannot contain the evidence envelope");
  }
  const unique = new Map<string, EvidenceSource>();
  for (const source of sources) {
    const previous = unique.get(source.id);
    if (previous && previous.text !== source.text) throw new Error("conflicting duplicate source");
    if (!source.id) throw new Error("empty source id");
    unique.set(source.id, source);
  }
  const evidence: EvidenceExcerpt[] = [];
  const fits = (excerpt: EvidenceExcerpt): boolean => evidenceTokens(serializeEvidence([...evidence, excerpt])) <= budget;
  for (const source of unique.values()) {
    if (!source.text.trim()) continue;
    const excerpt = selectEvidenceWindow(source, query, arm);
    if (fits(excerpt)) { evidence.push(excerpt); continue; }
    if (arm !== "whole-prefix") continue;
    // Prefix length is searched in Unicode code points, so surrogate pairs survive.
    // BPE counts need not be monotonic: this seeks a fitting prefix, not a claim of
    // optimal packing. Every accepted payload is independently counted below.
    const points = [...excerpt.text];
    let lo = 0, hi = points.length;
    let fitting: EvidenceExcerpt | undefined;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const text = points.slice(0, mid).join("");
      const prefix = { ...excerpt, text, end: text.length };
      if (fits(prefix)) { fitting = prefix; lo = mid; } else hi = mid - 1;
    }
    if (fitting) evidence.push(fitting);
    break;
  }
  if (arm === "query-expand") {
    // Spend slack on complete original sources. Never evict another selected
    // source to do so. This is a development arm, not proof that every qualifier
    // can be identified from the query or that lexical windows are safe to ship.
    for (let i = 0; i < evidence.length; i++) {
      const full = selectEvidenceWindow(unique.get(evidence[i].id)!, query, "whole-prefix");
      const expanded = evidence.map((e, j) => j === i ? full : e);
      if (evidenceTokens(serializeEvidence(expanded)) <= budget) evidence[i] = full;
    }
  }
  const serialized = serializeEvidence(evidence);
  const tokens = evidenceTokens(serialized);
  if (tokens > budget) throw new Error("evidence budget invariant violated");
  return {
    payload: { evidence }, serialized, tokens,
    omittedSources: unique.size - evidence.length,
    partialSources: evidence.filter(e => e.start !== 0 || e.end !== unique.get(e.id)!.text.length).length,
  };
}

/** A source ID alone does not certify that even one required answer span survived. */
export function coversSpan(evidence: EvidenceExcerpt[], span: EvidenceSpan): boolean {
  return evidence.some(e => e.id === span.id && e.start <= span.start && e.end >= span.end
    && e.text.slice(span.start - e.start, span.end - e.start) === span.text);
}
