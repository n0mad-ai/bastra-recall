/** Local, bounded draft storage (#1084, phase A); never reads or writes a vault. */
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { redactSecrets } from "@bastra-recall/core/scrub";
import { cleanDraftText, clipDraftText } from "./draft-text.js";
import { mergeSituations, situationLiterals } from "./draft-situation.js";
import { bigramSet, dice } from "./stop-lane-repeat.js";
import { withPathLock } from "./path-lock.js";

export const DRAFT_STORE_VERSION = 1;
export const DRAFT_MAX_ROWS = 500;
export const DRAFT_MAX_BYTES = 1024 * 1024;
export const DRAFT_OPEN_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Unmeasured: early expiry for an unshown draft with only one evidence row. */
export const DRAFT_UNCONFIRMED_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Structural within-session similarity threshold from the harvest design. */
export const DRAFT_SESSION_DICE_MIN = 0.6;
export const DRAFT_RETAIN_AGE_MS = 180 * 24 * 60 * 60 * 1000;

const timestamp = z.number().finite().nonnegative();
const draftSchema = z.object({
  id: z.string().regex(/^d-[a-f0-9]{12}$/),
  fp: z.string().regex(/^[a-f0-9]{40}$/),
  kind: z.enum(["restated", "correction", "answer", "after-failure", "typed"]),
  quote: z.string(), context: z.string().optional(),
  situation: z.object({
    cwd: z.string().optional(), project: z.string().optional(), branch: z.string().optional(),
    before: z.array(z.string()).default([]), after: z.array(z.string()).default([]),
    reads: z.array(z.string()).default([]), lits: z.array(z.string()).default([]),
  }).passthrough().default({ before: [], after: [], reads: [], lits: [] }),
  evidence: z.array(z.object({ session_id: z.string(), turn: z.number().int().nonnegative(), ts: timestamp, client: z.string().optional() }).passthrough()).min(1),
  created: timestamp, last_touched: timestamp,
  surfaced: z.array(z.object({ session_id: z.string(), ts: timestamp, novel: z.array(z.string()), used: z.object({ ts: timestamp, tool: z.string(), exit_code: z.literal(0), matched: z.array(z.string()) }).optional() }).passthrough()).default([]),
  state: z.enum(["open", "promoted", "rejected"]).default("open"),
  vault_id: z.string().optional(),
  memory_id: z.string().optional(), evidence_key: z.string().optional(), announce: z.boolean().optional(),
}).passthrough();

export type Draft = z.infer<typeof draftSchema>;

export function draftsPath(): string {
  return resolve(process.env.BASTRA_DRAFTS_PATH ?? join(homedir(), ".bastra", "drafts.json"));
}

/** Derived local cache shares the chosen draft store's lifetime and location. */
export function draftVectorsPath(): string {
  const path = draftsPath();
  return path.endsWith(".json") ? path.slice(0, -5) + ".vectors.json" : path + ".vectors.json";
}

export function draftFingerprint(quote: string): string {
  const normalized = redactSecrets(quote, homedir()).text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
  return createHash("sha256").update(normalized).digest("hex").slice(0, 40);
}

// SHA-256 keeps the planned label lengths without relying on SHA-1.
export function draftId(sessionId: string, turn: number, fp: string): string {
  return "d-" + createHash("sha256").update(`${sessionId}:${turn}:${fp}`).digest("hex").slice(0, 12);
}


function sanitize(input: unknown, now: number, fallback = now): Draft | null {
  const d = draftSchema.parse(input);
  const time = (ts: number) => ts > now ? Math.min(now, fallback) : ts;
  const quoteInput = clipDraftText(d.quote, 600);
  const quote = redactSecrets(quoteInput, homedir());
  if (quote.redactedChars > quoteInput.length * 0.3) return null;
  const clean = cleanDraftText;
  const optional = (text: string | undefined) => text === undefined ? undefined : clean(text);
  const strings = (items: string[], count: number, max = 200) => items.slice(-count).map((s) => clean(s, max));
  return {
    ...d, created: time(d.created), quote: clipDraftText(quote.text, 600), context: d.context === undefined ? undefined : clean(d.context, 160),
    situation: {
      ...d.situation,
      cwd: optional(d.situation.cwd), project: optional(d.situation.project), branch: optional(d.situation.branch),
      before: strings(d.situation.before, 3), after: strings(d.situation.after.slice(0, 3), 3),
      reads: strings(d.situation.reads, 3), lits: strings(d.situation.lits, 32, 160),
    },
    // Opaque identifiers (often UUIDs) must keep their identity across sessions.
    evidence: d.evidence.map((e) => ({ ...e, ts: time(e.ts), session_id: e.session_id.slice(0, 200), client: optional(e.client) })),
    surfaced: d.surfaced.slice(-5).map((s) => ({ ...s, ts: time(s.ts), session_id: s.session_id.slice(0, 200), novel: strings(s.novel, 32, 160),
      ...(s.used ? { used: { ...s.used, ts: time(s.used.ts), tool: clean(s.used.tool, 80), matched: strings(s.used.matched, 3, 160) } } : {}),
    })),
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
  const kept = rows.filter((d) => {
    const age = d.state !== "open" ? DRAFT_RETAIN_AGE_MS
      : d.evidence.length === 1 && d.surfaced.length === 0 ? DRAFT_UNCONFIRMED_AGE_MS : DRAFT_OPEN_AGE_MS;
    return now - d.last_touched < age;
  });
  // Preserve tombstones and confirmed drafts before disposable first captures.
  const priority = (d: Draft): number => d.state !== "open" ? 2
    : d.evidence.length === 1 && d.surfaced.length === 0 ? 0 : 1;
  kept.sort((a, b) => priority(a) - priority(b) || a.last_touched - b.last_touched);
  if (kept.length > DRAFT_MAX_ROWS) kept.splice(0, kept.length - DRAFT_MAX_ROWS);
  let bytes = Buffer.byteLength(JSON.stringify(documentOf([], metadata))) + kept.reduce((sum, d) => sum + Buffer.byteLength(JSON.stringify(d)) + 1, 0);
  while (bytes > DRAFT_MAX_BYTES && kept.length) bytes -= Buffer.byteLength(JSON.stringify(kept.shift()!)) + 1;
  if (bytes > DRAFT_MAX_BYTES) throw new Error("draft metadata exceeds store byte limit");
  return kept.sort((a, b) => a.last_touched - b.last_touched);
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

/** Internal read-only retrieval view. Unlike CLI listing it does not copy every
 * quote on each hook. Atomic writes and the file stamp invalidate the view;
 * bounds are reapplied so expiry works even without a harvest tick. */
export async function draftSearchSnapshot(now = Date.now()): Promise<{ key: string; rows: readonly Draft[] }> {
  const path = draftsPath();
  const info = await fileInfo(path);
  if (cache?.path !== path || cache.stamp !== info.stamp) await load(path, now);
  const store = cache?.path === path ? cache.store : undefined;
  if (!store) return { key: `${path}:missing`, rows: [] };
  const rows = bounded(store.rows, now, store.metadata);
  return { key: `${path}:${cache!.stamp}:${rows.map(row => row.id).join(",")}`, rows };
}

/** Replace by id; captureDraft owns evidence deduplication during harvest. */
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

export interface DraftCaptureResult {
  /** New rows and additional evidence that survived the final store bounds. */
  count: number;
  appended: number;
  /** Newly captured rows removed by the final row or byte bound. */
  evicted: number;
  ids: string[];
}

export interface DraftAfterUpdate {
  session_id: string;
  turn: number;
  after: string[];
}

/** One session, one lock and at most one write. Exact fingerprints match across
 * sessions; Dice matches only inside a session. Closed rows stay tombstones. */
async function captureBatch(inputs: Draft[], now: number, afterUpdates: DraftAfterUpdate[] = []): Promise<DraftCaptureResult & { matches: (Draft | null)[] }> {
  const drafts = inputs.map(input => sanitize(input, now));
  const empty = { count: 0, appended: 0, evicted: 0, ids: [] as string[], matches: inputs.map(() => null) as (Draft | null)[] };
  if (!drafts.some(Boolean) && afterUpdates.length === 0) return empty;
  const path = draftsPath();
  return withPathLock(path, async () => {
    const store = await load(path, now);
    assertWritable(store);
    const before = JSON.stringify(store.rows);
    const rows = bounded(store.rows, now, store.metadata);
    const original = new Map(rows.map(row => [row.id, structuredClone(row)]));
    const byFingerprint = new Map(rows.map(row => [row.fp, row]));
    const grams = new Map<string, Set<string> | null>();
    const gramsOf = (row: Draft): Set<string> | null => {
      if (!grams.has(row.id)) grams.set(row.id, bigramSet(row.quote));
      return grams.get(row.id)!;
    };
    const matchedIds = drafts.map(draft => {
      if (!draft) return null;
      const session = draft.evidence[0].session_id;
      const current = gramsOf(draft);
      const hit = byFingerprint.get(draft.fp) ?? rows.find(row => {
        if (row.state !== "open" || !row.evidence.some(e => e.session_id === session) || !current) return false;
        const previous = gramsOf(row);
        return previous !== null && dice(previous, current) >= DRAFT_SESSION_DICE_MIN;
      });
      if (hit) {
        if (hit.state !== "open") return hit.id;
        // Mixed or legacy provenance must never inherit a new vault identity.
        if (hit.vault_id !== draft.vault_id) hit.vault_id = "mixed";
        if (hit.kind === "typed" && draft.kind !== "typed") {
          hit.kind = draft.kind;
          if (draft.context !== undefined) hit.context = draft.context;
        }
        let appended = false;
        for (const evidence of draft.evidence) {
          if (!hit.evidence.some(e => e.session_id === evidence.session_id && e.turn === evidence.turn)) {
            hit.evidence.push(evidence);
            appended = true;
            hit.last_touched = Math.max(hit.last_touched, now);
          }
        }
        if (appended) hit.situation = mergeSituations(hit.situation, draft.situation);
      } else {
        rows.push(draft);
        byFingerprint.set(draft.fp, draft);
      }
      return (hit ?? draft).id;
    });
    // A resumed transcript may supply the application commands after a turn
    // already captured. Enrich only that existing open row, never add evidence.
    const updatedIds: string[] = [];
    for (const update of afterUpdates) {
      const row = rows.find(row => row.state === "open" && row.evidence.some(e =>
        e.session_id === update.session_id.slice(0, 200) && e.turn === update.turn));
      if (!row) continue;
      const additions = update.after.map(command => cleanDraftText(command)).filter(command => !row.situation.after.includes(command));
      const after = [...row.situation.after, ...additions].slice(0, 3);
      if (JSON.stringify(after) === JSON.stringify(row.situation.after)) continue;
      row.situation.after = after;
      row.situation.lits = situationLiterals(row.situation);
      row.last_touched = Math.max(row.last_touched, now);
      updatedIds.push(row.id);
    }
    const kept = bounded(rows, now, store.metadata);
    if (JSON.stringify(kept) !== before) await write(path, kept, store.metadata);
    const byId = new Map(kept.map(row => [row.id, row]));
    const result: DraftCaptureResult = { count: 0, appended: 0, evicted: 0, ids: [] };
    for (const id of new Set([...matchedIds, ...updatedIds])) {
      if (id === null) continue;
      const row = byId.get(id);
      if (!row) {
        if (!original.has(id)) result.evicted++;
        continue;
      }
      if (row.state !== "open") continue;
      const prior = original.get(id);
      if (!prior) result.count++;
      result.appended += row.evidence.length - (prior?.evidence.length ?? 1);
      if (!prior || JSON.stringify(row) !== JSON.stringify(prior)) result.ids.push(id);
    }
    return { ...result, matches: matchedIds.map(id => id === null ? null : byId.get(id) ?? null) };
  }, { crossProcess: true });
}

export async function captureDrafts(
  inputs: Draft[], now = Date.now(), afterUpdates: DraftAfterUpdate[] = [],
): Promise<DraftCaptureResult> {
  const { matches: _matches, ...result } = await captureBatch(inputs, now, afterUpdates);
  return result;
}

/** Single-row entry point for callers outside the session batch. */
export async function captureDraft(input: Draft, now = Date.now()): Promise<Draft | null> {
  return structuredClone((await captureBatch([input], now)).matches[0]);
}

/** Called from the harvest tick. A missing promoted note leaves a tombstone. */
export async function expireDrafts(opts: { now?: number; memoryExists?: (id: string) => Promise<boolean> } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const path = draftsPath();
  return withPathLock(path, async () => {
    const store = await load(path, now);
    assertWritable(store);
    const rows = store.rows;
    const before = JSON.stringify(rows);
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
    if (JSON.stringify(kept) !== before || store.diagnostics.skippedRows > 0) await write(path, kept, store.metadata);
    return rows.length - kept.length;
  }, { crossProcess: true });
}

export async function purgeDrafts(): Promise<void> {
  const path = draftsPath();
  await withPathLock(path, async () => {
    await unlink(path).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
    await unlink(draftVectorsPath()).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
    cache = undefined;
  }, { crossProcess: true });
}

/** Retrieval mutations preserve concurrent harvest evidence and retained tombstones. */
export async function updateRetrievedDrafts(
  removeIds: string[], displays: { id: string; session_id: string; novel: string[] }[], now = Date.now(),
): Promise<void> {
  if (!removeIds.length && !displays.length) return;
  const path = draftsPath();
  await withPathLock(path, async () => {
    const store = await load(path, now);
    assertWritable(store);
    const removed = new Set(removeIds);
    const rows = store.rows.filter(row => row.state !== "open" || !removed.has(row.id));
    for (const display of displays) {
      const row = rows.find(row => row.id === display.id && row.state === "open");
      if (!row || row.surfaced.some(s => s.session_id === display.session_id)) continue;
      row.surfaced.push({ session_id: display.session_id, ts: now, novel: display.novel });
      row.surfaced = row.surfaced.slice(-5);
      row.last_touched = now;
    }
    await write(path, bounded(rows, now, store.metadata), store.metadata);
  }, { crossProcess: true });
}

/** Promotion and undo serialize with capture/purge. Keep the draft lock across
 * the audited vault mutation; a purge cannot race a late note publication. */
export async function transactDrafts<T>(mutate: (rows: Draft[]) => Promise<T>, now = Date.now()): Promise<T> {
  const path = draftsPath();
  return withPathLock(path, async () => {
    const store = await load(path, now);
    assertWritable(store);
    const rows = bounded(store.rows, now, store.metadata);
    const before = JSON.stringify(rows);
    const result = await mutate(rows);
    if (JSON.stringify(rows) !== before) await write(path, bounded(rows, now, store.metadata), store.metadata);
    return result;
  }, { crossProcess: true });
}
