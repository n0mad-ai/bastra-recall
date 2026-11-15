/**
 * End-to-end check of the impact wiring, by DIFFERENCE.
 *
 * Two renderers over the same graph and the same clock; one gets a flash, the
 * other stays quiet. Everything the flashing one draws beyond the quiet one is,
 * by construction, the discharge — no guessing which arc is a node and which is
 * a ring. That mattered: a first attempt keyed on radius and happily "passed"
 * while measuring node circles.
 */
const REPO = new URL("../webui/js", import.meta.url).href;

let clock = 1000;
globalThis.performance = { now: () => clock };
globalThis.localStorage = {
  _d: new Map(),
  getItem(k) {
    return this._d.has(k) ? this._d.get(k) : null;
  },
  setItem(k, v) {
    this._d.set(k, String(v));
  },
};
globalThis.devicePixelRatio = 1;

let sink = [];
function makeCtx() {
  let alpha = 1;
  const rec = (op, extra = {}) => sink.push({ op, alpha, ...extra });
  return {
    canvas: { width: 1200, height: 800 },
    get globalAlpha() {
      return alpha;
    },
    set globalAlpha(v) {
      alpha = v;
    },
    lineWidth: 1,
    strokeStyle: "",
    fillStyle: "",
    font: "",
    textAlign: "",
    lineJoin: "",
    lineCap: "",
    globalCompositeOperation: "",
    save() {},
    restore() {},
    translate() {},
    scale() {},
    setLineDash() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    bezierCurveTo() {},
    arc(x, y, r) {
      rec("arc", { x, y, r });
    },
    stroke() {
      rec("stroke");
    },
    fill() {},
    fillRect() {},
    clearRect() {},
    strokeRect() {},
    fillText() {},
    strokeText() {},
    measureText: () => ({ width: 10 }),
    drawImage(_s, x, y, w) {
      rec("drawImage", { x, y, w });
    },
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
}
const canvasEl = {
  width: 1200,
  height: 800,
  clientWidth: 1200,
  clientHeight: 800,
  style: {},
  getContext: () => makeCtx(),
  getBoundingClientRect: () => ({ width: 1200, height: 800, left: 0, top: 0 }),
  addEventListener() {},
};
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => makeCtx(), style: {} }),
  documentElement: { classList: { contains: () => false }, style: {}, dataset: {} },
  body: { classList: { contains: () => false } },
  addEventListener() {},
  querySelector: () => null,
};
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "#888888" });

const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) process.exitCode = 1;
};

const { createRenderer } = await import(`${REPO}/renderer.js`);

function buildSim() {
  const nodes = [];
  const mk = (id, x, y) => {
    const n = { id, x, y, idx: nodes.length, cluster: "c", kind: "memory", label: id };
    nodes.push(n);
    return n;
  };
  const hub = mk("hub", 0, 0);
  const ring1 = [...Array(6).keys()].map((i) => mk(`n${i}`, Math.cos(i) * 300, Math.sin(i) * 300));
  const ring2 = ring1.flatMap((p, i) =>
    [...Array(3).keys()].map((j) => mk(`f${i}_${j}`, p.x + 60 + j * 40, p.y + 60 + j * 40))
  );
  const edges = [
    ...ring1.map((n) => ({ s: hub, t: n })),
    ...ring2.map((n, k) => ({ s: ring1[Math.floor(k / 3)], t: n })),
  ];
  return {
    sim: { nodes, edges, byId: new Map(nodes.map((n) => [n.id, n])), centers: new Map(), alpha: 0 },
    hub,
    ring1,
    ring2,
  };
}

const hues = new Map([["c", 200]]);
const A = buildSim(); // flashes
const B = buildSim(); // stays quiet — the control
const rA = createRenderer(canvasEl, A.sim, hues);
const rB = createRenderer(canvasEl, B.sim, hues);

// draw() takes the clock as an argument — calling it bare makes every
// time-dependent branch NaN and silently draws nothing.
const capture = (r) => {
  sink = [];
  r.draw(clock);
  return sink;
};
const near = (o, n) => o.x !== undefined && Math.hypot(o.x - n.x, o.y - n.y) < 1e-6;

rA.flashNode("hub", "#ff0000", 3000);

/** Ops the flashing renderer draws that the quiet one does not, per frame. */
function extraOps(t) {
  clock = 1000 + t;
  const a = capture(rA);
  const b = capture(rB);
  return { a, b, extra: a.length - b.length };
}

// ── 1. the discharge produces marks at all ─────────────────────────────────
const timeline = [...Array(80).keys()].map((i) => ({ t: i * 15, ...extraOps(i * 15) }));
const peak = timeline.reduce((x, y) => (y.extra > x.extra ? y : x));
ok("a flash draws more than the same graph at rest", peak.extra > 0, `+${peak.extra} ops at +${peak.t}ms`);

// ── 2. impacts land ON the first-level neighbours ──────────────────────────
// Counted as: arcs at a neighbour's exact position that the quiet renderer
// does NOT draw at that same instant.
const struck = new Set();
const impactAlpha = [];
for (const fr of timeline) {
  for (const n of A.ring1) {
    const inA = fr.a.filter((o) => o.op === "arc" && near(o, n));
    const inB = fr.b.filter((o) => o.op === "arc" && near(o, B.sim.byId.get(n.id)));
    if (inA.length > inB.length) {
      struck.add(n.id);
      // the surplus arcs are the impact rings
      for (const o of inA.slice(inB.length)) impactAlpha.push(o.alpha);
    }
  }
}
ok("the discharge strikes its neighbours", struck.size > 0, `${struck.size}/6 struck`);
ok("every first-level neighbour is struck", struck.size === A.ring1.length, `[${[...struck].sort().join(", ")}]`);

// ── 3. the strike stays under the origin's own flare ───────────────────────
const originAlpha = [];
for (const fr of timeline) {
  const inA = fr.a.filter((o) => (o.op === "arc" || o.op === "drawImage") && near(o, A.hub));
  const inB = fr.b.filter((o) => (o.op === "arc" || o.op === "drawImage") && near(o, B.hub));
  for (const o of inA.slice(inB.length)) originAlpha.push(o.alpha);
}
const iMax = impactAlpha.length ? Math.max(...impactAlpha) : 0;
const oMax = originAlpha.length ? Math.max(...originAlpha) : 0;
ok(
  "impact rings stay dimmer than the origin flare",
  iMax > 0 && oMax > 0 && iMax < oMax,
  `impact ${iMax.toFixed(2)} vs origin ${oMax.toFixed(2)}`
);

// ── 4. the spill reaches strands beyond the chain ──────────────────────────
// Second-level nodes are not struck at hop 1, but strands leaving a struck
// neighbour toward them should glow faintly. Detected as extra strokes while
// no extra arc sits on those far nodes.
const extraStrokes = timeline.map(
  (f) => f.a.filter((o) => o.op === "stroke").length - f.b.filter((o) => o.op === "stroke").length
);
ok(
  "strands light up around the impact",
  Math.max(...extraStrokes) > A.ring1.length,
  `${Math.max(...extraStrokes)} extra strokes vs ${A.ring1.length} chain legs`
);

// ── 5. it ends ──────────────────────────────────────────────────────────────
const late = extraOps(9000);
ok("nothing keeps glowing after the flash", late.extra === 0, `+${late.extra} ops at +9s`);

// ── 6. "off" silences the arrival too ──────────────────────────────────────
localStorage.setItem("bastra-vault-map-bolt-style", "off");
const C = buildSim();
const rC = createRenderer(canvasEl, C.sim, hues);
const D = buildSim();
const rD = createRenderer(canvasEl, D.sim, hues);
rC.flashNode("hub", "#ff0000", 3000);
let offStruck = 0;
for (let i = 0; i < 80; i++) {
  clock = 1000 + i * 15;
  const a = capture(rC),
    b = capture(rD);
  for (const n of C.ring1) {
    const inA = a.filter((o) => o.op === "arc" && near(o, n)).length;
    const inB = b.filter((o) => o.op === "arc" && near(o, D.sim.byId.get(n.id))).length;
    if (inA > inB) offStruck++;
  }
}
ok("style 'off' leaves the neighbours untouched", offStruck === 0, `${offStruck} strikes while off`);

// ── 7. the afterglow exists at every slider position ───────────────────────
// Daniel's report: "geringere Zeit kommt das Nachleuchten nicht durch".
//
// Two things could not be measured well here and are deliberately left to
// verify-impact.mjs, which knows the windows exactly: how LONG the glow lasts
// (the origin halo lives for the whole flash and swamps any duration measured
// from the canvas) and the ordering. What this checks is the part that only an
// end-to-end run can show: that spill strokes are actually emitted at every
// slider position, not just at the comfortable ones.
localStorage.setItem("bastra-vault-map-bolt-style", "bolt");
const spillSeen = {};
for (const ms of [300, 420, 1000, 2000, 4000]) {
  localStorage.setItem("bastra-vault-map-bolt-ms", String(ms));
  const P = buildSim(),
    Q = buildSim();
  const rP = createRenderer(canvasEl, P.sim, hues);
  const rQ = createRenderer(canvasEl, Q.sim, hues);
  rP.flashNode("hub", "#ff0000", ms * 4 + 2000);
  let best = 0;
  for (let k = 0; k * 16 < ms * 4 + 1500; k++) {
    clock = 1000 + k * 16;
    const a = capture(rP),
      b = capture(rQ);
    // more lit strands than the chain has legs ⇒ spill is on screen
    const extra = a.filter((o) => o.op === "stroke").length - b.filter((o) => o.op === "stroke").length;
    best = Math.max(best, extra - P.ring1.length);
  }
  spillSeen[ms] = best;
}
console.log("   surplus lit strands beyond the chain:", JSON.stringify(spillSeen));
ok(
  "spill strands appear at every slider position",
  Object.values(spillSeen).every((v) => v > 0),
  JSON.stringify(spillSeen)
);
ok(
  "the shortest duration is not the poorest",
  spillSeen[300] >= Math.max(...Object.values(spillSeen)) * 0.5,
  `300ms: ${spillSeen[300]} vs best ${Math.max(...Object.values(spillSeen))}`
);
