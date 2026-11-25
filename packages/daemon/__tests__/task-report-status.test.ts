// The one state a report shows in the owner's list (Daniel 18.11.2026): New, In progress, Handed
// over, Done, Question. Derivation rules as a table, the agent's sign-off (closing the last
// handed-over note marks the report read), and the follow-up link a question report carries.
import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import {
  asksOwner,
  questionCheck,
  reportStatus,
  type StatusNote,
  type StatusReport,
} from "../src/task-report-status.js";

type R = StatusReport & { notes: StatusNote[] };
const draft: StatusNote = { state: "open" };
const handed: StatusNote = { state: "open", handed_at: 5 };
const done: StatusNote = { state: "done", handed_at: 5 };
const ASK = "- Ship it now? [? Yes | No]";
const base = (extra: Partial<R> = {}): R => ({ id: "a", title: "A", body: "text", created_at: 1, notes: [], ...extra });
const followUp = (extra: Partial<R> = {}): R =>
  base({ id: "f", title: "F", body: ASK, created_at: 2, follow_up_of: "a", ...extra });

test("status: every derivation rule", () => {
  const rows: [string, R, R[], ReturnType<typeof reportStatus>][] = [
    ["unread, no notes → new", base(), [], { status: "new" }],
    ["read, no notes → read", base({ read_at: 3 }), [], { status: "read" }],
    ["a draft → in_progress", base({ notes: [draft, done] }), [], { status: "in_progress" }],
    ["a draft beside a handed note → in_progress", base({ notes: [draft, handed] }), [], { status: "in_progress" }],
    ["all handed, one open → handed", base({ notes: [handed, done] }), [], { status: "handed" }],
    ["all notes closed → done", base({ notes: [done] }), [], { status: "done" }],
    ["all closed, put back to unread → done", base({ notes: [done], read_at: undefined }), [], { status: "done" }],
    [
      "follow-up with a question → question",
      base({ notes: [done], read_at: 3 }),
      [followUp()],
      { status: "question", follow_up: { id: "f", title: "F" } },
    ],
    [
      "question without any notes on the report",
      base(),
      [followUp()],
      { status: "question", follow_up: { id: "f", title: "F" } },
    ],
    ["follow-up done → back to done", base({ notes: [done] }), [followUp({ notes: [done] })], { status: "done" }],
    [
      "follow-up handed over still asks",
      base({ notes: [done] }),
      [followUp({ notes: [handed] })],
      { status: "question", follow_up: { id: "f", title: "F" } },
    ],
    [
      "follow-up without answer options is no question",
      base({ notes: [done] }),
      [followUp({ body: "Just info." })],
      { status: "done" },
    ],
    [
      "a report about another one is no question here",
      base({ notes: [done] }),
      [followUp({ follow_up_of: "x" })],
      { status: "done" },
    ],
    ["own drafts come before a question", base({ notes: [draft] }), [followUp()], { status: "in_progress" }],
    ["handed notes come before a question", base({ notes: [handed] }), [followUp()], { status: "handed" }],
    [
      "the newest open follow-up is named",
      base(),
      [followUp(), followUp({ id: "g", title: "G", created_at: 9 })],
      { status: "question", follow_up: { id: "g", title: "G" } },
    ],
  ];
  for (const [name, report, others, want] of rows)
    assert.deepEqual(
      reportStatus(report, [report, ...others], (r) => r.notes),
      want,
      name
    );
});

test("#1657: a question stays until the whole chain of follow-ups is done", () => {
  // A ← B (asked, answered and signed off) ← C (asks, open): the issue's trace.
  const a = base({ notes: [done] });
  const b = followUp({ id: "b", title: "B", notes: [done] });
  const c = followUp({ id: "c", title: "C", created_at: 3, follow_up_of: "b" });
  const status = (r: R, all: R[]) => reportStatus(r, all, (x) => x.notes);
  assert.deepEqual(status(a, [a, b, c]), { status: "question", follow_up: { id: "c", title: "C" } });
  assert.deepEqual(status(b, [a, b, c]), { status: "question", follow_up: { id: "c", title: "C" } });
  const cDone = { ...c, notes: [done] };
  assert.deepEqual(status(a, [a, b, cDone]), { status: "done" }, "the chain is done");
  // A link without a question still carries the chain: A ← B (info only) ← C (asks).
  const info = followUp({ id: "b", title: "B", body: "Just info." });
  assert.deepEqual(status(a, [a, info, c]), { status: "question", follow_up: { id: "c", title: "C" } });
  // The outdated report's question is gone, but the active descendant still asks.
  const outdated = { ...b, outdated_at: 9 };
  assert.deepEqual(status(a, [a, outdated, c]), { status: "question", follow_up: { id: "c", title: "C" } });
  assert.deepEqual(status(a, [a, outdated, cDone]), { status: "done" });
  // An open direct follow-up is named before one further down.
  const open = followUp({ id: "d", title: "D", created_at: 1 });
  assert.deepEqual(status(a, [a, b, c, open]), { status: "question", follow_up: { id: "d", title: "D" } });
  // Three steps down.
  const e = followUp({ id: "e", title: "E", created_at: 4, follow_up_of: "c" });
  assert.deepEqual(status(a, [a, b, cDone, e]), { status: "question", follow_up: { id: "e", title: "E" } });
});

test("#1657: a circle in a damaged store ends", () => {
  const x = base({ id: "x", follow_up_of: "y", notes: [done] });
  const y = followUp({ id: "y", title: "Y", follow_up_of: "x", notes: [done] });
  const self = base({ id: "s", follow_up_of: "s", body: ASK });
  assert.deepEqual(
    reportStatus(x, [x, y], (r) => r.notes),
    { status: "done" }
  );
  assert.deepEqual(
    reportStatus(self, [self], (r) => r.notes),
    { status: "new" }
  );
});

test("#1678: outdated wins over every other state; an outdated follow-up asks nothing", () => {
  const old = { outdated_at: 9 };
  const rows: [string, R, R[], ReturnType<typeof reportStatus>][] = [
    ["unread → outdated", base(old), [], { status: "outdated" }],
    ["read → outdated", base({ ...old, read_at: 3 }), [], { status: "outdated" }],
    ["drafts → outdated", base({ ...old, notes: [draft] }), [], { status: "outdated" }],
    ["handed notes → outdated", base({ ...old, notes: [handed] }), [], { status: "outdated" }],
    ["all done → outdated", base({ ...old, notes: [done] }), [], { status: "outdated" }],
    ["an open question → outdated", base(old), [followUp()], { status: "outdated" }],
    ["the only asking follow-up outdated → no question", base({ read_at: 3 }), [followUp(old)], { status: "read" }],
    ["… and with closed notes → done", base({ notes: [done] }), [followUp(old)], { status: "done" }],
    [
      "an outdated newer follow-up leaves the older open one named",
      base(),
      [followUp(), followUp({ ...old, id: "g", title: "G", created_at: 9 })],
      { status: "question", follow_up: { id: "f", title: "F" } },
    ],
  ];
  for (const [name, report, others, want] of rows)
    assert.deepEqual(
      reportStatus(report, [report, ...others], (r) => r.notes),
      want,
      name
    );
});

test("#1678: through the store, outdating the follow-up takes its parent out of question", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-report-outdated-"));
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => 5 };
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "claude", domains: ["personal"], role: "agent" });
  const call = (op: string, input: unknown) => callTaskCrud(ctx, `Bearer ${agent.token}`, op as any, input) as any;
  const origin = { client: "codex" };
  const parent = await call("task_report_save", { title: "A", body: "text", origin });
  const asking = await call("task_report_save", { title: "F", body: ASK, origin, follow_up_of: parent.id });
  const status = async (id: string) => (await call("task_report_read", { id })).status;
  assert.equal(await status(parent.id), "question");
  await call("task_report_mark", { id: asking.id, outdated: true });
  assert.equal(await status(parent.id), "new");
  assert.equal(await status(asking.id), "outdated");
  await call("task_report_mark", { id: asking.id, outdated: false });
  assert.equal(await status(parent.id), "question", "cleared, it asks again");
});

test("status: questions are recognised by the fixed syntax, never by words", () => {
  const rows: [string, boolean][] = [
    [ASK, true],
    ["Paragraph line one\nWhich one? [? A | B | C ]  ", true],
    ["Frage? [? Ja | Nein]", true],
    ["Ship it? [? Yes]", false],
    ["Ship it? [? Yes | Yes]", false],
    ["[? Yes | No]", false],
    ["Ship it? [? Yes | No] and more", false],
    [`Ship it? [? ${"x".repeat(121)} | No]`, false],
    ["Ship it? [? A | B | C | D | E | F | G]", false],
    ["Should we ship it? Yes or no?", false],
    ["## Ship it? [? Yes | No]", false],
    // a lone pipe line is no table: the reader shows it as a paragraph that asks (#1656: one contract)
    ["| Ship it? [? Yes | No]", true],
  ];
  for (const [body, want] of rows) assert.equal(asksOwner(body), want, body);
});

test("#1656: an option longer than the reader's 120 characters asks nothing, as in the reader", () => {
  // the trace from the issue: report A, then follow-up B whose only marker has a too long option
  const a = base({ notes: [done], read_at: 3 });
  const long = followUp({ body: `Frage? [? ${"x".repeat(121)} | Nein]` });
  assert.deepEqual(
    reportStatus(a, [a, long], (r) => r.notes),
    { status: "done" }
  );
  const fits = followUp({ body: `Frage? [? ${"x".repeat(120)} | Nein]` });
  assert.equal(reportStatus(a, [a, fits], (r) => r.notes).status, "question", "120 characters still ask");
});

test("Daniel 25.11.2026: questionCheck counts the questions and names every marker read as text", () => {
  const body = [
    "# Report",
    "**Deine Antwort:** [? A – Bei der Messung mitzählen, dann entscheiden | B – Nicht weiter verfolgen]",
    "- Ship it? [? Yes | No]",
    "[? Yes | No]",
    "Ship it? [? Yes | No].",
    "Ship it? [? a | b | c | d | e | f | g]",
    "Ship it? [? Yes]",
    "Ship it? [? A – list [old] | B – new]",
    "Ship it? [? **Yes** | No]",
    "## Ship it? [? Yes | No]",
    "",
    "| Q | A |",
    "|---|---|",
    "| Ship it? | [? Yes | No] |",
    "",
    "Literal \\[? Yes | No] and `[? code]` stay quiet",
    "First question [? Yes] and second question [? Yes | No]",
    "Read the Matrix[?a|b]",
    "```",
    "[? in code | stays quiet]",
    "```",
  ].join("\n");
  const { asks, unread } = questionCheck(body);
  // #1718: the line's last marker asks, its earlier one is named; #1717: a joined marker is named
  assert.equal(asks, 3);
  assert.deepEqual(unread, [
    "[? Yes | No]",
    "Ship it? [? Yes | No].",
    "Ship it? [? a | b | c | d | e | f | g]",
    "Ship it? [? Yes]",
    "Ship it? [? A – list [old] | B – new]",
    "Ship it? [? **Yes** | No]",
    "## Ship it? [? Yes | No]",
    "Ship it? | [? Yes | No]",
    "First question [? Yes] and second question [? Yes | No]",
    "Read the Matrix[?a|b]",
  ]);
});

test("#1656/#1652: code and an escaped marker stay text for the status as in the reader", () => {
  const rows: [string, boolean][] = [
    ["```\nShip it? [? Yes | No]\n```", false],
    ["```\ncode\n```\nShip it? [? Yes | No]", true],
    ["Ship it? `[? Yes | No]`", false],
    ["Ship it? [? `Yes` | No]", false],
    ["Literal \\[? Yes | No]", false],
    ["- Literal \\[? Yes | No]", false],
    ["- [? Yes | No]", false],
  ];
  for (const [body, want] of rows) assert.equal(asksOwner(body), want, body);
});

test("#1665/#1662: indented code and an indented fence are code for the status, list text is not", () => {
  const ask = "Ship it? [? Yes | No]";
  const rows: [string, boolean][] = [
    [`Text\n\n    ${ask}`, false],
    [`    ${ask}`, false],
    [`Text\n\n\t${ask}`, false],
    [`Text\n\n    code\n\n    ${ask}`, false],
    [`- step\n  \`\`\`\n  ${ask}\n  \`\`\``, false],
    [`   \`\`\`\n${ask}\n   \`\`\``, false],
    // not code: right under a paragraph, inside a list, after the code
    [`Text\n    ${ask}`, true],
    [`- item\n\n    ${ask}`, true],
    [`1. item\n    ${ask}`, true],
    [`Text\n\n    code\n${ask}`, true],
    [`Text\n\n  ${ask}`, true],
  ];
  for (const [body, want] of rows) assert.equal(asksOwner(body), want, body);
});

test("#1665: the prose around a pipe table is read in the reader's pieces", () => {
  const ask = "Ship it? [? Yes | No]",
    table = "| a | b |\n|---|---|\n| 1 | 2 |";
  const rows: [string, boolean][] = [
    // the reader starts a new piece under the table, so the indented line is code there
    [`Intro\n\n${table}\n    ${ask}`, false],
    [`- item\n${table.replace(/^/gm, "  ")}\n\n    ${ask}`, false],
    [`${table}\n${ask}`, true],
    [`Intro\n\n${table}\n\n- ${ask}`, true],
  ];
  for (const [body, want] of rows) assert.equal(asksOwner(body), want, body);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-report-status-"));
  let now = 1_000;
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => now };
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "claude", domains: ["personal"], role: "agent" });
  const other = await mintTaskCredential(ctx.authPath, { actor_id: "other", domains: ["other"], role: "agent" });
  const auth = `Bearer ${agent.token}`;
  const owner = (op: string, input: unknown) =>
    callTaskCrud({ ...ctx, ownerUi: true }, auth, op as any, input) as Promise<any>;
  const agentCall = (op: string, input: unknown, authorization = auth) =>
    callTaskCrud(ctx, authorization, op as any, input) as Promise<any>;
  const save = (extra: Record<string, unknown> = {}, authorization = auth) =>
    agentCall(
      "task_report_save",
      { title: "Bericht", body: "## Ergebnis\n\n- Punkt eins\n", origin: { client: "claude-code" }, ...extra },
      authorization
    );
  const note = (id: string, index = 1) =>
    owner("task_report_note_add", {
      id,
      anchor: { kind: "item", index, excerpt: "Punkt eins" },
      text: "Bitte prüfen.",
    });
  const list = async (call = owner) => {
    const answer = await call("task_report_list", {});
    return { ...answer, byId: (id: string) => answer.reports.find((r: any) => r.id === id) };
  };
  return { save, note, owner, agentCall, list, other: `Bearer ${other.token}`, setNow: (v: number) => (now = v) };
}

test("sign-off: closing the last handed-over note marks the report read; the list says done", async () => {
  const f = await fixture();
  const report = await f.save();
  assert.equal((await f.list()).byId(report.id).status, "new");
  const first = (await f.note(report.id)).note;
  const second = (await f.note(report.id, 2)).note;
  assert.equal((await f.list()).byId(report.id).status, "in_progress");
  await f.owner("task_report_notes_hand", { id: report.id });
  assert.equal((await f.list()).byId(report.id).status, "handed");
  assert.equal((await f.agentCall("task_report_read", { id: report.id })).status, "handed");

  f.setNow(2_000);
  await f.agentCall("task_report_note_done", { id: report.id, note_id: first.id });
  let listed = await f.list();
  assert.equal(listed.byId(report.id).status, "handed", "one note is still open");
  assert.equal(listed.byId(report.id).read_at, undefined, "no sign-off before the last note");
  assert.equal(listed.unread, 1);

  f.setNow(3_000);
  const closed = await f.agentCall("task_report_note_done", { id: report.id, note_id: second.id, reply: "erledigt" });
  assert.equal(closed.report.read_at, 3_000, "the last note is the sign-off");
  listed = await f.list();
  assert.equal(listed.byId(report.id).status, "done");
  assert.equal(listed.unread, 0, "a signed-off report no longer counts as unread");
});

test("sign-off: an earlier read time stays; an owner's draft still shows in progress", async () => {
  const f = await fixture();
  const report = await f.save();
  await f.owner("task_report_mark", { id: report.id, read: true });
  const handedNote = (await f.note(report.id)).note;
  await f.owner("task_report_notes_hand", { id: report.id });
  await f.note(report.id, 2); // a new draft beside the handed-over note
  f.setNow(5_000);
  const closed = await f.agentCall("task_report_note_done", { id: report.id, note_id: handedNote.id });
  assert.equal(closed.report.read_at, 1_000, "the first read time is kept");
  assert.equal((await f.list()).byId(report.id).status, "in_progress", "the owner is still writing");
  assert.equal((await f.list(f.agentCall)).byId(report.id).status, "done", "an agent never hears of drafts");
});

test("sign-off: only handed-over notes; an agent can neither close a draft nor write a note", async () => {
  const f = await fixture();
  const report = await f.save();
  const draftNote = (await f.note(report.id)).note;
  await assert.rejects(f.agentCall("task_report_note_done", { id: report.id, note_id: draftNote.id }), {
    code: "not_found",
  });
  await assert.rejects(
    f.agentCall("task_report_note_add", {
      id: report.id,
      anchor: { kind: "item", index: 1, excerpt: "Punkt eins" },
      text: "von einem Agenten",
    }),
    { code: "forbidden" }
  );
  await assert.rejects(
    f.agentCall("task_report_note_done", { id: report.id, note_id: "00000000-0000-4000-8000-000000000000" }),
    { code: "not_found" }
  );
  await assert.rejects(
    f.agentCall("task_report_note_done", { id: "00000000-0000-4000-8000-000000000000", note_id: draftNote.id }),
    { code: "not_found" }
  );
  const listed = await f.list();
  assert.equal(listed.byId(report.id).status, "in_progress");
  assert.equal(listed.byId(report.id).read_at, undefined);
});

test("follow-up: the link must name a report the agent sees; it is kept and shown both ways", async () => {
  const f = await fixture();
  const original = await f.save();
  await assert.rejects(f.save({ follow_up_of: "00000000-0000-4000-8000-000000000000" }), { code: "not_found" });
  await assert.rejects(f.save({ follow_up_of: original.id }, f.other), { code: "not_found" }, "other domains");
  await assert.rejects(f.save({ follow_up_of: "kein-bericht" }), { name: "ZodError" });
  assert.equal((await f.list()).reports.length, 1, "nothing stored on a refused link");

  const ask = await f.save({ title: "Rückfrage", body: `Kurz erklärt.\n\n${ASK}\n`, follow_up_of: original.id });
  const listed = await f.list();
  assert.deepEqual(listed.byId(original.id).follow_up, { id: ask.id, title: "Rückfrage" });
  assert.equal(listed.byId(original.id).status, "question");
  assert.deepEqual(listed.byId(ask.id).follow_up_of, { id: original.id, title: "Bericht" });
  assert.equal(listed.byId(ask.id).status, "new", "the follow-up shows its own state");
  assert.deepEqual((await f.owner("task_report_read", { id: ask.id })).follow_up_of, {
    id: original.id,
    title: "Bericht",
  });
});

test("follow-up: answered and signed off, the original falls back to done", async () => {
  const f = await fixture();
  const original = await f.save();
  const n = (await f.note(original.id)).note;
  await f.owner("task_report_notes_hand", { id: original.id });
  await f.agentCall("task_report_note_done", { id: original.id, note_id: n.id });
  assert.equal((await f.list()).byId(original.id).status, "done");

  const ask = await f.save({ title: "Rückfrage", body: `${ASK}\n`, follow_up_of: original.id });
  assert.equal((await f.list()).byId(original.id).status, "question");
  // The owner answers on the follow-up's question and hands it over; the agent signs off.
  const answer = (
    await f.owner("task_report_note_add", {
      id: ask.id,
      anchor: { kind: "item", index: 1, excerpt: "Ship it now?" },
      text: "Yes",
    })
  ).note;
  await f.owner("task_report_notes_hand", { id: ask.id });
  assert.equal((await f.list()).byId(original.id).status, "question", "handed over, not signed off yet");
  await f.agentCall("task_report_note_done", { id: ask.id, note_id: answer.id });
  const listed = await f.list();
  assert.equal(listed.byId(original.id).status, "done");
  assert.equal(listed.byId(original.id).follow_up, undefined);
  assert.equal(listed.byId(ask.id).status, "done");
  assert.equal(listed.unread, 0);
});

test("follow-up: a chain never loops, and a deleted original only drops the link from answers", async () => {
  const f = await fixture();
  const a = await f.save({ title: "A" });
  const b = await f.save({ title: "B", body: `${ASK}\n`, follow_up_of: a.id });
  const c = await f.save({ title: "C", body: `${ASK}\n`, follow_up_of: b.id });
  let listed = await f.list();
  assert.equal(listed.byId(a.id).follow_up.id, b.id);
  assert.equal(listed.byId(b.id).follow_up.id, c.id);
  assert.equal(listed.byId(c.id).status, "new");
  await f.owner("task_report_delete", { id: a.id });
  listed = await f.list();
  assert.equal(listed.byId(b.id).follow_up_of, undefined, "the gone report is not named");
  assert.equal(listed.byId(b.id).status, "question");
});

test("Daniel 25.11.2026: task_report_save hints at unread markers and more than 20 questions, and stores anyway", async () => {
  const f = await fixture();
  const clean = await f.save({ body: "- Ship it? [? Yes | No]\n\nLater?\n\n[? Yes | No]" });
  assert.equal(clean.hints, undefined, "a report the reader reads fully carries no hints");
  const broken = await f.save({ body: "[? Yes | No]\n- Later? [? Yes | Yes]" });
  assert.equal(broken.hints.length, 3);
  assert.match(broken.hints[0], /plain text without answer buttons: "\[\? Yes \| No\]"/);
  assert.match(broken.hints[1], /"- Later\? \[\? Yes \| Yes\]"/);
  assert.match(broken.hints[2], /2-6 different options of at most 120 characters/);
  const mixed = await f.save({ body: "First question [? Yes] and second question [? Yes | No]" });
  assert.equal(mixed.hints.length, 2, "#1718: the earlier marker is named although the line asks");
  assert.match(mixed.hints[0], /"First question \[\? Yes\] and second question \[\? Yes \| No\]"/);
  const many = await f.save({ body: Array.from({ length: 21 }, (_, i) => `- Q${i}? [? Yes | No]`).join("\n") });
  assert.deepEqual(many.hints, [
    "21 questions with answer options; keep at most 20 per report and put the rest in a part 2.",
  ]);
  const twenty = await f.save({ body: Array.from({ length: 20 }, (_, i) => `- Q${i}? [? Yes | No]`).join("\n") });
  assert.equal(twenty.hints, undefined);
  const ids = (await f.list()).reports.map((r: any) => r.id);
  for (const r of [clean, broken, mixed, many, twenty]) assert.ok(ids.includes(r.id), "every report is stored");
});
