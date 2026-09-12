/**
 * Import review (#208) — seed the vault from other AI tools' memories,
 * staged for distillation instead of auto-saved.
 *
 * `bastra import` parses a user-provided export (ChatGPT memory list, Claude
 * memory text, Gemini "Saved Info", free text) and stages each fact as a
 * checkbox line in `import-review.md` at the vault root — the vault-care
 * pattern. NOTHING is auto-saved: foreign memories are exactly what the
 * admission rules (#159) warn about (stale facts, negative capability
 * claims, imperative self-directives). The next AI session sees the open
 * candidates via the session hook and distills accepted ones into real
 * memories WITH the user.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJsonPlain } from "./webui.js";
import { getUiEnabled } from "./settings.js";
import { queueStatus } from "./import-mining.js";
import { withPathLock } from "./path-lock.js";

export const IMPORT_FILE = "import-review.md";
export const IMPORT_SOURCES = ["chatgpt", "claude", "gemini", "text", "rules"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

const IMPORT_HEADER = `# Import Review

Candidates staged by \`bastra import\` from other AI tools' memories. In an
AI session, say "let's distill the import list" — the session goes through
the open entries WITH you, turns accepted ones into real memories (type,
triggers, dedupe), and ticks them \`[x]\`. Nothing is saved without your
accept.

`;

const IMPORT_LINE_RE = /^- \[([ x])\] (\d{4}-\d{2}-\d{2}) · (\w+) · (.+)$/;

const MIN_CANDIDATE_CHARS = 12;
const MAX_CANDIDATE_CHARS = 300;
const MAX_CANDIDATES_PER_RUN = 500;

export interface ImportEntry {
  done: boolean;
  date: string;
  source: string;
  text: string;
}

export function parseImportFile(content: string): ImportEntry[] {
  const out: ImportEntry[] = [];
  for (const line of content.split("\n")) {
    const m = IMPORT_LINE_RE.exec(line.trimEnd());
    if (m) out.push({ done: m[1] === "x", date: m[2], source: m[3], text: m[4] });
  }
  return out;
}

/** #313: bastra's own staging format is never a source. Detected by content,
 *  not filename — a copy of import-review.md under any name still carries the
 *  `- [ ] <date> · <source> ·` prefix, and re-staging it nests checkbox lines
 *  inside themselves. */
export class SelfImportError extends Error {
  constructor() {
    super(
      "this carries bastra's own staging format (import-review.md or a copy of it) — " +
        "it is never an import source. To work the open candidates off, open an AI " +
        'session and say "let\'s distill the import list".',
    );
  }
}

/** Conversation exports never stage raw — the CLI queues them for chunk-wise
 *  mining (#211, `bastra import mine`); the map dialog points there. */
export class ConversationExportError extends Error {
  constructor() {
    super(
      "this looks like a conversation export (chat history) — run " +
        "`bastra import <path/to/conversations.json>` in a terminal to queue it for " +
        "chunk-wise mining. To paste a memory LIST instead: ChatGPT → Settings → " +
        "Personalization → Manage memories; Claude → Settings → memory text.",
    );
  }
}

/** One line of an exported memory list → one clean candidate string. */
function cleanLine(line: string): string {
  return line
    .replace(/^- \[[ x]\]\s+/, "") // checkboxes — before the bullet strip eats the dash
    .replace(/^[-*•]\s+/, "") // bullets
    .replace(/^\d+[.)]\s+/, "") // numbering
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Raw export content → candidate facts. Accepts a plain-text memory list
 * (one fact per line, bullets/numbering tolerated) or a JSON array of
 * strings; rejects conversation exports (P2).
 */
export function extractCandidates(raw: string): string[] {
  const trimmed = raw.replace(/^﻿/, "").trim();
  let lines: string[];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      json = null; // JSON-looking but broken → treat as plain text below
    }
    if (Array.isArray(json) && json.every((x) => typeof x === "string")) {
      lines = json as string[];
    } else if (json !== null) {
      // conversations.json shapes: array of conversation objects, or an
      // object keyed by conversation with a "mapping" tree
      throw new ConversationExportError();
    } else {
      lines = trimmed.split("\n");
    }
  } else {
    lines = trimmed.split("\n");
  }

  // #313: refuse before cleaning — cleanLine would strip the very checkbox
  // prefix that identifies the input as our own staging file.
  if (lines.some((l) => IMPORT_LINE_RE.test(l.trimEnd()))) {
    throw new SelfImportError();
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const clean = cleanLine(line);
    if (clean.length < MIN_CANDIDATE_CHARS) continue; // headers, noise, blanks
    if (clean.startsWith("#")) continue; // markdown headings
    const capped = clean.length > MAX_CANDIDATE_CHARS ? `${clean.slice(0, MAX_CANDIDATE_CHARS - 1)}…` : clean;
    const key = capped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(capped);
    if (out.length >= MAX_CANDIDATES_PER_RUN) break;
  }
  return out;
}

/** Source label from an explicit override or the filename. */
export function detectSource(fileName: string | null, override: string | null): ImportSource {
  if (override && (IMPORT_SOURCES as readonly string[]).includes(override)) {
    return override as ImportSource;
  }
  const name = (fileName ?? "").toLowerCase();
  if (/chatgpt|openai/.test(name)) return "chatgpt";
  if (/claude|anthropic/.test(name)) return "claude";
  if (/gemini|takeout/.test(name)) return "gemini";
  return "text";
}

export interface StageResult {
  staged: number;
  skippedDuplicates: number;
  openTotal: number;
  filePath: string;
}

/** Append candidates to `import-review.md`, deduped against every entry
 *  already in the file (ticked or not — a rejected fact must not resurface).
 *
 *  #529: serialised per file and written tmp+rename. The read-modify-write ran
 *  unguarded, so concurrent CLI/UI imports all read the same content and the
 *  last write replaced the others — 80 parallel calls reported 80 staged
 *  candidates with 1 on disk. The counts are the durable ones now: they are
 *  taken inside the lock from the content that was just renamed into place. */
export async function stageImport(
  vaultPath: string,
  source: ImportSource,
  candidates: string[],
): Promise<StageResult> {
  const filePath = join(vaultPath, IMPORT_FILE);
  return withPathLock(filePath, async () => {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      content = IMPORT_HEADER;
    }
    const existing = new Set(parseImportFile(content).map((e) => e.text.toLowerCase()));
    const today = new Date().toISOString().slice(0, 10);
    let staged = 0;
    let skipped = 0;
    const lines: string[] = [];
    for (const c of candidates) {
      if (existing.has(c.toLowerCase())) {
        skipped++;
        continue;
      }
      existing.add(c.toLowerCase());
      lines.push(`- [ ] ${today} · ${source} · ${c}`);
      staged++;
    }
    if (staged > 0) {
      if (!content.endsWith("\n")) content += "\n";
      content += lines.join("\n") + "\n";
      // Atomic: a crash mid-write leaves the previous review file intact
      // instead of a truncated one (same hardening as floors.ts).
      const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
      await writeFile(tmp, content, "utf8");
      await rename(tmp, filePath);
    }
    const openTotal = parseImportFile(content).filter((e) => !e.done).length;
    return { staged, skippedDuplicates: skipped, openTotal, filePath };
  });
}

export async function countOpenImports(vaultPath: string): Promise<number> {
  try {
    const content = await readFile(join(vaultPath, IMPORT_FILE), "utf8");
    return parseImportFile(content).filter((e) => !e.done).length;
  } catch {
    return 0;
  }
}

/** GET /hook/import — open candidate count + mining-queue depth (#211) for
 *  the session hook. Loopback-only like /hook/care; deliberately NOT gated
 *  on ui.enabled (the file may exist from CLI use alone). */
export async function handleHookImport(res: ServerResponse, vaultPath: string): Promise<void> {
  const [open, queue] = await Promise.all([countOpenImports(vaultPath), queueStatus()]);
  sendJsonPlain(res, 200, { open, file: IMPORT_FILE, queued: queue.remaining });
}

/** POST /ui/import — the visual sibling of `bastra import` (#208): the map's
 *  import dialog sends { text, source? }; candidates are staged exactly like
 *  the CLI path. Loopback-only, gated on ui.enabled like the other /ui
 *  routes. Never saves memories — staging only. */
export async function handleUiImport(
  req: IncomingMessage,
  res: ServerResponse,
  vaultPath: string,
  settingsPath?: string,
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024 * 1024) {
      sendJsonPlain(res, 413, { error: "body too large (1 MB max)" });
      return;
    }
  }
  let text = "";
  let source: ImportSource = "text";
  try {
    const body = JSON.parse(raw) as { text?: unknown; source?: unknown };
    text = typeof body.text === "string" ? body.text : "";
    if (typeof body.source === "string" && (IMPORT_SOURCES as readonly string[]).includes(body.source)) {
      source = body.source as ImportSource;
    }
  } catch {
    sendJsonPlain(res, 400, { error: "invalid JSON body" });
    return;
  }
  if (!text.trim()) {
    sendJsonPlain(res, 400, { error: "text required" });
    return;
  }
  let candidates: string[];
  try {
    candidates = extractCandidates(text);
  } catch (err) {
    if (err instanceof ConversationExportError || err instanceof SelfImportError) {
      sendJsonPlain(res, 422, { error: err.message });
      return;
    }
    throw err;
  }
  if (candidates.length === 0) {
    sendJsonPlain(res, 422, { error: "no candidates found — paste a memory list, one fact per line" });
    return;
  }
  const result = await stageImport(vaultPath, source, candidates);
  sendJsonPlain(res, 200, {
    staged: result.staged,
    skipped_duplicates: result.skippedDuplicates,
    open_total: result.openTotal,
  });
}
