// Task reports: undo for delete (#1559) and the search over the report text
// (#1597). A deleted report waits RESTORE_WINDOW_MS outside the report store;
// task_report_restore brings it back with text, read state and notes, within
// the report limit. task_report_list takes an optional query.
import "./tasks-opt-in.js";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud, TASK_CRUD_OPERATIONS } from "../src/task-service.js";
import { taskTools } from "../src/task-transport.js";
import { RESTORE_WINDOW_MS, TASK_REPORT_LIMIT } from "../src/task-reports.js";
import { readAppRecord, writeAppRecord } from "../src/app-record-store.js";
import { mutateSettings } from "../src/settings-file.js";
import { applySettingChanges, parseSettingValue, settingEntry } from "../src/settings-registry.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-report-undo-"));
  let now = 1_000;
  const ctx = {
    path: join(root, "tasks.json"),
    authPath: join(root, "auth.json"),
    settingsPath: join(root, "settings.json"),
    now: () => now,
  };
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "claude", domains: ["personal"], role: "agent" });
  const other = await mintTaskCredential(ctx.authPath, { actor_id: "other", domains: ["other"], role: "agent" });
  const auth = `Bearer ${agent.token}`;
  const call = (op: string, input: unknown, authorization = auth) =>
    callTaskCrud({ ...ctx, ownerUi: true }, authorization, op as any, input) as Promise<any>;
  const trash = () => JSON.parse(readAppRecord("task-report-trash", join(root, "task-report-trash.json")));
  const undoSetting = (value: string) =>
    mutateSettings(ctx.settingsPath, (current) => applySettingChanges(current, { "tasks.reportUndo": value }));
  const agentCall = (op: string, input: unknown) => callTaskCrud(ctx, auth, op as any, input) as Promise<any>;
  return {
    ctx,
    root,
    call,
    agentCall,
    trash,
    undoSetting,
    other: `Bearer ${other.token}`,
    setNow: (v: number) => (now = v),
  };
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

test("#1559: a full trash refuses a new delete without losing a report or a promised undo", async () => {
  const f = await fixture();
  const first = randomUUID();
  const second = randomUUID();
  const notes = Array.from({ length: 720 }, () => ({
    id: randomUUID(),
    anchor: { kind: "item", index: 1, excerpt: "Preise prüfen" },
    text: "字".repeat(4000),
    actor: "claude",
    created_at: 1_000,
    state: "open",
  }));
  const path = join(f.root, "task-reports.json");
  const seed = (id: string) =>
    writeAppRecord(
      "task-reports",
      path,
      JSON.stringify({
        version: 1,
        reports: [{ ...report(), id, actor: "claude", created_at: 1_000, owner_domains: ["personal"], notes }],
      })
    );

  // Each report fits on its own; the trash cannot hold both at once.
  seed(first);
  const gone = await f.call("task_report_delete", { id: first });
  assert.equal(gone.restorable_until, 1_000 + RESTORE_WINDOW_MS);
  seed(second);
  f.setNow(2_000);

  await assert.rejects(f.call("task_report_delete", { id: second }), { code: "capacity" });
  assert.equal((await f.call("task_report_list", {})).reports[0]?.id, second, "the new report stays active");
  assert.equal(f.trash().deleted[0]?.report.id, first, "the promised undo survives");
  await assert.rejects(f.call("task_report_restore", { id: first }), { code: "capacity" }, "the first entry is found");

  f.setNow(1_000 + RESTORE_WINDOW_MS);
  assert.equal((await f.call("task_report_delete", { id: second })).deleted, true, "expiry makes room");
  assert.equal((await f.call("task_report_restore", { id: second })).id, second);
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

test("#1597 compatibility forms and case are matched together in report text", async () => {
  const f = await fixture();
  const saved = await f.call("task_report_save", report({ body: "Results: 𝐏rices checked" }));
  const result = await f.call("task_report_list", { query: "prices" });
  assert.deepEqual(
    result.reports.map((row: { id: string }) => row.id),
    [saved.id]
  );
});

test("#1614: an expired undo entry leaves the disk on the next list or restore, not only on a delete", async () => {
  const f = await fixture();
  const text = "Expired report text";
  const a = await f.call("task_report_save", report({ title: "a", body: text }));
  await f.call("task_report_delete", { id: a.id });

  f.setNow(1_000 + RESTORE_WINDOW_MS - 1);
  await f.call("task_report_list", {});
  assert.equal(f.trash().deleted.length, 1, "inside its window the entry stays");

  f.setNow(1_000 + RESTORE_WINDOW_MS);
  await f.call("task_report_list", {});
  assert.deepEqual(f.trash().deleted, [], "a list drops the expired entry");
  assert.ok(!JSON.stringify(f.trash()).includes(text));

  const b = await f.call("task_report_save", report({ title: "b", body: text }));
  await f.call("task_report_delete", { id: b.id });
  f.setNow(1_000 + 2 * RESTORE_WINDOW_MS);
  await assert.rejects(f.call("task_report_restore", { id: b.id }), { code: "not_found" });
  assert.deepEqual(f.trash().deleted, [], "a refused restore drops the expired entry as well");
});

test("Daniel 18.11.2026: a deleted report stays in the owner's list with its time left; agents see no trash", async () => {
  const f = await fixture();
  const a = await f.call("task_report_save", report({ title: "a", project: "recall" }));
  const b = await f.call("task_report_save", report({ title: "b" }));
  await f.call("task_report_delete", { id: a.id });
  f.setNow(5_000);
  await f.call("task_report_delete", { id: b.id });
  const listed = await f.call("task_report_list", {});
  assert.deepEqual(
    listed.deleted.map((d: any) => [d.id, d.title, d.deleted_at, d.restorable_until]),
    [
      [b.id, "b", 5_000, 5_000 + RESTORE_WINDOW_MS],
      [a.id, "a", 1_000, 1_000 + RESTORE_WINDOW_MS],
    ],
    "newest delete first, each with its own end"
  );
  assert.equal(listed.deleted[1].project, "recall");
  assert.equal(listed.deleted[0].body, undefined, "list rows only, never the text");
  assert.equal((await f.call("task_report_list", {}, f.other)).deleted.length, 0, "the domain rule holds");
  assert.equal((await f.agentCall("task_report_list", {})).deleted, undefined, "an agent's list is unchanged");
  assert.equal((await f.call("task_report_list", { query: "a" })).deleted, undefined, "a search lists no trash");
  f.setNow(1_000 + RESTORE_WINDOW_MS);
  assert.deepEqual(
    (await f.call("task_report_list", {})).deleted.map((d: any) => d.id),
    [b.id],
    "an expired delete leaves the list"
  );
});

test("N13: tasks.reportUndo sets the undo window in minutes, hours or days, or turns undo off", async () => {
  assert.equal(settingEntry("tasks.reportUndo")?.default, "10m");
  for (const ok of ["off", "1m", "90m", "2h", "30d", " 3D "])
    assert.doesNotThrow(() => parseSettingValue("tasks.reportUndo", ok));
  for (const bad of ["0m", "31d", "721h", "10", "1.5h", "10s", "-1m", "", 10, "on", "10 m"])
    assert.throws(() => parseSettingValue("tasks.reportUndo", bad), `${JSON.stringify(bad)} is refused`);

  const f = await fixture();
  await f.undoSetting("2h");
  const a = await f.call("task_report_save", report());
  const gone = await f.call("task_report_delete", { id: a.id });
  assert.equal(gone.restorable_until, 1_000 + 2 * 3_600_000);
  f.setNow(1_000 + 3_600_000);
  assert.equal((await f.call("task_report_restore", { id: a.id })).id, a.id, "an hour later it still comes back");

  await f.undoSetting("off");
  const off = await f.call("task_report_delete", { id: a.id });
  assert.deepEqual(off, { deleted: true, id: a.id }, "off: no undo is promised");
  assert.deepEqual(f.trash().deleted, [], "and nothing is kept");
  await assert.rejects(f.call("task_report_restore", { id: a.id }), { code: "not_found" });
  assert.deepEqual((await f.call("task_report_list", {})).deleted, []);
});
