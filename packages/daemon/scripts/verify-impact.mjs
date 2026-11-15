/**
 * Verifies the impact/spill animation without a browser: the canvas is a
 * recording proxy, so every stroke, arc and alpha becomes inspectable data.
 */
import {
  impactPhase,
  impactProgress,
  drawImpact,
  drawSpill,
  spillEdgesFor,
  spillPhase,
  tailMs,
  IMPACT_LEAD_MS,
  IMPACT_MS,
  SPILL_GAP_MS,
  SPILL_MS,
  IMPACT_SPILL_MAX,
  IMPACT_SPILL_ALPHA,
} from "../webui/js/impact.js";
import { boltRnd, legDurationFor, levelStartOffset, CHAIN_LEG_MS } from "../webui/js/bolt-styles.js";

const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) process.exitCode = 1;
};

// ── recording canvas ────────────────────────────────────────────────────────
function recorder() {
  const calls = [];
  let alpha = 1;
  const ctx = {
    get globalAlpha() {
      return alpha;
    },
    set globalAlpha(v) {
      alpha = v;
    },
    lineWidth: 1,
    strokeStyle: "",
    beginPath: () => calls.push({ op: "beginPath" }),
    arc: (x, y, r) => calls.push({ op: "arc", x, y, r, alpha }),
    stroke: () => calls.push({ op: "stroke", alpha }),
    drawImage: (_s, x, y, w) => calls.push({ op: "drawImage", x, y, w, alpha }),
    moveTo: () => {},
    lineTo: () => {},
  };
  return { ctx, calls };
}
const glowSprite = () => ({ sprite: true });

// ── 1. the post-bolt clock: measured from the bolt's arrival, in fixed ms ────
// legMs is time since the bolt started; legDur is how long the bolt travelled.
// A leg of 420ms and a leg of 4000ms must produce the SAME strike/spill once
// the bolt has arrived — that is the whole rule.
// the strike fires IMPACT_LEAD_MS before the bolt ends — a fixed lead, not the
// bolt's end and not a fraction of its length
const arrival = (legDur) => legDur - IMPACT_LEAD_MS;
ok("nothing strikes before the fixed lead point", impactPhase(arrival(420) - 5, 420) === 0);
ok("the strike is lit at the lead point", impactPhase(arrival(420) + 5, 420) > 0);
ok(
  "the strike fires exactly IMPACT_LEAD_MS before the bolt ends",
  (() => {
    for (const legDur of [300, 420, 1000, 2000, 4000]) {
      let first = null;
      for (let legMs = 0; legMs <= legDur + 100; legMs += 1)
        if (impactPhase(legMs, legDur) > 0) {
          first = legMs;
          break;
        }
      if (Math.abs(legDur - first - IMPACT_LEAD_MS) > 1.5) return false;
    }
    return true;
  })(),
  `${IMPACT_LEAD_MS}ms before the end, every slider`
);
// peak brightness sits inside the fixed strike window, near its front
const strikePeak = [...Array(200).keys()]
  .map((i) => ({ since: (i / 200) * IMPACT_MS, p: impactPhase(arrival(1000) + (i / 200) * IMPACT_MS, 1000) }))
  .reduce((a, b) => (b.p > a.p ? b : a));
ok(
  "strike peaks near 1, early in its window",
  strikePeak.p > 0.9 && strikePeak.since < IMPACT_MS * 0.4,
  `peak ${strikePeak.p.toFixed(2)} at +${Math.round(strikePeak.since)}ms`
);
ok("both fade to nothing eventually", impactPhase(99999, 420) === 0 && spillPhase(99999, 420) === 0);

// ── 1b. cause before consequence ────────────────────────────────────────────
// Strike first, then — after it has PLAYED OUT, not during — the neighbourhood.
const iStart = [...Array(600).keys()].map((k) => k * 5).find((s) => impactPhase(1000 + s, 1000) > 0);
const iEnd = [...Array(600).keys()]
  .map((k) => k * 5)
  .reverse()
  .find((s) => impactPhase(1000 + s, 1000) > 0);
const sStart = [...Array(600).keys()].map((k) => k * 5).find((s) => spillPhase(1000 + s, 1000) > 0);
ok(
  "the follow-up starts after the strike has finished",
  sStart >= iEnd,
  `strike +${iStart}..${iEnd}ms, follow-up from +${sStart}ms`
);
ok(
  "the gap between them matches SPILL_GAP_MS",
  Math.abs(sStart - iEnd - SPILL_GAP_MS) < 20,
  `gap ~${sStart - iEnd}ms vs ${SPILL_GAP_MS}ms`
);

// ── 1c. THE RULE: the slider touches the first bolt and nothing else ─────────
// The strike and the follow-up, measured from arrival, are byte-for-byte the
// same at every slider position. If they weren't, the slider would be changing
// an animation that is not the first bolt — the exact thing Daniel ruled out.
const SLIDER = [300, 420, 700, 1000, 2000, 4000];
const profile = (fn, legDur) =>
  [...Array(400).keys()].map((k) => (fn(legDur + k * 6, legDur) > 0.001 ? 1 : 0)).join("");
const strikeProfiles = SLIDER.map((ms) => profile(impactPhase, ms));
const spillProfiles = SLIDER.map((ms) => profile(spillPhase, ms));
ok(
  "the strike is identical at every slider position (arrival-relative)",
  strikeProfiles.every((p) => p === strikeProfiles[0]),
  `${new Set(strikeProfiles).size} distinct profiles`
);
ok(
  "the follow-up is identical at every slider position (arrival-relative)",
  spillProfiles.every((p) => p === spillProfiles[0]),
  `${new Set(spillProfiles).size} distinct profiles`
);
// the follow-up has to be a comfortable length — it was "zu schnell" before
ok("the follow-up is a calm, perceptible length", SPILL_MS >= 900, `${SPILL_MS}ms`);
// the strike and follow-up each have their own length; neither is derived from
// the other, so their relative order is a free choice, not an invariant.
// the keep-alive tail is a constant with no slider term (the sequence ends
// IMPACT_LEAD_MS earlier because it also starts that much before the bolt end)
ok(
  "tailMs carries the whole fixed sequence and no slider term",
  tailMs() === IMPACT_MS + SPILL_GAP_MS + SPILL_MS - IMPACT_LEAD_MS,
  `${tailMs()}ms`
);

// ── 1d. the slider times level 1 ONLY — everything after is decoupled ───────
// "Die Zeit am Regler ist einzig und allein die Zeit, in der der erste Blitz
// auf erster Linie angezeigt wird. Die Folgeblitze dürfen nicht mit dieser
// Zeit zusammenhängen." So the invariant is not a floor — it is INDEPENDENCE:
// a following level's timing is byte-for-byte the same at 300ms and at 4s.
const S1 = [300, 420, 1000, 2000, 4000];
for (const ms of S1) {
  ok(`level 1 obeys the slider exactly at ${ms}ms`, legDurationFor(1, ms) === ms);
}
const legFollow = S1.map((ms) => legDurationFor(2, ms));
ok(
  "a following level's duration never depends on the slider",
  legFollow.every((v) => v === CHAIN_LEG_MS),
  `[${legFollow.join(", ")}]`
);
ok("all following levels share one fixed duration", legDurationFor(2, 300) === legDurationFor(3, 4000));

// ── 1e. the levels QUEUE: each starts only after the previous strike ────────
// "Nach diesen 2 Sekunden müssen dann die anderen Sachen zünden." Level N+1
// must not overlap level N's strike — it starts once that strike has run out.
for (const ms of S1) {
  ok(`level 1 starts at 0 at ${ms}ms`, levelStartOffset(1, ms) === 0);
  // level 2 begins exactly when level 1's strike ends: (boltMs - LEAD) + IMPACT_MS
  const l1StrikeEnd = ms - IMPACT_LEAD_MS + IMPACT_MS;
  ok(
    `level 2 starts as level 1's strike ends at ${ms}ms`,
    Math.abs(levelStartOffset(2, ms) - l1StrikeEnd) < 1e-9,
    `start ${levelStartOffset(2, ms)}ms vs strike-end ${l1StrikeEnd}ms`
  );
  // level 3 begins after level 2's strike, which is a fixed length (no slider)
  const l2StrikeEnd = levelStartOffset(2, ms) + CHAIN_LEG_MS - IMPACT_LEAD_MS + IMPACT_MS;
  ok(`level 3 starts as level 2's strike ends at ${ms}ms`, Math.abs(levelStartOffset(3, ms) - l2StrikeEnd) < 1e-9);
  // the offset between level 2 and 3 is slider-independent (both are followers)
}
const l23Gap = S1.map((ms) => levelStartOffset(3, ms) - levelStartOffset(2, ms));
ok(
  "the gap between two following levels never depends on the slider",
  l23Gap.every((g) => Math.abs(g - l23Gap[0]) < 1e-9),
  `[${l23Gap.map(Math.round).join(", ")}]`
);

// ── 2. the impact stays under the origin flare ──────────────────────────────
// origin supernova: ring alpha 0.75, halo up to 0.9, ring reach 80px
const { ctx, calls } = recorder();
drawImpact({ ctx, x: 0, y: 0, r: 4, phase: 1, strength: 1, color: "#fff", camScale: 1, glowSprite });
const alphasOf = (cs) => cs.filter((c) => typeof c.alpha === "number").map((c) => c.alpha);
const maxAlpha = Math.max(...alphasOf(calls));
ok("impact never outshines the origin flare", maxAlpha <= 0.65, `max alpha ${maxAlpha.toFixed(2)}`);
const ring = calls.find((c) => c.op === "arc");
ok("impact ring stays well inside the supernova's reach", ring.r < 45, `reach ${ring.r.toFixed(1)}px vs 80px`);

// ── 2b. the ring only ever travels OUTWARD ──────────────────────────────────
// The bug this pins: sizing the ring off `phase` (which rises then falls) makes
// it start wide, collapse inward while the strike brightens, and only then
// expand. Radius must follow progress, which is monotonic.
const LEG = 420;
const radii = [];
for (let i = 0; i <= 40; i++) {
  const legMs = LEG + (IMPACT_MS * i) / 40; // step across the strike window, from arrival
  const r = recorder();
  drawImpact({
    ctx: r.ctx,
    x: 0,
    y: 0,
    r: 4,
    phase: 1 /* forced: isolate geometry */,
    progress: impactProgress(legMs, LEG),
    strength: 1,
    color: "#fff",
    camScale: 1,
    glowSprite,
  });
  const arc = r.calls.find((c) => c.op === "arc");
  if (arc) radii.push(arc.r);
}
const monotonic = radii.every((v, i) => i === 0 || v >= radii[i - 1] - 1e-9);
ok("impact ring never contracts", monotonic, `${radii[0].toFixed(1)}px → ${radii[radii.length - 1].toFixed(1)}px`);
ok("impact ring actually travels", radii[radii.length - 1] > radii[0] * 2);
ok(
  "progress is monotonic across the window",
  [...Array(50).keys()].every((i) => {
    const t0 = LEG + (i / 49) * IMPACT_MS,
      t1 = LEG + ((i + 1) / 49) * IMPACT_MS;
    return impactProgress(t1, LEG) >= impactProgress(t0, LEG);
  })
);

// ── 3. hop falloff carries into the impact ──────────────────────────────────
const at = (strength) => {
  const r = recorder();
  drawImpact({ ctx: r.ctx, x: 0, y: 0, r: 4, phase: 1, strength, color: "#fff", camScale: 1, glowSprite });
  return Math.max(0, ...alphasOf(r.calls));
};
const [a1, a2, a3] = [at(1), at(0.22), at(0.22 ** 2)];
ok("deeper hops strike dimmer", a1 > a2 && a2 > a3, `${a1.toFixed(2)} > ${a2.toFixed(2)} > ${a3.toFixed(2)}`);
ok("third-level impact is nearly gone", a3 < 0.06, `${a3.toFixed(3)}`);
ok("a vanishing impact draws nothing at all", at(0.001) === 0);

// ── 4. spill is faint and finite ────────────────────────────────────────────
const spillCalls = [];
const strokeEdge = (e) => spillCalls.push({ e, alpha: sctx.globalAlpha });
const sRec = recorder();
const sctx = sRec.ctx;
drawSpill({ ctx: sctx, e: { id: "e1" }, phase: 1, strength: 1, color: "#fff", camScale: 1, strokeEdge });
ok(
  "spill peaks at the configured whisper",
  Math.abs(spillCalls[0].alpha - IMPACT_SPILL_ALPHA) < 1e-9,
  `${spillCalls[0].alpha}`
);
ok("spill is far below the impact that causes it", IMPACT_SPILL_ALPHA < maxAlpha / 2.5);
spillCalls.length = 0;
drawSpill({ ctx: sctx, e: { id: "e2" }, phase: 0.01, strength: 0.05, color: "#fff", camScale: 1, strokeEdge });
ok("an invisible spill is skipped, not drawn", spillCalls.length === 0);

// ── 5. selection: deterministic, bounded, never the chain's own strands ─────
const node = (id) => ({ id, ringHidden: false });
const nodes = [...Array(40).keys()].map((i) => node("n" + i));
const hub = node("hub");
const edges = nodes.map((n) => ({ s: hub, t: n }));
const used = new Set([edges[0], edges[1]]);
const seedFor = (id) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 100000;
  return h;
};

const pick1 = spillEdgesFor("hub", edges, used, boltRnd, seedFor("hub"));
const pick2 = spillEdgesFor("hub", edges, used, boltRnd, seedFor("hub"));
ok("same node picks the same strands every flare", JSON.stringify(pick1) === JSON.stringify(pick2));
ok("spill is capped", pick1.length <= IMPACT_SPILL_MAX, `${pick1.length} ≤ ${IMPACT_SPILL_MAX}`);
ok(
  "spill never re-uses a strand the chain is already using",
  pick1.every((e) => !used.has(e))
);
const other = spillEdgesFor("hub", edges, used, boltRnd, seedFor("different-memory"));
ok("a different identity picks a different fan", JSON.stringify(other) !== JSON.stringify(pick1));

// hidden neighbours are skipped
const hidden = edges.map((e, i) => (i % 2 ? { ...e, t: { ...e.t, ringHidden: true } } : e));
const pickH = spillEdgesFor("hub", hidden, new Set(), boltRnd, seedFor("hub"));
ok(
  "drilled-away neighbours are never lit",
  pickH.every((e) => !e.t.ringHidden && !e.s.ringHidden)
);

// a node with no free strands spills nothing
ok("no free strand → no spill", spillEdgesFor("hub", edges, new Set(edges), boltRnd, 1).length === 0);
