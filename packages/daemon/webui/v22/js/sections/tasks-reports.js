// Tasks area — reports (Daniel 16.11.2026): agents file their final report
// with task_report_save instead of a long chat answer; here the user reads it.
// Head button "BERICHTE · n" next to "FÄLLIG" switches the main area from the
// calendar to the reading view, built like the memory browser: the list on
// the left, the chosen report at full width on the right (Daniel: not in the
// narrow detail panel). Opening a report does not mark it read: "Gelesen" /
// "Ungelesen" set that state by hand, "Löschen" removes it (Daniel 16.11.2026).
// The list itself is data.reports (js/data.js, rides on the shell polling), so
// the nav dot and the header ticker see the same rows.
// Report text is external data: rendered through the shared mini Markdown
// renderer (text nodes only) plus a text-only table for pipe tables.
// Notes on single places of a report: tasks-report-notes.js (Daniel 17.11.2026);
// leaving one never changes the read state.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { state, setState } from "../state.js";
import { data, onData, loadReports } from "../data.js";
import { markdown, openMemoryBrowser } from "../views/memory-browser.js";
import { ago } from "../views/vault-data.js";
import { S, emit, say, act } from "./tasks-store.js";
import { api, fmtAt } from "./tasks-api.js";
import { unreadCount, originText, reportBlocks, noteRows } from "./tasks-reports-model.js";
import { annotateReport } from "./tasks-report-notes.js";

// open: reading view replaces the calendar · sel: report shown · body: its text (null = loading)
// notes: the shown report's notes · edit: the open note field { anchor, noteId (null = new), draft }
// order: row order frozen while the view is open, so a row marked there does not jump away under the pointer
// list: narrow view shows the list instead of the reader (memory browser: "← LISTE")
// lens: the detail panel was open when the view opened; it is folded away meanwhile (a report needs
// the width, the panel has nothing to show for it) and comes back when the view closes
const R = { open: false, sel: null, body: null, notes: [], edit: null, order: [], list: false, lens: false };
/** Below this slot width list and reader share one column (memory browser: 760 px for list + reader;
 *  the report list is narrower, so two columns still fit at 640). */
const NARROW = 640;

let lastKey = JSON.stringify(data.reports);
onData(() => {
  const key = JSON.stringify(data.reports);
  if (key === lastKey) return;
  lastKey = key;
  if (R.sel && !data.reports.some((r) => r.id === R.sel)) R.sel = null; // deleted elsewhere
  if (R.open && !R.sel && data.reports.length) openReport(listed()[0].id);
  else emit("reports");
});

export const hasUnreadReports = () => unreadCount(data.reports) > 0;
/** True while the reading view stands in for the calendar (tasks.js). */
export const reportsOpen = () => R.open;

function enter() {
  setState({ view: "tasks" });
  if (R.open) return;
  R.open = true;
  R.order = data.reports.map((r) => r.id);
  R.lens = state.lensOpen;
  if (R.lens) setState({ lensOpen: false });
}

/** Leaving the Tasks area ends the view, so the next visit starts on the calendar. */
export function resetReports() {
  if (!R.open) return;
  R.open = false;
  if (R.lens) setState({ lensOpen: true });
}

export function closeReports() {
  resetReports();
  emit();
}

/** Opens the reading view (head button, dashboard widget): the first unread report, otherwise the
 *  newest (data.reports is ordered that way). */
export async function openReports() {
  enter();
  R.order = data.reports.map((r) => r.id);
  R.sel = null;
  S.compose = S.showDue = false;
  S.proposal = null;
  if (data.reports.length) openReport(data.reports[0].id);
  else emit();
  await loadReports();
}

/** Head button in the style of "FÄLLIG · n": n counts the UNREAD reports, so new ones stand out at once
 *  (#1553); the dot glows while there are any. */
export function reportsButton() {
  const unread = unreadCount(data.reports);
  return h(
    "button.tk-duebtn.tk-repbtn",
    {
      cls: R.open ? "is-on" : "",
      "aria-pressed": String(R.open),
      title: unread ? t("tk.rep.unreadTip", { n: unread }) : null,
      on: { click: () => (R.open ? closeReports() : openReports()) },
    },
    h("span.tk-duebtn__dot.tk-repbtn__dot", { cls: unread ? "" : "is-off" }),
    t("tk.rep.btn", { n: unread })
  );
}

/** Shows a report in the reading view (list row, header ticker); reading leaves its read state alone. */
export async function openReport(id) {
  enter();
  R.sel = id;
  R.body = null;
  R.notes = [];
  R.edit = null;
  R.list = false;
  emit();
  try {
    const r = await api("report_read", { id });
    if (R.sel === id) {
      R.body = typeof r?.body === "string" ? r.body : "";
      R.notes = noteRows(r);
    }
  } catch (e) {
    if (R.sel === id) R.sel = null;
    say(e.code === "not_found" ? t("tk.rep.gone") : e.message, "error");
  }
  emit();
}

/** "Gelesen" / "Ungelesen": counters, nav dot and ticker follow with the reloaded list. */
function mark(id, read) {
  return act(async () => {
    await api("report_mark", { id, read });
    await loadReports();
  });
}

/** Deletes the report and moves on to the row below it (or above, at the end of the list). */
function remove(id) {
  const rows = listed(),
    at = rows.findIndex((r) => r.id === id),
    next = rows[at + 1] ?? rows[at - 1];
  return act(async () => {
    try {
      await api("report_delete", { id });
    } catch (e) {
      if (e.code !== "not_found") throw e;
    }
    if (R.sel === id) {
      R.sel = null;
      if (R.open && next) openReport(next.id);
    }
    await loadReports();
    return t("tk.rep.deleted");
  });
}

// ── notes: the open field, saving, deleting. The list reloads for its "open notes" count.
/** The daemon's limit per note (task-reports.ts NOTE_MAX_CHARS). */
const NOTE_MAX = 4000;
const notesUi = {
  get notes() {
    return R.notes;
  },
  get editing() {
    return R.edit;
  },
  open(anchor) {
    R.edit = { anchor, noteId: null, draft: {} };
    emit("reports");
  },
  edit(n) {
    R.edit = { anchor: { kind: n.kind, index: n.index, excerpt: n.excerpt }, noteId: n.id, draft: {} };
    emit("reports");
  },
  cancel() {
    R.edit = null;
    emit("reports");
  },
  /** Rejects with the error the note field shows; the field keeps the text. */
  async save(text) {
    const id = R.sel,
      e = R.edit;
    if (text.length > NOTE_MAX) throw new Error(t("tk.rep.note.tooLong", { max: NOTE_MAX }));
    const r = e.noteId
      ? await api("report_note_edit", { id, note_id: e.noteId, text })
      : await api("report_note_add", { id, anchor: e.anchor, text });
    const [saved] = noteRows({ notes: [r?.note] });
    if (R.sel !== id || !saved) return;
    R.notes = e.noteId ? R.notes.map((n) => (n.id === saved.id ? saved : n)) : [...R.notes, saved];
    if (R.edit === e) R.edit = null;
    emit("reports");
    await loadReports();
  },
  remove(n) {
    const id = R.sel;
    return act(async () => {
      try {
        await api("report_note_delete", { id, note_id: n.id });
      } catch (e) {
        if (e.code !== "not_found") throw e;
      }
      if (R.sel === id) R.notes = R.notes.filter((x) => x.id !== n.id);
      if (R.edit?.noteId === n.id) R.edit = null;
      await loadReports();
      return t("tk.rep.note.deleted");
    });
  },
};

/** Rows in the order they had when the view opened; reports that arrived since go on top. */
function listed() {
  const at = (r) => R.order.indexOf(r.id);
  return [...data.reports].sort((a, b) => at(a) - at(b));
}

/** Arrow keys walk the rows (as in the memory browser); Enter / Space open the focused one (native button). */
function walk(e) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const rows = [...e.currentTarget.querySelectorAll(".mb-row")],
    at = rows.indexOf(document.activeElement);
  const next = rows[e.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0)];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

// Rows and reader are the memory browser's (css/membrowser.css: mb-row, mb-rd); Daniel wants the
// reports to look like it. Only the frame and the deltas live in css/tasks-reports.css.
function listRow(r) {
  const on = R.sel === r.id,
    fresh = r.readAt === null;
  return h(
    "button.mb-row",
    {
      cls: [fresh ? "is-new" : "", on ? "is-sel" : ""].join(" "),
      "aria-current": on ? "true" : null,
      title: fmtAt(r.createdAt),
      on: { click: () => openReport(r.id) },
    },
    h("span.mb-row__sq", { vars: { "--tc": fresh ? "var(--accent)" : "var(--line-45)" } }),
    h("span.mb-row__t", { text: r.title }),
    h("span.mb-row__ago", { text: ago(r.createdAt) }),
    h(
      "span.mb-row__meta",
      null,
      fresh ? h("span.mb-row__ai", { text: t("tk.rep.new") }) : null,
      r.notesOpen
        ? h("span.tk-an__count", {
            text: t("tk.rep.note.count", { n: r.notesOpen }),
            title: t("tk.rep.note.countTip", { n: r.notesOpen }),
          })
        : null,
      r.project ? h("span", { text: r.project }) : null,
      h("span", { text: r.client || t("tk.rep.unknown") })
    )
  );
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
/** Set while the reader is built: puts the cursor into the open note field. */
let focusNote = null;

function reader(r, narrow) {
  const facts = [[t("tk.rep.origin"), originText(r) || t("tk.rep.unknown")]];
  if (r.project) facts.push([t("tk.rep.project"), r.project]);
  facts.push([t("tk.rep.filed"), fmtAt(r.createdAt)]);
  if (r.readAt !== null) facts.push([t("tk.rep.readAt"), fmtAt(r.readAt)]);
  return h(
    "article.mb-rd",
    null,
    narrow
      ? h("button.mb-rd__back", {
          text: t("tk.rep.toList"),
          on: {
            click: () => {
              R.list = true;
              emit("reports");
            },
          },
        })
      : null,
    h(
      "div.mb-rd__top",
      null,
      h("span.mb-rd__chip", { text: t("tk.rep.kicker"), vars: { "--tc": "var(--accent)" } }),
      r.project ? h("span", { text: r.project }) : null,
      h("span.mb-rd__pos", { text: fmtAt(r.createdAt) })
    ),
    h("h2.mb-rd__h", { text: r.title }),
    R.body === null
      ? h("div.mb-rd__text.is-wait", { text: t("tk.loading") })
      : (() => {
          const annotated = annotateReport(bodyNodes(R.body), notesUi);
          focusNote = annotated.focus;
          return h("div.mb-rd__text.tk-rep__md", null, annotated.nodes);
        })(),
    h(
      "div.mb-rd__facts",
      null,
      facts.map(([k, v]) => [h("span.mb-rd__fk", { text: k }), h("span.mb-rd__fv", { text: v })])
    ),
    h(
      "div.mb-rd__acts",
      null,
      r.readAt === null
        ? h("button.mb-btn.is-primary", { text: t("tk.rep.markRead"), on: { click: () => mark(r.id, true) } })
        : h("button.mb-btn", { text: t("tk.rep.markUnread"), on: { click: () => mark(r.id, false) } }),
      h("button.mb-btn.is-quiet", { text: t("tk.rep.delete"), on: { click: () => remove(r.id) } })
    )
  );
}

/** Rebuilds the reader when its report, its notes or the open note field changed. A rebuilt
 *  reader keeps its scroll place; an opened (or still open) note field gets the cursor. */
function paintReader(read, rows, narrow, seen) {
  const r = rows.find((x) => x.id === R.sel);
  const key = JSON.stringify([r, narrow, R.notes, R.edit && [R.edit.anchor, R.edit.noteId]]);
  if (key === seen.key && R.body === seen.body) return;
  const top = read.scrollTop,
    hadFocus = read.contains(document.activeElement);
  focusNote = null;
  read.replaceChildren(
    r ? reader(r, narrow) : h("div.mb__nosel", { text: t(rows.length ? "tk.rep.pick" : "tk.rep.none") })
  );
  read.scrollTop = seen.sel !== R.sel ? 0 : top;
  if (focusNote && (seen.edit !== R.edit || hadFocus)) focusNote();
  Object.assign(seen, { key, body: R.body, edit: R.edit, sel: R.sel });
}

/** The reading view in the memory browser's frame: head (title, count, ESC), list | reader.
 *  Mounted into its own slot (tasks.js); list and reader keep their scroll position across
 *  polling because only a real change rebuilds them. */
export function reportsRenderer(host) {
  const hits = h("span.mb__hits.tk-rv__hits"),
    list = h("nav.mb__list", { "aria-label": t("tk.rep.title"), on: { keydown: walk } }),
    read = h("div.mb__reader"),
    body = h("div.mb__body", null, list, read),
    view = h(
      "section.tk-rv",
      { "aria-label": t("tk.rep.title") },
      h("span.mb__ticks"),
      h(
        "div.mb__head",
        null,
        h("span.mb__title", { text: t("tk.rep.title") }),
        hits,
        h("button.mb__esc", {
          text: t("tk.rep.esc"),
          title: t("tk.rep.back"),
          "aria-label": t("tk.rep.back"),
          on: { click: closeReports },
        })
      ),
      body
    );
  let listKey = "";
  // what the reader shows now (paintReader rebuilds it only on a real change)
  const seen = { key: "", body: undefined, edit: null, sel: null };
  return () => {
    host.hidden = !R.open;
    if (!R.open) {
      host.replaceChildren();
      listKey = seen.key = "";
      return;
    }
    if (host.firstChild !== view) host.replaceChildren(view);
    const rows = listed(),
      narrow = host.clientWidth > 0 && host.clientWidth < NARROW;
    if (!narrow || !R.sel) R.list = !R.sel;
    view.classList.toggle("is-narrow", narrow);
    view.classList.toggle("is-reading", !R.list);
    hits.textContent = t("tk.rep.count", { u: unreadCount(rows), n: rows.length });
    const lk = JSON.stringify([rows, R.sel]);
    if (lk !== listKey) {
      const all = () => [...list.querySelectorAll(".mb-row")],
        focused = all().indexOf(document.activeElement);
      list.replaceChildren(...(rows.length ? rows.map(listRow) : [h("div.mb__empty", { text: t("tk.rep.none") })]));
      if (focused >= 0) all()[focused]?.focus();
      listKey = lk;
    }
    paintReader(read, rows, narrow, seen);
  };
}

/** Escape leaves the reading view (tasks.js key handler, after the pop-overs); true when it was open. */
export function escapeReports() {
  if (!R.open) return false;
  // an open note field closes first, so Escape never drops the report view with a draft in it
  if (R.edit) notesUi.cancel();
  else closeReports();
  return true;
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
