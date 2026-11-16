// Telemetry area (SCREENS.md › Telemetry): the old Telemetry tab's sections
// on the daemon's GET /ui/telemetry?days=N report, in the new frame.
// Layouts document / tiles / index and heads centered / hud / hero (right
// panel › View), full-text Find over sections and rows (right panel › Find),
// the footer timeline switches to the window 1d / 7d / 30d / 90d.
// Section specs: telemetry-model.js; DOM: telemetry-render.js.
import { addStrings, t, LANG } from "../i18n.js";
import { registerArea, ICON } from "../areas.js";
import { h, s, clear } from "../dom.js";
import { state, setState, subscribe } from "../state.js";
import { registerTimelineSource } from "../timeline.js";
import { buildModel, findHits, fmt } from "./telemetry-model.js";
import { section, spark, pageHead } from "./telemetry-render.js";
import { veil, loadingBlock, loadingInline } from "./loading.js";
import en from "../i18n/telemetry-en.js";
import de from "../i18n/telemetry-de.js";

addStrings(en, de);

const KEY = "recall-v22-telemetry";
const REFRESH_MS = 30_000; // the old tab's background refresh
const STRIP_MS = 10 * 60_000; // the 90-day footer strip is costly; refresh it rarely
const DAYS = [1, 7, 30, 90];
const SEL = { 1: 1, 7: 4, 30: 17, 90: 52 }; // footer bars covered by each window (prototype selN2)
const CHIPS = ["session_hook_call", "load_memory", "p95", "shadow", "bastra-recall"];
const STYLES = [
  ["document", "M5 4h14M5 9h14M5 14h14M5 19h9"],
  ["tiles", "M4 4h7v7H4ZM13 4h7v7h-7ZM4 13h7v7H4ZM13 13h7v7h-7Z"],
  ["index", "M4 4h5v16H4ZM12 4h8M12 9h8M12 14h8M12 19h5"],
];
const HEADS = ["centered", "hud", "hero"];

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
})();
const tv = {
  days: DAYS.includes(saved.days) ? saved.days : 7,
  style: STYLES.some(([id]) => id === saved.style) ? saved.style : "document",
  // SCREENS.md: every area opens with the HUD head box; the prototype's other heads stay selectable.
  head: HEADS.includes(saved.head) ? saved.head : "hud",
  query: "",
  open: {},
};
function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ days: tv.days, style: tv.style, head: tv.head }));
  } catch {
    /* storage blocked */
  }
}

let model = null,
  error = "",
  updated = null,
  reqId = 0,
  pending = 0;
let strip = null,
  stripAt = 0,
  stripDays = [];
let view = null; // { el, frame, scroller, ctx } while mounted
const panelUpdaters = new Set();

// ── data ─────────────────────────────────────────────────────────────────
async function fetchReport(days) {
  const r = await fetch(`/ui/telemetry?days=${encodeURIComponent(days)}`, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j || typeof j !== "object" || !j.window) throw new Error("unexpected report");
  return j;
}

/**
 * silent: background tick — keeps the last good report on failure, no indicator.
 * Otherwise (first load, window switch) the old report stays on screen, dimmed
 * under the scan band, until the new one is there; only the latest request counts.
 */
async function load({ silent = false } = {}) {
  if (silent && pending) return;
  const id = ++reqId;
  if (!silent) {
    error = "";
    pending = tv.days;
    showBusy();
    if (!model) draw();
  }
  try {
    const r = await fetchReport(tv.days);
    if (id !== reqId) return;
    model = buildModel(r);
    if (model.days && model.days < tv.days) {
      tv.days = model.days;
      persist();
    }
    updated = new Date();
    error = "";
    pending = 0;
    if (tv.days === 90) setStrip(r);
    showBusy();
    draw();
    notifyPanel();
    if (Date.now() - stripAt > STRIP_MS) void loadStrip();
  } catch (e) {
    if (id !== reqId || silent) return;
    pending = 0;
    if (model) {
      // keep what is on screen and say why the switch did not happen
      tv.days = model.days || tv.days;
      persist();
      setState({ toast: { text: t("tv.error", { m: e.message }), tone: "error" } });
      showBusy();
    } else {
      error = t("tv.error", { m: e.message });
      showBusy();
      draw();
    }
  }
}

/** Run indicator: veil over the stage frame while a report is on its way, sweep on the footer button. */
function showBusy() {
  if (view) veil(view.frame, !!pending && !!model);
  tick();
}

/** Footer bars: context tokens per day over the last 90 days, folded into 52 bars. */
function setStrip(r) {
  const per = new Map(
    (Array.isArray(r.contextTax?.daily) ? r.contextTax.daily : []).map((d) => [
      String(d.day),
      (Number(d.lanes) || 0) + (Number(d.tools) || 0),
    ])
  );
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const days = Array.from({ length: 90 }, (_, i) =>
    new Date(end.getTime() - (89 - i) * 864e5).toISOString().slice(0, 10)
  );
  stripDays = Array.from({ length: 52 }, (_, i) =>
    days.slice(Math.floor((i * 90) / 52), Math.floor(((i + 1) * 90) / 52))
  );
  strip = stripDays.map((ds) => ds.reduce((n, d) => n + (per.get(d) || 0), 0));
  stripAt = Date.now();
}
async function loadStrip() {
  stripAt = Date.now();
  try {
    setStrip(await fetchReport(90));
    tick();
  } catch {
    stripAt = 0;
  }
}

/** Nudges the shell's render loop (footer timeline, lens marker). */
function tick() {
  setState({ tvRev: (state.tvRev || 0) + 1 });
}

function setDays(d) {
  if (d === tv.days && model) return;
  tv.days = d;
  persist();
  tick();
  void load();
}

// ── helpers ──────────────────────────────────────────────────────────────
// Labels describe the report on screen; while a switch loads, that is still the old window.
const shownDays = () => model?.days || tv.days;
const daysLabel = () => (shownDays() === 1 ? t("tv.last24") : t("tv.lastDays", { n: shownDays() }));
const updatedText = () =>
  updated
    ? updated.toLocaleTimeString(LANG === "de" ? "de-DE" : "en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    : "";
const q = () => tv.query.trim().toLowerCase();
function visible() {
  if (!model) return { hits: new Map(), vis: [] };
  const hits = findHits(model.sections, tv.query);
  return { hits, vis: model.sections.filter((x) => !q() || hits.get(x.id) > 0) };
}
function selected(vis) {
  return vis.find((x) => x.id === state.tvSel) || vis[0] || null;
}

// ── stage ────────────────────────────────────────────────────────────────
function status() {
  return error
    ? h("div.tv-status.is-err", { text: error })
    : loadingBlock(t("tv.loading", { n: tv.days }), { cls: "tv-loading" });
}
function noHits() {
  return h("div.tv-nohits", { text: t("tv.noHits", { q: tv.query.trim() }) });
}

function docView(vis) {
  return [
    pageHead({ model, head: tv.head, daysLabel: daysLabel(), updated: updatedText() }),
    vis.map((x) => section(x, { mode: "doc", head: tv.head, q: q() })),
    q() && !vis.length ? noHits() : null,
  ];
}

function tilesView(vis, hits) {
  return [
    pageHead({ model, head: tv.head, daysLabel: daysLabel(), updated: updatedText() }),
    h(
      "div.tv-tiles",
      null,
      vis.map((x) => {
        const open = !!tv.open[x.id],
          n = hits.get(x.id) || 0;
        return h(
          "div.tv-tile",
          { id: `tv-${x.id}`, cls: open ? "is-open" : "" },
          h("span.tv-tile__corners"),
          h(
            "button.tv-tile__head",
            {
              on: {
                click: () => {
                  tv.open[x.id] = !open;
                  draw();
                },
              },
            },
            h("span.tv-tile__n", { text: x.n }),
            h("span.tv-tile__t", null, h("span", { text: x.title }), h("span.tv-tile__kl", { text: x.keyLabel })),
            h(
              "span.tv-tile__k",
              null,
              q() && n > 0 ? h("span.tv-hits", { text: String(n) }) : null,
              h("span.tv-tile__kv", { text: x.key })
            ),
            h("span.tv-tile__chev", { text: open ? "▾" : "▸" })
          ),
          open
            ? h(
                "div.tv-tile__body",
                null,
                h("p.tv-tile__q", { text: x.q }),
                section(x, { mode: "tile", head: "none", figHead: tv.head, q: q(), idPrefix: "tvs-" })
              )
            : h("div.tv-tile__closed", null, h("p", { text: x.q }), spark(x))
        );
      })
    ),
    q() && !vis.length ? noHits() : null,
  ];
}

function indexView(vis, hits) {
  const sel = selected(vis),
    si = sel ? vis.indexOf(sel) : -1;
  const go = (id) => setState({ tvSel: id });
  return [
    h(
      "div.tv-idx__nav",
      null,
      h(
        "div.tv-idx__top",
        null,
        h("div.tv-idx__t", { text: t("nav.telemetry") }),
        h("div.tv-idx__sub", { text: t("tv.idxSub", { d: daysLabel(), n: fmt(model.events) }) })
      ),
      h(
        "div.tv-idx__figs",
        null,
        model.overview.map((o) =>
          h(
            "div.tv-idx__fig",
            { title: o.sub, cls: o.ok ? "is-ok" : "" },
            h("span.tv-idx__fk", { text: o.k }),
            h("span.tv-idx__fv", { text: o.v })
          )
        )
      ),
      h(
        "div.tv-idx__list",
        null,
        model.sections.map((x) => {
          const v = vis.includes(x),
            on = sel && x.id === sel.id,
            n = hits.get(x.id) || 0;
          return h(
            "button.tv-idx__item",
            { cls: [on ? "is-on" : "", v ? "" : "is-off"].join(" "), on: { click: () => go(x.id) } },
            h("span.tv-idx__n", { text: x.n }),
            h(
              "span.tv-idx__it",
              null,
              h("span.tv-idx__title", { text: x.title }),
              h("span.tv-idx__kl", { text: `${x.key} ${x.keyLabel}` })
            ),
            q() && n > 0 ? h("span.tv-hits", { text: String(n) }) : null
          );
        })
      )
    ),
    h(
      "div.tv-idx__main",
      null,
      sel
        ? [
            section(sel, { mode: "index", head: tv.head, q: q(), idPrefix: "tvi-" }),
            h(
              "div.tv-idx__pn",
              null,
              h("button.tv-idx__prev", {
                text: si > 0 ? `← ${vis[si - 1].title}` : "",
                on: { click: () => si > 0 && go(vis[si - 1].id) },
              }),
              h("button.tv-idx__next", {
                text: si < vis.length - 1 ? `${vis[si + 1].title} →` : "",
                on: { click: () => si < vis.length - 1 && go(vis[si + 1].id) },
              })
            ),
          ]
        : null,
      q() && !vis.length ? noHits() : null
    ),
  ];
}

function draw() {
  if (!view) return;
  const { el, frame, scroller } = view;
  frame.classList.toggle("tv-frame--index", tv.style === "index" && !!model);
  frame.classList.toggle("tv-frame--tiles", tv.style === "tiles");
  const top = scroller.scrollTop;
  if (!model) {
    clear(el).append(status());
    return;
  }
  const { hits, vis } = visible();
  clear(el).append(
    ...[tv.style === "index" ? indexView(vis, hits) : tv.style === "tiles" ? tilesView(vis, hits) : docView(vis)]
      .flat(Infinity)
      .filter(Boolean)
  );
  scroller.scrollTop = tv.style === "index" ? 0 : top;
}

/** Scroll the stage to a section (prototype tvJump): flash it, open its tile. */
function jump(id) {
  setState({ tvSel: id });
  if (!view || tv.style === "index") return;
  if (tv.style === "tiles" && !tv.open[id]) {
    tv.open[id] = true;
    draw();
  }
  const el = view.el.querySelector(`#tv-${id}`);
  if (!el) return;
  view.muteSpy = Date.now() + 1000;
  const sc = view.scroller;
  sc.scrollTo({
    top: el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 12,
    behavior: "smooth",
  });
  el.classList.add("is-flash");
  setTimeout(() => el.classList.remove("is-flash"), 1800);
}

/** Document scroll spy: the last section whose top passed 90 px is "current". */
function onScroll() {
  if (!view || tv.style !== "document" || Date.now() < (view.muteSpy || 0) || view.raf) return;
  view.raf = requestAnimationFrame(() => {
    if (!view) return;
    view.raf = 0;
    const top = view.scroller.getBoundingClientRect().top;
    let cur = null;
    for (const el of view.el.querySelectorAll("section.tv-sec"))
      if (el.getBoundingClientRect().top - top <= 90) cur = el.id.slice(3);
    if (cur && cur !== state.tvSel) setState({ tvSel: cur });
  });
}

function mount(el, ctx) {
  const frame = el.closest(".sx"),
    scroller = el.parentElement;
  frame.classList.add("tv-frame");
  view = { el, frame, scroller, ctx, raf: 0, muteSpy: 0 };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  let lastSel = state.tvSel;
  const unsub = subscribe((st) => {
    if (st.tvSel !== lastSel) {
      lastSel = st.tvSel;
      if (tv.style === "index") draw();
    }
  });
  let timer = 0;
  const arm = () => {
    clearInterval(timer);
    timer = document.hidden ? 0 : setInterval(() => void load({ silent: true }), REFRESH_MS);
  };
  const onVis = () => {
    arm();
    if (!document.hidden) void load({ silent: true });
  };
  document.addEventListener("visibilitychange", onVis);
  arm();
  draw();
  showBusy();
  void load({ silent: !!model && model.days === tv.days });
  return () => {
    clearInterval(timer);
    unsub();
    document.removeEventListener("visibilitychange", onVis);
    scroller.removeEventListener("scroll", onScroll);
    if (view?.raf) cancelAnimationFrame(view.raf);
    view = null;
  };
}

// ── right panel ──────────────────────────────────────────────────────────
function notifyPanel() {
  for (const fn of panelUpdaters) fn();
}

function findIcon() {
  return s(
    "svg",
    { viewBox: "0 0 24 24", "aria-hidden": "true" },
    s("circle", { cx: 10.5, cy: 10.5, r: 6.5, fill: "none", stroke: "currentColor", "stroke-width": 2 }),
    s("line", {
      x1: 15.5,
      y1: 15.5,
      x2: 21,
      y2: 21,
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
    })
  );
}

function findTab(body) {
  const count = h("span.lens__h-n");
  const clearBtn = h("button.tv-find__x", {
    "aria-label": t("tv.find.clear"),
    text: "×",
    on: { click: () => setQuery("") },
  });
  const input = h("input", {
    placeholder: t("tv.find.ph"),
    value: tv.query,
    on: { input: (e) => setQuery(e.target.value, true) },
  });
  const chips = h("div.tv-chips");
  const list = h("ul.lens__list.tv-find__list");
  function setQuery(v, typing = false) {
    tv.query = v;
    if (!typing) input.value = v;
    draw();
    update();
  }
  function update() {
    const { hits, vis } = visible();
    const n = [...hits.values()].reduce((a, b) => a + b, 0);
    count.textContent = !model
      ? ""
      : q()
        ? `${t(n === 1 ? "tv.find.match.1" : "tv.find.match", { n })} · ${t(vis.length === 1 ? "tv.find.sections.1" : "tv.find.sections", { n: vis.length })}`
        : t("tv.find.sections", { n: model.sections.length });
    clearBtn.hidden = !tv.query;
    clear(chips).append(
      ...CHIPS.map((c) =>
        h("button.tv-chip", {
          cls: tv.query === c ? "is-on" : "",
          text: c,
          on: { click: () => setQuery(tv.query === c ? "" : c) },
        })
      )
    );
    const sel = selected(vis);
    if (!model) {
      clear(list).append(
        error
          ? h("li.tv-find__row.is-off", { text: error })
          : h("li.tv-find__wait", null, loadingInline(t("tv.loading", { n: tv.days })))
      );
      return;
    }
    clear(list).append(
      ...model.sections.map((x) => {
        const on = sel && x.id === sel.id,
          n2 = hits.get(x.id) || 0;
        return h(
          "li.tv-find__row",
          {
            cls: [on ? "is-on" : "", vis.includes(x) ? "" : "is-off"].join(" "),
            "data-lsel": on ? "1" : null,
            on: { click: () => jump(x.id) },
          },
          h("span.tv-find__n", { text: x.n }),
          h("span.tv-find__t", { text: x.title }),
          h(
            "span.tv-find__k",
            null,
            q() && n2 > 0 ? h("span.tv-hits", { text: String(n2) }) : null,
            h("span", { text: x.key })
          )
        );
      })
    );
  }
  body.append(
    h(
      "div.lens__sec",
      null,
      h("div.lens__h", null, h("span.lens__h-t", { text: t("tv.find.title") }), count),
      h("label.lens__find.tv-find", null, findIcon(), input, clearBtn),
      chips,
      h("div.tv-find__cap", { text: t("tv.find.caps") }),
      list
    )
  );
  update();
  let lastSel = state.tvSel;
  const unsub = subscribe((st) => {
    if (st.tvSel !== lastSel) {
      lastSel = st.tvSel;
      update();
    }
  });
  panelUpdaters.add(update);
  return () => {
    unsub();
    panelUpdaters.delete(update);
  };
}

function viewTab(body, ctx) {
  const pick = (patch) => {
    Object.assign(tv, patch);
    persist();
    draw();
    ctx.refreshLens();
  };
  body.append(
    h(
      "div.lens__sec",
      null,
      h(
        "div.lens__h.tv-view__h",
        null,
        h("span.lens__h-t", { text: t("tv.view.title") }),
        h("span.tv-view__tag", { text: t("tv.view.tag") })
      ),
      h("div.tv-view__cap", { text: t("tv.view.layout") }),
      h(
        "div.tv-view__styles",
        null,
        STYLES.map(([id, d]) =>
          h(
            "button.tv-opt",
            {
              cls: tv.style === id ? "is-on" : "",
              "data-lsel": tv.style === id ? "1" : null,
              on: { click: () => pick({ style: id }) },
            },
            h("span.tv-opt__ico", null, s("svg", { viewBox: "0 0 24 24" }, s("path", { d }))),
            h(
              "span.tv-opt__txt",
              null,
              h("span.tv-opt__name", { text: t(`tv.style.${id}`) }),
              h("span.tv-opt__desc", { text: t(`tv.style.${id}.d`) })
            )
          )
        )
      ),
      h("div.tv-view__cap.is-gap", { text: t("tv.view.head") }),
      h(
        "div.tv-view__heads",
        null,
        HEADS.map((id) =>
          h(
            "button.tv-opt.tv-opt--head",
            {
              cls: tv.head === id ? "is-on" : "",
              "data-lsel": tv.head === id ? "1" : null,
              on: { click: () => pick({ head: id }) },
            },
            h("span.tv-opt__dot"),
            h(
              "span.tv-opt__txt",
              null,
              h("span.tv-opt__name", { text: t(`tv.head.${id}`) }),
              h("span.tv-opt__desc", { text: t(`tv.head.${id}.d`) })
            )
          )
        )
      )
    )
  );
}

// ── footer timeline: window 1d / 7d / 30d / 90d ──────────────────────────
registerTimelineSource("telemetry", {
  label: () => t("tv.tl.label"),
  opts: () => DAYS.map((d) => [String(d), `${d}d`, d === tv.days, d === pending]),
  pick: (v) => setDays(Number(v)),
  range: () => [52 - SEL[tv.days], 52],
  weeks: () => strip || new Array(52).fill(0),
  barTitle: (i, v) => {
    const ds = stripDays[i] || [];
    return ds.length ? t("tv.tl.bar", { a: ds[0].slice(5), b: ds[ds.length - 1].slice(5), n: fmt(v) }) : "";
  },
  summary: () =>
    t("tv.tl.sum", {
      n: model ? fmt(model.events) : "—",
      d: shownDays() === 1 ? t("tv.tl.24h") : t("tv.tl.days", { n: shownDays() }),
    }),
  axis: (kind) => {
    const ago = t("tv.tl.ago"),
      now = t("tl.now").toUpperCase();
    if (kind === "short") return [ago, now];
    if (kind === "mirror")
      return [
        ago,
        t("tv.tl.sum", {
          n: model ? fmt(model.events) : "—",
          d: shownDays() === 1 ? t("tv.tl.24h") : t("tv.tl.days", { n: shownDays() }),
        }),
        now,
      ];
    return [ago, "60", "30", now];
  },
});

registerArea({
  id: "telemetry",
  group: "vault",
  order: 2,
  labelKey: "nav.telemetry",
  icon: ICON.telemetry,
  section: { frame: true },
  tabs: [
    { id: "areas", labelKey: "lens.find", render: findTab },
    { id: "view", labelKey: "lens.view", render: viewTab },
  ],
  mount,
});
