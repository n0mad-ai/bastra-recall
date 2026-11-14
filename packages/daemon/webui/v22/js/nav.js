// Left navigation rail (prototype NAV:START … NAV:END). The Vault button
// opens the last chosen vault view; the views are picked in the right panel
// › View (Daniel, 14.11.2026; js/lens.js, js/views/pro-views.js).
import { h, s, icon, clear, setVars } from "./dom.js";
import { t } from "./i18n.js";
import { ICON, VAULT_VIEWS, GROUPS, areasIn } from "./areas.js";
import { state, setState } from "./state.js";
import { data } from "./data.js";
import { lastVaultView, rememberVaultView } from "./views/pro-views.js";

let navEl, scrollEl, indEl, verEl;

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
  app.append(navEl);
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
      const vb = navButton({ id: "vault", label: cur ? t(`view.${cur}`) : t("nav.vault"), title: t("nav.vault"), iconPath: ICON[cur || lastVaultView()], on: inVault,
        onClick: () => { if (!inVault) setState({ view: lastVaultView(), hover: null, tab: "areas" }); } });
      if (inVault) vb.dataset.active = "1";
      scrollEl.append(vb);
    }
    for (const a of items) {
      const label = a.label || t(a.labelKey);
      const title = a.titleKey ? t(a.titleKey) : label;
      const on = a.kind !== "action" && view === a.id;
      const badge = a.badge ? a.badge() : a.id === "tasks" ? data.dueTasks.length : 0;
      const b = navButton({ id: a.id, label, title, iconPath: a.icon, on, badge, onClick: () => (a.kind === "action" ? ctx.runAction(a) : setState({ view: a.id, hover: null, tab: "areas" })) });
      if (on) b.dataset.active = "1";
      scrollEl.append(b);
    }
  }
  const segs = inVault ? VAULT_VIEWS.map((v) => h("span.nav__seg", { cls: v === view ? "is-on" : "" })) : [h("span.nav__seg.is-on.is-solo")];
  clear(indEl).append(...segs);
  setVars(indEl, { "--ind-gap": inVault ? "1px" : "0px" });
  requestAnimationFrame(measureInd);
}

function measureInd() {
  const btn = scrollEl.querySelector("[data-active]");
  if (!btn) { setVars(indEl, { "--ind-op": 0 }); return; }
  const sr = scrollEl.getBoundingClientRect(), br = btn.getBoundingClientRect();
  setVars(indEl, { "--ind-top": `${Math.round(br.top - sr.top + scrollEl.scrollTop)}px`, "--ind-h": `${Math.round(br.height)}px`, "--ind-op": 1 });
}

/** Slot below the area buttons (footer variant "anchored" docks Recall here). */
export function mountNavAgent(el) { navEl.insertBefore(el, navEl.querySelector(".nav__foot")); }

export function updateNav(ctx, changed) {
  if (changed.has("view")) rememberVaultView(state.view);
  if (changed.has("view") || changed.has("data")) render(ctx);
  const v = data.health?.version;
  if (v && verEl.lastChild.textContent !== `v${v}`) { verEl.lastChild.textContent = `v${v}`; verEl.title = `daemon v${v} · semantic recall ${data.health.semantic_recall ?? "–"} · ${data.health.embedding_mode ?? ""}`; }
}
