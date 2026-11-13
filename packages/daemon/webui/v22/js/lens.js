// Right panel ("lens"): tabs per area, the Areas list for vault views,
// active-row marker on the outer edge, report links at the bottom.
import { h, s, clear, setVars } from "./dom.js";
import { t, numberFmt } from "./i18n.js";
import { state, setState } from "./state.js";
import { data } from "./data.js";
import { getArea } from "./areas.js";
import { signalsTab } from "./views/signals.js";
import { panelIndicator } from "./panel-indicator.js";
import { liveTab } from "./views/live-tab.js";

// Vault views (no tabs of their own): Areas, Signals, View, Live.
const VAULT_TABS = [{ id: "areas", labelKey: "lens.areas", render: (b) => { b.append(areasTab()); } },
  { id: "signals", labelKey: "lens.signals", render: (b) => signalsTab(b) }, { id: "view", labelKey: "lens.view" }, liveTab];
// A vault view may fill the View tab (registerArea({ viewTab: render })).
const tabsOf = (view) => {
  const a = getArea(view);
  if (a?.tabs) return a.tabs;
  return a?.viewTab ? VAULT_TABS.map((x) => (x.id === "view" ? { ...x, render: a.viewTab } : x)) : VAULT_TABS;
};

// Footer icons, same drawings as the old UI's #feedback-row.
const strokes = (...lines) => s("g", { stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round" },
  lines.map(([x1, y1, x2, y2]) => s("line", { x1, y1, x2, y2 })));
const outline = (d) => s("path", { d, fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linejoin": "round" });
const bugIcon = () => s("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" },
  outline("M9 10a3 3 0 0 1 6 0v4a3 3 0 0 1-6 0Z"),
  strokes([12, 7, 12, 5], [9, 8, 7, 6], [15, 8, 17, 6], [8.6, 12, 5.5, 12], [15.4, 12, 18.5, 12], [9, 16, 7, 18], [15, 16, 17, 18]));
const ideaIcon = () => s("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" },
  outline("M12 3a6 6 0 0 0-3.9 10.55c.7.62.9 1.45.9 2.45h6c0-1 .2-1.83.9-2.45A6 6 0 0 0 12 3Z"),
  strokes([10, 19, 14, 19], [10.6, 21.5, 13.4, 21.5]));

let peek, lens, tabsEl, body, indLayer, lpT = 0, ctxRef;

export function mountLens(app, ctx) {
  ctxRef = ctx;
  peek = h("div.lens-peek", { on: { mouseenter: peekIn, mouseleave: peekOut } });
  tabsEl = h("div.lens__tabs");
  body = h("div.lens__body");
  lens = h("aside.lens", { on: { mouseenter: peekIn, mouseleave: peekOut } }, tabsEl, body,
    h("div.lens__foot", null,
      h("a", { href: "https://github.com/n0mad-ai/bastra-recall/issues/new?template=bug_report.yml", target: "_blank", rel: "noopener" }, bugIcon(), t("lens.bug")),
      h("span.lens__foot-sep", { text: "·" }),
      h("a", { href: "https://github.com/n0mad-ai/bastra-recall/issues/new?template=feature_request.yml", target: "_blank", rel: "noopener" }, ideaIcon(), t("lens.idea"))));
  indLayer = h("div");
  app.append(peek, lens, indLayer);
  measureInd = panelIndicator(indLayer, lens, body, () => lens.classList.contains("is-open"));
}

export function peekIn() { clearTimeout(lpT); if (!state.lensPeek) setState({ lensPeek: true }); }
export function peekOut() { if (state.vw >= 1400) return; clearTimeout(lpT); lpT = setTimeout(() => setState({ lensPeek: false }), 380); }

export function toggleLens(L) {
  if (L.compact) setState({ lensPeek: !L.lensOpen });
  else setState({ lensOpen: !L.lensOpen, jOpen: !L.lensOpen && state.vw < 1200 ? false : state.jOpen });
}

export function color(key) {
  const i = data.clusters.findIndex((c) => c.key === key);
  return i < 0 ? "rgba(160,180,205,1)" : `hsla(${((i * 137.508 + 205) % 360).toFixed(1)}, 78%, 66%, 1)`;
}

function wip() {
  return h("div.lens__wip", null, h("span.wip-badge", { text: t("wip") }), h("p", { text: t("wip.panel") }));
}

function areasTab() {
  const total = data.clusters.reduce((x, c) => x + c.count, 0);
  const max = Math.max(1, ...data.clusters.map((c) => c.count));
  const q = state.filter.trim().toLowerCase();
  const filter = h("input", { placeholder: t("lens.filterAreas"), value: state.filter, on: { input: (e) => { state.filter = e.target.value; renderList(); } } });
  const list = h("ul.lens__list");
  function renderList() {
    const qq = state.filter.trim().toLowerCase();
    clear(list).append(...data.clusters.filter((c) => !qq || c.key.toLowerCase().includes(qq)).map((c) => {
      const on = state.focus === c.key;
      return h("li.area-row", { cls: [on ? "is-on" : "", state.hover === c.key ? "is-hov" : ""].join(" "), "data-k": c.key, "data-lsel": on ? "1" : null, vars: { "--c": color(c.key) },
        on: { click: () => setState({ focus: on ? null : c.key }), mouseenter: () => setState({ hover: c.key }), mouseleave: () => setState({ hover: null }) } },
        h("span.area-row__dot"), h("span.area-row__name", { text: c.key }),
        h("span.area-row__bar", null, h("span", { vars: { "--w": `${((c.count / max) * 100).toFixed(1)}%` } })),
        h("span.area-row__n", { text: String(c.count) }));
    }));
    requestAnimationFrame(measureInd);
  }
  renderList();
  void q;
  return h("div.lens__sec", null,
    h("div.lens__h", null, h("span.lens__h-t", { text: t("lens.areas") }), h("span.lens__h-n", { text: t("lens.areasCount", { a: data.clusters.length, m: numberFmt.format(total) }) })),
    h("label.lens__find", null, s("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, s("circle", { cx: 10.5, cy: 10.5, r: 6.5, fill: "none", stroke: "currentColor", "stroke-width": 2 }), s("line", { x1: 15.5, y1: 15.5, x2: 21, y2: 21, stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" })), filter),
    list);
}

// Active-row marker (js/panel-indicator.js); schedules one measurement.
let measureInd = () => {};

let lastKey = "", tabCleanup = null;
/** Forces the open tab's content to be rebuilt on the next render (ctx.refreshLens()). */
export function refreshLens() { lastKey = ""; }

export function render(L, changed) {
  lens.classList.toggle("is-open", L.lensOpen);
  lens.classList.toggle("is-compact", L.compact);
  peek.hidden = !L.compact;
  const tabs = tabsOf(state.view);
  const tab = tabs.find((x) => x.id === state.tab) || tabs[0];
  clear(tabsEl).append(...tabs.map((x) => {
    const n = typeof x.badge === "function" ? x.badge() : 0;
    return h("button.lens__tab", { cls: x === tab ? "is-on" : "", on: { click: () => setState({ tab: x.id }) } },
      t(x.labelKey), n > 0 ? h("span.lens__badge", { text: String(n) }) : null);
  }), h("button.lens__close", { title: t("lens.collapse"), on: { click: () => ctxRef.toggleLens() } }, s("svg", { viewBox: "0 0 24 24" }, s("path", { d: "M9 5l7 7-7 7" }))));
  // Vault tabs follow focus and data; an area's own tabs re-render on view/tab
  // change or refreshLens() only (they own their content and its updates).
  const own = !!getArea(state.view)?.tabs || !!tab.own; // own: tab keeps its content across data updates
  const key = own ? [state.view, tab.id].join("|") : [state.view, tab.id, state.focus, data.clusters.length, data.clusters[0]?.count].join("|");
  if (key !== lastKey || (!own && changed.has("data"))) {
    lastKey = key;
    if (typeof tabCleanup === "function") tabCleanup();
    tabCleanup = null;
    clear(body);
    if (typeof tab.render === "function") tabCleanup = tab.render(body, ctxRef) || null;
    else body.append(wip());
  }
  // Hover coupling with the vault views (state.hover).
  if (changed.has("hover")) for (const r of body.querySelectorAll(".area-row")) r.classList.toggle("is-hov", r.dataset.k === state.hover);
  setTimeout(measureInd, 480);
}
