// Shell geometry, taken from the prototype's renderValsDark (rail layout and
// the footer variants console | mirror | anchored | drawer | island).
// Everything is published as custom properties on .app.
import { isPinned } from "./areas.js";
import { setVars } from "./dom.js";

const FOOTERS = new Set(["console", "mirror", "anchored", "drawer", "island"]);

export function computeLayout(s) {
  const pinAgent = isPinned(s.view);
  const ft = FOOTERS.has(s.footer) ? s.footer : "console";
  const tl = s.timeline === "pulse" ? "pulse" : "bars";
  const isl = ft === "island" || ft === "mirror";
  const jOpen = !isl && pinAgent ? true : s.jOpen;
  const wide = s.vw >= 1280;
  const G = 12,
    jL = 24 + 64 + G,
    panelT = 54 + G,
    stT = panelT;
  const lensW = wide ? 320 : 288;
  const narrowSet = pinAgent && s.vw < 1200;
  const compact = s.vw < 1400;
  const lensOpen = compact ? !!s.lensPeek : s.lensOpen && (s.vw >= 1200 || !jOpen || s.view === "settings");
  const jW = narrowSet ? 300 : 360;
  const cL = jOpen && !isl ? jL + jW + 12 : jL;
  const cR = lensOpen && !compact ? 24 + lensW + 12 : 24;
  const podW = jOpen ? jW : 250;
  const ftM = ft === "mirror",
    ftDw = ft === "drawer" && !pinAgent,
    ftIs = ft === "island";
  const fB = ftM ? 88 : pinAgent || ftIs ? 24 : ftDw ? 76 : 92;
  const W = Math.max(240, s.vw - cL - cR),
    H = Math.max(200, s.vh - stT - fB);
  const panelH = s.vh - panelT - 92;
  const L = {
    pinAgent,
    ft,
    tl,
    jOpen,
    wide,
    jL,
    panelT,
    stT,
    lensW,
    compact,
    lensOpen,
    jW,
    cL,
    cR,
    podW,
    fB,
    W,
    H,
    panelH,
    showTimeline: !pinAgent,
    ftDw,
  };

  // Agent window (prototype apL/apT/apW/ftPanelB) and footer left edge (ftCL).
  L.ag = { l: jL, t: panelT, w: jW, b: ft === "anchored" ? 24 : ftDw ? 76 : 92, below: false };
  L.ftCL = ft === "anchored" ? (jOpen ? cL : jL) : jL + podW + 12;
  L.pod = ft === "console" || (ft === "drawer" && !ftDw);
  if (ftM) {
    const tight = s.vw < 1100,
      lensR = lensOpen && !narrowSet;
    L.mirror = {
      tight,
      lw: tight ? jL - 12 + 64 : jL - 12 + jW,
      padL: tight ? jL - 12 + 14 : 92,
      rw: lensR ? lensW + 12 : Math.min(360, Math.max(240, Math.round(s.vw * 0.22))),
    };
    L.ag.b = 12 + 64 - 1;
  }
  if (ftDw) L.drawer = { l: Math.max(cL, jL), r: cR };
  if (ftIs) {
    const Lx = jL,
      R = s.vw - cR,
      w = Math.min(660, Math.max(560, R - Lx - 48), s.vw - 24);
    const pos = s.isPos || { x: Math.round(Lx + (R - Lx - w) / 2), y: s.vh - 24 - 64 - 24 };
    const x = Math.min(Math.max(jL, pos.x), s.vw - w - 12),
      y = Math.min(Math.max(12, pos.y), s.vh - 64 - 12);
    const pH = Math.min(440, Math.max(300, s.vh - 150));
    let pT = y - pH + 1,
      below = false;
    if (pT < 12) {
      pT = y + 64 - 1;
      below = true;
    }
    L.island = { x, y, w: Math.round(w), wide: w >= 600, below, mini: !!s.isMin };
    L.ag = { l: x, t: pT, w: Math.round(w), b: Math.max(12, s.vh - pT - pH), below };
    if (s.isMin) {
      const mw = 360,
        mh = 52,
        mx = Math.min(Math.max(jL, pos.x), s.vw - mw - 12),
        my = Math.min(Math.max(12, pos.y), s.vh - mh - 12);
      const aH = Math.min(420, Math.max(300, s.vh - 130));
      let aT = my - aH + 1,
        mBelow = false;
      if (aT < 12) {
        aT = my + mh - 1;
        mBelow = true;
      }
      L.island.mx = mx;
      L.island.my = my;
      L.ag = { l: mx, t: aT, w: mw, b: Math.max(12, s.vh - aT - aH), below: mBelow };
    }
  }
  return L;
}

export function applyLayout(app, L, s) {
  const isl = L.island;
  setVars(app, {
    "--glow-x": `${(L.cL + L.W / 2).toFixed(0)}px`,
    "--glow-y": `${(L.stT + L.H / 2).toFixed(0)}px`,
    "--j-l": `${L.jL}px`,
    "--j-w": `${L.jW}px`,
    "--panel-t": `${L.panelT}px`,
    "--pod-w": `${L.podW}px`,
    "--ft-l": `${L.ftCL}px`,
    "--c-l": `${L.cL}px`,
    "--c-r": `${L.cR}px`,
    "--stage-b": `${L.fB}px`,
    "--lens-b": `${L.fB}px`,
    "--lens-w": `${L.lensW}px`,
    "--ag-l": `${L.ag.l}px`,
    "--ag-t": `${L.ag.t}px`,
    "--ag-w": `${L.ag.w}px`,
    "--ag-b": `${L.ag.b}px`,
    "--face-h": isl ? (isl.mini ? "130px" : "150px") : `${Math.round(Math.max(110, Math.min(300, L.panelH * 0.38)))}px`,
    "--caption-size": isl ? (isl.mini ? "16px" : "18px") : s.vh < 760 ? "14.5px" : "16.5px",
    "--vp-item-h": s.vh < 620 ? "31px" : s.vh < 720 ? "34px" : s.vh < 860 ? "39px" : "46px",
  });
  app.classList.toggle("is-short", s.vh < 640);
  app.classList.toggle("is-narrow", L.compact);
  app.classList.toggle("is-small", !L.wide);
  for (const f of ["console", "mirror", "anchored", "drawer", "island"]) app.classList.toggle(`ft-${f}`, L.ft === f);
  app.classList.toggle("ft-nopod", !L.pod);
  app.classList.toggle("ft-mini", !!isl?.mini);
  app.classList.toggle("ft-below", L.ag.below);
  app.classList.toggle("ft-isdrag", !!isl && !!s.isDrag);
}
