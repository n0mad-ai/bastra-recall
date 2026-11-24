// Dashboard (SCREENS.md › Dashboard, prototype isDash): a board of widgets,
// freely combinable (+ WIDGET, ARRANGE). Width snaps to twelfths, height to
// rows; row height Compact / Regular / Fit view. The layout persists in
// localStorage. Free build: Today, Weather, Tasks, Deadlines, Memory
// (js/sections/dashboard-widgets.js). Mail, Week/Calendar and Coding agents
// are Pro: recall-pulse adds them through window.recallUi.registerWidget().
//
// registerWidget({ type, code, title|titleKey, desc|descKey, icon, w, h,
//   minW, minH, defaultOn?, render(body, env) → { meta?, tone? } })
//   env: { item: {w,h}, wPx, hPx, rowH, now: Date, ctx, go(statePatch), redraw() }
//   returns meta (head text), tone, and optionally onMeta + metaTitle (meta becomes a button)
//   defaultOn: the widget joins a board the user has not arranged yet.
import { addStrings, t, LANG } from "../i18n.js";
import { registerArea, extendRecallUi, ICON } from "../areas.js";
import { onData } from "../data.js";
import { h, s, clear } from "../dom.js";
import { state, setState } from "../state.js";
import { COMPACT_BELOW } from "../layout.js";
import { BUILTIN, openTasks, deadlines } from "./dashboard-widgets.js";
import en from "../i18n/dashboard-en.js";
import de from "../i18n/dashboard-de.js";

addStrings(en, de);

const STORE = "recall-v22-dash";
const GAP = 12;
const DEFAULT = [
  ["briefing", 5, 3],
  ["weather", 7, 3],
  ["tasks", 4, 3],
  ["deadlines", 4, 3],
  ["memory", 4, 3],
];
const PRESETS = [
  { id: "default", items: DEFAULT },
  {
    id: "focus",
    items: [
      ["briefing", 4, 3],
      ["tasks", 8, 3],
      ["deadlines", 6, 3],
      ["memory", 6, 3],
    ],
  },
];
const ROW_OPTS = [
  [72, "db.lay.compact"],
  [84, "db.lay.regular"],
  ["fit", "db.lay.fit"],
];

// ── widget registry ───────────────────────────────────────────────────────
const widgets = new Map();
const extraDefaults = [];

export function registerWidget(def) {
  if (!def || typeof def.type !== "string" || typeof def.render !== "function") return;
  widgets.set(def.type, { w: 4, h: 2, minW: 3, minH: 1, ...def });
  if (def.defaultOn && !extraDefaults.includes(def.type)) extraDefaults.push(def.type);
  redraw();
  refreshPanel();
}

const wTitle = (w) => w.title || t(w.titleKey);
const wDesc = (w) => w.desc || (w.descKey ? t(w.descKey) : "");

// ── board state ───────────────────────────────────────────────────────────
const fromList = (list) => list.map(([type, w, hh]) => ({ id: type, type, w, h: hh }));
const loadSaved = () => {
  try {
    const sv = JSON.parse(localStorage.getItem(STORE) || "null");
    if (sv && Array.isArray(sv.items)) {
      const items = sv.items
        .filter((i) => i && typeof i.type === "string" && Number.isFinite(i.w) && Number.isFinite(i.h))
        .map((i) => ({
          id: typeof i.id === "string" ? i.id : i.type,
          type: i.type,
          w: Math.min(12, Math.max(1, i.w)),
          h: Math.min(6, Math.max(1, i.h)),
        }));
      return { items, rowH: sv.rowH === "fit" || sv.rowH === 72 || sv.rowH === 84 ? sv.rowH : 84 };
    }
  } catch {
    /* storage blocked or broken: default board */
  }
  return null;
};
const saved = loadSaved();
// Unknown types (a Pro widget while Pro is not loaded) stay in the saved
// list so they come back with Pro; they are just not drawn.
const B = {
  items: saved?.items ?? null,
  rowH: saved?.rowH ?? 84,
  edit: false,
  drag: null,
  over: null,
  rz: null,
  flash: null,
};

function items() {
  if (B.items) return B.items;
  return [
    ...fromList(DEFAULT),
    ...extraDefaults.map((type) => ({ id: type, type, w: widgets.get(type).w, h: widgets.get(type).h })),
  ];
}
function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ items: items(), rowH: B.rowH }));
  } catch {
    /* storage blocked */
  }
}
function setItems(list) {
  B.items = list;
  save();
  redraw();
  refreshPanel();
}
const shown = () => items().filter((i) => widgets.has(i.type));

function add(type) {
  const w = widgets.get(type);
  if (!w) return;
  if (!items().some((i) => i.type === type)) setItems([{ id: type, type, w: w.w, h: w.h }, ...items()]);
  focus(type);
}

let flashT = 0;
function focus(id) {
  clearTimeout(flashT);
  B.flash = id;
  redraw();
  flashT = setTimeout(() => {
    B.flash = null;
    redraw();
  }, 1700);
  setTimeout(() => {
    const el = scroller?.querySelector(`[data-dash-id="${CSS.escape(id)}"]`);
    if (el)
      scroller.scrollTo({
        top: el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 8,
        behavior: "smooth",
      });
  }, 60);
}

// ── geometry ──────────────────────────────────────────────────────────────
let scroller = null,
  gridEl = null,
  ctxRef = null,
  vis = null;

function colsFor(width) {
  return width >= 900 ? 12 : width >= 560 ? 6 : 1;
}
function spanFor(w, cols) {
  return cols === 12 ? w : cols === 6 ? Math.min(6, Math.max(3, Math.round(w / 2))) : 1;
}

/** Rows the dense grid needs (prototype pack()). */
function packRows(list, cols) {
  const occ = [];
  let maxR = 0;
  for (const it of list) {
    const c = Math.min(cols, spanFor(it.w, cols)),
      r = it.h;
    for (let row = 0; row < 300; row++) {
      let ok = false,
        col = 0;
      for (; col + c <= cols; col++) {
        ok = true;
        for (let y = row; y < row + r && ok; y++)
          for (let x = col; x < col + c; x++)
            if (occ[y]?.[x]) {
              ok = false;
              break;
            }
        if (ok) break;
      }
      if (ok) {
        for (let y = row; y < row + r; y++) {
          occ[y] = occ[y] || [];
          for (let x = col; x < col + c; x++) occ[y][x] = 1;
        }
        maxR = Math.max(maxR, row + r);
        break;
      }
    }
  }
  return maxR;
}

// ── rendering ─────────────────────────────────────────────────────────────
let raf = 0;
function redraw() {
  if (!scroller || raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    draw();
  });
}

function stamp(now) {
  const L = LANG === "de" ? "de-DE" : "en-US";
  const p = (o) => now.toLocaleDateString(L, o).replace(".", "");
  return `${p({ weekday: "short" })} ${String(now.getDate()).padStart(2, "0")} ${p({ month: "short" })} ${now.getFullYear()} · ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`.toUpperCase();
}

function summary(now) {
  const due = openTasks().filter((x) => x.state === "due").length;
  const head = due === 0 ? t("db.sum.free") : due === 1 ? t("db.sum.due1") : t("db.sum.dueN", { n: due });
  const dl = deadlines(now).find((x) => x.at > now.getTime());
  return head + (dl ? (dl.days === 0 ? t("db.sum.nextToday") : t("db.sum.next", { d: dl.days })) : t("db.sum.end"));
}

function draw() {
  if (!scroller) return;
  const now = new Date(),
    hr = now.getHours();
  const width = gridEl?.clientWidth || scroller.clientWidth - 6;
  const cols = colsFor(width),
    list = shown();
  const fit = B.rowH === "fit",
    rowsN = packRows(list, cols);
  const v = vis || { vh: scroller.clientHeight, top: 80 };
  const fitH = rowsN ? Math.floor((v.vh - v.top - 24 - (rowsN - 1) * GAP) / rowsN) : 84;
  const fitOk = fit && fitH >= 72;
  const rowH = fit ? (fitOk ? fitH : 84) : B.rowH;
  const note =
    fit && !fitOk
      ? t("db.note.fitScroll")
      : cols === 12
        ? t("db.note.cols12", { px: rowH })
        : cols === 6
          ? t("db.note.cols6")
          : t("db.note.cols1");
  const scrollTop = scroller.scrollTop;

  const head = h(
    "div.db__head",
    null,
    h(
      "div.db__hl",
      null,
      h("div.db__kicker", { text: t("db.kicker", { stamp: stamp(now) }) }),
      h(
        "h1.db__title",
        null,
        t(hr < 12 ? "db.greet.morning" : hr < 18 ? "db.greet.afternoon" : "db.greet.evening"),
        " ",
        h("span.db__sum", { text: summary(now) })
      )
    ),
    h(
      "div.db__acts",
      null,
      h("button.db-btn", { text: t("db.addWidget"), on: { click: openLib } }),
      h("button.db-btn", {
        cls: B.edit ? "is-on" : "",
        text: B.edit ? t("db.done") : t("db.arrange"),
        on: {
          click: () => {
            B.edit = !B.edit;
            redraw();
          },
        },
      })
    )
  );

  const bar = B.edit
    ? h(
        "div.db__bar",
        null,
        h("span.db__bar-t", { text: t("db.ar.t") }),
        h("span", { text: t("db.ar.grip") }),
        h("span", { text: t("db.ar.width") }),
        h("span", { text: t("db.ar.rows") }),
        h("span.db__bar-n", { text: note })
      )
    : null;

  gridEl = h(
    "div.db__grid",
    {
      cls: [fitOk ? "is-fit" : "", fit ? "is-fitmode" : ""].join(" "),
      vars: {
        "--cols": cols,
        "--rows": fitOk ? "minmax(72px, 1fr)" : `${rowH}px`,
        "--minh": fitOk ? `${Math.max(0, v.vh - v.top)}px` : "0px",
        "--pb": fit ? "1px" : "24px",
      },
    },
    B.edit
      ? h(
          "div.db__guides",
          null,
          Array.from({ length: cols }, () => h("span"))
        )
      : null,
    list.map((it) => widgetEl(it, { cols, width, rowH, fitOk, now })),
    list.length ? null : h("p.db__empty", { text: t("db.empty") })
  );

  clear(scroller).append(...[head, bar, gridEl].filter(Boolean));
  scroller.scrollTop = scrollTop;
  // Fit view needs the real grid top and viewport height (prototype _dsVis).
  const nv = {
    vh: scroller.clientHeight,
    top: Math.round(gridEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop),
  };
  const moved = !vis || Math.abs(vis.vh - nv.vh) > 1 || Math.abs(vis.top - nv.top) > 1;
  vis = nv;
  if (moved && fit) redraw();
  if (note !== lastNote) {
    lastNote = note;
    if (state.tab === "layout") setTimeout(refreshPanel, 0);
  }
}
let lastNote = "";

function widgetEl(it, { cols, width, rowH, fitOk, now }) {
  const w = widgets.get(it.type);
  const cs = spanFor(it.w, cols),
    wPx = cols === 1 ? width : (width / cols) * cs;
  const hPx = rowH * it.h + GAP * (it.h - 1);
  const body = h("div.dw__body");
  let out = {};
  try {
    out =
      w.render(body, {
        item: it,
        wPx,
        hPx,
        rowH,
        now,
        ctx: ctxRef,
        redraw,
        go: (patch) => setState({ hover: null, tab: "areas", ...patch }),
      }) || {};
  } catch (err) {
    console.warn("dashboard widget", it.type, err);
  }
  const isOver = B.over && B.over.id === it.id && B.drag && B.drag !== it.id;
  const el = h(
    "div.dw",
    {
      "data-dash-id": it.id,
      cls: [
        B.edit ? "is-edit" : "",
        fitOk ? "is-fit" : "",
        isOver ? `is-over is-${B.over.side}` : "",
        B.rz === it.id || B.flash === it.id ? "is-hot" : "",
        B.flash === it.id ? "is-flash" : "",
        B.drag === it.id ? "is-dragged" : "",
      ].join(" "),
      vars: { "--cs": cs, "--rs": it.h },
      on: { dragover: (e) => onOver(e, it), drop: (e) => onDrop(e, it) },
    },
    h("span.dw__corners"),
    h(
      "div.dw__head",
      null,
      B.edit
        ? h(
            "span.dw__grip",
            {
              draggable: "true",
              title: t("db.drag"),
              on: { dragstart: (e) => onDragStart(e, it), dragend: onDragEnd },
            },
            s(
              "svg",
              { viewBox: "0 0 10 16" },
              s("path", {
                d: "M2 2h2v2H2ZM6 2h2v2H6ZM2 7h2v2H2ZM6 7h2v2H6ZM2 12h2v2H2ZM6 12h2v2H6Z",
                fill: "currentColor",
              })
            )
          )
        : null,
      h("span.dw__code", { text: w.code || "" }),
      h("span.dw__title", { text: wTitle(w) }),
      h(typeof out.onMeta === "function" ? "button.dw__meta.is-btn" : "span.dw__meta", {
        cls: out.tone ? `is-${out.tone}` : "",
        text: out.meta || "",
        title: out.metaTitle || null,
        on: typeof out.onMeta === "function" ? { click: out.onMeta } : null,
      }),
      B.edit
        ? [
            h("span.dw__size", { text: `${it.w} × ${it.h}` }),
            h("button.dw__x", {
              title: t("db.remove"),
              "aria-label": t("db.remove"),
              text: "×",
              on: { click: () => setItems(items().filter((x) => x.id !== it.id)) },
            }),
          ]
        : null
    ),
    body,
    B.edit
      ? [
          h(
            "span.dw__rz.dw__rz--x",
            { title: t("db.rzX"), on: { pointerdown: (e) => resize(e, it.id, "x") } },
            h("span")
          ),
          h(
            "span.dw__rz.dw__rz--y",
            { title: t("db.rzY"), on: { pointerdown: (e) => resize(e, it.id, "y") } },
            h("span")
          ),
          h(
            "span.dw__rz.dw__rz--xy",
            { title: t("db.rzXY"), on: { pointerdown: (e) => resize(e, it.id, "xy") } },
            h("span")
          ),
        ]
      : null
  );
  return el;
}

// ── arrange: drag to move, pull edges to resize ───────────────────────────
function onDragStart(e, it) {
  B.drag = it.id;
  if (e.dataTransfer) {
    e.dataTransfer.setData("text/plain", it.id);
    e.dataTransfer.effectAllowed = "move";
    const el = e.currentTarget.closest("[data-dash-id]");
    if (el && e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(el, 24, 19);
  }
  setTimeout(redraw, 0);
}
function onDragEnd() {
  B.drag = null;
  B.over = null;
  redraw();
}
function onOver(e, it) {
  if (!B.drag || B.drag === it.id) return;
  e.preventDefault();
  const r = e.currentTarget.getBoundingClientRect(),
    side = e.clientX - r.left < r.width / 2 ? "before" : "after";
  if (!B.over || B.over.id !== it.id || B.over.side !== side) {
    B.over = { id: it.id, side };
    redraw();
  }
}
function onDrop(e, it) {
  e.preventDefault();
  const from = B.drag,
    o = B.over;
  B.drag = null;
  B.over = null;
  if (!from || from === it.id) {
    redraw();
    return;
  }
  const all = items(),
    mv = all.find((x) => x.id === from),
    rest = all.filter((x) => x.id !== from);
  let idx = rest.findIndex((x) => x.id === it.id);
  if (o && o.side === "after") idx += 1;
  rest.splice(idx, 0, mv);
  setItems(rest);
  focus(from);
}

function resize(e, id, ax) {
  e.preventDefault();
  e.stopPropagation();
  if (!gridEl) return;
  const it0 = items().find((i) => i.id === id),
    w = it0 && widgets.get(it0.type);
  if (!w) return;
  const ux = (gridEl.getBoundingClientRect().width + GAP) / 12;
  const uy =
    (B.rowH === "fit"
      ? (gridEl.querySelector(`[data-dash-id="${CSS.escape(id)}"]`)?.getBoundingClientRect().height + GAP) / it0.h
      : B.rowH + GAP) || 96;
  const x0 = e.clientX,
    y0 = e.clientY;
  const move = (ev) => {
    const cur = items().find((i) => i.id === id);
    if (!cur) return;
    const nw = ax.includes("x") ? Math.min(12, Math.max(w.minW, it0.w + Math.round((ev.clientX - x0) / ux))) : cur.w;
    const nh = ax.includes("y") ? Math.min(6, Math.max(w.minH, it0.h + Math.round((ev.clientY - y0) / uy))) : cur.h;
    if (nw !== cur.w || nh !== cur.h) {
      B.items = items().map((i) => (i.id === id ? { ...i, w: nw, h: nh } : i));
      redraw();
    }
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    B.rz = null;
    save();
    redraw();
    refreshPanel();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  B.rz = id;
  redraw();
}

// ── right panel: Widgets (library) and Layout ─────────────────────────────
function openLib() {
  setState({ tab: "areas", lensOpen: true, lensPeek: state.vw < COMPACT_BELOW ? true : state.lensPeek });
  refreshPanel();
}
function refreshPanel() {
  if (ctxRef && state.view === "dashboard") ctxRef.refreshLens();
}

const icon = (d) => s("svg", { viewBox: "0 0 24 24" }, s("path", { d }));

function libTab(body) {
  const all = [...widgets.values()],
    on = (type) => items().some((i) => i.type === type);
  body.append(
    h(
      "div.lens__sec.dbp",
      null,
      h(
        "div.dbp__h",
        null,
        h("span.dbp__t", { text: t("db.lib.t") }),
        h("span.dbp__n", { text: t("db.lib.count", { n: shown().length, m: all.length }) })
      ),
      h("p.dbp__p", { text: t("db.lib.text") }),
      h(
        "div.dbp__lib",
        null,
        all.map((w) => {
          const isOn = on(w.type);
          return h(
            "div.dbp__item",
            { cls: isOn ? "is-on" : "" },
            h("span.dbp__ico", null, icon(w.icon || ICON.dashboard)),
            h(
              "span.dbp__txt",
              null,
              h(
                "span.dbp__row",
                null,
                h("span.dbp__it", { text: wTitle(w) }),
                h("span.dbp__sz", { text: `${w.w} × ${w.h}` })
              ),
              h("span.dbp__d", { text: wDesc(w) })
            ),
            h("button.dbp__btn", {
              text: isOn ? t("db.lib.on") : t("db.lib.add"),
              on: { click: () => (isOn ? focus(w.type) : add(w.type)) },
            })
          );
        })
      )
    )
  );
}

function cells(list) {
  return h(
    "div.dbp__map",
    null,
    list
      .filter((x) => widgets.has(x.type))
      .map((x) => {
        const hot = x.type === "briefing" || x.type === "weather";
        return h("span", {
          title: wTitle(widgets.get(x.type)),
          cls: hot ? "is-hot" : "",
          vars: { "--w": x.w, "--h": x.h },
        });
      })
  );
}

function layoutTab(body) {
  const fit = B.rowH === "fit";
  body.append(
    h(
      "div.lens__sec.dbp",
      null,
      h(
        "div.dbp__h.dbp__h--lay",
        null,
        h("span.dbp__t", { text: t("db.lay.t") }),
        h("span.dbp__n", { text: lastNote })
      ),
      h("div.dbp__k", { text: t("db.lay.board") }),
      cells(items()),
      h("div.dbp__k.dbp__k--gap", { text: t("db.lay.row") }),
      h(
        "div.dbp__seg",
        null,
        ROW_OPTS.map(([v, key]) =>
          h("button", {
            cls: B.rowH === v || (fit && v === "fit") ? "is-on" : "",
            text: t(key),
            on: {
              click: () => {
                B.rowH = v;
                vis = null;
                save();
                redraw();
                refreshPanel();
              },
            },
          })
        )
      ),
      h("div.dbp__k.dbp__k--gap", { text: t("db.lay.from") }),
      h(
        "div.dbp__pres",
        null,
        PRESETS.map((p) => {
          const list = fromList(p.items);
          return h(
            "div.dbp__pre",
            null,
            h(
              "div.dbp__pre-h",
              null,
              h(
                "span.dbp__pre-t",
                null,
                h("span.dbp__it", { text: t(`db.pre.${p.id}.t`) }),
                h("span.dbp__d", { text: t(`db.pre.${p.id}.d`) })
              ),
              h("button.dbp__apply", { text: t("db.lay.apply"), on: { click: () => setItems(list) } })
            ),
            cells(list)
          );
        })
      ),
      h("button.dbp__reset", {
        text: t("db.lay.reset"),
        on: {
          click: () => {
            B.rowH = 84;
            vis = null;
            setItems(fromList(DEFAULT));
          },
        },
      })
    )
  );
}

// ── mount ─────────────────────────────────────────────────────────────────
function mount(stage, ctx) {
  ctxRef = ctx;
  scroller = h("div.db");
  stage.append(scroller);
  vis = null;
  draw();
  const ro = new ResizeObserver(() => {
    vis = null;
    redraw();
  });
  ro.observe(scroller);
  const off = onData(redraw);
  // Clock and day line: once a minute, on the minute.
  let tick = 0;
  const arm = () => {
    tick = setTimeout(
      () => {
        if (!document.hidden) redraw();
        arm();
      },
      60000 - (Date.now() % 60000) + 50
    );
  };
  arm();
  return () => {
    ro.disconnect();
    off();
    clearTimeout(tick);
    cancelAnimationFrame(raf);
    raf = 0;
    scroller = null;
    gridEl = null;
    B.edit = false;
    B.drag = null;
    B.over = null;
  };
}

registerArea({
  id: "dashboard",
  group: "home",
  order: 1,
  labelKey: "nav.dashboard",
  icon: ICON.dashboard,
  pinAgent: true,
  greetingKey: "agent.greeting.dashboard",
  presetKeys: ["agent.sug.brief", "agent.sug.due"],
  tabs: [
    { id: "areas", labelKey: "lens.widgets", render: (b) => libTab(b) },
    { id: "layout", labelKey: "lens.layout", render: (b) => layoutTab(b) },
  ],
  mount,
});

for (const w of BUILTIN) registerWidget(w);
// Docking point for recall-pulse (Mail, Week/Calendar, Coding agents).
extendRecallUi({ registerWidget });
