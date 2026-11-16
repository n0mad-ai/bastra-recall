// Tasks area — reports (Daniel 16.11.2026): agents file their final report
// with task_report_save instead of a long chat answer; here the user reads it
// and deletes it with one click. Head button "BERICHTE · n" next to "FÄLLIG"
// opens the list as a pop-over over the calendar (same frame as the due
// cards); a click shows the report in the detail panel (tk-dt) and marks it
// read. The list itself is data.reports (js/data.js, rides on the task
// polling), so the nav dot and the header ticker see the same rows.
// Report text is external data: rendered through the shared mini Markdown
// renderer (text nodes only) plus a text-only table for pipe tables.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { data, onData, loadReports } from "../data.js";
import { markdown, openMemoryBrowser } from "../views/memory-browser.js";
import { ago } from "../views/vault-data.js";
import { loadingInline } from "./loading.js";
import { S, emit, say, act, select } from "./tasks-store.js";
import { api, fmtAt } from "./tasks-api.js";
import { unreadCount, originText, reportBlocks } from "./tasks-reports-model.js";

// open: list pop-over · sel: report shown in the panel · body: its text (null = loading) · scroll: panel position
// order: row order frozen while the list is open, so a row read there does not jump away under the pointer
const R = { open: false, sel: null, body: null, scroll: 0, order: [] };

let lastKey = JSON.stringify(data.reports);
onData(() => {
  const key = JSON.stringify(data.reports);
  if (key === lastKey) return;
  lastKey = key;
  if (R.sel && !data.reports.some((r) => r.id === R.sel)) R.sel = null; // deleted elsewhere
  emit("reports");
});

export const hasUnreadReports = () => unreadCount(data.reports) > 0;
const otherOverlay = () => S.compose || S.showDue || !!S.proposal;

export function closeReports() {
  R.open = false;
  emit();
}

/** Head button in the style of "FÄLLIG · n"; the dot glows while reports are unread. */
export function reportsButton() {
  const unread = unreadCount(data.reports);
  return h(
    "button.tk-duebtn.tk-repbtn",
    {
      cls: R.open && !otherOverlay() ? "is-on" : "",
      title: unread ? t("tk.rep.unreadTip", { n: unread }) : null,
      on: {
        click: () => {
          R.open = !R.open || otherOverlay();
          R.order = data.reports.map((r) => r.id);
          S.compose = S.showDue = false;
          S.proposal = null;
          emit();
          if (R.open) loadReports();
        },
      },
    },
    h("span.tk-duebtn__dot.tk-repbtn__dot", { cls: unread ? "" : "is-off" }),
    t("tk.rep.btn", { n: data.reports.length })
  );
}

/** Opens a report in the detail panel (list row, header ticker) and marks it read. */
export async function openReport(id) {
  R.sel = id;
  R.body = null;
  R.scroll = 0;
  select(null, { view: "tasks" });
  try {
    const r = await api("report_read", { id });
    if (R.sel === id) R.body = typeof r?.body === "string" ? r.body : "";
  } catch (e) {
    if (R.sel === id) R.sel = null;
    say(e.code === "not_found" ? t("tk.rep.gone") : e.message, "error");
  }
  emit();
  loadReports();
}

function remove(id) {
  return act(async () => {
    try {
      await api("report_delete", { id });
    } catch (e) {
      if (e.code !== "not_found") throw e;
    }
    if (R.sel === id) R.sel = null;
    await loadReports();
    return t("tk.rep.deleted");
  });
}

function listRow(r) {
  const meta = [originText(r) || t("tk.rep.unknown"), r.project, ago(r.createdAt)].filter(Boolean).join(" · ");
  return h(
    "button.tk-rep__row",
    {
      cls: [r.readAt === null ? "is-new" : "", R.sel === r.id && !S.sel ? "is-on" : ""].join(" "),
      title: fmtAt(r.createdAt),
      on: { click: () => openReport(r.id) },
    },
    h("span.tk-rep__dot"),
    h("span.tk-rep__txt", null, h("span.tk-rep__t", { text: r.title }), h("span.tk-rep__m", { text: meta }))
  );
}

/** Rows in the order they had when the list opened; reports that arrived since go on top. */
function listed() {
  const at = (r) => R.order.indexOf(r.id);
  return [...data.reports].sort((a, b) => at(a) - at(b));
}

function popover() {
  const rows = listed();
  return h(
    "div.tk-pop.tk-pop--rep",
    { role: "dialog", "aria-label": t("tk.rep.title") },
    h(
      "div.tk-pop__h.is-row",
      null,
      h("span.tk-pop__k.tk-rep__k", { text: t("tk.rep.title") }),
      h("span.tk-pop__n", { text: t("tk.rep.count", { u: unreadCount(rows), n: rows.length }) }),
      h("button.tk-pop__x", { text: t("tk.close"), on: { click: closeReports } })
    ),
    rows.length ? h("div.tk-rep__list", null, rows.map(listRow)) : h("p.tk-due__none", { text: t("tk.rep.none") })
  );
}

/** Keeps dimmer and pop-over mounted across polling; only a real change redraws the list. */
export function reportsRenderer(host) {
  let shown = false,
    key = "";
  return () => {
    if (otherOverlay()) R.open = false;
    const sig = JSON.stringify([data.reports, R.sel, S.sel]);
    if (R.open === shown && (!R.open || sig === key)) return;
    if (!R.open) host.replaceChildren();
    else if (!shown) host.replaceChildren(h("div.tk-dim", { on: { click: closeReports } }), popover());
    else {
      const current = host.querySelector(".tk-pop"),
        scroll = current.scrollTop;
      current.replaceChildren(...popover().childNodes);
      current.scrollTop = scroll;
    }
    shown = R.open;
    key = sig;
  };
}

/** Escape closes the list (tasks.js key handler); true when it was open. */
export function escapeReports() {
  if (!R.open) return false;
  closeReports();
  return true;
}

function table(b) {
  return h(
    "div.tk-rep__tbl",
    null,
    h(
      "table",
      null,
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          b.head.map((c) => h("th", { text: c }))
        )
      ),
      h(
        "tbody",
        null,
        b.rows.map((r) =>
          h(
            "tr",
            null,
            r.map((c) => h("td", { text: c }))
          )
        )
      )
    )
  );
}

const follow = (id) => openMemoryBrowser("all", id);
const bodyNodes = (text) =>
  reportBlocks(text).flatMap((b) => (b.kind === "table" ? [table(b)] : markdown(b.text, follow)));

function detail(r) {
  const facts = [[t("tk.rep.origin"), originText(r) || t("tk.rep.unknown")]];
  if (r.project) facts.push([t("tk.rep.project"), r.project]);
  facts.push([t("tk.rep.filed"), fmtAt(r.createdAt)]);
  if (r.readAt !== null) facts.push([t("tk.rep.readAt"), fmtAt(r.readAt)]);
  return h(
    "div.tk-dt.tk-rep",
    null,
    h("span.tk-dt__k.is-acc", { text: t("tk.rep.kicker") }),
    h("h2.tk-dt__t", { text: r.title }),
    h(
      "div.tk-dt__facts",
      null,
      facts.map(([k, v]) => [h("span.tk-dt__fk", { text: k }), h("span.tk-dt__fv", { text: v })])
    ),
    h(
      "div.tk-dt__acts",
      null,
      h("button.tk-btn.is-pri", { text: t("tk.rep.delete"), on: { click: () => remove(r.id) } })
    ),
    R.body === null
      ? h("p.tk-pn__empty", null, loadingInline(t("tk.loading")))
      : h("div.tk-rep__md", null, bodyNodes(R.body))
  );
}

/** Detail panel content for the open report, or null (a selected task wins). */
export function reportPanel(body) {
  if (S.sel) R.sel = null;
  const r = R.sel ? data.reports.find((x) => x.id === R.sel) : null;
  if (!r) return null;
  // Keep the reading position when a refresh rebuilds the panel (one handler, replaced per render).
  const node = h("div.tk-pn", null, detail(r));
  requestAnimationFrame(() => {
    if (node.isConnected) body.scrollTop = R.scroll;
  });
  body.onscroll = () => {
    if (node.isConnected) R.scroll = body.scrollTop;
  };
  return node;
}

/** Header ticker: one entry per unread report, in the ticker's own item shape (js/header.js). */
export function reportTickerItems() {
  return data.reports
    .filter((r) => r.readAt === null)
    .map((r) => ({
      tag: t("tk.rep.kicker"),
      color: "var(--accent)",
      text: r.title,
      meta: ago(r.createdAt),
      pv: {
        tag: t("tk.rep.tkTag"),
        title: r.title,
        sub: [originText(r) || t("tk.rep.unknown"), r.project, fmtAt(r.createdAt)].filter(Boolean).join(" · "),
        body: "",
        whyLabel: t("tk.rep.tkWhy"),
        why: t("tk.rep.tkWhyText"),
        openLabel: t("tk.rep.tkOpen"),
        ask: t("tk.rep.tkAsk", { title: r.title }),
      },
      onClick: () => openReport(r.id),
    }));
}
