/**
 * Surfaced-usage feedback ping (#154, review find 2026-07-03).
 *
 * The daemon's /hook/recall returns raw top-k hits; every hook CLI then
 * filters client-side (score floors, #110/#148 scope filter, per-session
 * dedup) before injecting. Only the hook knows what the model actually saw —
 * so the hook reports exactly that id list back, and ONLY those count as
 * "surfaced" in the usage sidecar. Without this, phantom demand (hits nobody
 * saw) would qualify memories for curator demotion.
 *
 * Best-effort by contract: hard timeout, never throws, resolves always.
 * Loopback POST like the bash hooks' act-signal.
 */
import { postJson } from "./prompt-loopback.js";

export function reportHinted(
  baseUrl: string,
  ids: string[],
  /** #478 Part 2: the hook is the only place that knows which session saw
   *  these ids. Without it the act-detection window opens on an `inferred`
   *  turn, where a command from a PARALLEL session can close it — the count
   *  would then be about the wrong session. Lanes that have no session id
   *  report the ids for the usage sidecar as before, but open no window. */
  sessionId: string | null = null,
  timeoutMs = 120,
  drafts?: { ids: string[]; input: string }
): Promise<void> {
  if (!Array.isArray(ids) || (ids.length === 0 && !drafts?.ids.length)) return Promise.resolve();
  const body = {
    ids,
    session_id: sessionId,
    ...(drafts?.ids.length ? { draft_ids: drafts.ids.slice(0, 2), draft_input: drafts.input } : {}),
  };
  // The answer is never read: every outcome, a failure included, resolves.
  return postJson(baseUrl, "/hook/hinted", body, timeoutMs).then(
    () => undefined,
    () => undefined
  );
}
