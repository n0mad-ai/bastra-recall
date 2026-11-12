// Host for the old map engines (Mindspace = orbit, Clouds, Semantic).
//
// The engines are imported unchanged from the old UI (../../../js/ = /ui/js/):
// simulation, canvas renderer, pan/zoom/hover interactions, orbit and
// semantic view managers. This file only does what the old app.js and
// boot/render-loop.js did around them — build them once from the graph,
// switch views with the node flight, run the frame loop — plus the v22
// lifecycle: the canvas is attached while one of the three views is on stage
// and the loop stops when it is not (or when nothing moves).
//
// Coordinates: the engines read pointer positions as ev.clientX/Y, i.e. they
// expect the canvas origin at the viewport origin. The canvas therefore spans
// from the viewport's top-left corner to the stage's bottom-right corner and
// sits at a negative offset inside a clipping box that covers the stage; the
// part under the rail and header is clipped away. getInsets() tells the
// engines which part is visible, so every fit centres in the stage.
import { createSimulation } from "../../../js/simulation.js";
import { createRenderer } from "../../../js/renderer.js";
import { createInteractions } from "../../../js/interactions.js";
import { clusterHues } from "../../../js/graph-data.js";
import { createOrbitView } from "../../../js/managers/orbit-view.js";
import { createSemanticView } from "../../../js/managers/semantic-view.js";
import { h, setVars } from "../dom.js";
import { data } from "../data.js";

// Same storage keys as the old UI: cloud arrangements are shared between both.
const ANCHORS_KEY = "bastra-vault-map-cluster-pos";
const SPIN_KEY = "bastra-vault-map-semantic-spin";
const FLIGHT_MS = 950;
const SLOW_MS = 50; // idle cadence for slow effects (focus beacon, filter pulse): 20 fps
const ORBIT_IDLE_MS = 66; // idle universe (disc spin, planets — calm by design): 15 fps
const AWAKE_MS = 1000; // full rate after the last input or state change

let eng = null; // { graph, sim, renderer, interactions, orbit, semantic, canvas, … }

/** DOM ids the engines look up on enter/exit (hints, spin button). */
function engineDom() {
  let box = document.getElementById("ev-engine-dom");
  if (box) return box;
  box = h("div", { id: "ev-engine-dom", hidden: true },
    h("div", { id: "orbit-hint", hidden: true }), h("div", { id: "semantic-hint", hidden: true }),
    h("div", { id: "semantic-depth-controls", hidden: true }), h("button", { id: "semantic-spin", type: "button" }));
  document.body.append(box);
  return box;
}

const str = (v) => (typeof v === "string" ? v : "");
const num = (v) => (Number.isFinite(v) ? v : 0);

/** Old-UI graph shape from GET /api/v1/graph (external data: shapes checked). */
function engineGraph(g) {
  const nodes = [];
  for (const n of g.nodes) {
    if (!n || typeof n.id !== "string" || typeof n.cluster !== "string") continue;
    nodes.push({ ...n, title: str(n.title) || n.id, type: str(n.type), summary: str(n.summary), group: str(n.group) || n.cluster,
      tags: Array.isArray(n.tags) ? n.tags.filter((x) => typeof x === "string") : [], degree: num(n.degree), baseCluster: n.cluster });
  }
  const edges = g.edges.filter((e) => e && typeof e.source === "string" && typeof e.target === "string");
  const clusters = data.clusters.map((c) => ({ key: c.key, count: c.count }));
  const groups = (Array.isArray(g.groups) ? g.groups : []).filter((c) => c && typeof c.key === "string" && Number.isFinite(c.count)).map((c) => ({ key: c.key, count: c.count }));
  return { nodes, edges, clusters, groups };
}

function build() {
  engineDom();
  const graph = engineGraph(data.graph);
  const canvas = h("canvas.ev__cv");
  const clip = h("div.ev", null, canvas);
  const e = { src: data.graph, graph, canvas, clip, structure: "clusters", view: null, stage: null, hooks: null,
    transition: null, token: 0, raf: 0, lastFrame: -Infinity, awakeUntil: 0, rect: null, wasBusy: false, userTouched: false, saveT: 0,
    cloudSnapshot: null, spin: (() => { try { return localStorage.getItem(SPIN_KEY) === "on"; } catch { return false; } })() };
  e.hues = clusterHues(graph.clusters);
  e.sim = createSimulation(graph, innerWidth, innerHeight, loadAnchors(e));
  e.renderer = createRenderer(canvas, e.sim, e.hues);
  e.interactions = createInteractions(canvas, e.renderer, e.sim, {
    onSelect: (n) => e.hooks?.onSelect(n),
    onHoverChange: (n, x, y) => e.hooks?.onHover(n, x, y),
    onClusterDragEnd: () => saveAnchorsSoon(e),
    getInsets: () => insets(e),
    canDragClusters: () => e.view === "clouds",
  });
  const satLight = () => ["78%", "66%"];
  e.orbit = createOrbitView({ sim: e.sim, renderer: e.renderer, getInteractions: () => e.interactions, getHues: () => e.hues, getSatLight: satLight, getWeather: () => null });
  e.semantic = createSemanticView({ sim: e.sim, renderer: e.renderer, getInteractions: () => e.interactions });
  const wake = () => awake(e);
  for (const type of ["pointerdown", "pointermove", "pointerleave", "wheel"]) clip.addEventListener(type, wake, { passive: true });
  clip.addEventListener("pointerdown", () => { e.userTouched = true; }, { passive: true });
  clip.addEventListener("wheel", () => { e.userTouched = true; }, { passive: true });
  return e;
}

const anchorsKey = (e) => `${ANCHORS_KEY}:${e.structure}`;
function loadAnchors(e) { try { return JSON.parse(localStorage.getItem(anchorsKey(e)) ?? "null"); } catch { return null; } }
function saveAnchorsSoon(e) {
  clearTimeout(e.saveT);
  e.saveT = setTimeout(() => { try { localStorage.setItem(anchorsKey(e), JSON.stringify(e.sim.anchorPositions())); } catch { /* storage blocked */ } }, 400);
}

function insets(e) {
  const r = e.rect;
  // cardInset: the memory card's column on the right — flights keep clear of it
  return r ? { left: r.left, top: r.top, right: e.cardInset || 0, bottom: 0 } : { left: 0, top: 0, right: 0, bottom: 0 };
}

/** Canvas = viewport origin … stage bottom-right; keeps the picture in place
 *  relative to the stage when the stage moves or resizes. */
function syncGeometry(e) {
  const b = e.stage.getBoundingClientRect();
  const r = { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) };
  const p = e.rect;
  if (p && p.left === r.left && p.top === r.top && p.right === r.right && p.bottom === r.bottom) return false;
  setVars(e.canvas, { "--ev-l": `${-r.left}px`, "--ev-t": `${-r.top}px`, "--ev-w": `${Math.max(1, r.right)}px`, "--ev-h": `${Math.max(1, r.bottom)}px` });
  if (p) {
    const cam = e.renderer.camera;
    cam.x += (r.left + r.right - p.left - p.right) / 2;
    cam.y += (r.top + r.bottom - p.top - p.bottom) / 2;
  }
  e.rect = r;
  e.renderer.resize();
  return true;
}

function awake(e, ms = AWAKE_MS) {
  e.awakeUntil = Math.max(e.awakeUntil, performance.now() + ms);
  if (e.stage && !e.raf && !document.hidden) e.raf = requestAnimationFrame((now) => frame(e, now));
}

/** "full" | frame interval in ms | "stop" — #324 idle throttle, extended: a still picture stops. */
function cadence(e, now) {
  if (e.transition || e.zoomAnim || e.interactions.isFlying() || now < e.awakeUntil || e.wasBusy) return "full";
  if (e.view === "orbit") return ORBIT_IDLE_MS; // the universe turns on its own (discs, planets)
  if (e.view === "semantic" && e.semantic.getMode() === "3d" && e.spin) return SLOW_MS;
  return e.renderer.hasLiveEffects() ? SLOW_MS : "stop"; // focus beacon, filter pulse
}

function frame(e, now) {
  e.raf = 0;
  if (!e.stage || document.hidden) return;
  if (syncGeometry(e)) e.awakeUntil = Math.max(e.awakeUntil, now + 200);
  const mode = cadence(e, now);
  if (mode === "stop") { e.hooks?.onFrame(); return; }
  if (mode !== "full" && now - e.lastFrame < mode) { e.raf = requestAnimationFrame((t) => frame(e, t)); return; }
  e.lastFrame = now;
  const tr = e.transition;
  if (tr) {
    // nodes fly between layouts; physics and view ticks pause meanwhile
    const t = Math.min((now - tr.t0) / tr.ms, 1);
    const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    for (const n of e.sim.nodes) {
      const a = tr.from.get(n.id), b = tr.to.get(n.id);
      if (a && b) { n.x = a.x + (b.x - a.x) * k; n.y = a.y + (b.y - a.y) * k; }
    }
    if (t >= 1) e.transition = null;
  }
  const za = e.zoomAnim;
  if (za) {
    const t = Math.min((now - za.t0) / 240, 1), k = 1 - Math.pow(1 - t, 3), cam = e.renderer.camera;
    cam.scale = za.s0 + (za.s1 - za.s0) * k;
    cam.x = za.px - za.wx * cam.scale; cam.y = za.py - za.wy * cam.scale;
    if (t >= 1) e.zoomAnim = null;
  }
  if (!e.transition) {
    if (e.view === "orbit") e.orbit.tick(now);
    else if (e.view === "semantic") e.semantic.tick(now);
    else if (e.view === "clouds") {
      const busy = e.sim.tick();
      // settled after a regroup → final framing, unless the user took the camera
      if (!busy && e.wasBusy && !e.userTouched) fit(e, 600);
      e.wasBusy = busy;
      if (e.sim.separateClouds(e.interactions.draggedCluster())) saveAnchorsSoon(e);
    }
  }
  e.interactions.step(now);
  e.renderer.draw(now);
  e.hooks?.onFrame();
  e.raf = requestAnimationFrame((t) => frame(e, t));
}

/** Visible nodes for fits (ghosts included, as in the old fitAll). */
const fitPoints = (e, map) => (map ? [...map.values()] : e.sim.nodes.map((n) => ({ x: n.x, y: n.y })));

/** Scale the old flyToBounds would pick for these points (zoom % = 100 there). */
function fitScale(e, pts, padding = 90, maxScale = 1.6) {
  if (!pts.length || !e.rect) return 1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const W = e.rect.right - e.rect.left, H = e.rect.bottom - e.rect.top;
  return Math.max(0.05, Math.min((W - padding * 2) / Math.max(x1 - x0, 1), (H - padding * 2) / Math.max(y1 - y0, 1), maxScale));
}

function fit(e, ms = 700, map = null) {
  const pts = fitPoints(e, map);
  e.baseScale = fitScale(e, pts);
  e.interactions.flyToBounds(pts, { padding: 90, maxScale: 1.6, ms });
  awake(e, ms + 100);
}

/** Structure: v22 areas are the fine clusters; Clouds can switch to blocks. */
function applyStructure(e, mode) {
  e.structure = mode === "blocks" ? "blocks" : "clusters";
  for (const n of e.sim.nodes) n.cluster = e.structure === "blocks" ? n.group : n.baseCluster;
  e.hues = clusterHues(e.structure === "blocks" ? e.graph.groups : e.graph.clusters);
  e.renderer.setHues(e.hues);
}

function exitView(e) {
  if (e.view === "orbit") e.orbit.exit();
  else if (e.view === "semantic") e.semantic.exit();
  e.view = null;
}

/** Enter a view with the old switchView flight. Throws when the semantic
 *  layout is unavailable (no embeddings yet); the caller shows the notice. */
async function enterView(e, v) {
  const token = ++e.token;
  let sem = null;
  if (v === "semantic") sem = await e.semantic.enter();
  if (token !== e.token) {
    // the stage moved on while the layout loaded: undo the late semantic
    // enter and restore the renderer state of the view now on screen
    e.semantic.exit();
    if (e.view === "orbit") { e.orbit.exit(); e.orbit.enter(); }
    return;
  }
  const from = new Map(e.sim.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  if (e.structure !== "clusters" && v !== "clouds") applyStructure(e, "clusters");
  let to;
  e.wasBusy = false;
  if (v === "clouds") {
    // settle off-screen from the last arrangement; the flight target is the
    // final layout, so the landing hands over to the live physics seamlessly
    for (const n of e.sim.nodes) {
      const p = e.cloudSnapshot?.get(n.id);
      if (p) { n.x = p.x; n.y = p.y; }
      n.vx = 0; n.vy = 0;
    }
    e.sim.regroup(loadAnchors(e));
    for (let i = 0; i < 220 && e.sim.tick(); i++);
    to = new Map(e.sim.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  } else if (v === "orbit") to = e.orbit.enter();
  else to = sem;
  e.view = v;
  e.userTouched = false;
  e.transition = { t0: performance.now(), ms: FLIGHT_MS, from, to };
  fit(e, FLIGHT_MS, to);
}

/**
 * Attach the engine to a stage and enter view v ("orbit" | "clouds" | "semantic").
 * hooks: { onSelect(n), onHover(n, x, y), onFrame(), onError(err), onReady() }
 * Returns detach().
 */
export function attach(stage, v, hooks) {
  if (eng && eng.src !== data.graph) { detachAll(eng); eng = null; }
  if (!eng) eng = build();
  const e = eng;
  e.stage = stage; e.hooks = hooks; e.rect = null;
  stage.prepend(e.clip);
  syncGeometry(e);
  if (e.view) exitView(e);
  enterView(e, v).then(() => { if (e.stage === stage) { hooks.onReady?.(); awake(e); } }).catch((err) => { if (e.stage === stage) hooks.onError?.(err); });
  awake(e);
  const onVis = () => { if (!document.hidden) awake(e); };
  document.addEventListener("visibilitychange", onVis);
  return () => {
    document.removeEventListener("visibilitychange", onVis);
    if (e.stage !== stage) return;
    cancelAnimationFrame(e.raf); e.raf = 0;
    if (e.view === "clouds") e.cloudSnapshot = new Map(e.sim.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    // finish a running flight so the next view starts from real positions
    if (e.transition) { for (const n of e.sim.nodes) { const b = e.transition.to.get(n.id); if (b) { n.x = b.x; n.y = b.y; } } e.transition = null; }
    exitView(e);
    e.token++; // a semantic layout still loading must not enter after this
    e.renderer.setFocus(null); e.renderer.setHover(null); e.renderer.setHighlight(null); e.renderer.setFilter(null);
    e.stage = null; e.hooks = null; e.zoomAnim = null; e.cardInset = 0;
    e.clip.remove();
    e.canvas.width = 0; e.canvas.height = 0; // free the backing store while hidden
  };
}

function detachAll(e) { cancelAnimationFrame(e.raf); e.clip.remove(); e.canvas.width = 0; e.canvas.height = 0; }

// ── controls used by the v22 frame (engine-view.js) ────────────────────────
export const engine = {
  get: () => eng,
  wake: (ms) => eng && awake(eng, ms),
  view: () => eng?.view ?? null,
  busy: () => !!eng?.transition,
  /** Stage-local screen position of a world point. */
  toStage(x, y) { const e = eng, c = e.renderer.camera; return [x * c.scale + c.x - e.rect.left, y * c.scale + c.y - e.rect.top]; },
  zoomPct: () => (eng ? Math.round((eng.renderer.camera.scale / (eng.baseScale || 1)) * 100) : 100),
  /** Zoom about the stage centre (zoom bar buttons). */
  zoomBy(f) {
    const e = eng; if (!e || !e.rect) return;
    const c = e.renderer.camera, px = (e.rect.left + e.rect.right) / 2, py = (e.rect.top + e.rect.bottom) / 2;
    const s1 = Math.min(Math.max((e.zoomAnim?.s1 ?? c.scale) * f, 0.12), 8);
    e.userTouched = true;
    e.zoomAnim = { t0: performance.now(), s0: c.scale, s1, px, py, wx: (px - c.x) / c.scale, wy: (py - c.y) / c.scale };
    awake(e, 400);
  },
  fit: () => eng && fit(eng, 700),
  setCardInset(px) { if (eng) eng.cardInset = px; },
  /** Explicit flight (focus, memory): it owns the camera, so the settle fit
   *  after the physics comes to rest must not take it back. */
  flyTo(points, opts) { if (!eng || !points.length) return; eng.userTouched = true; eng.interactions.flyToBounds(points, opts); awake(eng, (opts?.ms ?? 800) + 100); },
  structure: () => eng?.structure ?? "clusters",
  setStructure(mode) {
    const e = eng; if (!e || e.view !== "clouds" || e.transition || mode === e.structure) return;
    applyStructure(e, mode);
    e.sim.regroup(loadAnchors(e)); e.wasBusy = true; e.userTouched = false;
    awake(e);
  },
  resetLayout() {
    const e = eng; if (!e || e.view !== "clouds") return;
    clearTimeout(e.saveT);
    try { localStorage.removeItem(anchorsKey(e)); } catch { /* storage blocked */ }
    e.sim.regroup(null); e.wasBusy = true; e.userTouched = false;
    awake(e);
  },
  semanticMode: () => eng?.semantic.getMode() ?? "2d",
  setSemanticMode(m) {
    const e = eng; if (!e || e.view !== "semantic" || e.transition || m === e.semantic.getMode()) return;
    const from = new Map(e.sim.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    e.semantic.setMode(m);
    const to = e.semantic.targetsForMode(m);
    e.transition = { t0: performance.now(), ms: 700, from, to };
    fit(e, 700, to);
  },
  spin: () => !!eng?.spin,
  /** The semantic view keeps its spin flag private and toggles it on its own
   *  button (#semantic-spin); the v22 control clicks that button. */
  setSpin(on) {
    const e = eng; if (!e || !!on === e.spin) return;
    document.getElementById("semantic-spin")?.click();
    e.spin = !!on;
    awake(e);
  },
  orbitMode: () => eng?.orbit.getMode() ?? "universe",
  setOrbitMode(m) { const e = eng; if (!e || e.view !== "orbit" || e.transition || m === e.orbit.getMode()) return; e.orbit.setMode(m); e.orbit.relayout(); fit(e, 700); },
  distance: () => eng?.orbit.getDistanceMode() ?? "woven",
  setDistance(m) { const e = eng; if (!e || e.view !== "orbit" || e.transition || m === e.orbit.getDistanceMode()) return; e.orbit.setDistanceMode(m); e.orbit.relayout(); awake(e); },
  drift: () => eng?.orbit.getDrift() ?? true,
  setDrift(on) { const e = eng; if (!e) return; e.orbit.setDrift(on); awake(e); },
};
