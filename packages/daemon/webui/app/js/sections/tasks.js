// Tasks area (SCREENS.md › Aufgaben, prototype STAGE › isTasks): compact head
// with status pills, calendar (setting calStyle: ledger here; flow | stream |
// relay belong to Recall Pulse and dock in via tasks-styles.js), drag & drop with drop zones, pop-overs that dim and
// blur the calendar, form "New task", panel tabs Details / View / Control.
// Real data and actions through the old UI's endpoints (tasks-store.js).
//
// Files: tasks-api.js (daemon + model), tasks-store.js (state + actions),
// tasks-cal.js (shared calendar pieces), tasks-styles.js (docking point for
// calendar styles; Pro styles register via window.recallUi), tasks-ledger.js,
// tasks-overlays.js (pop-overs), tasks-panel.js (right panel).
import { addStrings, t } from "../i18n.js";
import { registerArea, ICON } from "../areas.js";
import { h, s, setVars, clear } from "../dom.js";
import { state } from "../state.js";
import { hud, hudPills, hudButton } from "./hud.js";
import { loadingBlock } from "./loading.js";
import {
  S,
  onTasks,
  emit,
  save,
  refresh,
  loadWeather,
  openDue,
  select,
  review,
  lifecycle,
  moveDue,
  assign,
  openSource,
} from "./tasks-store.js";
import { canMove, holderOf } from "./tasks-api.js";
import * as cal from "./tasks-cal.js";
import { calendarStyle, onCalendarStyles } from "./tasks-styles.js";
import { KEYS, label, ICON as KICON, onSelect, endDrag } from "./tasks-cal.js";
import { splitPanel, weekDays, monthStart, rangeOf } from "./tasks-ledger.js";
import { overlayRenderer } from "./tasks-overlays.js";
import { watchSettledWidth } from "./tasks-width.js";
import { detailTab, viewTab, controlTab, statusTiles, dueList } from "./tasks-panel.js";
import {
  reportsRenderer,
  reportsOpen,
  resetReports,
  escapeReports,
  reportsArea,
  tasksLit,
  showCalendar,
} from "./tasks-reports.js";
import { outlineTab } from "./tasks-reports-toc.js";
import en from "../i18n/tasks-en.js";
import de from "../i18n/tasks-de.js";

addStrings(en, de);

let size = { bw: 600, bh: 480 };

function head() {
  const dueN = dueList().length;
  return hud({
    compact: true,
    cls: "tk-hud",
    kicker: t("tk.kicker"),
    title: S.W >= 700 ? t("tk.title") : "",
    side: [
      ...(S.W >= 760 ? hudPills(statusTiles()) : []),
      h(
        "button.tk-duebtn",
        {
          cls: S.showDue ? "is-on" : "",
          on: {
            click: () => {
              if (S.showDue) {
                S.showDue = false;
                emit();
              } else openDue();
            },
          },
        },
        h("span.tk-duebtn__dot"),
        t("tk.dueBtn", { n: dueN })
      ),
      hudButton(t("tk.new"), () => {
        S.compose = !S.compose;
        S.showDue = false;
        S.proposal = null;
        emit();
      }),
    ],
  });
}

function toolbar(v) {
  const wide = S.W >= 700,
    agOn = v.canAgenda && S.agenda;
  const short = { [t("tk.lv.week")]: t("tk.lv.weekShort"), [t("tk.lv.month")]: t("tk.lv.monthShort") };
  const btn = (txt, fn, aria) => h("button.tk-tb__b", { text: txt, "aria-label": aria || null, on: { click: fn } });
  return h(
    "div.tk-tb",
    null,
    v.nav
      ? h(
          "div.tk-tb__nav",
          null,
          btn("‹", v.prev, t("tk.prev")),
          btn(t("tk.todayBtn"), v.today),
          btn("›", v.next, t("tk.next"))
        )
      : null,
    wide || !v.zoom
      ? h(
          "div.tk-tb__range",
          null,
          h("span.tk-tb__title", { text: v.range ?? rangeOf().range }),
          wide ? h("span.tk-tb__sub", { text: v.sub ?? rangeOf().sub }) : null
        )
      : null,
    v.canAgenda
      ? h(
          "button.tk-tb__ag",
          {
            cls: agOn ? "is-on" : "",
            title: t("tk.agendaTip"),
            on: {
              click: () => {
                S.agenda = !S.agenda;
                save();
                emit();
              },
            },
          },
          s("svg", { viewBox: "0 0 24 24" }, s("path", { d: "M3 4h18v16H3zM9 4v16" })),
          wide ? t("tk.agenda") : null
        )
      : null,
    h(
      "div.tk-tb__seg",
      { cls: v.canAgenda ? "" : "is-auto" },
      v.levels.map((o) =>
        h("button", {
          cls: o.on ? "is-on" : "",
          text: S.W < 700 ? short[o.label] || o.label : o.label,
          on: { click: o.onClick },
        })
      )
    ),
    v.zoom
      ? h(
          "div.tk-tb__zoom",
          { cls: wide ? "" : "is-narrow" },
          h("button", { "aria-label": t("tk.zoomOut"), title: t("tk.zoomOut"), text: "−", on: { click: v.zoom.out } }),
          wide ? h("span", { text: v.zoom.label }) : null,
          h("button", { "aria-label": t("tk.zoomIn"), title: t("tk.zoomIn"), text: "+", on: { click: v.zoom.in } })
        )
      : null
  );
}

function legend() {
  const counts = {};
  for (const x of S.items) counts[x.k] = (counts[x.k] || 0) + 1;
  return h(
    "div.tk-lgd",
    null,
    KEYS.map((k) =>
      h(
        "button.tk-lgd__b",
        {
          cls: [`tk-k-${k}`, S.hide[k] ? "is-off" : ""].join(" "),
          on: {
            click: () => {
              S.hide = { ...S.hide, [k]: !S.hide[k] };
              save();
              emit();
            },
          },
        },
        h("span.tk-lgd__sw"),
        S.W >= 700 ? label(k) : null,
        h("span.tk-lgd__n", { text: String(counts[k] || 0) })
      )
    ),
    S.W >= 700 ? h("span.tk-lgd__hint", { text: t("tk.legendHint") }) : null
  );
}

function tray() {
  const none = S.items.filter((x) => !x.at && !S.hide[x.k]);
  return h(
    "div.tk-tray",
    null,
    h("span.tk-tray__l", { text: t("tk.tray") }),
    none.map((x) =>
      h(
        "article.tk-tray__it",
        { cls: `tk-k-${x.k}`, title: x.t.goal, on: { click: onSelect(x) } },
        h("span.tk-tray__ic", { text: KICON[x.k] }),
        h("span.tk-tray__t", { text: x.t.goal })
      )
    ),
    none.length ? null : h("span.tk-tray__empty", { text: t("tk.trayEmpty") })
  );
}

let ctxRef = null,
  bodyEl = null,
  ro = null;
function calendar() {
  // Unregistered (Pro) style saved earlier → the free default.
  const style = calendarStyle(S.style) || calendarStyle("ledger");
  const v = style.render({
    ...size,
    rebuild: () => drawCal(),
    ctx: ctxRef,
    S,
    t,
    dom: { h, s, setVars },
    actions: { emit, select, review, lifecycle, moveDue, canMove, assign, openSource, holder: holderOf },
    cal,
    ledger: { weekDays, monthStart },
  });
  const agOn = v.canAgenda && S.agenda;
  bodyEl = h("div.tk-cal__body", null, v.body);
  ro?.disconnect();
  ro = new ResizeObserver(() => {
    if (!bodyEl) return;
    const bw = bodyEl.clientWidth,
      bh = bodyEl.clientHeight;
    if (bw > 0 && (Math.abs(bw - size.bw) > 1 || Math.abs(bh - size.bh) > 1)) {
      size = { bw, bh };
      drawCal();
    }
  });
  ro.observe(bodyEl);
  return h(
    "div.tk-cal",
    null,
    toolbar(v),
    legend(),
    h("div.tk-cal__main", null, agOn ? splitPanel(weekDays()) : null, bodyEl),
    tray()
  );
}

let root = null,
  calSlot = null,
  headSlot = null,
  drawOverlays = null,
  drawReports = null;
function drawCal() {
  if (!calSlot || S.drag || reportsOpen()) return; // the reading view stands in for the calendar
  endDrag();
  clear(calSlot).append(calendar());
}

function draw() {
  if (!root) return;
  if (S.drag) return; // never rebuild under a running drag
  const content =
    S.error && !S.snap
      ? h(
          "div.tk-empty",
          null,
          h("span.wip-badge", { text: t("tk.offlineBadge") }),
          h("p", { text: S.error }),
          h("button.tk-btn", { text: t("tk.retry"), on: { click: () => refresh() } })
        )
      : null;
  // first answer pending: a run indicator instead of an empty calendar
  const wait = !content && !S.snap ? loadingBlock(t("ld.tasks")) : null;
  // Reports stand on their own (Daniel 18.11.2026): their view has its own head, without the
  // tasks' title, status tiles, "Due" and "New task"
  clear(headSlot);
  if (!reportsOpen()) headSlot.append(head());
  // an empty slot would still take the column's gap (.sx--fit .sx__in) and push the reading view
  // 8 px below the other areas' windows
  headSlot.hidden = reportsOpen();
  drawOverlays();
  drawReports();
  calSlot.hidden = reportsOpen();
  clear(calSlot);
  if (content || wait) calSlot.append(content || wait);
  if (!content && !wait) drawCal();
}

function mount(el, ctx) {
  ctxRef = ctx;
  root = el;
  root.classList.add("tk");
  headSlot = h("div.tk-headslot");
  const overlaySlot = h("div.tk-overlays"),
    reportSlot = h("div.tk-repslot", { hidden: true });
  calSlot = h("div.tk-calslot");
  root.append(headSlot, overlaySlot, reportSlot, calSlot);
  drawOverlays = overlayRenderer(overlaySlot);
  drawReports = reportsRenderer(reportSlot);
  const sro = watchSettledWidth(el, document.querySelector("main.stage"), (w) => {
    S.W = w;
    draw();
  });
  S.W = el.clientWidth || S.W;
  const off = onTasks((what) => {
    draw();
    if (what !== "cal" && state.view === "tasks") ctx.refreshLens();
  });
  const offStyles = onCalendarStyles(() => {
    draw();
    if (state.view === "tasks") ctx.refreshLens();
  });
  const key = (e) => {
    if (e.key !== "Escape") return;
    if (S.compose || S.showDue || S.proposal) {
      e.stopPropagation();
      S.compose = S.showDue = false;
      S.proposal = null;
      emit();
    } else if (!document.querySelector(".mb.is-on") && escapeReports(e.target)) e.stopPropagation(); // an open memory browser keeps its own Escape
  };
  window.addEventListener("keydown", key, true);
  draw();
  refresh();
  loadWeather();
  // CPU: the old UI polled every 1.5 s; here every 15 s while visible and idle.
  const poll = setInterval(() => {
    if (!document.hidden && !S.drag && !S.compose && !S.edit && !S.proposal) refresh(true);
  }, 15000);
  const tick = setInterval(() => {
    if (!document.hidden && !S.drag && !S.compose) drawCal();
  }, 60000); // now-line
  return () => {
    off();
    offStyles();
    sro.stop();
    ro?.disconnect();
    ro = null;
    clearInterval(poll);
    clearInterval(tick);
    window.removeEventListener("keydown", key, true);
    resetReports();
    root = null;
    calSlot = null;
    headSlot = null;
    drawOverlays = null;
    drawReports = null;
    bodyEl = null;
  };
}

const CALENDAR_TABS = [
  { id: "areas", labelKey: "lens.details", render: detailTab },
  { id: "view", labelKey: "lens.view", render: viewTab },
  { id: "control", labelKey: "lens.control", render: controlTab },
];

registerArea({
  id: "tasks",
  group: "work",
  order: 1,
  labelKey: "nav.tasks",
  icon: ICON.tasks,
  pinAgent: true,
  // the reading view has its own rail entry right below (reportsArea): Tasks is lit on the calendar
  lit: tasksLit,
  enter: showCalendar,
  section: { frame: false, fit: true },
  greetingKey: "agent.greeting.tasks",
  presetKeys: ["agent.sug.due", "agent.sug.remind"],
  // the right panel: Details / View / Control on the calendar, the reports' jump list while the
  // reading view is open (Daniel 18.11.2026: the existing panel, no second one)
  tabs: () => (reportsOpen() ? [outlineTab] : CALENDAR_TABS),
  // the header's crumb names the reports while their view is open
  crumb: () => (reportsOpen() ? t("nav.reports") : null),
  mount,
});
registerArea(reportsArea);
