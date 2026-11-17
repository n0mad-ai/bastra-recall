/**
 * #1322: the task-boundary accumulator (#572) — what the session wrote, and
 * the block a Stop parked for the next prompt.
 */
import { MAX_SHOW, bumpShown } from "./shown.js";
import { loadSessionState, mutateSessionState } from "./store.js";
import type { ReadonlySessionState, SessionState, TakenBoundary, TouchedFile, TouchedHit } from "./types.js";

/** #572: bounds, so a long session cannot grow its state file without limit. */
export const MAX_TOUCHED_FILES = 128;
export const MAX_TOUCHED_HITS = 40;
/**
 * Budget for the accumulator's own text, in characters. The counts above do
 * not bound it: a path may be 512 bytes (`limits.ts`), so 128 x 40 hits can
 * serialise to ~8 MiB — in a file every lane reads, parses and rewrites whole,
 * and whose largest observed size before #572 was under 1 KiB. Past the budget
 * the table is a prefix of the task and says so (`touchedOverflow`).
 */
export const MAX_TOUCHED_CHARS = 128 * 1024;

/**
 * #572: book one file the session is about to write.
 *
 * `hits === null` means the lane could not look at this edit. Every bound
 * resolves toward saying so rather than toward a shorter answer: past the hit
 * bound the entry is marked `truncated`, and past the file bound the whole
 * table is marked `touchedOverflow` — it has become a prefix of the task.
 */
/**
 * #572 (CodeQL `js/remote-property-injection`): both levels of `touched` are
 * keyed by tool input — a repository root and a file path. An object used as a
 * map turns those keys into property names, and `table["__proto__"] = entry`
 * then runs the inherited setter and changes the object's prototype instead of
 * storing anything.
 *
 * Two guards were tried first — prototype-less containers, then the same
 * denylist `call-corruption.ts` uses for argument names — and the query kept
 * flagging the writes, because it does not follow a refusal through a call and
 * did not read the inline comparisons as a barrier either. So the shape is
 * gone instead of guarded, which is what the query's own guidance says to do:
 * a `Map` has no property write to pollute and no name to refuse. Nothing is
 * dropped any more — a file really named `__proto__` is booked like any other,
 * which is the outcome a denylist could not give.
 *
 * It costs one conversion at the disk boundary, in `encodeSessionState` and in
 * the decoder (`codec.ts`), because `JSON.stringify` writes a `Map` as `{}`.
 */
export function recordTouched(
  state: SessionState,
  repoRoot: string,
  file: string,
  hits: readonly TouchedHit[] | null,
  truncated = false,
  now: number = Date.now()
): void {
  if (state.touched === undefined) state.touched = new Map();
  let repo = state.touched.get(repoRoot);
  if (repo === undefined) {
    repo = new Map();
    state.touched.set(repoRoot, repo);
  }
  const entry = repo.get(file) ?? registerTouchedFile(state, state.touched, repo, repoRoot, file, now);
  if (entry === undefined) return;
  entry.last = now;
  if (truncated) entry.truncated = true;
  if (hits === null) {
    entry.unplaced = true;
    return;
  }
  bookTouchedHits(state, entry, hits);
}

/** A file's first booking, or undefined when a bound refused it (and said so). */
function registerTouchedFile(
  state: SessionState,
  touched: Map<string, Map<string, TouchedFile>>,
  repo: Map<string, TouchedFile>,
  repoRoot: string,
  file: string,
  now: number
): TouchedFile | undefined {
  if (touchedCount(state) >= MAX_TOUCHED_FILES) {
    state.touchedOverflow = true;
    if (repo.size === 0) touched.delete(repoRoot);
    return undefined;
  }
  // The registration itself costs characters, and long paths make it the
  // bigger half: 128 files under a deep workspace root outspend the whole
  // budget before a single dependent is booked. Charged through the same
  // check as a hit, or `touchedOverflow` would stay false while the table
  // grew past the bound this module promises to hold.
  const base = repoRoot.length + file.length + ENTRY_OVERHEAD;
  if ((state.touchedChars ?? 0) + base > MAX_TOUCHED_CHARS) {
    state.touchedOverflow = true;
    if (repo.size === 0) touched.delete(repoRoot);
    return undefined;
  }
  const entry: TouchedFile = { at: now, last: now, hits: [], unplaced: false, truncated: false };
  repo.set(file, entry);
  state.touchedChars = (state.touchedChars ?? 0) + base;
  return entry;
}

/** Union the dependents of one edit into the file's entry, within both bounds. */
function bookTouchedHits(state: SessionState, entry: TouchedFile, hits: readonly TouchedHit[]): void {
  const known = new Set(entry.hits.map((h) => h.file));
  for (const hit of hits) {
    if (known.has(hit.file)) continue;
    if (entry.hits.length >= MAX_TOUCHED_HITS) {
      entry.truncated = true;
      break;
    }
    const cost = hit.file.length + hit.location.length + hit.via.length + hit.relation.length + ENTRY_OVERHEAD;
    if ((state.touchedChars ?? 0) + cost > MAX_TOUCHED_CHARS) {
      state.touchedOverflow = true;
      break;
    }
    state.touchedChars = (state.touchedChars ?? 0) + cost;
    known.add(hit.file);
    entry.hits.push({ file: hit.file, location: hit.location, via: hit.via, relation: hit.relation });
  }
}

/** JSON keys, quotes and separators around one entry — an estimate, on the high side. */
const ENTRY_OVERHEAD = 64;

/**
 * #572: park the block a Stop computed, unless a NEWER Stop already did.
 *
 * Two Stops can compute from different snapshots and finish in the opposite
 * order; `builtFrom` is the moment the snapshot was read, and the older
 * computation never overwrites the newer one. `null` clears the slot under the
 * same rule.
 */
export function parkBoundary(
  state: SessionState,
  built: { note: string; dedupeKey: string; files: number } | null,
  builtFrom: number
): void {
  if (state.boundary !== undefined && state.boundary.builtFrom > builtFrom) return;
  if (built === null) {
    delete state.boundary;
    return;
  }
  state.boundary = { note: built.note, dedupeKey: built.dedupeKey, builtFrom, files: built.files };
}

/**
 * #572: take the parked block from inside a mutation the caller already holds.
 *
 * Read, dedupe-check, book and clear in ONE write — the atomicity
 * `takeParkedBoundary` describes, available to a lane that has the session
 * state open anyway. The prompt lane folds it into its own save rather than
 * opening the file a second time on the hot path (#305's 200 ms ceiling).
 *
 * Returns null when nothing was parked. A `note` of null means the slot was
 * cleared but this session had already been told the same thing — the caller
 * still has a measurement to write.
 */
export function takeBoundary(state: SessionState): TakenBoundary | null {
  const parked = state.boundary;
  if (parked === undefined) return null;
  delete state.boundary;
  if ((state.shown[parked.dedupeKey]?.count ?? 0) >= MAX_SHOW) return { note: null, files: parked.files };
  bumpShown(state, parked.dedupeKey);
  return { note: parked.note, files: parked.files };
}

/**
 * #572: hand over the parked task-boundary block, at most once.
 *
 * Read, dedupe-check, book and clear happen in ONE locked mutation. Done from
 * a lane's early snapshot instead, a Stop that parks between the snapshot and
 * the write-back would have its fresh block deleted unseen. Returns null when
 * nothing is parked or this session was already told the same thing; the slot
 * empties either way.
 */
export async function takeParkedBoundary(
  sessionId: string,
  /**
   * The caller's own opt-in, asked ONLY once something is parked. The trivial
   * gate is the cheapest path in the prompt lane, and the switch behind this is
   * an uncached settings read — paying it per prompt to learn that no block is
   * waiting is the cost #305 keeps off this path.
   */
  gate: () => Promise<boolean> = async () => true
): Promise<TakenBoundary | null> {
  if (!sessionId) return null;
  // Cheap early-out: no slot, no lock, no write — the common prompt.
  if ((await loadSessionState(sessionId)).boundary === undefined) return null;
  if (!(await gate())) return null;
  let taken: TakenBoundary | null = null;
  await mutateSessionState(sessionId, (state) => {
    taken = takeBoundary(state);
  });
  return taken;
}

/** Files booked across every repository of the session. */
export function touchedCount(state: ReadonlySessionState | SessionState): number {
  let n = 0;
  for (const repo of (state.touched ?? new Map()).values()) n += repo.size;
  return n;
}
