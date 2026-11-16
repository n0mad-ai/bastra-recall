// Right panel › Live for the vault views: what happens in the vault right now
// — memories that are new, changed, deleted or read (recall / load_memory).
// Source: GET /ui/updates through data.js onUpdates(); nothing is recorded
// while the header's Live switch is off (state.live), like the map engines.
//
// Layout is the prototype's "This session" feed (Recall UI v22, tabLive).
// From the old UI's live deck (js/managers/live-deck.js, css/live.css) it
// keeps the arrival: a new entry slides in from the right (Daniel, 12.11.2026).
// Since 16.11.2026 it is more prominent and lasts longer: the rows below glide
// down, the new row lights up in its kind's colour and its dot pulses, all
// fading out over ~3 s (css/live.css). Motion only plays for events that
// arrive while the tab is open (live-feed.js arrivals); an idle tab runs no
// animation (only the age labels tick).
import { h } from "../dom.js";
import { t, addStrings } from "../i18n.js";
import { state, setState, subscribe } from "../state.js";
import { onUpdates, loadGraph } from "../data.js";
import { vault } from "./vault-data.js";
import { showInView, openMemoryBrowser } from "./memory-browser.js";
import { createFeed, shortAge, arrivals } from "./live-feed.js";
import en from "../i18n/live-en.js";
import de from "../i18n/live-de.js";

addStrings(en, de);

const feed = createFeed({ max: 300 });
onUpdates((list) => {
  if (!state.live) return;
  if (feed.ingest(list).length) setState({ liveN: feed.events.length }); // re-renders the tab badge
});

// Test hook, same spirit as window.__recallState: feeds simulated events
// through the real path, e.g. __recallLive.inject([{ id, kind: "read", title }]).
window.__recallLive = {
  inject: (list) => {
    if (state.live && feed.ingest(list).length) setState({ liveN: feed.events.length });
  },
};

/** Open an event's memory in both places (Daniel 16.11.2026): the vault view
 *  focuses it (glide / fly + info card, set even while the browser covers the
 *  view, so it stands selected once the browser closes), and the memory
 *  browser selects it — an open one in its mode, a closed one opens as a layer
 *  growing out of the clicked row. A memory the loaded graph does not know
 *  waits for a fresh graph (a new one may just be arriving); one that is gone
 *  by then gets a notice instead of an empty browser. */
async function openEvent(e, ev) {
  if (e.kind === "delete") return;
  const from = ev.currentTarget.getBoundingClientRect();
  if (!vault()?.byId.has(e.id)) await loadGraph();
  const m = vault()?.byId.get(e.id);
  if (!m) return setState({ toast: t("live.gone") });
  showInView(m.id);
  openMemoryBrowser(m.area, m.id, from);
}

const metaOf = (e) => [e.cluster, e.type, e.via ? t(`live.via.${e.via}`) : ""].filter(Boolean).join(" · ");

/** "2 new · 1 read" — kinds with no event this session are left out. */
function countsText() {
  const c = feed.counts();
  return ["add", "change", "read", "delete"]
    .filter((k) => c[k])
    .map((k) => t(`live.n.${k}`, { n: c[k] }))
    .join(" · ");
}

/** One entry; `delay` (ms) marks it as newly arrived and starts its animation. */
const row = (e, delay) =>
  h(
    "button.lvB__row",
    {
      cls: [`k-${e.kind}`, delay === undefined ? "" : "is-new"].join(" "),
      vars: delay === undefined ? null : { "--lv-d": `${delay}ms` },
      type: "button",
      on: { click: (ev) => openEvent(e, ev) },
    },
    h("span.lvB__dot"),
    h(
      "span.lvB__txt",
      null,
      h("span.lvB__kind", { text: t(`live.kind.${e.kind}`) + (e.count > 1 ? ` ×${e.count}` : "") }),
      h("span.lvB__title", { text: e.title }),
      h("span.lvB__meta", { text: metaOf(e) })
    ),
    h("span.lvB__ago", { "data-at": String(e.at), text: shortAge(e.at) })
  );

/** After `n` rows were prepended, the rows below glide down from where they
 *  were instead of jumping (one layout read; only the first rows, the rest
 *  is out of view). */
function glideDown(list, n) {
  const first = list.children[n];
  if (!first || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const dy = first.offsetTop - list.children[0].offsetTop;
  const easing = getComputedStyle(list).getPropertyValue("--ease-knob").trim() || "ease-out";
  for (const el of [...list.children].slice(n, n + 30))
    el.animate([{ transform: `translateY(${-dy}px)` }, { transform: "none" }], { duration: 380, easing });
}

export const liveTab = {
  id: "live",
  labelKey: "lens.live",
  own: true, // keeps its content across data updates (js/lens.js)
  badge: () => (state.live ? feed.events.length : 0),
  render(body) {
    const sum = h("span.lens__h-n");
    const off = h("p.lv-note");
    const empty = h("p.lv-empty", { text: t("live.empty") });
    const list = h("div.lvB");
    body.append(
      h(
        "div.lens__sec.lvt",
        null,
        h("div.lens__h", null, h("span.lens__h-t", { text: t("live.title") }), sum),
        off,
        empty,
        list
      )
    );

    // One line: whole segments give way from the end ("3 new · 1 changed · …"),
    // the full text stays in the title.
    function fitSum() {
      const full = sum.title,
        parts = full.split(" · ");
      sum.textContent = full;
      for (let n = parts.length - 1; n > 0 && sum.scrollWidth > sum.clientWidth; n--)
        sum.textContent = `${parts.slice(0, n).join(" · ")} · …`;
    }
    function head() {
      sum.title = countsText();
      fitSum();
      off.hidden = state.live;
      off.textContent = state.live ? "" : t("live.off");
      empty.hidden = feed.events.length > 0;
      list.hidden = !feed.events.length;
    }
    let shown = arrivals(null, feed.events, performance.now()); // already there: no animation
    list.append(...feed.events.map((e) => row(e)));
    head();
    requestAnimationFrame(fitSum); // widths are known once the tab is laid out

    const unAdd = feed.onAdd((fresh) => {
      shown = arrivals(shown, feed.events, performance.now());
      const delay = new Map(shown.fresh.map((f) => [f.key, f.delay]));
      list.prepend(...fresh.map((e) => row(e, delay.get(e.key))));
      glideDown(list, fresh.length);
      while (list.children.length > feed.events.length) list.lastChild.remove();
      head();
    });
    let wasLive = state.live;
    const unSub = subscribe((st) => {
      if (st.live !== wasLive) {
        wasLive = st.live;
        head();
      }
    });
    const ages = setInterval(() => {
      if (!document.hidden)
        for (const el of list.querySelectorAll(".lvB__ago")) el.textContent = shortAge(Number(el.dataset.at));
    }, 1000);
    return () => {
      unAdd();
      unSub();
      clearInterval(ages);
    };
  },
};
