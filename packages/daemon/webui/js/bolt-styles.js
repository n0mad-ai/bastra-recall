/** The three ways activity travels a connection (#217).
 *
 *  All three share what the renderer already decided: WHICH strands carry the
 *  discharge (level 1 = every connection the memory has, then a thinning tail)
 *  and HOW STRONG each leg is. They differ only in what is painted on a leg —
 *  and every one of them paints on the strand's own curve, never on the chord
 *  between two nodes.
 *
 *  Split out of renderer.js: the renderer was at 700 lines and three styles
 *  would have pushed it past the point where a small change means reading a
 *  large file (file-size convention).
 */

import { IMPACT_LEAD_MS, IMPACT_MS } from "./impact.js";

export const BOLT_STYLE_KEY = "bastra-vault-map-bolt-style";
export const BOLT_MS_KEY = "bastra-vault-map-bolt-ms";
export const BOLT_MS_DEFAULT = 420;
export const BOLT_MS_MIN = 300;
export const BOLT_MS_MAX = 4000;
export const BOLT_SPREAD_KEY = "bastra-vault-map-bolt-spread";
/** Wie weit der Zacken vom Strang abweicht, 0 = exakt auf der Linie, 1 = wie
 *  bisher. Manche wollen den Blitz sehen, manche nur die Verbindung leuchten
 *  haben — das ist Geschmack, also ein Regler statt einer Konstante. */
export const BOLT_SPREAD_DEFAULT = 1;
export const BOLT_SEGMENTS = 7; // zigzag points per bolt

/** What the duration slider governs, and what it does NOT.
 *
 *  The slider is the time of the FIRST bolt — level 1, the discharge the eye
 *  follows — and nothing else. Everything that fires afterwards (the onward
 *  chain and its impacts) has its own fixed time, in real milliseconds,
 *  completely decoupled from the slider.
 *
 *  This is the third attempt at it, so it is worth being blunt about why the
 *  first two were wrong. Deriving a following level from the slider (`boltMs`
 *  or `max(floor, boltMs)`) couples them back together at one end or the other:
 *  at 300ms the whole chain fires inside a few hundred ms, at 2s the followers
 *  balloon to 2s each. Both are "the followers depend on the slider", which is
 *  exactly what must not happen. A constant is the only shape that does not. */
export const CHAIN_LEG_MS = 680; // a following level's own travel time — fixed

/** How long one leg travels. Level 1 IS the bolt and obeys the slider; every
 *  later level runs for the fixed CHAIN_LEG_MS regardless of the slider. */
export function legDurationFor(hop, boltMs) {
  return hop === 1 ? boltMs : CHAIN_LEG_MS;
}

/** When level `hop` starts, in ms since the flash began.
 *
 *  The whole point (Daniel): each level fires only AFTER the previous level's
 *  strike has fully played out — not gestured at with a fixed hop-delay while
 *  the strike is still running. So level 1 is the bolt (slider-timed), and
 *  every later level waits out the level before it: that level's own travel,
 *  minus the strike's lead, plus the strike's full run. Each animation keeps
 *  its own duration; they simply queue up, so nothing lands on top of anything
 *  else and nothing gets cut off. */
export function levelStartOffset(hop, boltMs) {
  let off = 0;
  for (let h = 1; h < hop; h++) {
    off += legDurationFor(h, boltMs) - IMPACT_LEAD_MS + IMPACT_MS; // through h's strike
  }
  return off;
}

/** Deterministic 0..1 value. */
export function boltRnd(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Point on the edge's own path at t (0 = s, 1 = t), plus the normal there —
 *  the direction a zigzag deflects. `cp` is edgeBend's control point; without
 *  one the edge is a straight line and this degenerates to a lerp. */
export function pathAt(e, cp, t) {
  const { x: x0, y: y0 } = e.s;
  const { x: x1, y: y1 } = e.t;
  let px, py, dx, dy;
  if (cp) {
    const u = 1 - t;
    px = u * u * x0 + 2 * u * t * cp.x + t * t * x1;
    py = u * u * y0 + 2 * u * t * cp.y + t * t * y1;
    dx = 2 * u * (cp.x - x0) + 2 * t * (x1 - cp.x);
    dy = 2 * u * (cp.y - y0) + 2 * t * (y1 - cp.y);
  } else {
    px = x0 + (x1 - x0) * t;
    py = y0 + (y1 - y0) * t;
    dx = x1 - x0;
    dy = y1 - y0;
  }
  const len = Math.hypot(dx, dy) || 1;
  return { x: px, y: py, nx: -dy / len, ny: dx / len };
}

/** Sub-path from `a` to `b` along the strand, as a fresh path (no stroke). */
function tracePath(ctx, e, cp, a, b, steps = 18) {
  ctx.beginPath();
  const from = Math.max(0, Math.min(1, a));
  const to = Math.max(0, Math.min(1, b));
  for (let i = 0; i <= steps; i++) {
    const p = pathAt(e, cp, from + ((to - from) * i) / steps);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
}

/** The rail: the connection itself, lit for as long as something runs on it.
 *  Galaxy and ring views keep ambient strands dark (quietEdges), so without
 *  this the activity would appear to fly through open space — the very thing
 *  it is supposed to trace. */
function drawRail(s, alpha) {
  const { ctx, camScale } = s;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1 / camScale;
  s.strokeEdge(s.e);
}

export const BOLT_STYLES = {
  /** Zigzag along the strand — the original look, kept intact. */
  bolt: {
    label: "bolt",
    draw(s) {
      const { ctx, e, cp, strength, seed, camScale, spread } = s;
      drawRail(s, 0.32 * strength);
      const len = Math.hypot(e.t.x - e.s.x, e.t.y - e.s.y) || 1;
      // `spread` zieht den Zacken zum Strang hin: 1 = wie bisher, 0 = die
      // Entladung läuft exakt auf der Verbindung.
      const amp = Math.min(len * 0.13, 26 / camScale) * (spread ?? 1);
      ctx.globalAlpha = 0.34 * strength;
      ctx.lineWidth = 1.1 / camScale;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(e.s.x, e.s.y);
      for (let i = 1; i < BOLT_SEGMENTS; i++) {
        const p = i / BOLT_SEGMENTS;
        const j = (boltRnd(seed + i * 7.31) - 0.5) * 2 * amp * Math.sin(p * Math.PI);
        const at = pathAt(e, cp, p);
        ctx.lineTo(at.x + at.nx * j, at.y + at.ny * j);
      }
      ctx.lineTo(e.t.x, e.t.y);
      ctx.stroke();
    },
  },

  /** A charge running down the wire: the strand is lit, and a short bright
   *  piece of it travels from the flaring memory to its neighbour. Reads as
   *  direction — you see WHERE the activity goes, not just that it went. */
  pulse: {
    label: "pulse",
    draw(s) {
      const { ctx, e, cp, t, strength, camScale } = s;
      drawRail(s, 0.3 * strength);
      const head = Math.min(1, t * 1.15);
      const tail = 0.26;
      ctx.lineCap = "round";
      for (let i = 0; i < 6; i++) {
        const b = head - (tail * i) / 6;
        if (b <= 0) break;
        ctx.globalAlpha = 0.85 * strength * (1 - i / 6);
        ctx.lineWidth = (2.4 - i * 0.3) / camScale;
        tracePath(ctx, e, cp, head - (tail * (i + 1)) / 6, b, 5);
        ctx.stroke();
      }
      ctx.lineCap = "butt";
    },
  },

  /** The calmest: no separate mark at all. The connection itself is drawn on
   *  from the flaring memory outward and burns down again — nothing exists
   *  that is not already part of the map. */
  trace: {
    label: "trace",
    draw(s) {
      const { ctx, e, cp, t, strength, camScale } = s;
      const grow = Math.min(1, t * 2.2);
      ctx.lineCap = "round";
      ctx.globalAlpha = 0.18 * strength;
      ctx.lineWidth = 5 / camScale;
      tracePath(ctx, e, cp, 0, grow);
      ctx.stroke();
      ctx.globalAlpha = 0.9 * strength;
      ctx.lineWidth = 1.5 / camScale;
      tracePath(ctx, e, cp, 0, grow);
      ctx.stroke();
      ctx.lineCap = "butt";
    },
  },
};

/** Style id from storage, falling back to the original look. "off" is a valid
 *  stored value even though it has no entry here — the renderer resolves an
 *  unknown id to "draw nothing", which is exactly what off means. */
export function storedBoltStyle() {
  try {
    const v = localStorage.getItem(BOLT_STYLE_KEY);
    return v && (BOLT_STYLES[v] || v === "off") ? v : "bolt";
  } catch {
    return "bolt"; // private mode / storage disabled — never break the map over a preference
  }
}

/** Deflection strength from storage, clamped to 0..1. */
export function storedBoltSpread() {
  try {
    // nothing stored yet → the default; Number(null) would read as 0 (no deflection)
    const raw = localStorage.getItem(BOLT_SPREAD_KEY);
    const n = raw === null || raw.trim() === "" ? NaN : Number(raw);
    if (!Number.isFinite(n) || n < 0) return BOLT_SPREAD_DEFAULT;
    return Math.min(1, n);
  } catch {
    return BOLT_SPREAD_DEFAULT;
  }
}

/** Discharge duration from storage, clamped into the slider's own range. */
export function storedBoltMs() {
  try {
    const n = Number(localStorage.getItem(BOLT_MS_KEY));
    if (!Number.isFinite(n) || n <= 0) return BOLT_MS_DEFAULT;
    return Math.min(BOLT_MS_MAX, Math.max(BOLT_MS_MIN, n));
  } catch {
    return BOLT_MS_DEFAULT;
  }
}
