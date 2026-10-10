/**
 * #1128-capture — TEMPORARY text-free additions to the event log.
 *
 * Step 0 of #1128 needs three things the log did not say: which state of a
 * note a recall ranked, which rows a measurement run wrote, and what the
 * reranker picked. Ids, hashes, ranks and a flag only — no query, quote or
 * note text is added by anything in this file. Everything here is covered by
 * the existing `BASTRA_TELEMETRY` switch, because it only rides on rows that
 * switch already gates.
 *
 * Removal: this file, `training-capture.ts`, and the call sites tagged
 * `#1128-capture` are the whole feature. Delete them once #1128 is decided.
 */
import { createHmac, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { appendFile, lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Memory, RecallHit, Vault } from "@bastra-recall/core";
import { envFirst, envOff, isOnValue, testRunLogDir } from "./env.js";

const logDir = (): string => envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? testRunLogDir() ?? join(homedir(), ".bastra", "logs");

// ─── This feature's own files ────────────────────────────────────────────────

/** Refuse a symbolic link as the last path component (absent on Windows). */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
/** Never wait in `open`: a FIFO opened for reading waits for a writer otherwise. */
const NONBLOCK = constants.O_NONBLOCK ?? 0;

/** The path holds something that is not this feature's own regular file. */
export class RefusedFile extends Error {}

/**
 * Is the file behind an open handle this feature's own regular file? Asked of
 * the OPEN file, so what is checked is what gets read or written: a regular
 * file, with no second name (a hard link would be another file's content), and
 * still the file the path names (`at` is `lstat` of the path, so a link there
 * has a different inode — the check that also holds without O_NOFOLLOW).
 * A linked parent directory is not refused: a log directory may be one.
 */
function isOwnRegularFile(info: Stats, at: Stats | null): boolean {
  return info.isFile() && info.nlink === 1 && !!at && at.ino === info.ino && at.dev === info.dev;
}

/**
 * The one way this feature opens its two files: open first, then ask the open
 * handle what it is — never the path beforehand, which could change in
 * between (CodeQL js/file-system-race; the repo's rule since
 * rm-archive-reconcile.ts). What keeps the open itself harmless is its flags:
 * O_NOFOLLOW does not go through a link, and O_NONBLOCK does not wait — a
 * FIFO opened for reading would otherwise wait for a writer, on the event
 * loop if the call were synchronous. A pipe, socket, device or directory is
 * then refused on the handle, without a byte read or written. A path that
 * does not exist is the caller's case (`ENOENT`, or a create via `flags`).
 */
export async function openOwnFile(path: string, flags: number, mode = 0o600): Promise<FileHandle> {
  let handle: FileHandle;
  try { handle = await open(path, flags | NOFOLLOW | NONBLOCK, mode); } catch (error) {
    // A link (ELOOP/EMLINK), a pipe or socket nobody serves (ENXIO/EOPNOTSUPP), a directory opened for writing (EISDIR).
    if (["ELOOP", "EMLINK", "ENXIO", "EOPNOTSUPP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new RefusedFile();
    throw error;
  }
  try {
    if (!isOwnRegularFile(await handle.stat(), await lstat(path).catch(() => null))) throw new RefusedFile();
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

const warned = new Set<string>();
/** One line per file and process, naming the file and never its content. */
export function warnRefusedFile(name: string): void {
  if (warned.has(name)) return;
  warned.add(name);
  console.error(`[bastra-recall] ${name} is not a regular file of its own (a link, a pipe, or unreadable) — it is left untouched and nothing is written`);
}

// ─── Candidate pool: note state and per-arm rank ─────────────────────────────

export interface TelemetryPoolCandidate {
  id: string;
  score: number;
  /** 1-based rank in the keyword arm; null = that arm did not carry the note.
   *  Both ranks are absent when the recall did not run the hybrid path. */
  rank_bm25?: number | null;
  /** 1-based rank in the vector arm; null = that arm did not carry the note. */
  rank_vector?: number | null;
  /** {@link noteContentHash} of the note as it was ranked. Absent for a private
   *  note, with telemetry off, and while the local key is not in memory. */
  content_hash?: string;
}

export const CONTENT_KEY_FILE = "training-signal.key";
/** How long a key (or the lack of one) is used before the file is looked at again. */
export const CONTENT_KEY_RECHECK_MS = 60_000;
let contentKey: { path: string; key: Buffer | null; checked: number } | undefined;
let loading: { path: string; done: Promise<Buffer | null> } | undefined;

async function readOrCreateKey(path: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true });
  try {
    // O_EXCL creates or fails; it never opens what is already there, whatever that is.
    const fresh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | NONBLOCK, 0o600);
    try { const key = randomBytes(32); await fresh.writeFile(key.toString("hex")); return key; } finally { await fresh.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const handle = await openOwnFile(path, constants.O_RDONLY);
  let text: string;
  try { text = (await handle.readFile("utf8")).trim(); } finally { await handle.close(); }
  if (!/^[a-f0-9]{64}$/.test(text)) throw new RefusedFile();
  return Buffer.from(text, "hex");
}

/**
 * Read the local secret the content hash is keyed with, creating it if there
 * is none: 32 random bytes, 0600, beside the event log. Never in the vault,
 * never in an event row. Resolves to null when the file cannot be had as a
 * regular file of its own. Always asynchronous and never on a recall's path —
 * a recall only reads what this has put in memory ({@link noteContentHash}).
 */
export function loadContentKey(): Promise<Buffer | null> {
  const path = join(logDir(), CONTENT_KEY_FILE);
  if (loading?.path === path) return loading.done;
  const done = readOrCreateKey(path).then((key) => {
    // Unchanged bytes keep their Buffer, so hashes already computed stay valid.
    const kept = contentKey?.path === path && contentKey.key?.equals(key) ? contentKey.key : key;
    contentKey = { path, key: kept, checked: Date.now() };
    return kept;
  }, () => {
    warnRefusedFile(CONTENT_KEY_FILE);
    contentKey = { path, key: null, checked: Date.now() };
    return null;
  }).finally(() => { if (loading?.done === done) loading = undefined; });
  loading = { path, done };
  return done;
}

/** The key in memory, or null. Starts a background read when there is none yet
 *  or the last look at the file is older than {@link CONTENT_KEY_RECHECK_MS} —
 *  that is how a deleted or replaced key file takes effect in a running process. */
function keyInMemory(): Buffer | null {
  const path = join(logDir(), CONTENT_KEY_FILE);
  const known = contentKey?.path === path ? contentKey : undefined;
  if (!known || Date.now() - known.checked > CONTENT_KEY_RECHECK_MS) void loadContentKey();
  return known?.key ?? null;
}

const hashes = new WeakMap<Memory, { key: Buffer; hash: string }>();

/**
 * Which state of a note this was: HMAC-SHA-256, keyed with the local secret,
 * over title, summary, recall_when and body; first 16 hex digits. On this
 * machine the same content gives the same value, so a later or archived copy
 * of the note can be recognised as the one a recall ranked. Without the key
 * the value says nothing about the content: trying candidate texts against it
 * (a short note, a known title) does not work.
 *
 * Does no file I/O and never waits: null while the key is not in memory, which
 * includes the first recall after a start. Better a row without a hash than a
 * recall that waits for one.
 */
export function noteContentHash(note: Memory): string | null {
  const key = keyInMemory();
  if (!key) return null;
  const known = hashes.get(note);
  if (known?.key === key) return known.hash;
  const hash = createHmac("sha256", key).update(JSON.stringify([note.fm.title, note.fm.summary ?? "", note.fm.recall_when ?? [], note.body])).digest("hex").slice(0, 16);
  hashes.set(note, { key, hash });
  return hash;
}

export function telemetryCandidatePool(pool: readonly RecallHit[], vault: Pick<Vault, "get">): TelemetryPoolCandidate[] {
  // No row is written with telemetry off, so no key is created for it either.
  const hashed = !envOff("BASTRA_TELEMETRY", "NEXUS_TELEMETRY");
  return pool.map((hit) => {
    const note = vault.get(hit.id);
    const content_hash = hashed && note && note.fm.sensitivity !== "private" ? noteContentHash(note) : null;
    return {
      id: hit.id,
      score: hit.score,
      ...(hit.rrf ? { rank_bm25: hit.rrf.rank_bm25, rank_vector: hit.rrf.rank_vector } : {}),
      ...(content_hash ? { content_hash } : {}),
    };
  });
}

// ─── Measurement runs ────────────────────────────────────────────────────────

/**
 * `{ eval_run: true }` for a row a measurement run wrote, else nothing.
 *
 * A flag on the row rather than a separate directory: every reader of the log
 * (stats, curator, bridges) keeps finding its input where it is, and a reader
 * that wants real traffic drops the flagged rows. Two ways a run declares
 * itself: the whole process (`BASTRA_EVAL_RUN=1`, for a benchmark daemon or
 * script — this also reaches rows without a `dimensions` column), or one call
 * (`dimensions.client === "eval"`, the #619 marker).
 */
export function evalRunMark(event?: object): { eval_run?: true } {
  const client = (event as { dimensions?: { client?: unknown } } | undefined)?.dimensions?.client;
  return isOnValue(process.env.BASTRA_EVAL_RUN) || client === "eval" ? { eval_run: true } : {};
}

// ─── Reranker verdicts ───────────────────────────────────────────────────────

export interface RerankVerdict {
  /** The logged recall whose pool was judged; null on rows from before the id was logged. */
  recall_id: string | null;
  /** The candidates the model was shown, in the order shown. */
  candidate_ids: string[];
  /** The note the model picked; null = it found none fitting. */
  chosen_id: string | null;
  /** 1-based position of the pick among `candidate_ids`. */
  chosen_rank: number | null;
}

/** One `rerank_verdict` row per judged pool. Never throws. */
export async function recordRerankVerdicts(verdicts: RerankVerdict[], model: string): Promise<void> {
  if (!verdicts.length || envOff("BASTRA_TELEMETRY", "NEXUS_TELEMETRY")) return;
  try {
    const dir = logDir();
    await mkdir(dir, { recursive: true });
    const ts = new Date().toISOString();
    const rows = verdicts.map((verdict) => JSON.stringify({ kind: "rerank_verdict", ts, session_id: null, ...verdict, model, ...evalRunMark() }) + "\n");
    await appendFile(join(dir, `events-${ts.slice(0, 10)}.jsonl`), rows.join(""), "utf8");
  } catch {
    // Observability must never break the harvest itself.
  }
}
