/** Local, bounded draft storage (#1084, phase A); never reads or writes a vault. */
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { redactSecrets } from "@bastra-recall/core/scrub";
import { withPathLock } from "./path-lock.js";

export const DRAFT_STORE_VERSION = 1;
export const DRAFT_MAX_ROWS = 500;
export const DRAFT_MAX_BYTES = 1024 * 1024;
export const DRAFT_OPEN_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DRAFT_RETAIN_AGE_MS = 180 * 24 * 60 * 60 * 1000;

const timestamp = z.number().finite().nonnegative();
const draftSchema = z.object({
  id: z.string().regex(/^d-[a-f0-9]{12}$/),
  fp: z.string().regex(/^[a-f0-9]{40}$/),
  kind: z.enum(["restated", "correction", "answer", "after-failure"]),
  quote: z.string(), context: z.string().optional(),
  situation: z.object({
    cwd: z.string().optional(), project: z.string().optional(), branch: z.string().optional(),
    before: z.array(z.string()).default([]), after: z.array(z.string()).default([]),
    reads: z.array(z.string()).default([]), lits: z.array(z.string()).default([]),
  }).passthrough().default({ before: [], after: [], reads: [], lits: [] }),
  evidence: z.array(z.object({ session_id: z.string(), turn: z.number().int().nonnegative(), ts: timestamp, client: z.string().optional() }).passthrough()).min(1),
  created: timestamp, last_touched: timestamp,
  surfaced: z.array(z.object({ session_id: z.string(), ts: timestamp, novel: z.array(z.string()) }).passthrough()).default([]),
  state: z.enum(["open", "promoted", "rejected"]).default("open"),
  memory_id: z.string().optional(), evidence_key: z.string().optional(), announce: z.boolean().optional(),
}).passthrough();

export type Draft = z.infer<typeof draftSchema>;

export function draftsPath(): string {
  return resolve(process.env.BASTRA_DRAFTS_PATH ?? join(homedir(), ".bastra", "drafts.json"));
}

export function draftFingerprint(quote: string): string {
  const normalized = quote.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
  return createHash("sha256").update(normalized).digest("hex").slice(0, 40);
}

// SHA-256 keeps the planned label lengths without relying on SHA-1.
export function draftId(sessionId: string, turn: number, fp: string): string {
  return "d-" + createHash("sha256").update(`${sessionId}:${turn}:${fp}`).digest("hex").slice(0, 12);
}

function sanitize(input: unknown, now: number, fallback = now): Draft | null {
  const d = draftSchema.parse(input);
  const time = (ts: number) => ts > now ? Math.min(now, fallback) : ts;
  const quote = redactSecrets(d.quote, homedir());
  if (quote.redactedChars > d.quote.length * 0.3) return null;
  const clean = (text: string, max = 200) => redactSecrets(text, homedir()).text.slice(0, max);
  const optional = (text: string | undefined) => text === undefined ? undefined : clean(text);
  const strings = (items: string[], count: number, max = 200) => items.slice(-count).map((s) => clean(s, max));
  return {
    ...d, created: time(d.created), quote: quote.text.slice(0, 600), context: d.context === undefined ? undefined : clean(d.context, 160),
    situation: {
      ...d.situation,
      cwd: optional(d.situation.cwd), project: optional(d.situation.project), branch: optional(d.situation.branch),
      before: strings(d.situation.before, 3), after: strings(d.situation.after.slice(0, 3), 3),
      reads: strings(d.situation.reads, 3), lits: strings(d.situation.lits, 32, 160),
    },
    // Opaque identifiers (often UUIDs) must keep their identity across sessions.
    evidence: d.evidence.map((e) => ({ ...e, ts: time(e.ts), session_id: e.session_id.slice(0, 200), client: optional(e.client) })),
    surfaced: d.surfaced.slice(-5).map((s) => ({ ...s, ts: time(s.ts), session_id: s.session_id.slice(0, 200), novel: strings(s.novel, 32, 160) })),
    memory_id: d.memory_id?.slice(0, 200), evidence_key: d.evidence_key?.slice(0, 200),
    last_touched: Math.max(time(d.last_touched), time(d.created), ...d.evidence.map((e) => time(e.ts)), ...d.surfaced.map((s) => time(s.ts))),
  };
}


export interface DraftStoreDiagnostics {
  version: number | null;
  skippedRows: number;
  corrupt: boolean;
  unsupportedVersion: boolean;
}

interface StoreSnapshot {
  rows: Draft[];
  metadata: Record<string, unknown>;
  diagnostics: DraftStoreDiagnostics;
}

function documentOf(rows: Draft[], metadata: Record<string, unknown>): Record<string, unknown> {
  return { ...metadata, version: DRAFT_STORE_VERSION, rows };
}

function bounded(rows: Draft[], now: number, metadata: Record<string, unknown> = {}): Draft[] {
  const kept = rows.filter((d) => now - d.last_touched < (d.state === "open" ? DRAFT_OPEN_AGE_MS : DRAFT_RETAIN_AGE_MS));
  kept.sort((a, b) => a.last_touched - b.last_touched);
  if (kept.length > DRAFT_MAX_ROWS) kept.splice(0, kept.length - DRAFT_MAX_ROWS);
  let bytes = Buffer.byteLength(JSON.stringify(documentOf([], metadata))) + kept.reduce((sum, d) => sum + Buffer.byteLength(JSON.stringify(d)) + 1, 0);
  while (bytes > DRAFT_MAX_BYTES && kept.length) bytes -= Buffer.byteLength(JSON.stringify(kept.shift()!)) + 1;
  if (bytes > DRAFT_MAX_BYTES) throw new Error("draft metadata exceeds store byte limit");
  return kept;
}

// Atomic rename gives readers a complete snapshot without waiting for a writer.
let cache: { path: string; stamp: string; store: StoreSnapshot } | undefined;

/** Counts only, never quote contents. Describes the latest loaded snapshot. */
export function draftStoreDiagnostics(): DraftStoreDiagnostics {
  return { ...(cache?.store.diagnostics ?? { version: DRAFT_STORE_VERSION, skippedRows: 0, corrupt: false, unsupportedVersion: false }) };
}

async function fileInfo(path: string): Promise<{ stamp: string; mtime: number }> {
  try {
    const st = await stat(path);
    if (st.size > DRAFT_MAX_BYTES) throw new Error("draft store exceeds its byte limit");
    return { stamp: `${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`, mtime: st.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { stamp: "missing", mtime: 0 };
    throw err;
  }
}

async function load(path: string, now: number): Promise<StoreSnapshot> {
  const info = await fileInfo(path);
  if (cache?.path === path && cache.stamp === info.stamp) return structuredClone(cache.store);
  const store: StoreSnapshot = {
    rows: [], metadata: {},
    diagnostics: { version: DRAFT_STORE_VERSION, skippedRows: 0, corrupt: false, unsupportedVersion: false },
  };
  if (info.stamp !== "missing") {
    let parsed: unknown;
    try {
      const raw = await readFile(path, "utf8");
      parsed = raw.trim() === "" ? [] : JSON.parse(raw);
    }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return load(path, now);
      store.diagnostics.corrupt = true;
      store.diagnostics.version = null;
    }
    let rows: unknown[] = [];
    if (!store.diagnostics.corrupt) {
      if (Array.isArray(parsed)) {
        store.diagnostics.version = 0; // legacy, unversioned array
        rows = parsed;
      } else if (parsed && typeof parsed === "object") {
        const envelope = parsed as Record<string, unknown>;
        const version = envelope.version;
        if (typeof version === "number" && Number.isInteger(version) && version > DRAFT_STORE_VERSION) {
          // A future layout need not have today's rows field. Never interpret or rewrite it.
          store.diagnostics.version = version;
          store.diagnostics.unsupportedVersion = true;
        } else if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || !Array.isArray(envelope.rows)) {
          store.diagnostics.corrupt = true;
          store.diagnostics.version = null;
        } else {
          store.diagnostics.version = version;
          const { rows: _rows, ...metadata } = envelope;
          store.metadata = metadata;
          rows = envelope.rows;
        }
      } else {
        store.diagnostics.corrupt = true;
        store.diagnostics.version = null;
      }
      for (const row of rows) {
        const result = draftSchema.safeParse(row);
        const clean = result.success ? sanitize(result.data, now, info.mtime) : null;
        if (clean) store.rows.push(clean);
        else store.diagnostics.skippedRows++;
      }
    }
    if (store.diagnostics.skippedRows) process.stderr.write(`[bastra-recall] drafts: skipped ${store.diagnostics.skippedRows} invalid rows\n`);
    if (store.diagnostics.corrupt) process.stderr.write("[bastra-recall] drafts: malformed file; writes disabled\n");
    if (store.diagnostics.unsupportedVersion) process.stderr.write(`[bastra-recall] drafts: version ${store.diagnostics.version} is newer; writes disabled\n`);
  }
  cache = { path, stamp: info.stamp, store };
  return structuredClone(store);
}

function assertWritable(store: StoreSnapshot): void {
  if (store.diagnostics.corrupt) throw new Error("draft store is malformed; original file preserved");
  if (store.diagnostics.unsupportedVersion) throw new Error("draft store version is newer; original file preserved");
}

async function write(path: string, rows: Draft[], metadata: Record<string, unknown>): Promise<void> {
  const payload = JSON.stringify(documentOf(rows, metadata));
  if (Buffer.byteLength(payload) > DRAFT_MAX_BYTES) throw new Error("draft store exceeds its byte limit");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    const info = await fileInfo(path);
    cache = {
      path, stamp: info.stamp,
      store: { rows: structuredClone(rows), metadata, diagnostics: { version: DRAFT_STORE_VERSION, skippedRows: 0, corrupt: false, unsupportedVersion: false } },
    };
  } finally {
    await unlink(tmp).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
  }
}

/** Listing is not a display in a recall lane and does not refresh last_touched. */
export async function listDrafts(now = Date.now()): Promise<Draft[]> {
  const path = draftsPath();
  const store = await load(path, now);
  return bounded(store.rows, now, store.metadata);
}

/** Replace by id; cross-session matching and situation merging belong to phase B. */
export async function upsertDraft(input: Draft, now = Date.now()): Promise<Draft | null> {
  const draft = sanitize(input, now);
  if (!draft) return null;
  if (Buffer.byteLength(JSON.stringify(draft)) > DRAFT_MAX_BYTES - 2) throw new Error("draft exceeds store byte limit");
  const path = draftsPath();
  return withPathLock(path, async () => {
    const store = await load(path, now);
    assertWritable(store);
    const rows = store.rows.filter((row) => row.id !== draft.id);
    rows.push(draft);
    const kept = bounded(rows, now, store.metadata);
    await write(path, kept, store.metadata);
    return structuredClone(kept.find((row) => row.id === draft.id) ?? null);
  }, { crossProcess: true });
}

/** Phase B will call this from the harvest tick. A missing promoted note leaves a tombstone. */
export async function expireDrafts(opts: { now?: number; memoryExists?: (id: string) => Promise<boolean> } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const path = draftsPath();
  return withPathLock(path, async () => {
    const store = await load(path, now);
    assertWritable(store);
    const rows = store.rows;
    if (opts.memoryExists) {
      for (const row of rows) {
        if (row.state === "promoted" && row.memory_id && !await opts.memoryExists(row.memory_id)) {
          row.state = "rejected";
          row.announce = false;
          row.last_touched = now;
        }
      }
    }
    const kept = bounded(rows, now, store.metadata);
    if (rows.length || (await fileInfo(path)).stamp !== "missing") await write(path, kept, store.metadata);
    return rows.length - kept.length;
  }, { crossProcess: true });
}

export async function purgeDrafts(): Promise<void> {
  const path = draftsPath();
  await withPathLock(path, async () => {
    await unlink(path).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
    cache = undefined;
  }, { crossProcess: true });
}
