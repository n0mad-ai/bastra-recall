/**
 * Hook context load (#1465, #1460, #1461, #1464) — the repeatable part of the
 * #1371 measurement. The transcript scripts of that run were never checked in
 * and are gone (see reports/context-load-1371-2026-11-03.md); what CAN be
 * repeated from the event log is what every hook lane books about itself:
 *
 *   - per lane event kind (and main thread / subagent): calls, calls that
 *     injected text, and the injected size (`hint_tokens_est`, chars/4);
 *   - draft hints per hook event (`draft_hint`), which ride on top of a lane;
 *   - rule-kernel re-deliveries of the gate lane (`gate_hook_call` with
 *     `kernel_chars`, or `kernel_reminder_chars` for the short form), and how
 *     many of them repeated an identical kernel inside the same session;
 *   - the plan lane (`todo_hook_call`) per client.
 *
 *   npm run hook-context-load --workspace @bastra-recall/eval
 *   (SINCE=2026-11-03 / UNTIL=2026-11-17 — ISO days, inclusive; default: the
 *    last 14 days. BASTRA_LOG_PATH as everywhere else.)
 *
 * Read-only and descriptive: no daemon, no vault, no causal claim. Sizes are
 * the lanes' own chars/4 estimates, not tokenizer counts.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Ev = Record<string, unknown>;

/** Lane events that write text into the agent's context. */
export const LANE_KINDS = [
  "session_hook_call",
  "prompt_hook_call",
  "hook_call",
  "bash_hook_call",
  "bash_fail_hook_call",
  "todo_hook_call",
] as const;

export interface SizeRow {
  key: string;
  calls: number;
  /** Calls with a non-zero injected size. */
  emitted: number;
  p50: number;
  p95: number;
  max: number;
  sum: number;
}

export interface KernelRow {
  agent: string;
  /** Full-text kernel deliveries. */
  full: number;
  fullChars: number;
  /** Full deliveries whose kernel (ids + size) this session already received. */
  identical: number;
  identicalChars: number;
  /** Short reminders sent instead of an unchanged kernel (#1461). */
  reminders: number;
  reminderChars: number;
}

export interface HookContextLoad {
  events: number;
  lanes: SizeRow[];
  drafts: SizeRow[];
  kernel: KernelRow[];
  plan: SizeRow[];
  /** Plan-lane recalls (`hook_recall`, hook_source todo) and how many of them a
   *  later `load_memory` names as its `from_hook_recall` — the usage signal. */
  planFollowThrough: { recalls: number; followed: number };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const dimension = (e: Ev, name: string): string => {
  const d = e.dimensions;
  return d && typeof d === "object" ? str((d as Record<string, unknown>)[name]) || "unknown" : "unknown";
};
const agentOf = (e: Ev): string => dimension(e, "agent");
const clientOf = (e: Ev): string => dimension(e, "client");
const hookSourceOf = (e: Ev): string => dimension(e, "hook_source");

function sizeRows(groups: Map<string, number[]>): SizeRow[] {
  return [...groups.entries()]
    .map(([key, all]) => {
      const sizes = all.filter((n) => n > 0).sort((a, b) => a - b);
      const at = (q: number) => (sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * q))]! : 0);
      return {
        key,
        calls: all.length,
        emitted: sizes.length,
        p50: at(0.5),
        p95: at(0.95),
        max: sizes.length ? sizes[sizes.length - 1]! : 0,
        sum: sizes.reduce((a, b) => a + b, 0),
      };
    })
    .sort((a, b) => b.sum - a.sum || a.key.localeCompare(b.key));
}

function push(groups: Map<string, number[]>, key: string, value: number): void {
  const list = groups.get(key);
  if (list) list.push(value);
  else groups.set(key, [value]);
}

/** One kernel delivery into its agent's row; identical repeats are keyed by
 *  session, agent, kernel ids and size. */
function countKernel(kernel: Map<string, KernelRow>, seen: Set<string>, e: Ev): void {
  const agent = agentOf(e);
  const row = kernel.get(agent) ?? {
    agent,
    full: 0,
    fullChars: 0,
    identical: 0,
    identicalChars: 0,
    reminders: 0,
    reminderChars: 0,
  };
  kernel.set(agent, row);
  if (typeof e.kernel_reminder_chars === "number") {
    row.reminders++;
    row.reminderChars += num(e.kernel_reminder_chars);
    return;
  }
  const chars = num(e.kernel_chars);
  row.full++;
  row.fullChars += chars;
  const ids = Array.isArray(e.kernel_ids) ? e.kernel_ids.map(str).join(",") : "";
  const key = `${str(e.session_id)}\u0000${agent}\u0000${ids}\u0000${chars}`;
  if (seen.has(key)) {
    row.identical++;
    row.identicalChars += chars;
  }
  seen.add(key);
}

const isKernelDelivery = (e: Ev): boolean =>
  str(e.kind) === "gate_hook_call" &&
  (typeof e.kernel_chars === "number" || typeof e.kernel_reminder_chars === "number");

export function summarizeHookContextLoad(events: readonly Ev[]): HookContextLoad {
  const lanes = new Map<string, number[]>();
  const drafts = new Map<string, number[]>();
  const plan = new Map<string, number[]>();
  const kernel = new Map<string, KernelRow>();
  const seenKernel = new Set<string>();
  const planRecalls = new Set<string>();
  const loadedFrom = new Set<string>();
  for (const e of events) {
    const kind = str(e.kind);
    if (kind === "hook_recall" && hookSourceOf(e) === "todo" && str(e.recall_id)) planRecalls.add(str(e.recall_id));
    else if (kind === "load_memory" && str(e.from_hook_recall)) loadedFrom.add(str(e.from_hook_recall));
    else if (kind === "draft_hint") push(drafts, str(e.hook_event) || "unknown", num(e.hint_tokens_est));
    else if (isKernelDelivery(e)) countKernel(kernel, seenKernel, e);
    else if ((LANE_KINDS as readonly string[]).includes(kind)) {
      push(lanes, `${kind} · ${agentOf(e)}`, num(e.hint_tokens_est));
      if (kind === "todo_hook_call") push(plan, clientOf(e), num(e.hint_tokens_est));
    }
  }
  return {
    events: events.length,
    lanes: sizeRows(lanes),
    drafts: sizeRows(drafts),
    kernel: [...kernel.values()].sort((a, b) => a.agent.localeCompare(b.agent)),
    plan: sizeRows(plan),
    planFollowThrough: {
      recalls: planRecalls.size,
      followed: [...planRecalls].filter((id) => loadedFrom.has(id)).length,
    },
  };
}

export function renderHookContextLoad(load: HookContextLoad, window: string): string {
  const out = [`hook context load — ${window}, ${load.events} event(s); sizes in tokens (chars/4)`];
  const table = (title: string, rows: SizeRow[]) => {
    out.push("", title, "  key                                   calls  emitted    p50    p95    max      sum");
    for (const r of rows)
      out.push(
        `  ${r.key.padEnd(36)} ${String(r.calls).padStart(6)} ${String(r.emitted).padStart(8)} ${String(r.p50).padStart(6)} ${String(r.p95).padStart(6)} ${String(r.max).padStart(6)} ${String(r.sum).padStart(8)}`
      );
    if (!rows.length) out.push("  (none)");
  };
  table("lanes (kind · agent)", load.lanes);
  table("draft hints (hook event)", load.drafts);
  table("plan lane (client)", load.plan);
  out.push(
    `  follow-through: ${load.planFollowThrough.followed} of ${load.planFollowThrough.recalls} plan recall(s) were followed by a load_memory`
  );
  out.push("", "rule kernel re-delivery by the gate lane (characters)");
  for (const k of load.kernel)
    out.push(
      `  ${k.agent.padEnd(10)} full ${k.full} (${k.fullChars} chars), identical repeats ${k.identical} (${k.identicalChars} chars), short reminders ${k.reminders} (${k.reminderChars} chars)`
    );
  if (!load.kernel.length) out.push("  (none)");
  return out.join("\n");
}

function logDir(): string {
  const override = process.env.BASTRA_LOG_PATH ?? process.env.NEXUS_LOG_PATH;
  if (override) return override;
  return join(homedir(), ".bastra", "logs");
}

export function readEvents(dir: string, sinceDay: string, untilDay: string): Ev[] {
  if (!existsSync(dir)) return [];
  const out: Ev[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()) {
    const day = file.slice(7, 17);
    if (day < sinceDay || day > untilDay) continue;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Ev);
      } catch {
        /* torn line */
      }
    }
  }
  return out;
}

function main(): void {
  const since = process.env.SINCE ?? new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);
  const until = process.env.UNTIL ?? new Date().toISOString().slice(0, 10);
  const dir = logDir();
  console.log(
    renderHookContextLoad(summarizeHookContextLoad(readEvents(dir, since, until)), `${dir}, ${since}..${until}`)
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
