// Shell geometry, taken from the prototype's renderValsDark (rail layout,
// footer "console"). Everything is published as custom properties on .app.
import { isPinned } from "./areas.js";
import { setVars } from "./dom.js";

export function computeLayout(s) {
  const pinAgent = isPinned(s.view);
  const jOpen = pinAgent ? true : s.jOpen;
  const wide = s.vw >= 1280;
  const G = 12, jL = 24 + 64 + G, panelT = 54 + G, stT = panelT;
  const lensW = wide ? 320 : 288;
  const narrowSet = pinAgent && s.vw < 1200;
  const compact = s.vw < 1400;
  const lensOpen = compact ? !!s.lensPeek : s.lensOpen && (s.vw >= 1200 || !jOpen || s.view === "settings");
  const jW = narrowSet ? 300 : 360;
  const cL = jOpen ? jL + jW + 12 : jL;
  const cR = lensOpen && !compact ? 24 + lensW + 12 : 24;
  const podW = jOpen ? jW : 250;
  const fB = pinAgent ? 24 : 92;
  const W = Math.max(240, s.vw - cL - cR), H = Math.max(200, s.vh - stT - fB);
  const panelH = s.vh - panelT - 92;
  return { pinAgent, jOpen, wide, jL, panelT, stT, lensW, compact, lensOpen, jW, cL, cR, podW, fB, W, H, panelH, showTimeline: !pinAgent };
}

export function applyLayout(app, L, s) {
  setVars(app, {
    "--glow-x": `${(L.cL + L.W / 2).toFixed(0)}px`,
    "--glow-y": `${(L.stT + L.H / 2).toFixed(0)}px`,
    "--j-l": `${L.jL}px`,
    "--j-w": `${L.jW}px`,
    "--panel-t": `${L.panelT}px`,
    "--pod-w": `${L.podW}px`,
    "--ft-l": `${L.jL + L.podW + 12}px`,
    "--c-l": `${L.cL}px`,
    "--c-r": `${L.cR}px`,
    "--stage-b": `${L.fB}px`,
    "--lens-b": `${L.fB}px`,
    "--lens-w": `${L.lensW}px`,
    "--face-h": `${Math.round(Math.max(110, Math.min(300, L.panelH * 0.38)))}px`,
    "--caption-size": s.vh < 760 ? "14.5px" : "16.5px",
    "--vp-item-h": s.vh < 620 ? "31px" : s.vh < 720 ? "34px" : s.vh < 860 ? "39px" : "46px",
  });
  app.classList.toggle("is-short", s.vh < 640);
  app.classList.toggle("is-narrow", L.compact);
  app.classList.toggle("is-small", !L.wide);
}
