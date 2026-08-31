/**
 * Per-arm deadlines for recall (#342).
 *
 * The two retrieval arms have measurably different cost profiles: BM25 is an
 * in-memory MiniSearch pass, the dense arm needs a warm embedding model. #305
 * measured the gap on a real host — 734ms for the first call after the model
 * was evicted, ~161ms once resident — against a 600ms hook budget. Sharing one
 * deadline means a cold model makes the whole call miss it, and the caller gets
 * nothing at all rather than the cheap arm's answer.
 */

/**
 * Resolve with `p`'s value, or with `null` if `deadlineMs` elapses first.
 *
 * ABANDON, not abort. The pending work keeps running on purpose: the expensive
 * thing behind this deadline is usually a model load, and the call that gives
 * up on it is exactly the call that pays for it. Cancelling would re-pay the
 * cold start on every subsequent attempt and the model would never get warm.
 * The abandoned promise's result lands in whatever cache it writes to; its
 * rejection is swallowed so an abandoned arm cannot take the process down via
 * an unhandled rejection.
 *
 * `deadlineMs <= 0` disables the deadline and simply awaits `p` — the
 * pre-#342 behaviour, and the kill switch.
 *
 * `deadlineMs` reaches here from an HTTP request body (`vector_deadline_ms`,
 * clamped to [50, 10_000] in `http-hook-routes.ts` before the call) — this
 * function has no way to see that its caller already bounded it, so it
 * clamps again at the sink: no timer this function creates outlives
 * `MAX_DEADLINE_MS`, regardless of what a future caller passes.
 */
const MAX_DEADLINE_MS = 10_000;

export async function abandonAfter<T>(p: Promise<T>, deadlineMs: number): Promise<T | null> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return p;
  const clampedMs = Math.min(deadlineMs, MAX_DEADLINE_MS);

  // The loser of this race is still live. Without this handler, a later
  // rejection on an abandoned arm would surface as an unhandled rejection —
  // fatal in Node by default, and this runs inside short-lived hook processes.
  p.catch(() => {});

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), clampedMs);
    // Never hold the event loop open on this timer's account. A hook CLI that
    // finished its work must be free to exit; an un-unref'd timer would keep
    // the process alive for the remainder of the deadline.
    timer.unref?.();
  });

  try {
    return await Promise.race([p, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
