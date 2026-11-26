// Tasks area — reports (Daniel 16.11.2026): agents file their final report
// with task_report_save instead of a long chat answer; here the user reads it.
// The rail entry "Reports" (Daniel 18.11.2026: no head button in the Tasks area any more, no ESC)
// switches the main area from the calendar to the reading view, an area of its own without the
// tasks' head, built like the memory browser: the list on
// the left, the chosen report at full width on the right (Daniel: not in the
// narrow detail panel). Opening a report does not mark it read: "Gelesen" /
// "Ungelesen" set that state by hand, "Löschen" removes it (Daniel 16.11.2026);
// the three sit in the reader's head, which stays on top while a long report
// scrolls. The view's head holds, as in the memory browser, a project pick list and a search field
// that filters by title and project at once and by the report text as soon as the daemon answers
// (#1597; head: tasks-reports-head.js). After "Löschen" a notice offers "Rückgängig" while the report
// shown next is on screen (#1559), and the deleted report stays in the list, struck through, with
// its time left and "Wiederherstellen" until its undo window ends (Daniel 18.11.2026).
// A report with open notes of the owner reads "In progress" in the list instead of "New", in the
// notes' amber (Daniel 18.11.2026); every state and its jumps: tasks-reports-status.js.
// The search lives in tasks-reports-search.js, delete and Undo in tasks-reports-undo.js, the
// state all three share in tasks-reports-state.js.
// The list itself is data.reports (js/data.js, rides on the shell polling), so
// the nav dot and the header ticker see the same rows.
// Report text is external data: rendered through the shared mini Markdown
// renderer (text nodes only) plus a text-only table for pipe tables.
// Notes on single places of a report: tasks-report-notes.js (Daniel 17.11.2026);
// leaving one never changes the read state. They are the owner's drafts until
// "Hand over to agent" in the reader's head passes them on (Daniel 17.11.2026).
// The rail has its own "Reports" entry right below "Tasks" (reportsArea): lit
// while this view is open, with the unread count as its badge.
// Reading aids (Daniel 18.11.2026): the text size in the reader's head (tasks-reports-size.js), the
// answered questions counted in its meta line, and the jump list as the right panel's tab while this
// view is open (tasks-reports-toc.js); the panel keeps its own open/closed state and button.
// Above the list the status filter (Daniel 26.11.2026, tasks-reports-filter.js): by default only the
// reports that need the owner; read, done and outdated ones on demand, as groups of their own. Every
// state has its colour on the row's dot and, while it waits on someone, on the stripe at the row's left
// edge; the open report is marked by the accent at the row's right edge instead (css/tasks-reports.css).
// The reader's head stands above the scrolling text, not inside it, so its line and shadow span the
// reader's full width whether or not a scrollbar is shown (Daniel 26.11.2026).
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { ICON } from "../areas.js";
import { state, setState } from "../state.js";
import { data, onData, loadReports } from "../data.js";
import { markdown, openMemoryBrowser } from "../views/memory-browser.js";
import { ago } from "../views/vault-data.js";
import { S, emit, say, act } from "./tasks-store.js";
import { api, fmtAt } from "./tasks-api.js";
import {
  unreadCount,
  isUnread,
  draftReports,
  noteCounts,
  originText,
  reportBlocks,
  noteRows,
  matchReports,
  inWork,
  inProject,
  inStates,
  stateOf,
  stateCounts,
  grouped,
} from "./tasks-reports-model.js";
import { stateMark, askedAbout } from "./tasks-reports-status.js";
import { annotateReport } from "./tasks-report-notes.js";
import { R, write } from "./tasks-reports-state.js";
import { behind, listed, hitsNow, shown, keepRow, searchText, setQuery } from "./tasks-reports-search.js";
import { remove, undoNotice, undoable, deletedRow, resetClocks, runClocks } from "./tasks-reports-undo.js";
import { reportsHead } from "./tasks-reports-head.js";
import { textSize, sizeSwitch } from "./tasks-reports-size.js";
import { setOutline, trackOutline } from "./tasks-reports-toc.js";
import { statusFilter, groupHead } from "./tasks-reports-filter.js";

/** Below this slot width list and reader share one column (memory browser: 760 px for list + reader;
 *  the report list is narrower, so two columns still fit at 640). */
const NARROW = 640;

const dataKey = () => JSON.stringify([data.reports, data.deletedReports]);
let lastKey = dataKey();
onData(() => {
  const key = dataKey();
  if (key === lastKey) return;
  lastKey = key;
  if (R.q.trim()) searchText(); // new or changed reports: the text search runs again
  if (R.sel && !data.reports.some((r) => r.id === R.sel)) R.sel = null; // deleted elsewhere
  if (R.open && !R.sel && !R.undo) openFirstVisible("reports");
  else emit("reports");
});

/** True while the reading view stands in for the calendar (tasks.js). */
export const reportsOpen = () => R.open;

/** The rail lights "Reports" while this view is open, "Tasks" otherwise; it redraws on this event. */
const railChanged = () => document.dispatchEvent(new CustomEvent("recall:nav"));

/** Opens the view; the right panel, open or closed as the user left it, turns to the jump list. */
function enter() {
  setState({ view: "tasks" });
  if (R.open) return;
  R.open = true;
  R.order = data.reports.map((r) => r.id);
  setState({ tab: "toc" });
  railChanged();
}

/** Leaving the Tasks area ends the view, so the next visit starts on the calendar. */
export function resetReports() {
  if (!R.open) return;
  R.open = R.menu = false;
  R.q = "";
  R.hits = R.undo = R.project = null;
  setOutline(null, null);
  railChanged();
}

export function closeReports() {
  resetReports();
  emit();
}

/** Selects the first visible report, leaving the reader empty when the filters hide all reports. */
function openFirstVisible(change) {
  const first = shown()[0];
  if (first) openReport(first.id);
  else emit(change);
}

/** Opens the reading view (head button, dashboard widget). */
export async function openReports() {
  enter();
  R.order = data.reports.map((r) => r.id);
  R.sel = null;
  S.compose = S.showDue = false;
  S.proposal = null;
  openFirstVisible();
  await loadReports();
}

/** Rail entry "Tasks": lit on the calendar only; clicked in the reading view it goes back to the calendar. */
export const tasksLit = () => state.view === "tasks" && !R.open;
export function showCalendar() {
  if (R.open) closeReports();
  else setState({ view: "tasks", hover: null, tab: "areas" });
}

/** Rail entry "Reports" right below "Tasks", a plain rail button like the others (Daniel 17.11.2026):
 *  opens this view, lit while it is open, badge = unread reports (the cyan of unread reports). */
export const reportsArea = {
  id: "reports",
  group: "work",
  order: 2,
  labelKey: "nav.reports",
  icon: ICON.reports,
  kind: "action",
  lit: () => state.view === "tasks" && R.open,
  badge: () => unreadCount(data.reports),
  badgeAccent: true,
  tip: () => {
    const unread = unreadCount(data.reports),
      drafts = draftReports(data.reports);
    return [
      t("nav.reports"),
      unread ? t("nav.reportsUnread", { n: unread }) : "",
      drafts ? t("nav.reportsDrafts", { n: drafts }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  },
  // a second click keeps the view, like the other rail entries
  onAction: () => (R.open ? undefined : openReports()),
};

/** Shows a report in the reading view (list row, header ticker); reading leaves its read state alone. */
export async function openReport(id) {
  enter();
  if (R.undo && R.undo.next !== id) R.undo = null; // moved on: the delete stays
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

/** "Gelesen" / "Ungelesen" ({ read }) and "Veraltet" / "Nicht veraltet" ({ outdated }, #1678):
 *  counters, nav dot and ticker follow with the reloaded list. */
function mark(id, change) {
  return act(async () => {
    await write("report_mark", { id, ...change });
    await loadReports();
  });
}

/** "Hand over to agent": the report's drafts reach the agents (session start, task_report_read).
 *  A daemon from before the hand-over answers not_found while the report is still there. */
function handOver(id) {
  return act(async () => {
    let r;
    try {
      r = await write("report_notes_hand", { id });
    } catch (e) {
      if (e.code !== "not_found") throw e;
      await loadReports();
      throw data.reports.some((x) => x.id === id) ? new Error(t("tk.rep.handOld")) : e;
    }
    if (R.sel === id) R.notes = noteRows(r);
    emit("reports");
    await loadReports();
    return t("tk.rep.handDone", { n: Number.isInteger(r?.handed) ? r.handed : 0 });
  });
}

// ── notes: the open field, saving, deleting. The list reloads for its "open notes" count.
/** The daemon's limit per note (task-reports.ts NOTE_MAX_CHARS). */
const NOTE_MAX = 4000;
/** Stores a new note at `anchor` (noteId null) or rewrites note `noteId`; the shown notes follow.
 *  False when the reader moved on to another report meanwhile. */
async function storeNote(anchor, noteId, text) {
  const id = R.sel;
  const r = noteId
    ? await write("report_note_edit", { id, note_id: noteId, text })
    : await write("report_note_add", { id, anchor, text });
  const [saved] = noteRows({ notes: [r?.note] });
  if (R.sel !== id || !saved) return false;
  R.notes = noteId ? R.notes.map((n) => (n.id === saved.id ? saved : n)) : [...R.notes, saved];
  return true;
}
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
    const e = R.edit;
    if (text.length > NOTE_MAX) throw new Error(t("tk.rep.note.tooLong", { max: NOTE_MAX }));
    if (!(await storeNote(e.anchor, e.noteId, text))) return;
    if (R.edit === e) R.edit = null;
    emit("reports");
    await loadReports();
  },
  /** An answer option, or "needs clarification", picked on a question: saved at once as a note there;
   *  noteId names the earlier choice there, which the new one rewrites. */
  answer(anchor, text, noteId = null) {
    return act(async () => {
      if (!(await storeNote(anchor, noteId, text))) return;
      emit("reports");
      await loadReports();
    });
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

/** Arrow keys walk the rows (as in the memory browser); Enter / Space open the focused one (native button). */
function walk(e) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const rows = [...e.currentTarget.querySelectorAll("button.mb-row")],
    at = rows.indexOf(document.activeElement);
  const next = rows[e.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0)];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

/** "✎ 2" drafts still with the owner (muted), "➜ 1" handed-over notes open with the agent (amber). */
function noteMarks(c, tag) {
  return [
    c.drafts
      ? h(`${tag}.is-draft`, {
          text: t("tk.rep.note.drafts", { n: c.drafts }),
          title: t("tk.rep.note.draftsTip", { n: c.drafts }),
        })
      : null,
    c.handed
      ? h(tag, { text: t("tk.rep.note.handed", { n: c.handed }), title: t("tk.rep.note.handedTip", { n: c.handed }) })
      : null,
  ];
}

// Rows and reader are the memory browser's (css/membrowser.css: mb-row, mb-rd); Daniel wants the
// reports to look like it. Only the frame and the deltas live in css/tasks-reports.css.
// The row's state class (st-…) gives its dot, stripe and tint their colour (Daniel 26.11.2026).
// An outdated report (#1678) steps back: muted row, no unread look.
function listRow(r) {
  const on = R.sel === r.id,
    fresh = isUnread(r),
    work = inWork(r),
    old = r.outdatedAt !== null;
  return h(
    "button.mb-row",
    {
      cls: [`st-${stateOf(r)}`, fresh ? "is-new" : "", work ? "is-work" : "", old ? "is-old" : "", on ? "is-sel" : ""]
        .filter(Boolean)
        .join(" "),
      "aria-current": on ? "true" : null,
      "data-report-id": r.id,
      title: fmtAt(r.createdAt),
      on: { click: () => openReport(r.id) },
    },
    h("span.mb-row__sq"),
    h("span.mb-row__t", { text: r.title }),
    h("span.mb-row__ago", { text: ago(r.createdAt) }),
    h(
      "span.mb-row__meta",
      null,
      stateMark(r, false, openReport),
      noteMarks({ drafts: r.notesDraft, handed: r.notesOpen - r.notesDraft }, "span.tk-an__count"),
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

/** The reader's head: title, meta line and the actions; it stays on top while the report scrolls.
 *  The note counts come from the shown notes, so head and cards always agree. With drafts,
 *  "Hand over to agent" is the head's one primary action and "Read" steps back a level.
 *  asks: the report's questions (annotateReport); with any, the meta line counts the answered ones. */
function readerHead(r, narrow, asks) {
  const c = noteCounts(R.notes),
    unread = r.readAt === null,
    old = r.outdatedAt !== null,
    answered = asks.filter((a) => a.answered).length;
  return h(
    "header.tk-rep__head",
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
      "div.tk-rep__id",
      null,
      h("h2.tk-rep__title", { text: r.title, title: r.title }),
      h(
        "div.tk-rep__meta",
        null,
        // what asks for the owner first (questions count, notes, state), then where the report comes
        // from: next to the text size switch and the actions the line is short, and it cuts at its end
        asks.length
          ? h("span.tk-rep__asks", {
              cls: answered < asks.length ? "is-open" : "",
              text: t("tk.rep.asks", { n: answered, m: asks.length }),
            })
          : null,
        noteMarks(c, "span.tk-rep__open"),
        stateMark(r, true, openReport),
        askedAbout(r, openReport),
        r.project ? h("span.tk-rep__proj", { text: r.project, title: t("tk.rep.project") }) : null,
        h("span", { text: fmtAt(r.createdAt), title: t("tk.rep.filed") }),
        // last and the one that gives way: agent and session id are long and matter least
        h("span.tk-rep__origin", {
          text: originText(r) || t("tk.rep.unknown"),
          title: `${t("tk.rep.origin")}: ${originText(r) || t("tk.rep.unknown")}`,
        })
      )
    ),
    sizeSwitch(() => emit("reports")),
    h(
      "div.mb-rd__acts.tk-rep__acts",
      null,
      c.drafts
        ? h("button.mb-btn.is-primary.tk-rep__hand", {
            text: t("tk.rep.hand", { n: c.drafts }),
            title: t("tk.rep.handTip"),
            on: { click: () => handOver(r.id) },
          })
        : null,
      h(`button.mb-btn${unread && !old && !c.drafts ? ".is-primary" : ""}`, {
        text: t(unread ? "tk.rep.markRead" : "tk.rep.markUnread"),
        on: { click: () => mark(r.id, { read: unread }) },
      }),
      h("button.mb-btn", {
        text: t(old ? "tk.rep.markCurrent" : "tk.rep.markOutdated"),
        title: t(old ? "tk.rep.markCurrentTip" : "tk.rep.markOutdatedTip"),
        on: { click: () => mark(r.id, { outdated: !old }) },
      }),
      h("button.mb-btn.is-quiet", { text: t("tk.rep.delete"), on: { click: () => remove(r.id, openReport) } })
    )
  );
}

/** Origin, project and filing time stand in the head; below the text only the read time remains.
 *  Returns the head, the article and the report's outline for the jump list (null while the text loads). */
function reader(r, narrow) {
  const annotated = R.body === null ? null : annotateReport(bodyNodes(R.body), notesUi);
  focusNote = annotated?.focus ?? null;
  const el = h(
    "article.mb-rd",
    { "aria-label": r.title },
    annotated
      ? h("div.mb-rd__text.tk-rep__md", { cls: `is-size-${textSize()}` }, annotated.nodes)
      : h("div.mb-rd__text.is-wait", { text: t("tk.loading") }),
    r.readAt === null
      ? null
      : h(
          "div.mb-rd__facts",
          null,
          h("span.mb-rd__fk", { text: t("tk.rep.readAt") }),
          h("span.mb-rd__fv", { text: fmtAt(r.readAt) })
        )
  );
  return { head: readerHead(r, narrow, annotated?.toc.asks ?? []), el, outline: annotated?.toc ?? null };
}

/** Where the cursor stands in the note field being typed in, so a rebuild can put it back (#1610). */
const caretOf = (el) =>
  el?.tagName === "TEXTAREA"
    ? { start: el.selectionStart, end: el.selectionEnd, dir: el.selectionDirection, top: el.scrollTop }
    : null;
function putCaret(el, c) {
  if (!c || el?.tagName !== "TEXTAREA") return;
  el.setSelectionRange(c.start, c.end, c.dir);
  el.scrollTop = c.top;
}

/** Rebuilds the reader when its report, its notes, the open note field, the undo notice or the text
 *  size changed, and hands the jump list the new outline.
 *  A rebuilt reader keeps its scroll place; an opened (or still open) note field gets the cursor, and
 *  a field typed in during the rebuild (a live update) keeps selection and scroll place. */
function paintReader({ top: lid, read }, rows, narrow, seen) {
  const r = rows.find((x) => x.id === R.sel);
  const key = JSON.stringify([r, narrow, R.notes, R.edit && [R.edit.anchor, R.edit.noteId], R.undo, textSize()]);
  if (key === seen.key && R.body === seen.body) return;
  const top = read.scrollTop,
    hadFocus = read.contains(document.activeElement),
    caret = hadFocus && seen.edit === R.edit ? caretOf(document.activeElement) : null;
  focusNote = null;
  const shown = r
    ? reader(r, narrow)
    : { head: null, el: h("div.mb__nosel", { text: t(rows.length ? "tk.rep.pick" : "tk.rep.none") }), outline: null };
  // the undo notice and the head stand above the scrolling text
  lid.replaceChildren(...[undoNotice(openReport), shown.head].filter(Boolean));
  read.replaceChildren(shown.el);
  setOutline(shown.outline, read);
  read.scrollTop = seen.sel !== R.sel ? 0 : top;
  if (focusNote && (seen.edit !== R.edit || hadFocus)) {
    focusNote();
    putCaret(document.activeElement, caret);
  }
  Object.assign(seen, { key, body: R.body, edit: R.edit, sel: R.sel });
}

/** The live rows and the deleted ones still undoable, in the order the list had when the view opened;
 *  a delete from an earlier visit goes to the end. */
function withDeleted(live, gone) {
  const at = (r) => {
    const i = R.order.indexOf(r.id);
    return i >= 0 ? i : r.until === undefined ? -1 : Infinity;
  };
  return [...live, ...gone].sort((a, b) => behind(a) - behind(b) || at(a) - at(b));
}

/** Closes the project pick list on a click outside it, as in the memory browser. */
function closeMenuOutside(e) {
  if (!R.menu || e.target?.closest?.(".tk-rv__proj")) return;
  R.menu = false;
  emit("reports");
}

/** The list's rows: the open reports first, read, done and outdated ones each under a group head
 *  of its own; the heads show only when more than one group is in the list. A deleted report still
 *  undoable keeps its row in its group whatever the status filter says. */
function listNodes(rows, rowEl) {
  const groups = grouped(rows);
  return groups.flatMap((g) => [
    ...(groups.length > 1 ? [groupHead(g.group, g.rows.length)] : []),
    ...g.rows.map(rowEl),
  ]);
}

/** The reading view in the memory browser's frame: head (title, project, search, count), the status
 *  filter, list | reader. Mounted into its own slot (tasks.js); list and reader keep their scroll
 *  position across polling because only a real change rebuilds them. */
export function reportsRenderer(host) {
  const head = reportsHead(),
    filter = statusFilter(),
    list = h("nav.mb__list", { "aria-label": t("tk.rep.title"), on: { keydown: walk } }),
    side = h("div.tk-rv__side", null, list),
    // the reader's head stands above the scrolling text (lid), so its line spans the scrollbar too
    lid = h("div.tk-rv__lid"),
    read = h("div.mb__reader", { on: { scroll: trackOutline } }),
    pane = h("div.tk-rv__pane", null, lid, read),
    body = h("div.mb__body", null, side, pane),
    view = h("section.tk-rv", { "aria-label": t("tk.rep.title") }, h("span.mb__ticks"), head.el, filter.el, body);
  document.addEventListener("pointerdown", closeMenuOutside);
  /** No reports at all; none search and project filter leave (then with a way back to the full list);
   *  or only the status filter hides them (its switches are right above). */
  const empty = (any, matched) =>
    !any
      ? h("div.mb__empty", { text: t("tk.rep.none") })
      : matched
        ? h("div.mb__empty", { text: t("tk.rep.filter.none") })
        : h(
            "div.mb__empty.tk-rv__nohit",
            null,
            h("span", { text: t("tk.rep.find.none") }),
            h("button.mb-btn", {
              text: t("tk.rep.find.clear"),
              on: {
                click: () => {
                  R.project = null;
                  setQuery("");
                  head.input.focus();
                },
              },
            })
          );
  const rowEl = (r) => (r.until === undefined ? listRow(r) : deletedRow(r, openReport));
  let listKey = "";
  // what the reader shows now (paintReader rebuilds it only on a real change)
  const seen = { key: "", body: undefined, edit: null, sel: null };
  return () => {
    host.hidden = !R.open;
    if (!R.open) {
      host.replaceChildren();
      listKey = seen.key = "";
      resetClocks();
      runClocks();
      return;
    }
    if (host.firstChild !== view) host.replaceChildren(view);
    const all = listed(),
      gone = undoable(),
      every = withDeleted(all, gone),
      matched = inProject(withDeleted(matchReports(all, R.q, hitsNow()), matchReports(gone, R.q)), R.project),
      rows = inStates(matched, R.states, (r) => keepRow(r) || r.until !== undefined),
      narrow = host.clientWidth > 0 && host.clientWidth < NARROW;
    if (!narrow || !R.sel) R.list = !R.sel && !R.undo;
    view.classList.toggle("is-narrow", narrow);
    view.classList.toggle("is-reading", !R.list);
    head.paint(every, rows.length, unreadCount(all), all.length);
    filter.paint(stateCounts(matched.filter((r) => r.until === undefined)));
    const lk = JSON.stringify([rows, R.sel, every.length > 0, matched.length > 0]);
    if (lk !== listKey) {
      const active = document.activeElement;
      const focusedId = list.contains(active) ? active.getAttribute("data-report-id") : null;
      resetClocks();
      list.replaceChildren(...(rows.length ? listNodes(rows, rowEl) : [empty(every.length > 0, matched.length > 0)]));
      runClocks();
      if (focusedId)
        ([...list.children].find((row) => row.getAttribute("data-report-id") === focusedId) ?? head.input).focus();
      listKey = lk;
    }
    paintReader({ top: lid, read }, all, narrow, seen);
  };
}

/** Escape in the reading view (tasks.js key handler, after the pop-overs) closes what is open there:
 *  the note field, else the project list, else — in the search field (`target`) — the search. It never
 *  leaves the view, which is an area of its own reached from the rail (Daniel 18.11.2026). True when
 *  it closed something; false leaves Escape to the rest of the page. */
export function escapeReports(target) {
  if (!R.open) return false;
  if (R.edit) notesUi.cancel();
  else if (R.menu) {
    R.menu = false;
    emit("reports");
  } else if (R.q && target?.classList?.contains("tk-rv__input")) setQuery("");
  else return false;
  return true;
}

/** Header ticker: one entry per unread report, in the ticker's own item shape (js/header.js). */
export function reportTickerItems() {
  return data.reports.filter(isUnread).map((r) => ({
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
