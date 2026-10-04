/**
 * Kontextsteuer, Sitzungsbudget im Schatten und Session-Start des
 * Telemetrie-Reports (#463) — aus `telemetry-report.ts` herausgelöst (#680);
 * dort weiter re-exportiert.
 */
import {
  buildContextLedger,
  CONTEXT_LEDGER_ESTIMATOR,
  HOOK_LANE_KINDS,
  TOOL_PAYLOAD_KINDS,
  type LedgerEvent,
} from "./context-ledger.js";
import { bump, day, isSurfaced, median, num, type ReportEvent } from "./telemetry-report-shared.js";

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

// ─── Session-Start ───────────────────────────────────────────────

export interface SessionStartSection {
  starts: number;
  /** Starts mit `hint_tokens_by_part` (#462) — nur sie tragen die Anteile. */
  withParts: number;
  withoutParts: number;
  totalTokens: number;
  parts: Array<{ part: string; tokens: number; avgPerStart: number; presentIn: number }>;
  bySource: Array<{ source: string; n: number; parts: Array<{ part: string; avg: number }> }>;
  /** #513: Relay-Spuren je Start. Nur Starts mit `pending_lanes` zählen;
   *  ältere Zeilen stehen in `withoutLanes`, nie als 0. */
  pendingLanes: {
    withLanes: number;
    withoutLanes: number;
    recency: { entries: number; presentIn: number; avgChars: number };
    trends: { entries: number; presentIn: number; avgChars: number };
  };
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
  const withLanes = calls.filter((c) => c.pending_lanes && typeof c.pending_lanes === "object");
  const lane = (key: "recency" | "trends") => {
    let entries = 0;
    let presentIn = 0;
    let chars = 0;
    for (const c of withLanes) {
      const l = c.pending_lanes as Record<string, unknown>;
      const n = typeof l[key] === "number" ? (l[key] as number) : 0;
      const ch = typeof l[`${key}_chars`] === "number" ? (l[`${key}_chars`] as number) : 0;
      entries += n;
      chars += ch;
      if (n > 0) presentIn++;
    }
    return { entries, presentIn, avgChars: withLanes.length ? Math.round(chars / withLanes.length) : 0 };
  };
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
    pendingLanes: {
      withLanes: withLanes.length,
      withoutLanes: calls.length - withLanes.length,
      recency: lane("recency"),
      trends: lane("trends"),
    },
  };
}
