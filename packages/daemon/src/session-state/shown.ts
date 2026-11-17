/**
 * #1322: the per-session hint dedup (#32/#354) — which memories this session's
 * current context already carries, and the session-start constants' cadence
 * (#509). Both are reset by compact/clear, never by a timer.
 */
import { createHash } from "node:crypto";
import { envInt } from "../env.js";
import { loadSessionState, mutateSessionState } from "./store.js";
import type { SessionState, ShownEntry } from "./types.js";

/** Threshold above which a memory is dropped from hints. #32 startete mit 3;
 *  #106 senkt den Default auf 1 — jeder Hint erscheint pro Session (innerhalb
 *  des 4h-Fensters) genau EINMAL. Wiederholte Injektionen desselben Blocks
 *  sind purer Kontext-Cost (#72) bei ~null marginaler acted_on-Chance. Ein
 *  load_memory-Marker resettet weiterhin (nach Kompaktierung darf der Hint
 *  wiederkommen). Env-tunable ohne Rebuild. */
export const MAX_SHOW = Math.max(1, envInt("BASTRA_HOOK_MAX_SHOW", 1));
/** #32 legacy: the dedup counter used to expire after 4h. #354 removed that
 *  window from `shouldDropHit`/`bumpShown` — a hint still standing in the
 *  transcript gains nothing from being repeated, and compact/clear (#509) now
 *  reset the state by signal. Kept only as the documented former value. */
export const RESET_WINDOW_MS = 4 * 60 * 60 * 1000;

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
 * by being repeated. What genuinely empties the context — compact and clear
 * (#509: not resume) — now resets the state explicitly via `clearShown` (session-lane.ts),
 * which is a signal, not a timer.
 */
export function shouldDropHit(
  entry: ShownEntry | undefined,
  loadedMarkerMtime: number | null,
  _now: number = Date.now()
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
 * #354: drop the shown-counters for a session because its context was
 * rebuilt (SessionStart with source compact/clear). The hint text the
 * dedup was protecting against repeating is gone from the context, so every
 * memory becomes eligible again. Backoff state (`sources`) deliberately
 * survives: an empty streak describes the retrieval side, not the transcript.
 *
 * #509: `resume` no longer lands here — it restores the transcript intact, so
 * the hints are still in it. The delivered session-start constants go with the
 * counters: compact and clear drop them from the context just the same.
 */
export async function clearShown(sessionId: string): Promise<void> {
  if (!sessionId) return;
  // Cheap early-out kept from #354: nothing shown, nothing to write (and no
  // state file conjured for a session that never had one).
  const current = await loadSessionState(sessionId);
  if (
    Object.keys(current.shown).length === 0 &&
    current.constants === undefined &&
    !current.loadedConventions?.length &&
    !current.deniedReflex?.length &&
    !current.rulebookCheck &&
    !current.userValidatorChannel &&
    !current.activeTask?.validatorChannel
  )
    return;
  await mutateSessionState(sessionId, (state) => {
    state.shown = {};
    delete state.constants;
    delete state.loadedConventions;
    delete state.deniedReflex;
    delete state.userValidatorChannel;
    if (state.activeTask) delete state.activeTask.validatorChannel;
  });
  if (current.rulebookCheck) await (await import("../rulebook-check.js")).resetRulebookContext(sessionId);
}

/**
 * #509: the #462 cadence for the session-start constants. Returns the parts
 * whose text this session's current context already carries byte-identically
 * — those are left out — and records the hashes of what is sent now, in one
 * locked mutation. A part that changed, or was never sent, is sent. An empty
 * part is neither sent nor recorded, so a later non-empty one counts as new.
 */
export async function takeConstantCadence(sessionId: string, parts: Record<string, string>): Promise<Set<string>> {
  const skip = new Set<string>();
  if (!sessionId) return skip;
  await mutateSessionState(sessionId, (state) => {
    const delivered = state.constants ?? {};
    for (const [part, text] of Object.entries(parts)) {
      if (text === "") continue;
      const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
      if (delivered[part] === hash) skip.add(part);
      else delivered[part] = hash;
    }
    state.constants = delivered;
  });
  return skip;
}
