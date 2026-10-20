/** The frame loop: view transitions, per-view ticks, cloud physics, draw.
 *
 *  Split out of app.js (#284). One deliberate difference from a pure move:
 *  the three camera-warmup flags (`userTouched`, `warmupFrames`, `wasBusy`)
 *  now LIVE here instead of in app.js's closure, because the loop is their
 *  only reader. app.js wrote them from two places and both now go through
 *  `claimCameraForNewLayout()` / `markBusy()`.
 *
 *  `viewTransition` stays in app.js and is reached through get/set, the same
 *  accessor pair `view-controls.js` already uses — it is written by five
 *  callers and moving it would be a redesign, not a split.
 */

/**
 * @param {object} deps
 * @param {HTMLCanvasElement} deps.canvas
 * @param {object} deps.sim
 * @param {object} deps.renderer
 * @param {object} deps.minimap
 * @param {object} deps.ringView
 * @param {object} deps.orbitView
 * @param {object} deps.semanticView
 * @param {() => object} deps.getInteractions
 * @param {() => string} deps.getView
 * @param {() => object|null} deps.getTransition
 * @param {(t: object|null) => void} deps.setTransition
 * @param {() => void} deps.saveAnchorsSoon
 */
export function createRenderLoop({
  canvas,
  sim,
  renderer,
  minimap,
  ringView,
  orbitView,
  semanticView,
  getInteractions,
  getView,
  getTransition,
  setTransition,
  saveAnchorsSoon,
}) {
  let userTouched = false;
  let warmupFrames = 0;
  let wasBusy = true;

  // #324: idle throttle. A settled clouds view with no input, flight, flash or
  // burst only breathes (ghost pulse, salience halo), so it redraws at ~30 fps.
  // Every state change that matters (physics, transition, input) runs full rate.
  const IDLE_FRAME_MS = 28;
  const IDLE_AFTER_INPUT_MS = 1000;
  let lastInput = -Infinity;
  let lastFrame = -Infinity;
  let rafId = 0;
  let started = false;
  const noteInput = () => (lastInput = performance.now());

  addEventListener("resize", () => { renderer.resize(); noteInput(); });
  canvas.addEventListener("pointerdown", () => (userTouched = true));
  canvas.addEventListener("wheel", () => (userTouched = true), { passive: true });
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel"]) {
    addEventListener(type, noteInput, { passive: true });
  }
  addEventListener("keydown", noteInput);

  // #324: a hidden tab draws nothing; coming back restarts the loop. Orbit time
  // is absolute (now / 1000) and its drift clock clamps dt, so nothing jumps.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    } else if (started && !rafId) {
      noteInput();
      rafId = requestAnimationFrame(frame);
    }
  });

  function isIdle(now) {
    return (
      !wasBusy &&
      getView() === "clouds" &&
      !getTransition() &&
      !ringView.isAnimating() &&
      !getInteractions().isFlying() &&
      !renderer.hasLiveEffects() &&
      orbitView.listBursts().length === 0 &&
      now - lastInput > IDLE_AFTER_INPUT_MS
    );
  }

  function frame(now) {
    rafId = 0;
    if (document.hidden) return;
    if (isIdle(now) && now - lastFrame < IDLE_FRAME_MS) {
      rafId = requestAnimationFrame(frame);
      return;
    }
    lastFrame = now;
    const interactions = getInteractions();
    const transition = getTransition();
    if (transition) {
      // nodes fly between views; physics pauses while they travel
      const t = Math.min((now - transition.t0) / transition.ms, 1);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      for (const n of sim.nodes) {
        const from = transition.from.get(n.id);
        const to = transition.to.get(n.id);
        if (from && to) {
          n.x = from.x + (to.x - from.x) * e;
          n.y = from.y + (to.y - from.y) * e;
        }
      }
      if (t >= 1) {
        const { done, noFit } = transition;
        setTransition(null);
        if (!noFit) interactions.fitAll();
        done?.();
      }
    }
    const busyTransition = Boolean(getTransition());
    const view = getView();
    // fan-out crossfade: the non-drilled areas dissolve/reappear in place
    ringView.tick(now);
    // orbit view: rotation + depth projection, paused during view flights
    if (!busyTransition && view === "orbit") orbitView.tick(now);
    if (!busyTransition && view === "semantic") semanticView.tick(now);
    // clouds physics pauses while any fly/fan-out animation is running
    if (!busyTransition && !ringView.isAnimating() && view === "clouds") {
      const busy = sim.tick();
      if (busy && warmupFrames++ === 24 && !userTouched) interactions.fitAll();
      if (!busy && wasBusy && !userTouched) interactions.fitAll(); // settled → final framing
      wasBusy = busy;
      // safety distance between clouds — evading clouds glide away, animated;
      // persist the arrangement once everything has come to rest
      if (sim.separateClouds(interactions.draggedCluster())) saveAnchorsSoon();
    }
    interactions.step(now);
    renderer.draw(now);
    minimap.draw();
    rafId = requestAnimationFrame(frame);
  }

  return {
    start() {
      if (started) return;
      started = true;
      getInteractions().fitAll();
      if (!document.hidden) rafId = requestAnimationFrame(frame);
    },
    /** A freshly computed layout may claim the camera once: forget that the
     *  user ever grabbed it, and make sure the boot-warmup snap-fit can never
     *  fire again. Called by the clouds branch of switchView. */
    claimCameraForNewLayout() {
      userTouched = false;
      warmupFrames = 25;
      wasBusy = true;
    },
    /** The layout is about to move on its own (regroup) — treat the next
     *  settle as a real settle so the final framing still happens. */
    markBusy() {
      wasBusy = true;
    },
  };
}
