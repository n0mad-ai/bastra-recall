// Right panel › Live for the vault views: what happens in the vault right now
// — memories that are new, changed, deleted or read (recall / load_memory).
// Source: GET /ui/updates through data.js onUpdates(); nothing is recorded
// while the header's Live switch is off (state.live), like the map engines.
//
// Two variants side by side until Daniel picks one (temporary "Compare"
// switch at the top, choice in localStorage):
//   old   — the old UI's live deck (js/managers/live-deck.js, css/live.css):
//           cards slide in, the newest covers at most two others, the rest is
//           counted in the "+N" bar, hover fans the deck out, tick rail left.
//   draft — the prototype's "This session" feed (Recall UI v22, tabLive).
// Motion only plays for events that arrive while the tab is open; an idle
// tab runs no animation (only the age labels are refreshed).
import { h, clear, setVars } from "../dom.js";
import { t, addStrings } from "../i18n.js";
import { state, setState, subscribe } from "../state.js";
import { onUpdates } from "../data.js";
import { vault } from "./vault-data.js";
import { showInView, openMemoryBrowser } from "./memory-browser.js";
import { createFeed, shortAge } from "./live-feed.js";
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
window.__recallLive = { inject: (list) => { if (state.live && feed.ingest(list).length) setState({ liveN: feed.events.length }); } };

const VKEY = "recall-v22-live-variant";
const getVariant = () => { try { return localStorage.getItem(VKEY) === "old" ? "old" : "draft"; } catch { return "draft"; } };
const putVariant = (v) => { try { localStorage.setItem(VKEY, v); } catch { /* storage blocked */ } };

const DECK_VISIBLE = 3; // the top card plus the two it covers (live-deck.js)
const DECK_MAX = 40;    // cards kept in the old deck's DOM
const KIND_ORDER = ["delete", "add", "change", "read"];
const ICON = { add: "✦", change: "✎", delete: "✕", read: "◉" };
const dismissed = new Set(); // old deck: cards closed with × (the feed keeps them)

/** Open an event's memory in the active view (glide / fly + info card); a
 *  memory the loaded graph does not know yet opens in the memory browser. */
function openEvent(e, ev) {
  if (e.kind === "delete") return;
  if (vault()?.byId.has(e.id) && showInView(e.id)) return;
  openMemoryBrowser(e.cluster || "all", e.id, ev.currentTarget.getBoundingClientRect());
}

const metaOf = (e) => [e.cluster, e.type, e.via ? t(`live.via.${e.via}`) : ""].filter(Boolean).join(" · ");

function countsText() {
  const c = feed.counts();
  return ["add", "change", "read", "delete"].filter((k) => k !== "delete" || c.delete).map((k) => t(`live.n.${k}`, { n: c[k] })).join(" · ");
}

export const liveTab = {
  id: "live",
  labelKey: "lens.live",
  own: true, // keeps its content across data updates (js/lens.js)
  badge: () => (state.live ? feed.events.length : 0),
  render(body) {
    let variant = getVariant();
    const sum = h("span.lens__h-n");
    const cmp = h("div.lv-cmp", { title: t("live.cmp.title") }, h("span.lv-cmp__k", { text: t("live.cmp") }),
      ...["old", "draft"].map((v) => h("button.lv-cmp__b", { "data-v": v, text: t(`live.cmp.${v}`), on: { click: () => { if (v === variant) return; variant = v; putVariant(v); build(); } } })));
    const off = h("p.lv-note");
    const host = h("div");
    const sec = h("div.lens__sec.lvt", null, cmp, h("div.lens__h", null, h("span.lens__h-t", { text: t("live.title") }), sum), off, host);
    body.append(sec);

    let view = null;
    function head() {
      sum.textContent = countsText();
      off.hidden = state.live; off.textContent = state.live ? "" : t("live.off");
      for (const b of cmp.querySelectorAll(".lv-cmp__b")) b.classList.toggle("is-on", b.dataset.v === variant);
    }
    function build() {
      view?.destroy?.();
      clear(host);
      view = (variant === "old" ? oldDeck : draftFeed)(host);
      head();
    }
    build();

    const unAdd = feed.onAdd((fresh) => { head(); view.add(fresh); });
    let wasLive = state.live;
    const unSub = subscribe((st) => { if (st.live !== wasLive) { wasLive = st.live; head(); } });
    // Age labels only; nothing moves while the tab is idle.
    const ages = setInterval(() => { if (!document.hidden) view.ages(); }, 1000);
    return () => { unAdd(); unSub(); clearInterval(ages); view?.destroy?.(); };
  },
};

function emptyNote() { return h("p.lv-empty", { text: t("live.empty") }); }

// ── draft: prototype "This session" ─────────────────────────────────────────
function draftFeed(host) {
  const list = h("div.lvB");
  const empty = emptyNote();
  host.append(empty, list);
  const row = (e, fresh) => h("button.lvB__row", { cls: [`k-${e.kind}`, fresh ? "is-new" : ""].join(" "), type: "button", on: { click: (ev) => openEvent(e, ev) } },
    h("span.lvB__dot"),
    h("span.lvB__txt", null, h("span.lvB__kind", { text: t(`live.kind.${e.kind}`) + (e.count > 1 ? ` ×${e.count}` : "") }), h("span.lvB__title", { text: e.title }), h("span.lvB__meta", { text: metaOf(e) })),
    h("span.lvB__ago", { "data-at": String(e.at), text: shortAge(e.at) }));
  const sync = () => { empty.hidden = feed.events.length > 0; list.hidden = !feed.events.length; };
  list.append(...feed.events.map((e) => row(e, false)));
  sync();
  return {
    add(fresh) { list.prepend(...fresh.map((e) => row(e, true))); while (list.children.length > feed.events.length) list.lastChild.remove(); sync(); },
    ages() { for (const el of list.querySelectorAll(".lvB__ago")) el.textContent = shortAge(Number(el.dataset.at)); },
  };
}

// ── old: the live deck of the old UI ────────────────────────────────────────
function oldDeck(host) {
  const ticks = h("div.lvA__ticks", { "aria-hidden": "true" });
  const cards = h("div.lvA__cards");
  const more = h("div.lvA__more", { hidden: true });
  const lane = h("div.lvA", null, ticks, h("div.lvA__stack", null, cards, more));
  const empty = emptyNote();
  host.append(empty, lane);
  let depth = 0;

  const card = (e, fresh) => {
    const close = h("button.lvA__x", { type: "button", "aria-label": t("live.dismiss"), text: "×", on: { click: (ev) => { ev.stopPropagation(); dismissed.add(e.key); el.remove(); sync(); } } });
    const el = h("div.lvA__card", { cls: [`k-${e.kind}`, fresh ? "is-new" : ""].join(" "), "data-k": e.kind, vars: { "--z": String(++depth) }, on: { click: (ev) => openEvent(e, ev) } },
      h("div.lvA__head", null, h("span.lvA__star", { text: ICON[e.kind] }), h("span.lvA__label", { text: t(`live.old.${e.kind}`) }),
        e.count > 1 ? h("span.lvA__count", { text: `×${e.count}` }) : null,
        h("span.lvA__age", { "data-at": String(e.at), text: shortAge(e.at) }), close),
      h("div.lvA__title", { text: e.title }),
      h("div.lvA__meta", { text: metaOf(e) }),
      e.summary ? h("div.lvA__sum", { text: e.summary }) : null);
    return el;
  };

  function paintMore() {
    const hidden = [...cards.children].slice(DECK_VISIBLE);
    more.hidden = !hidden.length;
    if (more.hidden) return;
    const tally = new Map();
    for (const c of hidden) tally.set(c.dataset.k, (tally.get(c.dataset.k) ?? 0) + 1);
    clear(more).append(h("span.lvA__total", { text: `+${hidden.length}` }),
      ...KIND_ORDER.filter((k) => tally.has(k)).map((k) => h("span.lvA__mk", { cls: `k-${k}`, text: `${ICON[k]} ${tally.get(k)} ${t(`live.short.${k}`)}` })));
  }

  // Fan-out timing of live-deck.js paintFanDelays(): same speed for every
  // card, top card first on opening, bottom card first on closing.
  const OVERLAP = 62, GAP = 10, BASE = 0.26, SPEED = (OVERLAP + GAP) / BASE;
  function paintFan() {
    const list = [...cards.children];
    const LEAD = 0.34, STEP = 0.14, TAIL_GAP = 0.1, TAIL_STEP = 0.05, FOLD = 0.05;
    const tail = LEAD + (DECK_VISIBLE - 1) * STEP + TAIL_GAP;
    let slowest = BASE;
    list.forEach((c, i) => {
      const covered = i >= DECK_VISIBLE;
      const hgt = c.offsetHeight;
      const dur = ((covered ? hgt : OVERLAP) + GAP) / SPEED;
      slowest = Math.max(slowest, dur);
      setVars(c, { "--self-hide": `-${hgt}px`, "--fan-dur": `${dur.toFixed(3)}s`,
        "--fan-delay": `${(covered ? tail + (i - DECK_VISIBLE) * TAIL_STEP : LEAD + Math.max(0, i - 1) * STEP).toFixed(3)}s`,
        "--fold-delay": `${((list.length - 1 - i) * FOLD).toFixed(3)}s` });
    });
    setVars(lane, { "--fold-total": `${((list.length - 1) * FOLD + slowest).toFixed(3)}s` });
  }

  // Tick rail: one mark per card (capped), the newest marked, the card under
  // the pointer in the accent colour (components/tick-rail.js, simplified).
  function paintTicks() {
    const n = Math.min(cards.children.length, 24);
    clear(ticks).append(...Array.from({ length: n }, (_, i) => h("span.lvA__tick", { cls: i === 0 ? "is-on" : i === 1 ? "is-near" : "" })));
  }
  cards.addEventListener("pointerover", (ev) => {
    const c = ev.target.closest(".lvA__card"), i = c ? [...cards.children].indexOf(c) : -1;
    [...ticks.children].forEach((x, j) => x.classList.toggle("is-hov", j === i));
  });
  cards.addEventListener("pointerleave", () => { for (const x of ticks.children) x.classList.remove("is-hov"); });

  function sync() {
    const n = cards.children.length;
    empty.hidden = n > 0; lane.hidden = n === 0;
    paintMore(); paintTicks();
    requestAnimationFrame(paintFan); // heights are known after layout
  }
  // Oldest first so the newest ends up on top of the pile (rising --z).
  cards.append(...feed.events.filter((e) => !dismissed.has(e.key)).slice(0, DECK_MAX).reverse().map((e) => card(e, false)).reverse());
  sync();
  return {
    add(fresh) {
      for (const e of [...fresh].reverse()) cards.prepend(card(e, true));
      while (cards.children.length > DECK_MAX) cards.lastChild.remove();
      sync();
    },
    ages() { for (const el of cards.querySelectorAll(".lvA__age")) el.textContent = shortAge(Number(el.dataset.at)); },
  };
}
