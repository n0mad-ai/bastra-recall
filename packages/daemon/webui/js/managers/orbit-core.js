/** The galactic core — swappable centre graphic for the galactic modes.
 *
 *  Only `galaxy` and `galaxy-lab` have a centre to draw: the two universe modes
 *  have no single core, so the switcher stays hidden there.
 *
 *  Every entry apart from `classic` is ported from the animation lab
 *  (mindspace-lab-center-anims.js), where these were designed and picked. The
 *  port is verbatim — same motion, same timing, same colours — because a core
 *  that ships has to look like the one that was chosen. `classic` is the
 *  shipped black hole moved here unchanged.
 *
 *  Contract for a core renderer:
 *      draw(ctx, o, glowSprite)
 *        o = { x, y, r, t, camScale, theme, fade, depth, anchors }
 *        x, y      screen position of the centre (already projected)
 *        r         core radius in world units, depth-scaled
 *        t         seconds, for animation
 *        camScale  camera scale — divide by it for screen-constant sizes
 *        theme     active theme (accent, label, labelHalo, flowBlend)
 *        fade      entry-flight fade (0…1)
 *        depth     depth fade (0…1), SEPARATE from `fade`: the shipped core
 *                  applies it to its outer glow only, so the centre does not
 *                  dim when it sits on the far side
 *        anchors   [{x, y}] — the user's memories, in the same coordinates.
 *                  `gravity` hangs its web on these; everyone else ignores them.
 *
 *  Three deliberate departures from the lab, all forced by the map:
 *    · glow() draws from the pre-rendered sprite cache instead of building a
 *      radial gradient per call (canvas playbook — per-frame gradients were the
 *      original frame-budget hotspot)
 *    · line widths divide by camScale, so they stay screen-constant when zoomed
 *    · the lab's hardcoded "#070b14" becomes theme.labelHalo, the map's
 *      background ink — identical on the dark theme, correct on the light one
 *
 *  Sizes are LAB units scaled by S = r / 20, because the lab's classic core uses
 *  r0 = 20 where the map passes `r`. That keeps every proportion as designed.
 */

import { rnd } from "./orbit-galaxy.js";

const TAU = Math.PI * 2;

// ── lab primitives ─────────────────────────────────────────────────────────

/** Soft radial light. Sprite-backed; the lab built a gradient per call. */
function glow(ctx, glowSprite, x, y, r, color, a, blend) {
  if (r <= 0 || a <= 0) return;
  ctx.globalCompositeOperation = blend;
  ctx.globalAlpha = Math.max(0, Math.min(1, a));
  ctx.drawImage(glowSprite(color), x - r, y - r, r * 2, r * 2);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

function ring(ctx, x, y, r, color, lw, a, camScale, blend) {
  if (r <= 0 || a <= 0 || lw <= 0) return;
  ctx.globalCompositeOperation = blend;
  ctx.globalAlpha = Math.max(0, Math.min(1, a));
  ctx.strokeStyle = color;
  ctx.lineWidth = lw / camScale;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.stroke();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

function solid(ctx, x, y, r, color, a = 1) {
  if (r <= 0) return;
  ctx.globalAlpha = Math.max(0, Math.min(1, a));
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** Jets spin unevenly: a steady sweep with two wobbles laid over it. */
const beamSpin = (t, base = 3.2) => t * base + 0.4 * Math.sin(t * 3.1) + 0.2 * Math.sin(t * 6.7);
/** ...and flicker, fast shimmer modulated by a slower swell. */
const beamFlick = (t, o = 0) => 0.3 + 0.45 * (0.5 + 0.5 * Math.sin(t * 9.3 + o)) * (0.6 + 0.4 * Math.sin(t * 2.7 + o));

/** A beam: a wedge widening away from the core, fading along its length. */
function lobe(ctx, cx, cy, ang, len, wid, color, a, blend) {
  ctx.save();
  ctx.globalCompositeOperation = blend;
  ctx.translate(cx, cy);
  ctx.rotate(ang);
  const g = ctx.createLinearGradient(0, 0, len, 0);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.globalAlpha = Math.max(0, Math.min(1, a));
  ctx.beginPath();
  ctx.moveTo(0, -wid * 0.4);
  ctx.lineTo(0, wid * 0.4);
  ctx.lineTo(len, wid * 0.9);
  ctx.lineTo(len, -wid * 0.9);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Breathing halo + solid centre — the "bright core" signature. */
function heart(ctx, glowSprite, o, coreColor, r, glowR, amp, ca = 0.9) {
  const { x, y, t, theme, fade, depth } = o;
  glow(ctx, glowSprite, x, y, glowR + amp * Math.sin(t * 3), coreColor, ca * fade * depth, theme.flowBlend);
  solid(ctx, x, y, r, coreColor, fade);
}

/** Dark core + bright event-horizon rim — the black-hole signature. */
function horizon(ctx, glowSprite, o, r0, color, rimA = 0.85) {
  const { x, y, t, camScale, theme, fade, depth } = o;
  const spin = 1 + 0.05 * Math.sin(t * 1.7);
  glow(ctx, glowSprite, x, y, r0 * 2.2 * spin, color, 0.4 * fade * depth, theme.flowBlend);
  solid(ctx, x, y, r0 * 0.6, theme.labelHalo, 0.95 * fade);
  ring(ctx, x, y, r0 * 0.6 * spin, color, 1.8, rimA * fade, camScale, theme.flowBlend);
}

/** Deterministic star field for the cores that carry one. The lab seeded these
 *  with Math.random at spawn; here they have to survive rebuilds unchanged, so
 *  they come from the shared index hash instead and are computed once. */
const fields = new Map();
function starField(key, n, rMin, rMax) {
  let f = fields.get(key);
  if (!f) {
    f = Array.from({ length: n }, (_, i) => ({
      a: rnd(i, 941) * TAU,
      r: rMin + rnd(i, 947) * (rMax - rMin),
      sz: 1 + rnd(i, 953),
    }));
    fields.set(key, f);
  }
  return f;
}

// ── the cores ──────────────────────────────────────────────────────────────

/** The shipped black hole. Must stay pixel-identical. */
function classic(ctx, o, glowSprite) {
  const { x, y, r, t, camScale, theme, fade, depth } = o;
  const spinPulse = 1 + 0.05 * Math.sin(t * 1.7);
  // NOT the shared glow() helper: the shipped core's halo uses the two-colour
  // sprite (accent ring, lit centre). Swapping in the single-colour one would
  // change how it looks, and this one has to stay pixel-identical.
  ctx.globalCompositeOperation = theme.flowBlend;
  ctx.globalAlpha = 0.5 * fade * depth;
  const gr = r * 2.4 * spinPulse;
  ctx.drawImage(glowSprite(theme.accent, theme.label), x - gr, y - gr, gr * 2, gr * 2);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = Math.min(1, 0.94 * fade);
  ctx.fillStyle = theme.labelHalo;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.6, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 0.85 * fade;
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1.6 / camScale;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.6 * spinPulse, 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = 0.22 * fade;
  ctx.lineWidth = 0.8 / camScale;
  for (const m of [0.95, 1.35]) {
    ctx.beginPath();
    ctx.arc(x, y, r * m, 0, TAU);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Polar jets — two plasma beams along the rotation axis. */
function jets(ctx, o, glowSprite) {
  const { x, y, r, fade, depth, theme } = o;
  const S = r / 20;
  const COLOR = "#a99cff";
  const s = beamSpin(o.t);
  const fl = beamFlick(o.t) * fade * depth;
  lobe(ctx, x, y, s, 40 * S, 9 * S, COLOR, fl, theme.flowBlend);
  lobe(ctx, x, y, s + Math.PI, 40 * S, 9 * S, COLOR, fl, theme.flowBlend);
  horizon(ctx, glowSprite, o, 14 * S, COLOR);
}

/** Two holes orbiting their common centre of mass. */
function twin(ctx, o, glowSprite) {
  const { x, y, r, t, camScale, theme, fade, depth } = o;
  const S = r / 20;
  const COLOR = "#7fb4ff";
  const a = t * 1.2;
  const R = 12 * S;
  for (const s of [0, Math.PI]) {
    const px = x + Math.cos(a + s) * R;
    const py = y + Math.sin(a + s) * R * 0.5;
    glow(ctx, glowSprite, px, py, 9 * S, COLOR, 0.5 * fade * depth, theme.flowBlend);
    solid(ctx, px, py, 4.5 * S, theme.labelHalo, 0.95 * fade);
    ring(ctx, px, py, 4.8 * S, COLOR, 1.2, 0.8 * fade, camScale, theme.flowBlend);
  }
}

/** Streams of matter falling in — a hole that is actively feeding. */
function hungry(ctx, o, glowSprite) {
  const { x, y, r, t, camScale, theme, fade, depth } = o;
  const S = r / 20;
  const COLOR = "#ff9a6a";
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + t * 0.6;
    const fx = x + Math.cos(a) * 40 * S;
    const fy = y + Math.sin(a) * 40 * S;
    const g = ctx.createLinearGradient(fx, fy, x, y);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, COLOR);
    ctx.save();
    ctx.globalCompositeOperation = theme.flowBlend;
    ctx.strokeStyle = g;
    ctx.globalAlpha = 0.5 * fade * depth;
    ctx.lineWidth = 2 / camScale;
    ctx.beginPath();
    ctx.moveTo(fx, y + Math.sin(a) * 40 * S * 0.5);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();
  }
  horizon(ctx, glowSprite, o, 14 * S, COLOR);
}

/** A star collapsing into a hole and back — bright, then dark. */
function newborn(ctx, o, glowSprite) {
  const { x, y, r, t, camScale, theme, fade, depth } = o;
  const S = r / 20;
  const COLOR = "#38d9f5";
  const CORE = "#e6ffff";
  const ph = Math.sin(t * 0.7) * 0.5 + 0.5; // 0 bright → 1 dark
  glow(ctx, glowSprite, x, y, (16 + (1 - ph) * 12) * S, CORE, (0.6 * (1 - ph) + 0.2) * fade * depth, theme.flowBlend);
  solid(ctx, x, y, (6 + ph * 8) * S, theme.labelHalo, 0.9 * ph * fade);
  ring(ctx, x, y, (6 + ph * 12) * S, COLOR, 1.6, (0.4 + 0.4 * ph) * fade, camScale, theme.flowBlend);
}

/** A pulsar with a sharp double beat. */
function doublePulse(ctx, o, glowSprite) {
  const { x, y, r, t, camScale, theme, fade, depth } = o;
  const S = r / 20;
  const COLOR = "#8fd0ff";
  const CORE = "#eaf6ff";
  const b = Math.pow(Math.max(0, Math.sin(t * 3)), 6);
  glow(ctx, glowSprite, x, y, (11 + b * 12) * S, CORE, (0.7 + 0.3 * b) * fade * depth, theme.flowBlend);
  ring(ctx, x, y, (10 + b * 16) * S, COLOR, 1.4 * (1 - b), 0.5 * (1 - b) * fade, camScale, theme.flowBlend);
  solid(ctx, x, y, 5 * S, CORE, fade);
}

/** A slow heartbeat sending shockwave rings outward. */
function pulseHeart(ctx, o, glowSprite) {
  const { x, y, r, t, camScale, theme, fade, depth } = o;
  const S = r / 20;
  const COLOR = "#ff7a9c";
  const CORE = "#ffe0ea";
  const beat = Math.pow(Math.max(0, Math.sin(t * 2.2)), 8);
  const ph = ((t * 2.2) / Math.PI) % 2;
  if (ph < 1) ring(ctx, x, y, ph * 44 * S, COLOR, 2 * (1 - ph), 0.6 * (1 - ph) * fade, camScale, theme.flowBlend);
  glow(ctx, glowSprite, x, y, (10 + beat * 16) * S, CORE, (0.7 + 0.3 * beat) * fade * depth, theme.flowBlend);
  solid(ctx, x, y, (4 + beat * 2) * S, CORE, fade);
}

/** Quasar: jets plus a whirling inner star field.
 *
 *  Two changes against the lab version, both requested: it spins FASTER (beam
 *  base 3.2 → 5.6, orbit rate 1.1 → 2.6), and the inner stars are drawn with a
 *  screen-px floor so they survive at map zoom — at lab sizes (1-2 px in world
 *  units) they vanished entirely once zoomed out, which is why the middle
 *  looked empty. */
function quasar(ctx, o, glowSprite) {
  const { x, y, r, t, camScale, theme, fade, depth } = o;
  const S = r / 20;
  const COLOR = "#b98cff";
  const CORE = "#f2e8ff";
  const s = beamSpin(t, 5.6);
  const fl = beamFlick(t) * fade * depth;
  lobe(ctx, x, y, s - Math.PI / 2, 42 * S, 12 * S, COLOR, fl, theme.flowBlend);
  lobe(ctx, x, y, s + Math.PI / 2, 42 * S, 12 * S, COLOR, fl, theme.flowBlend);
  for (const q of starField("quasar", 30, 8, 30)) {
    const aa = q.a + t * (2.6 - q.r * 0.045);
    const sr = Math.max(q.sz * S, 1.6 / camScale); // screen floor — see note
    glow(
      ctx,
      glowSprite,
      x + Math.cos(aa) * q.r * S,
      y + Math.sin(aa) * q.r * 0.4 * S,
      sr,
      CORE,
      0.6 * fade * depth,
      theme.flowBlend
    );
  }
  heart(ctx, glowSprite, o, CORE, 4 * S, 11 * S, 1 * S);
}

/** Gravity web: threads from the core out to what it holds.
 *
 *  In the lab those threads ran to eight decorative orbit dots. Here they hang
 *  on the REAL user memories (`o.anchors`) — the ring around the core is the
 *  user's own memories, so the web shows what the centre actually binds instead
 *  of drawing invented points next to them. Without that the web and the ring
 *  would be two unrelated things sitting on top of each other. */
function gravity(ctx, o, glowSprite) {
  const { x, y, r, camScale, theme, fade, depth, anchors } = o;
  const S = r / 20;
  const COLOR = "#8fe6ff";
  const CORE = "#eaffff";
  if (anchors?.length) {
    ctx.save();
    ctx.globalCompositeOperation = theme.flowBlend;
    ctx.globalAlpha = 0.14 * fade * depth;
    ctx.strokeStyle = COLOR;
    ctx.lineWidth = 0.6 / camScale;
    ctx.beginPath();
    for (const a of anchors) {
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
      ctx.moveTo(x, y);
      ctx.lineTo(a.x, a.y);
    }
    ctx.stroke();
    ctx.restore();
  }
  heart(ctx, glowSprite, o, CORE, 5 * S, 12 * S, 2 * S);
}

/** key → { name, draw }. The select is built from this, so adding a core is
 *  one entry here and nothing else. */
export const CORES = {
  classic: { name: "Black Hole", draw: classic },
  jets: { name: "Polar Jets", draw: jets },
  twin: { name: "Binary Hole", draw: twin },
  hungry: { name: "Feeding", draw: hungry },
  newborn: { name: "Collapse", draw: newborn },
  doublePulse: { name: "Double Pulse", draw: doublePulse },
  pulseHeart: { name: "Heartbeat", draw: pulseHeart },
  quasar: { name: "Quasar", draw: quasar },
  // reshapes the user's memories into their own ellipses — see NEEDS_RELAYOUT
  gravity: { name: "Gravity Web", draw: gravity },
};

/** Cores that change the LAYOUT, not just the drawing. Switching to or from one
 *  of these has to rebuild: the gravity web puts the user's memories on
 *  individual ellipses instead of the shared ring. */
export const NEEDS_RELAYOUT = new Set(["gravity"]);

export const CORE_KEY = "bastra-vault-map-mindspace-core";
export const DEFAULT_CORE = "classic";

export const coreOf = (key) => CORES[key] ?? CORES[DEFAULT_CORE];
