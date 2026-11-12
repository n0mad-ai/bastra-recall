// Left navigation rail + vault views pop-over (prototype NAV:START … NAV:END).
import { h, s, icon, clear, setVars } from "./dom.js";
import { t } from "./i18n.js";
import { ICON, VAULT_VIEWS, GROUPS, areasIn } from "./areas.js";
import { state, setState } from "./state.js";
import { data } from "./data.js";

let navEl, scrollEl, indEl, vpBtn, vpLayer, verEl;

export function mountNav(app, ctx) {
  scrollEl = h("div.nav__scroll");
  indEl = h("span.nav__ind");
  verEl = h("span.nav__ver", null, h("span.dot"), "");
  navEl = h("nav.nav", { "aria-label": "Main" },
    h("div.nav__logo", { title: "bastravault" },
      s("svg", { viewBox: "0 0 40 40" },
        s("circle.r-base", { cx: 20, cy: 20, r: 17 }),
        s("circle.r-arc", { cx: 20, cy: 20, r: 17, "stroke-dasharray": "26 81", transform: "rotate(-90 20 20)" }),
        s("circle.r-base", { cx: 20, cy: 20, r: 10 }),
        s("circle.r-core", { cx: 20, cy: 20, r: 3.2 }))),
    scrollEl,
    h("div.nav__foot", null, verEl));
  vpLayer = h("div");
  app.append(navEl, vpLayer);
  scrollEl.addEventListener("scroll", () => measureInd(), { passive: true });
  document.addEventListener("recall:areas", () => render(ctx));
  render(ctx);
}

function navButton({ id, label, title, iconPath, on, onClick, badge, badgeAccent }) {
  const ic = h("span.nav__icon", null, icon(iconPath));
  if (badge) ic.append(h(`span.nav__badge${badgeAccent ? ".nav__badge--accent" : ""}`, { text: String(badge) }));
  return h("button.nav__btn", { cls: on ? "is-on" : "", title: title || label, "data-nav": id, on: { click: onClick } },
    ic, h("span.nav__label", { text: label }));
}

function render(ctx) {
  clear(scrollEl).append(indEl);
  const view = state.view;
  const inVault = VAULT_VIEWS.includes(view);
  for (const group of GROUPS) {
    const items = areasIn(group);
    if (group !== "vault" && !items.length) continue;
    scrollEl.append(h("div.nav__div"));
    if (group === "vault") {
      const cur = inVault ? view : null;
      vpBtn = navButton({ id: "vault", label: cur ? t(`view.${cur}`) : t("nav.vault"), title: t("nav.vaultViews"), iconPath: ICON[cur || "mindspace"], on: inVault || state.vpOpen, onClick: () => (state.vpOpen ? closeVp() : openVp()) });
      vpBtn.setAttribute("aria-haspopup", "true");
      vpBtn.setAttribute("aria-expanded", String(state.vpOpen));
      if (inVault) vpBtn.dataset.active = "1";
      scrollEl.append(vpBtn);
    }
    for (const a of items) {
      const label = a.label || t(a.labelKey);
      const title = a.titleKey ? t(a.titleKey) : label;
      const on = a.kind !== "action" && view === a.id;
      const badge = a.badge ? a.badge() : a.id === "tasks" ? data.dueTasks.length : 0;
      const b = navButton({ id: a.id, label, title, iconPath: a.icon, on, badge, onClick: () => (a.kind === "action" ? ctx.runAction(a) : setState({ view: a.id, hover: null, tab: "areas", vpOpen: false })) });
      if (on) b.dataset.active = "1";
      scrollEl.append(b);
    }
  }
  const segs = inVault ? VAULT_VIEWS.map((v) => h("span.nav__seg", { cls: v === view ? "is-on" : "" })) : [h("span.nav__seg.is-on.is-solo")];
  clear(indEl).append(...segs);
  setVars(indEl, { "--ind-gap": inVault ? "1px" : "0px" });
  requestAnimationFrame(measureInd);
  renderVp();
}

function measureInd() {
  const btn = scrollEl.querySelector("[data-active]");
  if (!btn) { setVars(indEl, { "--ind-op": 0 }); return; }
  const sr = scrollEl.getBoundingClientRect(), br = btn.getBoundingClientRect();
  setVars(indEl, { "--ind-top": `${Math.round(br.top - sr.top + scrollEl.scrollTop)}px`, "--ind-h": `${Math.round(br.height)}px`, "--ind-op": 1 });
}

/** Slot below the area buttons (footer variant "anchored" docks Recall here). */
export function mountNavAgent(el) { navEl.insertBefore(el, navEl.querySelector(".nav__foot")); }

// ── vault views pop-over ──────────────────────────────────────────────────
let vpGeo = { top: 140, dock: 24 }, vpHold = 0;

function openVp() {
  if (vpBtn && navEl) {
    const br = vpBtn.getBoundingClientRect(), nr = navEl.getBoundingClientRect();
    const cy = br.top - nr.top + 24 + br.height / 2;
    const H = 47 + 46 * 4 + 2, maxTop = state.vh - 24 - H;
    const top = Math.round(Math.max(24, Math.min(maxTop, cy - 22)));
    vpGeo = { top, dock: Math.round(cy - top) };
  }
  setState({ vpOpen: true });
}

export function closeVp() {
  if (!state.vpOpen) return;
  vpHold = Date.now() + 320;
  setState({ vpOpen: false });
  setTimeout(renderVp, 340);
}

function renderVp() {
  const mounted = state.vpOpen || Date.now() < vpHold;
  if (!mounted) { clear(vpLayer); return; }
  if (vpLayer.firstChild) { vpLayer.querySelector(".vp").classList.toggle("is-in", state.vpOpen); return; }
  const items = VAULT_VIEWS.map((v, i) => h("button.vp__item", { role: "menuitem", cls: v === state.view ? "is-on" : "", vars: { "--d": `${(0.04 + i * 0.035).toFixed(3)}s` }, on: { click: () => { setState({ view: v, hover: null, tab: "areas" }); closeVp(); } } },
    h("span.vp__item-bar"),
    h("span.vp__tile", null, icon(ICON[v])),
    h("span.vp__name", { text: t(`view.${v}`) }),
    v === state.view ? h("span.dot", { "aria-hidden": "true" }) : null));
  const pop = h("div.vp", { role: "menu", "aria-label": t("nav.vaultViews"), vars: { "--vp-top": `${vpGeo.top}px`, "--vp-dock": `${vpGeo.dock}px`, "--vp-edge": `${vpGeo.dock * 2 + 1}px` } },
    h("span.vp__arm"), h("span.vp__top"), h("span.vp__edge"),
    h("div.vp__head", null, h("span.vp__kicker", { text: t("nav.vaultViews") }), h("span.vp__count", { text: String(VAULT_VIEWS.length) })),
    h("div.vp__list", null, items));
  vpLayer.append(h("div.vp-scrim", { on: { click: closeVp } }), pop);
  requestAnimationFrame(() => requestAnimationFrame(() => pop.classList.toggle("is-in", state.vpOpen)));
}

export function updateNav(ctx, changed) {
  if (changed.has("view") || changed.has("vpOpen") || changed.has("data")) render(ctx);
  const v = data.health?.version;
  if (v && verEl.lastChild.textContent !== `v${v}`) { verEl.lastChild.textContent = `v${v}`; verEl.title = `daemon v${v} · semantic recall ${data.health.semantic_recall ?? "–"} · ${data.health.embedding_mode ?? ""}`; }
}
