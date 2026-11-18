import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const RC = { linked: "#d7e3f4", derived: "#7d92a8" };

async function links() {
  const source = await readFile(new URL("../webui/app/js/views/ring-links.js", import.meta.url), "utf8");
  return runInNewContext(
    source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "") +
      "\n({ nodeTier, linkPath, linkStyle, relCounts, linkedDots, legendSpot, TRACK })",
    { RC, MUT: "#7d92a8", ACC: "", areaCol: () => "", h() {}, s() {}, clear() {}, t: (k: string) => k, Set, Map, Math }
  );
}

type Pt = { x: number; y: number };
/**
 * Points along a path: "M a Q c b" (one quadratic curve) sampled at `n` steps,
 * any other "M … L …" path as its corner points.
 */
const pts = (d: string, n = 200): Pt[] => {
  const v = [...d.matchAll(/-?[\d.]+/g)].map((m) => Number(m[0]));
  if (!/Q/.test(d)) return Array.from({ length: v.length / 2 }, (_, i) => ({ x: v[2 * i], y: v[2 * i + 1] }));
  const [ax, ay, cx, cy, bx, by] = v;
  return Array.from({ length: n + 1 }, (_, i) => {
    const u = i / n,
      a = (1 - u) * (1 - u),
      c = 2 * u * (1 - u),
      b = u * u;
    return { x: a * ax + c * cx + b * bx, y: a * ay + c * cy + b * by };
  });
};
/** Turn (radians, signed) between consecutive steps of a sampled curve. */
const turns = (p: Pt[]): number[] => {
  const out: number[] = [];
  for (let i = 1; i < p.length - 1; i++) {
    let d = Math.atan2(p[i + 1].y - p[i].y, p[i + 1].x - p[i].x) - Math.atan2(p[i].y - p[i - 1].y, p[i].x - p[i - 1].x);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    out.push(d);
  }
  return out;
};
const rad = (p: Pt) => Math.hypot(p.x, p.y);
const polar = (r: number, deg: number): Pt => ({
  x: r * Math.cos((deg * Math.PI) / 180),
  y: r * Math.sin((deg * Math.PI) / 180),
});

test("ring dimming: selected segment soft, other segments dim, no selection unchanged", async () => {
  const { nodeTier } = await links();
  // memory of area "bastra-recall" selected (focus = its area)
  assert.equal(nodeTier("bastra-recall", "bastra-recall", "bastra-recall"), "soft");
  assert.equal(nodeTier("vault", "bastra-recall", "bastra-recall"), "dim");
  // hovering another segment while the card is open: that one is lit, the selected one dims
  assert.equal(nodeTier("vault", "vault", "bastra-recall"), "on");
  assert.equal(nodeTier("bastra-recall", "vault", "bastra-recall"), "dim");
  // area focus without a memory, plain hover and the rest state stay as before
  assert.equal(nodeTier("vault", "vault", null), "on");
  assert.equal(nodeTier("bastra-recall", "vault", null), "dim");
  assert.equal(nodeTier("vault", null, null), "on");
});

test("ring dimming: while links are drawn every segment steps back, the active one less", async () => {
  const { nodeTier } = await links();
  // hovered dot with links: its segment "back", all others "far"
  assert.equal(nodeTier("vault", "vault", null, true), "back");
  assert.equal(nodeTier("bastra-recall", "vault", null, true), "far");
  // selected memory with links: its segment "back" as well
  assert.equal(nodeTier("bastra-recall", "bastra-recall", "bastra-recall", true), "back");
  assert.equal(nodeTier("vault", "bastra-recall", "bastra-recall", true), "far");
  // no links drawn: as before
  assert.equal(nodeTier("bastra-recall", "bastra-recall", "bastra-recall", false), "soft");
});

test("ring links: only targets that are on the ring and shown, each once", async () => {
  const { linkedDots } = await links();
  const dotOf = new Map([
    ["a", { id: "a", x: 0, y: 0 }],
    ["b", { id: "b", x: 1, y: 1 }],
    ["c", { id: "c", x: 2, y: 2 }],
  ]);
  const m = {
    links: [
      { id: "b", rel: "linked" },
      { id: "b", rel: "derived" },
      { id: "c", rel: "derived" },
      { id: "gone", rel: "linked" },
    ],
  };
  const all = linkedDots(m, dotOf, () => true);
  assert.deepEqual(JSON.parse(JSON.stringify(all.map((x: { p: { id: string }; rel: string }) => [x.p.id, x.rel]))), [
    ["b", "linked"],
    ["c", "derived"],
  ]);
  // c outside the time window
  const shown = linkedDots(m, dotOf, (id: string) => id !== "c");
  assert.equal(shown.length, 1);
  assert.equal(shown[0].p.id, "b");
});

test("ring links: path starts on the source and ends on the target", async () => {
  const { linkPath } = await links();
  const a = polar(120, -150),
    b = polar(160, -20);
  const p = pts(linkPath(a, b));
  assert.ok(Math.abs(p[0].x - a.x) < 0.06 && Math.abs(p[0].y - a.y) < 0.06);
  const z = p[p.length - 1];
  assert.ok(Math.abs(z.x - b.x) < 0.06 && Math.abs(z.y - b.y) < 0.06);
});

test("ring links: path stays between the inner track and the outer of both dots", async () => {
  const { linkPath, TRACK } = await links();
  for (const [ra, da, rb, db] of [
    [100, 0, 100, 180],
    [180, 10, 96, 190],
    [140, -170, 150, 170],
    [97, 45, 230, 60],
    [120, 30, 120, 31],
  ]) {
    for (const q of pts(linkPath(polar(ra, da), polar(rb, db)))) {
      assert.ok(rad(q) >= TRACK - 0.1, `inside the track: ${rad(q)}`);
      assert.ok(rad(q) <= Math.max(ra, rb) + 0.1, `outside the ring: ${rad(q)}`);
    }
  }
  // never through the face (r 78)
  assert.ok(TRACK > 78 && TRACK < 90);
});

test("ring links: one smooth curve — no kink, no change of bending direction", async () => {
  const { linkPath } = await links();
  for (const [ra, rb] of [
    [150, 150],
    [110, 180],
    [180, 110],
    [97, 240],
    [240, 97],
  ])
    for (const deg of [5, 10, 20, 30, 45, 60, 90, 120, 150, 175, 180]) {
      const tt = turns(pts(linkPath(polar(ra, 0), polar(rb, deg))));
      const max = Math.max(...tt.map(Math.abs));
      assert.ok(max < (1.5 * Math.PI) / 180, `kink ${((max * 180) / Math.PI).toFixed(2)}° at ${ra}→${rb}, ${deg}°`);
      // turns below 0.05° are the 0.001 rounding of nearly straight steps
      const bent = tt.filter((x) => Math.abs(x) > (0.05 * Math.PI) / 180);
      assert.ok(
        bent.every((x) => Math.sign(x) === Math.sign(bent[0])),
        `bending flips at ${ra}→${rb}, ${deg}°`
      );
    }
});

test("ring links: every curve bends the same way as the ring, farther targets more", async () => {
  const { linkPath } = await links();
  // total turn along the curve, same sign as the ring (counter-clockwise for a positive angle)
  const total = (deg: number) => turns(pts(linkPath(polar(150, 0), polar(150, deg)))).reduce((a, b) => a + b, 0);
  let prev = 0;
  for (const deg of [5, 15, 30, 60, 90, 120, 150, 180]) {
    assert.ok(total(deg) > prev, `at ${deg}°: ${total(deg)} after ${prev}`);
    prev = total(deg);
  }
});

test("ring links: path runs the short way round", async () => {
  const { linkPath } = await links();
  // 170° → -170°: across 180°, not through 0°
  const p = pts(linkPath(polar(130, 170), polar(130, -170)));
  assert.ok(
    p.every((q) => q.x < 0),
    "crosses the left side only"
  );
  // and the angle moves monotonically
  const ang = p.map((q) => {
    const a = Math.atan2(q.y, q.x);
    return a < 0 ? a + 2 * Math.PI : a;
  });
  for (let i = 1; i < ang.length; i++) assert.ok(ang[i] >= ang[i - 1] - 1e-3);
});

test("ring links: near targets get a flat arc, farther ones dip deeper", async () => {
  const { linkPath, TRACK } = await links();
  const minR = (deg: number) => Math.min(...pts(linkPath(polar(150, 0), polar(150, deg))).map(rad));
  // 5° away: stays within 2 % of the dots' radius (no hairpin, no bow)
  assert.ok(minR(5) > 150 - 0.02 * (150 - TRACK) - 0.1, `near: ${minR(5)}`);
  // deeper the farther the target
  assert.ok(minR(30) > minR(90) && minR(90) > minR(170));
  // opposite targets come close to the inner track
  assert.ok(minR(180) < TRACK + 0.1 * (150 - TRACK), `opposite: ${minR(180)}`);
});

test("ring links: style by relation — written solid, derived dashed, lens colours", async () => {
  const { linkStyle } = await links();
  const w = linkStyle("linked", 3),
    d = linkStyle("derived", 3);
  assert.equal(w.stroke, RC.linked);
  assert.equal(d.stroke, RC.derived);
  assert.equal(w.dashed, false);
  assert.equal(d.dashed, true);
  assert.equal(linkStyle("other", 3).stroke, "#7d92a8");
});

test("ring links: opacity stays up for few links and calms down for many", async () => {
  const { linkStyle } = await links();
  const op = (n: number) => linkStyle("linked", n).opacity;
  assert.equal(op(1), op(8));
  assert.ok(op(12) < op(8) && op(25) < op(12));
  // never below 0.6: contrast ≥ 6 on the dark halo
  assert.ok(op(200) >= 0.6);
  // the darker dashed derived links keep 0.85 (contrast 4.7 on the halo)
  assert.equal(linkStyle("derived", 3).opacity, 0.85);
  assert.equal(linkStyle("derived", 25).opacity, 0.85);
});

test("ring links: legend counts per relation in RC order, only those present", async () => {
  const { relCounts } = await links();
  const rows = (ends: { rel: string }[]) => JSON.parse(JSON.stringify(relCounts(ends)));
  assert.deepEqual(rows([{ rel: "derived" }, { rel: "linked" }, { rel: "derived" }]), [
    ["linked", 1],
    ["derived", 2],
  ]);
  assert.deepEqual(rows([{ rel: "derived" }]), [["derived", 1]]);
  assert.deepEqual(rows([]), []);
});

test("ring links: legend sits bottom left and dodges the card", async () => {
  const { legendSpot } = await links();
  const L = { w: 220, h: 40 };
  // no card, or a card elsewhere: bottom left
  assert.equal(legendSpot(null, 1340, 760, L), "");
  assert.equal(legendSpot({ x: 1000, y: 10, w: 350, h: 300 }, 1340, 760, L), "");
  // card low on the left: top left
  assert.equal(legendSpot({ x: 0, y: 420, w: 350, h: 320 }, 1340, 760, L), "is-top");
  // card reaching both left corners: top right
  assert.equal(legendSpot({ x: 0, y: 0, w: 350, h: 760 }, 1340, 760, L), "is-top is-right");
});

test("ring ghosts: unwritten memories carry the memories that link to them, apart from the written ones", async () => {
  const source = await readFile(new URL("../webui/app/js/views/vault-data.js", import.meta.url), "utf8");
  const graph = {
    nodes: [
      { id: "a", cluster: "x", kind: "memory", title: "A" },
      { id: "b", cluster: "y", kind: "memory", title: "B" },
      { id: "g", cluster: "x", kind: "ghost", title: "g-slug", reach: { loaded: 4 } },
    ],
    edges: [
      { source: "a", target: "g", via: "related" },
      { source: "b", target: "g", via: "related_via" },
      { source: "a", target: "b", via: "related" },
    ],
  };
  const { vault } = runInNewContext(
    source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "") + "\n({ vault })",
    { data: { graph, clusters: [] }, state: {}, range: () => null, Map, Set, Date, Number, Math }
  );
  const v = vault();
  const g = v.ghostOf.get("g");
  assert.equal(g.kind, "ghost");
  assert.equal(g.title, "g-slug");
  assert.equal(g.recalled, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(g.links)), [
    { id: "a", rel: "linked" },
    { id: "b", rel: "derived" },
  ]);
  // not a written memory: not in byId, not counted, not among a's links
  assert.equal(v.byId.has("g"), false);
  assert.equal(v.total, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(v.byId.get("a").links)), [{ id: "b", rel: "linked" }]);
});

test("ring ghosts: each unwritten memory is a ring dot on the orbit (hit test, card, links)", async () => {
  const source = await readFile(new URL("../webui/app/js/views/ring-layout.js", import.meta.url), "utf8");
  const { buildRing } = runInNewContext(
    source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "") + "\n({ buildRing })",
    {
      hash: () => 0.5,
      // label widths: 6 units per character
      document: {
        createElement: () => ({ getContext: () => ({ measureText: (s: string) => ({ width: 6 * s.length }) }) }),
      },
      Map,
      Set,
      Math,
      Array,
      Number,
    }
  );
  const mems = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, area: i < 12 ? "x" : "y" }));
  const ring = buildRing(
    {
      areas: [
        { key: "x", count: 12, meta: false },
        { key: "y", count: 8, meta: false },
      ],
      mems,
      ghosts: [
        { id: "g1", area: "x" },
        { id: "g2", area: "y" },
      ],
      total: 20,
    },
    (n: number) => `${n} small`
  );
  for (const id of ["g1", "g2"]) {
    const p = ring.dotOf.get(id);
    assert.ok(p && p.ghost && p.r > 0, id);
    assert.ok(Math.abs(Math.hypot(p.x, p.y) - ring.orbit) < 1e-6);
  }
  assert.equal(ring.dotOf.get("g2").k, "y");
  assert.equal(ring.dotOf.size, 22);
});
