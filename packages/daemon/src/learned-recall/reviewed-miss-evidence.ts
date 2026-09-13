/**
 * Evidence provision for the reviewed-miss harvester: the hook lane, the
 * heatmap, the hot paths, and the gap ledger.
 *
 * Nearly all recall traffic is the hook lane (thousands of `hook_recall`
 * pools against tens of MCP calls), and the daemon already joins each
 * `load_memory` to the hook recall whose hint it followed. So the hook lane
 * needs no transcript: pool + load + vault snapshot assemble the same
 * observation the transcript lane builds, and the same classifier decides.
 *
 * The report keeps three things apart, the way the owner's harness does:
 * coverage (what the instruments could see), observed (what they saw), and
 * gaps (what they could not join). A gap kind becomes a *den* only when it is
 * silent, repeated across sessions, and has a named exit; a single occurrence
 * is noise. Non-use is censored feedback, never a negative label: a memory
 * surfaced many times and never loaded is reported as a density, not a verdict.
 */
import { hash, type ReviewedMissCandidate, type ReviewedMissChain } from "./reviewed-miss-harvest.js";
import {
  frozenIdsOf,
  frozenPoolOf,
  resolveTarget,
  type ObservationEngines,
  type ReviewedMissObservedCandidate,
  type Telemetry,
  type TelemetryLoad,
  type TelemetryPool,
} from "./reviewed-miss-engines.js";
import {
  classifyReviewedMissObservation,
  REVIEWED_MISS_CLASSES,
  type ReviewedMissClassification,
  type ReviewedMissObservation,
} from "./reviewed-miss-observation.js";

// ─── hook lane ───────────────────────────────────────────────────

export interface HookLaneRecord extends ReviewedMissObservedCandidate {
  lane: "hook";
  intentSource: "hook-query";
  hookHintRank: number | null;
}

export type GapKind =
  | "envelope-without-recall-id"
  | "load-without-recall-link"
  | "link-without-pool"
  | "load-not-found"
  | "unresolved-evidence"
  | "no-vault-snapshot";

export interface GapEvent {
  kind: GapKind;
  sessionRef: string | null;
}

export interface HookLaneResult {
  records: HookLaneRecord[];
  /** The chain behind each record, for cue proposals (same index as `records`). */
  chains: ReviewedMissChain[];
  gaps: GapEvent[];
}

/**
 * Observe every daemon-joined load against its pool. A load the daemon did
 * not link, or whose recall has no recorded pool, is a gap — counted, never
 * classified.
 */
export function observeHookLane(telemetry: Telemetry, engines: ObservationEngines): HookLaneResult {
  const records: HookLaneRecord[] = [];
  const chains: ReviewedMissChain[] = [];
  const gaps: GapEvent[] = [];
  for (const load of telemetry.loads) {
    const sessionRef = load.sessionId ? hash("session:" + load.sessionId) : null;
    const recallId = load.fromHookRecall ?? load.followsRecall;
    if (!recallId) {
      gaps.push({ kind: "load-without-recall-link", sessionRef });
      continue;
    }
    const pool = telemetry.pools.get(recallId);
    if (!pool) {
      gaps.push({ kind: "link-without-pool", sessionRef });
      continue;
    }
    if (!load.found) {
      gaps.push({ kind: "load-not-found", sessionRef });
      continue;
    }
    if (!engines.snapshot) {
      gaps.push({ kind: "no-vault-snapshot", sessionRef });
      continue;
    }
    const frozen = frozenIdsOf(pool, engines.snapshot);
    const frozenPool = frozenPoolOf(pool);
    const chain: ReviewedMissChain = {
      query: pool.query ?? "",
      sessionIdentity: load.sessionId ?? "unknown-session",
      recallId,
      explicitMiss: pool.servedIds.length === 0,
      servedIds: pool.servedIds,
      resultTs: pool.ts,
      evidence: { kind: "load-memory" as const, memoryId: load.memoryId },
    };
    const label = engines.labels.get(frozenPool.recallRef) ?? null;
    const target = resolveTarget(chain, engines.vaultRoot, engines.snapshot, frozen, pool.ts, label);
    const observation: ReviewedMissObservation = { kind: "reviewed-miss-observation/v1", frozen, pool: frozenPool, target };
    const candidate: ReviewedMissCandidate = {
      kind: "reviewed-recall-miss-candidate/v1",
      status: chain.explicitMiss ? "candidate" : "needs-relevance-label",
      query: chain.query,
      sessionRef: hash(chain.sessionIdentity),
      sourceRef: hash("id:" + load.memoryId),
      evidence: { recall: chain.explicitMiss ? "explicit-miss" : "nonempty-or-unclassified", sourceReadAfterRecall: true },
    };
    records.push({
      ...candidate,
      lane: "hook",
      intentSource: "hook-query",
      hookHintRank: load.hookHintRank,
      recallRef: frozenPool.recallRef,
      classification: classifyReviewedMissObservation(observation),
      observation,
    });
    chains.push(chain);
  }
  return { records, chains, gaps };
}

// ─── heatmap ─────────────────────────────────────────────────────

export interface HeatmapRow {
  /** Clear memory id — the evidence file is local, like the proposals file. */
  memoryId: string;
  surfaced: number;
  surfacedSessions: number;
  inPoolBelowServed: number;
  loaded: number;
  loadedSessions: number;
  servedHit: number;
  /** Served ranks at which the memory was loaded (1-based), for the rank curve. */
  loadedAtRank: number[];
  /** Surfaced in at least `hubSessions` distinct sessions: a high-degree node. */
  hub: boolean;
  /** Surfaced but never loaded in the window: a density, censored, not a verdict. */
  surfacedNeverLoaded: boolean;
}

export interface HeatmapOptions {
  /** Distinct sessions above which a memory counts as a hub. A reviewer's knob, not a finding. */
  hubSessions: number;
}

export function heatmap(telemetry: Telemetry, options: HeatmapOptions = { hubSessions: 3 }): HeatmapRow[] {
  const rows = new Map<string, HeatmapRow>();
  const surfacedSessions = new Map<string, Set<string>>();
  const loadedSessions = new Map<string, Set<string>>();
  const row = (id: string): HeatmapRow => {
    let r = rows.get(id);
    if (!r) {
      r = { memoryId: id, surfaced: 0, surfacedSessions: 0, inPoolBelowServed: 0, loaded: 0, loadedSessions: 0, servedHit: 0, loadedAtRank: [], hub: false, surfacedNeverLoaded: false };
      rows.set(id, r);
    }
    return r;
  };
  for (const pool of telemetry.pools.values()) {
    const served = new Set(pool.servedIds);
    for (const id of pool.servedIds) {
      row(id).surfaced += 1;
      if (pool.sessionId) (surfacedSessions.get(id) ?? surfacedSessions.set(id, new Set()).get(id)!).add(pool.sessionId);
    }
    for (const id of pool.orderedIds) if (!served.has(id)) row(id).inPoolBelowServed += 1;
  }
  for (const load of telemetry.loads) {
    const r = row(load.memoryId);
    r.loaded += 1;
    if (load.sessionId) (loadedSessions.get(load.memoryId) ?? loadedSessions.set(load.memoryId, new Set()).get(load.memoryId)!).add(load.sessionId);
    const recallId = load.fromHookRecall ?? load.followsRecall;
    const pool = recallId ? telemetry.pools.get(recallId) : undefined;
    if (!pool) continue;
    const rank = pool.servedIds.indexOf(load.memoryId);
    if (rank >= 0) {
      r.servedHit += 1;
      r.loadedAtRank.push(rank + 1);
    }
  }
  for (const r of rows.values()) {
    r.surfacedSessions = surfacedSessions.get(r.memoryId)?.size ?? 0;
    r.loadedSessions = loadedSessions.get(r.memoryId)?.size ?? 0;
    r.hub = r.surfacedSessions >= options.hubSessions;
    r.surfacedNeverLoaded = r.surfaced > 0 && r.loaded === 0;
    r.loadedAtRank.sort((a, b) => a - b);
  }
  return [...rows.values()].sort((a, b) => b.surfaced - a.surfaced || b.loaded - a.loaded || a.memoryId.localeCompare(b.memoryId));
}

// ─── hot paths ───────────────────────────────────────────────────

export interface HotPath {
  fromId: string;
  toId: string;
  observations: number;
  /** Distinct sessions that showed the transition. One session proposes an edge; it does not establish one. */
  support: number;
  established: boolean;
  sessionRefs: string[];
}

export interface HotPathOptions {
  /** Two loads further apart than this are not one path. */
  maxGapMs: number;
  /** Distinct sessions needed before an edge counts as established. */
  establishSessions: number;
}

export function hotPaths(loads: TelemetryLoad[], options: HotPathOptions = { maxGapMs: 30 * 60_000, establishSessions: 2 }): HotPath[] {
  const bySession = new Map<string, TelemetryLoad[]>();
  for (const load of loads) {
    if (!load.sessionId || !load.found) continue;
    (bySession.get(load.sessionId) ?? bySession.set(load.sessionId, []).get(load.sessionId)!).push(load);
  }
  const edges = new Map<string, { fromId: string; toId: string; observations: number; sessions: Set<string> }>();
  for (const [sessionId, list] of bySession) {
    list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    for (let index = 1; index < list.length; index += 1) {
      const from = list[index - 1];
      const to = list[index];
      if (from.memoryId === to.memoryId) continue;
      if (Date.parse(to.ts) - Date.parse(from.ts) > options.maxGapMs) continue;
      const key = from.memoryId + " " + to.memoryId;
      const edge = edges.get(key) ?? { fromId: from.memoryId, toId: to.memoryId, observations: 0, sessions: new Set<string>() };
      edge.observations += 1;
      edge.sessions.add(sessionId);
      edges.set(key, edge);
    }
  }
  return [...edges.values()]
    .map((edge) => ({
      fromId: edge.fromId,
      toId: edge.toId,
      observations: edge.observations,
      support: edge.sessions.size,
      established: edge.sessions.size >= options.establishSessions,
      sessionRefs: [...edge.sessions].map((id) => hash("session:" + id)).sort(),
    }))
    .sort((a, b) => b.support - a.support || b.observations - a.observations || a.fromId.localeCompare(b.fromId));
}

// ─── gaps and dens ───────────────────────────────────────────────

export interface DenRow {
  kind: GapKind;
  count: number;
  sessions: number;
  /** den = silent · repeated in ≥ 2 sessions · has a named exit; otherwise noise. */
  verdict: "den" | "noise" | "none";
  exit: string;
  /** Command that reproduces `count` from the raw source, or why only the harvester can. */
  recount: string;
}

const GAP_EXITS: Record<GapKind, string> = {
  "envelope-without-recall-id": "served envelope had no recall_id: batch or error result — extend readEnvelope for that shape or count it as unjoinable",
  "load-without-recall-link": "daemon did not join this load to a recall (join store lost across idle respawn, or a direct load) — see telemetry-join-store",
  "link-without-pool": "load links a recall_id with no recorded candidate_pool — event outside the window or pool not captured on that path",
  "load-not-found": "load_memory for an id the vault did not hold — moved or deleted memory; nothing to classify",
  "unresolved-evidence": "the evidence step had no inspectable identity (Grep/Glob/find_document) — nothing to check against the vault",
  "no-vault-snapshot": "no --vault given: vault membership cannot be proven, hook-lane loads stay unclassified",
};

/** Distinct sessions from which a repeated silent gap counts as a den (ported from the owner's classpulse rule, DENS_MIN_SIDS = 2). */
export const DEN_MIN_SESSIONS = 2;

/**
 * A command that recounts the gap from the raw source, printed next to the
 * number. `{events}` is the telemetry dir. Gaps that need the join itself
 * name the harvester as the only recount.
 */
const GAP_RECOUNT: Record<GapKind, string> = {
  "envelope-without-recall-id": "harvester only: transcript_recalls - transcript_recalls_with_recall_id",
  "load-without-recall-link": "grep -h '\"kind\":\"load_memory\"' {events}/events-*.jsonl | grep -vc 'from_hook_recall\\|follows_recall'",
  "link-without-pool": "harvester only: linked recall_id with no candidate_pool event in the window",
  "load-not-found": "grep -h '\"kind\":\"load_memory\"' {events}/events-*.jsonl | grep -c '\"found\":false'",
  "unresolved-evidence": "harvester only: chains whose evidence step had no file_path or memory id",
  "no-vault-snapshot": "harvester only: --vault not given",
};

export function dens(gaps: GapEvent[], eventsDir = "<events>"): DenRow[] {
  const kinds = Object.keys(GAP_EXITS) as GapKind[];
  return kinds.map((kind) => {
    const hits = gaps.filter((gap) => gap.kind === kind);
    const sessions = new Set(hits.map((gap) => gap.sessionRef).filter((ref): ref is string => ref !== null)).size;
    const verdict: DenRow["verdict"] = hits.length === 0 ? "none" : sessions >= DEN_MIN_SESSIONS ? "den" : "noise";
    return { kind, count: hits.length, sessions, verdict, exit: GAP_EXITS[kind], recount: GAP_RECOUNT[kind].replace("{events}", eventsDir) };
  });
}

// ─── report ──────────────────────────────────────────────────────

export interface EvidenceReport {
  kind: "reviewed-miss-evidence-report/v2";
  coverage: {
    /** Telemetry window in days, or null when every event file in the dir was read. */
    window_days: number | null;
    sessions_scanned: number;
    transcript_recalls: number;
    transcript_recalls_with_recall_id: number;
    transcript_chains: number;
    transcript_chains_joined: number;
    telemetry_pools: number;
    telemetry_pools_by_lane: { recall: number; hook_recall: number };
    telemetry_loads: number;
    telemetry_loads_linked: number;
    vault_ids: number | null;
  };
  observed: {
    by_class: { transcript: Record<ReviewedMissClassification, number>; hook: Record<ReviewedMissClassification, number> };
    /** Classes with ≥ OBSERVED_MIN specimens in this run. */
    live_classes: ReviewedMissClassification[];
    /** Classes seen 1..OBSERVED_MIN-1 times: observed thin, never a verdict. */
    observed_thin: ReviewedMissClassification[];
    heatmap_top: Array<Pick<HeatmapRow, "memoryId" | "surfaced" | "surfacedSessions" | "loaded" | "hub" | "surfacedNeverLoaded">>;
    hubs: number;
    surfaced_never_loaded: number;
    hot_paths_established: number;
    proposals: { targets: number; episodes: number; max_support: number };
  };
  gaps: DenRow[];
  engines: { pool_join: string; vault_snapshot: string; reviewer_labels: string; hook_lane: string };
}

export function emptyClassCounts(): Record<ReviewedMissClassification, number> {
  return Object.fromEntries(REVIEWED_MISS_CLASSES.map((cls) => [cls, 0])) as Record<ReviewedMissClassification, number>;
}

export function countClasses(records: Array<{ classification: ReviewedMissClassification }>): Record<ReviewedMissClassification, number> {
  const counts = emptyClassCounts();
  for (const record of records) counts[record.classification] += 1;
  return counts;
}

/** Specimens a class needs before it is "live"; below that it is observed thin (ported from the owner's bench rule: < 3 bites = not observed, never a verdict). */
export const OBSERVED_MIN = 3;

export function liveClasses(...counts: Array<Record<ReviewedMissClassification, number>>): ReviewedMissClassification[] {
  return REVIEWED_MISS_CLASSES.filter((cls) => counts.reduce((n, c) => n + c[cls], 0) >= OBSERVED_MIN);
}

export function thinClasses(...counts: Array<Record<ReviewedMissClassification, number>>): ReviewedMissClassification[] {
  return REVIEWED_MISS_CLASSES.filter((cls) => {
    const n = counts.reduce((sum, c) => sum + c[cls], 0);
    return n > 0 && n < OBSERVED_MIN;
  });
}

// ─── specimens ───────────────────────────────────────────────────

/**
 * A live-harvested specimen: one hashed observation per (lane, class) with
 * its recorded class and provenance, query removed. Specimens are the
 * positive fixtures the classifier is replayed against, so a change in the
 * classifier that moves a real shape to another class goes red.
 */
export interface Specimen {
  kind: "reviewed-miss-specimen/v1";
  lane: "transcript" | "hook";
  classification: ReviewedMissClassification;
  observation: ReviewedMissObservation;
  provenance: { harvested_at: string; window_days: number | null; sessionRef: string; recallRef: string | null };
}

export function specimensOf(
  records: Array<{ lane: "transcript" | "hook"; classification: ReviewedMissClassification; observation: ReviewedMissObservation; sessionRef: string; recallRef: string | null }>,
  provenance: { harvested_at: string; window_days: number | null },
): Specimen[] {
  const seen = new Set<string>();
  const out: Specimen[] = [];
  for (const record of records) {
    const key = record.lane + ":" + record.classification;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: "reviewed-miss-specimen/v1",
      lane: record.lane,
      classification: record.classification,
      observation: record.observation,
      provenance: { ...provenance, sessionRef: record.sessionRef, recallRef: record.recallRef },
    });
  }
  return out;
}

export function poolsByLane(pools: Map<string, TelemetryPool>): { recall: number; hook_recall: number } {
  const out = { recall: 0, hook_recall: 0 };
  for (const pool of pools.values()) out[pool.lane] += 1;
  return out;
}
