/**
 * After-session harvest (#675).
 *
 * Capture only happened when the model decided to save in the middle of a
 * task: 15 % of Claude Code sessions ever saved, and in a hand-read sample 6
 * of ~41 durable facts made it into the vault. A contributor's offline
 * harvester — read the transcript after the session, extract what the user
 * said — produced most of the notes his agent later opened (53 of 98).
 *
 * This is the smallest in-daemon cut of that path:
 *
 *  1. The Stop lane books every session it sees (`noteSessionForHarvest`):
 *     session id, transcript path, time of the last Stop. One small locked
 *     write, no transcript work in the Stop budget.
 *     Where the client sends `SessionEnd`, the same lane books the session as
 *     finished (`ended: true`), so it does not wait for the idle window.
 *  2. A daemon job (`runSessionHarvest`, daemon-jobs.ts) picks the sessions
 *     that ended or have been quiet for {@link HARVEST_IDLE_MS}, reads their
 *     transcript and extracts candidates (`harvestCandidates`).
 *  3. Candidates the vault already holds in the same words are dropped
 *     (`harvest-vault-match.ts`); the rest go into the pending-suggestions
 *     relay (#513, recency lane) as verbatim quotes. The next session start
 *     shows them; the agent judges and saves. Nothing here writes to the
 *     vault.
 *
 * Extraction is structural and language-neutral (#676): no word lists, only
 * the shape of the conversation.
 *   - `restated`: a user turn that restates an earlier one (the #678 bigram
 *     similarity) — the user explaining the same thing again.
 *   - `correction`: the first user turn after the user interrupted the agent
 *     (Claude Code's own `[Request interrupted by user…]` marker).
 *   - `answer`: a substantive user turn right after an assistant turn that
 *     ended on a question mark — the user's answer to the agent's question.
 * A candidate is dropped when the agent called a save tool after it, since
 * that session already captured it.
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { withPathLock } from "./path-lock.js";
import { envFirst } from "./env.js";
import { defaultLogDir } from "./telemetry.js";
import { writePendingSuggestion } from "./pending-suggestions.js";
import { restatementIndices } from "./stop-lane-repeat.js";

/** Without a SessionEnd, a session counts as finished once no Stop arrived for this long. */
export const HARVEST_IDLE_MS = 30 * 60 * 1000;
/** Booked sessions older than this are dropped from the queue unharvested. */
const QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const QUEUE_MAX_ENTRIES = 200;
/** Per session: the relay entry must stay well inside the 3,000-char budget. */
export const HARVEST_MAX_CANDIDATES = 3;
const QUOTE_MAX_CHARS = 280;
const CONTEXT_MAX_CHARS = 160;
/** An answer shorter than this is a yes/no or an acknowledgement. */
const ANSWER_MIN_LETTERS = 20;
/** Longer user turns are pastes (logs, files), not something the user said. */
const PASTE_MIN_CHARS = 2000;
const QUESTION_END_RE = /[?？؟]\s*$/u;
const INTERRUPT_PREFIX = "[Request interrupted by user";
const SAVE_TOOL_RE = /(?:^|__)(?:save_memory|edit_memory|save_hold)$/;

export interface HarvestTurn {
  role: string;
  content: string;
  /** Tool names the turn called (Claude `tool_use.name`, Codex function name). */
  tools?: string[];
}

export type HarvestKind = "restated" | "correction" | "answer";

export interface HarvestCandidate {
  kind: HarvestKind;
  /** Index of the user turn in the transcript. */
  turn: number;
  quote: string;
  /** The agent's question (answers only). */
  context?: string;
}

interface QueueEntry {
  session_id: string;
  transcript_path: string;
  cwd?: string;
  client?: string;
  last_stop: number;
  /** Turns already harvested — a resumed session only yields what is new. */
  harvested_upto?: number;
  harvested_at?: number;
  /** A SessionEnd hook arrived: the session is finished, no idle wait. A later
   *  Stop (a resumed session) moves `last_stop` past it and the idle rule is
   *  back. */
  ended_at?: number;
}

export function harvestQueuePath(): string {
  return process.env.BASTRA_HARVEST_QUEUE_PATH ?? join(homedir(), ".bastra", "harvest-queue.json");
}

export function sessionHarvestEnabled(): boolean {
  return (process.env.BASTRA_SESSION_HARVEST ?? "").trim() !== "0";
}

function letters(s: string): number {
  return (s.match(/\p{L}/gu) ?? []).length;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function lastLine(s: string): string {
  const lines = s.trim().split(/\n+/);
  return lines[lines.length - 1] ?? "";
}

/**
 * Pure extraction over a normalized transcript. `from` skips turns an earlier
 * pass already harvested.
 */
export function harvestCandidates(turns: HarvestTurn[], from = 0, max = HARVEST_MAX_CANDIDATES): HarvestCandidate[] {
  const userIdx: number[] = [];
  for (let i = 0; i < turns.length; i++) if (turns[i].role === "user") userIdx.push(i);

  const typed = (i: number): boolean => {
    const c = turns[i].content.trim();
    return c.length > 0 && c.length < PASTE_MIN_CHARS && !c.startsWith(INTERRUPT_PREFIX);
  };
  const savedAfter = (i: number): boolean =>
    turns.slice(i + 1).some((t) => (t.tools ?? []).some((name) => SAVE_TOOL_RE.test(name)));

  const found = new Map<number, HarvestCandidate>();
  const add = (c: HarvestCandidate): void => {
    if (c.turn < from || found.has(c.turn) || savedAfter(c.turn)) return;
    found.set(c.turn, c);
  };

  // restated — compared over typed user turns only.
  const typedUser = userIdx.filter(typed);
  for (const k of restatementIndices(typedUser.map((i) => turns[i].content))) {
    const i = typedUser[k];
    add({ kind: "restated", turn: i, quote: clip(turns[i].content, QUOTE_MAX_CHARS) });
  }

  for (let n = 0; n < userIdx.length; n++) {
    const i = userIdx[n];
    // correction — the first typed user turn after an interrupt marker.
    if (turns[i].content.trim().startsWith(INTERRUPT_PREFIX)) {
      const next = userIdx.slice(n + 1).find(typed);
      if (next !== undefined && letters(turns[next].content) >= ANSWER_MIN_LETTERS) {
        add({ kind: "correction", turn: next, quote: clip(turns[next].content, QUOTE_MAX_CHARS) });
      }
      continue;
    }
    // answer — the previous turn is the assistant's, ending on a question.
    const prev = turns[i - 1];
    if (!prev || prev.role !== "assistant" || !typed(i)) continue;
    const q = lastLine(prev.content);
    if (!QUESTION_END_RE.test(q)) continue;
    if (letters(turns[i].content) < ANSWER_MIN_LETTERS) continue;
    add({
      kind: "answer",
      turn: i,
      quote: clip(turns[i].content, QUOTE_MAX_CHARS),
      context: clip(q, CONTEXT_MAX_CHARS),
    });
  }

  const rank: Record<HarvestKind, number> = { restated: 0, correction: 1, answer: 2 };
  return [...found.values()]
    .sort((a, b) => rank[a.kind] - rank[b.kind] || b.turn - a.turn)
    .slice(0, max);
}

/** The relay entry for one finished session. */
export function formatHarvestBlock(
  entry: { session_id: string; cwd?: string },
  candidates: HarvestCandidate[],
): string {
  const where = entry.cwd ? ` project="${basename(entry.cwd)}"` : "";
  const lines = [
    `<session-harvest session="${entry.session_id.slice(0, 8)}"${where}>`,
    `From a finished session — the user said this verbatim and the session did not save it. ` +
      `Recall first; save or append only what is durable (a rule, a correction, a decision, a fact ` +
      `that holds beyond that session), keep the user's words, and do not invent beyond the quote:`,
  ];
  for (const c of candidates) {
    const ctx = c.context ? ` (answering: "${c.context}")` : "";
    lines.push(`- [${c.kind}]${ctx} "${c.quote.replace(/"/g, "'")}"`);
  }
  lines.push(`</session-harvest>`);
  return lines.join("\n");
}

async function readQueue(path: string): Promise<QueueEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as QueueEntry[]).filter(
      (e) => typeof e?.session_id === "string" && typeof e?.transcript_path === "string" && typeof e?.last_stop === "number",
    );
  } catch {
    return [];
  }
}

async function writeQueue(path: string, entries: QueueEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(entries), "utf8");
  await rename(tmp, path);
}

/**
 * Stop lane: book the session for a later harvest. Only a transcript on disk
 * can be harvested after the fact, so an inline transcript is not booked.
 * `ended` comes from a SessionEnd hook: the session is finished now.
 * Best-effort, never throws.
 */
export async function noteSessionForHarvest(p: {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  client?: string;
  ended?: boolean;
  now?: number;
}): Promise<void> {
  if (!sessionHarvestEnabled()) return;
  if (typeof p.session_id !== "string" || p.session_id === "") return;
  if (typeof p.transcript_path !== "string" || !/\.jsonl?$/.test(p.transcript_path)) return;
  const now = p.now ?? Date.now();
  const path = harvestQueuePath();
  try {
    await withPathLock(path, async () => {
      const entries = await readQueue(path);
      const hit = entries.find((e) => e.session_id === p.session_id);
      let row = hit;
      if (row) {
        row.last_stop = now;
        row.transcript_path = p.transcript_path as string;
      } else {
        row = { session_id: p.session_id as string, transcript_path: p.transcript_path as string, last_stop: now };
        if (typeof p.cwd === "string" && p.cwd) row.cwd = p.cwd;
        if (p.client) row.client = p.client;
        entries.push(row);
      }
      if (p.ended) row.ended_at = now;
      await writeQueue(path, entries.slice(-QUEUE_MAX_ENTRIES));
    });
  } catch {
    /* booking is best-effort — never break the Stop lane */
  }
}

export interface HarvestPassResult {
  harvested: number;
  candidates: number;
  /** Candidates dropped because the vault already holds them (#675). */
  stored: number;
}

/** Ended by a SessionEnd after its last Stop, or quiet for the idle window. */
function isFinished(e: QueueEntry, now: number): boolean {
  if (e.ended_at !== undefined && e.ended_at >= e.last_stop) return true;
  return now - e.last_stop >= HARVEST_IDLE_MS;
}

/**
 * The daemon job: harvest every booked session that has been quiet for
 * {@link HARVEST_IDLE_MS}. `loadTurns` reads and normalizes a transcript
 * (stop-transcript.ts owns the parser). Never throws.
 */
export async function runSessionHarvest(opts: {
  loadTurns: (transcriptPath: string) => Promise<HarvestTurn[]>;
  /** The id of a memory that already holds this quote, or null (#675).
   *  Absent = no vault check. */
  storedIn?: () => (quote: string) => string | null;
  now?: number;
}): Promise<HarvestPassResult> {
  const result: HarvestPassResult = { harvested: 0, candidates: 0, stored: 0 };
  if (!sessionHarvestEnabled()) return result;
  const now = opts.now ?? Date.now();
  const path = harvestQueuePath();
  try {
    // Pick the due sessions under the lock, harvest outside it (a transcript
    // read can take a while and the Stop lane must not wait on it), then write
    // the progress back under the lock again.
    const due = await withPathLock(path, async () => {
      const entries = await readQueue(path);
      return entries.filter(
        (e) => isFinished(e, now) && (e.harvested_at === undefined || e.harvested_at < e.last_stop),
      );
    });
    const progress = new Map<string, { upto: number; at: number }>();
    let storedIn: ((quote: string) => string | null) | null = null;
    for (const e of due) {
      const ended = e.ended_at !== undefined && e.ended_at >= e.last_stop;
      try {
        const st = await stat(e.transcript_path);
        if (!ended && now - st.mtimeMs < HARVEST_IDLE_MS) continue; // still being written
      } catch {
        progress.set(e.session_id, { upto: e.harvested_upto ?? 0, at: now }); // gone — never retry
        continue;
      }
      const turns = await opts.loadTurns(e.transcript_path);
      // Every candidate is checked against the vault before the cap, so a
      // stored one does not take the place of a new one.
      let candidates = harvestCandidates(turns, e.harvested_upto ?? 0, Infinity);
      let stored = 0;
      if (candidates.length > 0 && opts.storedIn) {
        storedIn ??= opts.storedIn();
        const matcher = storedIn;
        const fresh = candidates.filter((c) => matcher(c.quote) === null);
        stored = candidates.length - fresh.length;
        candidates = fresh;
      }
      candidates = candidates.slice(0, HARVEST_MAX_CANDIDATES);
      if (candidates.length > 0) await writePendingSuggestion(formatHarvestBlock(e, candidates));
      progress.set(e.session_id, { upto: turns.length, at: now });
      result.harvested += 1;
      result.candidates += candidates.length;
      result.stored += stored;
      await writeHarvestTelemetry(e, turns.length, candidates, stored, ended);
    }
    await withPathLock(path, async () => {
      const entries = await readQueue(path);
      for (const e of entries) {
        const p = progress.get(e.session_id);
        if (p) {
          e.harvested_upto = p.upto;
          e.harvested_at = p.at;
        }
      }
      await writeQueue(
        path,
        entries.filter((e) => now - e.last_stop <= QUEUE_MAX_AGE_MS),
      );
    });
  } catch {
    /* a background pass must never take the daemon down */
  }
  return result;
}

async function writeHarvestTelemetry(
  e: QueueEntry,
  turnCount: number,
  candidates: HarvestCandidate[],
  stored: number,
  ended: boolean,
): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const kinds: Record<HarvestKind, number> = { restated: 0, correction: 0, answer: 0 };
    for (const c of candidates) kinds[c.kind] += 1;
    const event = {
      kind: "session_harvest",
      ts,
      session_id: e.session_id,
      client: e.client ?? null,
      turn_count: turnCount,
      candidate_count: candidates.length,
      candidate_kinds: kinds,
      stored_count: stored,
      trigger: ended ? "session_end" : "idle",
    };
    await appendFile(join(logDir, `events-${ts.slice(0, 10)}.jsonl`), JSON.stringify(event) + "\n", "utf8");
  } catch {
    /* telemetry must never break the job */
  }
}
