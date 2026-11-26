// UI v2 task reports — the status filter above the list (Daniel 26.11.2026: "by default only those that
// need my attention"; read, done and outdated reports on demand, done ones as a group of their own) and
// the row look per state. The real reading view runs in a VM context (webui-report-view.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Node_ } from "./webui-report-dom.js";
import { ID, REPORTS, view, byClass, one, type, listRows } from "./webui-report-view.js";

const STATUS = ["question", "handed", "read", "done", "outdated", "new", "in_progress"];
/** One report per state (ids 1 to 7), project "a" for the odd ones, "b" for the even ones. */
const ONE_EACH = STATUS.map((status, i) => ({
  id: ID(i + 1),
  title: `Bericht ${status}`,
  project: i % 2 ? "b" : "a",
  origin: { client: "codex" },
  created_at: 100 - i,
  ...(status === "new" ? {} : { read_at: 200 }),
  ...(status === "outdated" ? { outdated_at: 300 } : {}),
  status,
}));

const titles = (host: Node_) => listRows(host).map((r) => one(r, "mb-row__t").textContent);
const chips = (host: Node_) => byClass(one(host, "tk-rv__filter"), "tk-rv__chip");
/** [state class, pressed, count] per switch. */
const switches = (host: Node_) =>
  chips(host).map((c) => [
    c.className.split(" ").find((x) => x.startsWith("st-")),
    c.attrs["aria-pressed"],
    byClass(c, "mb__mut")[0].textContent,
  ]);
const chip = (host: Node_, state: string) =>
  chips(host).find((c) => c.classList.contains(`st-${state}`)) ?? assert.fail(state);
const groupHeads = (host: Node_) => byClass(one(host, "mb__list"), "mb__gh").map((g) => g.textContent);

async function setup() {
  const ctx = await view();
  (ctx.context.data as { reports: unknown }).reports = ctx.v.reportRows({ reports: ONE_EACH });
  await ctx.v.openReports();
  return ctx;
}

test("by default the list shows only the reports that need the owner; the switches say so with counts", async () => {
  const { host, v } = await setup();
  assert.deepEqual(titles(host).sort(), ["Bericht handed", "Bericht in_progress", "Bericht new", "Bericht question"]);
  assert.equal(v.R.sel, ID(6), "the view opens on the unread report, which the filter shows");
  assert.deepEqual(switches(host), [
    ["st-new", "true", "1"],
    ["st-question", "true", "1"],
    ["st-in_progress", "true", "1"],
    ["st-handed", "true", "1"],
    ["st-read", "false", "1"],
    ["st-done", "false", "1"],
    ["st-outdated", "false", "1"],
  ]);
  const bar = one(host, "tk-rv__filter");
  assert.equal(bar.attrs.role, "group");
  assert.equal(bar.attrs["aria-label"], "tk.rep.filter.label");
  for (const c of chips(host)) {
    assert.equal(c.tagName, "BUTTON", "a native button: Tab, Enter and Space reach it");
    assert.ok(c.attrs.title, "a tooltip says what the state means");
  }
  assert.deepEqual(groupHeads(host), [], "one group: no group head");
});

test("each row carries its state class; done stands as a group of its own below the open reports", async () => {
  const { host } = await setup();
  await chip(host, "done").click();
  assert.equal(chip(host, "done").attrs["aria-pressed"], "true");
  assert.equal(titles(host).at(-1), "Bericht done", "done comes last");
  assert.deepEqual(groupHeads(host), ["tk.rep.group.open4", "tk.rep.group.done1"]);
  for (const row of listRows(host)) {
    const state = one(row, "mb-row__t").textContent.replace("Bericht ", "");
    assert.ok(row.classList.contains(`st-${state}`), `${state}: its colour class`);
  }
  // every state on: open, read, done, outdated, in this order
  await chip(host, "read").click();
  await chip(host, "outdated").click();
  assert.deepEqual(groupHeads(host), [
    "tk.rep.group.open4",
    "tk.rep.group.read1",
    "tk.rep.group.done1",
    "tk.rep.group.outdated1",
  ]);
  assert.deepEqual(titles(host).slice(-3), ["Bericht read", "Bericht done", "Bericht outdated"]);
  // and off again: the new report is the open one, so it keeps its row; the question goes
  await chip(host, "new").click();
  await chip(host, "question").click();
  assert.equal(chip(host, "question").attrs["aria-pressed"], "false");
  assert.ok(titles(host).includes("Bericht new"), "the open report stays");
  assert.ok(!titles(host).includes("Bericht question"));
});

test("the open report keeps its row whatever the filter says, so marking it never pulls it away", async () => {
  const { host, v, context, draw } = await setup();
  await v.openReport(ID(1));
  // the agent closed the question: the report is read now, which the default filter hides
  (context.data as { reports: unknown }).reports = v.reportRows({
    reports: ONE_EACH.map((r) => (r.id === ID(1) ? { ...r, status: "read" } : r)),
  });
  draw();
  assert.ok(titles(host).includes("Bericht question"), "still listed while it is open");
  const row = listRows(host).find((r) => r.classList.contains("is-sel"))!;
  assert.ok(row.classList.contains("st-read"));
  await v.openReport(ID(2));
  assert.ok(!titles(host).includes("Bericht question"), "gone once another report is open");
});

test("search and project filter narrow first; the switches count what they leave", async () => {
  const { host, v, draw } = await setup();
  v.R.project = "a";
  draw();
  // project a: question, read, outdated, in_progress (ids 1, 3, 5, 7)
  assert.deepEqual(titles(host).sort(), ["Bericht in_progress", "Bericht question"]);
  assert.deepEqual(
    switches(host).map(([s, , n]) => [s, n]),
    [
      ["st-new", "0"],
      ["st-question", "1"],
      ["st-in_progress", "1"],
      ["st-handed", "0"],
      ["st-read", "1"],
      ["st-done", "0"],
      ["st-outdated", "1"],
    ]
  );
  type(host, "progress");
  assert.deepEqual(titles(host), ["Bericht in_progress"]);
  assert.equal(chip(host, "question").children.at(-1)!.textContent, "0");
  await chip(host, "read").click();
  assert.deepEqual(titles(host), ["Bericht in_progress"], "the search still holds");
});

test("when only the status filter hides every report, the list says so without a search reset", async () => {
  const ctx = await view();
  (ctx.context.data as { reports: unknown }).reports = ctx.v.reportRows({
    reports: [{ ...REPORTS[0], read_at: 5, status: "done" }],
  });
  await ctx.v.openReports();
  assert.equal(ctx.v.R.sel, null, "opening the list does not select an excluded report");
  const list = one(ctx.host, "mb__list");
  assert.equal(list.textContent, "tk.rep.filter.none");
  assert.equal(byClass(list, "mb-btn").length, 0, "the switches are right above");
  type(ctx.host, "nichts passt");
  assert.equal(one(list, "tk-rv__nohit").children[0].textContent, "tk.rep.find.none", "a search that hides all");
});

test("when the switches hide a report that waits, the list does not claim nothing waits", async () => {
  const ctx = await view();
  (ctx.context.data as { reports: unknown }).reports = ctx.v.reportRows({
    reports: [
      { ...REPORTS[0], read_at: 5, status: "question" },
      { ...REPORTS[1], read_at: 5, status: "done" },
    ],
  });
  // the question switch off before the view opens, so no open report keeps its row
  ctx.v.R.states.delete("question");
  await ctx.v.openReports();
  assert.equal(chip(ctx.host, "question").attrs["aria-pressed"], "false");
  const list = one(ctx.host, "mb__list");
  assert.equal(listRows(ctx.host).length, 0);
  assert.equal(list.textContent, 'tk.rep.filter.hidden {"n":2}', "both reports are hidden by the switches");
  assert.equal(byClass(list, "mb-btn").length, 0, "the switches are right above");
  // the question switched on again and closed: nothing waits any more, so the old text is right
  await chip(ctx.host, "question").click();
  ctx.updateReports([
    { ...REPORTS[0], read_at: 5, status: "read" },
    { ...REPORTS[1], read_at: 5, status: "done" },
  ]);
  assert.equal(one(ctx.host, "mb__list").textContent, "tk.rep.filter.none");
});

test("group heads are headings for screen readers; rows and arrow keys stay as they were", async () => {
  const { host, context } = await setup();
  await chip(host, "done").click();
  const list = one(host, "mb__list");
  const heads = byClass(list, "mb__gh");
  assert.equal(heads.length, 2);
  for (const g of heads) {
    assert.equal(g.attrs.role, "heading");
    assert.equal(g.attrs["aria-level"], "2", "on the level of the reader's report title (h2)");
    assert.equal(g.tagName, "DIV", "the look stays the memory browser's");
  }
  assert.equal(list.tagName, "NAV");
  const rows = listRows(host);
  for (const row of rows) assert.equal(row.tagName, "BUTTON");
  // the arrow keys skip the heads: from the last open row straight to the done one
  const doc = context.document as { activeElement: Node_ | null };
  let focused: Node_ | null = null;
  const focus = Node_.prototype.focus;
  Node_.prototype.focus = function () {
    focused = this;
  };
  try {
    doc.activeElement = rows.at(-2)!;
    const e = { key: "ArrowDown", currentTarget: list, preventDefault() {} };
    for (const fn of list.listeners.keydown) fn(e);
    assert.equal(focused, rows.at(-1));
  } finally {
    Node_.prototype.focus = focus;
  }
});

test("polling leaves the reader unselected when all reports are excluded", async () => {
  const { v, updateReports } = await setup();
  updateReports([ONE_EACH[3]]);
  assert.equal(v.R.sel, null, "the selected report disappeared and the only remaining report is done");
});

test("deleting a report opens its next visible neighbour across groups", async () => {
  const { host, v } = await setup();
  await chip(host, "read").click();
  await v.openReport(ID(2));
  const current = titles(host).indexOf("Bericht handed");
  assert.equal(titles(host)[current + 1], "Bericht in_progress");
  const remove = byClass(one(host, "tk-rep__acts"), "mb-btn").find((button) => button.textContent === "tk.rep.delete");
  assert.ok(remove);
  await remove.click();
  assert.equal(v.R.sel, ID(7));
});

test("polling restores row focus by report when a status change regroups the list", async () => {
  const { host, context, updateReports } = await setup();
  await chip(host, "read").click();
  const doc = context.document as { activeElement: Node_ | null };
  doc.activeElement = listRows(host).find((row) => one(row, "mb-row__t").textContent === "Bericht question")!;
  let focused: Node_ | null = null;
  const focus = Node_.prototype.focus;
  Node_.prototype.focus = function () {
    focused = this;
  };
  try {
    updateReports(ONE_EACH.map((r) => (r.id === ID(1) ? { ...r, status: "read" } : r)));
    assert.equal(focused && one(focused, "mb-row__t").textContent, "Bericht question");
  } finally {
    Node_.prototype.focus = focus;
  }
});

test("the choice holds when the view is left and opened again", async () => {
  const { host, v } = await setup();
  await chip(host, "done").click();
  v.closeReports();
  await v.openReports();
  assert.equal(chip(host, "done").attrs["aria-pressed"], "true");
  assert.ok(titles(host).includes("Bericht done"));
});
