// Tasks area — reports (Daniel 16.11.2026): agents file their final report
// with task_report_save instead of a long chat answer; here the user reads it.
// Head button "BERICHTE · n" next to "FÄLLIG" switches the main area from the
// calendar to the reading view, built like the memory browser: the list on
// the left, the chosen report at full width on the right (Daniel: not in the
// narrow detail panel). Opening a report does not mark it read: "Gelesen" /
// "Ungelesen" set that state by hand, "Löschen" removes it (Daniel 16.11.2026);
// the three sit in the reader's head, which stays on top while a long report
// scrolls. A search field above the list filters it by title and project at once and by the
// report text as soon as the daemon answers (#1597). After "Löschen" a notice offers "Rückgängig"
// while the report shown next is on screen (#1559, like archiving in the memory browser).
// The list itself is data.reports (js/data.js, rides on the shell polling), so
// the nav dot and the header ticker see the same rows.
// Report text is external data: rendered through the shared mini Markdown
// renderer (text nodes only) plus a text-only table for pipe tables.
// Notes on single places of a report: tasks-report-notes.js (Daniel 17.11.2026);
// leaving one never changes the read state. They are the owner's drafts until
// "Hand over to agent" in the reader's head passes them on (Daniel 17.11.2026).
// The rail has its own "Reports" entry right below "Tasks" (reportsArea): lit
// while this view is open, with the unread count as its badge.
import { h, searchIcon } from "../dom.js";
import { t } from "../i18n.js";
import { ICON } from "../areas.js";
import { state, setState } from "../state.js";
import { data, onData, loadReports } from "../data.js";
import { markdown, openMemoryBrowser } from "../views/memory-browser.js";
import { ago } from "../views/vault-data.js";
import { S, emit, say, act } from "./tasks-store.js";
import { api, fmtAt } from "./tasks-api.js";
import {
  reportRows,
  unreadCount,
  draftReports,
  noteCounts,
  originText,
  reportBlocks,
  noteRows,
  matchReports,
} from "./tasks-reports-model.js";
import { annotateReport } from "./tasks-report-notes.js";

// open: reading view replaces the calendar · sel: report shown · body: its text (null = loading)
// notes: the shown report's notes · edit: the open note field { anchor, noteId (null = new), draft }
// order: row order frozen while the view is open, so a row marked there does not jump away under the pointer
// list: narrow view shows the list instead of the reader (memory browser: "← LISTE")
// lens: the detail panel was open when the view opened; it is folded away meanwhile (a report needs
// the width, the panel has nothing to show for it) and comes back when the view closes
// q: the search over the list; the shown report stays open even when the search hides its row
// hits: { q, ids } the daemon's text search found for q · undo: { id, title, next } the last delete, undoable
// while `next` (the report shown after it, null for none) is on screen
const R = {
  open: false,
  sel: null,
  body: null,
  notes: [],
  edit: null,
  order: [],
  list: false,
  lens: false,
  q: "",
  hits: null,
  undo: null,
};
/** Below this slot width list and reader share one column (memory browser: 760 px for list + reader;
 *  the report list is narrower, so two columns still fit at 640). */
const NARROW = 640;

let lastKey = JSON.stringify(data.reports);
onData(() => {
  const key = JSON.stringify(data.reports);
  if (key === lastKey) return;
  lastKey = key;
  if (R.q.trim()) searchText(); // new or changed reports: the text search runs again
  if (R.sel && !data.reports.some((r) => r.id === R.sel)) R.sel = null; // deleted elsewhere
  if (R.open && !R.sel && !R.undo && data.reports.length) openReport((shown()[0] ?? listed()[0]).id);
  else emit("reports");
});

/** True while the reading view stands in for the calendar (tasks.js). */
export const reportsOpen = () => R.open;

/** The rail lights "Reports" while this view is open, "Tasks" otherwise; it redraws on this event. */
const railChanged = () => document.dispatchEvent(new CustomEvent("recall:nav"));

function enter() {
  setState({ view: "tasks" });
  if (R.open) return;
  R.open = true;
  R.order = data.reports.map((r) => r.id);
  R.lens = state.lensOpen;
  if (R.lens) setState({ lensOpen: false });
  railChanged();
}

/** Leaving the Tasks area ends the view, so the next visit starts on the calendar. */
export function resetReports() {
  if (!R.open) return;
  R.open = false;
  R.q = "";
  R.hits = R.undo = null;
  if (R.lens) setState({ lensOpen: true });
  railChanged();
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

/** A change the report store can refuse when it is full (#1609): then the message says so and how to
 *  make room, instead of the generic one. */
async function write(name, input) {
  try {
    return await api(name, input);
  } catch (e) {
    throw e.code === "capacity" ? Object.assign(new Error(t("tk.rep.full")), { code: e.code }) : e;
  }
}

/** "Gelesen" / "Ungelesen": counters, nav dot and ticker follow with the reloaded list. */
function mark(id, read) {
  return act(async () => {
    await write("report_mark", { id, read });
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

/** Deletes the report and moves on to the row below it (or above, at the end of the list). While that
 *  one is on screen, a notice offers to undo the delete (the daemon keeps it for a while). */
function remove(id) {
  const filtered = shown(),
    rows = filtered.some((r) => r.id === id) ? filtered : listed(),
    at = rows.findIndex((r) => r.id === id),
    next = at < 0 ? null : (rows[at + 1] ?? rows[at - 1]),
    title = rows[at]?.title ?? "";
  return act(async () => {
    let r = null;
    try {
      r = await api("report_delete", { id });
    } catch (e) {
      if (e.code !== "not_found") throw e;
    }
    R.undo = Number.isFinite(r?.restorable_until) ? { id, title, next: next?.id ?? null } : null;
    if (R.sel === id) {
      R.sel = null;
      if (R.open && next) openReport(next.id);
    }
    emit("reports");
    await loadReports();
    return R.undo ? "" : t("tk.rep.deleted");
  });
}

/** "Rückgängig": the report comes back with text, read state and notes and is shown again. */
function undoDelete(u) {
  return act(async () => {
    try {
      await write("report_restore", { id: u.id });
    } catch (e) {
      if (e.code !== "not_found") throw e;
      R.undo = null;
      emit("reports");
      throw new Error(t("tk.rep.undoGone"));
    }
    R.undo = null;
    await loadReports();
    openReport(u.id);
    return t("tk.rep.restored");
  });
}

/** The notice after a delete, while the report shown next (or the empty reader) is on screen. */
function undoNotice() {
  const u = R.undo;
  if (!u || (R.sel && u.next !== R.sel)) return null;
  return h(
    "div.mb-ed__notice.tk-rep__undo",
    { role: "status" },
    h("span.mb-ed__done", { text: t("tk.rep.deletedNamed", { title: u.title }) }),
    h("button.mb-btn.is-quiet", { type: "button", text: t("tk.rep.undo"), on: { click: () => undoDelete(u) } }),
    h("button.mb-ed__x", {
      type: "button",
      text: "×",
      title: t("tk.rep.undoDismiss"),
      "aria-label": t("tk.rep.undoDismiss"),
      on: {
        click: () => {
          R.undo = null;
          emit("reports");
        },
      },
    })
  );
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
      ? await write("report_note_edit", { id, note_id: e.noteId, text })
      : await write("report_note_add", { id, anchor: e.anchor, text });
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
/** The daemon's text hits, while they belong to the current search. */
const hitsNow = () => (R.hits && R.hits.q === R.q.trim() ? R.hits.ids : null);
/** The rows the search leaves in the list. */
const shown = () => matchReports(listed(), R.q, hitsNow());

/** The daemon searches the report text too (#1597); a short pause after typing, the latest search wins.
 *  A Recall without the text search refuses the query: then title and project stay the search. */
const SEARCH_MS = 250;
const QUERY_MAX = 200;
let searchTimer = 0,
  searchSeq = 0;
function searchText() {
  clearTimeout(searchTimer);
  const seq = ++searchSeq;
  const q = R.q.trim();
  if (!q || q.length > QUERY_MAX) return;
  searchTimer = setTimeout(async () => {
    try {
      const r = await api("report_list", { query: q });
      if (seq !== searchSeq || R.q.trim() !== q) return;
      R.hits = { q, ids: new Set(reportRows(r).map((x) => x.id)) };
      emit("reports");
    } catch {
      /* the title and project match stays */
    }
  }, SEARCH_MS);
}

function setQuery(q) {
  if (R.q.trim() !== q.trim()) R.hits = null;
  R.q = q;
  searchText();
  emit("reports");
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
 *  "Hand over to agent" is the head's one primary action and "Read" steps back a level. */
function readerHead(r, narrow) {
  const c = noteCounts(R.notes),
    unread = r.readAt === null;
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
        r.project ? h("span.tk-rep__proj", { text: r.project, title: t("tk.rep.project") }) : null,
        h("span", { text: fmtAt(r.createdAt), title: t("tk.rep.filed") }),
        h("span", { text: originText(r) || t("tk.rep.unknown"), title: t("tk.rep.origin") }),
        noteMarks(c, "span.tk-rep__open")
      )
    ),
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
      h(`button.mb-btn${unread && !c.drafts ? ".is-primary" : ""}`, {
        text: t(unread ? "tk.rep.markRead" : "tk.rep.markUnread"),
        on: { click: () => mark(r.id, unread) },
      }),
      h("button.mb-btn.is-quiet", { text: t("tk.rep.delete"), on: { click: () => remove(r.id) } })
    )
  );
}

/** Origin, project and filing time stand in the head; below the text only the read time remains. */
function reader(r, narrow) {
  return h(
    "article.mb-rd",
    null,
    readerHead(r, narrow),
    R.body === null
      ? h("div.mb-rd__text.is-wait", { text: t("tk.loading") })
      : (() => {
          const annotated = annotateReport(bodyNodes(R.body), notesUi);
          focusNote = annotated.focus;
          return h("div.mb-rd__text.tk-rep__md", null, annotated.nodes);
        })(),
    r.readAt === null
      ? null
      : h(
          "div.mb-rd__facts",
          null,
          h("span.mb-rd__fk", { text: t("tk.rep.readAt") }),
          h("span.mb-rd__fv", { text: fmtAt(r.readAt) })
        )
  );
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

/** Rebuilds the reader when its report, its notes, the open note field or the undo notice changed.
 *  A rebuilt reader keeps its scroll place; an opened (or still open) note field gets the cursor, and
 *  a field typed in during the rebuild (a live update) keeps selection and scroll place. */
function paintReader(read, rows, narrow, seen) {
  const r = rows.find((x) => x.id === R.sel);
  const key = JSON.stringify([r, narrow, R.notes, R.edit && [R.edit.anchor, R.edit.noteId], R.undo]);
  if (key === seen.key && R.body === seen.body) return;
  const top = read.scrollTop,
    hadFocus = read.contains(document.activeElement),
    caret = hadFocus && seen.edit === R.edit ? caretOf(document.activeElement) : null;
  focusNote = null;
  read.replaceChildren(
    ...[
      undoNotice(),
      r ? reader(r, narrow) : h("div.mb__nosel", { text: t(rows.length ? "tk.rep.pick" : "tk.rep.none") }),
    ].filter(Boolean)
  );
  read.scrollTop = seen.sel !== R.sel ? 0 : top;
  if (focusNote && (seen.edit !== R.edit || hadFocus)) {
    focusNote();
    putCaret(document.activeElement, caret);
  }
  Object.assign(seen, { key, body: R.body, edit: R.edit, sel: R.sel });
}

/** The reading view in the memory browser's frame: head (title, count, ESC), list with its search |
 *  reader. Mounted into its own slot (tasks.js); list and reader keep their scroll position across
 *  polling because only a real change rebuilds them. */
export function reportsRenderer(host) {
  const hits = h("span.mb__hits.tk-rv__hits"),
    input = h("input.mb__input.tk-rv__input", {
      type: "text",
      spellcheck: "false",
      placeholder: t("tk.rep.find.ph"),
      "aria-label": t("tk.rep.find.label"),
      on: { input: () => setQuery(input.value) },
    }),
    found = h("span.mb__hits"),
    list = h("nav.mb__list", { "aria-label": t("tk.rep.title"), on: { keydown: walk } }),
    side = h(
      "div.tk-rv__side",
      null,
      h("div.tk-rv__find", null, h("label.mb__search", null, searchIcon(), input, found)),
      list
    ),
    read = h("div.mb__reader"),
    body = h("div.mb__body", null, side, read),
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
  /** No reports at all, or none the search leaves (then with a way back to the full list). */
  const empty = (any) =>
    any
      ? h(
          "div.mb__empty.tk-rv__nohit",
          null,
          h("span", { text: t("tk.rep.find.none") }),
          h("button.mb-btn", {
            text: t("tk.rep.find.clear"),
            on: {
              click: () => {
                setQuery("");
                input.focus();
              },
            },
          })
        )
      : h("div.mb__empty", { text: t("tk.rep.none") });
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
    const all = listed(),
      rows = matchReports(all, R.q, hitsNow()),
      narrow = host.clientWidth > 0 && host.clientWidth < NARROW;
    if (!narrow || !R.sel) R.list = !R.sel && !R.undo;
    view.classList.toggle("is-narrow", narrow);
    view.classList.toggle("is-reading", !R.list);
    hits.textContent = t("tk.rep.count", { u: unreadCount(all), n: all.length });
    if (input.value !== R.q) input.value = R.q;
    found.textContent = R.q.trim() ? t("tk.rep.find.count", { n: rows.length, m: all.length }) : "";
    const lk = JSON.stringify([rows, R.sel, all.length > 0]);
    if (lk !== listKey) {
      const rowEls = () => [...list.querySelectorAll(".mb-row")],
        focused = rowEls().indexOf(document.activeElement);
      list.replaceChildren(...(rows.length ? rows.map(listRow) : [empty(all.length > 0)]));
      if (focused >= 0) rowEls()[focused]?.focus();
      listKey = lk;
    }
    paintReader(read, all, narrow, seen);
  };
}

/** Escape leaves the reading view (tasks.js key handler, after the pop-overs); true when it was open.
 *  `target` is the key event's target: in the search field Escape first empties the search. */
export function escapeReports(target) {
  if (!R.open) return false;
  // an open note field closes first, so Escape never drops the report view with a draft in it
  if (R.edit) notesUi.cancel();
  else if (R.q && target?.classList?.contains("tk-rv__input")) setQuery("");
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
