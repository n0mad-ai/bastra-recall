// The task client of the web UI: a local browser session (csrf), task_<op> calls,
// one session renewal after 401/403/unauthorized, readable errors, and mutate().
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

type Reply = { status?: number; body?: unknown };
type Call = { path: string; csrf?: string; body: unknown };

async function client(replies: Record<string, Reply[]>) {
  const source = await readFile(new URL("../webui/app/js/sections/tasks-api.js", import.meta.url), "utf8");
  const calls: Call[] = [];
  let sessions = 0;
  const fetch = async (path: string, options: any) => {
    calls.push({ path, csrf: options.headers["x-bastra-task-csrf"], body: JSON.parse(options.body) });
    if (path === "/ui/tasks/session") {
      sessions += 1;
      return { ok: true, status: 200, json: async () => ({ csrf: `csrf-${sessions}` }) };
    }
    const reply = replies[path]?.shift() ?? { body: {} };
    const status = reply.status ?? 200;
    return { ok: status < 400, status, json: async () => reply.body };
  };
  const strings: Record<string, string> = { "tk.err.generic": "generic", "tk.err.conflict": "conflict text" };
  const m = runInNewContext(source.replace(/^import .*;$/gm, "").replace(/^export /gm, "") + "\n({ api, mutate })", {
    t: (key: string) => strings[key] ?? key,
    LANG: "en",
    Intl,
    Date,
    localStorage: undefined,
    fetch,
  });
  return { ...m, calls };
}

test("web UI tasks client: opens a session once and sends its csrf with every call", async () => {
  const c = await client({ "/ui/tasks/api/task_list": [{ body: { tasks: [1] } }, { body: { tasks: [2] } }] });
  assert.deepEqual(await c.api("list", { limit: 5 }), { tasks: [1] });
  assert.deepEqual(await c.api("list"), { tasks: [2] });
  assert.deepEqual(
    c.calls.map((x: Call) => [x.path, x.csrf, x.body]),
    [
      ["/ui/tasks/session", undefined, {}],
      ["/ui/tasks/api/task_list", "csrf-1", { limit: 5 }],
      ["/ui/tasks/api/task_list", "csrf-1", {}],
    ]
  );
});

for (const [label, reply] of [
  ["401", { status: 401, body: {} }],
  ["403", { status: 403, body: {} }],
  ["code unauthorized", { status: 400, body: { code: "unauthorized" } }],
] as const) {
  test(`web UI tasks client: renews the session once after ${label} and repeats the call`, async () => {
    const c = await client({ "/ui/tasks/api/task_get": [reply, { body: { id: "t1" } }] });
    assert.deepEqual(await c.api("get", { id: "t1" }), { id: "t1" });
    assert.deepEqual(
      c.calls.map((x: Call) => [x.path, x.csrf]),
      [
        ["/ui/tasks/session", undefined],
        ["/ui/tasks/api/task_get", "csrf-1"],
        ["/ui/tasks/session", undefined],
        ["/ui/tasks/api/task_get", "csrf-2"],
      ]
    );
  });
}

test("web UI tasks client: a second rejection after the renewal is an error, not a loop", async () => {
  const c = await client({
    "/ui/tasks/api/task_get": [
      { status: 401, body: {} },
      { status: 401, body: {} },
    ],
  });
  await assert.rejects(c.api("get", { id: "t1" }), { message: "generic", code: undefined });
  assert.equal(c.calls.filter((x: Call) => x.path === "/ui/tasks/api/task_get").length, 2);
  assert.equal(c.calls.filter((x: Call) => x.path === "/ui/tasks/session").length, 2);
});

test("web UI tasks client: daemon codes become readable errors, unknown codes the generic text", async () => {
  const c = await client({
    "/ui/tasks/api/task_pause": [
      { status: 409, body: { code: "conflict" } },
      { status: 500, body: { code: "boom" } },
    ],
  });
  await assert.rejects(c.api("pause", { id: "t1" }), { message: "conflict text", code: "conflict" });
  await assert.rejects(c.api("pause", { id: "t1" }), { message: "generic", code: "boom" });
  assert.equal(c.calls.filter((x: Call) => x.path === "/ui/tasks/session").length, 1, "no renewal for other errors");
});

test("web UI tasks client: mutate sends the operation with the revision it just read", async () => {
  const c = await client({
    "/ui/tasks/api/task_get": [{ body: { expected_revision: 7 } }],
    "/ui/tasks/api/task_snooze": [{ body: { ok: true } }],
  });
  assert.deepEqual(await c.mutate("t1", "snooze", { until: 5 }), { ok: true });
  assert.deepEqual(c.calls.at(-1)!.body, { id: "t1", expected_revision: 7, until: 5 });
});
