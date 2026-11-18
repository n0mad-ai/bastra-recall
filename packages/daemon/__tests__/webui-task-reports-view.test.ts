// UI v2 task reports — the reading view (js/sections/tasks-reports.js) with a
// fake DOM: the actions sit in the reader's head and nowhere below the report,
// the search above the list filters by title and project (#1597) while the
// shown report stays open, the daemon's text hits join in once they arrive, and Escape closes the note field, then empties the
// search, then leaves the view. With drafts among the notes, "Hand over to
// agent" leads the head and "Read" steps back. The real module runs in a VM
// context; its imports are replaced by small stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { Node_, h } from "./webui-report-dom.js";

const read = (path: string) => readFile(new URL(`../webui/app/js/${path}`, import.meta.url), "utf8");
const strip = (source: string) => source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
/** Report texts the stand-in daemon searches (task_report_list with query). */
const BODIES: Record<string, string> = { [ID(3)]: "die preise steigen weiter." };

const REPORTS = [
  { id: ID(1), title: "Überblick: Förderung", project: "FÖRDERUNG", origin: { client: "codex" }, created_at: 30 },
  { id: ID(2), title: "Release-Prüfung", project: "bastra-recall", origin: { client: "claude-code" }, created_at: 20 },
  {
    id: ID(3),
    title: "Lint nachgezogen",
    project: "bastra-io",
    origin: { client: "codex", session: "s-1" },
    created_at: 10,
    read_at: 40,
    notes_open: 2,
  },
];

async function view(notes: unknown[] = []) {
  const calls: Array<[string, unknown]> = [];
  const timers = new Map<number, () => unknown>();
  let timerId = 0;
  const said: Array<[string, unknown]> = [];
  const events: string[] = [];
  const dataListeners: Array<() => void> = [];
  const source = (
    await Promise.all(
      [
        "sections/tasks-reports-model.js",
        "sections/tasks-reports-state.js",
        "sections/tasks-reports-search.js",
        "sections/tasks-reports-undo.js",
        "sections/tasks-reports.js",
      ].map(read)
    )
  )
    .map(strip)
    .join("");
  const context: Record<string, unknown> = {
    h,
    searchIcon: () => h("svg", null),
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    state: { lensOpen: false },
    setState() {},
    data: { reports: [] },
    onData: (fn: () => void) => dataListeners.push(fn),
    loadReports: async () => {},
    markdown: (text: string) => [h("p", null, text)],
    openMemoryBrowser() {},
    ago: (at: number) => `${at}m`,
    S: {},
    emit() {},
    say: (text: string, tone: unknown) => said.push([text, tone]),
    act: async (fn: () => Promise<unknown>) => {
      try {
        const msg = await fn();
        if (msg) said.push([msg as string, undefined]);
      } catch (e) {
        said.push([(e as Error).message, "error"]);
      }
    },
    api: async (name: string, input: any) => {
      calls.push([name, input]);
      if (knobs.capacity && name !== "report_read" && name !== "report_list")
        throw Object.assign(new Error("tk.err.generic"), { code: "capacity" });
      if (name === "report_list")
        return { reports: REPORTS.filter((r) => (BODIES[r.id] ?? "").includes(input.query.toLowerCase())) };
      if (name === "report_delete") return { deleted: true, id: input.id, restorable_until: 99 };
      if (name === "report_restore" && knobs.restore)
        throw Object.assign(new Error(`tk.err.${knobs.restore}`), { code: knobs.restore });
      if (name === "report_notes_hand") {
        if (hand.fail) throw Object.assign(new Error("tk.err.not_found"), { code: "not_found" });
        return { handed: 1, notes: notes.map((n: any) => ({ ...n, handed_at: 99 })) };
      }
      return name === "report_read" ? { body: "Erster Absatz.", notes } : {};
    },
    fmtAt: (at: number) => `@${at}`,
    annotateReport: (nodes: Node_[]) => ({ nodes, focus: null }),
    ICON: { reports: "M0 0" },
    document: { activeElement: null, dispatchEvent: (e: { type: string }) => events.push(e.type) },
    CustomEvent: class {
      constructor(public type: string) {}
    },
    JSON,
    // a pause (the text search waits for typing to stop) runs when the test says so, never by the clock
    setTimeout: (fn: () => unknown) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
  };
  const hand = { fail: false };
  const knobs: { capacity: boolean; restore: string | null } = { capacity: false, restore: null };
  const v = runInNewContext(
    source +
      "\n({ R, notesUi, reportRows, openReport, openReports, closeReports, reportsRenderer, escapeReports, reportsOpen, matchReports, reportsArea, tasksLit, showCalendar })",
    context
  );
  (context.data as { reports: unknown }).reports = v.reportRows({ reports: REPORTS });
  const host = h("div", null);
  host.clientWidth = 1000;
  const draw = v.reportsRenderer(host);
  context.emit = () => draw();
  const runNextTimer = async () => {
    const next = timers.entries().next().value;
    if (!next) return;
    const [id, fn] = next;
    timers.delete(id);
    await fn();
  };
  const flush = async () => {
    while (timers.size) await runNextTimer();
  };
  const updateReports = (reports: unknown[]) => {
    (context.data as { reports: unknown }).reports = v.reportRows({ reports });
    for (const notify of dataListeners) notify();
  };
  return { v, host, draw, calls, said, events, hand, knobs, flush, context, updateReports, runNextTimer };
}

const byClass = (root: Node_, cls: string) => root.find(cls);
const one = (root: Node_, cls: string) => byClass(root, cls)[0] ?? assert.fail(`no .${cls}`);
const input = (host: Node_) => one(host, "tk-rv__input");
function type(host: Node_, text: string) {
  const el = input(host);
  el.value = text;
  for (const fn of el.listeners.input ?? []) fn();
}
const listRows = (host: Node_) => one(host, "mb__list").children.filter((n) => n.classList.contains("mb-row"));

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
    ["tk.rep.markRead", "tk.rep.delete"]
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
    ["tk.rep.markUnread", "tk.rep.delete"]
  );
  const [handed] = byClass(head, "tk-rep__open");
  assert.match(handed.textContent, /tk\.rep\.note\.handed \{"n":2\}/);
  assert.match(handed.attrs.title, /tk\.rep\.note\.handedTip/);
  assert.equal(byClass(head, "is-draft").length, 0, "no drafts");
  assert.equal(one(head, "tk-rep__meta").children[2].textContent, "codex · s-1");
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
  assert.equal(one(host, "tk-rv__find").textContent, "", "no count while nothing is searched");

  type(host, "ÜBERBLICK");
  assert.deepEqual(
    listRows(host).map((r) => r.children[1].textContent),
    ["Überblick: Förderung"]
  );
  assert.match(one(host, "tk-rv__find").textContent, /tk\.rep\.find\.count \{"n":1,"m":3\}/);
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

  assert.equal(v.escapeReports(field), true);
  assert.ok(!v.reportsOpen(), "then the view closes");
  assert.equal(v.escapeReports(field), false, "a closed view leaves Escape to others");
});

test("Escape outside the search field leaves the view; the next visit starts without a search", async () => {
  const { v, host } = await view();
  await v.openReports();
  type(host, "bastra");
  assert.equal(v.escapeReports(h("button", null)), true);
  assert.ok(!v.reportsOpen());
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
    ['tk.rep.hand {"n":1}', "tk.rep.markRead", "tk.rep.delete"]
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
    if (!ui.editing) return { nodes, focus: null };
    const area = h("textarea", null);
    area.value = "Bitte die Preise nochmal prüfen";
    return { nodes: [...nodes, area], focus: () => (doc.activeElement = area) };
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
