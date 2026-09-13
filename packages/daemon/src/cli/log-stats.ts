/**
 * `bastra logs --stats` — the readout for the hook lanes (#279, first slice).
 *
 * The event log already records everything needed to judge whether a lane
 * works: which trigger class fired, whether the daemon answered in time,
 * whether anything came back, how long it took. But a value that only exists
 * as a field inside 3 MB of JSONL is not measured in any useful sense — the
 * assertion lane (#252) shipped with exactly one field standing between it and
 * "we have no idea whether this fires", and reading it took a grep and a
 * hand-written Python one-liner.
 *
 * This aggregates that file: per trigger class, how often it fired, how often
 * it surfaced something, and where the latency sits against the hook budget.
 * Read-only, no daemon needed.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultLogDir } from "../learned-recall/harvest.js";
import { foldClientDuplicates, restartWindows, tsOf } from "./log-stats-phases.js";
import { GATE_LANE_BY_KIND, releaseVerdicts, renderReleaseGate } from "./log-stats-thresholds.js";
import { RECALL_BUDGET_MS } from "../hook-budgets.js";

export {
  releaseVerdicts, releaseGateMet, laneVerdict,
  RELEASE_THRESHOLDS, MIN_CALLS_FOR_VERDICT, GATE_LANE_BY_KIND, REQUIRED_LANES,
} from "./log-stats-thresholds.js";

export { foldClientDuplicates, restartWindows, DUPLICATE_WINDOW_MS } from "./log-stats-phases.js";

const EVENT_FILE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface LaneStats {
  /** Trigger class: retrieval | assertion | generic | none — or a future one. */
  mode: string;
  calls: number;
  /** Calls that injected at least one hint. */
  withHits: number;
  /** Calls the empty-streak backoff suppressed (#161). */
  suppressed: number;
  /** Calls the trivial-prompt gate stopped before any work (#151). */
  gated: number;
  timeouts: number;
  errors: number;
  latency: Percentiles | null;
}

export interface Percentiles {
  n: number;
  median: number;
  p90: number;
  max: number;
}

export interface LogStats {
  from: string | null;
  to: string | null;
  lanes: LaneStats[];
  totals: { calls: number; timeouts: number; errors: number };
  /** #305: the same table for the calls that fell inside a daemon restart.
   *  A hook cannot reach a daemon that is not running; counting those calls
   *  with the rest reports a deliberate restart as a delivery failure. */
  restart: { windows: number; lanes: LaneStats[]; calls: number; timeouts: number; errors: number };
  /** #305: client-written rows folded into the daemon row for the same call.
   *  Reported so the readout cannot silently shrink a number it once printed. */
  foldedDuplicates: number;
  /** Non-prompt event kinds seen in the window, for orientation. */
  otherKinds: Array<{ kind: string; count: number }>;
  /** #477: attempted vs. written saves. Until save_hold existed, only the
   *  written half was visible and the hold rate could not be read at all. */
  saves: SaveStats;
  /** #479: automatic hints removed after repeated version-local non-use. */
  hintSuppression: HintSuppressionStats;
}

export interface SaveStats {
  written: number;
  held: number;
  /** Held saves per exit reason, biggest first. */
  byReason: Array<{ reason: string; count: number }>;
}

export interface HintSuppressionStats {
  calls: number;
  hints: number;
  tokens: number;
  byType: Array<{ type: string; count: number }>;
  /** #484: calls per suppression mode. Events without the field predate the
   *  mode and were live. */
  modes: Array<{ mode: string; calls: number }>;
}

/** What the lane surfaced. The field is not called the same thing in every
 *  lane — reading only `hint_count` reported the three lanes that stamp
 *  `hit_count`/`suggested_count` as delivering nothing, ever. */
function hitCountOf(e: Record<string, unknown>): number {
  for (const key of ["hint_count", "hit_count", "suggested_count"]) {
    if (typeof e[key] === "number") return e[key];
  }
  return 0;
}

export function percentiles(values: number[]): Percentiles | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { n: s.length, median: at(0.5), p90: at(0.9), max: s[s.length - 1] };
}

/**
 * Fold raw events into per-lane counters.
 *
 * A `gated` or `suppressed` call still counts as a call: the lane DID classify
 * the prompt, and the interesting ratio is how often that classification led to
 * an injection. Counting only the ones that made it through would report a
 * suppression-heavy lane as a healthy one.
 */
export function aggregate(rawEvents: Array<Record<string, unknown>>): LogStats {
  const { events, folded } = foldClientDuplicates(rawEvents);
  const windows = restartWindows(events);
  const inRestart = (t: number): boolean => windows.some((w) => t >= w.start && t <= w.end);
  const byMode = new Map<string, LaneStats & { latencies: number[] }>();
  const byModeRestart = new Map<string, LaneStats & { latencies: number[] }>();
  const otherKinds = new Map<string, number>();
  const holdReasons = new Map<string, number>();
  const suppressedTypes = new Map<string, number>();
  let written = 0;
  let suppressionCalls = 0;
  let suppressionHints = 0;
  let suppressionTokens = 0;
  const suppressionModes = new Map<string, number>();
  let from: string | null = null;
  let to: string | null = null;

  for (const e of events) {
    const ts = typeof e.ts === "string" ? e.ts : null;
    if (ts) {
      if (from === null || ts < from) from = ts;
      if (to === null || ts > to) to = ts;
    }
    // Both recall-carrying hook families land in the same table: the prompt
    // hook splits by trigger class, the PreToolUse hook has only one lane.
    // Keeping them apart would have hidden the bigger number — the
    // PreToolUse lane is where the volume is.
    const kindName = String(e.kind ?? "event");
    if (kindName === "hook_recall" && Array.isArray(e.usage_suppressed) && e.usage_suppressed.length > 0) {
      suppressionCalls++;
      suppressionHints += e.usage_suppressed.length;
      suppressionTokens += typeof e.usage_suppressed_tokens_est === "number" ? e.usage_suppressed_tokens_est : 0;
      const suppressionMode = typeof e.usage_suppressed_mode === "string" ? e.usage_suppressed_mode : "live";
      suppressionModes.set(suppressionMode, (suppressionModes.get(suppressionMode) ?? 0) + 1);
      for (const item of e.usage_suppressed as Array<Record<string, unknown>>) {
        const type = String(item.type ?? "unknown");
        suppressedTypes.set(type, (suppressedTypes.get(type) ?? 0) + 1);
      }
    }
    // #477: the two halves of the save path, counted before the lane filter —
    // they are not hook calls and would otherwise only appear as a kind name.
    if (kindName === "save_memory") written++;
    if (kindName === "save_hold") {
      const reason = String(e.reason ?? "unknown");
      holdReasons.set(reason, (holdReasons.get(reason) ?? 0) + 1);
    }
    if (kindName !== "prompt_hook_call" && GATE_LANE_BY_KIND[kindName] === undefined) {
      otherKinds.set(kindName, (otherKinds.get(kindName) ?? 0) + 1);
      continue;
    }
    const mode = kindName === "prompt_hook_call" ? String(e.detected_mode ?? "unknown") : GATE_LANE_BY_KIND[kindName];
    const table = inRestart(tsOf(e)) ? byModeRestart : byMode;
    let lane = table.get(mode);
    if (!lane) {
      lane = {
        mode, calls: 0, withHits: 0, suppressed: 0, gated: 0,
        timeouts: 0, errors: 0, latency: null, latencies: [],
      };
      table.set(mode, lane);
    }
    lane.calls++;
    const status = String(e.status ?? "");
    if (status === "timeout") lane.timeouts++;
    else if (status === "error" || status === "daemon-unreachable") lane.errors++;
    // The Stop lane answers `{}` either way and stamps no status at all; its
    // one failure shape is the fail-open backstop, which stamps `error`.
    // Without this the lane's failure rate was 0% by construction.
    else if (status === "" && typeof e.error === "string" && e.error.length > 0) lane.errors++;
    if (status === "gated" || status === "skipped" || e.gated === true) lane.gated++;
    if (e.suppressed === true || status === "suppressed") lane.suppressed++;
    if (hitCountOf(e) > 0) lane.withHits++;
    const lat = e.latency_ms_total ?? e.latency_ms;
    if (typeof lat === "number") lane.latencies.push(lat);
  }

  const finish = (table: Map<string, LaneStats & { latencies: number[] }>): LaneStats[] =>
    [...table.values()]
      .map(({ latencies, ...rest }) => ({ ...rest, latency: percentiles(latencies) }))
      .sort((a, b) => b.calls - a.calls);
  const lanes = finish(byMode);
  const restartLanes = finish(byModeRestart);

  return {
    from,
    to,
    lanes,
    totals: {
      calls: lanes.reduce((n, l) => n + l.calls, 0),
      timeouts: lanes.reduce((n, l) => n + l.timeouts, 0),
      errors: lanes.reduce((n, l) => n + l.errors, 0),
    },
    restart: {
      windows: windows.length,
      lanes: restartLanes,
      calls: restartLanes.reduce((n, l) => n + l.calls, 0),
      timeouts: restartLanes.reduce((n, l) => n + l.timeouts, 0),
      errors: restartLanes.reduce((n, l) => n + l.errors, 0),
    },
    foldedDuplicates: folded,
    otherKinds: [...otherKinds.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    saves: {
      written,
      held: [...holdReasons.values()].reduce((n, c) => n + c, 0),
      byReason: [...holdReasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    },
    hintSuppression: {
      calls: suppressionCalls,
      hints: suppressionHints,
      tokens: suppressionTokens,
      byType: [...suppressedTypes.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count),
      modes: [...suppressionModes.entries()]
        .map(([mode, calls]) => ({ mode, calls }))
        .sort((a, b) => b.calls - a.calls),
    },
  };
}

/** #477 — the save line: attempted, written, held, and where the holds came
 *  from. Printed whenever the window saw either half, including the case where
 *  every attempt was held and nothing was written. */
function renderSaves(s: SaveStats): string[] {
  const attempted = s.written + s.held;
  if (attempted === 0) return [];
  const out = [`  saves — ${attempted} attempted, ${s.written} written, ${s.held} held (${pct(s.held, attempted)})`];
  if (s.byReason.length > 0) {
    out.push(`    held by: ${s.byReason.map((r) => `${r.reason}×${r.count}`).join(", ")}`);
  }
  return out;
}

function renderHintSuppression(s: HintSuppressionStats): string[] {
  if (s.hints === 0) return [];
  // #484: in shadow the same list is produced but nothing leaves the payload —
  // saying "removed"/"avoided" there would report a cut that never happened.
  const live = s.modes.some((m) => m.mode === "live");
  const shadow = s.modes.some((m) => m.mode !== "live");
  const verb = live && shadow ? "removed or would have been removed" : live ? "removed" : "would have been removed";
  const tokens = live && !shadow ? "hook-payload tokens avoided" : "hook-payload tokens";
  const out = [
    `  hint suppression — ${s.hints} repeated-unused hint(s) ${verb} across ${s.calls} recall(s), ~${s.tokens} ${tokens}`,
    `    by type: ${s.byType.map((r) => `${r.type}×${r.count}`).join(", ")}`,
  ];
  if (shadow) out.push(`    mode: ${s.modes.map((m) => `${m.mode}×${m.calls}`).join(", ")}`);
  return out;
}

function pct(part: number, whole: number): string {
  if (whole === 0) return "—";
  const v = (part / whole) * 100;
  return v >= 10 ? `${v.toFixed(0)}%` : `${v.toFixed(1)}%`;
}

export function renderStats(stats: LogStats, budgetMs: number): string {
  const out: string[] = [];
  if (stats.totals.calls === 0) {
    out.push("(no hook-lane events in this window — try --since 7d)");
    // #305: "nothing happened" and "everything happened during a restart" are
    // different answers, and only one of them means the window was too short.
    if (stats.restart.calls > 0) {
      out.push(
        `  ${stats.restart.calls} call(s) fell inside ${stats.restart.windows} daemon restart window(s) and are not counted`,
      );
    }
    if (stats.otherKinds.length > 0) {
      out.push(`  other events present: ${stats.otherKinds.map((k) => `${k.kind}×${k.count}`).join(", ")}`);
    }
    out.push(...renderSaves(stats.saves));
    out.push(...renderHintSuppression(stats.hintSuppression));
    return out.join("\n");
  }

  const window = stats.from && stats.to ? `${stats.from.slice(0, 16)} → ${stats.to.slice(0, 16)}` : "—";
  out.push(`hook lanes — ${stats.totals.calls} call(s), ${window}`);
  out.push("");
  out.push("  lane        calls   with hits   suppressed   gated   timeout   median   p90    max");
  out.push("  " + "─".repeat(78));
  for (const l of stats.lanes) {
    const lat = l.latency;
    out.push(
      "  " +
        l.mode.padEnd(11) +
        String(l.calls).padStart(5) +
        `   ${pct(l.withHits, l.calls)} (${l.withHits})`.padEnd(12) +
        String(l.suppressed).padStart(10) +
        String(l.gated).padStart(8) +
        String(l.timeouts).padStart(10) +
        (lat ? `${lat.median}ms`.padStart(9) : "        —") +
        (lat ? `${lat.p90}ms`.padStart(7) : "      —") +
        (lat ? `${lat.max}ms`.padStart(7) : "      —"),
    );
  }
  out.push("");

  // #305: one budget across lanes that do different amounts of work reported
  // the worst lane's p90 against a ceiling most lanes never approach, and said
  // nothing about whether the thing was shippable. The verdict is per lane now,
  // against the budget that lane actually enforces and the failure ceiling the
  // release gate is written down as.
  const verdicts = releaseVerdicts(stats.lanes);
  out.push(...renderReleaseGate(verdicts));
  // Lanes nobody set a threshold for still get their headroom line — a new
  // lane must not slip in unmeasured just because it has no entry yet.
  const unjudged = verdicts.filter((v) => v.verdict === "no-threshold" && v.p90 !== null);
  for (const v of unjudged) {
    const headroom = budgetMs > 0 ? Math.round((1 - v.p90! / budgetMs) * 100) : 0;
    out.push(`  ${v.mode}: no release threshold set — p90 ${v.p90}ms against ${budgetMs}ms (${headroom}% headroom)`);
  }
  if (stats.totals.timeouts > 0 || stats.totals.errors > 0) {
    out.push(
      `  ${stats.totals.timeouts} timeout(s), ${stats.totals.errors} error(s) ` +
        `= ${pct(stats.totals.timeouts + stats.totals.errors, stats.totals.calls)} of all calls`,
    );
  }
  // #305: the two lines that keep the number above honest — what was excluded
  // as a restart, and what was folded as one call logged twice. Both are
  // stated rather than applied silently: a rate that quietly got better is not
  // a measurement either.
  if (stats.restart.windows > 0) {
    out.push(
      `  excluded: ${stats.restart.calls} call(s) inside ${stats.restart.windows} daemon restart window(s) — ` +
        `${stats.restart.timeouts} timeout(s), ${stats.restart.errors} error(s) there ` +
        `(${pct(stats.restart.timeouts + stats.restart.errors, stats.restart.calls)})`,
    );
  }
  if (stats.foldedDuplicates > 0) {
    out.push(
      `  folded: ${stats.foldedDuplicates} client-side row(s) belonged to a call the daemon also logged ` +
        `(counted once, client verdict kept)`,
    );
  }
  const saveLines = renderSaves(stats.saves);
  if (saveLines.length > 0) {
    out.push("");
    out.push(...saveLines);
  }
  const suppressionLines = renderHintSuppression(stats.hintSuppression);
  if (suppressionLines.length > 0) {
    out.push("");
    out.push(...suppressionLines);
  }
  if (stats.otherKinds.length > 0) {
    out.push("");
    out.push(`  also in window: ${stats.otherKinds.map((k) => `${k.kind}×${k.count}`).join(", ")}`);
  }
  return out.join("\n");
}

/** Read every event newer than `cutoff` out of the JSONL day files. */
export async function readEvents(
  logDir: string,
  cutoff: number,
): Promise<Array<Record<string, unknown>>> {
  let files: string[];
  try {
    files = (await readdir(logDir)).filter((f) => EVENT_FILE.test(f)).sort();
  } catch {
    return [];
  }
  const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
  const out: Array<Record<string, unknown>> = [];
  for (const f of files.filter((f) => (EVENT_FILE.exec(f)?.[1] ?? "") >= cutoffDay)) {
    let raw: string;
    try {
      raw = await readFile(join(logDir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        const ts = Date.parse(String(e.ts));
        if (Number.isNaN(ts) || ts < cutoff) continue;
        out.push(e);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return out;
}

/** Fallback budget for a lane that has no release threshold of its own yet —
 *  the recall lanes' wall clock. Budgets are per lane since #305, so this is no
 *  longer "the" hook budget; RELEASE_THRESHOLDS is where a lane's real ceiling
 *  lives, and hook-budgets.ts is where both come from. */
export const DEFAULT_HOOK_BUDGET_MS = RECALL_BUDGET_MS;

function hookBudgetMs(): number {
  const raw = process.env.BASTRA_HOOK_TIMEOUT_MS ?? process.env.NEXUS_HOOK_TIMEOUT_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HOOK_BUDGET_MS;
}

export async function cmdLogStats(opts: { sinceMs: number }): Promise<number> {
  const events = await readEvents(defaultLogDir(), Date.now() - opts.sinceMs);
  process.stdout.write(`${renderStats(aggregate(events), hookBudgetMs())}\n`);
  return 0;
}
