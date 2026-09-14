/**
 * session-state — per-session tmpfile dedup for the PreToolUse hook (#32).
 *
 * Problem: the hook is stateless across invocations within the SAME Claude
 * session, so the same memory can appear in the <recall-hints> block on
 * every Write/Edit. Telemetry showed one lesson dominating 67% of misses.
 *
 * Solution: store a small JSON state per `session_id` under
 * `/tmp/bastra-hook/<session_id>.json` with shape `{ shown: { [memId]:
 * { count, at } } }`. Each hook call:
 *   1. Loads the session state (best-effort, returns empty on any error).
 *   2. Filters hits: if a hit has been shown >= MAX_SHOW times, drop it.
 *   3. After emitting the hint block, bumps `count` for every hit that
 *      was actually shown and writes the state atomically (tmpfile + rename).
 *
 * Reset signal: the daemon writes a touch-file `/tmp/bastra-hook/loaded-
 * <memId>.touch` whenever `load_memory(id)` is invoked. The hook
 * consults the touch-file mtime — if `at < loaded.mtime`, the counter is
 * reset (the agent has now consumed that memory, so the dedup-clock starts
 * over).
 *
 * Race conditions (#539): tmpfile + rename gives an atomic FILE; it does not
 * give an atomic TRANSACTION. Five lanes (write, todo, bash-pre, bash-fail,
 * prompt) run load → own work → save against the same session id, so without
 * serialisation they all read the same old file and the last save wins —
 * measured at 5 concurrent lanes reporting success and 1 surviving. Every
 * mutation therefore goes through `mutateSessionState`, which re-reads inside
 * a per-session lock and applies only that lane's delta. The lock wraps the
 * mutation, NEVER the lane's own work: a hook lane must not queue behind
 * another lane's recall. Measured cost of the extra re-read: ~0.2ms on top of
 * the ~0.5ms the save already cost.
 */
import { mkdir, readFile, rename, stat, writeFile, readdir, unlink } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { envInt } from "./env.js";
import { withPathLock } from "./path-lock.js";

export interface ShownEntry {
  count: number;
  at: number; // ms since epoch when last shown
}

/** #161: per hook-source empty-streak backoff state — see the backoff
 *  section at the bottom of this file. */
export interface SourceBackoff {
  /** consecutive unconsumed emits (incremented at emit, reset on consumption) */
  streak: number;
  /** ms epoch of the last actual emit for this source */
  at: number;
  /** candidate ids of that emit — consumption anchors on these */
  ids: string[];
  /** would-be injections suppressed since the last emit */
  skipped: number;
}

export interface SessionState {
  shown: Record<string, ShownEntry>;
  /** #161: keyed by hook source ("write-edit", "bash-tripwire", …) */
  sources?: Record<string, SourceBackoff>;
}

/**
 * #539 follow-up: what a lane gets back from {@link loadSessionState}.
 *
 * The snapshot a lane reads early is for DECISIONS only. Since #539 the
 * write-back re-reads the file inside the lock and applies just the callback's
 * delta, so anything mutated on the snapshot is dropped without a word — which
 * is exactly how the backoff's `skipped` counter stopped being saved.
 *
 * The read type therefore has to be one the mutators REFUSE. Plain `readonly`
 * properties would not do it: TypeScript ignores readonly modifiers when it
 * checks assignability, so a `Readonly<SessionState>` still slides into a
 * `SessionState` parameter. `readonly string[]` is the one readonly the
 * compiler does enforce — so `ids` carries the guard, and it makes the whole
 * state un-assignable to `SessionState`. `bumpShown(snapshot, …)` and
 * `recordSourceSuppressed(snapshot, …)` are now compile errors; the same call
 * with the callback's `state` is unchanged.
 */
export type ReadonlySourceBackoff = Readonly<Omit<SourceBackoff, "ids">> & {
  readonly ids: readonly string[];
};
export interface ReadonlySessionState {
  readonly shown: Readonly<Record<string, Readonly<ShownEntry>>>;
  readonly sources?: Readonly<Record<string, ReadonlySourceBackoff>>;
}

/** Threshold above which a memory is dropped from hints. #32 startete mit 3;
 *  #106 senkt den Default auf 1 — jeder Hint erscheint pro Session (innerhalb
 *  des 4h-Fensters) genau EINMAL. Wiederholte Injektionen desselben Blocks
 *  sind purer Kontext-Cost (#72) bei ~null marginaler acted_on-Chance. Ein
 *  load_memory-Marker resettet weiterhin (nach Kompaktierung darf der Hint
 *  wiederkommen). Env-tunable ohne Rebuild. */
export const MAX_SHOW = Math.max(1, envInt("BASTRA_HOOK_MAX_SHOW", 1));
/** #32 legacy: the dedup counter used to expire after 4h. #354 removed that
 *  window from `shouldDropHit`/`bumpShown` — a hint still standing in the
 *  transcript gains nothing from being repeated, and compact/clear/resume now
 *  reset the state by signal. Kept only as the documented former value. */
export const RESET_WINDOW_MS = 4 * 60 * 60 * 1000;
/** Cleanup: drop session files older than this (mtime). #354: this has to
 *  outlive a working day. At the old 4h it deleted the state of a session that
 *  was still running and re-opened exactly the hole the dedup closes. */
export const STATE_MAX_AGE_MS = 36 * 60 * 60 * 1000;

const DEFAULT_DIR = path.join(os.tmpdir(), "bastra-hook");

export function sessionStateDir(): string {
  return process.env.BASTRA_HOOK_STATE_DIR || DEFAULT_DIR;
}

function sessionFile(sessionId: string, dir = sessionStateDir()): string {
  // sanitize — defensive; session ids should be UUIDs but a stray slash
  // would let an attacker write outside the dir.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(dir, `${safe}.json`);
}

function loadedMarkerFile(memId: string, dir = sessionStateDir()): string {
  const safe = memId.replace(/[^a-zA-Z0-9_.\-]/g, "_");
  return path.join(dir, `loaded-${safe}.touch`);
}

/**
 * Load the session state. Never throws — on any error (missing file,
 * malformed JSON, EACCES, …) we return an empty state and let the hook
 * proceed without dedup.
 */
export async function loadSessionState(sessionId: string): Promise<ReadonlySessionState> {
  return readSessionState(sessionId);
}

/** The same read, typed mutable. Only `mutateSessionState` may have it — a
 *  lane's early snapshot must not be mutable (see ReadonlySessionState). */
async function readSessionState(sessionId: string): Promise<SessionState> {
  if (!sessionId) return { shown: {} };
  try {
    const raw = await readFile(sessionFile(sessionId), "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    if (!parsed || typeof parsed !== "object" || !parsed.shown) {
      return { shown: {} };
    }
    const state: SessionState = { shown: parsed.shown as Record<string, ShownEntry> };
    // #161: carry the backoff section through — dropping it here would reset
    // every streak on the next dedup save.
    if (parsed.sources && typeof parsed.sources === "object") {
      state.sources = parsed.sources as Record<string, SourceBackoff>;
    }
    return state;
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
 */
export async function mutateSessionState(
  sessionId: string,
  mutate: (state: SessionState) => void,
): Promise<void> {
  if (!sessionId) return;
  await withPathLock(sessionFile(sessionId), async () => {
    const state = await readSessionState(sessionId);
    mutate(state);
    await writeSessionState(sessionId, state);
  });
}

/** The bare atomic write. Only ever called with the session lock held. */
async function writeSessionState(sessionId: string, state: SessionState): Promise<void> {
  try {
    const dir = sessionStateDir();
    // mode 0700/0600: on Linux os.tmpdir() is world-writable (/tmp), so a
    // private dir + owner-only files block symlink/TOCTOU races from other
    // local users. macOS already gives a per-user temp dir.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = sessionFile(sessionId, dir);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, target);
  } catch {
    // dedup state is non-essential — never break the hot path
  }
}

/**
 * Cleanup: best-effort sweep of session files older than `maxAgeMs`. Runs
 * lazily from the hook (only when we already loaded a state, so we don't
 * pay for it on every cold call).
 */
export async function cleanupOldStates(maxAgeMs: number = STATE_MAX_AGE_MS): Promise<void> {
  try {
    const dir = sessionStateDir();
    const entries = await readdir(dir);
    const now = Date.now();
    await Promise.all(
      entries.map(async (name) => {
        if (!name.endsWith(".json") && !name.endsWith(".touch")) return;
        const full = path.join(dir, name);
        try {
          const st = await stat(full);
          if (now - st.mtimeMs > maxAgeMs) await unlink(full);
        } catch {
          // ignore — concurrent unlink or transient FS error
        }
      }),
    );
  } catch {
    // missing dir is fine
  }
}

/**
 * Touch the loaded-marker for `memId`. Called from the daemon's
 * load_memory tool handler so subsequent hook calls reset the dedup
 * counter for this memory.
 */
export async function touchLoadedMarker(memId: string): Promise<void> {
  if (!memId) return;
  try {
    const dir = sessionStateDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = loadedMarkerFile(memId, dir);
    // open-write-close gives us a fresh mtime even if the file already exists
    await writeFile(file, String(Date.now()), { encoding: "utf8", mode: 0o600 });
  } catch {
    // marker is advisory — never break load_memory if /tmp is unwritable
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
    const st = await stat(loadedMarkerFile(memId));
    return st.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Decide whether a hit with id `memId` should be dropped from the hint
 * block. Pure function — no I/O — so the unit test can pin behavior.
 *
 *   shouldDrop(state.shown[memId], loadedMarkerMtime, now)
 *
 *   - No prior entry → false (always show).
 *   - load_memory marker newer than entry.at → false (agent consumed it,
 *     dedup clock resets).
 *   - count >= MAX_SHOW AND no newer load marker → true.
 *
 * #354: there is deliberately no time window here any more. The old 4h
 * RESET_WINDOW_MS was a proxy for "same session" from a time when the lanes
 * stamped a random session id per call (#356). With a real session id the
 * proxy is redundant — and it was expensive: 180 of 873 injections in the
 * 23.08.–01.09. window were the same memory re-entering the same still-running
 * session after its window expired, 33,661 tokens, 17.9 % of that window's
 * whole context tax. A hint whose text is still in the transcript buys nothing
 * by being repeated. What genuinely empties the transcript — compact, clear,
 * resume — now resets the state explicitly via `clearShown` (session-lane.ts),
 * which is a signal, not a timer.
 */
export function shouldDropHit(
  entry: ShownEntry | undefined,
  loadedMarkerMtime: number | null,
  _now: number = Date.now(),
): boolean {
  if (!entry) return false;
  if (loadedMarkerMtime !== null && loadedMarkerMtime > entry.at) return false;
  return entry.count >= MAX_SHOW;
}

/**
 * Bump the shown-count for `memId` in `state` (mutates in place) and
 * stamp the current time. #354: counts accumulate for the life of the
 * session state — only `clearShown` and the load-marker reset them.
 */
export function bumpShown(state: SessionState, memId: string, now: number = Date.now()): void {
  const prev = state.shown[memId];
  state.shown[memId] = { count: (prev?.count ?? 0) + 1, at: now };
}

/**
 * #354: drop the shown-counters for a session because its transcript was
 * rebuilt (SessionStart with source compact/clear/resume). The hint text the
 * dedup was protecting against repeating is gone from the context, so every
 * memory becomes eligible again. Backoff state (`sources`) deliberately
 * survives: an empty streak describes the retrieval side, not the transcript.
 */
export async function clearShown(sessionId: string): Promise<void> {
  if (!sessionId) return;
  // Cheap early-out kept from #354: nothing shown, nothing to write (and no
  // state file conjured for a session that never had one).
  if (Object.keys((await loadSessionState(sessionId)).shown).length === 0) return;
  await mutateSessionState(sessionId, (state) => {
    state.shown = {};
  });
}

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
  hasRequired: boolean,
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
  const suppress =
    !hasRequired &&
    streak >= BACKOFF_MIN_STREAK &&
    entry.skipped < Math.min(streak, BACKOFF_STREAK_CAP);
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
  now: number = Date.now(),
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
