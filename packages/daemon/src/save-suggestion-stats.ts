/**
 * #708 / #662 — did a session that got a save suggestion save?
 *
 * The Stop lane writes `save_eval_call` with the Claude Code session id in
 * `session_id`. A `save_memory` row carries the daemon's telemetry id there, so
 * joining the two on `session_id` answered "0 of 56" whatever had happened —
 * recounted from transcripts it was 23 of 44 (#662). Since #708 a forwarded
 * save carries the Claude Code id in `caller_session`; this joins on that and
 * falls back to `session_id` for rows that have none (old rows, other clients),
 * which is exactly the join that could never match. `savesWithCallerSession`
 * says how much of the window the join can actually see.
 *
 * Computed ONCE for both surfaces — `bastra logs --stats` and the Telemetry
 * tab — for the reason `code-awareness-stats.ts` gives.
 */

export interface SaveSuggestionStats {
  /** Sessions with at least one `save_eval_call` that suggested a save. */
  suggestedSessions: number;
  /** Of those, sessions with a `save_memory` row at any point in the window. */
  savedSessions: number;
  /** Of those, sessions whose save came after the session's first suggestion. */
  savedAfterSuggestion: number;
  /** All `save_memory` rows in the window, and the ones that carry a caller
   *  session — below 100 % the numbers above are a lower bound. */
  saves: number;
  savesWithCallerSession: number;
}

type Row = Record<string, unknown>;

/** The Claude Code session a row belongs to: `caller_session` where the
 *  forwarder sent one, `session_id` otherwise. */
export function joinSessionKey(e: Row): string | null {
  if (typeof e.caller_session === "string" && e.caller_session) return e.caller_session;
  if (typeof e.session_id === "string" && e.session_id) return e.session_id;
  return null;
}

/** Null when the window holds no suggestion — there is no rate to report. */
export function aggregateSaveSuggestions(events: readonly Row[]): SaveSuggestionStats | null {
  const firstSuggestion = new Map<string, string>();
  for (const e of events) {
    if (e.kind !== "save_eval_call") continue;
    if (typeof e.suggested_count !== "number" || e.suggested_count <= 0) continue;
    const sid = joinSessionKey(e);
    const ts = typeof e.ts === "string" ? e.ts : null;
    if (!sid || !ts) continue;
    const prev = firstSuggestion.get(sid);
    if (prev === undefined || ts < prev) firstSuggestion.set(sid, ts);
  }
  if (firstSuggestion.size === 0) return null;

  const saved = new Set<string>();
  const savedAfter = new Set<string>();
  let saves = 0;
  let savesWithCallerSession = 0;
  for (const e of events) {
    if (e.kind !== "save_memory") continue;
    saves++;
    if (typeof e.caller_session === "string" && e.caller_session) savesWithCallerSession++;
    const sid = joinSessionKey(e);
    const suggestedAt = sid ? firstSuggestion.get(sid) : undefined;
    if (!sid || suggestedAt === undefined) continue;
    saved.add(sid);
    if (typeof e.ts === "string" && e.ts > suggestedAt) savedAfter.add(sid);
  }

  return {
    suggestedSessions: firstSuggestion.size,
    savedSessions: saved.size,
    savedAfterSuggestion: savedAfter.size,
    saves,
    savesWithCallerSession,
  };
}
