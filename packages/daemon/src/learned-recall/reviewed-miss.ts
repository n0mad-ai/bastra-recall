/**
 * Reviewed Recall misses are an offline, curator-owned input to learned recall.
 *
 * Telemetry can prove a query and an acted-on vault memory. It cannot prove that
 * a nonempty hit was irrelevant, nor can it turn an external file read into a
 * vault memory. This narrow classifier keeps those cases separate before any
 * bridge minting code sees them.
 */

export type ReviewedMissResolution =
  | { kind: "vault-memory"; memoryId: string }
  | { kind: "external-source"; sourceRef: string };

export interface ReviewedRecallMiss {
  kind: "reviewed-recall-miss/v1";
  review: "miss";
  query: string;
  resolution: ReviewedMissResolution;
}

export type ReviewedMissOutcome =
  | { kind: "bridge-reach"; query: string; memoryId: string }
  | { kind: "note-candidate"; sourceRef: string; reason: "external-source-is-not-a-memory" }
  | { kind: "reject"; reason: "not-a-reviewed-miss" | "invalid-resolution" };

function opaqueRef(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{16,}$/i.test(value);
}

/**
 * Convert only a human-reviewed miss into the next safe owner action.
 *
 * This function is deliberately pure: it does not write a bridge, save a note,
 * or submit a contribution. Callers may pass `bridge-reach` to the existing
 * local mint path; `note-candidate` remains a curator queue item.
 */
export function classifyReviewedMiss(value: unknown): ReviewedMissOutcome {
  if (!value || typeof value !== "object") return { kind: "reject", reason: "not-a-reviewed-miss" };
  const record = value as Partial<ReviewedRecallMiss>;
  if (record.kind !== "reviewed-recall-miss/v1" || record.review !== "miss" || typeof record.query !== "string" || !record.query.trim()) {
    return { kind: "reject", reason: "not-a-reviewed-miss" };
  }
  const resolution = record.resolution;
  if (!resolution || typeof resolution !== "object") return { kind: "reject", reason: "invalid-resolution" };
  if (resolution.kind === "vault-memory" && typeof resolution.memoryId === "string" && resolution.memoryId.trim()) {
    return { kind: "bridge-reach", query: record.query, memoryId: resolution.memoryId };
  }
  if (resolution.kind === "external-source" && opaqueRef(resolution.sourceRef)) {
    return { kind: "note-candidate", sourceRef: resolution.sourceRef, reason: "external-source-is-not-a-memory" };
  }
  return { kind: "reject", reason: "invalid-resolution" };
}
