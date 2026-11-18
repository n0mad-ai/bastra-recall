/**
 * #1322: the locked I/O of the session state — the only place that reads or
 * writes it, always through the codec and, for writes, under the per-session
 * path lock (#539). Load markers and the age sweep share the same directory.
 */
import * as path from "node:path";
import {
  readHookState,
  peekHookState,
  updateHookState,
  cleanupHookState,
  writeHookMarker,
  readHookMarker,
} from "../hook-state-database.js";
import { sweepUnreachableNotices } from "../hook-unreachable-notice.js";
import { withPathLock, tryWithPathLock } from "../path-lock.js";
import { decodeActiveConventions, decodeSessionState, encodeSessionState } from "./codec.js";
import { STATE_MAX_AGE_MS, loadedMarkerFile, sessionFile, sessionStateDir, stateKey } from "./location.js";
import type { ActiveConvention, ReadonlySessionState, SessionState } from "./types.js";

/**
 * Load the session state. Never throws — on any error (missing file,
 * malformed JSON, EACCES, …) we return an empty state and let the hook
 * proceed without dedup.
 */
export async function loadSessionState(sessionId: string): Promise<ReadonlySessionState> {
  return readSessionState(sessionId);
}

/** #1637: read parent membership without hydration or draft-hint claims. */
export async function peekActiveConventions(sessionId: string): Promise<ActiveConvention[]> {
  if (!sessionId) return [];
  try {
    const dir = sessionStateDir();
    const parsed = JSON.parse((await peekHookState(dir, stateKey(sessionId, dir))) ?? "{}");
    return parsed?.shown ? decodeActiveConventions(parsed.activeConventions) : [];
  } catch {
    return [];
  }
}

/** The same read, typed mutable. Only `mutateSessionState` may have it — a
 *  lane's early snapshot must not be mutable (see ReadonlySessionState). */
async function readSessionState(sessionId: string, dir = sessionStateDir()): Promise<SessionState> {
  if (!sessionId) return { shown: {} };
  try {
    return decodeSessionState(sessionId, (await readHookState(dir, stateKey(sessionId, dir))) ?? "{}");
  } catch {
    return { shown: {} };
  }
}

/**
 * Atomically persist a WHOLE state. Best-effort: failures are swallowed so
 * the hook never breaks the user's tool call.
 *
 * #539: this overwrites everything, so it is no longer how a lane writes —
 * lanes use {@link mutateSessionState}. It stays for the callers that own the
 * whole file (tests seeding a fixture). Never call it from inside a
 * `mutateSessionState` callback: taking the same path lock twice deadlocks.
 */
export async function saveSessionState(sessionId: string, state: SessionState): Promise<void> {
  if (!sessionId) return;
  await withPathLock(sessionFile(sessionId), () => writeSessionState(sessionId, state));
}

/**
 * #539: the one read-modify-write path, the shape #534 established for the
 * settings file. `mutate` gets the state as it is on disk RIGHT NOW and
 * mutates it in place; read, mutate and write all happen inside the
 * per-session lock, so two lanes firing in the same moment apply BOTH deltas
 * instead of overwriting each other.
 *
 * A lane still reads the state early — its filtering decisions need it — and
 * only the write-back moves in here, expressed as a delta. In-process
 * locking is enough: every lane is served by the same daemon process.
 *
 * #1303: resolves to whether the state reached the disk. Most lanes ignore it
 * (the state is a dedup cache); the gate lane denies only after `true`, so a
 * claim it could not persist never turns into an interruption.
 */
export async function mutateSessionState(
  sessionId: string,
  mutate: (state: SessionState) => void,
  options: { noQueue?: boolean; deadline?: number } = {}
): Promise<boolean> {
  if (!sessionId) return false;
  const expired = () => options.deadline !== undefined && Date.now() >= options.deadline;
  const apply = async () => {
    if (expired()) return false;
    let callbackError: unknown;
    try {
      await updateHookState(sessionStateDir(), stateKey(sessionId), (raw) => {
        if (expired()) throw new Error("hook_state_deadline");
        const state = decodeSessionState(sessionId, raw ?? "{}");
        try {
          mutate(state);
        } catch (error) {
          callbackError = error;
          throw error;
        }
        if (expired()) throw new Error("hook_state_deadline");
        return encodeSessionState(state);
      });
      return true;
    } catch (error) {
      if (callbackError === error) throw error;
      return false;
    }
  };
  // Busy means no claim, rather than a queued write after the hook returned.
  if (options.noQueue) {
    return (await tryWithPathLock(sessionFile(sessionId), apply, { noQueue: true })) ?? false;
  }
  return withPathLock(sessionFile(sessionId), apply);
}

/** The bare atomic write. Only ever called with the session lock held.
 *  Never throws; `false` when the state did not reach the disk. */
async function writeSessionState(sessionId: string, state: SessionState, dir = sessionStateDir()): Promise<boolean> {
  try {
    await updateHookState(dir, stateKey(sessionId, dir), () => encodeSessionState(state));
    return true;
  } catch {
    return false;
  }
}

/** Delivery bookkeeping is advisory and never queues behind another lane. */
export async function persistDraftHintClaims(sessionId: string, ids: string[], dir = sessionStateDir()): Promise<void> {
  await tryWithPathLock(sessionFile(sessionId, dir), async () => {
    try {
      await updateHookState(dir, stateKey(sessionId, dir), (raw) => {
        const state = decodeSessionState(sessionId, raw ?? "{}");
        state.draftShown = [...new Set([...(state.draftShown ?? []), ...ids])].slice(-500);
        return encodeSessionState(state);
      });
    } catch {
      /* Advisory feedback must not wait behind another writer. */
    }
  });
}

/**
 * Cleanup: best-effort sweep of session files older than `maxAgeMs`. Runs
 * lazily from the hook (only when we already loaded a state, so we don't
 * pay for it on every cold call). #1640: the per-session offline notice
 * markers share the same horizon.
 */
export async function cleanupOldStates(maxAgeMs: number = STATE_MAX_AGE_MS): Promise<void> {
  try {
    await cleanupHookState(sessionStateDir(), maxAgeMs);
  } catch {
    /* State cleanup is advisory. */
  }
  await sweepUnreachableNotices(maxAgeMs);
}

/**
 * Touch the loaded-marker for `memId`. Called from the daemon's
 * load_memory tool handler so subsequent hook calls reset the dedup
 * counter for this memory.
 */
export async function touchLoadedMarker(memId: string): Promise<void> {
  if (!memId) return;
  try {
    const key = path.basename(loadedMarkerFile(memId), ".touch").slice("loaded-".length);
    await writeHookMarker(sessionStateDir(), key);
  } catch {
    /* A busy state database must never break load_memory. */
  }
}

/**
 * Returns the mtime of the loaded-marker for `memId`, or null if no
 * marker exists. Hook uses this to decide whether to reset the dedup
 * counter (counter resets if last-shown `at` < marker mtime).
 */
export async function getLoadedMarkerMtime(memId: string): Promise<number | null> {
  if (!memId) return null;
  try {
    const key = path.basename(loadedMarkerFile(memId), ".touch").slice("loaded-".length);
    return await readHookMarker(sessionStateDir(), key);
  } catch {
    return null;
  }
}
