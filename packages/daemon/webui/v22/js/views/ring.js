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
import { zoomBar, overlay, areaCard, memoryCard, dock, park, dateStr, TC, INK, ACC } from "./chrome.js";
import { mountMemoryBrowser } from "./memory-browser.js";

// Upper bound for the label scale (SVG units per screen pixel). The bands keep
// the prototype's widths in SVG units (30 main, 22 rules); at 2.5 a label's cap
// height (~0.7 em) still fits inside the narrower rules band. On stages too
// small for that, the wheel stops growing and labels shrink below 10.5 px
// instead of spilling out of their band.
const LF_MAX = 2.5;
const SANS = '"IBM Plex Sans Condensed", system-ui, sans-serif', MONO = '"IBM Plex Mono", ui-monospace, monospace';
const P = (r, a) => `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
const sector = (r0, r1, a0, a1) => { const L = a1 - a0 > Math.PI ? 1 : 0; return `M${P(r1, a0)}A${r1} ${r1} 0 ${L} 1 ${P(r1, a1)}L${P(r0, a1)}A${r0} ${r0} 0 ${L} 0 ${P(r0, a0)}Z`; };
const arc = (r, a0, a1, rev) => { const L = a1 - a0 > Math.PI ? 1 : 0; return rev ? `M${P(r, a1)}A${r} ${r} 0 ${L} 0 ${P(r, a0)}` : `M${P(r, a0)}A${r} ${r} 0 ${L} 1 ${P(r, a1)}`; };

export function mountRing(stage) {
  const inner = h("div.rg__in");
  const wrap = h("div.rg", { on: { pointerdown: onPD, dblclick: onDbl } }, inner);
  // Capture: a finished pan swallows its click; a click on a memory dot opens
  // it instead of the segment underneath (dots themselves take no events).
  wrap.addEventListener("click", (e) => {
    if (moved) { e.stopPropagation(); e.preventDefault(); return; }
    const p = dotAt(e); if (!p) return;
    e.stopPropagation(); e.preventDefault();
    if (inWindow(vault().byId.get(p.id), timeWindow())) openDot(p);
  }, true);
  wrap.addEventListener("pointermove", onMove);
  wrap.addEventListener("pointerleave", () => { hoverDot(null); wrap.classList.remove("is-out-dot"); });
  wrap.addEventListener("wheel", onWheel, { passive: false });
  const zb = zoomBar({ onIn: () => zoomAt(1.4, W / 2, H / 2, true), onOut: () => zoomAt(1 / 1.4, W / 2, H / 2, true), onFit: () => ringTo(1, 0, 0, true) });
  const faceCv = h("canvas", { title: t("vv.talk"), on: { click: () => setState({ jOpen: true }) } });
  const core = h("div.rg-core", null, h("span.rg-core__disc"), faceCv);
  stage.append(wrap, zb.el, core);
  const ov = overlay(stage);
  const cardHost = h("div");
  const tip = h("div.ltip");
  stage.append(cardHost, tip);
  const unMb = mountMemoryBrowser(stage, { showMemory: (id) => { const p = ring?.dotOf.get(id); if (p) openDot(p); } });

  let ring = null, builtFor = null, W = 800, H = 600, rz = 1, rpx = 0, rpy = 0, raf = 0, moved = false, jarvis = null;
  let refs = null, card = null, cardKey = "", selMem = null, dead = false, labScale = 0, relayT = 0;
  let hovDot = null, glideDot = null, openT = 0, opening = false, swapCard = false;
  // closing a memory card (×, Escape, another area) glides back to the fit
  const zoomHome = () => ringTo(1, 0, 0, true);
  function closeMem() {
    clearTimeout(openT); glideDot = null; selMem = null;
    setState({ focus: null });
    place(); zoomHome();
  }
  const onKey = (e) => {
    if (e.key !== "Escape" || state.covered || (!selMem && !glideDot)) return;
    e.preventDefault(); e.stopImmediatePropagation(); closeMem();
  };
  window.addEventListener("keydown", onKey, true);

  const k = () => (Math.min(W, H) / (2 * (ring ? ring.extent : 400))) * rz;
  // SVG units per screen pixel at zoom 100 % — the scale ring labels are laid
  // out at so they keep the prototype's on-screen size (10.5 px) at any size.
  const needLf = (extent) => (2 * extent) / Math.min(W, H);
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
    ring = layout(v);
    builtFor = v;
    const { segs, band, metaSegs, metaBand, orbit, ghosts, extent } = ring;
    const allSegs = [...segs.map((x) => ({ ...x, ri: 96 - 6, bi: band.ri, bo: band.ro })), ...metaSegs.map((x) => ({ ...x, ri: band.ro + 6, bi: metaBand.ri, bo: metaBand.ro, mid: (metaBand.ri + metaBand.ro) / 2, meta: true }))];
    const kids = [];
    kids.push(s("defs", null,
      s("radialGradient", { id: "vv-emb", cx: "50%", cy: "50%", r: "50%" }, s("stop", { offset: "60%", "stop-color": "#38d9f5", "stop-opacity": 0.16 }), s("stop", { offset: "100%", "stop-color": "#38d9f5", "stop-opacity": 0 })),
      ...allSegs.map((x, i) => s("path", { id: "vv-tp" + i })),
      s("path", { id: "vv-tpu" })));
    for (const b of [band, metaBand]) {
      kids.push(s("circle", { r: (b.ri + b.ro) / 2, fill: "none", stroke: "rgba(126,164,210,.07)", "stroke-width": b.ro - b.ri }));
      kids.push(s("circle", { r: b.ri, fill: "none", stroke: "rgba(126,164,210,.28)", "stroke-width": 0.8 }));
      kids.push(s("circle", { r: b.ro, fill: "none", stroke: "rgba(126,164,210,.28)", "stroke-width": 0.8 }));
    }
    kids.push(s("circle", { r: 78, fill: "none", stroke: "rgba(126,164,210,.28)", "stroke-opacity": 0.65, "stroke-width": 0.8 }));
    kids.push(s("circle", { r: orbit, fill: "none", stroke: "rgba(160,180,205,.28)", "stroke-width": 0.8, "stroke-dasharray": "4 5" }));
    const segRefs = [], labels = [];
    allSegs.forEach((x, i) => {
      const wedge = s("path", { d: sector(x.ri, x.bi - 2, x.a0, x.a1) });
      const cell = s("path", { d: sector(x.bi, x.bo, x.a0, x.a1) });
      const edge = s("path", { d: arc(x.bi + 1, x.a0, x.a1), fill: "none", "stroke-width": 2 });
      const g = s("g.rg-seg", { on: { mouseenter: () => setState({ hover: x.key }), mouseleave: () => setState({ hover: null }), click: () => pick(x.key) } }, wedge, cell, edge);
      const dots = x.pts.map((p) => s("circle", { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: p.r.toFixed(2), fill: col(p.k, 0.92) }));
      const nodes = s("g.rg-nodes", null, dots);
      const num = s("tspan", { fill: "#7d92a8", "font-family": MONO, "font-weight": 400 }, String(x.count));
      const text = s("text.rg-text", { "font-family": SANS, "font-weight": 700 },
        s("textPath", { href: "#vv-tp" + i, startOffset: "50%", "text-anchor": "middle" },
          s("tspan", { fill: col(x.key) }, (x.label ?? x.key).toUpperCase()), num));
      kids.push(g, nodes, text);
      segRefs.push({ x, wedge, cell, edge, nodes, text, dots });
      const m = (x.a0 + x.a1) / 2, flip = Math.sin(m) > 0.05, hf = x.half ?? (x.a1 - x.a0) / 2 + 0.2;
      labels.push({ text, num, fs: x.meta ? 10 : 10.5, path: (f) => arc(flip ? x.mid + 3.6 * f : x.mid - 3.6 * f, m - hf, m + hf, flip) });
    });
    segs.forEach((x, i) => {
      const nx = segs[(i + 1) % segs.length];
      const a = i === segs.length - 1 ? (x.a1 + nx.a0 + TAU) / 2 : (x.a1 + nx.a0) / 2;
      kids.push(s("line.rg-none", { x1: Math.cos(a) * 78, y1: Math.sin(a) * 78, x2: Math.cos(a) * band.ro, y2: Math.sin(a) * band.ro, stroke: "rgba(126,164,210,.28)", "stroke-opacity": 0.5, "stroke-width": 0.6 }));
    });
    const ghostG = s("g.rg-ghosts", null, ghosts.map((g) => s("circle", { cx: g.x.toFixed(1), cy: g.y.toFixed(1), r: 2.6, fill: "#060a13", stroke: "rgba(160,180,205,.75)", "stroke-width": 0.9, "stroke-dasharray": "1.6 1.4" })));
    kids.push(ghostG);
    if (ghosts.length) {
      const num = s("tspan", { fill: "#7d92a8", "font-family": MONO, "font-weight": 400 }, String(ghosts.length));
      const text = s("text.rg-none", { "font-family": SANS, "font-weight": 700 },
        s("textPath", { href: "#vv-tpu", startOffset: "50%", "text-anchor": "middle" }, s("tspan", { fill: "rgba(215,227,244,.82)" }, t("vv.unwritten")), num));
      kids.push(text);
      labels.push({ text, num, fs: 10, numLs: false, path: (f) => arc(orbit + 12 * f, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5, false) });
    }
    kids.push(s("circle.rg-none", { r: 76, fill: "url(#vv-emb)" }));
    const emblem = s("circle.rg-emblem", { r: 56, fill: "rgba(6,10,19,.9)", "stroke-width": 1.6 });
    const centre = s("g.rg-none");
    kids.push(emblem, centre);
    const hovMark = s("circle.rg-hov", { fill: "none", stroke: ACC, "stroke-width": 1.2, "vector-effect": "non-scaling-stroke" });
    const selMark = s("path.rg-sel", { fill: "none", stroke: ACC, "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" });
    const pulse = s("circle.rg-pulse", { fill: "none", "stroke-width": 1.6, "vector-effect": "non-scaling-stroke" });
    kids.push(hovMark, selMark, pulse);
    const svg = s("svg.rg__svg", { viewBox: `${-extent} ${-extent} ${extent * 2} ${extent * 2}`, width: "100%", height: "100%", preserveAspectRatio: "xMidYMid meet" }, kids);
    clear(inner).append(svg);
    refs = { segRefs, ghostG, emblem, centre, allSegs, labels, paths: [...svg.querySelectorAll("defs > path")], hovMark, selMark, pulse };
    hovDot = null; glideDot = null;
    labScale = 0;
    paint(); place();
  }

  // The label scale sets the wheel size (labels need their arc, as in the
  // prototype the wheel grows until they fit) and the wheel size sets the
  // scale. Bisect for the smallest scale whose layout fits itself.
  function layout(v) {
    const lab = (n) => t("vv.smallAreas", { n });
    const fits = (r) => needLf(r.extent) <= r.lf;
    let lo = 0.25, hi = 1, best = buildRing(v, lab, lo);
    if (fits(best)) return best;
    for (let r = buildRing(v, lab, hi); ; r = buildRing(v, lab, hi)) {
      if (fits(r)) { best = r; break; }
      if (hi >= LF_MAX) return r;
      lo = hi; hi = Math.min(LF_MAX, hi * 2);
    }
    while (hi / lo > 1.01) {
      const mid = Math.sqrt(lo * hi), r = buildRing(v, lab, mid);
      if (fits(r)) { best = r; hi = mid; } else lo = mid;
    }
    return best;
  }

  // Label size, tracking, gaps and baseline offset in SVG units for `f` units
  // per screen pixel (prototype values at f = 1).
  function applyLabels(f) {
    labScale = f;
    refs.labels.forEach((l, i) => {
      l.text.setAttribute("font-size", (l.fs * f).toFixed(3));
      l.text.setAttribute("letter-spacing", (1.3 * f).toFixed(3));
      l.num.setAttribute("font-size", (9.5 * f).toFixed(3));
      if (l.numLs !== false) l.num.setAttribute("letter-spacing", (0.4 * f).toFixed(3));
      l.num.setAttribute("dx", (6 * f).toFixed(3));
      refs.paths[i].setAttribute("d", l.path(f));
    });
  }

  function pick(key) { setState(key === SMALL_KEY ? { lensOpen: true, tab: "areas", filter: "" } : { focus: key }); }

  const hoverKey = () => { const hv = state.hover ?? state.focus; return hv && ring && ring.smallKeys.has(hv) ? SMALL_KEY : hv; };

  function paint() {
    if (!refs) return;
    const hover = hoverKey(), win = timeWindow(), v = vault();
    if (hovDot && !inWindow(v.byId.get(hovDot.id), win)) { hoverDot(null); wrap.classList.add("is-out-dot"); }
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
    // never larger than the layout was made for (only when the stage is too
    // small for any wheel to fit its labels at full size)
    const lf = Math.min(1 / kk, ring.lf);
    if (refs && Math.abs(lf - labScale) > labScale * 0.001) applyLabels(lf);
    const coreF = 2 * 56 * kk * 1.6;
    const showCore = !computeLayout(state).jOpen;
    core.classList.toggle("is-on", showCore);
    setVars(core, { "--l": `${(cx - coreF / 2).toFixed(0)}px`, "--t": `${(cy - coreF / 2).toFixed(0)}px`, "--s": `${coreF.toFixed(0)}px` });
    if (showCore && !jarvis) { jarvis = mountJarvis(faceCv, { scale: 0.3, points: 700, glow: false }); jarvis.set(state.agent); }
    jarvis?.setActive(showCore && !state.covered); // frozen under the memory browser / a dialog (js/cover.js)
    placeMarks(kk);
    placeCard(kk, cx, cy);
    const hits = Array.isArray(state.hits) ? state.hits : [];
    ov.marks(hits.slice(0, 3).map((id, i) => ({ n: i + 1, id, p: ring.dotOf.get(id) })).filter((m) => m.p).map((m) => { const [x, y] = toScr(m.p.x, m.p.y); return { n: m.n, x, y }; }));
  }

  // ── memory dots: hit test, hover tooltip, click glide (lens-canvas.js) ──
  // Nearest visible dot within its radius plus a few pixels, so the smallest
  // dots stay hittable at any zoom.
  function dotAt(e) {
    if (!ring || !refs) return null;
    const b = stage.getBoundingClientRect(), sx = e.clientX - b.left, sy = e.clientY - b.top;
    const kk = k();
    let best = null, bd = Infinity;
    for (const p of ring.dotOf.values()) {
      const [x, y] = toScr(p.x, p.y), d = Math.hypot(x - sx, y - sy);
      if (d < bd && d <= Math.max(p.r * kk + 2, 5)) { bd = d; best = p; }
    }
    return best;
  }
  function onMove(e) {
    if (moved) return;
    let p = dotAt(e);
    const out = !!p && !inWindow(vault().byId.get(p.id), timeWindow());
    wrap.classList.toggle("is-out-dot", out);
    if (out) p = null;
    hoverDot(p);
    if (!p) return;
    const m = vault().byId.get(p.id), c = TC[m.cls] || INK;
    if (tip.dataset.id !== m.id) {
      tip.dataset.id = m.id;
      tip.replaceChildren(
        h("div.ltip__top", null, h("span.ltip__chip", { text: t(`vv.cls.${m.cls}`), vars: { "--tc": c } }), h("span.ltip__m", { text: m.area })),
        h("div.ltip__t", { text: m.title }),
        h("div.ltip__m", { text: [Number.isFinite(m.at) ? dateStr(m.at) : "", t("vv.recalledN", { n: m.recalled }), t("vv.linksN", { n: m.links.length })].filter(Boolean).join(" · ") }),
        h("div.ltip__m.ltip__hint", { text: t("vv.lens.open") }));
    }
    const b = stage.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top, tw = tip.offsetWidth || 240, th = tip.offsetHeight || 80;
    let x = mx + 16, y = my + 16; if (x + tw > W - 8) x = mx - tw - 16; if (y + th > H - 8) y = my - th - 16;
    setVars(tip, { "--x": `${Math.max(8, x)}px`, "--y": `${Math.max(8, y)}px` });
    tip.classList.add("is-on");
  }
  function hoverDot(p) {
    if (!p) tip.classList.remove("is-on");
    if (p === hovDot) return;
    hovDot = p;
    wrap.classList.toggle("is-dot", !!p);
    placeMarks(k());
  }
  // Click: selection mark + pulse, glide the dot to the centre, then open the
  // memory card with its arm (as in the lenses: 430 ms after the click).
  function openDot(p) {
    const m = vault()?.byId.get(p.id); if (!m) return;
    hoverDot(null);
    glideDot = p;
    const { pulse } = refs;
    pulse.setAttribute("cx", p.x.toFixed(1)); pulse.setAttribute("cy", p.y.toFixed(1)); pulse.setAttribute("r", (p.r + 2).toFixed(2));
    pulse.setAttribute("stroke", TC[m.cls] || ACC);
    pulse.classList.remove("is-on"); void pulse.getBoundingClientRect(); pulse.classList.add("is-on");
    const z = Math.min(4, Math.max(rz, 2.4)), k0 = k() / rz;
    ringTo(z, -p.x * k0 * z, -p.y * k0 * z, true);
    clearTimeout(openT);
    openT = setTimeout(() => {
      if (dead) return;
      glideDot = null;
      // the area focus that comes with the memory must not count as a close
      if (state.focus !== m.area) { opening = true; setState({ focus: m.area }); opening = false; }
      selMem = m; place();
    }, 430);
  }
  function placeMarks(kk) {
    if (!refs) return;
    const { hovMark, selMark } = refs;
    hovMark.classList.toggle("is-on", !!hovDot);
    if (hovDot) { hovMark.setAttribute("cx", hovDot.x.toFixed(1)); hovMark.setAttribute("cy", hovDot.y.toFixed(1)); hovMark.setAttribute("r", (hovDot.r + 2.5 / kk).toFixed(2)); }
    const sd = glideDot || (selMem && ring.dotOf.get(selMem.id));
    selMark.classList.toggle("is-on", !!sd);
    if (sd) {
      const px = 1 / kk, q = 7 * px + sd.r, a = 4 * px;
      selMark.setAttribute("d", [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => `M${(sd.x + sx * q).toFixed(2)} ${(sd.y + sy * (q - a)).toFixed(2)}L${(sd.x + sx * q).toFixed(2)} ${(sd.y + sy * q).toFixed(2)}L${(sd.x + sx * (q - a)).toFixed(2)} ${(sd.y + sy * q).toFixed(2)}`).join(""));
    }
  }

  function placeCard(kk, cx, cy) {
    const key = state.focus ? `${state.focus}|${selMem ? selMem.id : ""}|${H < 420}` : "";
    if (key !== cardKey) {
      cardKey = key; clear(cardHost); card = null;
      if (state.focus && vault()) {
        card = selMem ? memoryCard(selMem, { onClose: closeMem }) : areaCard(state.focus, { compact: H < 420, onMemory: (m) => { const p = ring.dotOf.get(m.id); if (p) openDot(p); else { selMem = m; place(); } } });
        cardHost.append(card.el);
        if (swapCard) card.el.classList.add("is-swap");
      }
      swapCard = false;
    }
    if (!card) { ov.arm(null); return; }
    const edge = ring.extent * kk;
    const dot = selMem && ring.dotOf.get(selMem.id);
    const sf = segFor(state.focus);
    if (!sf) { park(card, ov, W, H); return; }
    const m = dot ? Math.atan2(dot.y, dot.x) : (sf.s.a0 + sf.s.a1) / 2, R = sf.ro;
    const [ax, ay] = dot ? toScr(dot.x, dot.y) : toScr(Math.cos(m) * R, Math.sin(m) * R);
    const [ex, ey] = toScr(Math.cos(m) * (R + 26), Math.sin(m) * (R + 26));
    const right = Math.cos(m) >= 0;
    const x = right ? Math.min(cx + edge + 20, W - 260) : Math.max(cx - edge - 20 - 260, 0);
    dock(card, ov, { ax, ay, ex, ey, right, x, W, H, color: selMem ? card.el.style.getPropertyValue("--fc") : col(state.focus) });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────
  const ro = new ResizeObserver(() => {
    const b = stage.getBoundingClientRect(); W = Math.max(1, b.width); H = Math.max(1, b.height); [rpx, rpy] = clampP(rz, rpx, rpy); place();
    // labels no longer fit (or the wheel is far larger than needed): re-lay out
    clearTimeout(relayT);
    if (ring && builtFor) { const need = needLf(ring.extent); if (need > ring.lf * 1.001 || need < ring.lf * 0.9) relayT = setTimeout(() => { if (!dead) build(); }, 150); }
  });
  ro.observe(stage);
  let prev = { ...state }, prevWin = windowKey();
  const unsub = subscribe((st) => {
    const ch = (k2) => st[k2] !== prev[k2];
    if (ch("focus")) { if (selMem && !opening) zoomHome(); selMem = null; }
    if (ch("hover") || ch("focus") || windowKey() !== prevWin) paint();
    if (ch("agent")) jarvis?.set(st.agent);
    prev = { ...st }; prevWin = windowKey();
    place();
  });
  // Live vault update: the wheel is re-laid out in place (area shares change),
  // zoom and pan stay. An open card is refilled without its entrance fade, a
  // memory card for a deleted memory closes.
  const unData = onData(() => {
    const v = vault(); if (!v || v === builtFor) return;
    const had = !!builtFor;
    build();
    if (!had || !card) return;
    if (selMem) { const m = v.byId.get(selMem.id); if (!m) { closeMem(); return; } selMem = m; }
    cardKey = ""; swapCard = true; place();
  });
  const ready = document.fonts?.load ? Promise.all([document.fonts.load("700 10.5px 'IBM Plex Sans Condensed'"), document.fonts.load("400 9.5px 'IBM Plex Mono'")]).catch(() => {}) : Promise.resolve();
  ready.then(() => { if (!dead) build(); });

  return () => { dead = true; window.removeEventListener("keydown", onKey, true); unMb(); clearTimeout(relayT); clearTimeout(openT); cancelAnimationFrame(raf); ro.disconnect(); unsub(); unData(); jarvis?.destroy(); };
}
