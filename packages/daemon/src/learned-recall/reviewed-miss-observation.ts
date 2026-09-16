/**
 * Frozen observation contract for the offline reviewed-miss classifier (#459,
 * Workstream A). Six miss classes plus `served-hit`, the non-miss outcome.
 *
 * An observation is assembled by the engines in `reviewed-miss-engines.ts`
 * from proofs that already exist locally: the daemon's telemetry pool for the
 * exact `recall_id`, a vault snapshot with per-object birth times, and the
 * chain the transcript proves. The classifier below is pure: it decides one
 * class from the proofs and never consults a model, the vault, or the daemon.
 * Any missing or contradictory proof lands in `unknown`.
 */

export type ReviewedMissClassification =
  | "served-hit"
  | "in-pool-not-selected"
  | "genuine-out-of-pool"
  | "unindexed-vault-object"
  | "vault-gap"
  | "external-source"
  | "unknown";

export const REVIEWED_MISS_CLASSES: readonly ReviewedMissClassification[] = [
  "served-hit",
  "in-pool-not-selected",
  "genuine-out-of-pool",
  "unindexed-vault-object",
  "vault-gap",
  "external-source",
  "unknown",
];

export interface CandidatePoolScoreSpace {
  kind: "rrf" | "bm25";
  /** Fused scores carry a formula version; raw BM25 carries null. */
  formulaVersion: string | null;
  /** Sorted, unique arm names — part of the score-space identity. */
  arms: string[];
}

export interface FrozenObservationIds {
  /** Derived from the telemetry fields of the observed call, not from a
   *  persisted index snapshot — the daemon does not stamp one today. */
  indexSnapshotId: string;
  indexIdentityBasis: "telemetry-derived";
  vaultSnapshotId: string;
  profileSnapshotId: string;
}

export interface FrozenCandidatePool {
  /** Hash of the daemon's `recall_id` for this call. */
  recallRef: string;
  /** Telemetry timestamp of the observed call. */
  observedAt: string;
  /** Hashed ids in the daemon's recorded pool order, below-floor included. */
  orderedCandidateIds: string[];
  /** Recorded pool depth, equal to orderedCandidateIds.length. */
  depth: number;
  /** Hashed ids the call actually served, in served order. */
  servedCandidateIds: string[];
  scoreSpace: CandidatePoolScoreSpace;
  vaultSize: number;
}

export type MembershipReason =
  | "present"
  | "no-such-object"
  | "created-after-observation"
  | "not-a-memory"
  | "no-observation-time";

export interface MembershipProof {
  snapshotId: string;
  candidateId: string;
  membership: "present" | "absent";
  reason: MembershipReason;
}

export type ObservedTarget =
  | {
      kind: "vault-object";
      /** Hashed memory id, or hashed vault-relative path for a non-memory file. */
      candidateId: string;
      vaultMembership: MembershipProof;
      indexMembership: MembershipProof;
    }
  | {
      kind: "external-read";
      sourceRef: string;
      /** Which vault snapshot was checked for a canonical object, if any. */
      vaultChecked: { snapshotId: string; idCount: number } | null;
      /** A reviewer's explicit label that the resulting fact is durable. */
      reviewerDurable: boolean | null;
    }
  | { kind: "unresolved"; sourceRef: string | null };

export interface ReviewedMissObservation {
  kind: "reviewed-miss-observation/v1";
  frozen: FrozenObservationIds | null;
  pool: FrozenCandidatePool | null;
  target: ObservedTarget;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function opaqueId(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{16,}$/i.test(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonempty);
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function completeScoreSpace(value: unknown): value is CandidatePoolScoreSpace {
  if (!record(value) || (value.kind !== "rrf" && value.kind !== "bm25") || !stringList(value.arms)) return false;
  const arms = value.arms;
  if (arms.length === 0 || !unique(arms)) return false;
  if (arms.some((arm, index) => index > 0 && arms[index - 1].localeCompare(arm) >= 0)) return false;
  if (value.kind === "rrf") return nonempty(value.formulaVersion);
  return value.formulaVersion === null;
}

function validPool(value: unknown): value is FrozenCandidatePool {
  if (!record(value) || !opaqueId(value.recallRef) || !nonempty(value.observedAt)) return false;
  const ordered = value.orderedCandidateIds;
  const served = value.servedCandidateIds;
  return stringList(ordered) && ordered.every(opaqueId) && unique(ordered) &&
    typeof value.depth === "number" && Number.isSafeInteger(value.depth) && value.depth === ordered.length &&
    stringList(served) && served.every(opaqueId) && unique(served) &&
    typeof value.vaultSize === "number" && Number.isSafeInteger(value.vaultSize) && value.vaultSize >= 0 &&
    completeScoreSpace(value.scoreSpace);
}

function validFrozen(value: unknown): value is FrozenObservationIds {
  return record(value) && opaqueId(value.indexSnapshotId) && value.indexIdentityBasis === "telemetry-derived" &&
    opaqueId(value.vaultSnapshotId) && opaqueId(value.profileSnapshotId);
}

function validProof(value: unknown, snapshotId: string, candidateId: string): value is MembershipProof {
  if (!record(value) || value.snapshotId !== snapshotId || value.candidateId !== candidateId) return false;
  const reasons: MembershipReason[] = ["present", "no-such-object", "created-after-observation", "not-a-memory", "no-observation-time"];
  if (!reasons.includes(value.reason as MembershipReason)) return false;
  if (value.membership === "present") return value.reason === "present";
  return value.membership === "absent" && value.reason !== "present";
}

function classifyVaultObject(
  target: Record<string, unknown>,
  frozen: FrozenObservationIds,
  pool: FrozenCandidatePool,
): ReviewedMissClassification {
  if (!opaqueId(target.candidateId)) return "unknown";
  const candidateId = target.candidateId;
  if (!validProof(target.vaultMembership, frozen.vaultSnapshotId, candidateId) ||
      !validProof(target.indexMembership, frozen.indexSnapshotId, candidateId)) {
    return "unknown";
  }
  const vault = target.vaultMembership;
  const index = target.indexMembership;
  const served = pool.servedCandidateIds.includes(candidateId);
  const inPool = served || pool.orderedCandidateIds.includes(candidateId);

  // The object the session used was among the served hits: Recall answered.
  // This is not a miss of any kind and never a proposal; it is kept apart
  // from `unknown` so a success does not read as a missing proof.
  if (served) return "served-hit";
  // An object in the pool was indexed by definition, and an indexed object
  // cannot be absent from the vault snapshot its index was frozen against.
  if (inPool && index.membership === "absent") return "unknown";
  if (index.membership === "present" && vault.membership === "absent") return "unknown";
  if (vault.membership === "absent") return "unknown";
  if (index.reason === "no-observation-time") return "unknown";
  if (inPool) return "in-pool-not-selected";
  if (index.membership === "present") return "genuine-out-of-pool";
  return "unindexed-vault-object";
}

/**
 * Classify one observation. Every partial or contradictory shape fails closed
 * to `unknown`; the same observation always lands in exactly one class.
 */
export function classifyReviewedMissObservation(value: unknown): ReviewedMissClassification {
  if (!record(value) || value.kind !== "reviewed-miss-observation/v1" || !record(value.target)) return "unknown";
  const target = value.target;

  if (target.kind === "external-read") {
    if (!opaqueId(target.sourceRef)) return "unknown";
    // A vault gap is a reviewer's claim about durability, evidenced against a
    // named snapshot. Without both it stays what the transcript proves: the
    // task was answered from a source outside the vault.
    if (target.reviewerDurable === true) {
      const checked = target.vaultChecked;
      if (record(checked) && opaqueId(checked.snapshotId) && typeof checked.idCount === "number" &&
          Number.isSafeInteger(checked.idCount) && checked.idCount >= 0) {
        return "vault-gap";
      }
      return "unknown";
    }
    return "external-source";
  }

  if (target.kind !== "vault-object") return "unknown";
  if (!validFrozen(value.frozen) || !validPool(value.pool)) return "unknown";
  return classifyVaultObject(target, value.frozen, value.pool);
}
