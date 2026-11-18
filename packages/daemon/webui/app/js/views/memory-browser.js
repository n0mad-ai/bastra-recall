// Memory browser (SCREENS.md › Vault-Ansichten › Ring; prototype Recall UI
// web UI, MEMORY BROWSER): "OPEN IN BROWSER" on an area or memory card grows a
// full window out of the clicked button over the stage — scope menu,
// search, type chips, sort, a 90-day creation pulse, the list and a reader.
//
// Daniel (12.11.2026): the entry exists in every vault view (ring, lenses,
// Mindspace / Clouds / Semantic); each mounts the browser over its own stage,
// never over other areas. Its state is module-wide, so an open browser stays
// open while switching between vault views.
//
// Real data:
//   list, chips, pulse, stats, links — vault() from GET /ui/graph
//   last recalled, tags, scope        — the same graph nodes (reach.last_at …)
//   reader text, topic, source        — GET /ui/graph/node?id= (as the old map inspector;
//                                        cached per generation, membrowser-detail.js)
//   edit, archive, undo, rule state   — POST /ui/memory/edit | archive | restore (membrowser-edit.js)
//   semantic hits                     — GET /ui/search?q= (as the old map search)
//   vault care flags                  — GET /ui/annotations, POST /ui/annotate (membrowser-care.js)
// The prototype's recall_when, version, file path, sessions, reflex mode and
// per-day recall heat are not served by the daemon; those parts stay out.
import { h, clear, setVars, searchIcon } from "../dom.js";
import { t, addStrings, numberFmt } from "../i18n.js";
import { state, setState } from "../state.js";
import { data, onData, loadGraph } from "../data.js";
import { ask } from "../agent.js";
import { cover } from "../cover.js";
import { vault, areaCol, ago } from "./vault-data.js";
import { TC, INK, ACC, MUT, dateStr, lastPress } from "./chrome.js";
import { viewLocked, lastVaultView } from "./pro-views.js";
import { careBlock } from "./membrowser-care.js";
import { detailCache, readerKey, readerPlan } from "./membrowser-detail.js";
import { readerEdit, archiveNotice, editing } from "./membrowser-edit.js";
import { nextSelection } from "./membrowser-edit-model.js";
import { markdown } from "./markdown.js";
import en from "../i18n/membrowser-en.js";
import de from "../i18n/membrowser-de.js";

addStrings(en, de);

const DAY = 864e5,
  PAGE = 120,
  CLASSES = ["decision", "rule", "convention", "fact", "note", "reference"];

const M = {
  open: false,
  scope: "all",
  q: "",
  type: "all",
  sort: "recent",
  sel: null,
  menu: false,
  reader: false,
  limit: PAGE,
  sem: [],
  semQ: "",
  from: null,
  grow: false,
  focus: false,
  nav: false, // opened from the rail as its own area: no close, Esc does not close (state.browser)
};
let inst = null;

/** Focus a memory in the mounted vault view (its glide / fly + info card).
 *  false when no vault view is mounted or it has no such hook. */
export function showInView(id) {
  if (!inst?.showMemory) return false;
  inst.showMemory(id);
  return true;
}

/** Close an open browser with its shrink, then run `after` (stage.js: leaving
 *  the vault views closes it before the area changes). false when none is open. */
export function closeMemoryBrowser(after) {
  if (!M.open || !inst) return false;
  inst.hide(after);
  return true;
}

/** Open the browser on an area (or "all"), optionally with a memory selected. */
/** `from` is where the user clicked: the clicked element's DOMRect (or a
 *  { left, top, right, bottom } box) taken at click time — the window grows
 *  out of exactly that spot and shrinks back into it. */
/** `nav`: opened from the rail as its own area (Daniel 16.11.2026); a link
 *  followed while the browser stands as an area keeps it one. */
export function openMemoryBrowser(scope, sel, from, nav = false) {
  const asArea = nav || state.browser === "nav";
  const browser = asArea ? "nav" : "vault";
  // Already standing (not shrinking away): it switches in place, no new grow.
  const standing = M.open && !!state.browser;
  Object.assign(M, {
    nav: asArea,
    open: true,
    scope: scope || "all",
    sel: sel || null,
    q: "",
    type: "all",
    menu: false,
    reader: !!sel,
    limit: PAGE,
    sem: [],
    semQ: "",
    from: standing ? M.from : box(from) || pressBox(),
    grow: !standing,
    focus: !!sel,
  });
  // The browser lives in the vault views (ring, lenses, map engines), which
  // mount it; from anywhere else the ring takes over and plays the same grow
  // (the last free view while the Pro views are locked, pro-views.js). As an
  // area it opens over the last vault view, which the rail's Vault then shows.
  // state.browser is set at once, so the rail is right before the grow ends.
  if (inst) {
    // A departure may still be shrinking this mounted browser. Reopening is
    // a new navigation intent: restore its host before cancelling that timer.
    setState({ view: inst.view, browser });
    inst.show(!standing);
  } else setState({ view: asArea || viewLocked("ring") ? lastVaultView() : "ring", browser });
}

/** The rail's Browser entry: opens the browser as an area; one already open
 *  as a vault layer becomes the area in place (selection and filters stay). */
export function openMemoryBrowserArea(from) {
  if (state.browser === "nav") return;
  if (state.browser === "vault" && inst) {
    M.nav = true;
    setState({ browser: "nav" });
    inst.mode();
    return;
  }
  openMemoryBrowser("all", null, from, true);
}

const box = (r) =>
  r && [r.left, r.top, r.right, r.bottom].every(Number.isFinite)
    ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    : null;
// Fallback origin for callers without a rect: the last pointer press (within 1 s).
const pressBox = () => {
  const p = lastPress();
  return p ? { left: p.x - 1, top: p.y - 1, right: p.x + 1, bottom: p.y + 1 } : null;
};

// ── data helpers ───────────────────────────────────────────────────────────
let extraFor = null,
  extra = new Map();
/** Graph-node fields vault() does not keep (reach.last_at, tags, scope). */
function extras() {
  const g = data.graph;
  if (g && g !== extraFor) {
    extra = new Map();
    for (const n of g.nodes)
      if (n && typeof n.id === "string")
        extra.set(n.id, {
          lastAt: Date.parse(typeof n.reach?.last_at === "string" ? n.reach.last_at : ""),
          tags: Array.isArray(n.tags) ? n.tags.filter((x) => typeof x === "string") : [],
          scope: typeof n.scope === "string" ? n.scope : "",
          days: days30(n.recall_days),
        });
    extraFor = g;
  }
  return extra;
}

/** `recall_days` ([daysAgo, loads] pairs from the daemon) → 30 bins, oldest first, today last. */
function days30(list) {
  const out = new Array(30).fill(0);
  if (Array.isArray(list))
    for (const x of list)
      if (Array.isArray(x) && Number.isInteger(x[0]) && x[0] >= 0 && x[0] < 30 && Number.isFinite(x[1]))
        out[29 - x[0]] += Math.max(0, x[1]);
  return out;
}
/** Heat bars (prototype heatRow): scale 4 loads per bar, more fill the bar. */
function heat(el, days, hot) {
  const mx = Math.max(4, ...days);
  el.append(
    ...days.map((v) =>
      h("span.mb-heat__b", {
        cls: v ? "is-v" : "",
        vars: { "--h": v ? `${Math.max(15, (v / mx) * 100).toFixed(0)}%` : "1px", "--c": hot },
      })
    )
  );
  return el;
}
const NO_DAYS = new Array(30).fill(0);

// Node details for the reader: a new generation on every graph change and reopen (#1449).
const details = detailCache();

let care = null; // [{ id, kind, note, date, done }] from GET /ui/annotations
async function loadCare() {
  try {
    const r = await fetch("/ui/annotations", { credentials: "same-origin" });
    const b = r.ok ? await r.json() : null;
    care = Array.isArray(b?.annotations) ? b.annotations.filter((a) => a && typeof a.id === "string") : [];
  } catch {
    care = [];
  }
}

const todayStart = () => {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
};
const daysAgo = (ms) => (Number.isFinite(ms) ? Math.floor((todayStart() - ms) / DAY) : Infinity);
const byRecent = (a, b) => (Number.isFinite(b.at) ? b.at : -Infinity) - (Number.isFinite(a.at) ? a.at : -Infinity);
const str = (v) => (typeof v === "string" ? v : "");

// The reader's mini Markdown lives in views/markdown.js; the task reports and the agent window
// still take it from here.
export { markdown };

// ── mount ──────────────────────────────────────────────────────────────────
/** Mount into a vault view's stage. `showMemory(id)` focuses a memory in that view (glide / fly + card). */
export function mountMemoryBrowser(stage, { showMemory } = {}) {
  const hostView = state.view;
  const input = h("input.mb__input", {
    type: "text",
    spellcheck: "false",
    placeholder: t("mb.search"),
    on: { input: onInput },
  });
  const hits = h("span.mb__hits");
  const scopeBtn = h("button.mb__scopebtn", {
    on: {
      click: () => {
        M.menu = !M.menu;
        renderHead();
      },
    },
  });
  const menu = h("div.mb__menu", { hidden: true });
  const chips = h("div.mb__chips"),
    sorts = h("div.mb__sorts"),
    bars = h("div.mb__bars");
  const list = h("div.mb__list"),
    reader = h("div.mb__reader");
  const esc = h("button.mb__esc", { title: t("mb.close"), text: t("mb.esc"), on: { click: () => hide() } });
  const root = h(
    "div.mb",
    null,
    h("span.mb__ticks"),
    h(
      "div.mb__head",
      null,
      h("span.mb__title", { text: t("mb.title") }),
      h("span.mb__slash", { text: "/" }),
      h("div.mb__scope", null, scopeBtn, menu),
      h("label.mb__search", null, searchIcon(), input, hits),
      esc
    ),
    h("div.mb__bar", null, chips, sorts),
    h(
      "div.mb__pulse",
      null,
      h("span.mb__plab", { text: t("mb.created90") }),
      bars,
      h("span.mb__plab.is-now", { text: t("mb.now") })
    ),
    h("div.mb__body", null, list, reader)
  );
  stage.append(root);

  // growing: the open animation runs; its end plays the visible scroll to the
  // selected memory, so earlier reveals (resize, graph arrival) must not jump.
  let dead = false,
    closeT = 0,
    revealT = 0,
    semT = 0,
    semSeq = 0,
    order = [],
    readerFor = undefined, // readerKey of the drawn reader (membrowser-detail.js)
    keepTop = null, // { id, top }: reader scroll to restore once a refreshed reader is filled
    seenGraph = data.graph,
    view = null,
    growing = false,
    glideId = null,
    glideT = 0;

  // ── open / close (prototype openMB / closeMB) ──
  /** As an area (rail) the browser has no close: the rail leaves it. */
  function mode() {
    root.classList.toggle("is-nav", M.nav);
    esc.hidden = M.nav;
  }
  function show(anim) {
    clearTimeout(closeT);
    details.invalidate(); // a reopened browser reads every memory fresh
    input.value = M.q;
    mode();
    if (!care)
      loadCare().then(() => {
        if (!dead && M.open) renderReader(true);
      });
    if (!anim) {
      growing = false;
      root.classList.add("is-on", "is-grow");
      render();
      scheduleReveal();
      cover("mb", true);
      return;
    }
    M.grow = false;
    // Prototype openMB: clip-path from the origin box to the full stage
    // (.5s cubic-bezier(.65,0,.25,1)); without an origin from the centre, fading in.
    const sb = stage.getBoundingClientRect(),
      o = M.from;
    const cl = (v, max) => `${Math.max(0, Math.min(max, v)).toFixed(1)}px`;
    if (o)
      setVars(root, {
        "--ct": cl(o.top - sb.top, sb.height),
        "--cr": cl(sb.right - o.right, sb.width),
        "--cb": cl(sb.bottom - o.bottom, sb.height),
        "--cl": cl(o.left - sb.left, sb.width),
        "--op": "1",
      });
    else setVars(root, { "--ct": "46%", "--cr": "46%", "--cb": "46%", "--cl": "46%", "--op": "0" });
    root.classList.remove("is-grow");
    root.classList.add("is-on");
    growing = true;
    render();
    list.scrollTop = 0; // the list scrolls from the top to the memory once the window stands
    void root.offsetWidth;
    requestAnimationFrame(() => {
      if (!dead && M.open) {
        root.classList.add("is-grow");
        scheduleReveal(520, true);
      }
    });
    // the view underneath freezes once the window covers it (js/cover.js)
    closeT = setTimeout(() => {
      if (!dead && M.open) cover("mb", true);
    }, 520);
  }
  function hide(after) {
    if (state.browser) setState({ browser: null }); // the rail follows at once, not after the shrink
    M.menu = false;
    renderHead();
    root.classList.remove("is-grow");
    clearTimeout(closeT);
    clearTimeout(revealT);
    clearTimeout(glideT);
    growing = false;
    glideId = null;
    cover("mb", false); // the view moves again while the window shrinks away
    closeT = setTimeout(() => {
      M.open = false;
      root.classList.remove("is-on");
      after?.();
    }, 480);
  }

  // ── model ──
  function model() {
    const v = vault();
    if (!v) return null;
    const q = M.q.trim().toLowerCase(),
      sem = new Set(M.semQ === M.q.trim() ? M.sem : []);
    const inScope = v.mems.filter((m) => M.scope === "all" || m.area === M.scope);
    const base = inScope.filter(
      (m) => !q || sem.has(m.id) || `${m.title} ${m.summary} ${m.area} ${m.type}`.toLowerCase().includes(q)
    );
    let rows = base.filter((m) => M.type === "all" || m.cls === M.type);
    if (M.sort === "recalled") rows = rows.slice().sort((a, b) => b.recalled - a.recalled || byRecent(a, b));
    else if (M.sort === "unused") rows = rows.slice().sort((a, b) => a.recalled - b.recalled || byRecent(a, b));
    else rows = rows.slice().sort(byRecent);
    return { v, q, sem, inScope, base, rows };
  }

  // ── render ──
  function render() {
    if (dead || !M.open) return;
    // A direct memory link wins over a caller's stale area. Resolve this only
    // once the graph arrives; later manual filtering remains under user control.
    const target = M.focus && vault()?.byId.get(M.sel);
    if (target && M.scope !== "all" && M.scope !== target.area) M.scope = target.area;
    view = model();
    renderHead();
    renderBar();
    renderPulse();
    renderList();
    renderReader();
    if (target) {
      M.focus = false;
      if (!growing) scheduleReveal();
    }
  }

  function renderHead() {
    const v = vault();
    const accent = M.scope === "all" ? ACC : areaCol(M.scope);
    setVars(root, { "--mba": accent });
    const count = view ? view.inScope.length : 0;
    clear(scopeBtn).append(
      h("span.mb__scopesq"),
      h("span.mb__scopename", { text: M.scope === "all" ? t("mb.all") : M.scope }),
      h("span.mb__mut", { text: numberFmt.format(count) }),
      h("span.mb__mut", { text: "▾" })
    );
    scopeBtn.classList.toggle("is-open", M.menu);
    menu.hidden = !M.menu;
    if (M.menu && v) {
      const opts = [["all", t("mb.all"), v.total, ACC], ...v.areas.map((a) => [a.key, a.key, a.count, areaCol(a.key)])];
      clear(menu).append(
        ...opts.map(([id, name, n, c]) =>
          h(
            "button.mb__opt",
            {
              cls: id === M.scope ? "is-on" : "",
              on: {
                click: () => {
                  Object.assign(M, { scope: id, menu: false, limit: PAGE, type: "all" });
                  render();
                },
              },
            },
            h("span.mb__optdot", { vars: { "--c": c } }),
            h("span.mb__optname", { text: name }),
            h("span.mb__mut", { text: numberFmt.format(n) })
          )
        )
      );
    }
    hits.textContent = view && view.q ? t("mb.hits", { n: numberFmt.format(view.base.length) }) : "";
  }

  function renderBar() {
    if (!view) {
      clear(chips);
      clear(sorts);
      return;
    }
    const { base } = view;
    const types = [
      ["all", t("mb.allChip"), base.length, ACC],
      ...CLASSES.map((c) => [c, t(`vv.cls.${c}`), base.filter((m) => m.cls === c).length, TC[c]]),
    ].filter((x) => x[0] === "all" || x[2] > 0 || x[0] === M.type);
    clear(chips).append(
      ...types.map(([id, label, n, c]) =>
        h(
          "button.mb__chip",
          {
            cls: M.type === id ? "is-on" : "",
            on: {
              click: () => {
                Object.assign(M, { type: id, limit: PAGE });
                render();
              },
            },
          },
          h("span.mb__chipdot", { vars: { "--c": c } }),
          label,
          h("span.mb__mut", { text: numberFmt.format(n) })
        )
      )
    );
    clear(sorts).append(
      ...["recent", "recalled", "unused"].map((id) =>
        h("button.mb__sort", {
          cls: M.sort === id ? "is-on" : "",
          text: t(`mb.sort.${id}`),
          on: {
            click: () => {
              Object.assign(M, { sort: id, limit: PAGE });
              render();
            },
          },
        })
      )
    );
  }

  function renderPulse() {
    const bins = new Array(30).fill(0),
      now = Date.now();
    for (const m of view ? view.base : []) {
      const d = (now - m.created) / DAY;
      if (d >= 0 && d < 90) bins[29 - Math.floor(d / 3)]++;
    }
    const mx = Math.max(1, ...bins),
      sel = M.sel && vault()?.byId.get(M.sel);
    const sd = sel ? (now - sel.created) / DAY : NaN,
      selBin = sd >= 0 && sd < 90 ? 29 - Math.floor(sd / 3) : -1;
    if (bars.children.length !== 30) clear(bars).append(...bins.map(() => h("span.mb__pb")));
    bins.forEach((n, i) => {
      const el = bars.children[i];
      setVars(el, { "--h": n ? `${Math.max(12, (n / mx) * 100).toFixed(0)}%` : "1px" });
      el.classList.toggle("is-v", n > 0);
      el.classList.toggle("is-sel", i === selBin);
      el.title = t("mb.pulseTip", { n, a: (29 - i) * 3, b: (29 - i) * 3 + 3 });
    });
  }

  function row(m) {
    const c = TC[m.cls] || INK;
    return h(
      "button.mb-row",
      { "data-id": m.id, cls: m.id === M.sel ? "is-sel" : "", on: { click: () => select(m.id, true) } },
      h("span.mb-row__sq", { vars: { "--tc": c } }),
      h("span.mb-row__t", { text: m.title }),
      h("span.mb-row__ago", { text: Number.isFinite(m.at) ? ago(m.at) : "" }),
      h(
        "span.mb-row__meta",
        null,
        h("span.mb-row__type", { text: m.type || t(`vv.cls.${m.cls}`), vars: { "--tc": c } }),
        M.scope === "all"
          ? h("span.mb-row__area", null, h("span.mb-row__adot", { vars: { "--ac": areaCol(m.area) } }), m.area)
          : null,
        h("span", { text: t("mb.recalled", { n: numberFmt.format(m.recalled) }) }),
        view.sem.has(m.id) && view.q && !`${m.title} ${m.summary} ${m.area} ${m.type}`.toLowerCase().includes(view.q)
          ? h("span.mb-row__ai", { text: t("mb.semantic"), title: t("mb.semanticTip") })
          : null
      ),
      heat(
        h("span.mb-heat.mb-row__heat", { title: t("mb.heatTip") }),
        extras().get(m.id)?.days || NO_DAYS,
        m.id === M.sel ? ACC : "rgba(56,217,245,.55)"
      )
    );
  }

  function renderList() {
    const top = list.scrollTop;
    clear(list);
    if (!view) {
      order = [];
      return;
    }
    const { rows } = view;
    // A selected memory may be older than the first page (also for wikilinks
    // and remounts in another vault view). Materialize its row before scrolling.
    const selected = rows.findIndex((m) => m.id === M.sel);
    if (selected >= M.limit) M.limit = Math.ceil((selected + 1) / PAGE) * PAGE;
    const shown = rows.slice(0, M.limit);
    order = rows.map((m) => m.id);
    const group = (label, n, items) => [
      h("div.mb__gh", null, h("span", { text: label }), h("span", { text: numberFmt.format(n) })),
      ...items.map(row),
    ];
    if (M.sort === "recent") {
      const B = [
        ["today", 0],
        ["week", 6],
        ["month", 29],
        ["earlier", Infinity],
      ];
      const bucket = (m) => {
        const d = daysAgo(m.at);
        return B.findIndex(([, lim]) => d <= lim);
      };
      B.forEach(([id], i) => {
        const all = rows.filter((m) => bucket(m) === i),
          vis = shown.filter((m) => bucket(m) === i);
        if (vis.length) list.append(...group(t(`mb.g.${id}`), all.length, vis));
      });
    } else list.append(...group(t(M.sort === "recalled" ? "mb.g.recalled" : "mb.g.unused"), rows.length, shown));
    if (rows.length > shown.length)
      list.append(
        h("button.mb__more", {
          text: t("mb.more", { n: numberFmt.format(Math.min(PAGE, rows.length - shown.length)) }),
          on: {
            click: () => {
              M.limit += PAGE;
              render();
            },
          },
        })
      );
    if (!rows.length)
      list.append(h("div.mb__empty", { text: t("mb.empty", { s: M.scope === "all" ? t("mb.all") : M.scope }) }));
    list.scrollTop = top;
    if (glideId && glideId === M.sel) reveal(glideId, true);
  }

  // ── selection ──
  function select(id, fromList) {
    M.sel = id;
    M.reader = true;
    render();
    if (!fromList) scheduleReveal();
  }
  function step(d) {
    if (!order.length) return;
    const i = order.indexOf(M.sel),
      n = i < 0 ? 0 : Math.min(order.length - 1, Math.max(0, i + d));
    if (n >= M.limit) M.limit = Math.ceil((n + 1) / PAGE) * PAGE;
    select(order[n]);
  }
  /** Bring the selected row into view. `glide` (after the open animation):
   *  centre it with a visible scroll from where the list stands; far targets
   *  first jump to one list height before the row, so the glide stays short
   *  and arrives in time (old memories sit thousands of rows down). Otherwise
   *  jump, and only when the row is out of view. */
  function reveal(id, glide) {
    const el = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect(),
      b = list.getBoundingClientRect();
    if (!b.height) return; // narrow reader: the list is hidden, "back" reveals again
    const max = list.scrollHeight - list.clientHeight;
    const to = Math.max(0, Math.min(max, r.top - b.top + list.scrollTop - (b.height - r.height) / 2));
    if (!glide) {
      if (r.top < b.top + 34 || r.bottom > b.bottom) list.scrollTo({ top: to, behavior: "instant" });
      return;
    }
    if (Math.abs(to - list.scrollTop) < 4) return;
    if (Math.abs(to - list.scrollTop) > b.height * 1.5)
      list.scrollTo({ top: to > list.scrollTop ? to - b.height : to + b.height, behavior: "instant" });
    list.scrollTo({ top: to, behavior: "smooth" });
    // A list re-render (live data) cancels a running smooth scroll: renderList
    // resumes it while the glide lasts, and its end makes sure the row is in view.
    glideId = id;
    clearTimeout(glideT);
    glideT = setTimeout(() => {
      glideId = null;
      if (!dead && M.open && M.sel === id) reveal(id);
    }, 1000);
  }
  function scheduleReveal(delay = 0, glide = false) {
    clearTimeout(revealT);
    if (!glide) growing = false; // a user step or link ends the pending open glide
    const id = M.sel;
    revealT = setTimeout(() => {
      if (glide) growing = false;
      if (!dead && M.open && M.sel === id) reveal(id, glide);
    }, delay);
  }
  /** A linked memory: select it, widening the scope when it lives elsewhere. */
  function follow(id) {
    const m = vault()?.byId.get(id);
    if (!m) return;
    Object.assign(M, {
      scope: M.scope === "all" || M.scope === m.area ? M.scope : "all",
      type: "all",
      q: "",
      sem: [],
      semQ: "",
    });
    input.value = "";
    select(id);
  }

  // ── reader ──
  function renderReader(force) {
    const v = vault(),
      m = M.sel && v ? v.byId.get(M.sel) : null;
    const narrow = root.clientWidth > 0 && root.clientWidth < 760;
    root.classList.toggle("is-narrow", narrow);
    root.classList.toggle("is-reading", !!m && M.reader);
    const key = readerKey(m, v, narrow, details.gen);
    const plan = force ? "rebuild" : readerPlan(readerFor, key, readerBusy());
    if (plan === "keep") {
      updatePos();
      return;
    }
    if (plan === "refresh") return refreshReader(key);
    readerFor = key;
    clear(reader);
    reader.scrollTop = 0;
    if (!m) {
      const nosel = h("div.mb__nosel", null, t("mb.pick"), h("br"), t("mb.pickKeys"));
      reader.append(...[archiveNotice(M.sel, editDeps), nosel].filter(Boolean));
      return;
    }
    const c = TC[m.cls] || INK,
      ex = extras().get(m.id) || { lastAt: NaN, tags: [], scope: "", days: NO_DAYS };
    const text = h("div.mb-rd__text.is-wait", { text: t("mb.loading") });
    const facts = h("div.mb-rd__facts");
    const pos = h("span.mb-rd__pos");
    // last load: the newest day of the 30-day series, else the usage clock
    const lastBin = ex.days.findLastIndex((x) => x > 0);
    const last = lastBin >= 0 ? 29 - lastBin : Number.isFinite(ex.lastAt) ? daysAgo(ex.lastAt) : null;
    const box = h(
      "div.mb-rd__box",
      null,
      h("div.mb-rd__boxk", { text: t("mb.summary") }),
      h("div.mb-rd__boxv", { text: m.summary })
    );
    const reflex = h("span.mb-rd__flag", { text: "REFLEX", hidden: true });
    const title = h("h2.mb-rd__h", { text: m.title });
    const ed = readerEdit(m, { anchor: title, box, text, ...editDeps });
    const stats = [
      [numberFmt.format(m.recalled), "recalled", INK],
      [numberFmt.format(m.acted), "acted", ACC],
      [m.recalled ? `${Math.round((m.acted / m.recalled) * 100)}%` : "—", "rate", m.recalled ? ACC : MUT],
      [last === null ? t("mb.never") : last <= 0 ? t("mb.today") : t("mb.dAgo", { n: last }), "last", INK],
    ];
    const links = m.links.map((l) => ({ l, o: v.byId.get(l.id) })).filter((x) => x.o);
    const el = h(
      "div.mb-rd",
      null,
      archiveNotice(M.sel, editDeps),
      narrow
        ? h("button.mb-rd__back", {
            text: t("mb.back"),
            on: {
              click: () => {
                M.reader = false;
                renderReader(true);
                scheduleReveal();
              },
            },
          })
        : null,
      h(
        "div.mb-rd__top",
        null,
        h("span.mb-rd__chip", { text: t(`vv.cls.${m.cls}`), vars: { "--tc": c } }),
        h(
          "button.mb-rd__area",
          {
            on: {
              click: () => {
                Object.assign(M, { scope: m.area, menu: false, limit: PAGE });
                render();
              },
            },
          },
          h("span.mb-rd__adot", { vars: { "--ac": areaCol(m.area) } }),
          m.area
        ),
        m.type ? h("span", { text: m.type }) : null,
        ed.badge,
        reflex,
        pos
      ),
      title,
      m.summary ? box : null,
      text,
      h(
        "div.mb-rd__stats",
        null,
        stats.map(([val, k, col]) =>
          h(
            "div.mb-rd__stat",
            null,
            h("span.mb-rd__sv", { text: val, vars: { "--c": col } }),
            h("span.mb-rd__sk", { text: t(`mb.st.${k}`) })
          )
        )
      ),
      h("div.mb-rd__hk", null, h("span", { text: t("mb.recalls30") }), h("span", { text: t("mb.todayK") })),
      heat(h("div.mb-heat.mb-rd__heat"), ex.days, ACC),
      links.length
        ? [
            h("div.mb-rd__k", { text: t("mb.linked", { n: links.length }) }),
            h(
              "div.mb-rd__links",
              null,
              links.map(({ l, o }) =>
                h(
                  "button.mb-rd__link",
                  { on: { click: () => follow(o.id) } },
                  h("span.mb-rd__rel", {
                    text: `${t(`mb.rel.${l.rel}`)} →`,
                    vars: { "--rc": l.rel === "linked" ? ACC : MUT },
                  }),
                  h("span.mb-rd__lt", { text: o.title }),
                  h("span.mb-rd__la", null, h("span.mb-rd__ladot", { vars: { "--ac": areaCol(o.area) } }), o.area)
                )
              )
            ),
          ]
        : null,
      facts,
      h(
        "div.mb-rd__acts",
        null,
        h("button.mb-btn.is-primary", { text: t("mb.ask"), on: { click: () => ask(t("mb.askQ", { m: m.title })) } }),
        showMemory
          ? h("button.mb-btn", {
              text: t(state.view === "ring" ? "mb.inRing" : "mb.inView"),
              on: {
                click: () => {
                  const id = m.id;
                  hide(() => showMemory(id));
                },
              },
            })
          : null,
        ed.acts
      ),
      careBlock(m, careDeps())
    );
    reader.append(el);
    const fill = (d) => {
      const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
      const mode = d ? (d.recall_mode === "reflex" ? t("mb.mode.reflex") : t("mb.mode.auto")) : "";
      clear(facts).append(
        ...[
          ["file", str(d?.file)],
          ["created", Number.isFinite(m.created) ? dateStr(m.created) : str(d?.created)],
          ["updated", Number.isFinite(m.at) ? dateStr(m.at) : str(d?.updated)],
          ["mode", mode],
          ["id", m.id],
          ["type", m.type],
          ["scope", str(d?.scope) || ex.scope],
          ["topic", list(d?.topic_path).join(" / ")],
          ["tags", (d ? list(d.tags) : ex.tags).join(" · ")],
          ["source", str(d?.source)],
        ]
          .filter(([, val]) => val)
          .flatMap(([k, val]) => [h("span.mb-rd__fk", { text: t(`mb.f.${k}`) }), h("span.mb-rd__fv", { text: val })])
      );
    };
    fill(null);
    updatePos(pos);
    details.load(m.id).then((d) => {
      if (dead || readerFor !== key) return;
      fill(d);
      // RECALL WHEN (prototype box): the memory's own triggers
      const when = Array.isArray(d?.recall_when) ? d.recall_when.filter((x) => typeof x === "string" && x.trim()) : [];
      if (when.length) {
        clear(box).append(
          h("div.mb-rd__boxk", { text: t("mb.recallWhen") }),
          h("div.mb-rd__boxv", { text: when.join(" · ") })
        );
        if (!box.isConnected) el.insertBefore(box, text);
      }
      reflex.hidden = d?.recall_mode !== "reflex";
      const body = str(d?.body).trim();
      text.classList.remove("is-wait");
      if (body) clear(text).append(...markdown(body, follow));
      else if (d && box.firstChild?.textContent === t("mb.recallWhen") && m.summary) text.textContent = m.summary;
      else if (d) text.remove();
      else {
        text.classList.add("is-wait");
        text.textContent = t("mb.noBody");
      }
      ed.attach(d);
      restoreScroll(m.id);
    });
  }
  /** After a refresh: back to where the reader stood (#1449). */
  function restoreScroll(id) {
    if (keepTop?.id !== id) return;
    reader.scrollTop = keepTop.top;
    keepTop = null;
  }
  /** An open editor or a field the user types in: a refresh waits for it. */
  function readerBusy() {
    const f = document.activeElement;
    return editing(M.sel) || (reader.contains(f) && /^(TEXTAREA|INPUT|SELECT)$/.test(f.tagName));
  }
  /** Same memory, newer data (#1449): fetch first, then redraw at the same
   *  scroll position — no flash of "loading", the selection stays. */
  function refreshReader(key) {
    readerFor = key;
    details.load(key.id).then(() => {
      if (dead || readerFor !== key) return;
      // a refresh that overtook another keeps the position from before both
      if (keepTop?.id !== key.id) keepTop = { id: key.id, top: reader.scrollTop };
      renderReader(true);
    });
  }
  function updatePos(el = reader.querySelector(".mb-rd__pos")) {
    if (!el) return;
    const i = order.indexOf(M.sel);
    el.textContent = i >= 0 ? `${i + 1} / ${order.length}` : "";
  }

  // Editing in the reader (membrowser-edit.js): after a write the graph and
  // this reader reload; an archived memory hands the selection to its neighbour.
  function afterWrite() {
    details.invalidate();
    // the new graph redraws list, counts and reader (onData); without one, the reader alone
    loadGraph().finally(() => {
      if (!dead) renderReader();
    });
  }
  const editDeps = {
    refresh: afterWrite,
    rerender: () => renderReader(),
    reload: (id) => {
      details.invalidate();
      return details.load(id);
    },
    archived: (id) => {
      M.sel = nextSelection(order, id);
      M.reader = !!M.sel;
      afterWrite();
      return M.sel;
    },
    restored: (id) => {
      Object.assign(M, { sel: id, reader: true, focus: true });
      afterWrite();
    },
  };

  // Vault care block (membrowser-care.js): the loaded flags, how a new one is
  // kept, and the redraw after a save.
  const careDeps = () => ({
    care: care || [],
    add: (entry) => (care ||= []).push(entry),
    rerender: () => {
      if (!dead) renderReader(true);
    },
  });

  // ── search: local filter at once, semantic recall (≥ 3 chars) after a pause ──
  function onInput() {
    M.q = input.value;
    M.limit = PAGE;
    render();
    clearTimeout(semT);
    const q = M.q.trim();
    if (q.length < 3) {
      M.sem = [];
      M.semQ = "";
      return;
    }
    semT = setTimeout(async () => {
      const my = ++semSeq;
      let ids = [];
      try {
        const r = await fetch(`/ui/search?q=${encodeURIComponent(q)}`, { credentials: "same-origin" });
        const b = r.ok ? await r.json() : null;
        ids = (Array.isArray(b?.hits) ? b.hits : []).map((x) => x && x.id).filter((x) => typeof x === "string");
      } catch {
        /* none */
      }
      if (dead || my !== semSeq || M.q.trim() !== q) return;
      M.sem = ids;
      M.semQ = q;
      render();
    }, 220);
  }

  // ── keys: Esc closes (menu, then query, then window — not an area); ↑ ↓ walk the list ──
  function onKey(e) {
    if (!M.open || !root.classList.contains("is-grow")) return;
    const tag = e.target?.tagName;
    if (e.key === "Escape") return onEscape(e);
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && tag !== "INPUT" && tag !== "TEXTAREA") {
      e.preventDefault();
      step(e.key === "ArrowDown" ? 1 : -1);
    }
  }
  function onEscape(e) {
    const clearQuery = e.target === input && M.q;
    if (M.nav && !M.menu && !clearQuery) return; // an area is left through the rail
    e.preventDefault();
    e.stopImmediatePropagation();
    if (M.menu) {
      M.menu = false;
      renderHead();
    } else if (clearQuery) {
      input.value = "";
      onInput();
    } else hide();
  }
  window.addEventListener("keydown", onKey, true);
  const onDoc = (e) => {
    if (M.menu && !e.target.closest?.(".mb__scope")) {
      M.menu = false;
      renderHead();
    }
  };
  document.addEventListener("pointerdown", onDoc);
  const ro = new ResizeObserver(() => {
    if (M.open) {
      renderReader();
      if (!growing) scheduleReveal();
    }
  });
  ro.observe(root);
  const unData = onData(() => {
    // #1449: a new graph means memories may have changed — details are stale.
    if (data.graph !== seenGraph) {
      seenGraph = data.graph;
      details.invalidate();
    }
    if (M.open) render();
  });

  inst = { show, showMemory, hide, mode, view: hostView };
  if (M.open) show(M.grow);

  return () => {
    dead = true;
    clearTimeout(closeT);
    clearTimeout(revealT);
    clearTimeout(glideT);
    clearTimeout(semT);
    // A close that was still animating finishes here.
    if (!root.classList.contains("is-grow")) M.open = false;
    if (!M.open && state.browser) setState({ browser: null });
    cover("mb", false); // the next vault view covers again if the browser stays open
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onDoc);
    ro.disconnect();
    unData();
    root.remove();
    if (inst?.show === show) inst = null;
  };
}
