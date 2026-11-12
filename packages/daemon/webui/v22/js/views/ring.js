// Ring view — prototype ring-v8.js (SVG) + its stage logic from
// renderValsDark: zoom/pan (ringTo/ringZoomAt), focus card with arm, the
// Recall face in the centre while the agent is closed, numbered hit marks.
import { h, s, clear, setVars } from "../dom.js";
import { t } from "../i18n.js";
import { state, setState, subscribe } from "../state.js";
import { onData } from "../data.js";
import { computeLayout } from "../layout.js";
import { mountJarvis } from "../../vendor/jarvis-v13.js";
import { vault, areaCol as col, timeWindow, inWindow, windowKey } from "./vault-data.js";
import { buildRing, SMALL_KEY, TAU } from "./ring-layout.js";
import { zoomBar, overlay, areaCard, memoryCard, dock, park } from "./chrome.js";

const SANS = '"IBM Plex Sans Condensed", system-ui, sans-serif', MONO = '"IBM Plex Mono", ui-monospace, monospace';
const P = (r, a) => `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
const sector = (r0, r1, a0, a1) => { const L = a1 - a0 > Math.PI ? 1 : 0; return `M${P(r1, a0)}A${r1} ${r1} 0 ${L} 1 ${P(r1, a1)}L${P(r0, a1)}A${r0} ${r0} 0 ${L} 0 ${P(r0, a0)}Z`; };
const arc = (r, a0, a1, rev) => { const L = a1 - a0 > Math.PI ? 1 : 0; return rev ? `M${P(r, a1)}A${r} ${r} 0 ${L} 0 ${P(r, a0)}` : `M${P(r, a0)}A${r} ${r} 0 ${L} 1 ${P(r, a1)}`; };

export function mountRing(stage) {
  const inner = h("div.rg__in");
  const wrap = h("div.rg", { on: { pointerdown: onPD, dblclick: onDbl } }, inner);
  wrap.addEventListener("click", (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); } }, true);
  wrap.addEventListener("wheel", onWheel, { passive: false });
  const zb = zoomBar({ onIn: () => zoomAt(1.4, W / 2, H / 2, true), onOut: () => zoomAt(1 / 1.4, W / 2, H / 2, true), onFit: () => ringTo(1, 0, 0, true) });
  const faceCv = h("canvas", { title: t("vv.talk"), on: { click: () => setState({ jOpen: true }) } });
  const core = h("div.rg-core", null, h("span.rg-core__disc"), faceCv);
  stage.append(wrap, zb.el, core);
  const ov = overlay(stage);
  const cardHost = h("div");
  stage.append(cardHost);

  let ring = null, builtFor = null, W = 800, H = 600, rz = 1, rpx = 0, rpy = 0, raf = 0, moved = false, jarvis = null;
  let refs = null, card = null, cardKey = "", selMem = null, dead = false;

  const k = () => (Math.min(W, H) / (2 * (ring ? ring.extent : 400))) * rz;
  const toScr = (x, y) => [W / 2 + rpx + x * k(), H / 2 + rpy + y * k()];
  const clampP = (z, x, y) => { const mx = ((z - 1) * W) / 2, my = ((z - 1) * H) / 2; return [Math.max(-mx, Math.min(mx, x)), Math.max(-my, Math.min(my, y))]; };

  function ringTo(z, x, y, anim) {
    z = Math.max(1, Math.min(4, z)); [x, y] = clampP(z, x, y);
    cancelAnimationFrame(raf);
    if (!anim) { rz = z; rpx = x; rpy = y; place(); return; }
    const s0 = { z: rz, x: rpx, y: rpy }, t0 = performance.now();
    const step = (now) => { const u = Math.min(1, (now - t0) / 240), e = 1 - Math.pow(1 - u, 3); rz = s0.z + (z - s0.z) * e; rpx = s0.x + (x - s0.x) * e; rpy = s0.y + (y - s0.y) * e; place(); if (u < 1 && !dead) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
  }
  function zoomAt(f, sx, sy, anim) {
    const z = Math.max(1, Math.min(4, rz * f)), px = (sx - W / 2 - rpx) / rz, py = (sy - H / 2 - rpy) / rz;
    ringTo(z, sx - W / 2 - px * z, sy - H / 2 - py * z, anim);
  }
  function onWheel(e) { e.preventDefault(); const b = wrap.getBoundingClientRect(); zoomAt(Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.0025), e.clientX - b.left, e.clientY - b.top, false); }
  function onDbl(e) { const b = wrap.getBoundingClientRect(); if (rz > 1.05) ringTo(1, 0, 0, true); else zoomAt(2, e.clientX - b.left, e.clientY - b.top, true); }
  function onPD(e) {
    if (e.button !== 0 || rz <= 1.001) return;
    const sx = e.clientX, sy = e.clientY, x0 = rpx, y0 = rpy; moved = false;
    const mv = (ev) => { const dx = ev.clientX - sx, dy = ev.clientY - sy; if (!moved && Math.hypot(dx, dy) < 4) return; if (!moved) { moved = true; wrap.classList.add("is-pan"); setState({ hover: null }); } [rpx, rpy] = clampP(rz, x0 + dx, y0 + dy); place(); };
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); wrap.classList.remove("is-pan"); setTimeout(() => { moved = false; }, 0); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  }

  // ── SVG (ringSvg) ───────────────────────────────────────────────────────
  function build() {
    const v = vault();
    if (!v || !v.mems.length) return;
    ring = buildRing(v, (n) => t("vv.smallAreas", { n }));
    builtFor = v;
    const { segs, band, metaSegs, metaBand, orbit, ghosts, extent } = ring;
    const allSegs = [...segs.map((x) => ({ ...x, ri: 96 - 6, bi: band.ri, bo: band.ro })), ...metaSegs.map((x) => ({ ...x, ri: band.ro + 6, bi: metaBand.ri, bo: metaBand.ro, mid: (metaBand.ri + metaBand.ro) / 2, meta: true }))];
    const kids = [];
    kids.push(s("defs", null,
      s("radialGradient", { id: "vv-emb", cx: "50%", cy: "50%", r: "50%" }, s("stop", { offset: "60%", "stop-color": "#38d9f5", "stop-opacity": 0.16 }), s("stop", { offset: "100%", "stop-color": "#38d9f5", "stop-opacity": 0 })),
      ...allSegs.map((x, i) => { const m = (x.a0 + x.a1) / 2; const flip = Math.sin(m) > 0.05; const hf = x.half ?? (x.a1 - x.a0) / 2 + 0.2; return s("path", { id: "vv-tp" + i, d: arc(flip ? x.mid + 3.6 : x.mid - 3.6, m - hf, m + hf, flip) }); }),
      s("path", { id: "vv-tpu", d: arc(orbit + 12, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5, false) })));
    for (const b of [band, metaBand]) {
      kids.push(s("circle", { r: (b.ri + b.ro) / 2, fill: "none", stroke: "rgba(126,164,210,.07)", "stroke-width": b.ro - b.ri }));
      kids.push(s("circle", { r: b.ri, fill: "none", stroke: "rgba(126,164,210,.28)", "stroke-width": 0.8 }));
      kids.push(s("circle", { r: b.ro, fill: "none", stroke: "rgba(126,164,210,.28)", "stroke-width": 0.8 }));
    }
    kids.push(s("circle", { r: 78, fill: "none", stroke: "rgba(126,164,210,.28)", "stroke-opacity": 0.65, "stroke-width": 0.8 }));
    kids.push(s("circle", { r: orbit, fill: "none", stroke: "rgba(160,180,205,.28)", "stroke-width": 0.8, "stroke-dasharray": "4 5" }));
    const segRefs = [];
    allSegs.forEach((x, i) => {
      const wedge = s("path", { d: sector(x.ri, x.bi - 2, x.a0, x.a1) });
      const cell = s("path", { d: sector(x.bi, x.bo, x.a0, x.a1) });
      const edge = s("path", { d: arc(x.bi + 1, x.a0, x.a1), fill: "none", "stroke-width": 2 });
      const g = s("g.rg-seg", { on: { mouseenter: () => setState({ hover: x.key }), mouseleave: () => setState({ hover: null }), click: () => pick(x.key) } }, wedge, cell, edge);
      const dots = x.pts.map((p) => s("circle", { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: p.r.toFixed(2), fill: col(p.k, 0.92) }));
      const nodes = s("g.rg-nodes", null, dots);
      const text = s("text.rg-text", { "font-family": SANS, "font-weight": 700, "font-size": x.meta ? 10 : 10.5, "letter-spacing": 1.3 },
        s("textPath", { href: "#vv-tp" + i, startOffset: "50%", "text-anchor": "middle" },
          s("tspan", { fill: col(x.key) }, (x.label ?? x.key).toUpperCase()),
          s("tspan", { fill: "#7d92a8", "font-family": MONO, "font-weight": 400, "font-size": 9.5, "letter-spacing": 0.4, dx: 6 }, String(x.count))));
      kids.push(g, nodes, text);
      segRefs.push({ x, wedge, cell, edge, nodes, text, dots });
    });
    segs.forEach((x, i) => {
      const nx = segs[(i + 1) % segs.length];
      const a = i === segs.length - 1 ? (x.a1 + nx.a0 + TAU) / 2 : (x.a1 + nx.a0) / 2;
      kids.push(s("line.rg-none", { x1: Math.cos(a) * 78, y1: Math.sin(a) * 78, x2: Math.cos(a) * band.ro, y2: Math.sin(a) * band.ro, stroke: "rgba(126,164,210,.28)", "stroke-opacity": 0.5, "stroke-width": 0.6 }));
    });
    const ghostG = s("g.rg-ghosts", null, ghosts.map((g) => s("circle", { cx: g.x.toFixed(1), cy: g.y.toFixed(1), r: 2.6, fill: "#060a13", stroke: "rgba(160,180,205,.75)", "stroke-width": 0.9, "stroke-dasharray": "1.6 1.4" })));
    kids.push(ghostG);
    if (ghosts.length) kids.push(s("text.rg-none", { "font-family": SANS, "font-weight": 700, "font-size": 10, "letter-spacing": 1.3 },
      s("textPath", { href: "#vv-tpu", startOffset: "50%", "text-anchor": "middle" }, s("tspan", { fill: "rgba(215,227,244,.82)" }, t("vv.unwritten")), s("tspan", { fill: "#7d92a8", "font-family": MONO, "font-weight": 400, "font-size": 9.5, dx: 6 }, String(ghosts.length)))));
    kids.push(s("circle.rg-none", { r: 76, fill: "url(#vv-emb)" }));
    const emblem = s("circle.rg-emblem", { r: 56, fill: "rgba(6,10,19,.9)", "stroke-width": 1.6 });
    const centre = s("g.rg-none");
    kids.push(emblem, centre);
    const svg = s("svg.rg__svg", { viewBox: `${-extent} ${-extent} ${extent * 2} ${extent * 2}`, width: "100%", height: "100%", preserveAspectRatio: "xMidYMid meet" }, kids);
    clear(inner).append(svg);
    refs = { segRefs, ghostG, emblem, centre, allSegs };
    paint(); place();
  }

  function pick(key) { setState(key === SMALL_KEY ? { lensOpen: true, tab: "areas", filter: "" } : { focus: key }); }

  const hoverKey = () => { const hv = state.hover ?? state.focus; return hv && ring && ring.smallKeys.has(hv) ? SMALL_KEY : hv; };

  function paint() {
    if (!refs) return;
    const hover = hoverKey(), win = timeWindow(), v = vault();
    for (const r of refs.segRefs) {
      const on = hover === r.x.key, dim = !!hover && !on;
      r.wedge.setAttribute("fill", col(r.x.key, on ? 0.09 : 0.03));
      r.cell.setAttribute("fill", on ? "rgba(56,217,245,.14)" : col(r.x.key, 0.06));
      r.edge.setAttribute("stroke", col(r.x.key, dim ? 0.25 : 0.85));
      r.nodes.classList.toggle("is-dim", dim); r.text.classList.toggle("is-dim", dim);
      r.x.pts.forEach((p, j) => r.dots[j].classList.toggle("is-out", !inWindow(v.byId.get(p.id), win)));
    }
    refs.ghostG.classList.toggle("is-dim", !!hover);
    const hs = refs.allSegs.find((x) => x.key === hover);
    refs.emblem.setAttribute("stroke", hs ? col(hs.key, 0.9) : "rgba(56,217,245,.75)");
    const T = (y, txt, o) => s("text", { y, "text-anchor": "middle", ...o }, txt);
    if (hs) {
      const lab = hs.label ?? hs.key;
      clear(refs.centre).append(
        T(-14, lab.toUpperCase(), { fill: col(hs.key), "font-family": SANS, "font-weight": 700, "font-size": lab.length > 11 ? 7.5 : 9, "letter-spacing": 1.2 }),
        T(12, String(hs.count), { fill: "#d7e3f4", "font-family": SANS, "font-weight": 600, "font-size": 26 }),
        T(28, hs.meta ? t("vv.rules") : t("vv.clickBrowse"), { fill: "#7d92a8", "font-family": MONO, "font-size": 7, "letter-spacing": 1.4 }));
    } else {
      clear(refs.centre).append(
        T(6, "B", { fill: "rgba(215,227,244,.82)", "font-family": SANS, "font-weight": 700, "font-size": 34 }),
        T(26, t("vv.nMemories", { n: ring.total }), { fill: "#7d92a8", "font-family": MONO, "font-size": 7, "letter-spacing": 1.4 }));
    }
  }

  function segFor(key) {
    if (!ring || !key) return null;
    const kk = ring.smallKeys.has(key) ? SMALL_KEY : key;
    const sg = ring.segs.find((x) => x.key === kk); if (sg) return { s: sg, ro: ring.band.ro };
    const mg = ring.metaSegs.find((x) => x.key === kk); return mg ? { s: mg, ro: ring.metaBand.ro } : null;
  }

  // ── stage overlay: transform, centre face, card + arm, marks ─────────────
  function place() {
    setVars(inner, { "--rx": `${rpx.toFixed(1)}px`, "--ry": `${rpy.toFixed(1)}px`, "--rz": rz.toFixed(4) });
    wrap.classList.toggle("is-zoom", rz > 1.001);
    zb.set(Math.round(rz * 100));
    if (!ring) return;
    const kk = k(), cx = W / 2 + rpx, cy = H / 2 + rpy;
    const coreF = 2 * 56 * kk * 1.6;
    const showCore = !computeLayout(state).jOpen;
    core.classList.toggle("is-on", showCore);
    setVars(core, { "--l": `${(cx - coreF / 2).toFixed(0)}px`, "--t": `${(cy - coreF / 2).toFixed(0)}px`, "--s": `${coreF.toFixed(0)}px` });
    if (showCore && !jarvis) { jarvis = mountJarvis(faceCv, { scale: 0.3, points: 700, glow: false }); jarvis.set(state.agent); }
    jarvis?.setActive(showCore);
    placeCard(kk, cx, cy);
    const hits = Array.isArray(state.hits) ? state.hits : [];
    ov.marks(hits.slice(0, 3).map((id, i) => ({ n: i + 1, id, p: ring.dotOf.get(id) })).filter((m) => m.p).map((m) => { const [x, y] = toScr(m.p.x, m.p.y); return { n: m.n, x, y }; }));
  }

  function placeCard(kk, cx, cy) {
    const key = state.focus ? `${state.focus}|${selMem ? selMem.id : ""}|${H < 420}` : "";
    if (key !== cardKey) {
      cardKey = key; clear(cardHost); card = null;
      if (state.focus && vault()) {
        card = selMem ? memoryCard(selMem, { onClose: () => { selMem = null; place(); } }) : areaCard(state.focus, { compact: H < 420, onMemory: (m) => { selMem = m; place(); } });
        cardHost.append(card.el);
      }
    }
    if (!card) { ov.arm(null); return; }
    const edge = ring.extent * kk;
    const dot = selMem && ring.dotOf.get(selMem.id);
    const sf = segFor(state.focus);
    if (!sf) { park(card, ov, W); return; }
    const m = dot ? Math.atan2(dot.y, dot.x) : (sf.s.a0 + sf.s.a1) / 2, R = sf.ro;
    const [ax, ay] = dot ? toScr(dot.x, dot.y) : toScr(Math.cos(m) * R, Math.sin(m) * R);
    const [ex, ey] = toScr(Math.cos(m) * (R + 26), Math.sin(m) * (R + 26));
    const right = Math.cos(m) >= 0;
    const x = right ? Math.min(cx + edge + 20, W - 260) : Math.max(cx - edge - 20 - 260, 0);
    dock(card, ov, { ax, ay, ex, ey, right, x, W, H, color: selMem ? card.el.style.getPropertyValue("--fc") : col(state.focus) });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────
  const ro = new ResizeObserver(() => { const b = stage.getBoundingClientRect(); W = Math.max(1, b.width); H = Math.max(1, b.height); [rpx, rpy] = clampP(rz, rpx, rpy); place(); });
  ro.observe(stage);
  let prev = { ...state }, prevWin = windowKey();
  const unsub = subscribe((st) => {
    const ch = (k2) => st[k2] !== prev[k2];
    if (ch("focus")) selMem = null;
    if (ch("hover") || ch("focus") || windowKey() !== prevWin) paint();
    if (ch("agent")) jarvis?.set(st.agent);
    prev = { ...st }; prevWin = windowKey();
    place();
  });
  const unData = onData(() => { if (vault() !== builtFor) build(); });
  const ready = document.fonts?.load ? Promise.all([document.fonts.load("700 10.5px 'IBM Plex Sans Condensed'"), document.fonts.load("400 9.5px 'IBM Plex Mono'")]).catch(() => {}) : Promise.resolve();
  ready.then(() => { if (!dead) build(); });

  return () => { dead = true; cancelAnimationFrame(raf); ro.disconnect(); unsub(); unData(); jarvis?.destroy(); };
}
