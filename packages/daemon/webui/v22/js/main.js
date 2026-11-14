// Recall UI v22 — boot and render loop for the shell.
import { h } from "./dom.js";
import { t } from "./i18n.js";
import { state, setState, subscribe } from "./state.js";
import { computeLayout, applyLayout } from "./layout.js";
import { getArea } from "./areas.js";
import { data, onData, startPolling } from "./data.js";
import { mountNav, updateNav } from "./nav.js";
import { mountHeader, updateHeader } from "./header.js";
import * as agent from "./agent.js";
import * as footer from "./footer.js";
import * as lens from "./lens.js";
import * as stage from "./stage.js";
import { mountBackdrop } from "./backdrop.js";
import "./views/index.js";
import "./sections/index.js";

const app = document.getElementById("app");
let L = computeLayout(state);
let prev = { ...state };

const ctx = {
  viewLabel: (v) => { const a = getArea(v); return a ? (a.label || t(a.labelKey)) : t(`view.${v}`); },
  areaColor: (k) => lens.color(k),
  weather: () => readWeather(),
  ask: (q) => agent.ask(q),
  toggleLens: () => lens.toggleLens(L),
  lensPeekIn: () => lens.peekIn(),
  lensPeekOut: () => lens.peekOut(),
  // An area's panel tab content is rebuilt on view/tab change; areas call this
  // when their panel data changed.
  refreshLens: () => { lens.refreshLens(); update(new Set(["lens"])); },
  runAction: (a) => (typeof a.onAction === "function" ? a.onAction(ctx) : setState({ toast: t("wip.stage") })),
};

function readWeather() { return data.weather; }

app.append(h("div.glow"), h("div.frame", null, h("span.frame__marks")));
mountBackdrop(app);
mountNav(app, ctx);
stage.mountStage(app);
agent.mountAgent(app);
footer.mountFooter(app);
lens.mountLens(app, ctx);
mountHeader(app, ctx);

function update(changed) {
  L = computeLayout(state);
  applyLayout(app, L, state);
  updateNav(ctx, changed);
  updateHeader(L, changed);
  stage.render(ctx);
  agent.render(L);
  footer.render(L);
  lens.render(L, changed);
}

subscribe((s) => {
  const changed = new Set(Object.keys(s).filter((k) => s[k] !== prev[k]));
  prev = { ...s };
  update(changed);
});
onData(() => update(new Set(["data"])));

window.addEventListener("resize", () => setState({ vw: window.innerWidth, vh: window.innerHeight }));
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (state.focus) setState({ focus: null }); else setState({ jOpen: false });
});

// Scrollbars: full visibility only while the pointer is over the scrolling area.
let sbOn = new Set();
document.addEventListener("pointerover", (e) => {
  const next = new Set(); let el = e.target;
  while (el && el !== document.body && el.nodeType === 1) {
    const cs = getComputedStyle(el);
    if ((/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) || (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1)) { next.add(el); break; }
    el = el.parentElement;
  }
  sbOn.forEach((x) => { if (!next.has(x)) x.removeAttribute("data-sb"); });
  next.forEach((x) => x.setAttribute("data-sb", ""));
  sbOn = next;
}, { passive: true });

update(new Set(["init", "view", "vw", "data"]));
startPolling();
