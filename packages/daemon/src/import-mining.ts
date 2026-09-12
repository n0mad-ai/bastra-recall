/**
 * Import P2 (#211) — mine the official conversations.json data export of
 * ChatGPT / Claude for lessons, decisions and preferences.
 *
 * The CLI does NOT extract facts itself (a local 4b model would produce
 * noise): `bastra import <conversations.json>` parses the export, keeps
 * only the USER's own messages (the dense source for preferences and
 * decisions — and far less sensitive than full transcripts), and writes a
 * local queue under ~/.bastra/. The AI session then combs it chunk-wise
 * via `bastra import mine`, distills candidate facts, and stages them
 * through the same `import-review.md` gate as #208 — never auto-saved.
 * The queue never leaves the machine and is deleted when mining completes.
 */
import { readFile, rename, unlink, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { withPathLock } from "./path-lock.js";

export const QUEUE_FILE = "import-queue.jsonl";
export const CURSOR_FILE = "import-queue.cursor";

const MIN_MESSAGE_CHARS = 20;
const MAX_MESSAGE_CHARS = 2000;
const MAX_MESSAGES_PER_CONVERSATION = 80;
const CHUNK_CHAR_BUDGET = 16_000;

export function defaultQueueDir(): string {
  return join(homedir(), ".bastra");
}

export interface ConversationRecord {
  source: "chatgpt" | "claude";
  title: string;
  date: string; // YYYY-MM-DD
  messages: string[];
}

export interface ParsedExport {
  source: "chatgpt" | "claude";
  conversations: ConversationRecord[];
}

/** Collapse whitespace so one message is one queue/chunk line. */
function squash(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length < MIN_MESSAGE_CHARS) return "";
  return s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS - 1)}…` : s;
}

function isoDate(epochOrIso: unknown): string {
  if (typeof epochOrIso === "number" && Number.isFinite(epochOrIso)) {
    return new Date(epochOrIso * 1000).toISOString().slice(0, 10);
  }
  if (typeof epochOrIso === "string" && /^\d{4}-\d{2}-\d{2}/.test(epochOrIso)) {
    return epochOrIso.slice(0, 10);
  }
  return "unknown";
}

interface ChatGptNode {
  message?: {
    author?: { role?: string };
    create_time?: number | null;
    content?: { content_type?: string; parts?: unknown[] };
  } | null;
}

/** One ChatGPT conversation object (`mapping` tree) → user messages. */
function fromChatGpt(conv: Record<string, unknown>): ConversationRecord | null {
  const mapping = conv.mapping;
  if (typeof mapping !== "object" || mapping === null) return null;
  const turns: Array<{ at: number; text: string }> = [];
  for (const node of Object.values(mapping as Record<string, ChatGptNode>)) {
    const msg = node?.message;
    if (!msg || msg.author?.role !== "user") continue;
    const parts = Array.isArray(msg.content?.parts) ? msg.content.parts : [];
    const text = squash(parts.filter((p): p is string => typeof p === "string").join("\n"));
    if (text) turns.push({ at: typeof msg.create_time === "number" ? msg.create_time : 0, text });
  }
  if (turns.length === 0) return null;
  turns.sort((a, b) => a.at - b.at);
  return {
    source: "chatgpt",
    title: typeof conv.title === "string" && conv.title ? conv.title : "untitled",
    date: isoDate(conv.create_time),
    messages: turns.slice(0, MAX_MESSAGES_PER_CONVERSATION).map((t) => t.text),
  };
}

interface ClaudeMessage {
  sender?: string;
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
}

/** One Claude conversation object (`chat_messages` list) → user messages. */
function fromClaude(conv: Record<string, unknown>): ConversationRecord | null {
  const raw = conv.chat_messages;
  if (!Array.isArray(raw)) return null;
  const messages: string[] = [];
  for (const m of raw as ClaudeMessage[]) {
    if (m?.sender !== "human") continue;
    const text =
      typeof m.text === "string" && m.text.trim()
        ? m.text
        : (m.content ?? [])
            .filter((c) => c?.type === "text" && typeof c.text === "string")
            .map((c) => c.text)
            .join("\n");
    const clean = squash(text);
    if (clean) messages.push(clean);
    if (messages.length >= MAX_MESSAGES_PER_CONVERSATION) break;
  }
  if (messages.length === 0) return null;
  return {
    source: "claude",
    title: typeof conv.name === "string" && conv.name ? conv.name : "untitled",
    date: isoDate(conv.created_at),
    messages,
  };
}

/**
 * conversations.json content → user-message records, newest conversation
 * first (so a user who stops after a few chunks mined the freshest — least
 * stale — history). Returns null when this is no known export shape.
 */
export function parseConversationExport(raw: string): ParsedExport | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  // Some wrappers nest the list: { "conversations": [...] }
  if (json !== null && typeof json === "object" && !Array.isArray(json)) {
    const inner = (json as Record<string, unknown>).conversations;
    if (Array.isArray(inner)) json = inner;
  }
  if (!Array.isArray(json) || json.length === 0) return null;

  const objs = json.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
  const isChatGpt = objs.some((c) => typeof c.mapping === "object" && c.mapping !== null);
  const isClaude = !isChatGpt && objs.some((c) => Array.isArray(c.chat_messages));
  if (!isChatGpt && !isClaude) return null;

  const conversations: ConversationRecord[] = [];
  for (const conv of objs) {
    const rec = isChatGpt ? fromChatGpt(conv) : fromClaude(conv);
    if (rec) conversations.push(rec);
  }
  if (conversations.length === 0) return null;
  conversations.sort((a, b) => b.date.localeCompare(a.date));
  return { source: isChatGpt ? "chatgpt" : "claude", conversations };
}

export interface QueueStatus {
  total: number;
  remaining: number;
}

async function readQueueRaw(dir: string): Promise<string> {
  try {
    return await readFile(join(dir, QUEUE_FILE), "utf8");
  } catch {
    return "";
  }
}

async function readQueueLines(dir: string): Promise<string[]> {
  return (await readQueueRaw(dir)).split("\n").filter((l) => l.trim().length > 0);
}

/** Atomic tmp+rename — a crash mid-write leaves the previous queue/cursor
 *  intact instead of a half-written one (#529, hardening as in floors.ts). */
async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

async function readCursor(dir: string): Promise<number> {
  try {
    const n = parseInt(await readFile(join(dir, CURSOR_FILE), "utf8"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Append conversations to the local mining queue (survives across runs —
 *  a ChatGPT and a Claude export can be queued back to back).
 *
 *  #529: serialised per queue directory and written tmp+rename. Unguarded,
 *  every concurrent caller took the initial-empty branch and `writeFile()` over
 *  the others — 80 parallel calls reported 80 queued conversations with 1 on
 *  disk. `queued` is the durable count now: those lines are part of the file
 *  that was renamed into place before the result is returned. */
export async function buildQueue(
  conversations: ConversationRecord[],
  dir: string = defaultQueueDir(),
): Promise<{ queued: number; messages: number; queueFile: string }> {
  const queueFile = join(dir, QUEUE_FILE);
  return withPathLock(dir, async () => {
    await mkdir(dir, { recursive: true });
    const existing = await readQueueRaw(dir);
    const lines = conversations.map((c) => JSON.stringify(c)).join("\n") + "\n";
    const head = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n` : existing;
    await writeAtomic(queueFile, head + lines);
    if (existing.trim().length === 0) await writeAtomic(join(dir, CURSOR_FILE), "0");
    return {
      queued: conversations.length,
      messages: conversations.reduce((n, c) => n + c.messages.length, 0),
      queueFile,
    };
  });
}

export async function queueStatus(dir: string = defaultQueueDir()): Promise<QueueStatus> {
  const lines = await readQueueLines(dir);
  if (lines.length === 0) return { total: 0, remaining: 0 };
  const cursor = await readCursor(dir);
  return { total: lines.length, remaining: Math.max(0, lines.length - cursor) };
}

/** Inner form — `readNextChunk` already holds the directory lock. */
async function clearQueueLocked(dir: string): Promise<void> {
  for (const f of [QUEUE_FILE, CURSOR_FILE]) {
    try {
      await unlink(join(dir, f));
    } catch {
      // already gone
    }
  }
}

export async function clearQueue(dir: string = defaultQueueDir()): Promise<void> {
  return withPathLock(dir, () => clearQueueLocked(dir));
}

export interface MiningChunk {
  /** Formatted conversations for the session to comb. */
  body: string;
  /** Conversations in this chunk. */
  conversations: number;
  /** Conversations left AFTER this chunk. */
  remaining: number;
  /** Dominant source of this chunk (for the staging hint). */
  source: string;
}

/**
 * Next chunk of the queue (~16k chars, at least one conversation, newest
 * first). Advances the cursor immediately — mining is best-effort, a chunk
 * lost to a crash is re-importable. Deletes the queue when drained.
 *
 * #529: the cursor transition runs under the same per-directory lock as
 * `buildQueue()`, so two overlapping readers never hand out one chunk twice
 * and no queue write lands between the read and the cursor bump.
 */
export async function readNextChunk(dir: string = defaultQueueDir()): Promise<MiningChunk | null> {
  return withPathLock(dir, async () => {
    const lines = await readQueueLines(dir);
    const cursor = await readCursor(dir);
    if (lines.length === 0 || cursor >= lines.length) {
      await clearQueueLocked(dir);
      return null;
    }

    const sections: string[] = [];
    const sources = new Map<string, number>();
    let used = 0;
    let taken = 0;
    for (let i = cursor; i < lines.length; i++) {
      let rec: ConversationRecord;
      try {
        rec = JSON.parse(lines[i]) as ConversationRecord;
      } catch {
        taken++; // corrupt line — skip, never stall the cursor
        continue;
      }
      const section = `### ${rec.date} · ${rec.title} (${rec.source})\n` + rec.messages.map((m) => `- ${m}`).join("\n");
      if (taken > 0 && used + section.length > CHUNK_CHAR_BUDGET) break;
      sections.push(section);
      sources.set(rec.source, (sources.get(rec.source) ?? 0) + 1);
      used += section.length;
      taken++;
    }

    const nextCursor = cursor + taken;
    const remaining = Math.max(0, lines.length - nextCursor);
    if (remaining === 0) {
      await clearQueueLocked(dir);
    } else {
      await writeAtomic(join(dir, CURSOR_FILE), String(nextCursor));
    }
    const source = [...sources.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "text";
    return { body: sections.join("\n\n"), conversations: sections.length, remaining, source };
  });
}
