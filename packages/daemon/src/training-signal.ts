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
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Memory, RecallHit, Vault } from "@bastra-recall/core";
import { envFirst, envOff, isOnValue, testRunLogDir } from "./env.js";

// ─── Candidate pool: note state and per-arm rank ─────────────────────────────

export interface TelemetryPoolCandidate {
  id: string;
  score: number;
  /** 1-based rank in the keyword arm; null = that arm did not carry the note.
   *  Both ranks are absent when the recall did not run the hybrid path. */
  rank_bm25?: number | null;
  /** 1-based rank in the vector arm; null = that arm did not carry the note. */
  rank_vector?: number | null;
  /** {@link noteContentHash} of the note as it was ranked. Absent for a private note. */
  content_hash?: string;
}

const hashes = new WeakMap<Memory, string>();

/**
 * Which state of a note this was: SHA-256 over title, summary, recall_when and
 * body, first 16 hex digits. Recompute it over any later or archived copy of
 * the note to tell whether that copy is the one a recall ranked.
 */
export function noteContentHash(note: Memory): string {
  let value = hashes.get(note);
  if (!value) {
    value = createHash("sha256").update(JSON.stringify([note.fm.title, note.fm.summary ?? "", note.fm.recall_when ?? [], note.body])).digest("hex").slice(0, 16);
    hashes.set(note, value);
  }
  return value;
}

export function telemetryCandidatePool(pool: readonly RecallHit[], vault: Pick<Vault, "get">): TelemetryPoolCandidate[] {
  return pool.map((hit) => {
    const note = vault.get(hit.id);
    return {
      id: hit.id,
      score: hit.score,
      ...(hit.rrf ? { rank_bm25: hit.rrf.rank_bm25, rank_vector: hit.rrf.rank_vector } : {}),
      ...(note && note.fm.sensitivity !== "private" ? { content_hash: noteContentHash(note) } : {}),
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
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? testRunLogDir() ?? join(homedir(), ".bastra", "logs");
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const rows = verdicts.map((verdict) => JSON.stringify({ kind: "rerank_verdict", ts, session_id: null, ...verdict, model, ...evalRunMark() }) + "\n");
    await appendFile(join(logDir, `events-${ts.slice(0, 10)}.jsonl`), rows.join(""), "utf8");
  } catch {
    // Observability must never break the harvest itself.
  }
}
