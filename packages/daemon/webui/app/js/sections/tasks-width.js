// Settled content width of the Tasks area. The stage animates its left and right edges when the
// shell geometry changes (css/panels.css .stage), so a width measured mid-transition is transient:
// acting on it flips the calendar between week and three days and back (#1701). Every settled
// change counts, a single pixel included, so 699 px shows three days and 700 px the week (#1702).
// Only the stage's own edge transitions defer: those are finite and end in transitionend or
// transitioncancel. Any other animation on the stage, endless ones included, does not (#1735).
const EDGES = new Set(["left", "right", "inset", "width", "all"]);
const movesEdges = (stage) => stage?.getAnimations?.().some((a) => EDGES.has(a.transitionProperty));

export function watchSettledWidth(el, stage, onWidth) {
  let last = el.clientWidth;
  const check = () => {
    if (movesEdges(stage)) return; // transitionend re-checks once the edges stop
    const w = el.clientWidth;
    if (w > 0 && w !== last) {
      last = w;
      onWidth(w);
    }
  };
  const ro = new ResizeObserver(check);
  ro.observe(el);
  stage?.addEventListener("transitionend", check);
  stage?.addEventListener("transitioncancel", check);
  return {
    stop() {
      ro.disconnect();
      stage?.removeEventListener("transitionend", check);
      stage?.removeEventListener("transitioncancel", check);
    },
  };
}
