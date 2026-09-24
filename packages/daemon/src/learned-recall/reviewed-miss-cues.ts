/**
 * Cue proposals and accounting derived mechanically from observed chains.
 *
 * A proposal pairs the human intent (its content terms, the verbatim query
 * capped) with the vault object the session actually used, for the classes
 * that can become memory-system proposals under #459: in-pool-not-selected,
 * genuine-out-of-pool, unindexed-vault-object. One episode proposes; support
 * counts distinct sessions. Nothing here writes `recall_when`; the output is
 * a reviewer's list, and `confidence` is not computed rather than invented.
 */
import { capAtWordBoundary, MIN_SIGNIFICANT_TOKEN_LEN, PHRASE_STOPWORDS, tokenizeWithIdentifiers } from "@bastra-recall/core";
import type { ReviewedMissChain } from "./reviewed-miss-harvest.js";
import { realOrResolved, type ObservationEngines, type ReviewedMissObservedCandidate } from "./reviewed-miss-engines.js";
import type { ReviewedMissClassification } from "./reviewed-miss-observation.js";

export const CUE_GENERATOR = "reviewed-miss-cues/v1";
export const CUE_MAX_CHARS = 160;
export const CUE_MAX_TERMS = 12;

const PROPOSAL_CLASSES: ReadonlySet<ReviewedMissClassification> = new Set([
  "in-pool-not-selected",
  "genuine-out-of-pool",
  "unindexed-vault-object",
]);

export interface CueEpisode {
  cue: string;
  terms: string[];
  classification: ReviewedMissClassification;
  recallRef: string | null;
  sessionRef: string;
  /** Recorded pool depth of the observed call, when telemetry joined. */
  poolDepth: number | null;
}

export interface CueProposal {
  kind: "recall-when-proposal/v1";
  /** Clear memory id: this file is for the vault's own reviewer, never the queue. */
  targetId: string;
  /** The target is a high-degree node in the heatmap; a cue toward a hub connects everything. */
  hub: boolean;
  support: number;
  episodes: CueEpisode[];
  generator: typeof CUE_GENERATOR;
  derived_at: string;
  confidence: null;
}

/** Content terms of an intent: tokenized, stopwords and short tokens dropped. */
export function intentTerms(query: string): string[] {
  const out: string[] = [];
  for (const token of tokenizeWithIdentifiers(query)) {
    const term = token.toLowerCase();
    if (term.length < MIN_SIGNIFICANT_TOKEN_LEN || PHRASE_STOPWORDS.has(term) || out.includes(term)) continue;
    out.push(term);
    if (out.length >= CUE_MAX_TERMS) break;
  }
  return out;
}

/** The clear vault id a chain resolved to, or null when it did not resolve to one. */
export function resolvedMemoryId(chain: ReviewedMissChain, engines: ObservationEngines): string | null {
  if (chain.evidence.kind === "load-memory") return chain.evidence.memoryId;
  // `bash-read` resolves exactly like `file-read` in `resolveTarget`; leaving it
  // out here made the same path through `cat` produce no cue proposal at all.
  if ((chain.evidence.kind === "file-read" || chain.evidence.kind === "bash-read") && engines.snapshot) {
    return engines.snapshot.idByPath.get(realOrResolved(chain.evidence.path)) ?? null;
  }
  return null;
}

export interface ObservedPair {
  chain: ReviewedMissChain;
  record: ReviewedMissObservedCandidate;
}

export function deriveCueProposals(
  pairs: ObservedPair[],
  engines: ObservationEngines,
  now: Date = new Date(),
  hubs: ReadonlySet<string> = new Set(),
): CueProposal[] {
  const byTarget = new Map<string, CueProposal>();
  for (const { chain, record } of pairs) {
    if (!PROPOSAL_CLASSES.has(record.classification)) continue;
    const targetId = resolvedMemoryId(chain, engines);
    if (!targetId) continue;
    const episode: CueEpisode = {
      cue: capAtWordBoundary(chain.query.replace(/\s+/g, " ").trim(), CUE_MAX_CHARS),
      terms: intentTerms(chain.query),
      classification: record.classification,
      recallRef: record.recallRef,
      sessionRef: record.sessionRef,
      poolDepth: record.observation.pool?.depth ?? null,
    };
    const proposal = byTarget.get(targetId) ?? {
      kind: "recall-when-proposal/v1",
      targetId,
      hub: hubs.has(targetId),
      support: 0,
      episodes: [],
      generator: CUE_GENERATOR,
      derived_at: now.toISOString(),
      confidence: null,
    };
    proposal.episodes.push(episode);
    proposal.support = new Set(proposal.episodes.map((e) => e.sessionRef)).size;
    byTarget.set(targetId, proposal);
  }
  return [...byTarget.values()].sort((a, b) => b.support - a.support || a.targetId.localeCompare(b.targetId));
}
