// UI v2 task reports — the one state a report shows (Daniel 18.11.2026; js/sections/tasks-reports-status.js):
// the label per state from the daemon's `status`, the old rule for a Recall that sends none, the
// "Question" jump to the follow-up (a click on the list label, a button in the head) and the
// follow-up's "Question about: …" back. The real modules run in a VM context with a fake DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { Node_, h } from "./webui-report-dom.js";

const read = (path: string) => readFile(new URL(`../webui/app/js/sections/${path}`, import.meta.url), "utf8");
const strip = (source: string) => source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const base = { title: "Bericht", origin: { client: "codex" }, created_at: 10 };

async function load() {
  const source = [await read("tasks-reports-model.js"), await read("tasks-reports-status.js")].map(strip).join("\n");
  return runInNewContext(`${source}\n({ reportRows, stateMark, askedAbout })`, {
    h,
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
  });
}

test("every state has its label and look; a read report shows none", async () => {
  const v = await load();
  const rows = v.reportRows({
    reports: ["new", "in_progress", "handed", "done", "read"].map((status, i) => ({
      ...base,
      id: ID(i + 1),
      created_at: 10 - i,
      status,
    })),
  });
  const marks = rows.map((r: unknown) => v.stateMark(r, false, () => {}) as Node_ | null);
  assert.deepEqual(
    marks.map((m: Node_ | null) => m && [m.textContent, m.className]),
    [
      ["tk.rep.new", "mb-row__ai"],
      ["tk.rep.inWork", "mb-row__ai tk-rv__work"],
      ["tk.rep.handedState", "mb-row__ai tk-rv__work"],
      ["tk.rep.doneState", "mb-row__ai tk-rv__done"],
      null,
    ]
  );
});

test("a Recall without status keeps the old rule; an unknown status or broken link is ignored", async () => {
  const v = await load();
  const [work, fresh, odd] = v.reportRows({
    reports: [
      { ...base, id: ID(1), notes_open: 1 },
      { ...base, id: ID(2), created_at: 9 },
      { ...base, id: ID(3), created_at: 8, status: "maybe", follow_up_of: { id: 7 } },
    ],
  });
  assert.equal(v.stateMark(work, false, () => {}).textContent, "tk.rep.inWork");
  assert.equal(v.stateMark(fresh, false, () => {}).textContent, "tk.rep.new");
  assert.equal(odd.status, null);
  assert.equal(odd.followUpOf, null);
  assert.equal(
    v.askedAbout(odd, () => {}),
    null
  );
});

test("Question jumps to the follow-up: a click on the list label, a button in the head", async () => {
  const v = await load();
  const [asked] = v.reportRows({
    reports: [{ ...base, id: ID(1), status: "question", follow_up: { id: ID(2), title: "Rückfrage Preise" } }],
  });
  const opened: string[] = [];
  const open = (id: string) => opened.push(id);
  const inList = v.stateMark(asked, false, open) as Node_;
  assert.equal(inList.tagName, "SPAN", "the row is a button already");
  assert.equal(inList.className, "mb-row__ai tk-rv__work tk-rv__ask");
  assert.equal(inList.attrs.title, 'tk.rep.questionTip {"t":"Rückfrage Preise"}');
  let stopped = false;
  for (const fn of inList.listeners.click ?? []) fn({ stopPropagation: () => (stopped = true) });
  assert.deepEqual(opened, [ID(2)]);
  assert.ok(stopped, "the row underneath does not open the report itself");
  const inHead = v.stateMark(asked, true, open) as Node_;
  assert.equal(inHead.tagName, "BUTTON");
  assert.ok(inHead.classList.contains("tk-rep__state"));
});

test("the follow-up's head names the report it asks about and leads back", async () => {
  const v = await load();
  const [followUp] = v.reportRows({
    reports: [{ ...base, id: ID(2), status: "new", follow_up_of: { id: ID(1), title: "Pulse: Entscheidungen" } }],
  });
  const opened: string[] = [];
  const back = v.askedAbout(followUp, (id: string) => opened.push(id)) as Node_;
  assert.equal(back.tagName, "BUTTON");
  assert.equal(back.textContent, 'tk.rep.askedAbout {"t":"Pulse: Entscheidungen"}');
  await back.click();
  assert.deepEqual(opened, [ID(1)]);
  assert.equal(followUp.followUp, null, "only a question carries a follow-up to jump to");
});

test("#1678: 'Outdated' is muted in list and head; a Recall without status shows it from the time alone", async () => {
  const v = await load();
  const [old, legacy] = v.reportRows({
    reports: [
      { ...base, id: ID(1), status: "outdated", outdated_at: 20 },
      { ...base, id: ID(2), created_at: 9, outdated_at: 20 },
    ],
  });
  const inList = v.stateMark(old, false, () => {}) as Node_;
  assert.equal(inList.textContent, "tk.rep.outdated");
  assert.equal(inList.className, "mb-row__ai tk-rv__old");
  assert.equal(inList.attrs.title, "tk.rep.outdatedTip");
  const inHead = v.stateMark(old, true, () => {}) as Node_;
  assert.equal(inHead.className, "mb-row__ai tk-rv__old tk-rep__state");
  assert.equal(v.stateMark(legacy, false, () => {}).textContent, "tk.rep.outdated");
});
