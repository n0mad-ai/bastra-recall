// Task reports: undo for delete (#1559) and the search over the report text
// (#1597). A deleted report waits RESTORE_WINDOW_MS outside the report store;
// task_report_restore brings it back with text, read state and notes, within
// the report limit. task_report_list takes an optional query.
import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud, TASK_CRUD_OPERATIONS } from "../src/task-service.js";
import { taskTools } from "../src/task-transport.js";
import { RESTORE_WINDOW_MS, TASK_REPORT_LIMIT } from "../src/task-reports.js";
import { readAppRecord } from "../src/app-record-store.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-report-undo-"));
  let now = 1_000;
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => now };
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "claude", domains: ["personal"], role: "agent" });
  const other = await mintTaskCredential(ctx.authPath, { actor_id: "other", domains: ["other"], role: "agent" });
  const auth = `Bearer ${agent.token}`;
  const call = (op: string, input: unknown, authorization = auth) =>
    callTaskCrud({ ...ctx, ownerUi: true }, authorization, op as any, input) as Promise<any>;
  const trash = () => JSON.parse(readAppRecord("task-report-trash", join(root, "task-report-trash.json")));
  return { ctx, root, call, trash, other: `Bearer ${other.token}`, setNow: (v: number) => (now = v) };
}
const report = (extra: Record<string, unknown> = {}) => ({
  title: "Umbau der Suche abgeschlossen",
  body: "## Ergebnis\n\n- Preise prüfen\n",
  origin: { client: "claude-code", session: "s-1" },
  ...extra,
});

test("#1559: delete → restore brings the report back with its text, read state and notes", async () => {
  const f = await fixture();
  const saved = await f.call("task_report_save", report({ project: "recall" }));
  await f.call("task_report_mark", { id: saved.id, read: true });
  const anchor = { kind: "item", index: 1, excerpt: "Preise prüfen" };
  await f.call("task_report_note_add", { id: saved.id, anchor, text: "Bitte nochmal" });
  await f.call("task_report_notes_hand", { id: saved.id });
  const before = await f.call("task_report_read", { id: saved.id });

  f.setNow(2_000);
  const gone = await f.call("task_report_delete", { id: saved.id });
  assert.deepEqual(gone, { deleted: true, id: saved.id, restorable_until: 2_000 + RESTORE_WINDOW_MS });
  assert.deepEqual((await f.call("task_report_list", {})).reports, [], "a deleted report is neither listed …");
  await assert.rejects(f.call("task_report_read", { id: saved.id }), { code: "not_found" }, "… nor read");

  const back = await f.call("task_report_restore", { id: saved.id });
  assert.equal(back.id, saved.id);
  assert.equal(back.read_at, before.read_at);
  assert.deepEqual(await f.call("task_report_read", { id: saved.id }), before);
  assert.deepEqual(f.trash().deleted, [], "the trash entry leaves once the report is back");
  await assert.rejects(f.call("task_report_restore", { id: saved.id }), { code: "not_found" }, "only once");
});

test("#1559: the undo window ends; a later restore is refused and the next delete drops the expired entry", async () => {
  const f = await fixture();
  const a = await f.call("task_report_save", report({ title: "a" }));
  const b = await f.call("task_report_save", report({ title: "b" }));
  await f.call("task_report_delete", { id: a.id });
  f.setNow(1_000 + RESTORE_WINDOW_MS);
  await assert.rejects(f.call("task_report_restore", { id: a.id }), { code: "not_found" });
  await f.call("task_report_delete", { id: b.id });
  assert.deepEqual(
    f.trash().deleted.map((d: any) => d.report.id),
    [b.id],
    "deleted report data does not outlive its window"
  );
  f.setNow(1_000 + RESTORE_WINDOW_MS + RESTORE_WINDOW_MS - 1);
  assert.equal((await f.call("task_report_restore", { id: b.id })).id, b.id, "b's own window still runs");
});

test("#1559: restore keeps the domain rule and the report limit; nothing is lost when it is refused", async () => {
  const f = await fixture();
  const saved = await f.call("task_report_save", report());
  await f.call("task_report_delete", { id: saved.id });
  await assert.rejects(f.call("task_report_restore", { id: saved.id }, f.other), { code: "not_found" });

  for (let i = 0; i < TASK_REPORT_LIMIT; i++) await f.call("task_report_save", report({ title: `r${i}` }));
  await assert.rejects(f.call("task_report_restore", { id: saved.id }), { code: "capacity" });
  assert.equal(f.trash().deleted.length, 1, "a refused restore keeps the report for a later try");
  const first = (await f.call("task_report_list", {})).reports[0];
  await f.call("task_report_delete", { id: first.id });
  assert.equal((await f.call("task_report_restore", { id: saved.id })).id, saved.id, "room again: it comes back");
});

test("#1559: restore is a task tool for agents; an invalid id is a validation error", async () => {
  const f = await fixture();
  assert.ok((TASK_CRUD_OPERATIONS as readonly string[]).includes("task_report_restore"));
  const tool = taskTools.find((t) => t.name === "task_report_restore")!;
  assert.match(tool.description, /undo/i);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.match(taskTools.find((t) => t.name === "task_report_delete")!.description, /restorable_until/);
  await assert.rejects(f.call("task_report_restore", { id: "x" }), (e) => e instanceof z.ZodError);
});

test("#1597: the list query searches title, project and text; every word, any case or Unicode form", async () => {
  const f = await fixture();
  const a = await f.call(
    "task_report_save",
    report({ title: "Release", project: "bastra-recall", body: "Die Prüfung der Preise ist offen." })
  );
  await f.call("task_report_save", report({ title: "Lint", body: "Alles grün." }));
  const ids = async (query: string) =>
    (await f.call("task_report_list", { query })).reports.map((r: any) => r.id) as string[];
  assert.deepEqual(await ids("PREISE"), [a.id], "a word only the text holds");
  assert.deepEqual(await ids("prüfung release"), [a.id], "words from text and title, decomposed form");
  assert.deepEqual(await ids("recall offen"), [a.id], "project and text");
  assert.deepEqual(await ids("preise grün"), [], "every word must occur in the same report");
  assert.equal((await ids("  ")).length, 2, "a blank query lists all");
  const listed = await f.call("task_report_list", { query: "preise" });
  assert.equal(listed.reports[0].body, undefined, "still metadata only");
  await assert.rejects(f.call("task_report_list", { query: "x".repeat(201) }), (e) => e instanceof z.ZodError);
});
