// Header: left breadcrumb tab, right status tab, ticker between them and the
// accent trace along their slanted edges (prototype HEADER / TICKER / CORNER ACCENTS).
import { h, s, clear, setVars } from "./dom.js";
import { t, numberFmt } from "./i18n.js";
import { state, setState } from "./state.js";
import { data, dueAt } from "./data.js";
import { openTask } from "./sections/tasks-store.js";
import { getArea } from "./areas.js";
import { placeWeather, weatherPicker } from "./weather-place.js";

const AMB = "#d9a441";
let app, ctxRef, leftTab, crumbEl, rightTab, statMem, statMemD, statLinks, liveBtn, wxT, wxC, lensBtnWrap;
let tkr, tkrIn, tkrNow, tkrRunWrap, tkrTrack, tkrSum, tkrDueN, tkrDueW, tkrNote, acBox, acSvg, tpLayer;
let geo = null, wxBtn, wxPop = null;
const tk = { nudge: 0, paused: false, arm: null, open: null, hold: false, tArm: 0, tClose: 0 };

const slant = (pts, line, cls) => s(`svg.htab-slant.${cls}`, { width: 27, height: 42, viewBox: "0 0 27 42", "shape-rendering": "geometricPrecision" },
  s("polygon.s-fill", { points: pts }), s("polyline.s-line", { points: line }));

export function mountHeader(root, ctx) {
  app = root; ctxRef = ctx;
  crumbEl = h("div.htab-l__body");
  leftTab = h("header.htab-l", null, crumbEl, h("div.htab-l__grow", { "data-tab-grow": "1" }), slant("0,0 27,0 3,42 0,42", "27,0 3,41.5 0,41.5", "htab-slant--l"));

  statMem = h("span.stat__n", { text: "–" }); statMemD = h("span.stat__d");
  statLinks = h("span.stat__n", { text: "–" });
  liveBtn = h("button.live-btn", { title: t("status.liveTitle"), on: { click: () => setState({ live: !state.live }) } }, h("span.dot"), h("span"));
  wxT = h("span.wx__t", { text: "" }); wxC = h("span.wx__c", { text: "" });
  wxBtn = h("button.wx", { type: "button", "aria-expanded": "false", "aria-haspopup": "dialog", on: { click: () => wxPop ? closeWeather() : openWeather() } }, weatherIcon(), wxT, wxC);
  lensBtnWrap = h("span.htab-r__tail");
  rightTab = h("div.htab-r", null,
    slant("0,0 27,0 27,42 24,42", "0,0 24,41.5 27,41.5", "htab-slant--r"),
    h("div.htab-r__body", null,
      h("span.stat.stat--mem", null, statMem, h("span.stat__u", { text: t("status.mem") }), statMemD), h("span.vsep"),
      h("span.stat.stat--links", null, statLinks, h("span.stat__u", { text: t("status.links") })), h("span.vsep"),
      liveBtn, h("span.vsep.wx-sep"),
      wxBtn,
      lensBtnWrap));

  tkrNow = h("div.tkr__now", null, h("span.dot.dot--pulse"), h("span", { text: t("ticker.now") }));
  tkrTrack = h("div.tkr__track", { "data-tkr-track": "1", on: { mouseenter: () => { tk.paused = true; syncPlay(); }, mouseleave: () => { tk.paused = false; syncPlay(); } } });
  // Notices (state.toast) take the running-text area for a few seconds, see renderNote.
  tkrNote = h("div.tkr__note", { role: "status", "aria-live": "polite", on: { mouseenter: () => holdNote("hover", true), mouseleave: () => holdNote("hover", false) } });
  tkrRunWrap = h("div.tkr__run", null, tkrTrack, tkrNote);
  tkrDueN = h("span.n-amber"); tkrDueW = h("span", { text: t("ticker.due") });
  tkrSum = h("div.tkr__sum", null, h("button", { on: { click: () => setState({ view: "tasks", tab: "areas" }) } }, tkrDueN, tkrDueW));
  tkrIn = h("div.tkr__in", null, tkrNow, tkrRunWrap, tkrSum);
  tkr = h("div.tkr", { "data-tkr-bar": "1" }, tkrIn);
  // The glow pulse runs on the svg's own layer (opacity only), the fade-in on
  // the box around it — so the drop-shadow is not re-rastered every frame.
  acSvg = s("svg.ac__glow", { width: "100%", height: 70, "shape-rendering": "geometricPrecision" });
  acBox = h("div.ac", null, acSvg);
  tpLayer = h("div");

  app.append(leftTab, rightTab, tkr, tpLayer, acBox);
  document.addEventListener("pointerdown", (e) => { if (wxPop && !wxPop.contains(e.target) && !wxBtn.contains(e.target)) closeWeather(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && wxPop) { e.preventDefault(); e.stopImmediatePropagation(); closeWeather(); wxBtn.focus(); } }, true);
  document.addEventListener("visibilitychange", () => holdNote("tab", document.hidden));
  const ro = new ResizeObserver(() => measure());
  ro.observe(leftTab); ro.observe(rightTab);
  window.addEventListener("resize", () => requestAnimationFrame(measure));
}

function closeWeather() {
  wxPop?.remove(); wxPop = null; wxBtn.setAttribute("aria-expanded", "false");
}

function positionWeather() {
  if (!wxPop) return;
  const r = wxBtn.getBoundingClientRect(), a = app.getBoundingClientRect();
  const x = Math.max(12, Math.min(r.right - a.left - wxPop.offsetWidth, a.width - wxPop.offsetWidth - 12));
  setVars(wxPop, { "--wx-x": `${x}px`, "--wx-y": `${r.bottom - a.top + 8}px` });
}

function openWeather() {
  wxPop = h("div.wx-pop", { role: "dialog", "aria-label": t("status.weatherPlace") }, weatherPicker(placeWeather(), closeWeather));
  app.append(wxPop); wxBtn.setAttribute("aria-expanded", "true"); positionWeather();
  wxPop.querySelector("input")?.focus();
}

function weatherIcon() {
  return s("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" },
    ...["M12 2v2", "m4.93 4.93 1.41 1.41", "M20 12h2", "m19.07 4.93-1.41 1.41", "M15.947 12.65a4 4 0 0 0-5.925-4.128", "M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"].map((d) => s("path", { d })));
}

// ── left tab: vault name / view [/ filter] ───────────────────────────────
let crumbBrand = null;
const brandText = () => data.vaultName || t("brand");
function renderCrumb() {
  crumbBrand = brandText();
  const crumbs = [h("span.htab-l__brand", { text: crumbBrand }), h("span.htab-l__sep", { text: "/" }), h("span.htab-l__view", { text: ctxRef.viewLabel(state.view) })];
  // The area filter only applies to the vault views; other areas show no filter crumb.
  if (state.focus && state.vw >= 1400 && getArea(state.view)?.group === "vault-view") {
    crumbs.push(h("span.htab-l__sep", { text: "/" }), h("button.htab-l__crumb", { title: t("crumb.clear"), vars: { color: ctxRef.areaColor(state.focus) }, on: { click: () => setState({ focus: null }) } }, state.focus));
  }
  clear(crumbEl).append(...crumbs);
}

// ── right tab ─────────────────────────────────────────────────────────────
function renderStatus(L) {
  const hl = data.health;
  statMem.textContent = hl && Number.isFinite(hl.vault_size) ? numberFmt.format(hl.vault_size).replace(/\./g, " ").replace(/,/g, " ") : "–";
  statMemD.textContent = data.newMemories ? `+${data.newMemories}` : "";
  statLinks.textContent = data.edges ? numberFmt.format(data.edges).replace(/\./g, " ").replace(/,/g, " ") : "–";
  liveBtn.classList.toggle("is-on", state.live);
  liveBtn.lastChild.textContent = state.live ? t("status.liveNew", { n: data.newSince }) : t("status.liveOff");
  const w = ctxRef.weather();
  const place = placeWeather().getPlace();
  wxT.textContent = w ? `${Math.round(w.temp)}°` : place ? "–" : t("status.weatherPlace");
  wxBtn.title = t("status.weatherPlace");
  wxBtn.classList.toggle("is-empty", !place);
  wxC.textContent = w?.city || place?.name || "";
  positionWeather();
  clear(lensBtnWrap);
  if (!L.lensOpen || L.compact) {
    const b = h("button.lens-btn", { title: t("status.panel"), "aria-label": t("status.panel"), cls: L.compact && L.lensOpen ? "is-on" : "",
      on: { click: () => ctxRef.toggleLens(), mouseenter: () => ctxRef.lensPeekIn(), mouseleave: () => ctxRef.lensPeekOut() } },
      s("svg", { viewBox: "0 0 24 24" }, s("path", { d: "M15 5l-7 7 7 7" })));
    lensBtnWrap.append(b);
  }
}

// ── ticker ────────────────────────────────────────────────────────────────
function tickerItems() {
  return data.dueTasks.map((task) => {
    const at = dueAt(task);
    const time = at ? new Date(at).toLocaleTimeString(document.documentElement.lang, { hour: "2-digit", minute: "2-digit", timeZone: task.timezone || undefined }) : "";
    const full = at ? new Date(at).toLocaleString(document.documentElement.lang, { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: task.timezone || undefined }) : "";
    return { tag: t("ticker.task"), color: AMB, text: task.goal, meta: time,
      pv: { tag: t("ticker.taskDue"), title: task.goal, sub: `${full} · ${task.origin === "agent" ? t("ticker.byAgent") : t("ticker.byUser")}`, body: typeof task.request === "string" && task.request ? `„${task.request}“` : "", whyLabel: t("ticker.whyNow"), why: t("ticker.whyDefault"), openLabel: t("ticker.openTask"), ask: t("ticker.askTask", { goal: task.goal }) },
      onClick: () => openTask(task.id) };
  });
}

let lastItemsKey = "";
function renderTicker() {
  const avail = geo ? geo.R - geo.L : 0;
  const show = avail >= 200;
  // A notice needs the running-text area: it is shown even where the ticker
  // would hide it; below 200 px JETZT and the sum make room for it.
  tkr.hidden = !show && !note.on;
  tkrNow.lastChild.hidden = avail < 230;
  tkrRunWrap.hidden = avail < 300 && !note.on;
  tkrNow.hidden = tkrSum.hidden = !show && note.on;
  tkrDueW.hidden = avail < 280;
  tkrDueN.textContent = String(data.dueTasks.length);
  const items = tickerItems();
  const key = JSON.stringify(items.map((i) => [i.text, i.meta]));
  if (key !== lastItemsKey) {
    lastItemsKey = key; tk.nudge = 0; tk.open = null; tk.arm = null; clear(tpLayer);
    clear(tkrTrack);
    if (!items.length) tkrTrack.append(h("span.tkr__empty", { text: t("ticker.empty") }));
    else [...items, ...items].forEach((it, i) => tkrTrack.append(tickerButton(it, i)));
    setVars(tkrTrack, { "--tkr-dur": `${Math.max(24, items.length * 7)}s`, "--tkr-nudge": "0px" });
    tkrTrack.classList.toggle("is-static", !items.length);
  }
  syncPlay();
}

function tickerButton(it, i) {
  const b = h("button.tkr__item", { vars: { "--c": it.color }, on: {
    click: it.onClick,
    mouseenter: (e) => armPreview(e.currentTarget, it, i),
    mouseleave: () => { clearTimeout(tk.tArm); if (tk.arm === i) { tk.arm = null; b.querySelector(".tkr__arm")?.remove(); } if (tk.open === i) { clearTimeout(tk.tClose); tk.tClose = setTimeout(closePreview, 260); } },
  } },
    h("span.tkr__dia"), h("span.tkr__tag", { text: it.tag }), h("span.tkr__text", { text: it.text }), h("span.tkr__meta", { text: it.meta }));
  return b;
}

function syncPlay() {
  const items = data.dueTasks.length;
  tkrTrack.classList.toggle("is-paused", !items || tk.paused || tk.open !== null || tk.hold || note.on);
}

// ── notices ───────────────────────────────────────────────────────────────
// Every short confirmation or error (state.toast: a string, or
// { text, tone: "error" }) appears centred in the running-text area only
// (between JETZT and the sum): the running text fades out, the notice stays
// with a timer line, then the running text returns.
// Hover and a hidden browser tab pause the timer; a new notice replaces the
// current one. One timeout per notice, no loop.
const note = { on: false, shown: null, left: 0, since: 0, timer: 0, outT: 0, hover: false, tab: false };
function holdNote(kind, val) {
  note[kind] = val;
  if (!note.on) return;
  const hold = note.hover || note.tab;
  tkrNote.classList.toggle("is-held", hold);
  clearTimeout(note.timer);
  if (hold) { if (note.since) note.left -= Date.now() - note.since; note.since = 0; }
  else { note.since = Date.now(); note.timer = setTimeout(() => setState({ toast: "" }), Math.max(0, note.left)); }
}

function renderNote() {
  const v = state.toast;
  if (v === note.shown) return;
  note.shown = v;
  const text = typeof v === "string" ? v : v?.text || "";
  clearTimeout(note.timer); clearTimeout(note.outT);
  if (!text) {
    if (!note.on) return;
    note.on = false; tkr.classList.remove("has-note"); syncPlay();
    // Content goes after the fade-out; a following notice cancels this.
    note.outT = setTimeout(() => { clear(tkrNote); renderTicker(); }, 400);
    return;
  }
  const ms = Math.min(12000, Math.max(6000, 2000 + text.length * 60));
  const err = typeof v === "object" && v.tone === "error";
  const bar = h("span.tkr__note-bar");
  setVars(bar, { "--note-ms": `${ms}ms` });
  clear(tkrNote).append(h("span.tkr__note-in", { title: text },
    h("span.tkr__note-p", { text: "›" }), h("span.tkr__note-t", { text })),
  h("button.tkr__note-x", { type: "button", "aria-label": t("toast.close"), text: "×", on: { click: () => setState({ toast: "" }) } }), bar);
  tkrNote.classList.toggle("is-err", err);
  tkrNote.classList.remove("is-held");
  note.on = true; note.left = ms; note.since = 0;
  if (tk.open !== null) closePreview();
  renderTicker();
  tkr.classList.add("has-note"); syncPlay();
  holdNote("tab", document.hidden);
}

function armPreview(el, it, i) {
  clearTimeout(tk.tClose); clearTimeout(tk.tArm);
  if (tk.open !== null && tk.open !== i) closePreview();
  tk.arm = i;
  el.querySelector(".tkr__arm")?.remove();
  el.prepend(h("span.tkr__arm"));
  tk.tArm = setTimeout(() => {
    const track = tkrTrack, vp = tkrRunWrap;
    const r = el.getBoundingClientRect(), o = app.getBoundingClientRect(), v = vp.getBoundingClientRect(), pad = v.width * 0.06 + 6;
    let d = 0; if (r.right > v.right - pad) d = r.right - (v.right - pad); if (r.left - d < v.left + pad) d = r.left - (v.left + pad);
    d = Math.round(d);
    const half = track.scrollWidth / 2 || 1;
    const open = () => { el.querySelector(".tkr__arm")?.remove(); tk.arm = null; tk.open = i; el.classList.add("is-open"); syncPlay(); showPreview(it, { il: r.left - d - o.left, iw: r.width, rootW: o.width }); };
    if (d) { tk.nudge = (tk.nudge + d) % half; tk.hold = true; setVars(track, { "--tkr-nudge": `${-tk.nudge}px` }); syncPlay(); setTimeout(open, 190); } else open();
  }, 1000);
}

function closePreview() {
  clearTimeout(tk.tClose);
  tk.open = null; tk.hold = false;
  tkrTrack.querySelectorAll(".tkr__item.is-open").forEach((x) => x.classList.remove("is-open"));
  clear(tpLayer); syncPlay();
}

function showPreview(it, m) {
  if (!geo) return;
  const RW = m.rootW || state.vw, il = Math.round(m.il) + 0.5, iw = Math.round(m.iw) - 1;
  const lo = Math.max(24, Math.round(geo.L)), hi = Math.min(RW - 24, Math.round(geo.R));
  const w = Math.round(Math.max(Math.min(300, RW - 48), Math.min(hi - lo, Math.max(400, iw + 56))));
  const x = Math.round(Math.max(lo, Math.min(hi - w, il + iw / 2 - w / 2))) + 0.5;
  const dxL = il - x, dxR = x + w - 1 - (il + iw), dy = Math.round(Math.max(16, Math.min(42, Math.max(dxL, dxR) * 0.55)));
  const yF = 54 + dy, xr = (x + w - 1).toFixed(1), ir = (il + iw).toFixed(1);
  const enter = () => clearTimeout(tk.tClose);
  const leave = () => { clearTimeout(tk.tClose); tk.tClose = setTimeout(closePreview, 260); };
  const flare = `M ${il} 53 L ${ir} 53 L ${ir} 54 L ${xr} ${yF + 0.5} L ${x} ${yF + 0.5} L ${il} 54 Z`;
  const svg = s("svg.tp__svg", { width: RW, height: yF + 2, "shape-rendering": "geometricPrecision" },
    s("defs", null, s("linearGradient", { id: "tpNeck", x1: 0, y1: 0, x2: 0, y2: 1 }, s("stop.tp__stop", { offset: 0, "stop-opacity": ".16" }), s("stop.tp__stop", { offset: 1, "stop-opacity": ".05" }))),
    s("path.tp__flare", { d: flare, on: { mouseenter: enter, mouseleave: leave } }),
    s("path.tp__flare-tint", { d: flare, fill: "url(#tpNeck)" }),
    s("rect.tp__neck", { x: il.toFixed(1), y: 13, width: iw.toFixed(1), height: 41, fill: "url(#tpNeck)" }),
    s("path.tp__line", { d: `M ${il} 13 L ${il} 54 L ${x} ${yF} L ${x} ${yF + 1}`, pathLength: 1000 }),
    s("path.tp__line", { d: `M ${ir} 13 L ${ir} 54 L ${xr} ${yF} L ${xr} ${yF + 1}`, pathLength: 1000 }));
  const pv = it.pv;
  const card = h("div.tp__card", { vars: { "--tp-x": `${x - 0.5}px`, "--tp-y": `${yF}px`, "--tp-w": `${w}px`, "--c": it.color }, on: { mouseenter: enter, mouseleave: leave } },
    h("div.tp__tex"), h("span.tp__scan"),
    h("div.tp__head", null, h("span.tp__tagw", null, h("span.tp__dia"), h("span.tp__tag", { text: pv.tag })), h("span.tp__meta", { text: it.meta })),
    h("div.tp__body", null,
      h("div.tp__row", null, h("div.tp__title", { text: pv.title }), h("div.tp__sub", { text: pv.sub })),
      pv.body ? h("p.tp__quote", { text: pv.body }) : null,
      h("div.tp__why", null, h("div.tp__why-l", null, h("span.dot"), pv.whyLabel), h("div.tp__why-t", { text: pv.why }))),
    h("div.tp__acts", null,
      h("button", { text: `${pv.openLabel} →`, on: { click: () => { closePreview(); it.onClick(); } } }),
      h("button", { text: t("ticker.ask"), on: { click: () => { closePreview(); ctxRef.ask(pv.ask); } } })));
  clear(tpLayer).append(h("div.tp", null, svg, card));
}

// ── geometry + accent trace ───────────────────────────────────────────────
function measure() {
  const gr = leftTab.querySelector("[data-tab-grow]");
  const L = Math.round(leftTab.getBoundingClientRect().right - (gr ? gr.getBoundingClientRect().width : 0));
  const R = Math.round(rightTab.getBoundingClientRect().left);
  if (geo && geo.L === L && geo.R === R) return;
  geo = { L, R };
  setVars(tkr, { "--tkr-l": `${Math.round(L - 25)}px`, "--tkr-r": `${Math.round(state.vw - (R + 25))}px` });
  renderAccent();
  renderTicker();
}

function renderAccent() {
  const L = geo.L, R = geo.R, yt = 12.5, yb = 53.5, vw = state.vw;
  const PL = (u) => [L - 24 + 24 * u, yb - 41.5 * u], PR = (u) => [R + 24 - 24 * u, yb - 41.5 * u];
  const f = (pt) => pt.map((v) => v.toFixed(2)).join(" ");
  const uA = 0.33, uF = 0.8, bA = 13, bFL = L - 24 - 13, bFR = vw - 13 - (R + 24);
  const avail = R - L;
  const grad = (id, x1, y1, x2, y2, stops) => s("linearGradient", { id, gradientUnits: "userSpaceOnUse", x1, y1, x2, y2 }, ...stops.map(([o, a]) => s("stop.ac__stop", { offset: o, "stop-opacity": a })));
  const fade4 = [[0, 0], [".55", ".18"], [".85", ".5"], [1, 1]];
  const fo1 = Math.max(0, Math.min(1, (L - 24 - bA - 13) / Math.max(1, vw - 26))).toFixed(4);
  const fo2 = Math.max(0, Math.min(1, (R + 24 + bA - 13) / Math.max(1, vw - 26))).toFixed(4);
  const full = `M 13 ${yb} L ${f(PL(0))} L ${L.toFixed(2)} ${yt} L ${R.toFixed(2)} ${yt} L ${f(PR(0))} L ${(vw - 13).toFixed(2)} ${yb}`;
  clear(acSvg).append(
    s("defs", null,
      grad("acLb", (L - 24 - bFL).toFixed(2), yb, (L - 24 - bA).toFixed(2), yb, fade4),
      grad("acLs", PL(uF)[0].toFixed(2), PL(uF)[1].toFixed(2), PL(uA)[0].toFixed(2), PL(uA)[1].toFixed(2), [[0, 0], [1, 1]]),
      grad("acRb", (R + 24 + bFR).toFixed(2), yb, (R + 24 + bA).toFixed(2), yb, fade4),
      grad("acRs", PR(uF)[0].toFixed(2), PR(uF)[1].toFixed(2), PR(uA)[0].toFixed(2), PR(uA)[1].toFixed(2), [[0, 0], [1, 1]]),
      grad("acFull", 13, 0, (vw - 13).toFixed(2), 0, [[0, 0], [fo1, 1], [fo2, 1], [1, 0]])),
    s("g", null,
      s("path.ac__solid", { d: `M ${f(PL(uA))} L ${f(PL(0))} L ${(L - 24 - bA).toFixed(2)} ${yb}` }),
      s("path.ac__fade", { d: `M ${(L - 24 - bFL).toFixed(2)} ${yb} L ${(L - 24 - bA).toFixed(2)} ${yb}`, stroke: "url(#acLb)" }),
      s("path.ac__fade", { d: `M ${f(PL(uF))} L ${f(PL(uA))}`, stroke: "url(#acLs)" }),
      s("path.ac__solid", { d: `M ${f(PR(uA))} L ${f(PR(0))} L ${(R + 24 + bA).toFixed(2)} ${yb}` }),
      s("path.ac__fade", { d: `M ${(R + 24 + bFR).toFixed(2)} ${yb} L ${(R + 24 + bA).toFixed(2)} ${yb}`, stroke: "url(#acRb)" }),
      s("path.ac__fade", { d: `M ${f(PR(uF))} L ${f(PR(uA))}`, stroke: "url(#acRs)" }),
      avail >= 150 ? s("path.ac__full", { d: full, stroke: "url(#acFull)" }) : null));
  setVars(acBox, { "--ac-op": 1 });
}

export function updateHeader(L, changed) {
  // Data only re-renders the crumb when the vault name changed, so the
  // regular polls don't replay the crumb animation.
  const brandChanged = changed.has("data") && brandText() !== crumbBrand;
  if (changed.has("view") || changed.has("focus") || changed.has("vw") || brandChanged) renderCrumb();
  renderStatus(L);
  if (changed.has("data") || changed.has("init")) renderTicker();
  if (changed.has("toast")) renderNote();
  if (changed.has("vw") || changed.has("init") || changed.has("view") || brandChanged) requestAnimationFrame(measure);
}
