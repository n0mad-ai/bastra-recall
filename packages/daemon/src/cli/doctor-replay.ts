/**
 * `bastra doctor --replay` (#702): the user's own past prompts, sent through
 * the live prompt lane in shadow, and a report on what recall would have done
 * with them on THIS vault.
 *
 * Why a replay and not an offline estimate: a contributor counted the shadow
 * telemetry's `dropped_scopes` by hand, concluded the lane scope filter was
 * harmless, switched it on — and a replay of the same 438 turns showed it
 * dropping ten useful slots to remove four noisy ones. The offline count could
 * not see that the dropped notes had been loaded in other sessions. Only the
 * lane itself knows what it would inject, so the lane is what runs here.
 *
 * What runs where:
 *  - This file reads the Claude Code transcripts (`~/.claude/projects/⋆/⋆.jsonl`,
 *    `CLAUDE_CONFIG_DIR` moves them), keeps every user-role row that is not a
 *    tool result, and posts each one to the running daemon's `/hook/prompt`
 *    with `replay: true` under the session id `replay-<run>-<original>`.
 *  - The daemon runs `runPromptLane` exactly as for the hook — classification,
 *    recall, reflex, session dedup, backoff, scope filter — in its replay mode
 *    (prompt-lane.ts): nothing is written outside the replay's own session
 *    state and the replay telemetry file `replay-YYYY-MM-DD.jsonl`
 *    (telemetry-sink.ts). The vault is read, never written.
 *  - The route answers `{stdout, telemetry}`; the report is built from the
 *    telemetry rows, so its numbers are the same ones the log holds.
 *
 * System turns (task notifications, agent mail, `<system-reminder>` blocks)
 * are sent too, not dropped: the lane gates them as `origin: "system"`, and
 * the report shows their share — a third of one contributor's "prompts".
 *
 * Every run uses a fresh session-id suffix, so the lane's per-session state
 * (dedup, backoff) starts empty each time and two replays of the same
 * transcripts against the same settings give the same report.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
import { normalizeTurns } from "../stop-transcript.js";
import type { PromptHookTelemetry } from "../prompt-lane-telemetry.js";
import { probeDaemon } from "./helpers.js";
import type { ParsedArgs } from "./types.js";

export const REPLAY_DEFAULT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Sessions replayed side by side; turns inside one session stay in order. */
const SESSION_CONCURRENCY = 4;
/** Above the lane's own 1000 ms budget plus the draft band — a hung daemon,
 *  not a slow lane, is what this cuts off. */
const POST_TIMEOUT_MS = 10_000;
const TOP_NOTES = 10;
const LOAD_MEMORY_TOOL = /(?:^|__)load_memory$/;

// ─── transcripts ─────────────────────────────────────────────────────────────

export interface ReplayTurn {
  /** The original Claude Code session id (the transcript's file name). */
  session: string;
  cwd: string | null;
  at: number;
  /** The row's text as the hook would have received it — untouched, so the
   *  lane tags system turns itself. */
  text: string;
}

export interface ReplayCorpus {
  turns: ReplayTurn[];
  /** Ids the agent passed to `load_memory` inside the window, any session. */
  loadedIds: Set<string>;
  files: number;
  sessions: number;
}

export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

function rowText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

function loadedIdsOf(content: unknown, into: Set<string>): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; name?: unknown; input?: unknown };
    if (b.type !== "tool_use" || typeof b.name !== "string" || !LOAD_MEMORY_TOOL.test(b.name)) continue;
    const id = (b.input as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.trim()) into.add(id.trim());
  }
}

/**
 * Every user-role row of the window, in transcript order per session. Tool
 * results are not prompts (they share the user role in Claude Code's file and
 * `normalizeTurns` tells them apart); `isMeta` rows are the client's own
 * echoes (command expansions, local stdout) that never reach the prompt hook.
 * Subagent transcripts (`isSidechain`) are skipped: UserPromptSubmit does not
 * fire for a parent's instruction to its subagent.
 */
export async function readClaudeTranscripts(
  projectsDir: string,
  sinceMs: number,
  untilMs = Number.POSITIVE_INFINITY,
): Promise<ReplayCorpus> {
  const turns: ReplayTurn[] = [];
  const loadedIds = new Set<string>();
  const sessions = new Set<string>();
  let files = 0;
  let projects: string[];
  try {
    projects = (await readdir(projectsDir)).sort();
  } catch {
    return { turns, loadedIds, files, sessions: 0 };
  }
  for (const project of projects) {
    const dir = join(projectsDir, project);
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const st = await stat(path);
        if (!st.isFile() || st.mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        continue;
      }
      files += 1;
      const session = basename(name, ".jsonl");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let row: Record<string, unknown>;
        try {
          row = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!row || typeof row !== "object" || row.isSidechain === true) continue;
        const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
        if (!Number.isFinite(at) || at < sinceMs || at > untilMs) continue;
        const message = row.message as { role?: unknown; content?: unknown } | undefined;
        if (!message || typeof message !== "object") continue;
        if (message.role === "assistant") {
          loadedIdsOf(message.content, loadedIds);
          continue;
        }
        if (row.type !== "user" || message.role !== "user" || row.isMeta === true) continue;
        const [turn] = normalizeTurns([row]);
        if (!turn || turn.role === "tool") continue;
        const text = rowText(message.content);
        if (!text.trim()) continue;
        sessions.add(session);
        turns.push({ session, cwd: typeof row.cwd === "string" && row.cwd ? row.cwd : null, at, text });
      }
    }
  }
  turns.sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : a.at - b.at));
  return { turns, loadedIds, files, sessions: sessions.size };
}

// ─── the replay ──────────────────────────────────────────────────────────────

/** The fields of the lane's telemetry row the report reads. */
export type ReplayRow = Pick<
  PromptHookTelemetry,
  "session_id" | "origin" | "gated" | "status" | "detected_mode" | "hinted_ids" | "latency_ms_total" | "bridges_fired"
>;

export type ReplayPost = (turn: ReplayTurn, sessionId: string) => Promise<ReplayRow | null>;

export function replaySessionId(original: string, run: string): string {
  return `replay-${run}-${original}`;
}

/**
 * Every turn through `post`, sessions side by side, one session in order.
 * Rows come back in corpus order whatever the timing, so the report is a
 * function of the turns and the lane alone.
 */
export async function runReplay(
  corpus: ReplayCorpus,
  post: ReplayPost,
  opts: { run: string; concurrency?: number; onProgress?: (done: number, total: number) => void } ,
): Promise<ReplayRow[]> {
  const bySession = new Map<string, number[]>();
  corpus.turns.forEach((t, i) => bySession.set(t.session, [...(bySession.get(t.session) ?? []), i]));
  const queue = [...bySession.values()];
  const rows: (ReplayRow | null)[] = new Array(corpus.turns.length).fill(null);
  let done = 0;
  const worker = async (): Promise<void> => {
    for (let idx = queue.shift(); idx !== undefined; idx = queue.shift()) {
      for (const i of idx) {
        const turn = corpus.turns[i];
        rows[i] = await post(turn, replaySessionId(turn.session, opts.run));
        done += 1;
        opts.onProgress?.(done, corpus.turns.length);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? SESSION_CONCURRENCY) }, worker));
  return rows.filter((r): r is ReplayRow => r !== null);
}

/** POST one turn to the daemon's prompt route in replay mode. A turn the
 *  daemon could not answer (timeout, 5xx) yields no row and is counted as
 *  skipped by the caller. */
export function postReplayTurn(baseUrl: string): ReplayPost {
  return (turn, sessionId) => postReplay(baseUrl, turn, sessionId).then((r) => r?.telemetry ?? null);
}

/**
 * Does the running daemon know the replay mode? A daemon from before #702
 * ignores `replay: true` and runs the LIVE lane — statusline, usage sidecar,
 * live telemetry under a `replay-` session id — which is exactly what a
 * replay must never do. Probed with an empty prompt: both daemons leave the
 * lane before any side effect (`extractPrompt` returns null), and only the
 * new route wraps its answer in `{stdout, telemetry}`.
 */
export async function daemonSupportsReplay(baseUrl: string): Promise<boolean> {
  const r = await postReplay(baseUrl, { session: "probe", cwd: null, at: 0, text: "" }, "replay-probe");
  return r !== null && typeof r.stdout === "string";
}

function postReplay(
  baseUrl: string,
  turn: ReplayTurn,
  sessionId: string,
): Promise<{ stdout?: unknown; telemetry?: ReplayRow | null } | null> {
  return new Promise((resolve) => {
      let url: URL;
      try {
        url = new URL("/hook/prompt", baseUrl);
      } catch {
        resolve(null);
        return;
      }
      const body = Buffer.from(
        JSON.stringify({
          replay: true,
          payload: {
            session_id: sessionId,
            cwd: turn.cwd ?? undefined,
            hook_event_name: "UserPromptSubmit",
            prompt: turn.text,
          },
        }),
        "utf8",
      );
      const req = request(
        {
          method: "POST",
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname,
          headers: {
            // No task token: nothing is due in a replayed turn, and a daemon
            // from before #702 runs the live route for the probe — with a
            // token it would mark due tasks as delivered to "replay-probe".
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": body.byteLength.toString(),
          },
          timeout: POST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            if ((res.statusCode ?? 500) >= 400) {
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stdout?: unknown; telemetry?: ReplayRow | null });
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(null));
      req.write(body);
      req.end();
  });
}

// ─── the report ──────────────────────────────────────────────────────────────

export interface ReplayReport {
  evaluable: true;
  days: number;
  since: string;
  files: number;
  sessions: number;
  turns: number;
  /** Turns the daemon answered with a row. */
  replayed: number;
  system_turns: number;
  owner_prompts: number;
  gated_prompts: number;
  prompts_with_hint: number;
  slots: number;
  top_notes: Array<{ id: string; slots: number }>;
  top_notes_slots: number;
  loaded_ids: number;
  slots_on_loaded: number;
  bridges: Array<{ id: string; fires: number }>;
  latency: { n: number; p50_ms: number | null; p95_ms: number | null };
  statuses: Record<string, number>;
  modes: Record<string, number>;
}

export interface ReplayNotEvaluable {
  evaluable: false;
  days: number;
  since: string;
  reason: string;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function countBy(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Pure: the same rows give the same report. */
export function summarizeReplay(
  rows: ReplayRow[],
  corpus: Pick<ReplayCorpus, "loadedIds" | "files" | "sessions"> & { turns: number },
  meta: { days: number; sinceMs: number },
): ReplayReport {
  const system = rows.filter((r) => r.origin === "system");
  const owner = rows.filter((r) => r.origin !== "system");
  const gated = owner.filter((r) => r.gated === true);
  const slotsById = new Map<string, number>();
  let slots = 0;
  let slotsOnLoaded = 0;
  let withHint = 0;
  for (const r of owner) {
    const ids = r.hinted_ids ?? [];
    if (ids.length > 0) withHint += 1;
    for (const id of ids) {
      slots += 1;
      slotsById.set(id, (slotsById.get(id) ?? 0) + 1);
      if (corpus.loadedIds.has(id)) slotsOnLoaded += 1;
    }
  }
  const topNotes = [...slotsById.entries()]
    .map(([id, n]) => ({ id, slots: n }))
    .sort((a, b) => b.slots - a.slots || (a.id < b.id ? -1 : 1))
    .slice(0, TOP_NOTES);
  const fires = new Map<string, number>();
  for (const r of owner) for (const id of r.bridges_fired ?? []) fires.set(id, (fires.get(id) ?? 0) + 1);
  const bridges = [...fires.entries()]
    .map(([id, n]) => ({ id, fires: n }))
    .sort((a, b) => b.fires - a.fires || (a.id < b.id ? -1 : 1));
  const latencies = owner
    .filter((r) => r.gated !== true)
    .map((r) => r.latency_ms_total)
    .sort((a, b) => a - b);
  return {
    evaluable: true,
    days: meta.days,
    since: new Date(meta.sinceMs).toISOString().slice(0, 10),
    files: corpus.files,
    sessions: corpus.sessions,
    turns: corpus.turns,
    replayed: rows.length,
    system_turns: system.length,
    owner_prompts: owner.length,
    gated_prompts: gated.length,
    prompts_with_hint: withHint,
    slots,
    top_notes: topNotes,
    top_notes_slots: topNotes.reduce((n, t) => n + t.slots, 0),
    loaded_ids: corpus.loadedIds.size,
    slots_on_loaded: slotsOnLoaded,
    bridges,
    latency: { n: latencies.length, p50_ms: percentile(latencies, 50), p95_ms: percentile(latencies, 95) },
    statuses: countBy(owner.map((r) => r.status)),
    modes: countBy(owner.filter((r) => r.gated !== true).map((r) => r.detected_mode)),
  };
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`;
}

function counts(map: Record<string, number>): string {
  const entries = Object.entries(map);
  return entries.length === 0 ? "none" : entries.map(([k, v]) => `${k} ${v}`).join(", ");
}

export function formatReplayReport(r: ReplayReport): string {
  const lines: string[] = [];
  lines.push(
    `replay: ${r.turns} user turns from ${r.sessions} Claude Code sessions, last ${r.days} days (since ${r.since})`,
  );
  if (r.replayed < r.turns) lines.push(`  not answered by the daemon: ${r.turns - r.replayed} turns (left out below)`);
  lines.push(`  system turns        ${r.system_turns} (${pct(r.system_turns, r.replayed)}) — task notifications, agent mail, reminders; gated, no recall`);
  lines.push(`  owner prompts       ${r.owner_prompts}`);
  lines.push(`    trivial, gated    ${r.gated_prompts}`);
  lines.push(`    with a hint       ${r.prompts_with_hint} (${pct(r.prompts_with_hint, r.owner_prompts)} of owner prompts)`);
  lines.push(`  hint slots          ${r.slots}`);
  lines.push(`    ten most frequent notes   ${r.top_notes_slots} slots (${pct(r.top_notes_slots, r.slots)})`);
  for (const t of r.top_notes) lines.push(`      ${String(t.slots).padStart(4)}  ${t.id}`);
  lines.push(
    `    on notes the agent loaded in the window   ${r.slots_on_loaded} slots (${pct(r.slots_on_loaded, r.slots)}; ${r.loaded_ids} notes loaded)`,
  );
  const fires = r.bridges.reduce((n, b) => n + b.fires, 0);
  lines.push(`  bridges fired       ${r.bridges.length} bridges, ${fires} fires`);
  for (const b of r.bridges) lines.push(`      ${String(b.fires).padStart(4)}  ${b.id}`);
  const p50 = r.latency.p50_ms === null ? "–" : `${r.latency.p50_ms} ms`;
  const p95 = r.latency.p95_ms === null ? "–" : `${r.latency.p95_ms} ms`;
  lines.push(`  latency (recall ran, n=${r.latency.n})   p50 ${p50}   p95 ${p95}   timeouts ${r.statuses.timeout ?? 0}`);
  lines.push(`  statuses: ${counts(r.statuses)}`);
  lines.push(`  modes: ${counts(r.modes)}`);
  lines.push("  rows: replay-YYYY-MM-DD.jsonl in the daemon's log dir — never counted with live traffic");
  return lines.join("\n") + "\n";
}

/** `--compare <report.json>`: the saved report next to this one, with deltas. */
export function formatReplayDiff(before: ReplayReport, after: ReplayReport): string {
  const row = (label: string, a: number | null, b: number | null): string => {
    const fmt = (n: number | null): string => (n === null ? "–" : String(n));
    const delta = a === null || b === null ? "" : `  (${b - a >= 0 ? "+" : ""}${b - a})`;
    return `  ${label.padEnd(34)} ${fmt(a).padStart(8)} ${fmt(b).padStart(8)}${delta}`;
  };
  const lines = [
    `compare: saved report (${before.turns} turns, since ${before.since}) vs this run (${after.turns} turns, since ${after.since})`,
    ...(before.turns !== after.turns ? ["  the turn sets differ — read the deltas as a trend, not a measurement"] : []),
    `  ${"".padEnd(34)} ${"saved".padStart(8)} ${"now".padStart(8)}`,
    row("system turns", before.system_turns, after.system_turns),
    row("owner prompts with a hint", before.prompts_with_hint, after.prompts_with_hint),
    row("hint slots", before.slots, after.slots),
    row("slots on ten most frequent notes", before.top_notes_slots, after.top_notes_slots),
    row("slots on loaded notes", before.slots_on_loaded, after.slots_on_loaded),
    row("bridge fires", before.bridges.reduce((n, b) => n + b.fires, 0), after.bridges.reduce((n, b) => n + b.fires, 0)),
    row("timeouts", before.statuses.timeout ?? 0, after.statuses.timeout ?? 0),
    row("latency p50 ms", before.latency.p50_ms, after.latency.p50_ms),
    row("latency p95 ms", before.latency.p95_ms, after.latency.p95_ms),
  ];
  return lines.join("\n") + "\n";
}

// ─── the command ─────────────────────────────────────────────────────────────

export function parseDays(raw: string | null): number | { error: string } {
  if (raw === null) return REPLAY_DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 365) return { error: `--days needs a whole number of days between 1 and 365, got '${raw}'` };
  return n;
}

function runStamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function notEvaluable(days: number, sinceMs: number, reason: string): ReplayNotEvaluable {
  return { evaluable: false, days, since: new Date(sinceMs).toISOString().slice(0, 10), reason };
}

/**
 * Read, replay, report. Returns the report (or why there is none) and the
 * exit code; the caller prints. `out` carries the progress lines.
 */
export async function replayAndReport(opts: {
  days: number;
  now?: number;
  projectsDir?: string;
  progress?: (line: string) => void;
}): Promise<{ report: ReplayReport | ReplayNotEvaluable; code: number }> {
  const now = opts.now ?? Date.now();
  const sinceMs = now - opts.days * DAY_MS;
  const projectsDir = opts.projectsDir ?? claudeProjectsDir();
  const corpus = await readClaudeTranscripts(projectsDir, sinceMs, now);
  if (corpus.turns.length === 0) {
    return {
      report: notEvaluable(
        opts.days,
        sinceMs,
        `no Claude Code transcripts in the last ${opts.days} days under ${projectsDir} — use Claude Code for a week, then run \`bastra doctor --replay\``,
      ),
      code: 0,
    };
  }
  const endpoint = resolveDaemonEndpoint();
  const probe = await probeDaemon(endpoint);
  if (!probe.ok) {
    return {
      report: notEvaluable(opts.days, sinceMs, `daemon not reachable at ${endpoint.label} (${probe.detail}) — start it and run \`bastra doctor --replay\` again`),
      code: 1,
    };
  }
  if (!(await daemonSupportsReplay(endpoint.baseUrl))) {
    return {
      report: notEvaluable(
        opts.days,
        sinceMs,
        `the daemon at ${endpoint.label} (${probe.version ?? "unknown version"}) predates the replay mode — restart it on the current build (\`bastra update\`), then run \`bastra doctor --replay\` again`,
      ),
      code: 1,
    };
  }
  opts.progress?.(
    `replaying ${corpus.turns.length} user turns from ${corpus.sessions} sessions (${corpus.files} transcripts) through ${endpoint.label} in shadow — nothing is written to the vault`,
  );
  let lastTick = 0;
  const rows = await runReplay(corpus, postReplayTurn(endpoint.baseUrl), {
    run: runStamp(now),
    onProgress: (done, total) => {
      if (done === total || done - lastTick >= 100) {
        lastTick = done;
        opts.progress?.(`  ${done}/${total}`);
      }
    },
  });
  const report = summarizeReplay(rows, { ...corpus, turns: corpus.turns.length }, { days: opts.days, sinceMs });
  return { report, code: 0 };
}

export async function cmdDoctorReplay(args: ParsedArgs): Promise<number> {
  const days = parseDays(args.days);
  if (typeof days !== "number") {
    process.stderr.write(`error: ${days.error}\n`);
    return 2;
  }
  let saved: ReplayReport | null = null;
  if (args.compare !== null) {
    try {
      const parsed = JSON.parse(await readFile(args.compare, "utf8")) as ReplayReport | ReplayNotEvaluable;
      if (parsed.evaluable !== true) {
        process.stderr.write(`error: ${args.compare} holds no evaluable replay report\n`);
        return 2;
      }
      saved = parsed;
    } catch (err) {
      process.stderr.write(`error: cannot read ${args.compare}: ${(err as Error).message}\n`);
      return 2;
    }
  }
  const { report, code } = await replayAndReport({
    days,
    progress: args.json ? undefined : (line) => process.stderr.write(`${line}\n`),
  });
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return code;
  }
  if (!report.evaluable) {
    process.stdout.write(`replay: not evaluable — ${report.reason}\n`);
    return code;
  }
  process.stdout.write(formatReplayReport(report));
  if (saved) process.stdout.write("\n" + formatReplayDiff(saved, report));
  return code;
}

/**
 * The end of `bastra onboard` (#702 step 5): a user with transcripts gets the
 * replay on day one; a fresh install is told when to come back. Best-effort —
 * onboarding has already saved, and nothing here may change its outcome.
 */
export async function replayAfterOnboarding(out: { write: (s: string) => unknown }): Promise<void> {
  try {
    const { report } = await replayAndReport({ days: REPLAY_DEFAULT_DAYS, progress: (line) => out.write(`${line}\n`) });
    if (!report.evaluable) {
      out.write(`\nrecall replay: not evaluable — ${report.reason}\n`);
      return;
    }
    out.write("\nHow recall answers your own prompts on this vault (shadow replay, nothing written):\n");
    out.write(formatReplayReport(report));
  } catch (err) {
    out.write(`\nrecall replay skipped: ${(err as Error).message} — run \`bastra doctor --replay\` later\n`);
  }
}
