/**
 * #1322: the #161 per hook-source empty-streak backoff inside the session state.
 */
import { getLoadedMarkerMtime } from "./store.js";
import type { ReadonlySourceBackoff, SessionState } from "./types.js";

/* ── #161: per hook-source empty-streak backoff ────────────────────────────
 *
 * Telemetry showed long streaks of injected hint candidates that are never
 * loaded (bash-tripwire: 162 surfaced / 0 loaded) while the injection
 * cadence stayed fixed. Each hook source now tracks, per session:
 *
 *   - streak: consecutive emits whose candidates saw NO load-marker newer
 *     than the emit. Incremented at emit time; any consumption resets to 0.
 *   - skipped: would-be injections suppressed since the last emit.
 *
 * The cadence unit is EVENTS, not wall time: hooks only run on tool events
 * (there is no timer to widen against) and event rates differ wildly per
 * source — so a source with streak N skips the next min(N, cap) injection-
 * worthy events, then probes with a real emit. Deterministic, testable, and
 * costs only the state read + marker stats the dedup path already pays.
 *
 * Consumption reuses the load-marker touch files: a marker mtime newer than
 * the entry's emit ts means the agent loaded one of the emitted candidates.
 */

/** Suppression starts once this many consecutive emits went unconsumed. */
export const BACKOFF_MIN_STREAK = 2;
/** Cadence never widens beyond 1 emit per (cap + 1) injection-worthy events. */
export const BACKOFF_STREAK_CAP = 8;
/** Bound state size — hooks emit ≤5 candidate ids per block today. */
const BACKOFF_IDS_CAP = 10;

export interface BackoffDecision {
  suppress: boolean;
  /** streak after resolving the previous emit's consumption (telemetry). */
  streak: number;
}

/**
 * Decide whether this injection-worthy event should be suppressed. Pure —
 * `consumed` is resolved separately (wasEmitConsumed) so tests can pin the
 * matrix without I/O. Malformed entries fail open (emit normally).
 *
 * `hasRequired` (#161 review): true when the pending emission contains ANY
 * hit at/above MUST_LOAD_SCORE. REQUIRED-band hits are non-negotiable loads —
 * suppressing them would silently drop exactly the hints the scoring model
 * marked as must-see, so they BYPASS suppression. The bypass emit is regular
 * streak bookkeeping (recordSourceEmit as usual); only consumption resets
 * the streak. One rule here, shared by every backoff-consulting emitter.
 */
export function decideBackoff(
  entry: ReadonlySourceBackoff | undefined,
  consumed: boolean,
  hasRequired: boolean
): BackoffDecision {
  if (
    !entry ||
    typeof entry.streak !== "number" ||
    typeof entry.at !== "number" ||
    typeof entry.skipped !== "number" ||
    entry.at <= 0
  ) {
    return { suppress: false, streak: 0 };
  }
  const streak = consumed ? 0 : entry.streak;
  const suppress = !hasRequired && streak >= BACKOFF_MIN_STREAK && entry.skipped < Math.min(streak, BACKOFF_STREAK_CAP);
  return { suppress, streak };
}

/**
 * Was the source's last emit consumed? True if any of its candidate ids has
 * a load-marker newer than the emit timestamp. Best-effort fs stats via
 * getLoadedMarkerMtime — never throws.
 */
export async function wasEmitConsumed(entry: ReadonlySourceBackoff | undefined): Promise<boolean> {
  if (!entry || typeof entry.at !== "number" || entry.at <= 0 || !Array.isArray(entry.ids)) {
    return false;
  }
  for (const id of entry.ids) {
    if (typeof id !== "string") continue;
    const mtime = await getLoadedMarkerMtime(id);
    if (mtime !== null && mtime > entry.at) return true;
  }
  return false;
}

/**
 * Record an actual emit for `source` (mutates in place). The streak
 * increments only here — and only when a previous emit exists that went
 * unconsumed; consumption (or no prior emit) resets it to 0.
 */
export function recordSourceEmit(
  state: SessionState,
  source: string,
  ids: string[],
  consumed: boolean,
  now: number = Date.now()
): void {
  const prev = state.sources?.[source];
  const hadPrev = !!prev && typeof prev.at === "number" && prev.at > 0;
  const prevStreak = hadPrev && typeof prev.streak === "number" ? prev.streak : 0;
  const streak = hadPrev && !consumed ? prevStreak + 1 : 0;
  if (!state.sources) state.sources = {};
  state.sources[source] = { streak, at: now, ids: ids.slice(0, BACKOFF_IDS_CAP), skipped: 0 };
}

/** Record a suppressed would-be injection (mutates in place). */
export function recordSourceSuppressed(state: SessionState, source: string): void {
  const entry = state.sources?.[source];
  if (!entry || typeof entry.skipped !== "number") return; // decide() required an entry
  entry.skipped += 1;
}
