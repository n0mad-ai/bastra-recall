// UI v2 task reports — reading aids in the reading view (Daniel 18.11.2026): the text size switch
// next to read and delete, the answered questions in the head's meta line, the jump list as the right
// panel's tab (headings, then questions with state and count; a click scrolls there, scrolling marks
// the place being read), and the right panel left open or closed as the user set it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Node_, h } from "./webui-report-dom.js";
import { ID, view, byClass, one, type Toc } from "./webui-report-view.js";

const sizes = (host: Node_) =>
  byClass(one(host, "tk-rep__size"), "tk-rep__sz").map((b) => [b.attrs["aria-label"], b.attrs["aria-pressed"]]);

test("text size: three steps next to read and delete, medium by default, kept in this browser", async () => {
  const stored = new Map<string, string>();
  const { v, host } = await view([], stored);
  await v.openReport(ID(1));
  const head = one(host, "tk-rep__head");
  const kids = head.children.map((n) => n.className.split(" ")[0]);
  assert.deepEqual(kids.slice(-2), ["tk-rep__size", "mb-rd__acts"], "the switch stands right before the actions");
  assert.equal(one(head, "tk-rep__size").attrs.role, "group");
  assert.equal(one(head, "tk-rep__size").attrs["aria-label"], "tk.rep.size.label");
  assert.deepEqual(sizes(host), [
    ["tk.rep.size.s", "false"],
    ["tk.rep.size.m", "true"],
    ["tk.rep.size.l", "false"],
  ]);
  assert.ok(one(host, "tk-rep__md").classList.contains("is-size-m"));
  await byClass(host, "tk-rep__sz")[2].click();
  assert.ok(one(host, "tk-rep__md").classList.contains("is-size-l"), "only the report text changes");
  assert.equal(sizes(host)[2][1], "true");
  assert.equal(stored.get("recall-reports-text-size"), "l");
  const again = await view([], stored);
  await again.v.openReport(ID(1));
  assert.ok(one(again.host, "tk-rep__md").classList.contains("is-size-l"), "the next visit keeps it");
});

test("text size: blocked storage changes nothing but the memory of the choice", async () => {
  const { v, host, knobs } = await view();
  knobs.blocked = true;
  await v.openReport(ID(1));
  await byClass(host, "tk-rep__sz")[0].click();
  assert.ok(one(host, "tk-rep__md").classList.contains("is-size-s"));
});

/** A rendered report as annotateReport describes it: two headings and two questions. */
function outline(answered: boolean): Toc {
  const el = (top: number) => Object.assign(h("p", null), { top });
  return {
    heads: [
      { text: "Summary", el: el(0), index: 1 },
      { text: "Questions", el: el(400), index: 3 },
    ],
    asks: [
      { text: "Keep it?", el: el(500), index: 4, answered },
      { text: "Ship it?", el: el(700), index: 5, answered: false },
    ],
  };
}

test("head: with questions the meta line counts the answered ones; without, nothing", async () => {
  const { v, host, knobs } = await view();
  await v.openReport(ID(1));
  assert.equal(byClass(host, "tk-rep__asks").length, 0);
  knobs.toc = outline(true);
  await v.openReport(ID(2));
  const asks = one(host, "tk-rep__asks");
  assert.equal(asks.textContent, 'tk.rep.asks {"n":1,"m":2}');
  assert.ok(asks.classList.contains("is-open"), "amber while some are open");
});

test("jump list: the right panel's tab shows headings, then the questions with state and count", async () => {
  const { v, knobs, context } = await view();
  knobs.toc = outline(true);
  await v.openReports();
  assert.equal((context.state as { tab: string }).tab, "toc", "the panel turns to the jump list");
  const body = h("div", null);
  v.outlineTab.render(body);
  const [heads, asks] = body.children;
  assert.deepEqual(
    [one(heads, "lens__h-t").textContent, one(heads, "lens__h-n").textContent],
    ["tk.rep.toc.heads", "2"]
  );
  assert.deepEqual(
    [one(asks, "lens__h-t").textContent, one(asks, "lens__h-n").textContent],
    ["tk.rep.toc.asks", 'tk.rep.toc.answered {"n":1,"m":2}']
  );
  assert.deepEqual(
    byClass(body, "tk-toc__j").map((r) => [r.textContent, r.className]),
    [
      ["Summary", "tk-toc__j is-head is-here"],
      ["Questions", "tk-toc__j is-head"],
      ["Keep it?", "tk-toc__j is-ask is-done"],
      ["Ship it?", "tk-toc__j is-ask"],
    ]
  );
});

test("jump list: a click scrolls to the place; scrolling marks the place being read", async () => {
  const { v, knobs, host } = await view();
  const toc = outline(false);
  knobs.toc = toc;
  await v.openReports();
  const body = h("div", null);
  v.outlineTab.render(body);
  const rows = byClass(body, "tk-toc__j");
  await rows[3].click();
  assert.equal(toc.asks[1].el.scrolled, 1, "the question's place scrolled into view");
  // the reader scrolled: "Questions" has passed the line below the head, "Keep it?" not yet
  toc.heads[0].el.top = -500;
  toc.heads[1].el.top = 60;
  toc.asks[0].el.top = 300;
  toc.asks[1].el.top = 500;
  for (const fn of one(host, "mb__reader").listeners.scroll ?? []) fn();
  assert.deepEqual(
    rows.map((r) => r.classList.contains("is-here")),
    [false, true, false, false]
  );
  assert.equal(rows[1].attrs["aria-current"], "location");
  assert.equal(rows[0].attrs["aria-current"], undefined);
});

test("jump list: without a report, and for a report without headings or questions, a short note", async () => {
  const { v } = await view();
  v.closeReports();
  const empty = h("div", null);
  v.outlineTab.render(empty);
  assert.equal(empty.textContent, "tk.rep.toc.pick");
  await v.openReport(ID(1));
  const none = h("div", null);
  v.outlineTab.render(none);
  assert.equal(none.textContent, "tk.rep.toc.none");
  v.closeReports();
  const closed = h("div", null);
  v.outlineTab.render(closed);
  assert.equal(closed.textContent, "tk.rep.toc.pick", "leaving the view forgets the outline");
});

test("the right panel stays as the user set it: the reading view neither closes nor opens it", async () => {
  for (const open of [true, false]) {
    const { v, context } = await view();
    const state = context.state as { lensOpen: boolean };
    state.lensOpen = open;
    await v.openReports();
    assert.equal(state.lensOpen, open, `entering keeps it ${open ? "open" : "closed"}`);
    v.closeReports();
    assert.equal(state.lensOpen, open, "leaving keeps it too");
    await v.openReports();
    assert.equal(state.lensOpen, open, "and coming back");
  }
});
