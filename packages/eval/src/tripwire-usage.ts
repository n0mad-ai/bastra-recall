/**
 * Tripwire usage (bash-pre lane) — the instrument behind the 22.08.2026
 * measurement that dropped `> overwrite redirect` and rewrote the lane's
 * query. Re-run it to see whether the change held:
 *
 *   npm run tripwire-usage --workspace @bastra-recall/eval
 *   (optional: SINCE=2026-08-22 — ISO day, default: 30 days back;
 *    BASTRA_LOG_PATH as everywhere else)
 *
 * Reads bash_hook_call (volume, pattern, tokens, hinted ids), hook_recall
 * with tool_name "Bash" (the lane's own recall, carries the real session),
 * load_memory (follow-through: a hinted id loaded in the same session within
 * 15 minutes) and every other lane's hint_tokens_est (the tripwire's share of
 * the context tax, #354). Descriptive only — no causal claim.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Ev = Record<string, unknown>;

function logDir(): string {
  const override = process.env.BASTRA_LOG_PATH ?? process.env.NEXUS_LOG_PATH;
  if (override) return override;
  const next = join(homedir(), ".bastra", "logs");
  const legacy = join(homedir(), ".nexus-recall", "logs");
  if (existsSync(next)) return next;
  return existsSync(legacy) ? legacy : next;
}

function readEvents(dir: string, sinceDay: string): Ev[] {
  if (!existsSync(dir)) return [];
  const out: Ev[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.startsWith("events-") && f.endsWith(".jsonl"))
    .sort()) {
    if (file.slice(7, 17) < sinceDay) continue;
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

const since = process.env.SINCE ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const dir = logDir();
const events = readEvents(dir, since);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

const tripwire = events.filter((e) => e.kind === "bash_hook_call");
const bashRecalls = events.filter((e) => e.kind === "hook_recall" && e.tool_name === "Bash");
const loads = events.filter((e) => e.kind === "load_memory");

const byPattern = new Map<string, number>();
const hinted = new Map<string, number>();
let withHints = 0;
let tokens = 0;
let dropped = 0;
for (const e of tripwire) {
  const p = str(e.matched_pattern) || "?";
  byPattern.set(p, (byPattern.get(p) ?? 0) + 1);
  dropped += num(e.dropped_dedup_count);
  if (num(e.hint_count) > 0) {
    withHints += 1;
    tokens += num(e.hint_tokens_est);
    for (const id of (Array.isArray(e.hinted_ids) ? e.hinted_ids : []) as unknown[]) {
      hinted.set(str(id), (hinted.get(str(id)) ?? 0) + 1);
    }
  }
}

// Follow-through: a hinted id loaded in the same session within 15 minutes.
const recallsBySession = new Map<string, Ev[]>();
for (const r of bashRecalls) {
  const s = str(r.session_id);
  recallsBySession.set(s, [...(recallsBySession.get(s) ?? []), r]);
}
let followed = 0;
for (const l of loads) {
  const lts = Date.parse(str(l.ts));
  for (const r of recallsBySession.get(str(l.session_id)) ?? []) {
    const rts = Date.parse(str(r.ts));
    const ids = ((r.hits as Ev[] | undefined) ?? []).map((h) => str(h.id));
    if (ids.includes(str(l.id)) && lts >= rts && lts - rts <= 15 * 60 * 1000) {
      followed += 1;
      break;
    }
  }
}

// Share of all hook-injected tokens.
const share = new Map<string, number>();
for (const e of events) {
  const k = str(e.kind);
  if ((k === "hook_call" || k === "bash_hook_call" || k === "session_hook_call") && num(e.hint_count) > 0) {
    share.set(k, (share.get(k) ?? 0) + num(e.hint_tokens_est));
  }
}
const total = [...share.values()].reduce((a, b) => a + b, 0);

console.log(`tripwire-usage — log dir: ${dir}, since ${since}`);
console.log(`bash_hook_call: ${tripwire.length} (with hints ${withHints}, dedup-dropped lines ${dropped})`);
console.log(
  "  by pattern: " +
    [...byPattern.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([p, n]) => `${p}=${n}`)
      .join(", ")
);
console.log(`  tokens injected: ${tokens} (${withHints ? Math.round(tokens / withHints) : 0}/hint)`);
console.log(`  distinct memories hinted: ${hinted.size}`);
for (const [id, n] of [...hinted.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
  console.log(`    ${String(n).padStart(5)}  ${id}`);
}
console.log(
  `follow-through: ${followed} hinted ids loaded within 15 min (${withHints ? ((100 * followed) / withHints).toFixed(1) : "0.0"}% of hinting calls)`
);
console.log(
  "share of hook-injected tokens: " +
    [...share.entries()].map(([k, v]) => `${k} ${v} (${total ? Math.round((100 * v) / total) : 0}%)`).join(", ")
);
