// UI v2 task reports — the status filter (Daniel 26.11.2026: "by default only those that need my
// attention"; read, done and outdated reports on demand, done ones as a group of their own), in the head
// between project and search: four switches, then a pick list like the project's for the filed-away
// states (Daniel 26.11.2026), and the row look per state. The real reading view runs in a VM context
// (webui-report-view.ts).
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
const stateBtn = (host: Node_) => one(one(host, "mb__head"), "tk-rv__statebtn");
const stateMenu = (host: Node_) => one(host, "tk-rv__smenu");
const ATTENTION = ["new", "question", "in_progress", "handed"];
/** Every state's control: the four switches in the head, then the pick list's entries (the list is
 *  opened first when it is closed). */
const chips = (host: Node_) => {
  if (stateMenu(host).hidden) void stateBtn(host).click();
  return [...byClass(one(host, "mb__head"), "tk-rv__chip"), ...byClass(stateMenu(host), "tk-rv__sopt")];
};
/** [state class, pressed, count] per control. */
const switches = (host: Node_) =>
  chips(host).map((c) => [
    c.className.split(" ").find((x) => x.startsWith("st-")),
    c.attrs["aria-pressed"],
    byClass(c, "mb__mut")[0].textContent,
  ]);
const chip = (host: Node_, state: string) =>
  (ATTENTION.includes(state) ? byClass(one(host, "mb__head"), "tk-rv__chip") : chips(host)).find((c) =>
    c.classList.contains(`st-${state}`)
  ) ?? assert.fail(state);
/** What the closed pick list says: its name and the number of states switched on in it. */
const label = (host: Node_) =>
  [one(stateBtn(host), "mb__scopename").textContent, byClass(stateBtn(host), "mb__mut")[0].textContent].join(" ");
const groupHeads = (host: Node_) => byClass(one(host, "mb__list"), "mb__gh").map((g) => g.textContent);

async function setup(stored?: Map<string, string>) {
  const ctx = await view([], stored);
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
  assert.equal(byClass(host, "tk-rv__filter").length, 0, "no filter row of its own any more");
  const group = one(one(host, "mb__head"), "tk-rv__fgrp");
  assert.equal(group.attrs.role, "group");
  assert.equal(group.attrs["aria-label"], "tk.rep.filter.label");
  assert.deepEqual(
    group.children.map((c) => c.className.split(" ").find((x) => x.startsWith("st-"))),
    ["st-new", "st-question", "st-in_progress", "st-handed"],
    "the four open states as switches"
  );
  const menu = stateMenu(host);
  assert.equal(menu.attrs.role, "group");
  assert.equal(menu.attrs["aria-label"], "tk.rep.filter.filedTip");
  assert.ok(menu.classList.contains("mb__menu"), "the project pick list's list");
  for (const c of chips(host)) {
    assert.equal(c.tagName, "BUTTON", "a native button: Tab, Enter and Space reach it");
    assert.ok(c.attrs.title, "a tooltip says what the state means");
  }
  assert.deepEqual(groupHeads(host), [], "one group: no group head");
});

test("in the head between project and search: the switches, then the filed-away states' pick list", async () => {
  const { host, v, docListeners } = await setup();
  const head = one(host, "mb__head");
  assert.deepEqual(
    head.children.map((n) => n.className.split(" ").slice(0, 2).join(" ")),
    ["mb__scope tk-rv__proj", "tk-rv__fgrp", "mb__scope tk-rv__state", "mb__search", "mb__hits tk-rv__hits"]
  );
  const btn = stateBtn(host);
  assert.ok(btn.classList.contains("mb__scopebtn"), "the project pick list's button");
  assert.equal(btn.attrs["aria-haspopup"], "true");
  assert.equal(btn.attrs["aria-expanded"], "false");
  assert.equal(stateMenu(host).hidden, true);
  assert.equal(label(host), "tk.rep.filter.filed ", "closed and none on: just its name");
  await btn.click();
  assert.equal(btn.attrs["aria-expanded"], "true");
  assert.ok(btn.classList.contains("is-open"));
  assert.deepEqual(
    byClass(stateMenu(host), "mb__opt").map((o) => [
      one(o, "mb__optname").textContent,
      one(o, "mb__mut").textContent,
      o.attrs["aria-pressed"],
    ]),
    [
      ["tk.rep.st.read", "1", "false"],
      ["tk.rep.st.done", "1", "false"],
      ["tk.rep.st.outdated", "1", "false"],
    ],
    "the three filed-away states, each with its count"
  );
  // a state switches and leaves the list open; the closed list counts the states switched on
  await chip(host, "read").click();
  await chip(host, "outdated").click();
  assert.equal(stateMenu(host).hidden, false, "a state leaves the list open");
  assert.equal(label(host), "tk.rep.filter.filed 2");
  assert.equal(titles(host).length, 6);
  // opening the one list closes the other
  await one(host, "tk-rv__projbtn").click();
  assert.equal(v.R.smenu, false);
  assert.equal(v.R.menu, true);
  await btn.click();
  assert.equal(v.R.menu, false);
  // a click outside and Escape close it, the view stays
  docListeners.pointerdown({ target: { closest: () => null } });
  assert.equal(v.R.smenu, false, "a click outside closes the list");
  await btn.click();
  docListeners.pointerdown({ target: { closest: (sel: string) => (sel === ".tk-rv__state" ? btn : null) } });
  assert.equal(v.R.smenu, true, "a click inside keeps it open");
  assert.equal(v.escapeReports(btn), true);
  assert.equal(v.R.smenu, false, "Escape closes the list");
  assert.ok(v.reportsOpen());
});

test("one line: no title in the head; a narrower view gets the short search hint", async () => {
  const { host, draw } = await setup();
  const head = one(host, "mb__head");
  assert.equal(byClass(head, "mb__title").length, 0, "the breadcrumb and the rail name the area");
  const input = one(head, "tk-rv__input") as Node_ & { placeholder?: string };
  assert.equal(input.placeholder, "tk.rep.find.ph");
  host.clientWidth = 900;
  draw();
  assert.equal(input.placeholder, "tk.rep.find.phShort");
  host.clientWidth = 1200;
  draw();
  assert.equal(input.placeholder, "tk.rep.find.ph");
});

test("an entry keeps the keyboard focus when it is switched: the list is not rebuilt", async () => {
  const { host } = await setup();
  const before = chip(host, "done");
  await before.click();
  assert.equal(chip(host, "done"), before, "the same button, so the focus stays on it");
  assert.equal(before.attrs["aria-pressed"], "true");
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
  assert.equal(list.textContent, 'tk.rep.filter.hidden {"n":2}', "both reports are hidden by the filter");
  assert.equal(byClass(list, "mb-btn").length, 0, "the filter is right above");
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

test("the browser restores the chosen statuses, including no statuses, after a reload", async () => {
  const stored = new Map<string, string>();
  const first = await setup(stored);
  await chip(first.host, "question").click();
  await chip(first.host, "read").click();

  const second = await setup(stored);
  assert.equal(chip(second.host, "question").attrs["aria-pressed"], "false");
  assert.equal(chip(second.host, "read").attrs["aria-pressed"], "true");
  for (const state of ["new", "in_progress", "handed", "read"]) await chip(second.host, state).click();

  const third = await setup(stored);
  assert.equal(third.v.R.states.size, 0);
  assert.deepEqual(titles(third.host), []);
});

test("broken or blocked storage leaves the report filter usable", async () => {
  const { host, knobs } = await setup(new Map([["recall-reports-filter-states", "invalid JSON"]]));
  assert.equal(chip(host, "handed").attrs["aria-pressed"], "true");
  knobs.blocked = true;
  await chip(host, "read").click();
  assert.equal(chip(host, "read").attrs["aria-pressed"], "true");
});

test("Escape from a filed status option restores focus to the filter button", async () => {
  const { host, v } = await setup();
  const button = stateBtn(host);
  await button.click();
  const option = chip(host, "done");
  Object.assign(option, { closest: (selector: string) => (selector === ".tk-rv__state" ? button.parent : null) });
  let focused = false;
  button.focus = () => {
    focused = true;
  };
  assert.equal(v.escapeReports(option), true);
  assert.equal(stateMenu(host).hidden, true);
  assert.equal(focused, true);
});

test("Escape in the filed status list keeps an open report note draft", async () => {
  const { host, v } = await setup();
  const button = stateBtn(host);
  await button.click();
  const option = chip(host, "done");
  Object.assign(option, { closest: (selector: string) => (selector === ".tk-rv__state" ? button.parent : null) });
  const draft = {
    anchor: { kind: "paragraph", index: 1, excerpt: "fixture" },
    noteId: null,
    draft: { value: "unsaved" },
  };
  v.R.edit = draft;
  assert.equal(v.escapeReports(option), true);
  assert.equal(v.R.edit, draft);
  assert.equal(stateMenu(host).hidden, true);
});
