/**
 * Per-lane hook budgets (#305).
 *
 * The reflex layer used to enforce ONE wall clock — 600ms — across lanes that
 * do entirely different amounts of work, and #305 proposed cutting that single
 * ceiling to 200ms. Seven days of telemetry (2026-09-05 → 2026-09-12,
 * `~/.bastra/logs`, restart windows excluded) said a single number is the wrong
 * shape for this:
 *
 *   | lane                  |   n |  median |   p90 | cut off |
 *   |-----------------------|-----|---------|-------|---------|
 *   | PreToolUse Write/Edit | 723 |   49ms  |  87ms |   0.1%  |
 *   | UserPromptSubmit none | 351 |   68ms  | 245ms |   0.9%  |
 *   | UserPromptSubmit assertion | 273 | 423ms | 731ms |  23.4%  |
 *
 * Three lanes, two populations. The fast lanes hold a tight ceiling with room
 * to spare; the assertion lane sits at the start of a turn, which is exactly
 * the pause that evicts the embedding model, so it pays a cold dense arm by
 * construction (see the #342 measurement in #305). A budget it misses on one
 * call in four is not a budget — it is a silent drop, and #305's own framing is
 * that a timed-out hook fails quietly.
 *
 * DECISION (2026-09-12): budget per lane, assertion at 1000ms; the 200ms target
 * from #305 applies to the fast lanes only, which actually hold it. Measured
 * against the same seven days, by reconstructing what each cut call really cost
 * from the `hook_recall` row the daemon finished anyway: all 64 cut assertion
 * calls reconstruct to ≤ 975ms (median 625ms, p90 836ms), so a 1000ms budget
 * delivers 99.3–100% of the lane instead of 76.6%. The spread is the lane
 * overhead used in the reconstruction (median 16ms → 100%, p90 56ms → 99.3%).
 *
 * These are fixed constants, deliberately — a budget that every host can retune
 * is a budget no measurement applies to. The pre-existing
 * `BASTRA_HOOK_TIMEOUT_MS` escape hatch keeps working where it already did; no
 * new knob is added here.
 *
 * Dependency-free on purpose: the thin clients and the compiled stub import it,
 * and every import there is process-start cost on every single hook call.
 */

/** Trigger classes the UserPromptSubmit lane splits into. */
export type PromptLaneMode = "retrieval" | "assertion" | "generic" | "none";

/**
 * The assertion lane's budget. Also the budget the UserPromptSubmit CLIENTS
 * must allow: the trigger class is decided daemon-side, after the payload has
 * been posted, so a client cannot know which class it is serving. It has to
 * outlast the slowest one — and since the daemon cuts each class at its own
 * budget, the extra room is a backstop against a hung daemon, not added
 * waiting. The registered hook timeout is 2s either way.
 */
export const PROMPT_ASSERTION_BUDGET_MS = 1000;

/** Every other prompt class, plus the two recall lanes (write, plan). */
export const RECALL_BUDGET_MS = 600;

/** Bash pre/post and the session lane: pattern work and a preload, not a
 *  dense recall. Unchanged — they have always run on 500ms. */
export const FAST_BUDGET_MS = 500;

/** The Stop lane scans a transcript and answers `{}` either way. Unchanged. */
export const STOP_BUDGET_MS = 1000;

/**
 * The p90 latency each lane is expected to hold. This is where #305's "cut the
 * ceiling to 200ms" survives: as a target for the lanes that meet it, not as a
 * single number the slowest lane was always going to miss.
 */
export const FAST_LANE_P90_TARGET_MS = 200;
/** The silent prompt classes do more than a write hook and less than a recall;
 *  measured p90 245ms, so 200ms would be a target that is already missed. */
export const PROMPT_QUIET_P90_TARGET_MS = 300;
/** The assertion lane's target is its budget minus the headroom the
 *  reconstruction leaves: worst reconstructed call 975–1015ms. */
export const ASSERTION_P90_TARGET_MS = 900;

/** The wall clock the daemon-side prompt lane gives itself for `mode`. */
export function promptBudgetMs(mode: PromptLaneMode): number {
  return mode === "assertion" ? PROMPT_ASSERTION_BUDGET_MS : RECALL_BUDGET_MS;
}
