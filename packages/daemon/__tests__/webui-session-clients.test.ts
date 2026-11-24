// Characterization of the three session/CSRF consumers of the web UI (#1509):
// the shell's task client (js/data.js), the Tasks area client
// (js/sections/tasks-api.js) and the settings client (js/sections/settings-model.js).
// Every request is recorded with method, path, credentials, headers and body, in order, for:
// the first call without a session, an expired session renewed silently, a second rejection,
// parallel calls (without a session and during a renewal) and a network error.
// Each consumer keeps its own response policy; parallel calls share a sign-in per cookie (#1675).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

type Reply = { status?: number; body?: unknown; wait?: Promise<void> } | "network";
type Init = { method?: string; credentials?: string; headers?: Record<string, string>; body?: string };

const read = (path: string) => readFile(new URL(`../webui/app/js/${path}`, import.meta.url), "utf8");
const strip = (src: string) => src.replace(/^import .*;$/gm, "").replace(/^export /gm, "");
const source = async (...paths: string[]) =>
  (await Promise.all(["session-client.js", ...paths].map(read))).map(strip).join("\n");

/** A scripted daemon: replies per path in order; a session path without a script opens session n. */
function server(sessionPath: string, script: Record<string, Reply[]>) {
  const log: string[] = [];
  let sessions = 0;
  async function fetch(path: string, init: Init = {}) {
    log.push(
      [init.method ?? "-", path, init.credentials ?? "-", JSON.stringify(init.headers ?? {}), init.body ?? "-"].join(
        " "
      )
    );
    await Promise.resolve();
    const reply =
      script[path]?.shift() ?? (path === sessionPath ? { body: { csrf: `csrf-${++sessions}` } } : { body: {} });
    if (reply === "network") throw new TypeError("Failed to fetch");
    if (reply.wait) await reply.wait;
    const status = reply.status ?? 200;
    return { ok: status < 400, status, json: async () => reply.body };
  }
  return { fetch, log };
}

const failure = (err: unknown) => {
  const e = err as { constructor: { name: string }; message: string; code?: unknown; status?: unknown };
  return { type: e.constructor.name, message: e.message, code: e.code, status: e.status };
};
async function outcome(p: Promise<unknown>) {
  try {
    return { ok: await p };
  } catch (err) {
    return { error: failure(err) };
  }
}

// ── shell task client (data.js taskApi) ──────────────────────────────────────
async function shellClient(script: Record<string, Reply[]> = {}) {
  const s = server("/ui/tasks/session", script);
  const m = runInNewContext((await source("sections/tasks-reports-model.js", "data.js")) + "\n({ taskApi })", {
    fetch: s.fetch,
    document: { documentElement: { dataset: { tasksEnabled: "true" } }, hidden: false },
    JSON,
    Promise,
    Error,
    TypeError,
    Array,
    Number,
  });
  return { api: m.taskApi as (name: string, input?: unknown) => Promise<unknown>, log: s.log };
}

const SHELL_SESSION = 'POST /ui/tasks/session same-origin {"Content-Type":"application/json"} {}';
const shellCall = (name: string, csrf: string, body = "{}") =>
  `POST /ui/tasks/api/task_${name} same-origin {"Content-Type":"application/json","x-bastra-task-csrf":"${csrf}"} ${body}`;

test("shell task client: the first call opens one session and sends its csrf", async () => {
  const c = await shellClient({ "/ui/tasks/api/task_list": [{ body: { tasks: [] } }] });
  assert.deepEqual(await outcome(c.api("list", { limit: 5 })), { ok: { tasks: [] } });
  assert.deepEqual(c.log, [SHELL_SESSION, shellCall("list", "csrf-1", '{"limit":5}')]);
});

for (const status of [401, 403]) {
  test(`shell task client: ${status} renews the session once and repeats the call`, async () => {
    const c = await shellClient({ "/ui/tasks/api/task_list": [{}, { status }, { body: { tasks: [1] } }] });
    await c.api("list");
    assert.deepEqual(await outcome(c.api("list")), { ok: { tasks: [1] } });
    assert.deepEqual(c.log, [
      SHELL_SESSION,
      shellCall("list", "csrf-1"),
      shellCall("list", "csrf-1"),
      SHELL_SESSION,
      shellCall("list", "csrf-2"),
    ]);
  });
}

test("shell task client: a second rejection ends with 'task session expired'", async () => {
  const c = await shellClient({ "/ui/tasks/api/task_list": [{ status: 401 }, { status: 403 }] });
  assert.deepEqual(await outcome(c.api("list")), {
    error: { type: "Error", message: "task session expired", code: undefined, status: undefined },
  });
  assert.deepEqual(c.log, [SHELL_SESSION, shellCall("list", "csrf-1"), SHELL_SESSION, shellCall("list", "csrf-2")]);
});

test("shell task client: other refusals are not renewed, the code 'unauthorized' included", async () => {
  const c = await shellClient({
    "/ui/tasks/api/task_list": [
      { status: 400, body: { code: "unauthorized" } },
      { status: 500, body: {} },
    ],
  });
  assert.deepEqual(await outcome(c.api("list")), {
    error: { type: "Error", message: "task_list → 400", code: undefined, status: undefined },
  });
  assert.deepEqual(await outcome(c.api("list")), {
    error: { type: "Error", message: "task_list → 500", code: undefined, status: undefined },
  });
  assert.deepEqual(c.log, [SHELL_SESSION, shellCall("list", "csrf-1"), shellCall("list", "csrf-1")]);
});

test("shell task client: a refused or empty session answer is an error without a task call", async () => {
  const refused = await shellClient({ "/ui/tasks/session": [{ status: 500 }] });
  assert.deepEqual(await outcome(refused.api("list")), {
    error: { type: "Error", message: "/ui/tasks/session → 500", code: undefined, status: undefined },
  });
  assert.deepEqual(refused.log, [SHELL_SESSION]);
  const empty = await shellClient({ "/ui/tasks/session": [{ body: {} }] });
  assert.deepEqual(await outcome(empty.api("list")), {
    error: { type: "Error", message: "no task session", code: undefined, status: undefined },
  });
  assert.deepEqual(empty.log, [SHELL_SESSION]);
});

test("shell task client: parallel calls without a session share one session request", async () => {
  const c = await shellClient({
    "/ui/tasks/api/task_list": [{ body: { tasks: [] } }],
    "/ui/tasks/api/task_report_list": [{ body: { reports: [] } }],
  });
  assert.deepEqual(await Promise.all([outcome(c.api("list")), outcome(c.api("report_list"))]), [
    { ok: { tasks: [] } },
    { ok: { reports: [] } },
  ]);
  assert.deepEqual(c.log, [SHELL_SESSION, shellCall("list", "csrf-1"), shellCall("report_list", "csrf-1")]);
});

test("shell task client: parallel calls rejected together share one renewal", async () => {
  const c = await shellClient({
    "/ui/tasks/api/task_list": [{}, { status: 401 }, { body: { tasks: [1] } }],
    "/ui/tasks/api/task_report_list": [{ status: 401 }, { body: { reports: [] } }],
  });
  await c.api("list");
  assert.deepEqual(await Promise.all([outcome(c.api("list")), outcome(c.api("report_list"))]), [
    { ok: { tasks: [1] } },
    { ok: { reports: [] } },
  ]);
  assert.deepEqual(c.log, [
    SHELL_SESSION,
    shellCall("list", "csrf-1"),
    shellCall("list", "csrf-1"),
    shellCall("report_list", "csrf-1"),
    SHELL_SESSION,
    shellCall("list", "csrf-2"),
    shellCall("report_list", "csrf-2"),
  ]);
});

test("shell task client: a network error is passed on unchanged and not repeated", async () => {
  const onCall = await shellClient({ "/ui/tasks/api/task_list": ["network"] });
  assert.deepEqual(await outcome(onCall.api("list")), {
    error: { type: "TypeError", message: "Failed to fetch", code: undefined, status: undefined },
  });
  assert.deepEqual(onCall.log, [SHELL_SESSION, shellCall("list", "csrf-1")]);
  const onSession = await shellClient({ "/ui/tasks/session": ["network"] });
  assert.deepEqual((await outcome(onSession.api("list"))).error?.type, "TypeError");
  assert.deepEqual(onSession.log, [SHELL_SESSION]);
});

// ── Tasks area client (sections/tasks-api.js api) ────────────────────────────
async function tasksClient(script: Record<string, Reply[]> = {}) {
  const s = server("/ui/tasks/session", script);
  const strings: Record<string, string> = {
    "tk.err.generic": "generic",
    "tk.err.offline": "offline text",
    "tk.err.conflict": "conflict text",
  };
  const m = runInNewContext((await source("sections/tasks-api.js")) + "\n({ api })", {
    t: (key: string) => strings[key] ?? key,
    LANG: "en",
    Intl,
    Date,
    localStorage: undefined,
    fetch: s.fetch,
  });
  return { api: m.api as (name: string, input?: unknown) => Promise<unknown>, log: s.log };
}

const TASKS_SESSION = 'POST /ui/tasks/session same-origin {"Content-Type":"application/json"} {}';
const tasksCall = shellCall; // same request shape as the shell client

test("tasks area client: the first call opens one session and sends its csrf", async () => {
  const c = await tasksClient({ "/ui/tasks/api/task_list": [{ body: { tasks: [] } }] });
  assert.deepEqual(await outcome(c.api("list", { limit: 5 })), { ok: { tasks: [] } });
  assert.deepEqual(c.log, [TASKS_SESSION, tasksCall("list", "csrf-1", '{"limit":5}')]);
});

for (const [label, reply] of [
  ["401", { status: 401, body: {} }],
  ["403", { status: 403, body: {} }],
  ["code unauthorized", { status: 400, body: { code: "unauthorized" } }],
] as const) {
  test(`tasks area client: ${label} renews the session once and repeats the call`, async () => {
    const c = await tasksClient({ "/ui/tasks/api/task_list": [{}, reply, { body: { tasks: [1] } }] });
    await c.api("list");
    assert.deepEqual(await outcome(c.api("list")), { ok: { tasks: [1] } });
    assert.deepEqual(c.log, [
      TASKS_SESSION,
      tasksCall("list", "csrf-1"),
      tasksCall("list", "csrf-1"),
      TASKS_SESSION,
      tasksCall("list", "csrf-2"),
    ]);
  });
}

test("tasks area client: a second rejection ends with the daemon code and its text (generic here)", async () => {
  const c = await tasksClient({
    "/ui/tasks/api/task_list": [
      { status: 401, body: {} },
      { status: 403, body: { code: "unauthorized" } },
    ],
  });
  assert.deepEqual(await outcome(c.api("list")), {
    error: { type: "Error", message: "generic", code: "unauthorized", status: undefined },
  });
  assert.deepEqual(c.log, [TASKS_SESSION, tasksCall("list", "csrf-1"), TASKS_SESSION, tasksCall("list", "csrf-2")]);
});

test("tasks area client: a refused session answer is the offline text without a task call", async () => {
  const c = await tasksClient({ "/ui/tasks/session": [{ status: 500, body: {} }] });
  assert.deepEqual(await outcome(c.api("list")), {
    error: { type: "Error", message: "offline text", code: "offline", status: undefined },
  });
  assert.deepEqual(c.log, [TASKS_SESSION]);
});

test("tasks area client: parallel calls without a session share one session request", async () => {
  const c = await tasksClient({
    "/ui/tasks/api/task_list": [{ body: { tasks: [] } }],
    "/ui/tasks/api/task_get": [{ body: { id: "t1" } }],
  });
  assert.deepEqual(await Promise.all([outcome(c.api("list")), outcome(c.api("get", { id: "t1" }))]), [
    { ok: { tasks: [] } },
    { ok: { id: "t1" } },
  ]);
  assert.deepEqual(c.log, [TASKS_SESSION, tasksCall("list", "csrf-1"), tasksCall("get", "csrf-1", '{"id":"t1"}')]);
});

test("tasks area client: parallel calls rejected together share one renewal", async () => {
  const c = await tasksClient({
    "/ui/tasks/api/task_list": [{}, { status: 401, body: {} }, { body: { tasks: [1] } }],
    "/ui/tasks/api/task_get": [{ status: 401, body: {} }, { body: { id: "t1" } }],
  });
  await c.api("list");
  assert.deepEqual(await Promise.all([outcome(c.api("list")), outcome(c.api("get", { id: "t1" }))]), [
    { ok: { tasks: [1] } },
    { ok: { id: "t1" } },
  ]);
  assert.deepEqual(c.log, [
    TASKS_SESSION,
    tasksCall("list", "csrf-1"),
    tasksCall("list", "csrf-1"),
    tasksCall("get", "csrf-1", '{"id":"t1"}'),
    TASKS_SESSION,
    tasksCall("list", "csrf-2"),
    tasksCall("get", "csrf-2", '{"id":"t1"}'),
  ]);
});

test("tasks area client: a delayed rejection reuses the session already renewed by a peer", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const c = await tasksClient({
    "/ui/tasks/api/task_list": [{}, { status: 401, body: {} }, { body: { tasks: [1] } }],
    "/ui/tasks/api/task_get": [{ status: 401, body: {}, wait }, { body: { id: "t1" } }],
  });
  await c.api("list");
  const delayed = c.api("get", { id: "t1" });
  assert.deepEqual(await outcome(c.api("list")), { ok: { tasks: [1] } });
  release();
  assert.deepEqual(await outcome(delayed), { ok: { id: "t1" } });
  assert.equal(c.log.filter((call) => call === TASKS_SESSION).length, 2);
  assert.equal(c.log.at(-1), tasksCall("get", "csrf-2", '{"id":"t1"}'));
});

test("tasks area client: a network error is passed on unchanged and not repeated", async () => {
  const onCall = await tasksClient({ "/ui/tasks/api/task_list": ["network"] });
  assert.deepEqual(await outcome(onCall.api("list")), {
    error: { type: "TypeError", message: "Failed to fetch", code: undefined, status: undefined },
  });
  assert.deepEqual(onCall.log, [TASKS_SESSION, tasksCall("list", "csrf-1")]);
  const onSession = await tasksClient({ "/ui/tasks/session": ["network"] });
  assert.deepEqual((await outcome(onSession.api("list"))).error?.type, "TypeError");
  assert.deepEqual(onSession.log, [TASKS_SESSION]);
});

// ── settings client (sections/settings-model.js withSession + call) ─────────
async function settingsClient(script: Record<string, Reply[]> = {}) {
  const s = server("/ui/settings/session", script);
  const m = runInNewContext((await source("sections/settings-model.js")) + "\n({ settingsApi })", {
    state: {},
    setState: () => {},
    t: (key: string) => key,
    setBackdrop: () => {},
    fetch: s.fetch,
    JSON,
    Object,
    Error,
    TypeError,
    Array,
    Set,
    Map,
    Promise,
  });
  const get = (path: string) => m.settingsApi(path) as Promise<unknown>;
  return { get, log: s.log };
}

const SETTINGS_SESSION = 'POST /ui/settings/session same-origin {"Content-Type":"application/json"} {}';
const settingsGet = (path: string, csrf: string) =>
  `- ${path} same-origin {"Content-Type":"application/json","X-Bastra-Settings-CSRF":"${csrf}"} -`;

test("settings client: the first call opens one session and sends its csrf", async () => {
  const c = await settingsClient({ "/ui/settings": [{ body: { entries: [] } }] });
  assert.deepEqual(await outcome(c.get("/ui/settings")), { ok: { entries: [] } });
  assert.deepEqual(c.log, [SETTINGS_SESSION, settingsGet("/ui/settings", "csrf-1")]);
});

test("settings client: 401 renews the session once and repeats the call", async () => {
  const c = await settingsClient({ "/ui/settings": [{}, { status: 401, body: {} }, { body: { entries: [1] } }] });
  await c.get("/ui/settings");
  assert.deepEqual(await outcome(c.get("/ui/settings")), { ok: { entries: [1] } });
  assert.deepEqual(c.log, [
    SETTINGS_SESSION,
    settingsGet("/ui/settings", "csrf-1"),
    settingsGet("/ui/settings", "csrf-1"),
    SETTINGS_SESSION,
    settingsGet("/ui/settings", "csrf-2"),
  ]);
});

test("settings client: 403 is not renewed and keeps the session", async () => {
  const c = await settingsClient({ "/ui/settings": [{ status: 403, body: { error: "forbidden", code: "csrf" } }, {}] });
  assert.deepEqual(await outcome(c.get("/ui/settings")), {
    error: { type: "Error", message: "forbidden", code: "csrf", status: 403 },
  });
  await c.get("/ui/settings");
  assert.deepEqual(c.log, [
    SETTINGS_SESSION,
    settingsGet("/ui/settings", "csrf-1"),
    settingsGet("/ui/settings", "csrf-1"),
  ]);
});

test("settings client: a second rejection ends with the daemon text or the HTTP status", async () => {
  const c = await settingsClient({
    "/ui/settings": [
      { status: 401, body: {} },
      { status: 401, body: null },
    ],
  });
  assert.deepEqual(await outcome(c.get("/ui/settings")), {
    error: { type: "Error", message: "HTTP 401", code: undefined, status: 401 },
  });
  assert.deepEqual(c.log, [
    SETTINGS_SESSION,
    settingsGet("/ui/settings", "csrf-1"),
    SETTINGS_SESSION,
    settingsGet("/ui/settings", "csrf-2"),
  ]);
});

test("settings client: a refused or empty session answer is an error without the call", async () => {
  const refused = await settingsClient({ "/ui/settings/session": [{ status: 500, body: { error: "down" } }] });
  assert.deepEqual(await outcome(refused.get("/ui/settings")), {
    error: { type: "Error", message: "down", code: undefined, status: 500 },
  });
  assert.deepEqual(refused.log, [SETTINGS_SESSION]);
  const empty = await settingsClient({ "/ui/settings/session": [{ body: {} }] });
  assert.deepEqual(await outcome(empty.get("/ui/settings")), {
    error: { type: "Error", message: "no settings session", code: undefined, status: undefined },
  });
  assert.deepEqual(empty.log, [SETTINGS_SESSION]);
});

test("settings client: parallel calls without a session share one session request", async () => {
  const c = await settingsClient({
    "/ui/settings": [{ body: { entries: [] } }],
    "/ui/settings/models": [{ body: { models: [] } }],
  });
  assert.deepEqual(await Promise.all([outcome(c.get("/ui/settings")), outcome(c.get("/ui/settings/models"))]), [
    { ok: { entries: [] } },
    { ok: { models: [] } },
  ]);
  assert.deepEqual(c.log, [
    SETTINGS_SESSION,
    settingsGet("/ui/settings", "csrf-1"),
    settingsGet("/ui/settings/models", "csrf-1"),
  ]);
});

test("settings client: parallel calls rejected together share one renewal", async () => {
  const c = await settingsClient({
    "/ui/settings": [{}, { status: 401, body: {} }, { body: { entries: [1] } }],
    "/ui/settings/models": [{ status: 401, body: {} }, { body: { models: [] } }],
  });
  await c.get("/ui/settings");
  assert.deepEqual(await Promise.all([outcome(c.get("/ui/settings")), outcome(c.get("/ui/settings/models"))]), [
    { ok: { entries: [1] } },
    { ok: { models: [] } },
  ]);
  assert.deepEqual(c.log, [
    SETTINGS_SESSION,
    settingsGet("/ui/settings", "csrf-1"),
    settingsGet("/ui/settings", "csrf-1"),
    settingsGet("/ui/settings/models", "csrf-1"),
    SETTINGS_SESSION,
    settingsGet("/ui/settings", "csrf-2"),
    settingsGet("/ui/settings/models", "csrf-2"),
  ]);
});

test("settings client: a network error is passed on unchanged and not repeated", async () => {
  const onCall = await settingsClient({ "/ui/settings": ["network"] });
  assert.deepEqual(await outcome(onCall.get("/ui/settings")), {
    error: { type: "TypeError", message: "Failed to fetch", code: undefined, status: undefined },
  });
  assert.deepEqual(onCall.log, [SETTINGS_SESSION, settingsGet("/ui/settings", "csrf-1")]);
  const onSession = await settingsClient({ "/ui/settings/session": ["network"] });
  assert.deepEqual((await outcome(onSession.get("/ui/settings"))).error?.type, "TypeError");
  assert.deepEqual(onSession.log, [SETTINGS_SESSION]);
});
