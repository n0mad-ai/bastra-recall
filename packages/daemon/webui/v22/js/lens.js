// Right panel ("lens"): tabs per area, the Areas list for vault views,
// active-row marker on the outer edge, report links at the bottom.
import { h, s, clear, setVars } from "./dom.js";
import { t, numberFmt } from "./i18n.js";
import { state, setState } from "./state.js";
import { data } from "./data.js";

const TABS = {
  dashboard: [["areas", "lens.widgets"], ["layout", "lens.layout"]],
  tasks: [["areas", "lens.details"], ["view", "lens.view"], ["control", "lens.control"]],
  settings: [["areas", "lens.find"], ["changes", "lens.changes"]],
  telemetry: [["areas", "lens.find"], ["view", "lens.view"]],
  default: [["areas", "lens.areas"], ["signals", "lens.signals"], ["view", "lens.view"], ["live", "lens.live"]],
};
const VAULTISH = (v) => !["telemetry", "dashboard", "settings", "tasks"].includes(v);

let peek, lens, tabsEl, body, indLayer, lpT = 0, ctxRef;

export function mountLens(app, ctx) {
  ctxRef = ctx;
  peek = h("div.lens-peek", { on: { mouseenter: peekIn, mouseleave: peekOut } });
  tabsEl = h("div.lens__tabs");
  body = h("div.lens__body", { on: { scroll: () => requestAnimationFrame(measureInd) } });
  lens = h("aside.lens", { on: { mouseenter: peekIn, mouseleave: peekOut } }, tabsEl, body,
    h("div.lens__foot", null,
      h("a", { href: "https://github.com/n0mad-ai/bastra-recall/issues/new?template=bug_report.yml", target: "_blank", rel: "noopener", text: t("lens.bug") }),
      h("span.lens__foot-sep", { text: "·" }),
      h("a", { href: "https://github.com/n0mad-ai/bastra-recall/issues/new?template=feature_request.yml", target: "_blank", rel: "noopener", text: t("lens.idea") })));
  indLayer = h("div");
  app.append(peek, lens, indLayer);
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
      return h("li.area-row", { cls: on ? "is-on" : "", "data-lsel": on ? "1" : null, vars: { "--c": color(c.key) },
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

function measureInd() {
  clear(indLayer);
  if (!lens.classList.contains("is-open")) return;
  const ar = lens.getBoundingClientRect(), br = body.getBoundingClientRect();
  for (const el of lens.querySelectorAll("[data-lsel]")) {
    const r = el.getBoundingClientRect(), top = Math.max(r.top, br.top), bot = Math.min(r.bottom, br.bottom);
    if (bot - top < 4 || ar.width < 10) continue;
    indLayer.append(h("span.ls-ind", { vars: { "--t": `${Math.round(top)}px`, "--h": `${Math.round(bot - top)}px` } }));
  }
}

let lastKey = "";
export function render(L, changed) {
  lens.classList.toggle("is-open", L.lensOpen);
  lens.classList.toggle("is-compact", L.compact);
  peek.hidden = !L.compact;
  const tabs = TABS[state.view] || TABS.default;
  const tab = tabs.some(([id]) => id === state.tab) ? state.tab : "areas";
  clear(tabsEl).append(...tabs.map(([id, key]) => h("button.lens__tab", { cls: id === tab ? "is-on" : "", text: t(key), on: { click: () => setState({ tab: id }) } })),
    h("button.lens__close", { title: t("lens.collapse"), on: { click: () => ctxRef.toggleLens() } }, s("svg", { viewBox: "0 0 24 24" }, s("path", { d: "M9 5l7 7-7 7" }))));
  const key = [state.view, tab, state.focus, data.clusters.length, data.clusters[0]?.count].join("|");
  if (key !== lastKey || changed.has("data")) {
    lastKey = key;
    clear(body).append(tab === "areas" && VAULTISH(state.view) ? areasTab() : wip());
  }
  setTimeout(measureInd, 480);
}
