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
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync, type Stats } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Memory, RecallHit, Vault } from "@bastra-recall/core";
import { envFirst, envOff, isOnValue, testRunLogDir } from "./env.js";

const logDir = (): string => envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? testRunLogDir() ?? join(homedir(), ".bastra", "logs");

// ─── This feature's own files ────────────────────────────────────────────────

/** Open flag that refuses a symbolic link as the last path component (absent on Windows). */
export const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * Is the file behind an open handle this feature's own regular file? Asked of
 * the OPEN file, so what is checked is what gets read or written: a regular
 * file, with no second name (a hard link would be another file's content), and
 * still the file the path names (`at` is `lstat` of the path, so a link there
 * has a different inode — the check that also holds without O_NOFOLLOW).
 * A linked parent directory is not refused: a log directory may be one.
 */
export function isOwnRegularFile(info: Stats, at: Stats | null): boolean {
  return info.isFile() && info.nlink === 1 && !!at && at.ino === info.ino && at.dev === info.dev;
}

const warned = new Set<string>();
/** One line per file and process, naming the file and never its content. */
export function warnRefusedFile(name: string): void {
  if (warned.has(name)) return;
  warned.add(name);
  console.error(`[bastra-recall] ${name} is not a regular file of its own (a link, or unreadable) — it is left untouched and nothing is written`);
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
   *  note, with telemetry off, and when the local key is unavailable. */
  content_hash?: string;
}

export const CONTENT_KEY_FILE = "training-signal.key";
let contentKey: { path: string; key: Buffer } | undefined;

/**
 * The local secret the content hash is keyed with: 32 random bytes, created
 * once, 0600, beside the event log. Never in the vault, never in an event row.
 * Null when it cannot be had as a regular file of its own — then no hash is
 * written at all, rather than an unkeyed one. Only a success is remembered, so
 * a key another process is still writing is simply read on the next recall.
 */
function loadContentKey(): Buffer | null {
  const dir = logDir(), path = join(dir, CONTENT_KEY_FILE);
  if (contentKey?.path === path) return contentKey.key;
  let fd = -1;
  try {
    mkdirSync(dir, { recursive: true });
    let key: Buffer | undefined;
    try {
      // O_EXCL never follows a link: an existing one is EEXIST, and the read below refuses it.
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      key = randomBytes(32);
      writeSync(fd, key.toString("hex"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
      if (!isOwnRegularFile(fstatSync(fd), lstatSync(path))) throw new Error("not a regular file");
      const text = readFileSync(fd, "utf8").trim();
      if (!/^[a-f0-9]{64}$/.test(text)) throw new Error("not a key");
      key = Buffer.from(text, "hex");
    }
    contentKey = { path, key };
    return key;
  } catch {
    warnRefusedFile(CONTENT_KEY_FILE);
    return null;
  } finally { if (fd >= 0) closeSync(fd); }
}

const hashes = new WeakMap<Memory, { key: Buffer; hash: string }>();

/**
 * Which state of a note this was: HMAC-SHA-256, keyed with the local secret,
 * over title, summary, recall_when and body; first 16 hex digits. On this
 * machine the same content gives the same value, so a later or archived copy
 * of the note can be recognised as the one a recall ranked. Without the key
 * the value says nothing about the content: trying candidate texts against it
 * (a short note, a known title) does not work. Null without a key.
 */
export function noteContentHash(note: Memory): string | null {
  const key = loadContentKey();
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
