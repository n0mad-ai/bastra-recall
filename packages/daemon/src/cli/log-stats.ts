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
export function aggregate(events: Array<Record<string, unknown>>): LogStats {
  const byMode = new Map<string, LaneStats & { latencies: number[] }>();
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
    if (kindName !== "prompt_hook_call" && kindName !== "hook_call") {
      otherKinds.set(kindName, (otherKinds.get(kindName) ?? 0) + 1);
      continue;
    }
    const mode = kindName === "hook_call" ? "pretooluse" : String(e.detected_mode ?? "unknown");
    let lane = byMode.get(mode);
    if (!lane) {
      lane = {
        mode, calls: 0, withHits: 0, suppressed: 0, gated: 0,
        timeouts: 0, errors: 0, latency: null, latencies: [],
      };
      byMode.set(mode, lane);
    }
    lane.calls++;
    const status = String(e.status ?? "");
    if (status === "timeout") lane.timeouts++;
    else if (status === "error" || status === "daemon-unreachable") lane.errors++;
    if (status === "gated" || status === "skipped" || e.gated === true) lane.gated++;
    if (e.suppressed === true || status === "suppressed") lane.suppressed++;
    if (typeof e.hint_count === "number" && e.hint_count > 0) lane.withHits++;
    const lat = e.latency_ms_total ?? e.latency_ms;
    if (typeof lat === "number") lane.latencies.push(lat);
  }

  const lanes = [...byMode.values()]
    .map(({ latencies, ...rest }) => ({ ...rest, latency: percentiles(latencies) }))
    .sort((a, b) => b.calls - a.calls);

  return {
    from,
    to,
    lanes,
    totals: {
      calls: lanes.reduce((n, l) => n + l.calls, 0),
      timeouts: lanes.reduce((n, l) => n + l.timeouts, 0),
      errors: lanes.reduce((n, l) => n + l.errors, 0),
    },
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
    out.push("(no prompt-hook events in this window — try --since 7d)");
    if (stats.otherKinds.length > 0) {
      out.push(`  other events present: ${stats.otherKinds.map((k) => `${k.kind}×${k.count}`).join(", ")}`);
    }
    out.push(...renderSaves(stats.saves));
    out.push(...renderHintSuppression(stats.hintSuppression));
    return out.join("\n");
  }

  const window = stats.from && stats.to ? `${stats.from.slice(0, 16)} → ${stats.to.slice(0, 16)}` : "—";
  out.push(`prompt-hook lanes — ${stats.totals.calls} call(s), ${window}`);
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

  // The budget is what turns a latency number into a verdict: p90 far under it
  // means the lane has room, p90 near it means the next slow day drops hints.
  const allLat = stats.lanes.flatMap((l) => (l.latency ? [l.latency.p90] : []));
  if (allLat.length > 0) {
    const worst = Math.max(...allLat);
    const headroom = budgetMs > 0 ? Math.round((1 - worst / budgetMs) * 100) : 0;
    out.push(`  hook budget ${budgetMs}ms — worst lane p90 ${worst}ms (${headroom}% headroom)`);
  }
  if (stats.totals.timeouts > 0 || stats.totals.errors > 0) {
    out.push(
      `  ${stats.totals.timeouts} timeout(s), ${stats.totals.errors} error(s) ` +
        `= ${pct(stats.totals.timeouts + stats.totals.errors, stats.totals.calls)} of all calls`,
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

/** The same budget the recalling hooks enforce — read here rather than
 *  imported, because importing a hook module for one constant drags its entry
 *  point in. Keep the default in step with hook.ts / prompt-hook.ts /
 *  todo-hook.ts: a readout that names the wrong ceiling reports the wrong
 *  headroom, which is worse than naming none. */
export const DEFAULT_HOOK_BUDGET_MS = 600;

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
