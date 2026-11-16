// Left navigation rail (prototype NAV:START … NAV:END). The Vault button
// opens the last chosen vault view; the views are picked in the right panel
// › View (Daniel, 14.11.2026; js/lens.js, js/views/pro-views.js).
import { h, icon, clear, setVars } from "./dom.js";
import { t } from "./i18n.js";
import { ICON, VAULT_VIEWS, GROUPS, areasIn } from "./areas.js";
import { state, setState } from "./state.js";
import { data } from "./data.js";
import { lastVaultView, rememberVaultView } from "./views/pro-views.js";
import { openMemoryBrowserArea, closeMemoryBrowser } from "./views/memory-browser.js";

let navEl, scrollEl, indEl, verEl;

export function mountNav(app, ctx) {
  scrollEl = h("div.nav__scroll");
  indEl = h("span.nav__ind");
  verEl = h("span.nav__ver", null, h("span.dot"), "");
  navEl = h(
    "nav.nav",
    { "aria-label": "Main" },
    h(
      "div.nav__logo",
      { title: "bastravault" },
      h("img", {
        src: "img/logo-64.png",
        srcset: "img/logo-64.png 2x, img/logo-96.png 3x",
        alt: "Recall",
        width: 32,
        height: 32,
      })
    ),
    scrollEl,
    h("div.nav__foot", null, verEl)
  );
  app.append(navEl);
  scrollEl.addEventListener("scroll", () => measureInd(), { passive: true });
  document.addEventListener("recall:areas", () => render(ctx));
  render(ctx);
}

function navButton({ id, label, title, iconPath, on, sub, onClick, badge, badgeAccent, dot }) {
  const ic = h("span.nav__icon", null, icon(iconPath));
  if (badge) ic.append(h(`span.nav__badge${badgeAccent ? ".nav__badge--accent" : ""}`, { text: String(badge) }));
  // dot: a second, separate signal next to the count (Tasks: unread reports beside "due").
  if (dot && dot()) ic.append(h("span.dot.nav__dot"));
  return h(
    "button.nav__btn",
    {
      cls: on ? "is-on" : sub ? "is-sub" : "",
      title: title || label,
      "aria-label": title || label,
      // the lit entry is the page; the second mark is open beside it
      "aria-current": on ? "page" : sub ? "true" : null,
      "data-nav": id,
      on: { click: onClick },
    },
    ic,
    h("span.nav__label", { text: label })
  );
}

/** Which of Vault and Browser the rail lights (Daniel 16.11.2026). The browser
 *  opened from the rail is its own area: only Browser is lit. Opened from a
 *  vault view it is a layer: Vault stays lit and Browser gets the second mark.
 *  state.browser changes at the click, so the marks never wait for the grow. */
export function railMarks(view, browser) {
  const inVault = VAULT_VIEWS.includes(view);
  return {
    vault: inVault && browser !== "nav",
    browser: browser === "nav" ? "on" : browser === "vault" && inVault ? "sub" : null,
  };
}

/** Memory browser entry (below Vault): opens the browser as an area. Like the
 *  other entries a second click keeps it; another entry leaves it (stage.js). */
function browserButton(mark) {
  const b = navButton({
    id: "browser",
    label: t("nav.browser"),
    title: t("nav.browserTitle"),
    iconPath: ICON.browser,
    on: mark === "on",
    sub: mark === "sub",
    onClick: (e) => openMemoryBrowserArea(e.currentTarget.getBoundingClientRect()),
  });
  if (mark === "on") b.dataset.active = "1";
  return b;
}

/** The Vault entry: named after the current vault view; lit unless the browser stands as an area over it. */
function vaultButton(view, on) {
  const cur = VAULT_VIEWS.includes(view) ? view : null;
  const b = navButton({
    id: "vault",
    label: cur ? t(`view.${cur}`) : t("nav.vault"),
    title: t("nav.vault"),
    iconPath: ICON[cur || lastVaultView()],
    on,
    onClick: () => {
      // from the browser area back to the vault view it stands on
      if (state.browser === "nav") closeMemoryBrowser();
      else if (!on) setState({ view: lastVaultView(), hover: null, tab: "areas" });
    },
  });
  if (on) b.dataset.active = "1";
  return b;
}

function render(ctx) {
  clear(scrollEl).append(indEl);
  const view = state.view;
  const marks = railMarks(view, state.browser);
  const inVault = marks.vault; // the vault-view segments belong to a lit Vault
  for (const group of GROUPS) {
    const items = areasIn(group);
    if (group !== "vault" && !items.length) continue;
    scrollEl.append(h("div.nav__div"));
    if (group === "vault") scrollEl.append(vaultButton(view, inVault), browserButton(marks.browser));
    for (const a of items) {
      const label = a.label || t(a.labelKey);
      const title = a.titleKey ? t(a.titleKey) : label;
      const on = a.kind !== "action" && view === a.id;
      const badge = a.badge ? a.badge() : a.id === "tasks" ? data.dueTasks.length : 0;
      const b = navButton({
        id: a.id,
        label,
        title,
        iconPath: a.icon,
        on,
        badge,
        dot: a.dot,
        onClick: () => (a.kind === "action" ? ctx.runAction(a) : setState({ view: a.id, hover: null, tab: "areas" })),
      });
      if (on) b.dataset.active = "1";
      scrollEl.append(b);
    }
  }
  const segs = inVault
    ? VAULT_VIEWS.map((v) => h("span.nav__seg", { cls: v === view ? "is-on" : "" }))
    : [h("span.nav__seg.is-on.is-solo")];
  clear(indEl).append(...segs);
  setVars(indEl, { "--ind-gap": inVault ? "1px" : "0px" });
  requestAnimationFrame(measureInd);
}

function measureInd() {
  const btn = scrollEl.querySelector("[data-active]");
  if (!btn) {
    setVars(indEl, { "--ind-op": 0 });
    return;
  }
  const sr = scrollEl.getBoundingClientRect(),
    br = btn.getBoundingClientRect();
  setVars(indEl, {
    "--ind-top": `${Math.round(br.top - sr.top + scrollEl.scrollTop)}px`,
    "--ind-h": `${Math.round(br.height)}px`,
    "--ind-op": 1,
  });
}

/** Slot below the area buttons (footer variant "anchored" docks Recall here). */
export function mountNavAgent(el) {
  navEl.insertBefore(el, navEl.querySelector(".nav__foot"));
}

export function updateNav(ctx, changed) {
  if (changed.has("view")) rememberVaultView(state.view);
  if (changed.has("view") || changed.has("data") || changed.has("browser")) render(ctx);
  const v = data.health?.version;
  if (v && verEl.lastChild.textContent !== `v${v}`) {
    verEl.lastChild.textContent = `v${v}`;
    verEl.title = `daemon v${v} · semantic recall ${data.health.semantic_recall ?? "–"} · ${data.health.embedding_mode ?? ""}`;
  }
}
