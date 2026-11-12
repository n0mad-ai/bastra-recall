// Settings area — right panel tabs (prototype tabFindSet / tabChanges):
// Find (search, quick chips, group list with hits / modified dot / count) and
// Changes (old → new, the CLI line it stands for, Revert, Discard / Apply).
// Both tabs update in place from the settings store, so the search field keeps focus.
import { t } from "../i18n.js";
import { h, s, clear } from "../dom.js";
import { SETTINGS_FILE, store, onStore, emit, apply, discard, revert, restart, changeList, cliOf, entry, matches } from "./settings-model.js";
import { nameOf, descOf, fmt } from "./settings.js";

const CHIPS = ["env", "restart", "experimental", "ollama", "token"];

function searchIcon() {
  return s("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" },
    s("circle", { cx: "10.5", cy: "10.5", r: "6.5", fill: "none", stroke: "currentColor", "stroke-width": "2" }),
    s("line", { x1: "15.5", y1: "15.5", x2: "21", y2: "21", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round" }));
}

const setQuery = (q) => { store.query = q; emit("query"); };

export function findTab(body) {
  const count = h("span.lens__h-n");
  const input = h("input", { type: "text", placeholder: t("st.find.ph"), autocomplete: "off", spellcheck: "false", value: store.query,
    on: { input: () => setQuery(input.value) } });
  const x = h("button.st-find__x", { type: "button", "aria-label": t("st.find.clear"), text: "×", on: { click: () => { input.value = ""; setQuery(""); input.focus(); } } });
  const chips = CHIPS.map((c) => h("button.st-fchip", { type: "button", text: c, on: { click: () => { const q = store.query === c ? "" : c; input.value = q; setQuery(q); } } }));
  const list = h("ul.lens__list.st-nav");
  body.append(h("div.lens__sec", null,
    h("div.lens__h", null, h("span.lens__h-t", { text: t("st.find.title") }), count),
    h("div.lens__find.st-find", null, searchIcon(), input, x),
    h("div.st-fchips", null, chips),
    h("div.st-nav__l", { text: t("st.find.sections") }),
    list));

  const sync = () => {
    const q = store.query.trim().toLowerCase();
    if (document.activeElement !== input) input.value = store.query;
    x.hidden = !q;
    chips.forEach((c) => c.classList.toggle("is-on", store.query === c.textContent));
    let total = 0, hitsAll = 0;
    clear(list).append(...(store.sections || []).map((sec) => {
      let hits = 0, mods = 0;
      for (const k of sec.keys) { const e = entry(k); total++; if (q && matches(e, nameOf(e), descOf(e), q)) hits++; if (store.changes.has(k)) mods++; }
      hitsAll += hits;
      return h("li.st-nav__i", { cls: [store.sel === sec.id ? "is-on" : "", q && !hits ? "is-dim" : ""].join(" "), "data-lsel": store.sel === sec.id ? "1" : null, on: { click: () => store.jump?.(sec.id) } },
        h("span.st-nav__n", { text: sec.n }),
        h("span.st-nav__t", { text: sec.title }),
        h("span.st-nav__r", null, q && hits ? h("span.st-nav__hits", { text: String(hits) }) : null,
          mods ? h("span.st-nav__mod") : null, h("span.st-nav__c", { text: String(sec.keys.length) })));
    }));
    count.textContent = q ? t(hitsAll === 1 ? "st.find.match1" : "st.find.matches", { n: hitsAll }) : t("st.find.total", { n: total });
  };
  sync();
  return onStore(sync);
}

export function changesTab(body) {
  const wrap = h("div.lens__sec");
  body.append(wrap);
  const sync = () => {
    const list = changeList(), n = list.length, rsN = list.filter((c) => c.e.restartRequired).length;
    const cards = list.map((c) => {
      const cli = c.e.local ? null : cliOf(c.e, c.value);
      return h("div.st-ch", null,
        h("div.st-ch__h", null, h("span.st-ch__n", { text: nameOf(c.e) }),
          h("button.st-ch__rv", { type: "button", title: t("st.revert"), text: t("st.revert"), on: { click: () => revert(c.key) } })),
        h("div.st-ch__v", null, h("span.st-ch__from", { text: fmt(c.e, c.e.value) }), h("span.st-ch__arr", { text: "→" }), h("span.st-ch__to", { text: fmt(c.e, c.value) })),
        h("div.st-ch__cli", null, cli ? [h("span.st-ch__p", { text: "$ " }), cli] : t("st.cli.default")));
    });
    clear(wrap).append(...[
      h("div.lens__h", null, h("span.lens__h-t", { text: t("st.ch.title") }),
        h("span.lens__h-n", { cls: n ? "is-amber" : "", text: n ? t("st.ch.unsaved", { n }) : t("st.ch.allSaved") })),
      n ? null : h("p.st-ch__empty", { text: t("st.ch.empty") }),
      !n && store.saved ? h("div.st-ch__saved", { text: `✓ ${t("st.ch.saved", { at: store.saved, file: SETTINGS_FILE })}` }) : null,
      !n && store.savedRestart ? h("div.st-ch__rs", null, h("span", { text: t("st.ch.needRestart") }),
        store.model?.restartAvailable ? h("button.st-btn.st-btn--go", { type: "button", cls: store.restarting ? "ld-on" : "", text: store.restarting ? t("st.restarting") : t("st.restart"), disabled: store.restarting, on: { click: restart } }) : null) : null,
      store.error && store.model ? h("div.st-ch__err", { text: t("st.saveErr", { err: store.error }) }) : null,
      h("div.st-ch__list", null, cards),
      n ? h("p.st-ch__rsn", { text: rsN ? t("st.restartN", { n: rsN }) : t("st.noRestart") }) : null,
      n ? h("div.st-ch__acts", null,
        h("button.st-btn.st-btn--mute", { type: "button", text: t("st.discard"), on: { click: discard } }),
        h("button.st-btn.st-btn--go", { type: "button", cls: store.busy ? "ld-on" : "", text: store.busy ? t("st.applying") : t("st.apply"), disabled: store.busy, on: { click: apply } })) : null].filter(Boolean));
  };
  sync();
  return onStore((what) => { if (what !== "query" && what !== "sel") sync(); });
}
