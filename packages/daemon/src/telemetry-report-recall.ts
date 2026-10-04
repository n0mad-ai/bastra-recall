/**
 * Recall-Qualität und Evidenzentscheid des Telemetrie-Reports (#463) — aus
 * `telemetry-report.ts` herausgelöst (#680); dort weiter re-exportiert.
 */
import {
  ACCEPT_MAX_SESSION_SHARE,
  ACCEPT_MIN_DAYS,
  ACCEPT_MIN_DECISIONS,
  ACCEPT_MIN_SESSIONS,
  shadowAcceptance,
  type ShadowAcceptance,
} from "./stats-governor.js";
import { bump, day, isSurfaced, num, type ReportEvent, type ReportThresholds } from "./telemetry-report-shared.js";

// ─── Recall-Qualität ─────────────────────────────────────────────

export type Band = "required" | "optional" | "below_floor";
const BANDS: Band[] = ["required", "optional", "below_floor"];

export interface BandRow {
  band: Band;
  candidates: number;
  loaded: number;
  acted: number;
}

export interface QualitySection {
  hookCalls: {
    calls: number;
    reachable: number;
    withHints: number;
    /** Top-Score je erreichbarem Aufruf, gebandet — `none` = kein Kandidat. */
    topScore: Record<Band | "none", number>;
  };
  bands: BandRow[];
  /** Episoden ohne vorangehenden Hint — in keiner Bandquote (#77). */
  directLoads: number;
  bySource: Array<{ source: "bash-tripwire" | "write-edit"; candidates: number; loaded: number; acted: number }>;
  followThrough: {
    loads: number;
    fromHint: number;
    hookRecallsWithHits: number;
    hookRecallsConsumed: number;
    ranks: Array<{ rank: number; count: number }>;
  };
}

function bandFor(score: number, t: ReportThresholds): Band {
  return score >= t.mustLoadScore ? "required" : score >= t.scoreFloor ? "optional" : "below_floor";
}

export function summarizeQuality(events: ReportEvent[], t: ReportThresholds): QualitySection {
  const calls = events.filter((e) => e.kind === "hook_call");
  const topScore: Record<Band | "none", number> = { required: 0, optional: 0, below_floor: 0, none: 0 };
  for (const c of calls) {
    const s = num(c.top_score);
    if (s === null) topScore.none++;
    else topScore[bandFor(s, t)]++;
  }

  const hookRecalls = events.filter((e) => e.kind === "hook_recall" && Array.isArray(e.hits));
  const episodes = events.filter((e) => e.kind === "recall_episode");
  const surfacedEpisodes = episodes.filter(isSurfaced);

  const rows = new Map<Band, BandRow>(BANDS.map((b) => [b, { band: b, candidates: 0, loaded: 0, acted: 0 }]));
  for (const r of hookRecalls) {
    for (const h of r.hits as Array<{ score?: number }>) {
      rows.get(bandFor(Number(h.score ?? 0), t))!.candidates++;
    }
  }
  for (const e of surfacedEpisodes) {
    const band = (BANDS as string[]).includes(String(e.band)) ? (e.band as Band) : "below_floor";
    const row = rows.get(band)!;
    row.loaded++;
    if (e.acted_on === true) row.acted++;
  }

  // #71: Tripwire-Hints (bash-pre-hook) getrennt von Write/Edit-Hints.
  const recallTool = new Map<string, string>();
  for (const r of hookRecalls) recallTool.set(String(r.recall_id), String(r.tool_name ?? ""));
  const src = { "bash-tripwire": { candidates: 0, loaded: 0, acted: 0 }, "write-edit": { candidates: 0, loaded: 0, acted: 0 } };
  for (const r of hookRecalls) {
    const k = String(r.tool_name ?? "") === "Bash" ? "bash-tripwire" : "write-edit";
    src[k].candidates +=(r.hits as unknown[]).length;
  }
  for (const e of surfacedEpisodes) {
    const k = recallTool.get(String(e.recall_id)) === "Bash" ? "bash-tripwire" : "write-edit";
    src[k].loaded++;
    if (e.acted_on === true) src[k].acted++;
  }

  const loads = events.filter((e) => e.kind === "load_memory");
  const fromHint = loads.filter((l) => l.from_hook_recall != null);
  const rankCounts = new Map<string, number>();
  for (const l of fromHint) {
    const r = Number(l.hook_hint_rank ?? 0);
    if (r > 0) bump(rankCounts, String(r));
  }

  return {
    hookCalls: {
      calls: calls.length,
      reachable: calls.filter((c) => c.daemon_reachable === true).length,
      withHints: calls.filter((c) => Number(c.hint_count ?? 0) > 0).length,
      topScore,
    },
    bands: BANDS.map((b) => rows.get(b)!),
    directLoads: episodes.length - surfacedEpisodes.length,
    bySource: (["bash-tripwire", "write-edit"] as const).map((source) => ({ source, ...src[source] })),
    followThrough: {
      loads: loads.length,
      fromHint: fromHint.length,
      hookRecallsWithHits: hookRecalls.filter((r) => (r.hits as unknown[]).length > 0).length,
      hookRecallsConsumed: new Set(fromHint.map((l) => String(l.from_hook_recall))).size,
      ranks: [...rankCounts]
        .map(([rank, count]) => ({ rank: Number(rank), count }))
        .sort((a, b) => a.rank - b.rank),
    },
  };
}

// ─── Evidenzentscheid ────────────────────────────────────────────

interface Decision {
  memory_id: string;
  decision: string;
  abstain_reason?: string;
  hop?: string;
  evidence?: Record<string, unknown>;
}

export interface EvidenceSection {
  shadow: { calls: number; decisions: number; days: number };
  live: { calls: number; decisions: number };
  excluded: { degraded: number; failed: number };
  acceptance: ShadowAcceptance;
  criteria: { minDecisions: number; minDays: number; minSessions: number; maxSessionShare: number };
  /** Entscheidungsmix über alle verwertbaren Läufe (shadow + live). */
  decisions: Array<{ decision: string; count: number }>;
  abstainReasons: Array<{ reason: string; count: number }>;
  requiredByHop: Array<{ hop: string; count: number }>;
  /** required vs. Legacy-required, nur fusionierte Läufe (§9.4). */
  divergence: { agree: number; withholds: number; promotes: number; unknownSpace: number; unfused: number };
}

export function summarizeEvidence(events: ReportEvent[], t: ReportThresholds): EvidenceSection | null {
  const all = events.filter((e) => e.kind === "evidence_decision");
  if (all.length === 0) return null;
  const decisionsOf = (e: ReportEvent): Decision[] => (Array.isArray(e.decisions) ? (e.decisions as Decision[]) : []);
  const failed = all.filter((e) => e.failed === true);
  const degraded = all.filter((e) => e.failed !== true && e.degraded === true);
  const usable = all.filter((e) => e.failed !== true && e.degraded !== true);
  const shadow = usable.filter((e) => e.shadow === true);
  const live = usable.filter((e) => e.shadow !== true);
  const usableDecisions = usable.flatMap(decisionsOf);

  const byDecision = new Map<string, number>();
  const reasons = new Map<string, number>();
  const byHop = new Map<string, number>();
  for (const d of usableDecisions) {
    bump(byDecision, d.decision);
    if (d.abstain_reason) bump(reasons, d.abstain_reason);
    if (d.decision === "required") bump(byHop, d.hop ?? "(no hop recorded)");
  }

  const fused = new Map<string, boolean>();
  for (const r of events) if (r.kind === "hook_recall") fused.set(String(r.recall_id), r.score_kind === "rrf");
  const divergence = { agree: 0, withholds: 0, promotes: 0, unknownSpace: 0, unfused: 0 };
  for (const e of usable) {
    const space = fused.get(String(e.recall_id));
    if (space === undefined) {
      divergence.unknownSpace += decisionsOf(e).length;
      continue;
    }
    if (!space) {
      divergence.unfused += decisionsOf(e).length;
      continue;
    }
    for (const d of decisionsOf(e)) {
      const score = num(d.evidence?.lexical_score);
      if (score === null) continue;
      const legacyRequired = score >= t.mustLoadScore;
      const gateRequired = d.decision === "required";
      if (legacyRequired === gateRequired) divergence.agree++;
      else if (legacyRequired) divergence.withholds++;
      else divergence.promotes++;
    }
  }

  return {
    shadow: {
      calls: shadow.length,
      decisions: shadow.flatMap(decisionsOf).length,
      days: new Set(shadow.map(day)).size,
    },
    live: { calls: live.length, decisions: live.flatMap(decisionsOf).length },
    excluded: { degraded: degraded.length, failed: failed.length },
    acceptance: shadowAcceptance(shadow, decisionsOf),
    criteria: {
      minDecisions: ACCEPT_MIN_DECISIONS,
      minDays: ACCEPT_MIN_DAYS,
      minSessions: ACCEPT_MIN_SESSIONS,
      maxSessionShare: ACCEPT_MAX_SESSION_SHARE,
    },
    decisions: ["required", "optional", "no_answer"].map((decision) => ({ decision, count: byDecision.get(decision) ?? 0 })),
    abstainReasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    requiredByHop: [...byHop].map(([hop, count]) => ({ hop, count })).sort((a, b) => b.count - a.count),
    divergence,
  };
}
