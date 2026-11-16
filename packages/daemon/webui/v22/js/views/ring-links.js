// Ring view (UI v2): the links of one memory — the hovered dot, else the
// selected one — as curves to its linked dots, like the lenses draw them
// (lens-draw.js: relation colour RC at 0.8, 1 px, bent towards the centre;
// links to memories that are not shown are left out). The source and its
// linked dots are drawn again on top at full strength, so the segment dimming
// (nodeTier) never hides them, across area borders too.
import { s, clear } from "../dom.js";
import { RC, MUT, ACC } from "./chrome.js";
import { areaCol } from "./vault-data.js";

/**
 * Dimming tier of a segment's dots: "dim" outside the hovered/focused
 * segment, "soft" for the rest of the segment that holds the selected memory,
 * "on" otherwise. Keys are ring segment keys (small areas share one).
 */
export function nodeTier(segKey, hoverKey, selKey) {
  if (hoverKey && segKey !== hoverKey) return "dim";
  return selKey && segKey === selKey ? "soft" : "on";
}

/** Quadratic curve a → b, bent halfway towards the ring centre (0, 0). */
export function linkCurve(a, b) {
  const f = (v) => v.toFixed(1);
  return `M${f(a.x)} ${f(a.y)}Q${f((a.x + b.x) / 4)} ${f((a.y + b.y) / 4)} ${f(b.x)} ${f(b.y)}`;
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

const NS = { "vector-effect": "non-scaling-stroke" };
const dot = (p, ring) =>
  s("circle", {
    cx: p.x.toFixed(1),
    cy: p.y.toFixed(1),
    r: p.r.toFixed(2),
    fill: areaCol(p.k, 0.92),
    ...(ring ? { stroke: ACC, "stroke-width": 1.2, ...NS } : null),
  });

/** SVG layer; show() rebuilds only when the source dot or `stamp` changes. */
export function mountLinks() {
  const curves = s("g"),
    dots = s("g");
  const el = s("g.rg-links", null, curves, dots);
  let key = "";
  return {
    el,
    /**
     * @param {object|null} src ring dot ({ id, x, y, r, k }) or null
     * @param {object|null} m its memory ({ links })
     * @param {Map} dotOf ring dots by memory id
     * @param {(id:string) => boolean} shown target is visible (time window)
     * @param {string} stamp changes when visibility changes
     */
    show(src, m, dotOf, shown, stamp) {
      const k = src && m ? `${src.id}|${stamp}` : "";
      if (k === key) return;
      key = k;
      clear(curves);
      clear(dots);
      if (!k) return;
      const ends = linkedDots(m, dotOf, shown);
      curves.append(
        ...ends.map(({ p, rel }) =>
          s("path", {
            d: linkCurve(src, p),
            fill: "none",
            stroke: RC[rel] || MUT,
            "stroke-opacity": 0.8,
            "stroke-width": 1,
            ...NS,
          })
        )
      );
      dots.append(...ends.map(({ p }) => dot(p, true)), dot(src, false));
    },
  };
}
