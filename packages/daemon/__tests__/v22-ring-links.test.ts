import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const RC = { linked: "#d7e3f4", derived: "#7d92a8" };

async function links() {
  const source = await readFile(new URL("../webui/v22/js/views/ring-links.js", import.meta.url), "utf8");
  return runInNewContext(
    source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "") +
      "\n({ nodeTier, linkPath, linkStyle, relCounts, linkedDots, legendSpot, TRACK })",
    { RC, MUT: "#7d92a8", ACC: "", areaCol: () => "", h() {}, s() {}, clear() {}, t: (k: string) => k, Set, Map, Math }
  );
}

type Pt = { x: number; y: number };
/** Points of an "M x y L x y …" path. */
const pts = (d: string): Pt[] =>
  [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
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
  assert.ok(op(200) >= 0.45);
  // the darker dashed derived links keep more
  assert.ok(linkStyle("derived", 25).opacity > op(25));
  assert.ok(linkStyle("derived", 25).opacity <= linkStyle("derived", 3).opacity);
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
