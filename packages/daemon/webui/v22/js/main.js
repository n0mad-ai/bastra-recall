// Recall UI v22 — boot and render loop for the shell.
import { h } from "./dom.js";
import { t } from "./i18n.js";
import { state, setState, subscribe } from "./state.js";
import { computeLayout, applyLayout } from "./layout.js";
import { getArea } from "./areas.js";
import { data, onData, startPolling } from "./data.js";
import { mountNav, updateNav, closeVp } from "./nav.js";
import { mountHeader, updateHeader } from "./header.js";
import * as agent from "./agent.js";
import * as footer from "./footer.js";
import * as lens from "./lens.js";
import * as stage from "./stage.js";

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
  runAction: (a) => (typeof a.onAction === "function" ? a.onAction(ctx) : setState({ toast: t("wip.stage") })),
};

function readWeather() { return data.weather; }

// Toast: short notices while the right panel is closed (DESIGN-SYSTEM › Toast).
const toastLayer = h("div");
let toastShown = "", toastTimer = 0;
function renderToast(L) {
  const msg = state.toast && !L.lensOpen ? state.toast : "";
  if (msg === toastShown) return;
  toastShown = msg; clearTimeout(toastTimer);
  toastLayer.replaceChildren();
  if (!msg) return;
  toastLayer.append(h("div.toast", { role: "status" },
    h("span.toast__p", { text: "›" }), h("span.toast__t", { text: msg }),
    h("button.toast__x", { "aria-label": t("toast.close"), text: "×", on: { click: () => setState({ toast: "" }) } }),
    h("span.toast__bar")));
  toastTimer = setTimeout(() => setState({ toast: "" }), 6000);
}

app.append(h("div.glow"), h("div.frame", null, h("span.frame__marks")));
mountNav(app, ctx);
stage.mountStage(app);
agent.mountAgent(app);
footer.mountFooter(app);
lens.mountLens(app, ctx);
mountHeader(app, ctx);
app.append(toastLayer);

function update(changed) {
  L = computeLayout(state);
  applyLayout(app, L, state);
  updateNav(ctx, changed);
  updateHeader(L, changed);
  stage.render(ctx);
  agent.render(L);
  footer.render(L);
  lens.render(L, changed);
  renderToast(L);
}

subscribe((s) => {
  const changed = new Set(Object.keys(s).filter((k) => s[k] !== prev[k]));
  if (changed.has("view") && prev.vpOpen && s.vpOpen) closeVp();
  prev = { ...s };
  update(changed);
});
onData(() => update(new Set(["data"])));

window.addEventListener("resize", () => setState({ vw: window.innerWidth, vh: window.innerHeight }));
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (state.vpOpen) { closeVp(); return; }
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
