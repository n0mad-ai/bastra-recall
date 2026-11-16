import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

async function geometry() {
  const source = await readFile(new URL("../webui/v22/js/views/dock-geometry.js", import.meta.url), "utf8");
  const m = runInNewContext(source.replace(/^export /gm, "") + "\n({ dockGeometry })", { Math });
  // plain objects of this realm, so deepEqual compares values only
  return { dockGeometry: (o: object) => JSON.parse(JSON.stringify(m.dockGeometry(o))) };
}

type Pt = number[];
type Box = { x: number; y: number; w: number; h: number };

// Does segment a→b pass through the open interior of the box (Liang–Barsky)?
function entersBox(a: Pt, b: Pt, r: Box) {
  const eps = 0.5;
  const x0 = r.x + eps,
    x1 = r.x + r.w - eps,
    y0 = r.y + eps,
    y1 = r.y + r.h - eps;
  let t0 = 0,
    t1 = 1;
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  for (const [p, q] of [
    [-dx, a[0] - x0],
    [dx, x1 - a[0]],
    [-dy, a[1] - y0],
    [dy, y1 - a[1]],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const u = q / p;
    if (p < 0) t0 = Math.max(t0, u);
    else t1 = Math.min(t1, u);
    if (t0 > t1) return false;
  }
  return true;
}
const onEdge = (p: Pt, r: Box) => {
  const inX = p[0] >= r.x - 0.5 && p[0] <= r.x + r.w + 0.5,
    inY = p[1] >= r.y - 0.5 && p[1] <= r.y + r.h + 0.5;
  const atX = Math.abs(p[0] - r.x) < 0.5 || Math.abs(p[0] - r.x - r.w) < 0.5,
    atY = Math.abs(p[1] - r.y) < 0.5 || Math.abs(p[1] - r.y - r.h) < 0.5;
  return (atX && inY) || (atY && inX);
};

// The arm must run from the anchor to one point on the card's border without
// passing underneath the card and without any segment along or past it.
function assertCleanArm(
  g: { x: number; y: number; pts: Pt[] },
  o: { ax: number; ay: number; CW: number; cardH: number }
) {
  const box = { x: g.x, y: g.y, w: o.CW, h: o.cardH };
  assert.deepEqual(g.pts[0], [o.ax, o.ay], "arm starts at the anchor");
  const last = g.pts[g.pts.length - 1];
  assert.ok(onEdge(last, box), `arm ends on the card border, got ${last} for ${JSON.stringify(box)}`);
  for (let i = 1; i < g.pts.length; i++)
    assert.ok(
      !entersBox(g.pts[i - 1], g.pts[i], box),
      `segment ${i} runs under the card: ${g.pts[i - 1]} → ${g.pts[i]}`
    );
  // every point before the docking point stays outside the card and its border
  for (const p of g.pts.slice(0, -1)) assert.ok(!onEdge(p, box), `point ${p} lies on the card border before docking`);
}

const base = { W: 1400, H: 800, CW: 350, cardH: 300 };

test("dock: zoomed-in ring, elbow far off-stage up-right → arm docks cleanly on the card's left edge", async () => {
  const { dockGeometry } = await geometry();
  // Daniel's case: dot glided to the stage centre at 240 %, ring edge (elbow)
  // far outside the stage, card clamped to the right (Math.min(…, W - 260)).
  const o = { ...base, ax: 700, ay: 400, ex: 1900, ey: -300, right: true, x: 1140 };
  const g = dockGeometry(o);
  assertCleanArm(g, o);
  assert.equal(g.side, "is-left");
  assert.equal(g.pts[g.pts.length - 1][0], g.x, "docks on the left edge");
});

test("dock: zoom levels 100–400 % with the card open never run the arm under the card", async () => {
  const { dockGeometry } = await geometry();
  // Ring with extent 400 at a 1400×800 stage, dot at radius 250 / angle −35°,
  // dot glided to the centre (pan = −dot·k), elbow on R + 26 = 356.
  const W = 1400,
    H = 800,
    a = (-35 * Math.PI) / 180;
  for (const z of [1, 1.4, 1.96, 2.4, 2.744, 4]) {
    const k = (Math.min(W, H) / 800) * z,
      dx = Math.cos(a) * 250,
      dy = Math.sin(a) * 250,
      px = z === 1 ? 0 : -dx * k,
      py = z === 1 ? 0 : -dy * k;
    const scr = (x: number, y: number) => [W / 2 + px + x * k, H / 2 + py + y * k];
    const [ax, ay] = scr(dx, dy),
      [ex, ey] = scr(Math.cos(a) * 356, Math.sin(a) * 356);
    const cx = W / 2 + px;
    for (const cardH of [180, 300, 520]) {
      const o = { W, H, CW: 350, cardH, ax, ay, ex, ey, right: true, x: Math.min(cx + 400 * k + 20, W - 260) };
      assertCleanArm(dockGeometry(o), o);
    }
  }
});

test("dock: card on the left, elbow off-stage down-left", async () => {
  const { dockGeometry } = await geometry();
  const o = { ...base, ax: 700, ay: 400, ex: -500, ey: 1400, right: false, x: 0 };
  const g = dockGeometry(o);
  assertCleanArm(g, o);
  assert.equal(g.side, "is-right");
  assert.equal(g.pts[g.pts.length - 1][0], g.x + o.CW, "docks on the right edge");
});

test("dock: anchor under the card's column → card above/below, arm docks on its horizontal edge", async () => {
  const { dockGeometry } = await geometry();
  // narrow stage: the card cannot sit beside the anchor
  for (const [ax, ay, ex, ey] of [
    [420, 500, 900, -200],
    [420, 150, 600, 40],
    [300, 600, 520, 760],
  ]) {
    const o = { W: 600, H: 800, CW: 350, cardH: 260, ax, ay, ex, ey, right: true, x: 340 };
    assertCleanArm(dockGeometry(o), o);
  }
});

test("dock: sweep over anchors, off-stage elbows and both sides keeps every arm clean", async () => {
  const { dockGeometry } = await geometry();
  const W = 1200,
    H = 760;
  const steps = (from: number, to: number, by: number) =>
    Array.from({ length: Math.ceil((to - from) / by) }, (_, i) => from + i * by);
  const cases = steps(20, W, 70).flatMap((ax) =>
    steps(20, H, 60).flatMap((ay) =>
      [-900, 10, 400, 900, 1190, 2600].flatMap((ex) =>
        [-700, 10, 380, 750, 1800].flatMap((ey) =>
          [true, false].map((right) => ({ W, H, CW: 350, cardH: 280, ax, ay, ex, ey, right, x: right ? W - 260 : 0 }))
        )
      )
    )
  );
  // the stage must have room for the card next to, above or below the anchor
  const roomy = cases.filter((o) => o.ay - 24 - 280 >= 0 || o.ay + 24 + 280 <= H - 42);
  for (const o of roomy) assertCleanArm(dockGeometry(o), o);
  assert.ok(roomy.length > 3000);
});

test("dock: prototype case at fit zoom keeps elbow and side docking unchanged", async () => {
  const { dockGeometry } = await geometry();
  const o = { ...base, ax: 820, ay: 260, ex: 900, ey: 200, right: true, x: 1000 };
  const g = dockGeometry(o);
  assert.deepEqual(g.pts, [
    [820, 260],
    [900, 200],
    [1000, 200],
  ]);
  assert.equal(g.x, 1000);
  assert.equal(g.y, 172);
  assert.equal(g.side, "is-left");
  assert.equal(g.sideVars["--sh"], "57px");
});
