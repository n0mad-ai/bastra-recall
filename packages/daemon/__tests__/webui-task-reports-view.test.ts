// UI v2 task reports — the reading view (js/sections/tasks-reports.js) with a
// fake DOM: the actions sit in the reader's head and nowhere below the report,
// the search above the list filters by title and project (#1597) while the
// shown report stays open, the daemon's text hits join in once they arrive, and Escape closes the note field, then empties the
// search, but never leaves the view (an area of its own). With drafts among the notes, "Hand over to
// agent" leads the head and "Read" steps back. The real module runs in a VM
// context (webui-report-view.ts); its imports are replaced by small stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Node_, h } from "./webui-report-dom.js";
import { ID, REPORTS, view, byClass, one, input, type, listRows } from "./webui-report-view.js";

test("the reader's head holds title, meta line, open notes and the actions; none are left below the report", async () => {
  const { v, host, calls } = await view();
  await v.openReport(ID(1));
  const article = one(host, "mb-rd");
  const head = article.children[0];
  assert.ok(head.classList.contains("tk-rep__head"), "the head comes first in the reader");
  const title = one(head, "tk-rep__title");
  assert.equal(title.textContent, "Überblick: Förderung");
  assert.equal(title.attrs.title, "Überblick: Förderung", "the full title on hover, the line itself is cut");
  assert.deepEqual(
    byClass(head, "tk-rep__meta")[0].children.map((n) => n.textContent),
    ["FÖRDERUNG", "@30", "codex"],
    "project, filing time and origin"
  );
  assert.equal(byClass(head, "tk-rep__open").length, 0, "no notes, no badge");
  assert.equal(byClass(head, "tk-rep__hand").length, 0, "no drafts, no hand-over");
  const acts = one(head, "tk-rep__acts");
  assert.deepEqual(
    acts.children.map((b) => b.textContent),
    ["tk.rep.markRead", "tk.rep.markOutdated", "tk.rep.delete"]
  );
  const outside = article.children.slice(1).flatMap((n) => [n, ...n.all()]);
  assert.equal(outside.filter((n) => n.classList.contains("mb-btn")).length, 0, "no actions below the report");
  assert.equal(outside.filter((n) => n.classList.contains("mb-rd__facts")).length, 0, "an unread report has no facts");
  assert.equal(byClass(article, "mb-rd__top").length + byClass(article, "mb-rd__h").length, 0, "nothing twice");
  assert.ok(!calls.some(([name]) => name === "report_mark"), "opening a report does not mark it read");

  await acts.children[0].click();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["report_mark", { id: ID(1), read: true }]);
});

const NOTE = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(n),
  anchor: { kind: "paragraph", index: 1, excerpt: "Erster Absatz." },
  text: `Anmerkung ${n}`,
  actor: "ui",
  created_at: 5,
  state: "open",
  ...over,
});

test("a read report offers 'unread', shows its handed-over notes in the head and its read time below", async () => {
  const { v, host } = await view([NOTE(1, { handed_at: 7 }), NOTE(2, { handed_at: 7 })]);
  await v.openReport(ID(3));
  const head = one(host, "tk-rep__head");
  assert.deepEqual(
    one(head, "tk-rep__acts").children.map((b) => b.textContent),
    ["tk.rep.markUnread", "tk.rep.markOutdated", "tk.rep.delete"]
  );
  const [handed] = byClass(head, "tk-rep__open");
  assert.match(handed.textContent, /tk\.rep\.note\.handed \{"n":2\}/);
  assert.match(handed.attrs.title, /tk\.rep\.note\.handedTip/);
  assert.equal(byClass(head, "is-draft").length, 0, "no drafts");
  assert.equal(one(head, "tk-rep__origin").textContent, "codex · s-1");
  assert.deepEqual(
    one(head, "tk-rep__meta").children.map((n) => n.className.split(" ")[0]),
    ["tk-rep__open", "mb-row__ai", "tk-rep__proj", "", "tk-rep__origin"],
    "marks first; the long origin comes last, so the line cuts it and not the marks"
  );
  assert.equal(one(host, "mb-rd__facts").textContent, "tk.rep.readAt@40");
});

test("narrow: the way back to the list sits in the head as well", async () => {
  const { v, host, draw } = await view();
  host.clientWidth = 500;
  await v.openReport(ID(2));
  draw();
  assert.equal(one(host, "tk-rep__head").children[0].textContent, "tk.rep.toList");
});

test("search: title and project, any case, any Unicode form; the open report stays open", async () => {
  const { v, host } = await view();
  await v.openReport(ID(2));
  assert.equal(listRows(host).length, 3);
  assert.equal(one(host, "mb__search").textContent, "", "no count while nothing is searched");

  type(host, "ÜBERBLICK");
  assert.deepEqual(
    listRows(host).map((r) => r.children[1].textContent),
    ["Überblick: Förderung"]
  );
  assert.match(one(host, "mb__search").textContent, /tk\.rep\.find\.count \{"n":1,"m":3\}/);
  assert.equal(one(host, "tk-rep__title").textContent, "Release-Prüfung", "the shown report stays open");

  type(host, "förderung"); // "ö" written as o + combining diaeresis
  assert.equal(listRows(host).length, 1, "a decomposed umlaut finds the composed one");
  type(host, "bastra");
  assert.equal(listRows(host).length, 2, "the project is searched");
  type(host, "  bastra   IO ");
  assert.deepEqual(
    listRows(host).map((r) => r.children[1].textContent),
    ["Lint nachgezogen"],
    "every word has to match"
  );
});

test("search without a match: a short line and a way to clear it", async () => {
  const { v, host } = await view();
  await v.openReport(ID(1));
  type(host, "zzz");
  assert.equal(listRows(host).length, 0);
  const none = one(host, "tk-rv__nohit");
  assert.equal(none.children[0].textContent, "tk.rep.find.none");
  await none.children[1].click();
  assert.equal(v.R.q, "");
  assert.equal(input(host).value, "");
  assert.equal(listRows(host).length, 3);
  assert.equal(one(host, "tk-rep__title").textContent, "Überblick: Förderung");
});

test("Escape: the open note field first, then the search (in the search field), then the view", async () => {
  const { v, host } = await view();
  await v.openReports();
  type(host, "bastra");
  v.notesUi.open({ kind: "paragraph", index: 1, excerpt: "Erster Absatz." });
  const field = input(host);

  assert.equal(v.escapeReports(field), true);
  assert.equal(v.R.edit, null, "the note field closed");
  assert.equal(v.R.q, "bastra", "the search is still there");
  assert.ok(v.reportsOpen());

  assert.equal(v.escapeReports(field), true);
  assert.equal(v.R.q, "", "the search emptied");
  assert.equal(field.value, "");
  assert.ok(v.reportsOpen());

  // Reports are an area of their own (Daniel 18.11.2026): with nothing left to close, Escape stays
  assert.equal(v.escapeReports(field), false, "nothing open: Escape is left to the rest of the page");
  assert.ok(v.reportsOpen(), "and never leaves the view");
});

test("Escape outside the search field keeps the search and the view; the next visit starts without a search", async () => {
  const { v, host } = await view();
  await v.openReports();
  type(host, "bastra");
  assert.equal(v.escapeReports(h("button", null)), false);
  assert.ok(v.reportsOpen());
  assert.equal(v.R.q, "bastra");
  v.closeReports();
  await v.openReports();
  assert.equal(v.R.q, "");
  assert.equal(listRows(host).length, 3);
});

test("hand-over: with drafts the head leads with 'Hand over to agent', 'Read' steps back, one click hands them over", async () => {
  const { v, host, calls, said } = await view([NOTE(1), NOTE(2, { handed_at: 7 })]);
  await v.openReport(ID(1));
  const head = one(host, "tk-rep__head");
  const acts = one(head, "tk-rep__acts").children;
  assert.deepEqual(
    acts.map((b) => b.textContent),
    ['tk.rep.hand {"n":1}', "tk.rep.markRead", "tk.rep.markOutdated", "tk.rep.delete"]
  );
  assert.ok(acts[0].classList.contains("is-primary"), "the hand-over is the head's main action");
  assert.ok(!acts[1].classList.contains("is-primary"), "never two equally loud main buttons side by side");
  assert.match(acts[0].attrs.title, /tk\.rep\.handTip/);
  assert.deepEqual(
    byClass(head, "tk-rep__open").map((n) => [n.textContent, n.classList.contains("is-draft")]),
    [
      ['tk.rep.note.drafts {"n":1}', true],
      ['tk.rep.note.handed {"n":1}', false],
    ],
    "drafts (still with you) and handed-over open notes (with the agent) apart"
  );

  await acts[0].click();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["report_notes_hand", { id: ID(1) }]);
  assert.deepEqual(said.at(-1), ['tk.rep.handDone {"n":1}', undefined], "a short confirmation, no dialog");
  const after = one(host, "tk-rep__head");
  assert.equal(byClass(after, "tk-rep__hand").length, 0, "no drafts left, no button");
  assert.ok(one(after, "tk-rep__acts").children[0].classList.contains("is-primary"), "'Read' leads again");
  assert.match(one(after, "tk-rep__open").textContent, /tk\.rep\.note\.handed \{"n":2\}/);
});

test("hand-over against a Recall that predates it: a clear message, nothing breaks", async () => {
  const { v, host, said, hand } = await view([NOTE(1)]);
  hand.fail = true;
  await v.openReport(ID(1));
  await one(host, "tk-rep__hand").click();
  assert.deepEqual(said.at(-1), ["tk.rep.handOld", "error"]);
  assert.equal(byClass(host, "tk-rep__hand").length, 1, "the drafts stay drafts, the button stays");
});

test("list rows show drafts and handed-over notes apart", async () => {
  const { v, host, context } = await view();
  (context.data as { reports: unknown }).reports = v.reportRows({
    reports: [{ ...REPORTS[0], notes_open: 3, notes_draft: 2 }, REPORTS[2]],
  });
  await v.openReports();
  const marks = (row: Node_) =>
    byClass(row, "tk-an__count").map((n) => [n.textContent, n.classList.contains("is-draft")]);
  const [first, third] = listRows(host);
  assert.deepEqual(marks(first), [
    ['tk.rep.note.drafts {"n":2}', true],
    ['tk.rep.note.handed {"n":1}', false],
  ]);
  assert.deepEqual(marks(third), [['tk.rep.note.handed {"n":2}', false]], "an older answer without drafts");
});

test("rail: 'Reports' is lit while the view is open and 'Tasks' otherwise; both redraw the rail", async () => {
  const { v, events, context } = await view();
  (context.state as { view: string }).view = "tasks";
  const area = v.reportsArea;
  assert.equal(area.kind, "action");
  assert.equal(area.group, "work");
  assert.equal(area.order, 2, "right below Tasks");
  assert.equal(area.labelKey, "nav.reports");
  assert.equal(area.icon, "M0 0");
  assert.ok(v.tasksLit() && !area.lit(), "calendar: Tasks lit");
  assert.equal(area.badge(), 2, "the badge counts the unread reports");
  assert.equal(area.badgeAccent, true, "in the cyan of unread reports");
  assert.equal(area.tip(), 'nav.reports · nav.reportsUnread {"n":2}');

  await area.onAction();
  assert.ok(area.lit() && !v.tasksLit(), "reports open: Reports lit, Tasks not");
  assert.deepEqual(events, ["recall:nav"], "the rail is told");
  const sel = v.R.sel;
  area.onAction();
  assert.equal(v.R.sel, sel, "a second click keeps the view");

  v.showCalendar();
  assert.ok(!v.reportsOpen() && v.tasksLit() && !area.lit(), "Tasks goes back to the calendar");
  assert.deepEqual(events, ["recall:nav", "recall:nav"]);
  (context.state as { view: string }).view = "ring";
  assert.ok(!v.tasksLit() && !area.lit(), "elsewhere neither is lit");

  (context.data as { reports: unknown }).reports = v.reportRows({
    reports: REPORTS.map((r) => ({ ...r, read_at: 50, notes_open: 1, notes_draft: 1 })),
  });
  assert.equal(area.badge(), 0, "nothing unread, no badge");
  assert.equal(area.tip(), 'nav.reports · nav.reportsDrafts {"n":3}', "reports with notes not handed over");
});

test("#1597: the report text is searched by the daemon; its hits join the list once they arrive", async () => {
  const { v, host, calls, flush } = await view();
  await v.openReport(ID(1));
  type(host, "Preise");
  assert.equal(listRows(host).length, 0, "no title or project holds it");
  assert.ok(!calls.some(([name]) => name === "report_list"), "the daemon is asked once typing pauses");
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["report_list", { query: "Preise" }]);
  assert.deepEqual(
    listRows(host).map((r) => r.children[1].textContent),
    ["Lint nachgezogen"],
    "found in its text"
  );
  type(host, "Preise x");
  assert.equal(listRows(host).length, 0, "hits of an older search never stand for a new one");
  type(host, "");
  assert.equal(listRows(host).length, 3);
});

test("#1597: a late answer to an older search is dropped", async () => {
  const { v, host, flush, context } = await view();
  await v.openReport(ID(1));
  const api = context.api as (n: string, i: unknown) => Promise<unknown>;
  let release!: () => void;
  context.api = (name: string, input: any) =>
    name === "report_list" && input.query === "preise"
      ? new Promise((resolve) => (release = () => resolve(api(name, input))))
      : api(name, input);
  type(host, "preise");
  const first = flush();
  type(host, "lint");
  await flush();
  release();
  await first;
  assert.deepEqual(
    listRows(host).map((r) => r.children[1].textContent),
    ["Lint nachgezogen"]
  );
  assert.equal(v.R.hits.q, "lint", "the older answer did not overwrite the newer one");
});

test("#1609: a full report store says so and how to make room", async () => {
  const { v, host, said, knobs } = await view([NOTE(1)]);
  await v.openReport(ID(1));
  knobs.capacity = true;
  await one(host, "tk-rep__acts").children[1].click();
  assert.deepEqual(said.at(-1), ["tk.rep.full", "error"], "mark read");
  await one(host, "tk-rep__hand").click();
  assert.deepEqual(said.at(-1), ["tk.rep.full", "error"], "hand-over");
  v.notesUi.open({ kind: "paragraph", index: 1, excerpt: "Erster Absatz." });
  await assert.rejects(v.notesUi.save("Neu"), { message: "tk.rep.full" }, "the note field shows it, keeps the text");
});

test("#1559: after Delete the next report shows an Undo notice; Undo brings the report back", async () => {
  const { v, host, calls, said } = await view();
  await v.openReport(ID(1));
  await one(one(host, "tk-rep__acts"), "is-quiet").click();
  assert.ok(calls.some(([name, input]) => name === "report_delete" && (input as any).id === ID(1)));
  assert.equal(v.R.sel, ID(2), "the next report is shown");
  const notice = one(host, "tk-rep__undo");
  assert.equal(notice.children[0].textContent, 'tk.rep.deletedNamed {"title":"Überblick: Förderung"}');
  assert.ok(!said.some(([text]) => text === "tk.rep.deleted"), "the notice replaces the plain confirmation");

  await notice.children[1].click();
  assert.ok(calls.some(([name, input]) => name === "report_restore" && (input as any).id === ID(1)));
  assert.deepEqual(said.at(-1), ["tk.rep.restored", undefined]);
  assert.equal(v.R.sel, ID(1), "the restored report is shown again");
  assert.equal(byClass(host, "tk-rep__undo").length, 0);
});

test("#1559: the undo action is visible after deleting the last report on a narrow screen", async () => {
  const { v, host, context, updateReports } = await view();
  host.clientWidth = 500;
  updateReports([REPORTS[0]]);
  context.loadReports = async () => updateReports([]);
  await v.openReport(ID(1));
  await one(one(host, "tk-rep__acts"), "is-quiet").click();
  const notice = one(host, "tk-rep__undo");
  assert.ok(one(host, "tk-rv").classList.contains("is-reading"), "narrow layout must show the reader with undo");
  await notice.children[2].click();
  assert.ok(!one(host, "tk-rv").classList.contains("is-reading"), "dismissing undo returns to the empty list");
});

test("#1559: deleting a report hidden by the current search keeps its title and the undo action", async () => {
  const { v, host, calls, context, updateReports } = await view();
  context.loadReports = async () => updateReports(REPORTS.slice(1));
  await v.openReport(ID(1));
  type(host, "zzzz");
  assert.equal(listRows(host).length, 0);
  await one(one(host, "tk-rep__acts"), "is-quiet").click();
  const notice = one(host, "tk-rep__undo");
  assert.equal(notice.children[0].textContent, 'tk.rep.deletedNamed {"title":"Überblick: Förderung"}');
  context.loadReports = async () => updateReports(REPORTS);
  await notice.children[1].click();
  assert.ok(calls.some(([name]) => name === "report_restore"));
  assert.equal(one(host, "tk-rep__title").textContent, "Überblick: Förderung");
});

test("#1559: a search with no remaining matches keeps the undo action after refreshing the list", async () => {
  const { v, host, context, updateReports } = await view();
  context.loadReports = async () => updateReports(REPORTS.slice(1));
  await v.openReport(ID(1));
  type(host, "Überblick");
  assert.equal(listRows(host).length, 1);
  await one(one(host, "tk-rep__acts"), "is-quiet").click();
  assert.equal(listRows(host).length, 0);
  assert.equal(v.R.sel, null);
  assert.equal(one(host, "tk-rep__undo").children[1].textContent, "tk.rep.undo");
});

test("#1597: an earlier response is ignored after switching away from and back to the same query", async () => {
  const { v, host, context, flush, runNextTimer } = await view();
  const api = context.api as (name: string, input: unknown) => Promise<unknown>;
  let release!: () => void;
  context.api = (name: string, payload: unknown) =>
    name === "report_list"
      ? new Promise((resolve) => (release = () => resolve({ reports: [REPORTS[2]] })))
      : api(name, payload);
  await v.openReport(ID(1));
  type(host, "preise");
  const first = runNextTimer();
  type(host, "andere Wörter");
  type(host, "preise");
  release();
  await first;
  assert.equal(listRows(host).length, 0, "the first result does not stand for the latest search");
  context.api = api;
  await flush();
  assert.equal(listRows(host).length, 1, "the current search still receives text hits");
});

test("#1559: the notice goes when the user moves on or closes it; an expired undo says so", async () => {
  const { v, host, said, knobs } = await view();
  const del = async () => {
    await v.openReport(ID(1));
    await one(one(host, "tk-rep__acts"), "is-quiet").click();
  };
  await del();
  await v.openReport(ID(3));
  assert.equal(byClass(host, "tk-rep__undo").length, 0, "moved on: the delete stays");
  await v.openReport(ID(2));
  assert.equal(byClass(host, "tk-rep__undo").length, 0, "and does not come back");

  await del();
  await one(host, "tk-rep__undo").children[2].click();
  assert.equal(byClass(host, "tk-rep__undo").length, 0, "× closes it");

  await del();
  knobs.restore = "not_found";
  await one(host, "tk-rep__undo").children[1].click();
  assert.deepEqual(said.at(-1), ["tk.rep.undoGone", "error"]);
  assert.equal(byClass(host, "tk-rep__undo").length, 0);
});

test("#1610: a rebuild while a note is typed keeps the cursor, the selection and the field's scroll place", async () => {
  const { v, draw, context } = await view();
  const doc = context.document as { activeElement: unknown };
  context.annotateReport = (nodes: Node_[], ui: any) => {
    const toc = { heads: [], asks: [] };
    if (!ui.editing) return { nodes, focus: null, toc };
    const area = h("textarea", null);
    area.value = "Bitte die Preise nochmal prüfen";
    return { nodes: [...nodes, area], focus: () => (doc.activeElement = area), toc };
  };
  await v.openReport(ID(1));
  v.notesUi.open({ kind: "paragraph", index: 1, excerpt: "Erster Absatz." });
  const typed = doc.activeElement as Node_;
  assert.equal(typed.tagName, "TEXTAREA", "the opened field has the cursor");
  typed.setSelectionRange(6, 9, "backward");
  typed.scrollTop = 40;

  (context.data as { reports: unknown }).reports = v.reportRows({
    reports: REPORTS.map((r) => (r.id === ID(1) ? { ...r, notes_open: 1 } : r)),
  });
  draw(); // a live update rebuilds the reader
  const now = doc.activeElement as Node_;
  assert.notEqual(now, typed, "the field was rebuilt");
  assert.deepEqual(
    [now.selectionStart, now.selectionEnd, now.selectionDirection, now.scrollTop],
    [6, 9, "backward", 40]
  );
});

test("#1597: polling changed reports searches the active query again and preserves the open reader", async () => {
  const { v, host, context, flush, updateReports, calls } = await view();
  await v.openReport(ID(1));
  type(host, "preise");
  await flush();
  assert.equal(one(listRows(host)[0], "mb-row__t").textContent, "Lint nachgezogen");
  const api = context.api as (name: string, input: unknown) => Promise<unknown>;
  context.api = (name: string, input: unknown) =>
    name === "report_list" ? Promise.resolve({ reports: [REPORTS[1]] }) : api(name, input);
  updateReports(REPORTS.map((r) => ({ ...r, notes_open: 1 })));
  await flush();
  assert.equal(listRows(host).length, 1);
  assert.equal(one(listRows(host)[0], "mb-row__t").textContent, "Release-Prüfung");
  assert.equal(v.R.sel, ID(1));
  assert.equal(v.R.q, "preise");
  assert.equal(calls.filter(([name]) => name === "report_read").length, 1);
});

const TEN_MIN = 10 * 60 * 1000;

test("N1: moving on to another report keeps the undo; the deleted report stays in the list with its time left", async () => {
  const { v, host, calls, said, context, updateAll, ticks } = await view();
  const until = Date.now() + TEN_MIN;
  context.loadReports = async () => updateAll(REPORTS.slice(1), [{ ...REPORTS[0], restorable_until: until }]);
  await v.openReport(ID(1));
  await one(one(host, "tk-rep__acts"), "is-quiet").click();
  await v.openReport(ID(3)); // moved on: before, the undo was gone here

  const deleted = listRows(host).filter((r) => r.classList.contains("is-deleted"));
  assert.equal(deleted.length, 1, "the deleted report is still listed");
  const row = deleted[0];
  assert.equal(row.tagName, "DIV", "not a button: it holds one");
  assert.equal(one(row, "mb-row__t").textContent, "Überblick: Förderung");
  assert.equal(listRows(host).indexOf(row), 0, "at the place it had in the list");
  assert.match(one(row, "tk-rv__left").textContent, /^tk\.rep\.del\.left \{"time":"(9:59|10:00)"\}$/);
  assert.equal(typeof ticks.fn, "function", "a countdown ticks while a deleted report is shown");

  await one(row, "tk-rv__restore").click();
  assert.ok(calls.some(([name, input]) => name === "report_restore" && (input as any).id === ID(1)));
  assert.deepEqual(said.at(-1), ["tk.rep.restored", undefined]);
  assert.equal(v.R.sel, ID(1), "the restored report is shown again");
});

test("N1: the countdown runs down in place, and an expired delete leaves the list", async () => {
  const { v, host, context, updateAll, ticks } = await view();
  let now = Date.now();
  context.Date = { now: () => now }; // the view reads the clock through Date.now only
  updateAll(REPORTS.slice(1), [{ ...REPORTS[0], restorable_until: now + 2 * 3_600_000 + 5 * 60_000 }]);
  await v.openReport(ID(2));
  const left = () => one(host, "tk-rv__left");
  assert.equal(left().textContent, 'tk.rep.del.left {"time":"tk.rep.del.hm {\\"h\\":2,\\"m\\":5}"}');
  const el = left();
  now += 2 * 3_600_000;
  ticks.fn!();
  assert.equal(el.textContent, 'tk.rep.del.left {"time":"5:00"}', "rewritten in place, the row is not rebuilt");
  assert.equal(left(), el);
  now += 5 * 60_000;
  let reloaded = false;
  context.loadReports = async () => {
    reloaded = true;
  };
  ticks.fn!();
  assert.ok(reloaded, "the list reloads once a countdown ran out");
  assert.equal(listRows(host).filter((r) => r.classList.contains("is-deleted")).length, 0);
  assert.equal(ticks.fn, null, "no countdown, no tick");
});

test("N1: a delete from an earlier visit is listed at the end; days and hours for a long window", async () => {
  const { v, host, updateAll } = await view();
  updateAll(REPORTS.slice(0, 2), [
    { id: ID(5), title: "Alt", created_at: 5, restorable_until: Date.now() + 3 * 86_400_000 + 4 * 3_600_000 + 1 },
  ]);
  await v.openReports();
  const rows = listRows(host);
  assert.equal(rows.length, 3);
  assert.ok(rows[2].classList.contains("is-deleted"));
  assert.match(one(rows[2], "tk-rv__left").textContent, /tk\.rep\.del\.dh \{\\"d\\":3,\\"h\\":4\}/);
});

test("search and project pick list sit in the head like the memory browser's; the list column holds only the rows", async () => {
  const { v, host } = await view();
  await v.openReports();
  const head = one(host, "mb__head");
  assert.equal(byClass(head, "mb__search").length, 1, "the search field is in the head");
  assert.equal(byClass(head, "tk-rv__input").length, 1);
  assert.equal(byClass(one(host, "tk-rv__side"), "mb__search").length, 0, "no search above the list");
  const kids = head.children.map((n) => n.className.split(" ")[0]);
  assert.deepEqual(kids, ["mb__title", "mb__slash", "mb__scope", "mb__search", "mb__hits"], "no ESC button");
});

test("project filter: like the memory browser's pick list; it narrows the list together with the search", async () => {
  const { v, host, docListeners } = await view();
  await v.openReports();
  const btn = one(host, "tk-rv__projbtn");
  assert.equal(one(btn, "mb__scopename").textContent, "tk.rep.proj.all");
  assert.equal(one(host, "mb__menu").hidden, true);
  await btn.click();
  const opts = byClass(host, "mb__opt");
  assert.deepEqual(
    opts.map((o) => [one(o, "mb__optname").textContent, one(o, "mb__mut").textContent]),
    [
      ["tk.rep.proj.all", "3"],
      ["bastra-io", "1"],
      ["bastra-recall", "1"],
      ["FÖRDERUNG", "1"],
    ],
    "every project once, with its count"
  );
  assert.ok(opts[0].classList.contains("is-on"));
  await opts[2].click();
  assert.equal(v.R.project, "bastra-recall");
  assert.equal(one(host, "mb__menu").hidden, true, "picking closes the list");
  assert.equal(one(btn, "mb__scopename").textContent, "bastra-recall");
  assert.deepEqual(
    listRows(host).map((r) => one(r, "mb-row__t").textContent),
    ["Release-Prüfung"]
  );
  type(host, "lint");
  assert.equal(listRows(host).length, 0, "search and project filter together");
  await one(one(host, "tk-rv__nohit"), "mb-btn").click();
  assert.equal(v.R.project, null, "clearing resets the project as well");
  assert.equal(listRows(host).length, 3);

  await btn.click();
  docListeners.pointerdown({ target: { closest: () => null } });
  assert.equal(v.R.menu, false, "a click outside closes the list");
  await btn.click();
  assert.equal(v.escapeReports(h("button", null)), true);
  assert.equal(v.R.menu, false, "Escape closes the list first");
  assert.ok(v.reportsOpen(), "and keeps the view");
});

test("N6/N29: picking an answer option saves it at once as an ordinary note at that place", async () => {
  const { v, calls, said, context } = await view();
  const api = context.api as (name: string, input: any) => Promise<unknown>;
  context.api = (name: string, input: any) =>
    name === "report_note_add"
      ? (calls.push([name, input]), Promise.resolve({ note: { ...NOTE(7), anchor: input.anchor, text: input.text } }))
      : api(name, input);
  await v.openReport(ID(1));
  const anchor = { kind: "item", index: 2, excerpt: "Ship it? [? Yes | No]" };
  await v.notesUi.answer(anchor, "Yes");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["report_note_add", { id: ID(1), anchor, text: "Yes" }]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(v.R.notes.map((n: any) => [n.kind, n.index, n.text, n.draft]))),
    [["item", 2, "Yes", true]],
    "a draft like any other note, handed over with the rest"
  );
  assert.equal(v.R.edit, null, "no note field opened on the way");
  assert.equal(said.length, 0, "no message: the card shows the answer");
});

test("N4: a report with open notes reads 'In progress' instead of 'New', in the notes' amber", async () => {
  const { v, host, context } = await view();
  (context.data as { reports: unknown }).reports = v.reportRows({
    reports: [{ ...REPORTS[0], notes_open: 1, notes_draft: 1 }, REPORTS[1], { ...REPORTS[2], notes_open: 0 }],
  });
  await v.openReports();
  const [work, fresh, read] = listRows(host);
  assert.ok(work.classList.contains("is-work"));
  assert.equal(one(work, "mb-row__ai").textContent, "tk.rep.inWork");
  assert.ok(one(work, "mb-row__ai").classList.contains("tk-rv__work"));
  assert.equal(one(fresh, "mb-row__ai").textContent, "tk.rep.new", "without notes an unread report stays 'New'");
  assert.ok(!fresh.classList.contains("is-work"));
  assert.equal(byClass(read, "mb-row__ai").length, 0);
});

test("state: 'Question' in the list opens the follow-up; its head leads back; 'Done' is calm", async () => {
  const { v, host, context } = await view();
  (context.data as { reports: unknown }).reports = v.reportRows({
    reports: [
      { ...REPORTS[0], status: "question", follow_up: { id: ID(2), title: REPORTS[1].title } },
      { ...REPORTS[1], status: "new", follow_up_of: { id: ID(1), title: REPORTS[0].title } },
      { ...REPORTS[2], status: "done" },
    ],
  });
  await v.openReports();
  const [asked, , done] = listRows(host);
  assert.ok(asked.classList.contains("is-work"), "a question is amber");
  assert.ok(!done.classList.contains("is-work"));
  assert.equal(one(done, "mb-row__ai").textContent, "tk.rep.doneState");
  await one(asked, "tk-rv__ask").click();
  assert.equal(v.R.sel, ID(2), "the follow-up is open");
  const back = one(one(host, "tk-rep__head"), "tk-rep__about");
  assert.equal(back.textContent, `tk.rep.askedAbout {"t":"${REPORTS[0].title}"}`);
  await back.click();
  assert.equal(v.R.sel, ID(1));
  assert.equal(one(one(host, "tk-rep__head"), "tk-rep__state").textContent, "tk.rep.question");
});

test("#1678: an outdated report reads 'Outdated' muted in list and head; the head sets and clears it", async () => {
  const { v, host, context, calls } = await view();
  (context.data as { reports: unknown }).reports = v.reportRows({
    reports: [REPORTS[0], REPORTS[1], { ...REPORTS[2], status: "outdated", outdated_at: 50, notes_open: 0 }],
  });
  await v.openReports();
  const [fresh, , old] = listRows(host);
  assert.ok(old.classList.contains("is-old"));
  assert.ok(!old.classList.contains("is-new"));
  assert.equal(one(old, "mb-row__ai").textContent, "tk.rep.outdated");
  assert.ok(one(old, "mb-row__ai").classList.contains("tk-rv__old"));
  assert.ok(!fresh.classList.contains("is-old"));

  const freshActs = one(one(host, "tk-rep__head"), "tk-rep__acts").children;
  await freshActs[1].click();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["report_mark", { id: ID(1), outdated: true }]);

  await v.openReport(ID(3));
  const head = one(host, "tk-rep__head");
  assert.equal(one(head, "tk-rep__state").textContent, "tk.rep.outdated");
  const acts = one(head, "tk-rep__acts").children;
  assert.deepEqual(
    acts.map((b) => b.textContent),
    ["tk.rep.markUnread", "tk.rep.markCurrent", "tk.rep.delete"]
  );
  await acts[1].click();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["report_mark", { id: ID(3), outdated: false }]);
});

test("#1678: an unread outdated report is not offered as the first to read and leaves rail and ticker", async () => {
  const { v, host, context } = await view();
  (context.data as { reports: unknown }).reports = v.reportRows({
    reports: [{ ...REPORTS[0], status: "outdated", outdated_at: 50 }, REPORTS[1]],
  });
  assert.equal(v.reportsArea.badge(), 1);
  assert.deepEqual(
    v.reportTickerItems().map((i: { text: string }) => i.text),
    [REPORTS[1].title]
  );
  await v.openReports();
  assert.equal(v.R.sel, ID(2), "the unread one opens first");
  const [fresh, old] = listRows(host);
  assert.ok(fresh.classList.contains("is-new"));
  assert.ok(old.classList.contains("is-old"));
  const acts = one(one(host, "tk-rep__head"), "tk-rep__acts").children;
  assert.ok(acts[0].classList.contains("is-primary"), "'Read' leads on the unread report");
  await v.openReport(ID(1));
  const oldActs = one(one(host, "tk-rep__head"), "tk-rep__acts").children;
  assert.ok(!oldActs[0].classList.contains("is-primary"), "an outdated report asks for nothing");
});

test("#1678: a report marked outdated while the list is open goes behind the current ones at once", async () => {
  const { v, host, context } = await view();
  await v.openReports();
  const ids = () => listRows(host).map((row) => one(row, "mb-row__t").textContent);
  const before = ids();
  (context.data as { reports: unknown }).reports = v.reportRows({
    reports: [REPORTS[1], REPORTS[2], { ...REPORTS[0], status: "outdated", outdated_at: 50 }],
  });
  (context.emit as () => void)();
  assert.deepEqual(ids(), [before[1], before[2], before[0]], "the outdated report left its place from the opening");
  // a plain read change keeps the place the list opened with
  (context.data as { reports: unknown }).reports = v.reportRows({
    reports: [REPORTS[2], { ...REPORTS[1], read_at: 60 }, { ...REPORTS[0], status: "outdated", outdated_at: 50 }],
  });
  (context.emit as () => void)();
  assert.deepEqual(ids(), [before[1], before[2], before[0]]);
});
