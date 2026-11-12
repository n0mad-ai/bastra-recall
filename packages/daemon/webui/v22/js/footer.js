// Footer variants (prototype ui.footer): console (default) | anchored |
// mirror | drawer | island. Every variant shows the timeline as bars or pulse
// (ui.timeline). Free build: no microphone and no LIVE button.
import { h, s, clear, setVars } from "./dom.js";
import { t } from "./i18n.js";
import { state, setState } from "./state.js";
import { mountJarvis } from "../vendor/jarvis-v13.js";
import { mountNavAgent } from "./nav.js";
import { ask, podInfo, onPodChange } from "./agent.js";
import { makeGraph, timeOpts, summary, axis, timeLabel } from "./timeline.js";

let Lc = null;
const C = {}, A = {}, M = {}, D = {}, I = {}, N = {};

const orb = () => h("span.orb", null, h("span.orb__ring"), h("span.orb__rim"), h("span.orb__core"));
const toggleAgent = () => setState({ jOpen: !Lc.jOpen });
const podTitle = () => (Lc.pinAgent ? t("agent.name") : Lc.jOpen ? t("pod.title.close") : t("pod.title.open"));

export function mountFooter(app) {
  // console / anchored: timeline right of the pod
  C.opts = h("div.tl__opts"); C.sum = h("span.tl__sum"); C.vsep = h("span.tl__vsep");
  C.graph = makeGraph("console"); C.axis = h("div.tl__axis");
  C.chart = h("div.tl__chart", null, C.graph.el, C.axis);
  C.el = h("div.tl", null, h("div.tl__in", null, h("div.tl__ctl", null, C.opts, C.sum), C.vsep, C.chart));

  // anchored: Recall docked in the navigation rail
  A.canvas = h("canvas");
  A.label = h("span.nav-agent__l", { text: "RECALL" });
  A.el = h("button.nav-agent", { on: { click: toggleAgent } }, h("span.nav-agent__face", null, A.canvas), A.label);
  A.el.hidden = true;
  mountNavAgent(A.el);

  // mirror: agent bar across the bottom, the window folds up out of it
  M.orb = orb(); M.state = h("span.fm__state"); M.line = h("span.fm__line");
  M.txt = h("span.fm__txt", null, M.state, M.line);
  M.agent = h("button.fm__agent", { on: { click: toggleAgent } }, h("span.fm__orb", null, M.orb), M.txt);
  M.input = h("input", { placeholder: t("agent.ask"), "aria-label": t("agent.askLong"), on: {
    keydown: (e) => { if (e.key === "Enter" && M.input.value.trim()) mirrorSend(); if (e.key === "Escape") M.input.blur(); },
    focus: () => { M.input.placeholder = t("agent.askLong"); },
    blur: () => { if (!M.input.value) M.input.placeholder = t("agent.ask"); },
  } });
  M.exp = h("button.fm__exp", { on: { click: toggleAgent } }, h("span", { text: "▴" }));
  M.opts = h("span.fm__opts"); M.graph = makeGraph("mirror"); M.axis = h("div.ft-axis.ft-axis--mirror");
  M.time = h("div.fm__time", null, h("div.fm__head", null, M.lab = h("span.fm__lab", { text: t("tl.updated") }), M.opts), M.graph.el, M.axis);
  M.el = h("div.fm", null, M.agent,
    h("div.fm__mid", null, h("div.fm__in", null, M.input,
      h("button.agent__send", { "aria-label": t("agent.send"), on: { click: mirrorSend } }, s("svg", { viewBox: "0 0 24 24" }, s("path", { d: "M5 12h14M13 6l6 6-6 6" })))), M.exp),
    M.time);

  // drawer: slim bar, the timeline opens above it
  D.opts = h("span.fd__opts"); D.sum = h("span.fd__sum"); D.graph = makeGraph("drawer"); D.axis = h("div.ft-axis.ft-axis--drawer");
  D.panel = h("div.fd", null, h("div.fd__head", null, h("span.fd__lab", { text: t("tl.updated") }), D.opts, D.sum), D.graph.el, D.axis);
  D.orb = orb(); D.state = h("span.fdb__state"); D.line = h("span.fdb__line"); D.btnSum = h("span.fdb__sum");
  D.agent = h("button.fdb__agent", { on: { click: toggleAgent } }, h("span.fdb__orb", null, D.orb), D.state);
  D.btn = h("button.fdb__tl", { title: t("ft.timeline"), on: { click: () => setState({ ftDw: !state.ftDw }) } },
    h("span", { text: t("ft.timelineCaps") }), D.btnSum, h("span.fdb__chev", { text: "▴" }));
  D.bar = h("div.fdb", null, D.agent, D.line, D.btn);

  // island: floating, draggable; minimized = compact agent bar
  I.orb = orb(); I.lab = h("span.fi__lab", { text: "RECALL" });
  I.agent = h("button.fi__agent", { on: { click: toggleAgent } }, h("span.fi__orb", null, I.orb), I.lab);
  I.noTime = h("div.fi__notime");
  I.graph = makeGraph("island"); I.axis = h("div.ft-axis.ft-axis--island");
  I.time = h("div.fi__time", null, I.graph.el, I.axis);
  I.opts = h("span.fi__opts"); I.sum = h("span.fi__sum");
  I.ctl = h("div.fi__ctl", null, I.opts, I.sum);
  I.el = h("div.fi", null,
    h("div.fi__grab", { title: t("ft.isDrag"), on: { pointerdown: islandDown, dblclick: islandReset } }, h("span.fi__dots")),
    h("span.fi__marks"), I.agent, I.noTime, I.time, I.ctl,
    h("button.fi__min", { title: t("ft.isMin"), text: "–", on: { click: () => setState({ isMin: true }) } }));
  N.orb = orb(); N.state = h("span.fim__state"); N.line = h("span.fim__line");
  N.agent = h("button.fim__agent", { on: { click: toggleAgent } }, h("span.fim__orb", null, N.orb), h("span.fim__txt", null, N.state, N.line));
  N.el = h("div.fim", null,
    h("div.fi__grab.fim__grab", { title: t("ft.isDragMini"), on: { pointerdown: islandDown } }, h("span.fi__dots")),
    N.agent,
    h("button.fim__exp", { title: t("ft.isExpand"), on: { click: () => setState({ isMin: false }) } },
      s("svg", { viewBox: "0 0 24 24" }, s("path", { d: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" }))));

  for (const el of [C.el, M.el, D.panel, D.bar, I.el, N.el]) el.hidden = true;
  app.append(C.el, M.el, D.panel, D.bar, I.el, N.el);
  onPodChange(() => Lc && renderPod());
}

function mirrorSend() { const q = M.input.value.trim(); if (!q) return; M.input.value = ""; M.input.blur(); ask(q); }

function islandDown(e) {
  e.preventDefault();
  const g = Lc.island.mini ? { x: Lc.island.mx, y: Lc.island.my } : { x: Lc.island.x, y: Lc.island.y };
  const ox = e.clientX - g.x, oy = e.clientY - g.y;
  setState({ isDrag: true, isPos: { x: g.x, y: g.y } });
  const mv = (ev) => setState({ isPos: { x: ev.clientX - ox, y: ev.clientY - oy } });
  const up = () => {
    window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
    setState({ isDrag: false });
    try { localStorage.setItem("recall-v22-island", JSON.stringify(state.isPos)); } catch { /* storage blocked */ }
  };
  window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
}

function islandReset() {
  try { localStorage.removeItem("recall-v22-island"); } catch { /* storage blocked */ }
  setState({ isPos: null });
}

let railFace = null;

export function render(L) {
  Lc = L;
  const ft = L.ft, tl = L.tl;
  const showC = L.showTimeline && (ft === "console" || ft === "anchored");
  C.el.hidden = !showC; A.el.hidden = ft !== "anchored";
  M.el.hidden = ft !== "mirror"; D.panel.hidden = D.bar.hidden = !L.ftDw;
  I.el.hidden = ft !== "island" || L.island.mini; N.el.hidden = ft !== "island" || !L.island.mini;

  if (showC) {
    C.el.classList.toggle("tl--pulse", tl === "pulse");
    timeOpts(C.opts).prepend(h("span.tl__lab", { text: timeLabel() }));
    C.sum.textContent = summary();
    const on = tl === "pulse" || state.vw - (L.jL + L.podW + 12) - 24 >= 520;
    C.vsep.hidden = !on; C.chart.hidden = !on;
    if (on) { C.graph.update(tl); axis(C.axis, "full"); }
  }
  if (ft === "anchored") {
    if (!railFace) railFace = mountJarvis(A.canvas, { scale: 0.42, points: 260 });
    railFace.setActive(true);
    A.el.title = podTitle();
    A.el.classList.toggle("is-on", L.jOpen);
  } else railFace?.setActive(false);
  if (ft === "mirror") {
    M.el.classList.toggle("is-tight", L.mirror.tight);
    M.el.classList.toggle("is-open", L.jOpen);
    setVars(M.el, { "--fm-lw": `${L.mirror.lw}px`, "--fm-padl": `${L.mirror.padL}px`, "--fm-rw": `${L.mirror.rw}px` });
    M.agent.title = podTitle();
    M.exp.title = L.jOpen ? t("pod.title.close") : t("ft.expand");
    M.time.hidden = L.pinAgent;
    if (!L.pinAgent) { M.lab.textContent = timeLabel(); timeOpts(M.opts); M.graph.update(tl); axis(M.axis, "mirror"); }
  }
  if (L.ftDw) {
    const open = !!state.ftDw;
    D.panel.classList.toggle("is-open", open); D.bar.classList.toggle("is-open", open);
    setVars(D.panel, { "--fd-l": `${L.drawer.l}px`, "--fd-r": `${L.drawer.r}px` });
    D.agent.title = podTitle();
    timeOpts(D.opts); D.sum.textContent = D.btnSum.textContent = summary();
    D.graph.update(tl); axis(D.axis, "full");
  }
  if (ft === "island") {
    const g = L.island, el = g.mini ? N.el : I.el;
    setVars(el, { "--fi-x": `${g.mini ? g.mx : g.x}px`, "--fi-y": `${g.mini ? g.my : g.y}px`, "--fi-w": `${g.w}px` });
    el.classList.toggle("is-drag", !!state.isDrag);
    el.classList.toggle("is-seam-t", L.jOpen && !g.below);
    el.classList.toggle("is-seam-b", L.jOpen && g.below);
    I.agent.title = N.agent.title = podTitle();
    if (!g.mini) {
      I.lab.hidden = !g.wide;
      I.noTime.hidden = !L.pinAgent; I.time.hidden = I.ctl.hidden = L.pinAgent;
      if (!L.pinAgent) { I.graph.update(tl); axis(I.axis, g.wide ? "full" : "short"); timeOpts(I.opts); I.sum.textContent = summary(); }
    }
  }
  renderPod();
}

// Agent status in the variant bars (prototype stateColor / stateLabel / podText).
function renderPod() {
  const p = podInfo(), L = Lc;
  for (const o of [M.orb, D.orb, I.orb, N.orb]) o.classList.toggle("is-fast", p.busy);
  for (const el of [M.el, D.bar, I.el, N.el, A.el]) setVars(el, { "--state-c": p.color });
  if (railFace) railFace.set(state.agent);
  if (L.ft === "mirror") { M.state.textContent = p.state; M.line.textContent = p.text; M.txt.hidden = L.mirror.tight; }
  if (L.ftDw) { D.state.textContent = p.state; D.line.textContent = p.text; }
  if (L.ft === "island") { I.noTime.textContent = p.text; N.state.textContent = p.state; N.line.textContent = p.text; }
}
