/**
 * Per-session hook dedup and gate bookkeeping (#32/#539/#1339).
 * Session state and load timestamps persist in the local app database. Legacy
 * /tmp/bastra-hook JSON and touch files are backed up, imported, then retained
 * as .pre-sqlite originals. Warm lane reads use immutable in-memory snapshots.
 * Mutations serialize per session and read the latest committed row inside a
 * short SQLite writer transaction, never around a lane's recall work.
 * Busy storage is best-effort; a gate only denies after a successful commit.
 *
 * #1322: this module is the public face; the parts live in `session-state/`,
 * one responsibility each:
 *
 *   types.ts        the state shapes (mutable and read-only)
 *   codec.ts        the one decoder/encoder of the persisted JSON
 *   store.ts        locked I/O: load, mutate, save, load markers, sweep
 *   location.ts     state directory and keys
 *   draft-claims.ts in-process draft-hint claims, seeded by the decoder
 *   shown.ts        hint dedup and the session-start constants' cadence
 *   task-gate.ts    must-load claims, conventions in force, task generation
 *   touched.ts      the task-boundary accumulator and its parked block
 *   backoff.ts      the per-source empty-streak backoff
 *
 * Callers import from here, never from the parts.
 */
export { taskIdFor, type ActiveTask } from "./task-state.js";
export type {
  ActiveConvention,
  ArtifactReceipt,
  ConventionValidator,
  CorrespondenceContext,
  ParkedBoundary,
  PendingMustLoad,
  ReadonlySessionState,
  ReadonlySourceBackoff,
  RepairAttempts,
  SessionState,
  ShownEntry,
  SourceBackoff,
  TakenBoundary,
  TouchedFile,
  TouchedHit,
} from "./session-state/types.js";
export { STATE_MAX_AGE_MS, sessionStateDir } from "./session-state/location.js";
export { availableDraftHints, claimDraftHints } from "./session-state/draft-claims.js";
export {
  cleanupOldStates,
  getLoadedMarkerMtime,
  loadSessionState,
  mutateSessionState,
  persistDraftHintClaims,
  saveSessionState,
  touchLoadedMarker,
} from "./session-state/store.js";
export {
  MAX_SHOW,
  RESET_WINDOW_MS,
  bumpShown,
  clearShown,
  shouldDropHit,
  takeConstantCadence,
} from "./session-state/shown.js";
export {
  ACTIVE_CONVENTIONS_CAP,
  bookPendingMustLoad,
  bumpTaskGeneration,
  clearPendingMustLoad,
  recordActiveConventions,
  recordClaimedMustLoad,
  resetToolCalls,
} from "./session-state/task-gate.js";
export {
  MAX_TOUCHED_CHARS,
  MAX_TOUCHED_FILES,
  MAX_TOUCHED_HITS,
  parkBoundary,
  recordTouched,
  takeBoundary,
  takeParkedBoundary,
  touchedCount,
} from "./session-state/touched.js";
export {
  BACKOFF_MIN_STREAK,
  BACKOFF_STREAK_CAP,
  decideBackoff,
  recordSourceEmit,
  recordSourceSuppressed,
  wasEmitConsumed,
  type BackoffDecision,
} from "./session-state/backoff.js";
