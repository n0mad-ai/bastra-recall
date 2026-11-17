// UI v2 task reports — the reading view (js/sections/tasks-reports.js) with a
// fake DOM: the actions sit in the reader's head and nowhere below the report,
// the search above the list filters by title and project (#1597) while the
// shown report stays open, and Escape closes the note field, then empties the
// search, then leaves the view. The real module runs in a VM context; its
// imports are replaced by small stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { Node_, h } from "./v22-report-dom.js";

const read = (path: string) => readFile(new URL(`../webui/v22/js/${path}`, import.meta.url), "utf8");
const strip = (source: string) => source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

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

async function view() {
  const calls: Array<[string, unknown]> = [];
  const source = strip(await read("sections/tasks-reports-model.js")) + strip(await read("sections/tasks-reports.js"));
  const context: Record<string, unknown> = {
    h,
    searchIcon: () => h("svg", null),
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    state: { lensOpen: false },
    setState() {},
    data: { reports: [] },
    onData() {},
    loadReports: async () => {},
    markdown: (text: string) => [h("p", null, text)],
    openMemoryBrowser() {},
    ago: (at: number) => `${at}m`,
    S: {},
    emit() {},
    say() {},
    act: (fn: () => unknown) => fn(),
    api: async (name: string, input: unknown) => {
      calls.push([name, input]);
      return name === "report_read" ? { body: "Erster Absatz.", notes: [] } : {};
    },
    fmtAt: (at: number) => `@${at}`,
    annotateReport: (nodes: Node_[]) => ({ nodes, focus: null }),
    document: { activeElement: null },
    JSON,
  };
  const v = runInNewContext(
    source +
      "\n({ R, notesUi, reportRows, openReport, openReports, reportsRenderer, escapeReports, reportsOpen, matchReports })",
    context
  );
  (context.data as { reports: unknown }).reports = v.reportRows({ reports: REPORTS });
  const host = h("div", null);
  host.clientWidth = 1000;
  const draw = v.reportsRenderer(host);
  context.emit = () => draw();
  return { v, host, draw, calls };
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

test("a read report offers 'unread', shows its open notes in the head and its read time below", async () => {
  const { v, host } = await view();
  await v.openReport(ID(3));
  const head = one(host, "tk-rep__head");
  assert.deepEqual(
    one(head, "tk-rep__acts").children.map((b) => b.textContent),
    ["tk.rep.markUnread", "tk.rep.delete"]
  );
  assert.match(one(head, "tk-rep__open").textContent, /tk\.rep\.note\.count \{"n":2\}/);
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
