// Docking geometry of a focus card and its arm (DESIGN-SYSTEM §1.8), pure:
// stage pixels in, card position + arm polyline + side accent out. dock() in
// chrome.js applies the result to the DOM.
//
// The arm runs anchor → elbow → one docking point on the card border and never
// underneath the card. The elbow comes from the caller (the ring's outer edge
// in the prototype geometry); zoomed in it lies far off the stage, so it is
// moved into the corridor between anchor and card instead of only onto the
// stage (a stage corner can lie behind the card).

// Zoom bar footprint at the stage's bottom right corner (142 × 30 px + 12 px gap).
export const ZB_W = 154,
  ZB_H = 42;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dedupe = (pts) => pts.filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);

/** Stage frame for a card of CW × cardH: usable height at x, clamped card x. */
function frame(W, H, CW, cardH) {
  // Keep the card clear of the zoom bar.
  const Hx = (cx0) => (cx0 + CW > W - ZB_W ? H - ZB_H : H);
  // A card too tall for the space above the zoom bar moves left of it.
  const fitX = (cx0) => {
    cx0 = Math.max(0, Math.min(cx0, W - CW));
    return Hx(cx0) < cardH ? Math.max(0, Math.min(cx0, W - ZB_W - CW)) : cx0;
  };
  return { Hx, fitX };
}

// Card beside the anchor: the elbow stays between anchor and card, the arm
// docks horizontally on the card's near edge, inside the card's height.
function besideDock(o, f, x) {
  const { ax, ay, right, H, CW, cardH } = o;
  const lx = right ? x : x + CW;
  const ex = right ? clamp(o.ex, Math.min(ax, lx - 8), lx - 8) : clamp(o.ex, lx + 8, Math.max(ax, lx + 8));
  const ey = clamp(o.ey, 8, H - 8);
  const y = Math.max(0, Math.min(ey - 28, f.Hx(x) - cardH));
  const hy = clamp(ey, y + 14, y + cardH - 14);
  return {
    x,
    y,
    pts: dedupe([
      [ax, ay],
      [ex, hy],
      [lx, hy],
    ]),
    side: right ? "is-left" : "is-right",
    sideVars: { "--sh": `${Math.min(cardH, Math.max(2, 2 * (hy - y) + 1)).toFixed(0)}px` },
  };
}

// Card above or below the point (px, py) — the elbow, or the anchor itself
// when the elbow's placement would cover the anchor — docking vertically.
function stackDock(o, f, px, py, viaElbow) {
  const { ax, ay, CW, cardH } = o;
  const cx = f.fitX(px - CW / 2),
    Hb = f.Hx(cx);
  const top = Math.min(ay, py),
    bot = Math.max(ay, py);
  const below = bot + 24 + cardH <= Hb || (top - 24 - cardH < 0 && top + bot < Hb);
  const y = below ? Math.max(0, Math.min(bot + 24, Hb - cardH)) : Math.max(0, Math.min(top - 24, Hb) - cardH);
  // the elbow's placement must leave anchor and elbow outside the card
  if (viaElbow && (below ? bot > y - 8 : top < y + cardH + 8)) return null;
  const dx = clamp(px - cx, 14, CW - 14),
    edge = [cx + dx, below ? y : y + cardH];
  return {
    x: cx,
    y,
    pts: dedupe(viaElbow ? [[ax, ay], [cx + dx, py], edge] : [[ax, ay], edge]),
    side: below ? null : "is-bottom",
    sideVars: below
      ? {}
      : {
          "--sx": `${(dx - Math.min(dx, CW - dx)).toFixed(0)}px`,
          "--sw": `${(2 * Math.min(dx, CW - dx) + 1).toFixed(0)}px`,
        },
  };
}

/**
 * @param {{ ax:number, ay:number, ex:number, ey:number, right:boolean, x:number,
 *   W:number, H:number, CW:number, cardH:number }} o anchor (ax, ay), wanted
 *   elbow (ex, ey), card side, card x for the original 260 px card, stage and
 *   card size, all in stage pixels
 * @returns {{ x:number, y:number, pts:number[][], side:string|null, sideVars:object }}
 */
export function dockGeometry(o) {
  const { ax, right, W, H, CW, cardH } = o;
  const f = frame(W, H, CW, cardH);
  // Callers provide the original 260px-card anchor; preserve its near edge.
  const x = f.fitX(right ? o.x : o.x - (CW - 260));
  if (right ? ax <= x - 16 : ax >= x + CW + 16) return besideDock(o, f, x);
  const ex = clamp(o.ex, 8, W - 8),
    ey = clamp(o.ey, 8, H - 8);
  return stackDock(o, f, ex, ey, true) || stackDock(o, f, ax, o.ay, false);
}
