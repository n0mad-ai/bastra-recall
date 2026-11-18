// Active-row marker on the right panel's outer edge (prototype lsInd).
// Every element in the panel with data-lsel="1" gets one 1px line at x =
// viewport frame. The line elements are kept between measurements, so a new
// selection slides there (transform, same duration/easing as the nav marker)
// instead of jumping. Colour: the row's --lsel-c (e.g. an area's own colour),
// otherwise the accent. Lists only need to set data-lsel; DOM changes inside
// the panel are picked up by a MutationObserver (at most one measure per frame).
import { h, setVars } from "./dom.js";

/**
 * @param {HTMLElement} layer  absolutely positioned host for the line elements
 * @param {HTMLElement} panel  the panel (its [data-lsel] descendants are marked)
 * @param {HTMLElement} clip   scroll box the marker is clipped to
 * @param {() => boolean} visible  false hides all lines (panel closed)
 */
export function panelIndicator(layer, panel, clip, visible) {
  const lines = [];
  let queued = false;

  function measure() {
    queued = false;
    const show = visible();
    const ar = panel.getBoundingClientRect(),
      cr = clip.getBoundingClientRect();
    const spots = [];
    if (show && ar.width >= 10)
      for (const el of panel.querySelectorAll('[data-lsel="1"]')) {
        const r = el.getBoundingClientRect(),
          top = Math.max(r.top, cr.top),
          bot = Math.min(r.bottom, cr.bottom);
        if (bot - top < 4) continue;
        spots.push({
          top: Math.round(top),
          h: Math.round(bot - top),
          c: getComputedStyle(el).getPropertyValue("--lsel-c").trim(),
        });
      }
    while (lines.length > spots.length) lines.pop().remove();
    spots.forEach((p, i) => {
      let el = lines[i];
      const vars = { "--t": `${p.top}px`, "--h": `${p.h}px`, "--ic": p.c || "var(--accent)" };
      if (!el) {
        // New line: placed without transition, then faded in.
        el = h("span.ls-ind.is-new");
        lines.push(el);
        layer.append(el);
        setVars(el, vars);
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("is-new")));
      } else setVars(el, vars);
    });
  }

  const schedule = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(measure);
    }
  };
  new MutationObserver(schedule).observe(panel, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-lsel", "class"],
  });
  clip.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  return schedule;
}
