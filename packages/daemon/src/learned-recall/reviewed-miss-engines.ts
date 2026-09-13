/**
 * Offline engines that turn a harvested chain into a frozen observation.
 *
 * Each engine produces one proof from one local artifact and nothing else:
 *
 * - pool-join      telemetry `events-*.jsonl` → the pool the daemon searched
 *                  for this exact `recall_id`, its served ids and score space;
 * - vault-snapshot one enumeration of the vault → hashed listing, parsed ids,
 *                  per-object birth time, non-memory files;
 * - target-resolve the chain's first evidence step → a vault object, an
 *                  external read, or nothing inspectable;
 * - identity       telemetry fields → profile and telemetry-derived index ids.
 *
 * None of them ranks, writes, or calls a model. All ids leave as hashes.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { readOccupant } from "@bastra-recall/core";
import { hash, type ReviewedMissCandidate, type ReviewedMissChain, toCandidate } from "./reviewed-miss-harvest.js";
import {
  classifyReviewedMissObservation,
  type CandidatePoolScoreSpace,
  type FrozenCandidatePool,
  type FrozenObservationIds,
  type MembershipProof,
  type ObservedTarget,
  type ReviewedMissClassification,
  type ReviewedMissObservation,
} from "./reviewed-miss-observation.js";

// ─── pool-join ───────────────────────────────────────────────────

export interface TelemetryPool {
  recallId: string;
  ts: string;
  orderedIds: string[];
  servedIds: string[];
  scoreSpace: CandidatePoolScoreSpace;
  vaultSize: number;
  k: number | null;
}

function scoreSpaceOf(event: Record<string, unknown>): CandidatePoolScoreSpace | null {
  const kind = event.candidate_pool_score_kind ?? event.score_kind;
  if (kind !== "rrf" && kind !== "bm25") return null;
  const armsRaw = event.candidate_pool_score_arms ?? event.score_arms;
  const arms = Array.isArray(armsRaw) ? armsRaw.filter((arm): arm is string => typeof arm === "string") : [];
  if (arms.length === 0) return null;
  const version = event.candidate_pool_score_version ?? event.score_version;
  return {
    kind,
    formulaVersion: kind === "rrf" ? (typeof version === "string" && version ? version : null) : null,
    arms: [...new Set(arms)].sort((a, b) => a.localeCompare(b)),
  };
}

function idsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const id = typeof item === "object" && item !== null ? (item as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Read every recall-class event with a `recall_id` and a candidate pool. */
export async function loadTelemetryPools(dir: string): Promise<Map<string, TelemetryPool>> {
  const pools = new Map<string, TelemetryPool>();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.startsWith("events-") && f.endsWith(".jsonl")).sort();
  } catch {
    return pools;
  }
  for (const file of files) {
    const raw = await readFile(join(dir, file), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.kind !== "recall" && event.kind !== "hook_recall") continue;
      if (typeof event.recall_id !== "string" || !event.recall_id || typeof event.ts !== "string") continue;
      const scoreSpace = scoreSpaceOf(event);
      const orderedIds = idsOf(event.candidate_pool);
      if (!scoreSpace || orderedIds.length === 0) continue;
      const scoreSpaceFormulaOk = scoreSpace.kind === "bm25" || scoreSpace.formulaVersion !== null;
      if (!scoreSpaceFormulaOk) continue;
      pools.set(event.recall_id, {
        recallId: event.recall_id,
        ts: event.ts,
        orderedIds,
        servedIds: idsOf(event.hits),
        scoreSpace,
        vaultSize: typeof event.vault_size === "number" ? event.vault_size : 0,
        k: typeof event.k === "number" ? event.k : null,
      });
    }
  }
  return pools;
}

// ─── vault-snapshot ──────────────────────────────────────────────

export interface VaultObject {
  hashedPath: string;
  bornAtMs: number;
}

export interface VaultSnapshot {
  snapshotId: string;
  idCount: number;
  /** memory id → object */
  objects: Map<string, VaultObject>;
  /** absolute path → memory id, for resolving file reads */
  idByPath: Map<string, string>;
  /** absolute path → non-memory markdown file inside the vault */
  foreignByPath: Map<string, VaultObject>;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name.length > 1) continue;
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(full);
  }
}

/** Enumerate the vault once; the snapshot id is the hash of its hashed listing. */
export async function snapshotVault(root: string): Promise<VaultSnapshot> {
  const absRoot = resolve(root);
  const files: string[] = [];
  await walk(absRoot, files);
  files.sort();
  const objects = new Map<string, VaultObject>();
  const idByPath = new Map<string, string>();
  const foreignByPath = new Map<string, VaultObject>();
  const listing: string[] = [];
  for (const file of files) {
    const hashedPath = hash("vault:" + relative(absRoot, file));
    let bornAtMs: number;
    try {
      const s = await stat(file);
      bornAtMs = s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
    } catch {
      continue;
    }
    const occupant = readOccupant(file);
    if (occupant.kind === "memory") {
      listing.push(hashedPath + "=" + hash("id:" + occupant.id));
      objects.set(occupant.id, { hashedPath, bornAtMs });
      idByPath.set(file, occupant.id);
    } else if (occupant.kind === "foreign") {
      listing.push(hashedPath + "=foreign");
      foreignByPath.set(file, { hashedPath, bornAtMs });
    }
  }
  return {
    snapshotId: hash("vault-listing:" + listing.join("\n")),
    idCount: objects.size,
    objects,
    idByPath,
    foreignByPath,
  };
}

function insideVault(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
}

// ─── identity ────────────────────────────────────────────────────

export function frozenIdsOf(pool: TelemetryPool, snapshot: VaultSnapshot): FrozenObservationIds {
  const space = `${pool.scoreSpace.kind};${pool.scoreSpace.arms.join(",")};${pool.scoreSpace.formulaVersion ?? "-"}`;
  return {
    indexSnapshotId: hash(`index:vault_size=${pool.vaultSize};${space}`),
    indexIdentityBasis: "telemetry-derived",
    vaultSnapshotId: snapshot.snapshotId,
    profileSnapshotId: hash(`profile:k=${pool.k ?? "-"};${space}`),
  };
}

export function frozenPoolOf(pool: TelemetryPool): FrozenCandidatePool {
  const ordered = pool.orderedIds.map((id) => hash("id:" + id));
  return {
    recallRef: hash("recall_id:" + pool.recallId),
    observedAt: pool.ts,
    orderedCandidateIds: ordered,
    depth: ordered.length,
    servedCandidateIds: pool.servedIds.map((id) => hash("id:" + id)),
    scoreSpace: pool.scoreSpace,
    vaultSize: pool.vaultSize,
  };
}

// ─── target-resolve ──────────────────────────────────────────────

export interface ReviewerLabel {
  durable?: boolean;
}

function membership(
  snapshotId: string,
  candidateId: string,
  present: boolean,
  reason: MembershipProof["reason"],
): MembershipProof {
  return { snapshotId, candidateId, membership: present ? "present" : "absent", reason };
}

function vaultObjectTarget(
  candidateId: string,
  object: VaultObject | null,
  isMemory: boolean,
  observedAtMs: number | null,
  frozen: FrozenObservationIds,
): ObservedTarget {
  if (!object) {
    return {
      kind: "vault-object",
      candidateId,
      vaultMembership: membership(frozen.vaultSnapshotId, candidateId, false, "no-such-object"),
      indexMembership: membership(frozen.indexSnapshotId, candidateId, false, "no-such-object"),
    };
  }
  const vaultMembership = membership(frozen.vaultSnapshotId, candidateId, true, "present");
  let indexMembership: MembershipProof;
  if (!isMemory) indexMembership = membership(frozen.indexSnapshotId, candidateId, false, "not-a-memory");
  else if (observedAtMs === null) indexMembership = membership(frozen.indexSnapshotId, candidateId, false, "no-observation-time");
  else if (object.bornAtMs > observedAtMs) indexMembership = membership(frozen.indexSnapshotId, candidateId, false, "created-after-observation");
  else indexMembership = membership(frozen.indexSnapshotId, candidateId, true, "present");
  return { kind: "vault-object", candidateId, vaultMembership, indexMembership };
}

/**
 * Resolve the chain's evidence step against the vault snapshot. Without a
 * snapshot a vault-side identity cannot be proven, so only external reads and
 * unresolved steps remain.
 */
export function resolveTarget(
  chain: ReviewedMissChain,
  vaultRoot: string | null,
  snapshot: VaultSnapshot | null,
  frozen: FrozenObservationIds | null,
  observedAt: string | null,
  label: ReviewerLabel | null,
): ObservedTarget {
  const evidence = chain.evidence;
  const observedAtMs = observedAt ? Date.parse(observedAt) : NaN;
  const atMs = Number.isFinite(observedAtMs) ? observedAtMs : null;
  const checked = snapshot ? { snapshotId: snapshot.snapshotId, idCount: snapshot.idCount } : null;
  const durable = label && typeof label.durable === "boolean" ? label.durable : null;

  if (evidence.kind === "load-memory") {
    const candidateId = hash("id:" + evidence.memoryId);
    if (!snapshot || !frozen) return { kind: "unresolved", sourceRef: candidateId };
    return vaultObjectTarget(candidateId, snapshot.objects.get(evidence.memoryId) ?? null, true, atMs, frozen);
  }
  if (evidence.kind === "file-read") {
    const path = resolve(evidence.path);
    const sourceRef = hash("file_path:" + evidence.path);
    if (!vaultRoot || !insideVault(vaultRoot, path)) {
      return { kind: "external-read", sourceRef, vaultChecked: checked, reviewerDurable: durable };
    }
    if (!snapshot || !frozen) return { kind: "unresolved", sourceRef };
    const memoryId = snapshot.idByPath.get(path);
    if (memoryId) {
      return vaultObjectTarget(hash("id:" + memoryId), snapshot.objects.get(memoryId) ?? null, true, atMs, frozen);
    }
    const foreign = snapshot.foreignByPath.get(path);
    const candidateId = hash("vault:" + relative(resolve(vaultRoot), path));
    return vaultObjectTarget(candidateId, foreign ?? null, false, atMs, frozen);
  }
  return { kind: "unresolved", sourceRef: evidence.sourceRef };
}

// ─── assemble ────────────────────────────────────────────────────

export interface ObservationEngines {
  pools: Map<string, TelemetryPool> | null;
  vaultRoot: string | null;
  snapshot: VaultSnapshot | null;
  /** keyed by recallRef or, when no telemetry joined, by sourceRef */
  labels: Map<string, ReviewerLabel>;
}

export interface ReviewedMissObservedCandidate extends ReviewedMissCandidate {
  /** Hash of the served envelope's `recall_id`; null when the envelope had none. */
  recallRef: string | null;
  classification: ReviewedMissClassification;
  observation: ReviewedMissObservation;
}

export function assembleObservation(chain: ReviewedMissChain, engines: ObservationEngines): ReviewedMissObservation {
  const telemetry = chain.recallId && engines.pools ? engines.pools.get(chain.recallId) ?? null : null;
  const pool = telemetry ? frozenPoolOf(telemetry) : null;
  const frozen = telemetry && engines.snapshot ? frozenIdsOf(telemetry, engines.snapshot) : null;
  const candidate = toCandidate(chain);
  const label = (pool ? engines.labels.get(pool.recallRef) : undefined) ??
    (candidate.sourceRef ? engines.labels.get(candidate.sourceRef) : undefined) ?? null;
  const target = resolveTarget(chain, engines.vaultRoot, engines.snapshot, frozen, telemetry?.ts ?? chain.resultTs, label);
  return { kind: "reviewed-miss-observation/v1", frozen, pool, target };
}

export function observeChain(chain: ReviewedMissChain, engines: ObservationEngines): ReviewedMissObservedCandidate {
  const observation = assembleObservation(chain, engines);
  return {
    ...toCandidate(chain),
    recallRef: chain.recallId ? hash("recall_id:" + chain.recallId) : null,
    classification: classifyReviewedMissObservation(observation),
    observation,
  };
}

/** Parse a reviewer label file: one JSON object per line, `{ ref, durable }`. */
export function parseReviewerLabels(text: string): Map<string, ReviewerLabel> {
  const labels = new Map<string, ReviewerLabel>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const { ref, durable } = entry as { ref?: unknown; durable?: unknown };
    if (typeof ref !== "string" || !ref) continue;
    labels.set(ref, typeof durable === "boolean" ? { durable } : {});
  }
  return labels;
}
