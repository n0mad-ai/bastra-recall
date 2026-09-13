/**
 * Der Telemetrie-Report für die UI (#463) — die Serien aus `stats.ts` als
 * JSON, nicht als Konsolentext.
 *
 * Reine Rechnung über geladene Ereignisse: keine Persistenz, kein Rohtext,
 * keine neue Instrumentierung. Jede Serie hier gibt es bereits in
 * `packages/daemon/scripts/stats.ts`; dieses Modul faltet dieselben Felder
 * nach denselben Regeln und trägt die Lücken ausdrücklich mit:
 *
 *   - Zeilen ohne ein Feld zählen als `unknown`, nie als 0 (Ledger, #457).
 *   - `hinted_types` gibt es erst seit #354 — ältere Emissionen bleiben
 *     `unknown` typisiert und werden NICHT als Fakten gezählt.
 *   - `hint_tokens_by_part` gibt es erst seit #462 — Starts ohne das Feld
 *     werden gezählt und ausgewiesen, nicht in die Anteile eingerechnet.
 *   - Divergenzen gegen Legacy nur auf fusionierten Läufen (§9.4).
 *
 * Gelesen wird tageweise: Die Logdateien tragen den Tag im Namen, also
 * werden nur die Dateien geöffnet, die im Fenster liegen können.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildContextLedger,
  CONTEXT_LEDGER_ESTIMATOR,
  HOOK_LANE_KINDS,
  TOOL_PAYLOAD_KINDS,
  type LedgerEvent,
} from "./context-ledger.js";
import {
  ACCEPT_MAX_SESSION_SHARE,
  ACCEPT_MIN_DAYS,
  ACCEPT_MIN_DECISIONS,
  ACCEPT_MIN_SESSIONS,
  shadowAcceptance,
  type AnyEventLike,
  type ShadowAcceptance,
} from "./stats-governor.js";
import { resolveRetentionDays } from "./log-retention.js";
import { summarizeHintSuppression, type HintSuppressionSection } from "./telemetry-report-suppression.js";
export { summarizeHintSuppression } from "./telemetry-report-suppression.js";

export const TELEMETRY_REPORT_VERSION = 1;

export type ReportEvent = AnyEventLike;

const EVENT_FILE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface EventWindow {
  events: ReportEvent[];
  /** Geöffnete Tagesdateien. */
  files: number;
  /** Ältester und jüngster Zeitstempel im Fenster. */
  from: string | null;
  to: string | null;
}

/**
 * Ereignisse der letzten `days` Tage. Dateien vor dem Fenster-Tag werden gar
 * nicht geöffnet — auf einer Installation mit drei Monaten Logs sind das
 * über 100 MB, die ein 7-Tage-Fenster nie braucht.
 */
export async function readEventWindow(logDir: string, days: number, now = Date.now()): Promise<EventWindow> {
  let files: string[];
  try {
    files = (await readdir(logDir)).filter((f) => EVENT_FILE.test(f)).sort();
  } catch {
    return { events: [], files: 0, from: null, to: null };
  }
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
  const relevant = files.filter((f) => (EVENT_FILE.exec(f)?.[1] ?? "") >= cutoffDay);
  const events: ReportEvent[] = [];
  for (const f of relevant) {
    let raw: string;
    try {
      raw = await readFile(join(logDir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as ReportEvent;
        if (typeof e.kind !== "string" || typeof e.ts !== "string") continue;
        if (Date.parse(e.ts) < cutoff) continue;
        events.push(e);
      } catch {
        /* skip malformed line */
      }
    }
  }
  let from: string | null = null;
  let to: string | null = null;
  for (const e of events) {
    if (from === null || e.ts < from) from = e.ts;
    if (to === null || e.ts > to) to = e.ts;
  }
  return { events, files: relevant.length, from, to };
}

// ─── Hilfen ──────────────────────────────────────────────────────

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const p95 = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const day = (e: ReportEvent): string => String(e.ts).slice(0, 10);
const bump = (m: Map<string, number>, key: string, n = 1): void => {
  m.set(key, (m.get(key) ?? 0) + n);
};

export interface ReportThresholds {
  mustLoadScore: number;
  scoreFloor: number;
}

// ─── Recall-Qualität ─────────────────────────────────────────────

export type Band = "required" | "optional" | "below_floor";
const BANDS: Band[] = ["required", "optional", "below_floor"];

export interface BandRow {
  band: Band;
  surfaced: number;
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
  bySource: Array<{ source: "bash-tripwire" | "write-edit"; surfaced: number; loaded: number; acted: number }>;
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

const isSurfaced = (e: ReportEvent): boolean =>
  typeof e.surfaced === "boolean" ? Boolean(e.surfaced) : e.surfaced_score != null;

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

  const rows = new Map<Band, BandRow>(BANDS.map((b) => [b, { band: b, surfaced: 0, loaded: 0, acted: 0 }]));
  for (const r of hookRecalls) {
    for (const h of r.hits as Array<{ score?: number }>) {
      rows.get(bandFor(Number(h.score ?? 0), t))!.surfaced++;
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
  const src = { "bash-tripwire": { surfaced: 0, loaded: 0, acted: 0 }, "write-edit": { surfaced: 0, loaded: 0, acted: 0 } };
  for (const r of hookRecalls) {
    const k = String(r.tool_name ?? "") === "Bash" ? "bash-tripwire" : "write-edit";
    src[k].surfaced += (r.hits as unknown[]).length;
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

// ─── Kontextsteuer ───────────────────────────────────────────────

export interface LedgerRow {
  kind: string;
  tokens: number;
  emissions: number;
  unknown: number;
}

export interface ContextTaxSection {
  estimator: string;
  totalTokens: number;
  totalUnknown: number;
  emissions: number;
  lanes: LedgerRow[];
  tools: LedgerRow[];
  loadByPresentation: LedgerRow[];
  /** Tokens je Kalendertag, Lanes und Tool-Payloads getrennt. */
  daily: Array<{ day: string; lanes: number; tools: number; unknown: number; sessions: number }>;
  topSessions: Array<{ session: string; tokens: number; emissions: number }>;
  archival: {
    /** Emittiert ≥3×, acted_on 0, bewertbarer Typ — Archiv-Kandidaten. */
    candidates: Array<{ id: string; emitted: number; type: string }>;
    /** Dieselbe Bedingung, aber Direktiv-Typ — KEINE Kandidaten (#354). */
    directives: Array<{ id: string; emitted: number; type: string }>;
    /** Kandidaten, deren Typ aus Zeilen vor `hinted_types` stammt — unverifiziert. */
    unknownTyped: number;
    /** Hook-Emissionen mit / ohne `hinted_types` — die Lücke, die die Liste trägt. */
    typedEmissions: number;
    untypedEmissions: number;
  };
}

/** Typen, die Verhalten vorschreiben — Heuristik aus stats.ts (#354). */
export const DIRECTIVE_TYPES = new Set(["preference", "user-preference", "meta-working", "workflow"]);

export function summarizeContextTax(events: ReportEvent[]): ContextTaxSection {
  const ledger = buildContextLedger(events as LedgerEvent[]);
  const t = ledger.total;
  const row = (kind: string, p: { emissions: number; tokens: number; unknown: number }): LedgerRow => ({
    kind,
    tokens: p.tokens,
    emissions: p.emissions,
    unknown: p.unknown,
  });
  const emissions = [...Object.values(t.lanes), ...Object.values(t.tools)].reduce((s, p) => s + p.emissions, 0);

  // Tagesreihe: dieselben Regeln wie der Ledger, nur nach Tag gefaltet.
  const perDay = new Map<string, { lanes: number; tools: number; unknown: number; sessions: Set<string> }>();
  const laneSet = new Set<string>(HOOK_LANE_KINDS);
  const toolSet = new Set<string>(TOOL_PAYLOAD_KINDS);
  for (const e of events) {
    let side: "lanes" | "tools";
    let size: number | null;
    if (laneSet.has(e.kind)) {
      side = "lanes";
      size = num(e.hint_tokens_est);
    } else if (toolSet.has(e.kind)) {
      if (e.found === false) continue;
      side = "tools";
      size = e.kind === "recall" ? num(e.payload_tokens_est) : num(e.delivered_tokens_est);
    } else continue;
    const d = day(e);
    const r = perDay.get(d) ?? { lanes: 0, tools: 0, unknown: 0, sessions: new Set<string>() };
    if (size === null) r.unknown++;
    else r[side] += size;
    const sid = typeof e.caller_session === "string" && e.caller_session ? e.caller_session : String(e.session_id ?? "");
    if (sid) r.sessions.add(sid);
    perDay.set(d, r);
  }
  const daily = [...perDay]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([d, r]) => ({ day: d, lanes: r.lanes, tools: r.tools, unknown: r.unknown, sessions: r.sessions.size }));

  const topSessions = [...ledger.sessions.values()]
    .filter((s) => s.session !== "(none)")
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 8)
    .map((s) => ({
      session: s.session,
      tokens: s.totalTokens,
      emissions: [...Object.values(s.lanes), ...Object.values(s.tools)].reduce((n, p) => n + p.emissions, 0),
    }));

  // Archiv-Kandidaten (#354): emittiert ≥3×, nie acted_on — geteilt nach
  // Direktive/Fakt, und der Typ nur aus Zeilen, die ihn tragen.
  const emitted = new Map<string, number>();
  const typeById = new Map<string, string>();
  let typedEmissions = 0;
  let untypedEmissions = 0;
  for (const e of events) {
    if (!laneSet.has(e.kind) || !Array.isArray(e.hinted_ids)) continue;
    const ids = e.hinted_ids as string[];
    if (ids.length === 0) continue;
    const types = Array.isArray(e.hinted_types) ? (e.hinted_types as string[]) : null;
    if (types) typedEmissions++;
    else untypedEmissions++;
    ids.forEach((id, i) => {
      bump(emitted, id);
      if (types?.[i]) typeById.set(id, types[i]);
    });
  }
  const actedByMemory = new Map<string, number>();
  for (const e of events) {
    if (e.kind === "recall_episode" && isSurfaced(e) && e.acted_on === true) bump(actedByMemory, String(e.memory_id));
  }
  const unused = [...emitted]
    .map(([id, n]) => ({ id, emitted: n, type: typeById.get(id) ?? "unknown" }))
    .filter((x) => (actedByMemory.get(x.id) ?? 0) === 0 && x.emitted >= 3)
    .sort((a, b) => b.emitted - a.emitted);
  const candidates = unused.filter((x) => !DIRECTIVE_TYPES.has(x.type));
  const directives = unused.filter((x) => DIRECTIVE_TYPES.has(x.type));

  return {
    estimator: CONTEXT_LEDGER_ESTIMATOR,
    totalTokens: t.totalTokens,
    totalUnknown: t.totalUnknown,
    emissions,
    lanes: HOOK_LANE_KINDS.map((k) => row(k, t.lanes[k])),
    tools: TOOL_PAYLOAD_KINDS.map((k) => row(k, t.tools[k])),
    loadByPresentation: [row("lean", t.loadByPresentation.lean), row("full", t.loadByPresentation.full)],
    daily,
    topSessions,
    archival: {
      candidates: candidates.slice(0, 15),
      directives: directives.slice(0, 15),
      unknownTyped: candidates.filter((x) => x.type === "unknown").length,
      typedEmissions,
      untypedEmissions,
    },
  };
}

// ─── Sitzungsbudget im Schatten (#458) ───────────────────────────

export interface BudgetShadowSection {
  /** Die Budgethöhe der jüngsten Entscheidung im Fenster; 0 = unbegrenzt. */
  budget: number;
  /** Verschiedene Budgethöhen im Fenster — mehr als eine heißt: der Wert wurde umgestellt. */
  budgets: number[];
  emissions: number;
  tokens: number;
  sessions: number;
  /** Sitzungen mit mindestens einer Emission, die nicht mehr gepasst hätte. */
  sessionsAffected: number;
  /** Emissionen, die im Schatten gefallen wären, und ihre Tokens. */
  wouldDrop: number;
  tokensTrimmed: number;
  byLane: Array<{ lane: string; emissions: number; tokens: number; wouldDrop: number; tokensTrimmed: number }>;
  daily: Array<{ day: string; tokens: number; tokensTrimmed: number; wouldDrop: number; sessionsAffected: number }>;
  /** Wievielte Emission einer Sitzung zuerst nicht mehr passte — Median über die betroffenen Sitzungen. */
  firstOverAtEmission: number | null;
}

export function summarizeBudgetShadow(events: ReportEvent[]): BudgetShadowSection | null {
  const rows = events.filter((e) => e.kind === "budget_shadow");
  if (rows.length === 0) return null;
  const budgets = new Set<number>();
  const sessions = new Set<string>();
  const affected = new Set<string>();
  const byLane = new Map<string, { emissions: number; tokens: number; wouldDrop: number; tokensTrimmed: number }>();
  const perDay = new Map<string, { tokens: number; tokensTrimmed: number; wouldDrop: number; affected: Set<string> }>();
  const firstOver: number[] = [];
  let tokens = 0;
  let wouldDrop = 0;
  let tokensTrimmed = 0;
  let latest: ReportEvent | null = null;
  for (const e of rows) {
    const t = num(e.tokens) ?? 0;
    const lane = String(e.lane ?? "unknown");
    const sid = String(e.session_id ?? "");
    const drop = e.would_drop === true;
    const b = num(e.budget);
    if (b !== null) budgets.add(b);
    if (!latest || String(e.ts) >= String(latest.ts)) latest = e;
    sessions.add(sid);
    tokens += t;
    const l = byLane.get(lane) ?? { emissions: 0, tokens: 0, wouldDrop: 0, tokensTrimmed: 0 };
    l.emissions++;
    l.tokens += t;
    const d = perDay.get(day(e)) ?? { tokens: 0, tokensTrimmed: 0, wouldDrop: 0, affected: new Set<string>() };
    d.tokens += t;
    if (drop) {
      wouldDrop++;
      tokensTrimmed += t;
      affected.add(sid);
      l.wouldDrop++;
      l.tokensTrimmed += t;
      d.wouldDrop++;
      d.tokensTrimmed += t;
      d.affected.add(sid);
      if (e.first_over === true) firstOver.push(num(e.emission_index) ?? 0);
    }
    byLane.set(lane, l);
    perDay.set(day(e), d);
  }
  return {
    budget: num(latest?.budget) ?? 0,
    budgets: [...budgets].sort((a, b) => a - b),
    emissions: rows.length,
    tokens,
    sessions: sessions.size,
    sessionsAffected: affected.size,
    wouldDrop,
    tokensTrimmed,
    byLane: HOOK_LANE_KINDS.filter((k) => byLane.has(k)).map((lane) => ({ lane, ...byLane.get(lane)! })),
    daily: [...perDay]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([d, r]) => ({ day: d, tokens: r.tokens, tokensTrimmed: r.tokensTrimmed, wouldDrop: r.wouldDrop, sessionsAffected: r.affected.size })),
    firstOverAtEmission: firstOver.length ? median(firstOver) : null,
  };
}

// ─── Latenz ──────────────────────────────────────────────────────

export interface LatencyRow {
  lane: string;
  n: number;
  median: number;
  p95: number;
}

export interface LatencySection {
  lanes: LatencyRow[];
  /** Je Tag: Hook-Gesamtlatenz (alle Hook-Lanes) und Daemon-Recall. */
  daily: Array<{ day: string; hook: LatencyRow | null; recall: LatencyRow | null }>;
}

/** Welches Feld je Ereignisart die Latenz trägt. */
const LATENCY_FIELD: Record<string, string> = {
  hook_call: "latency_ms_total",
  session_hook_call: "latency_ms_total",
  prompt_hook_call: "latency_ms_total",
  bash_hook_call: "latency_ms_total",
  bash_fail_hook_call: "latency_ms_total",
  todo_hook_call: "latency_ms_total",
  hook_recall: "latency_ms_recall",
  recall: "latency_ms",
};

const latencyRow = (lane: string, xs: number[]): LatencyRow => ({ lane, n: xs.length, median: median(xs), p95: p95(xs) });

export function summarizeLatency(events: ReportEvent[]): LatencySection {
  const byLane = new Map<string, number[]>();
  const perDay = new Map<string, { hook: number[]; recall: number[] }>();
  for (const e of events) {
    const field = LATENCY_FIELD[e.kind];
    if (!field) continue;
    const v = num(e[field]);
    if (v === null) continue;
    const list = byLane.get(e.kind) ?? [];
    list.push(v);
    byLane.set(e.kind, list);
    const d = day(e);
    const r = perDay.get(d) ?? { hook: [], recall: [] };
    if (e.kind === "hook_recall" || e.kind === "recall") r.recall.push(v);
    else r.hook.push(v);
    perDay.set(d, r);
  }
  return {
    lanes: Object.keys(LATENCY_FIELD)
      .filter((k) => byLane.has(k))
      .map((k) => latencyRow(k, byLane.get(k)!)),
    daily: [...perDay]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([d, r]) => ({
        day: d,
        hook: r.hook.length ? latencyRow("hook", r.hook) : null,
        recall: r.recall.length ? latencyRow("recall", r.recall) : null,
      })),
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

// ─── Save-Pfad (#477) ────────────────────────────────────────────

export interface SaveSection {
  /** Saves that became a file. */
  written: number;
  /** Saves that exited before the write — the half that was invisible. */
  held: number;
  /** Held saves per exit reason, biggest first. */
  byReason: Array<{ reason: string; count: number }>;
  /** Claim-gate holds only: how many memories the gate found unanswered. */
  claimedTotal: number;
  /** Writes split by create vs. overwrite — a held save is neither. */
  created: number;
  overwritten: number;
}

/**
 * The save path in both halves. Before #477 only `save_memory` was logged, so
 * the ledger showed successful writes and nothing else: a save the claim gate
 * held, a `conflict_with` redirect and the two throwing exits left no trace at
 * all, and the hold rate was not derivable from the log in any way.
 *
 * Returns null when the window saw neither half — a vault that simply did not
 * save in the window should not grow an empty section.
 */
export function summarizeSaves(events: ReportEvent[]): SaveSection | null {
  const writes = events.filter((e) => e.kind === "save_memory");
  const holds = events.filter((e) => e.kind === "save_hold");
  if (writes.length === 0 && holds.length === 0) return null;

  const byReason = new Map<string, number>();
  let claimedTotal = 0;
  for (const h of holds) {
    bump(byReason, String(h.reason ?? "unknown"));
    const claimed = num(h.claimed_count);
    if (claimed !== null) claimedTotal += claimed;
  }

  return {
    written: writes.length,
    held: holds.length,
    byReason: [...byReason].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    claimedTotal,
    created: writes.filter((e) => e.created === true).length,
    overwritten: writes.filter((e) => e.overwrite === true).length,
  };
}

// ─── Cross-session hint suppression (#479) ────────────────────────

// ─── Session-Start ───────────────────────────────────────────────

export interface SessionStartSection {
  starts: number;
  /** Starts mit `hint_tokens_by_part` (#462) — nur sie tragen die Anteile. */
  withParts: number;
  withoutParts: number;
  totalTokens: number;
  parts: Array<{ part: string; tokens: number; avgPerStart: number; presentIn: number }>;
  bySource: Array<{ source: string; n: number; parts: Array<{ part: string; avg: number }> }>;
}

export function summarizeSessionStart(events: ReportEvent[]): SessionStartSection {
  const calls = events.filter((e) => e.kind === "session_hook_call");
  const withParts = calls.filter((c) => c.hint_tokens_by_part && typeof c.hint_tokens_by_part === "object");
  const totals = new Map<string, number>();
  const hits = new Map<string, number>();
  const bySource = new Map<string, { n: number; parts: Map<string, number> }>();
  let all = 0;
  for (const c of withParts) {
    const parts = c.hint_tokens_by_part as Record<string, unknown>;
    const s = String(c.source ?? "unknown");
    const row = bySource.get(s) ?? { n: 0, parts: new Map<string, number>() };
    row.n++;
    for (const [part, v] of Object.entries(parts)) {
      const n = typeof v === "number" ? v : 0;
      bump(totals, part, n);
      if (n > 0) bump(hits, part);
      bump(row.parts, part, n);
      all += n;
    }
    bySource.set(s, row);
  }
  return {
    starts: calls.length,
    withParts: withParts.length,
    withoutParts: calls.length - withParts.length,
    totalTokens: all,
    parts: [...totals]
      .filter(([part, total]) => total > 0 || (hits.get(part) ?? 0) > 0)
      .map(([part, tokens]) => ({
        part,
        tokens,
        avgPerStart: withParts.length ? Math.round(tokens / withParts.length) : 0,
        presentIn: hits.get(part) ?? 0,
      }))
      .sort((a, b) => b.tokens - a.tokens),
    bySource: [...bySource]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([source, row]) => ({
        source,
        n: row.n,
        parts: [...row.parts]
          .filter(([, v]) => v > 0)
          .map(([part, v]) => ({ part, avg: Math.round(v / row.n) }))
          .sort((a, b) => b.avg - a.avg),
      })),
  };
}

// ─── Der Report ──────────────────────────────────────────────────

export interface TelemetryReport {
  version: number;
  window: {
    days: number;
    from: string | null;
    to: string | null;
    files: number;
    events: number;
    /** Das längste Fenster, das die Retention ehrlich hergibt. */
    retentionDays: number;
  };
  thresholds: ReportThresholds;
  quality: QualitySection;
  contextTax: ContextTaxSection;
  /** #458: das Sitzungsbudget im Schatten — null, solange kein Ereignis vorliegt. */
  budgetShadow: BudgetShadowSection | null;
  latency: LatencySection;
  evidence: EvidenceSection | null;
  /** #477: attempted vs. written saves — null while the window saw neither. */
  saves: SaveSection | null;
  /** #479: live cross-session noise removed from automatic hook injection. */
  hintSuppression: HintSuppressionSection | null;
  sessionStart: SessionStartSection;
}

export function buildTelemetryReport(
  window: EventWindow,
  days: number,
  t: ReportThresholds,
  retentionDays = resolveRetentionDays(),
): TelemetryReport {
  const events = window.events;
  return {
    version: TELEMETRY_REPORT_VERSION,
    window: { days, from: window.from, to: window.to, files: window.files, events: events.length, retentionDays },
    thresholds: t,
    quality: summarizeQuality(events, t),
    contextTax: summarizeContextTax(events),
    budgetShadow: summarizeBudgetShadow(events),
    latency: summarizeLatency(events),
    evidence: summarizeEvidence(events, t),
    saves: summarizeSaves(events),
    hintSuppression: summarizeHintSuppression(events),
    sessionStart: summarizeSessionStart(events),
  };
}
