// Board fields of the v22 Aufgaben view (Daniel 12.11.2026): waits_on, source,
// agent_note, assignee. Area stays scope.name. All optional and backward compatible.
import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud, type TaskCrudOperation } from "../src/task-service.js";
import { readTaskStore, transactTaskStore } from "../src/task-store.js";
import { taskSchema } from "../src/task-schema.js";
import { taskTools } from "../src/task-transport.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-board-"));
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => 1000 };
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "agent", domains: ["personal"], role: "agent" });
  const call = (op: TaskCrudOperation, input: unknown) =>
    callTaskCrud(ctx, `Bearer ${agent.token}`, op, input) as Promise<any>;
  const input = {
    idempotency_key: "board",
    original_request: "Reply to Lena",
    goal: "Reply to Lena",
    resolution_condition: "Owner confirms",
    schedule: { kind: "instant", at: 5000 },
    timezone: "Europe/Madrid",
    scope: { kind: "personal", name: "carnexus" },
    owner_domains: ["personal"],
  };
  return { ctx, call, input };
}
const board = {
  waits_on: ["Antwort von Lena", "Preisliste"],
  source: { kind: "memory", ref: "carnexus-preise-q1" },
  agent_note: "Entwurf liegt bereit, ich warte auf die Zahlen.",
  assignee: "recall",
} as const;

test("create stores board fields; get and list return them; area is scope.name", async () => {
  const f = await fixture();
  const t = await f.call("task_create", { ...f.input, ...board });
  assert.deepEqual(t.waits_on, board.waits_on);
  assert.deepEqual(t.source, board.source);
  assert.equal(t.agent_note, board.agent_note);
  assert.equal(t.assignee, "recall");
  assert.equal(t.scope.name, "carnexus");
  const got = await f.call("task_get", { id: t.id });
  assert.deepEqual(
    [got.waits_on, got.source, got.agent_note, got.assignee],
    [board.waits_on, board.source, board.agent_note, "recall"]
  );
  const listed = (await f.call("task_list", {})).tasks[0];
  assert.deepEqual(listed.source, board.source);
  assert.equal(listed.assignee, "recall");
  const stored = (await readTaskStore(f.ctx.path)).tasks[0];
  assert.deepEqual(stored.waits_on, board.waits_on);
  assert.equal(stored.agent_note, board.agent_note);
});

test("tasks without board fields stay valid (rows written before the fields)", async () => {
  const f = await fixture();
  const t = await f.call("task_create", f.input);
  for (const k of ["waits_on", "source", "agent_note", "assignee"]) assert.equal(k in t, false, k);
  // An old row on disk: parse it exactly as stored.
  const row = (await readTaskStore(f.ctx.path)).tasks[0];
  assert.equal(taskSchema.safeParse(row).success, true);
  assert.equal(
    (await f.call("task_edit", { id: t.id, expected_revision: t.expected_revision, patch: { goal: "Reply soon" } }))
      .goal,
    "Reply soon"
  );
});

test("validation rejects unknown source kinds, bad assignees, empty and oversized values", async () => {
  const f = await fixture();
  for (const [i, bad] of (
    [
      { source: { kind: "slack", ref: "x" } },
      { source: { kind: "mail" } },
      { source: { kind: "mail", ref: "" } },
      { source: { kind: "mail", ref: "x", extra: 1 } },
      { assignee: "owner" },
      { agent_note: "" },
      { waits_on: [] },
      { waits_on: [""] },
      { waits_on: Array.from({ length: 21 }, (_, n) => `w${n}`) },
      { waits_on: ["x".repeat(257)] },
      { agent_note: "x".repeat(4097) },
    ] as unknown[]
  ).entries())
    await assert.rejects(
      f.call("task_create", { ...f.input, idempotency_key: `bad-${i}`, ...(bad as object) }),
      JSON.stringify(bad)
    );
  assert.equal((await readTaskStore(f.ctx.path)).tasks.length, 0);
});

test("hand over: task_edit assignee user ↔ recall keeps schedule, arming and generation", async () => {
  const f = await fixture();
  let t = await f.call("task_create", {
    ...f.input,
    arm: true,
    origin: { kind: "user-request", client: "test", session: "s", context: "c" },
  });
  assert.equal(t.armed, true);
  t = await f.call("task_edit", { id: t.id, expected_revision: t.expected_revision, patch: { assignee: "user" } });
  assert.equal(t.assignee, "user");
  assert.equal(t.armed, true);
  assert.equal(t.generation, 0);
  assert.equal(t.state, "pending");
  t = await f.call("task_edit", { id: t.id, expected_revision: t.expected_revision, patch: { assignee: "recall" } });
  assert.equal(t.assignee, "recall");
  assert.equal(t.generation, 0);
  assert.equal(t.history.at(-1).operation, "edit");
  t = await f.call("task_edit", { id: t.id, expected_revision: t.expected_revision, patch: { assignee: null } });
  assert.equal("assignee" in t, false);
});

test("edit sets and clears waits_on, source and agent_note; snooze survives", async () => {
  const f = await fixture();
  let t = await f.call("task_create", {
    ...f.input,
    arm: true,
    origin: { kind: "user-request", client: "test", session: "s", context: "c" },
  });
  t = await f.call("task_snooze", { id: t.id, expected_revision: t.expected_revision, until: 9000 });
  t = await f.call("task_edit", {
    id: t.id,
    expected_revision: t.expected_revision,
    patch: { waits_on: ["Freigabe"], source: { kind: "mail", ref: "<m1@example.com>" }, agent_note: "Notiz" },
  });
  assert.deepEqual(t.waits_on, ["Freigabe"]);
  assert.equal(t.source.kind, "mail");
  assert.equal(t.agent_note, "Notiz");
  assert.equal(t.state, "snoozed");
  assert.equal(t.snoozed_until, 9000);
  t = await f.call("task_edit", {
    id: t.id,
    expected_revision: t.expected_revision,
    patch: { waits_on: [], source: null, agent_note: null },
  });
  for (const k of ["waits_on", "source", "agent_note"]) assert.equal(k in t, false, k);
  assert.equal(t.state, "snoozed");
  await assert.rejects(
    f.call("task_edit", { id: t.id, expected_revision: t.expected_revision, patch: { assignee: "nobody" } })
  );
});

test("free text board fields are scrubbed like the goal", async () => {
  const f = await fixture();
  const t = await f.call("task_create", { ...f.input, agent_note: "ok\u0007 note", waits_on: ["a​b"] });
  assert.equal(t.agent_note, "ok note");
  assert.deepEqual(t.waits_on, ["ab"]);
});

test("existing store rows gain fields only through edits; others stay untouched", async () => {
  const f = await fixture();
  const a = await f.call("task_create", f.input),
    b = await f.call("task_create", { ...f.input, idempotency_key: "b", goal: "Other", original_request: "Other" });
  await f.call("task_edit", { id: a.id, expected_revision: a.expected_revision, patch: { assignee: "user" } });
  const s = await readTaskStore(f.ctx.path);
  assert.equal(s.tasks.find((x) => x.id === a.id)!.assignee, "user");
  assert.equal("assignee" in s.tasks.find((x) => x.id === b.id)!, false);
  // A store written by a build that wrote the field stays readable after a transaction.
  await transactTaskStore(f.ctx.path, undefined, () => {});
  assert.equal((await readTaskStore(f.ctx.path)).tasks.length, 2);
});

test("MCP input schemas advertise the board fields", () => {
  const props = (name: string) => (taskTools.find((x) => x.name === name)!.inputSchema as any).properties;
  for (const k of ["waits_on", "source", "agent_note", "assignee"]) {
    assert.ok(props("task_create")[k], `create ${k}`);
    assert.ok(props("task_edit").patch.properties[k], `edit ${k}`);
  }
});
