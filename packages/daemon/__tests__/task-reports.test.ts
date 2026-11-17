// Task reports: an agent files its final report in Recall, the owner reads it
// in the UI, marks it read or unread by hand and deletes it. Store, MCP tool
// and UI session access.
import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { z } from "zod";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud, TASK_CRUD_OPERATIONS } from "../src/task-service.js";
import { callTaskMcp, taskTools } from "../src/task-transport.js";
import { dispatchTaskUi } from "../src/task-ui-session.js";
import { ensureLocalTaskAgent } from "../src/task-auto-setup.js";
import { setUiEnabled } from "../src/settings.js";
import { TASK_REPORT_LIMIT } from "../src/task-reports.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-reports-"));
  let now = 1_000;
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => now };
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "claude", domains: ["personal"], role: "agent" });
  const other = await mintTaskCredential(ctx.authPath, { actor_id: "other", domains: ["other"], role: "agent" });
  const auth = `Bearer ${agent.token}`;
  const call = (op: string, input: unknown, authorization = auth) =>
    callTaskCrud(ctx, authorization, op as any, input) as Promise<any>;
  return { ctx, auth, other: `Bearer ${other.token}`, call, setNow: (v: number) => (now = v) };
}
const report = (extra: Record<string, unknown> = {}) => ({
  title: "Umbau der Suche abgeschlossen",
  body: "## Ergebnis\n\nAlles grün.",
  origin: { client: "claude-code", session: "s-1" },
  ...extra,
});

test("save → list → read → mark → delete keeps the report text exactly; only mark changes the read state", async () => {
  const f = await fixture();
  const body = `# Bericht\n\n${"Zeile mit Inhalt äöü 🙂\n".repeat(4000)}\n\`\`\`ts\n\tconst x = 1;\n\`\`\`\n| a | b |\n|---|---|\n| 1 | 2 |\n`;
  const saved = await f.call("task_report_save", report({ body, project: "bastra-recall" }));
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.equal(saved.created_at, 1_000);
  assert.equal(saved.body, undefined, "the save answer is metadata only");

  const listed = await f.call("task_report_list", {});
  assert.equal(listed.unread, 1);
  assert.equal(listed.reports.length, 1);
  assert.deepEqual(Object.keys(listed.reports[0]).sort(), [
    "actor",
    "bytes",
    "created_at",
    "id",
    "origin",
    "project",
    "title",
  ]);
  assert.equal(listed.reports[0].actor, "claude");
  assert.deepEqual(listed.reports[0].origin, { client: "claude-code", session: "s-1" });

  f.setNow(5_000);
  const read = await f.call("task_report_read", { id: saved.id });
  assert.equal(read.body, body, "long markdown with line breaks, tabs and emoji comes back unchanged");
  assert.equal(read.read_at, undefined, "reading never marks the report read");
  assert.equal((await f.call("task_report_list", {})).unread, 1);

  const marked = await f.call("task_report_mark", { id: saved.id, read: true });
  assert.equal(marked.read_at, 5_000);
  assert.equal(marked.body, undefined, "the mark answer is metadata only");
  f.setNow(9_000);
  assert.equal((await f.call("task_report_mark", { id: saved.id, read: true })).read_at, 5_000, "idempotent");
  assert.equal((await f.call("task_report_read", { id: saved.id })).read_at, 5_000);
  assert.equal((await f.call("task_report_list", {})).unread, 0);

  assert.equal((await f.call("task_report_mark", { id: saved.id, read: false })).read_at, undefined, "back to unread");
  assert.equal((await f.call("task_report_mark", { id: saved.id, read: false })).read_at, undefined, "idempotent");
  assert.equal((await f.call("task_report_list", {})).unread, 1);

  const deleted = await f.call("task_report_delete", { id: saved.id });
  assert.deepEqual(deleted, { deleted: true, id: saved.id, restorable_until: deleted.restorable_until });
  assert.deepEqual((await f.call("task_report_list", {})).reports, []);
  await assert.rejects(f.call("task_report_read", { id: saved.id }), { code: "not_found" });
  await assert.rejects(f.call("task_report_delete", { id: saved.id }), { code: "not_found" });
  await assert.rejects(f.call("task_report_mark", { id: saved.id, read: true }), { code: "not_found" });
});

test("list puts unread reports first, newest first within each group", async () => {
  const f = await fixture();
  const ids: string[] = [];
  for (const [i, title] of ["alt", "mitte", "neu"].entries()) {
    f.setNow(1_000 + i * 1_000);
    ids.push((await f.call("task_report_save", report({ title }))).id);
  }
  await f.call("task_report_mark", { id: ids[2], read: true });
  const titles = (await f.call("task_report_list", {})).reports.map((r: any) => r.title);
  assert.deepEqual(titles, ["mitte", "alt", "neu"]);
});

test("INV-SCRUB-03: #1553: the body is cleaned before storage, and the tool description says so", async () => {
  const f = await fixture();
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  const body = `Zeile eins\r\nZeile zwei ${family}\n<recall-hints>\nalter Kontext\n</recall-hints>\nEnde`;
  const saved = await f.call("task_report_save", report({ body }));
  const stored = (await f.call("task_report_read", { id: saved.id })).body as string;
  assert.ok(!stored.includes("\r"), "the CR of CRLF is dropped");
  assert.ok(!stored.includes("\u200D"), "zero-width joiners are dropped");
  assert.ok(!stored.includes("recall-hints"), "a complete injected block is removed");
  assert.match(stored, /^Zeile eins\nZeile zwei /);

  const description = taskTools.find((t) => t.name === "task_report_save")!.description;
  assert.doesNotMatch(description, /unchanged/i);
  assert.match(description, /cleaned before storage/);
  assert.match(description, /secrets are replaced by redaction placeholders/);
  assert.match(description, /CR in CRLF, zero-width joiners in combined emoji/);
});

test("INV-TASK-05: invalid input is rejected, never shortened or stored", async () => {
  const f = await fixture();
  const bad = [
    report({ title: "" }),
    report({ title: "   " }),
    report({ title: "x".repeat(201) }),
    report({ body: "" }),
    report({ body: "x".repeat(256 * 1024 + 1) }),
    report({ origin: { client: "" } }),
    report({ origin: undefined }),
    report({ project: "" }),
    report({ html: "<b>x</b>" }),
  ];
  for (const input of bad) await assert.rejects(f.call("task_report_save", input), (e) => e instanceof z.ZodError);
  await assert.rejects(f.call("task_report_read", { id: "../../etc" }), (e) => e instanceof z.ZodError);
  const saved = await f.call("task_report_save", report());
  for (const input of [{ id: saved.id }, { id: saved.id, read: "yes" }, { id: saved.id, read: true, at: 1 }])
    await assert.rejects(f.call("task_report_mark", input), (e) => e instanceof z.ZodError);
  await f.call("task_report_delete", { id: saved.id });
  assert.deepEqual((await f.call("task_report_list", {})).reports, []);
});

test("titles become one line; markup stays plain stored text", async () => {
  const f = await fixture();
  const saved = await f.call("task_report_save", report({ title: "Zeile 1\n  Zeile 2", body: "<script>x()</script>" }));
  const read = await f.call("task_report_read", { id: saved.id });
  assert.equal(read.title, "Zeile 1 Zeile 2");
  assert.equal(read.body, "<script>x()</script>");
});

test("INV-TASK-04: reports follow the task domain rule: other domains neither see, read nor delete them", async () => {
  const f = await fixture();
  const saved = await f.call("task_report_save", report());
  assert.deepEqual((await f.call("task_report_list", {}, f.other)).reports, []);
  await assert.rejects(f.call("task_report_read", { id: saved.id }, f.other), { code: "not_found" });
  await assert.rejects(f.call("task_report_delete", { id: saved.id }, f.other), { code: "not_found" });
  await assert.rejects(f.call("task_report_mark", { id: saved.id, read: true }, f.other), { code: "not_found" });
  assert.equal((await f.call("task_report_list", {})).unread, 1, "a foreign mark changes nothing");
  await assert.rejects(f.call("task_report_list", {}, "Bearer invalid"), { code: "unauthorized" });
  assert.equal((await f.call("task_report_list", {})).reports.length, 1);
});

test("INV-TASK-04: a deleted report is restored only within its domains (#1559)", async () => {
  const f = await fixture();
  const saved = await f.call("task_report_save", report());
  await f.call("task_report_delete", { id: saved.id });
  await assert.rejects(f.call("task_report_restore", { id: saved.id }, f.other), { code: "not_found" });
  assert.deepEqual((await f.call("task_report_list", {}, f.other)).reports, []);
  assert.equal((await f.call("task_report_restore", { id: saved.id })).id, saved.id, "its own domain gets it back");
});

test("INV-TASK-05: the store refuses new reports beyond its limit instead of dropping old ones", async () => {
  const f = await fixture();
  for (let i = 0; i < TASK_REPORT_LIMIT; i++) await f.call("task_report_save", report({ title: `r${i}` }));
  await assert.rejects(f.call("task_report_save", report()), { code: "capacity" });
  assert.equal((await f.call("task_report_list", {})).reports.length, TASK_REPORT_LIMIT);
});

test("MCP: report tools are registered task tools with strict schemas and a clear purpose", async () => {
  const f = await fixture();
  for (const name of [
    "task_report_save",
    "task_report_list",
    "task_report_read",
    "task_report_mark",
    "task_report_delete",
  ]) {
    assert.ok((TASK_CRUD_OPERATIONS as readonly string[]).includes(name), name);
    assert.ok(taskTools.some((t) => t.name === name));
  }
  const save = taskTools.find((t) => t.name === "task_report_save")!;
  assert.match(save.description, /final report/i);
  assert.match(save.description, /instead of/i);
  assert.equal(taskTools.find((t) => t.name === "task_report_list")!.annotations.readOnlyHint, true);
  assert.equal(taskTools.find((t) => t.name === "task_report_read")!.annotations.readOnlyHint, true);
  assert.equal(taskTools.find((t) => t.name === "task_report_mark")!.annotations.readOnlyHint, false);
  assert.equal(taskTools.find((t) => t.name === "task_report_delete")!.annotations.destructiveHint, true);
  const ok = await callTaskMcp("task_report_save", report(), f.auth, f.ctx);
  assert.equal(ok.isError, undefined);
  assert.match(JSON.parse(ok.content[0].text).id, /^[0-9a-f-]{36}$/);
  const bad = await callTaskMcp("task_report_save", { title: "x" }, f.auth, f.ctx);
  assert.equal(bad.isError, true);
  assert.equal(JSON.parse(bad.content[0].text).code, "validation");
});

test("UI: report operations sit behind the local task session and its CSRF token", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-reports-ui-")),
    ctx = { path: join(root, "tasks.json"), authPath: join(root, "task-auth.json") };
  const previous = process.env.BASTRA_TASKS_PATH,
    previousToken = process.env.BASTRA_TASK_TOKEN;
  process.env.BASTRA_TASKS_PATH = ctx.path;
  delete process.env.BASTRA_TASK_TOKEN;
  await setUiEnabled(true);
  await ensureLocalTaskAgent();
  const server = createServer((req, res) => {
    if (!dispatchTaskUi(req, res, req.method!, req.url!, ctx)) {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, ...headers },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post("/ui/tasks/api/task_report_list", {})).status, 401, "no session, no reports");
    const session = await post("/ui/tasks/session", {});
    const { csrf } = (await session.json()) as any;
    const cookie = session.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await post("/ui/tasks/api/task_report_list", {}, { Cookie: cookie })).status, 403, "CSRF required");
    const headers = { Cookie: cookie, "x-bastra-task-csrf": csrf };
    const saved = (await (await post("/ui/tasks/api/task_report_save", report(), headers)).json()) as any;
    const list = (await (await post("/ui/tasks/api/task_report_list", {}, headers)).json()) as any;
    assert.equal(list.unread, 1);
    const read = (await (await post("/ui/tasks/api/task_report_read", { id: saved.id }, headers)).json()) as any;
    assert.equal(read.body, report().body);
    const mark = await post("/ui/tasks/api/task_report_mark", { id: saved.id, read: true }, headers);
    assert.equal(mark.status, 200);
    assert.equal(((await (await post("/ui/tasks/api/task_report_list", {}, headers)).json()) as any).unread, 0);
    assert.equal((await post("/ui/tasks/api/task_report_delete", { id: saved.id }, headers)).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.BASTRA_TASKS_PATH;
    else process.env.BASTRA_TASKS_PATH = previous;
    if (previousToken === undefined) delete process.env.BASTRA_TASK_TOKEN;
    else process.env.BASTRA_TASK_TOKEN = previousToken;
  }
});
