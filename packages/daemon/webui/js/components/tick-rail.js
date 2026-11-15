/** Tick rail: a scroll position shown as marks instead of a scrollbar.
 *
 *  Built for the notice deck, now shared with the live history — same rail,
 *  same behaviour, two lists. Pure UI: it knows an element to draw into and an
 *  element that scrolls, nothing about notices or memories.
 *
 *  Two things it does that a naive version gets wrong, both learned on the
 *  deck:
 *
 *  1. The lit mark comes from the scroll POSITION, not from "which item has
 *     been scrolled past". The latter can never reach the last mark — scrolled
 *     all the way down, the final item sits at the BOTTOM of the port, so the
 *     rail stops short and the list looks like it has more below. A fraction
 *     of the scrollable distance is exact at both ends by construction.
 *
 *  2. The rail is capped in marks. The deck holds a handful of cards, but a
 *     session history holds hundreds — one mark per row would leave a wall of
 *     marks that reads as noise. Past the cap the rail becomes a scale: fewer
 *     marks than rows, the position still exact.
 */

const MAX_GAP = 7;
const MIN_GAP = 1;
const TICK_H = 2;

/**
 * @param {object}      o
 * @param {HTMLElement} o.railEl    where the marks are drawn
 * @param {HTMLElement} o.scrollEl  the element that actually scrolls
 * @param {HTMLElement} [o.sizeEl]  what the rail may not outgrow (default: scrollEl)
 * @param {number}      [o.maxTicks] cap on marks; beyond it the rail is a scale
 */
export function createTickRail({ railEl, scrollEl, sizeEl = null, maxTicks = 30 }) {
  const heightSource = () => sizeEl ?? scrollEl;
  let activeIndex = 0;
  /** Which item the pointer is on, independent of where the list is scrolled.
   *  Two different questions — "where am I in the list" and "what am I touching"
   *  — so they are two marks, not one fighting over the same state. */
  let hoverIndex = null;

  /** How many marks to draw for `count` items — the count itself, or the cap. */
  const tickCount = (count) => Math.min(count, maxTicks);

  /** Item index → mark index. They are the same until the cap kicks in; past it
   *  the rail is a scale and several items share a mark. */
  function tickFor(item, count) {
    const n = tickCount(count);
    if (n < 2 || count < 2) return 0;
    return Math.round((item / (count - 1)) * (n - 1));
  }

  /** Which mark is lit, from the scroll position. Exact at both ends: 0 at the
   *  top, n-1 at the bottom, whatever the item heights do in between. */
  function computeActive(count) {
    const n = tickCount(count);
    if (n < 2) return 0;
    const scrollable = scrollEl.scrollHeight - scrollEl.clientHeight;
    if (scrollable <= 1) return 0; // nothing to scroll — everything is "at the top"
    const frac = Math.min(Math.max(scrollEl.scrollTop / scrollable, 0), 1);
    return Math.round(frac * (n - 1));
  }

  /** Keep the rail no taller than the box beside it. The marks are fixed at
   *  2px — any thinner and they vanish — so the spacing is what gives, down to
   *  MIN_GAP. Past that the overflow clips at the TOP, i.e. the oldest end. */
  function fit(n) {
    const available = heightSource().offsetHeight;
    if (!available || n < 2) return;
    const gap = (available - n * TICK_H) / (n - 1);
    railEl.style.gap = `${Math.min(Math.max(gap, MIN_GAP), MAX_GAP)}px`;
  }

  /** Redraw for `count` items. One mark is not a scale, it is a dot — the rail
   *  stays hidden until there is something to navigate. */
  function paint(count) {
    const n = tickCount(count);
    railEl.hidden = n < 2;
    if (railEl.hidden) {
      railEl.replaceChildren();
      return;
    }
    if (railEl.children.length !== n) {
      railEl.replaceChildren(
        ...Array.from({ length: n }, () => {
          const t = document.createElement("span");
          t.className = "lt-tick";
          return t;
        })
      );
    }
    const hovered = hoverIndex === null ? null : tickFor(hoverIndex, count);
    [...railEl.children].forEach((t, i) => {
      t.classList.toggle("active", i === activeIndex);
      // neighbours lean towards the active mark, so it reads as a position on
      // a rail instead of a lone bright dash
      t.classList.toggle("near", Math.abs(i - activeIndex) === 1);
      t.classList.toggle("hover", i === hovered);
    });
    fit(n);
  }

  return {
    /** Recompute the lit mark from the current scroll offset. */
    sync(count) {
      const next = computeActive(count);
      if (next === activeIndex) return false;
      activeIndex = next;
      return true;
    },
    paint,
    /** Point the rail at the item under the cursor, or clear it with null.
     *  Redraws only on a real change — this runs off pointer movement. */
    setHover(item, count) {
      const next = item === null || item === undefined ? null : item;
      if (next === hoverIndex) return;
      hoverIndex = next;
      paint(count);
    },
    /** Full pass: read the scroll position, then redraw. */
    update(count) {
      this.sync(count);
      paint(count);
    },
    getActive: () => activeIndex,
  };
}
