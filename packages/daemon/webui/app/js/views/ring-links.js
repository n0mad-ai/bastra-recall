// Ring view (UI v2): the links of one memory — the hovered dot, else the
// selected one — drawn as in the Half-life lens (lens-draw.js): relation
// colour RC, each linked dot marked with a hollow accent ring set off from the
// dot (its "impact"). Unlike a lens, the ring keeps all dots on one band, so a
// curve bent towards the centre would send every link through the face. The
// links follow the ring instead (linkPath): the short way round, dipping
// further in the farther the target is, never inside the inner track and never
// outside the ring. Each link runs on a dark halo, so it stays visible on dots
// of any area colour. Written links are solid, derived ones dashed; a legend
// names both with their counts while links are drawn. Links to memories that
// are not shown are left out. The source and its linked dots are drawn again
// on top at full strength, so the segment dimming (nodeTier) never hides them;
// while links are drawn all other dots step back further.
// Stroke widths, dashes and the impact gap are screen pixels at every zoom:
// scale() sets --px (SVG units per screen pixel) and views.css multiplies.
import { h, s, clear } from "../dom.js";
import { t } from "../i18n.js";
import { RC, MUT, ACC } from "./chrome.js";
import { areaCol } from "./vault-data.js";

// Inner track: between the face rim (r 78) and the wedges' inner edge (96 − 6).
export const TRACK = 86;

/**
 * Dimming tier of a segment's dots: "dim" outside the hovered/focused
 * segment, "soft" for the rest of the segment that holds the selected memory,
 * "on" otherwise. While links are drawn (`linking`) every segment steps back:
 * "back" for the hovered/focused one, "far" for the others. Keys are ring
 * segment keys (small areas share one).
 */
export function nodeTier(segKey, hoverKey, selKey, linking = false) {
  const dim = hoverKey && segKey !== hoverKey;
  if (linking) return dim ? "far" : "back";
  if (dim) return "dim";
  return selKey && segKey === selKey ? "soft" : "on";
}

/**
 * Path a → b around the ring centre (0, 0): the angle runs the short way
 * (u = 0…1), the radius from a's to b's minus one parabolic dip
 * 4·D·u·(1 − u). D grows with the square of the angle, so the bend per angle
 * is the same for every link of a dot: near targets get flat arcs along the
 * ring, farther ones dip deeper and nest inside them, and no link changes its
 * bending direction (that needs r > d²r/dθ² = 8·D/dt², kept by D ≤ TRACK·dt²/8).
 * (√p + √q)² / 4 is the deepest dip that still clears TRACK; 95 % of it at 180°.
 * Drawn as a polyline of ~1.5-unit steps at 0.001 precision, so neither the
 * corners nor the rounding show at any zoom.
 */
export function linkPath(a, b) {
  const ra = Math.hypot(a.x, a.y),
    rb = Math.hypot(b.x, b.y),
    ta = Math.atan2(a.y, a.x);
  let dt = Math.atan2(b.y, b.x) - ta;
  if (dt > Math.PI) dt -= 2 * Math.PI;
  if (dt < -Math.PI) dt += 2 * Math.PI;
  const room = (Math.sqrt(Math.max(0, ra - TRACK)) + Math.sqrt(Math.max(0, rb - TRACK))) ** 2 / 4,
    D = dt * dt * Math.min((0.95 * room) / (Math.PI * Math.PI), TRACK / 8),
    n = 4 + Math.ceil((Math.abs(dt) * (ra + rb)) / 3 + Math.abs(rb - ra) / 1.5),
    f = (v) => v.toFixed(3);
  let d = `M${f(a.x)} ${f(a.y)}`;
  for (let i = 1; i < n; i++) {
    const u = i / n,
      r = ra + (rb - ra) * u - 4 * D * u * (1 - u),
      th = ta + dt * u;
    d += `L${f(Math.cos(th) * r)} ${f(Math.sin(th) * r)}`;
  }
  return `${d}L${f(b.x)} ${f(b.y)}`;
}

/**
 * Stroke of one link: lens colour (RC), dashed when derived. Written links
 * calm down when many; the darker derived dashes keep 0.85, so they reach
 * contrast 4.7 on the dark halo every link runs on (views.css .rg-halo).
 */
export function linkStyle(rel, n) {
  const dashed = rel === "derived";
  return {
    stroke: RC[rel] || MUT,
    dashed,
    opacity: dashed ? 0.85 : Math.max(0.6, n <= 8 ? 0.85 : 0.85 * Math.sqrt(8 / n)),
  };
}

/** Legend rows [rel, count] in RC order, only relations that occur. */
export function relCounts(ends) {
  return Object.keys(RC)
    .map((rel) => [rel, ends.filter((e) => e.rel === rel).length])
    .filter(([, n]) => n > 0);
}

/** Linked dots of memory m that are on the ring and shown, once per target. */
export function linkedDots(m, dotOf, shown) {
  const out = [],
    seen = new Set();
  for (const l of m.links) {
    const p = dotOf.get(l.id);
    if (!p || seen.has(l.id) || !shown(l.id)) continue;
    seen.add(l.id);
    out.push({ p, rel: l.rel });
  }
  return out;
}

/**
 * Legend corner (classes) that keeps clear of the card box {x, y, w, h}:
 * bottom left (""), else top left, else top right; all in stage pixels.
 */
export function legendSpot(box, W, H, L) {
  const spots = [
    ["", 16, H - 16 - L.h],
    ["is-top", 16, 16],
    ["is-top is-right", W - 16 - L.w, 16],
  ];
  const free = ([, x, y]) =>
    !box || x > box.x + box.w + 8 || x + L.w < box.x - 8 || y > box.y + box.h + 8 || y + L.h < box.y - 8;
  return (spots.find(free) || spots[0])[0];
}

/** Unwritten memory on the outer orbit: hollow dashed dot (ring.js ghosts). */
export const GHOST = {
  fill: "#060a13",
  stroke: "rgba(160,180,205,.75)",
  "stroke-width": 0.9,
  "stroke-dasharray": "1.6 1.4",
};
const f2 = (v) => v.toFixed(2);
const dot = (p) =>
  s("circle", { cx: f2(p.x), cy: f2(p.y), r: f2(p.r), ...(p.ghost ? GHOST : { fill: areaCol(p.k, 0.92) }) });
// impact: hollow accent ring set off from the linked dot (Half-life: r + 3, 1.2 px)
const impact = (p) => s("circle.rg-impact", { cx: f2(p.x), cy: f2(p.y), stroke: ACC, vars: { "--r": f2(p.r) } });

// one link: the line and its dark halo underneath (same path and dashes)
function curve(src, { p, rel }, n) {
  const st = linkStyle(rel, n),
    d = linkPath(src, p),
    cls = st.dashed ? ".is-derived" : "";
  return [
    s(`path.rg-halo${cls}`, { d }),
    s(`path.rg-link${cls}`, { d, stroke: st.stroke, "stroke-opacity": st.opacity.toFixed(2) }),
  ];
}

function legendRow([rel, n]) {
  return h(
    "div.rg-legend__row",
    null,
    h(`span.rg-legend__line.is-${rel}`, { vars: { "--c": RC[rel] || MUT } }),
    h("span", { text: t(`vv.rel.${rel}`) }),
    h("span.rg-legend__n", { text: String(n) })
  );
}

/** SVG layer plus its HTML legend; show() rebuilds only when the source dot, the ring or `stamp` changes. */
export function mountLinks() {
  const halos = s("g"),
    curves = s("g"),
    dots = s("g");
  const el = s("g.rg-links", null, halos, curves, dots);
  const legend = h("div.rg-legend");
  let key = "",
    ring = null,
    spot = "",
    drawn = false;
  return {
    el,
    legend,
    /** @param {number} kk screen pixels per SVG unit */
    scale(kk) {
      el.style.setProperty("--px", (1 / kk).toFixed(4));
    },
    /** Keep the legend clear of the focus card (an element in the stage, or null). */
    dodge(card, W, H) {
      if (!legend.classList.contains("is-on")) return;
      const box = card && { x: card.offsetLeft, y: card.offsetTop, w: card.offsetWidth, h: card.offsetHeight };
      const c = legendSpot(box, W, H, { w: legend.offsetWidth, h: legend.offsetHeight });
      if (c === spot) return;
      spot = c;
      legend.classList.remove("is-top", "is-right");
      if (c) legend.classList.add(...c.split(" "));
    },
    /**
     * @param {object|null} src ring dot ({ id, x, y, r, k }) or null
     * @param {object|null} m its memory ({ links })
     * @param {Map} dotOf ring dots by memory id
     * @param {(id:string) => boolean} shown target is visible (time window)
     * @param {string} stamp changes when visibility changes
     * @returns {boolean} links are drawn
     */
    show(src, m, dotOf, shown, stamp) {
      const k = src && m ? `${src.id}|${stamp}` : "";
      if (k === key && dotOf === ring) return drawn;
      key = k;
      ring = dotOf;
      clear(halos);
      clear(curves);
      clear(dots);
      clear(legend);
      const ends = k ? linkedDots(m, dotOf, shown) : [];
      drawn = ends.length > 0;
      legend.classList.toggle("is-on", drawn);
      if (!drawn) return false;
      const pairs = ends.map((e) => curve(src, e, ends.length));
      halos.append(...pairs.map(([halo]) => halo));
      curves.append(...pairs.map(([, line]) => line));
      dots.append(...ends.map(({ p }) => dot(p)), ...ends.map(({ p }) => impact(p)), dot(src));
      legend.append(...relCounts(ends).map(legendRow));
      return true;
    },
  };
}
