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
import { resolveRetentionDays } from "./log-retention.js";
import { isEvalTraffic } from "./telemetry-dimensions.js";
import { foldClientDuplicates, restartWindows, tsOf } from "./cli/log-stats-phases.js";
import { summarizeHintSuppression, type HintSuppressionSection } from "./telemetry-report-suppression.js";
export { summarizeHintSuppression } from "./telemetry-report-suppression.js";
import { summarizeCodeAwareness, type CodeAwarenessSection } from "./telemetry-report-code.js";
import { aggregateSaveSuggestions, type SaveSuggestionStats } from "./save-suggestion-stats.js";
export { summarizeCodeAwareness, type CodeAwarenessSection } from "./telemetry-report-code.js";
import { median, num, p95, day, bump, type ReportEvent, type ReportThresholds } from "./telemetry-report-shared.js";
export type { ReportEvent, ReportThresholds } from "./telemetry-report-shared.js";
import { summarizeEvidence, summarizeQuality, type EvidenceSection, type QualitySection } from "./telemetry-report-recall.js";
export {
  summarizeEvidence,
  summarizeQuality,
  type Band,
  type BandRow,
  type EvidenceSection,
  type QualitySection,
} from "./telemetry-report-recall.js";
import {
  summarizeBudgetShadow,
  summarizeContextTax,
  summarizeSessionStart,
  type BudgetShadowSection,
  type ContextTaxSection,
  type SessionStartSection,
} from "./telemetry-report-tokens.js";
export {
  DIRECTIVE_TYPES,
  summarizeBudgetShadow,
  summarizeContextTax,
  summarizeSessionStart,
  type BudgetShadowSection,
  type ContextTaxSection,
  type LedgerRow,
  type SessionStartSection,
} from "./telemetry-report-tokens.js";

export const TELEMETRY_REPORT_VERSION = 1;

const EVENT_FILE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface EventWindow {
  events: ReportEvent[];
  /** Geöffnete Tagesdateien. */
  files: number;
  /** Ältester und jüngster Zeitstempel im Fenster. */
  from: string | null;
  to: string | null;
  /** #664: eval/synthetic rows left out (#619) — 0 when `includeEval`. */
  excludedEval: number;
  /** #664: client rows folded into the daemon row of the same call. */
  foldedDuplicates: number;
}

/**
 * Ereignisse der letzten `days` Tage. Dateien vor dem Fenster-Tag werden gar
 * nicht geöffnet — auf einer Installation mit drei Monaten Logs sind das
 * über 100 MB, die ein 7-Tage-Fenster nie braucht.
 */
export async function readEventWindow(
  logDir: string,
  days: number,
  now = Date.now(),
  includeEval = false,
): Promise<EventWindow> {
  let files: string[];
  try {
    files = (await readdir(logDir)).filter((f) => EVENT_FILE.test(f)).sort();
  } catch {
    return { events: [], files: 0, from: null, to: null, excludedEval: 0, foldedDuplicates: 0 };
  }
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
  const relevant = files.filter((f) => (EVENT_FILE.exec(f)?.[1] ?? "") >= cutoffDay);
  const read: ReportEvent[] = [];
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
        read.push(e);
      } catch {
        /* skip malformed line */
      }
    }
  }
  // #664: the same two filters `bastra logs --stats` applies, once, here —
  // so every section of the UI counts what the CLI counts: eval/synthetic
  // traffic out unless asked for (#619), and a stub row folded into the
  // daemon row of the same hook call (#305).
  const kept = includeEval ? read : read.filter((e) => !isEvalTraffic(e));
  const { events: foldedEvents, folded } = foldClientDuplicates(kept);
  const events = foldedEvents as ReportEvent[];
  let from: string | null = null;
  let to: string | null = null;
  for (const e of events) {
    if (from === null || e.ts < from) from = e.ts;
    if (to === null || e.ts > to) to = e.ts;
  }
  return {
    events,
    files: relevant.length,
    from,
    to,
    excludedEval: read.length - kept.length,
    foldedDuplicates: folded,
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

export function summarizeLatency(events: ReportEvent[]): LatencySection & { excludedRestart: number } {
  // The CLI (`log-stats.ts`'s `aggregate`) excludes calls that landed
  // inside a daemon-restart window from its totals — a cold warmup skews
  // latency and is not a delivery number worth reporting alongside steady
  // state. This section had no such exclusion at all, so the same log
  // produced a higher call count here than the CLI ever showed for it
  // (measured: 10 vs 9 on one synthetic log) — the #664 claim that "every
  // section of the UI counts what the CLI counts" did not hold for latency.
  const windows = restartWindows(events);
  const inRestart = (t: number): boolean => windows.some((w) => t >= w.start && t <= w.end);
  const byLane = new Map<string, number[]>();
  const perDay = new Map<string, { hook: number[]; recall: number[] }>();
  // Stated, not applied silently — the CLI prints its `excluded:` line too.
  let excludedRestart = 0;
  for (const e of events) {
    const field = LATENCY_FIELD[e.kind];
    if (!field) continue;
    const v = num(e[field]);
    if (v === null) continue;
    if (inRestart(tsOf(e))) {
      excludedRestart++;
      continue;
    }
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
    excludedRestart,
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
    /** #664: what the CLI states as excluded / folded, stated here too. */
    excludedEval: number;
    foldedDuplicates: number;
    /** #875: calls the latency section left out because they fell inside a
     *  daemon-restart window. Latency only — every other section counts them. */
    excludedRestart: number;
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
  /** #708/#662: suggested sessions → sessions that saved; the same fold
   *  `bastra logs --stats` prints. Null while the window holds no suggestion. */
  saveSuggestions: SaveSuggestionStats | null;
  /** #479: live cross-session noise removed from automatic hook injection. */
  hintSuppression: HintSuppressionSection | null;
  /** #579: code awareness — the tools that were called and the blocks that
   *  were injected. Null while the window saw neither. */
  codeAwareness: CodeAwarenessSection | null;
  sessionStart: SessionStartSection;
}

export function buildTelemetryReport(
  window: EventWindow,
  days: number,
  t: ReportThresholds,
  retentionDays = resolveRetentionDays(),
): TelemetryReport {
  const events = window.events;
  const { excludedRestart, ...latency } = summarizeLatency(events);
  return {
    version: TELEMETRY_REPORT_VERSION,
    window: {
      days,
      from: window.from,
      to: window.to,
      files: window.files,
      events: events.length,
      retentionDays,
      excludedEval: window.excludedEval,
      foldedDuplicates: window.foldedDuplicates,
      excludedRestart,
    },
    thresholds: t,
    quality: summarizeQuality(events, t),
    contextTax: summarizeContextTax(events),
    budgetShadow: summarizeBudgetShadow(events),
    latency,
    evidence: summarizeEvidence(events, t),
    saves: summarizeSaves(events),
    saveSuggestions: aggregateSaveSuggestions(events),
    hintSuppression: summarizeHintSuppression(events),
    codeAwareness: summarizeCodeAwareness(events),
    sessionStart: summarizeSessionStart(events),
  };
}
