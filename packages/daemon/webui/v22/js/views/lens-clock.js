// Lens clock under a covering layer (js/cover.js): while paused the frame loop
// stands still and the animation clock is held; on resume the paused time is
// skipped, so nothing replays at once.

/** The loop schedules the next frame only while it is not paused and still busy. */
export const loopContinues = (paused, busy) => !paused && busy;

/** The animation time of a frame: held at the pause moment while paused. */
export const frameClock = (pausedAt, now) => (pausedAt == null ? now : pausedAt);

/** How long the clock stood still; added to every start time on resume. */
export const pausedFor = (pausedAt, now) => (pausedAt == null ? 0 : Math.max(0, now - pausedAt));
