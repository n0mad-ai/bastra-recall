/** Activity bolts (#217) for the canvas renderer: which strands a flaring
 *  node discharges along (chain + spill), and the per-frame drawing of the
 *  live-notice flashes (#216). Split out of renderer.js (#680); the renderer
 *  owns the state and hands it in. */

import { glowSprite } from "./graph-data.js";
import { BOLT_STYLES, boltRnd, levelStartOffset, legDurationFor } from "./bolt-styles.js";
import {
  IMPACT_SPILL_BUDGET,
  impactPhase,
  impactProgress,
  spillPhase,
  tailMs,
  drawImpact,
  drawSpill,
  spillEdgesFor,
} from "./impact.js";

// Activity bolts (#217): a flaring node discharges along its connections.
//
// The bolt travels the STRAND, not the straight line between two nodes: edges
// are drawn as quadratic curves (edgeBend), so a chord-based zigzag ran beside
// the very connection it was meant to trace — on cross-cluster edges by up to
// the full 90px bulge. Same look, right path.
//
// And it does not stop at the first neighbour: the discharge carries on, memory
// to memory to memory. What keeps that from turning into a web is not the hop
// limit alone but the falloff — the first leg is the event, every further leg
// is only the echo of it (0.22 per level: 1 · 0.22 · 0.05).
const BOLT_HOPS = 3; // how far the discharge carries
// Level 1 takes EVERY connection the flaring memory has — that is the event
// itself, and hovering the node shows exactly the same set of strands. Beyond
// it the chain thins out instead of branching: only some neighbours carry on
// (BOLT_SPREAD_CHANCE), and those take a single strand each. Thinning, not
// dimming alone, is what keeps a chain from becoming a web.
const BOLT_FANOUT = [Infinity, 1, 1];
const BOLT_SPREAD_CHANCE = [1, 0.35, 0.2]; // odds a neighbour passes the discharge on
const BOLT_MAX_LEGS = 96; // emergency ceiling — a hub with degree 300 must not eat the frame
const BOLT_HOP_FALLOFF = 0.22; // visibility per level beyond the first
// Duration of one discharge, adjustable from the sidebar. 420ms is the look
// that shipped; zzallirog asked for the option of something far calmer
// ("longer, parallel, rather than a short blast"), hence a slider instead of a
// second hardcoded number.
const BOLT_MS_DEFAULT = 420;
// When each level starts is decided by levelStartOffset (bolt-styles.js): a
// level fires only after the previous level's strike has finished, so there is
// no per-level delay constant here any more.
const BOLT_TICK_MS = 55; // re-rolling the zigzag: below ~40ms it turns to noise
export const FLASH_LIFE_MAX = 20000; // ceiling, so constant access can't flare forever

/** Stable number for a memory id — the seed for everything about a bolt that
 *  must not change between two flares of the same memory. */
function idSeed(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 100000;
  return h;
}

/** The chain of edges an activity bolt travels: breadth-first from the
 *  flaring node, up to BOLT_HOPS levels deep, as [{ e, hop }].
 *
 *  Resolved once when the flare is lit and kept on the flash — the EDGES are
 *  held, so the draw loop re-reads n.x/n.y every frame and the chain follows
 *  moving nodes; only the selection is fixed. A node is entered once
 *  (`seen`), so the discharge spreads outward instead of bouncing back and
 *  forth between two hubs. Per level only BOLT_FANOUT branches per node: on a
 *  hub any selection is arbitrary, and "the first ones" is the cheapest
 *  honest answer. */
export function boltChainOf(sim, id) {
  const legs = [];
  const seen = new Set([id]);
  let frontier = [id];
  for (let hop = 1; hop <= BOLT_HOPS && frontier.length; hop++) {
    const next = [];
    const cap = BOLT_FANOUT[hop - 1] ?? 1;
    const chance = BOLT_SPREAD_CHANCE[hop - 1] ?? 0;
    for (const from of frontier) {
      // Beyond the first level only some neighbours carry on. WHICH ones is
      // derived from the memory's identity, not from the clock: a lit strand
      // claims "these two belong together", and that claim has to hold still.
      // The same memory therefore always draws the same chain — recognisable
      // across flares and across sessions.
      if (chance < 1 && boltRnd(idSeed(from) + hop * 977.3) > chance) continue;
      let taken = 0;
      for (const e of sim.edges) {
        if (taken >= cap || legs.length >= BOLT_MAX_LEGS) break;
        const other = e.s?.id === from ? e.t : e.t?.id === from ? e.s : null;
        if (!other || other.ringHidden || seen.has(other.id)) continue;
        seen.add(other.id);
        // `to` is the END the discharge travels toward — the edge alone does
        // not say which of its two nodes gets struck, and the impact needs
        // exactly that.
        legs.push({ e, hop, to: other.id });
        next.push(other.id);
        taken++;
      }
    }
    frontier = next;
  }
  return legs;
}

/** Which strands glow faintly around each struck node (impact.js).
 *
 *  Resolved once with the chain and kept on the flash, for the same reason
 *  the chain is: the selection must not change between two flares of the
 *  same memory. Only first-level impacts spill — deeper in the chain the
 *  legs are already echoes, and an echo of an echo is noise.
 */
export function spillOf(sim, legs) {
  const used = new Set(legs.map((l) => l.e));
  const byNode = new Map();
  let budget = IMPACT_SPILL_BUDGET;
  for (const leg of legs) {
    if (budget <= 0) break;
    if (leg.hop !== 1) continue;
    const picked = spillEdgesFor(leg.to, sim.edges, used, boltRnd, idSeed(leg.to)).slice(0, budget);
    if (!picked.length) continue;
    for (const e of picked) used.add(e); // never spill the same strand twice
    byNode.set(leg.to, picked);
    budget -= picked.length;
  }
  return byNode;
}

/** One frame of the live-notice flashes — called by the renderer's draw()
 *  after the node layer, inside its camera transform. */
export function drawFlashes(now, { ctx, sim, flashes, camera, theme, boltStyle, boltMs, boltSpread, edgeBend, strokeEdge, drawRadius }) {
  // live-notice flashes (#216): ÜBER der Node-Ebene — in dichten Galaxien
  // würde ein Halo im Painter's-Order sonst von Nachbarn verdeckt. Erst
  // ein expandierender Ring (das bewährte Supernova-Zitat), dann ein
  // pulsierender Halo in der Kind-Farbe, beides mit Screen-px-Floors.
  for (const [id, f] of flashes) {
    const n = sim.byId.get(id);
    if (!n || n.ringHidden) {
      flashes.delete(id);
      continue;
    }
    const chainAge = now - f.boltAt;
    // The cascade — bolt, strike, and the follow-up on the onward strands —
    // runs on its OWN summed clock, not the notice's `life`. Each level fires
    // only after the previous level's strike has played out (levelStartOffset),
    // each animation keeps its own fixed duration, and the whole thing simply
    // takes as long as it takes. NOTHING may be cut off, so the flash lives
    // until BOTH the halo's life has elapsed AND the last level's sequence has
    // finished — never the shorter of the two.
    let cascadeEnd = 0;
    for (let hop = 1; hop <= BOLT_HOPS; hop++) {
      cascadeEnd = Math.max(
        cascadeEnd,
        levelStartOffset(hop, boltMs) + legDurationFor(hop, boltMs) + tailMs(),
      );
    }
    const haloT = (now - f.born) / f.life;
    if (haloT >= 1 && chainAge >= cascadeEnd) {
      flashes.delete(id);
      continue;
    }
    const r = drawRadius(n);
    // Activity bolts FIRST: they run underneath the ring and the halo, so the
    // flaring node stays the hero and the edges merely hint at where the
    // activity radiates.
    const style = BOLT_STYLES[boltStyle] ?? null; // "off" resolves to nothing on purpose
    if (style && chainAge < cascadeEnd && f.links.length) {
      const tick = Math.floor(now / BOLT_TICK_MS);
      ctx.strokeStyle = f.color;
      ctx.lineJoin = "round";
      f.links.forEach((leg, i) => {
        const e = leg.e;
        if (e.s.ringHidden || e.t.ringHidden) return;
        // each level starts a little later, so the discharge visibly runs on
        // instead of every leg lighting up at once
        // The slider times the BOLT; a level that fires afterwards gets its
        // own travel time and starts only once the previous level's strike
        // has finished (levelStartOffset), so the levels queue instead of
        // overlapping.
        const legDur = legDurationFor(leg.hop, boltMs);
        const legMs = chainAge - levelStartOffset(leg.hop, boltMs);
        const t = legMs / legDur;
        if (legMs <= 0 || legMs >= legDur + tailMs()) return;
        // fast in, slow out — activity strikes and then burns down
        const strength = Math.min(t * 6, 1) * (1 - t) * BOLT_HOP_FALLOFF ** (leg.hop - 1);
        // WHICH strands and HOW STRONG is settled here; WHAT is painted on
        // them belongs to the chosen style (bolt-styles.js). Every style
        // draws on the strand's own curve — strokeEdge is handed over so the
        // lit connection is literally the same line the map draws.
        // Only while the bolt is actually travelling: past t=1 the leg is
        // kept alive purely for the tail, and `strength` has gone negative.
        if (t < 1) {
          style.draw({
            ctx,
            e,
            cp: edgeBend(e),
            t,
            strength,
            seed: tick + i * 131,
            camScale: camera.scale,
            spread: boltSpread,
            strokeEdge,
          });
        }

        // …and where it lands. The spill goes first so the struck node's
        // own light sits on top of the strands it lit, not under them.
        const phase = impactPhase(legMs, legDur);
        const sPhase = spillPhase(legMs, legDur); // trails the strike, see impact.js
        if (phase <= 0 && sPhase <= 0) return;
        const hit = sim.byId.get(leg.to);
        if (!hit || hit.ringHidden) return;
        const hop1 = BOLT_HOP_FALLOFF ** (leg.hop - 1);
        for (const se of f.spill.get(leg.to) ?? []) {
          if (se.s.ringHidden || se.t.ringHidden) continue;
          drawSpill({
            ctx,
            e: se,
            phase: sPhase,
            strength: hop1,
            color: f.color,
            camScale: camera.scale,
            strokeEdge,
          });
        }
        ctx.strokeStyle = f.color; // drawSpill/drawImpact reset alpha, not stroke
        drawImpact({
          ctx,
          x: hit.x,
          y: hit.y,
          r: drawRadius(hit),
          phase,
          progress: impactProgress(legMs, legDur),
          strength: hop1,
          color: f.color,
          camScale: camera.scale,
          glowSprite,
        });
      });
    }
    const ringT = Math.min((now - f.born) / 900, 1);
    if (ringT < 1) {
      const ringR = Math.max(r * 2, 10 / camera.scale) + ringT * (80 / camera.scale);
      ctx.globalAlpha = 0.75 * (1 - ringT);
      ctx.lineWidth = 2.2 / camera.scale;
      ctx.strokeStyle = f.color;
      ctx.beginPath();
      ctx.arc(n.x, n.y, ringR, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Halo fades over the notice's own life. If the cascade outlasts it, the
    // halo is simply gone by then while the strands keep animating — the
    // origin glow was never meant to hold for a multi-second sequence.
    if (haloT < 1) {
      const ease = 1 - haloT * haloT;
      const fr = Math.max(r * 4, 36 / camera.scale) * (1 + 0.15 * Math.sin(now / 160));
      ctx.globalAlpha = Math.min(1, 0.9 * ease);
      ctx.drawImage(glowSprite(f.color, theme.label), n.x - fr, n.y - fr, fr * 2, fr * 2);
      ctx.globalAlpha = 1;
    }
  }
}
