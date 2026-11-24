// Web UI tasks area (js/sections/tasks-store.js with tasks-api.js and the
// proposal pop-over of tasks-overlays.js): characterization of what the browser
// does when the owner executes a prepared change, drops a task on the calendar
// or board, and when the local task session expires around a write. These are
// the promises the old UI's task-owner-ui.test.ts held (#1219, #1402) carried
// over to today's modules. The real modules run in one VM context against a
// fake daemon; no browser, no network, no running daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { Node_, h } from "./webui-report-dom.js";

/** The web UI folder. The only place this file names it (rename: #1572). */
const WEBUI = new URL("../webui/app/js/", import.meta.url);

const read = (path: string) => readFile(new URL(path, WEBUI), "utf8");
const strip = (source: string) => source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");

type Call = { name: string; csrf?: string; input: any };
type Reply = { status?: number; body?: unknown };
type Handler = (input: any) => Reply | undefined;

const TZ = "Europe/Berlin";
const task = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  goal: "Synthetic reminder",
  state: "pending",
  armed: true,
  action_level: "notify",
  schedule: { kind: "instant", at: Date.UTC(2030, 0, 1, 8) },
  timezone: TZ,
  deliveries: [],
  ...over,
});
const snapshot = (tasks: unknown[]) => ({ role: "owner", tasks, intents: [], receipts: [] });

/**
 * Fake daemon: POST /ui/tasks/session hands out csrf-<n>; `expire()` makes the
 * next task call answer 401 (cookie gone after a daemon restart); `denySession()`
 * makes renewals fail. `on[name]` answers task_<name>.
 */
async function store(tasks: unknown[] = [task()], on: Record<string, Handler> = {}) {
  const source = (
    await Promise.all(
      ["session-client.js", "sections/tasks-api.js", "sections/tasks-store.js", "sections/tasks-overlays.js"].map(read)
    )
  )
    .map(strip)
    .join("\n");
  const calls: Call[] = [];
  const toasts: Array<{ text: string; tone?: string }> = [];
  let sessions = 0,
    expired = false,
    denied = false,
    uuid = 0;
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
  const fetch = async (path: string, init: any) => {
    if (path === "/ui/tasks/session") {
      sessions++;
      if (denied) return json(403, { code: "unauthorized" });
      expired = false;
      return json(200, { csrf: `csrf-${sessions}` });
    }
    const name = path.replace("/ui/tasks/api/task_", "");
    const input = JSON.parse(init.body);
    calls.push({ name, csrf: init.headers["x-bastra-task-csrf"], input });
    if (expired) return json(401, {});
    const reply =
      on[name]?.(input) ??
      (name === "status"
        ? { body: snapshot(tasks) }
        : name === "get"
          ? { body: { expected_revision: `rev-${calls.length}` } }
          : { body: {} });
    return json(reply.status ?? 200, reply.body);
  };
  const m = runInNewContext(
    `${source}\n({ S, refresh, act, lifecycle, moveTo, moveDue, create, showProposal, executeProposal, overlays })`,
    {
      h,
      loadingInline: () => h("span", null),
      t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
      LANG: "en",
      state: { vw: 1600 },
      setState: (patch: { toast?: { text: string; tone?: string } }) => {
        if (patch.toast) toasts.push(structuredClone(patch.toast));
      },
      touched: () => null,
      setBusy() {},
      openMemoryBrowser() {},
      document: { querySelector: () => null, activeElement: null },
      localStorage: undefined,
      crypto: { randomUUID: () => `uuid-${++uuid}` },
      fetch,
      Intl,
      Date,
      JSON,
      Number,
    }
  );
  await m.refresh();
  calls.length = 0;
  return {
    m,
    calls,
    toasts,
    names: () => calls.map((c) => c.name),
    sessions: () => sessions,
    expire: () => (expired = true),
    denySession: () => (denied = true),
  };
}

const PROPOSAL = {
  proposal: { id: "p1", task_id: "t1", status: "ready" },
  preview: { before: "old", after: "new" },
  approved: true,
  binding_status: "current",
};
const LEASE = { lease: { id: "l1", fence: 7 }, holder_token: "holder-secret" };

// ── executing a prepared change ─────────────────────────────────────────────

test("execute: reserves once, executes with that reservation and releases exactly its own holder after a failure", async () => {
  const s = await store([task()], {
    lease: () => ({ body: LEASE }),
    execute: () => ({ status: 409, body: { code: "approval_stale" } }),
  });
  await s.m.showProposal(PROPOSAL);
  await s.m.executeProposal();
  assert.deepEqual(s.names(), ["lease", "execute", "release"]);
  assert.deepEqual(s.calls[0].input, { proposal_id: "p1" });
  assert.deepEqual(s.calls[1].input, {
    proposal_id: "p1",
    lease_id: "l1",
    holder_token: "holder-secret",
    fence: 7,
    idempotency_key: "uuid-1",
  });
  assert.deepEqual(s.calls[2].input, { lease_id: "l1", holder_token: "holder-secret", fence: 7 });
  assert.deepEqual(s.toasts.at(-1), { text: "tk.err.generic", tone: "error" });
  assert.equal(s.m.S.propNote, "", "a failed run shows no result line");
});

test("execute: a refused reservation neither executes nor releases anything", async () => {
  const s = await store([task()], { lease: () => ({ status: 409, body: { code: "conflict" } }) });
  await s.m.showProposal(PROPOSAL);
  await s.m.executeProposal();
  assert.deepEqual(s.names(), ["lease"]);
  assert.equal(s.toasts.at(-1)?.tone, "error");
});

test("execute: success shows the outcome, rereads the board and still releases its holder", async () => {
  const s = await store([task()], {
    lease: () => ({ body: LEASE }),
    execute: () => ({ body: { state: "succeeded", intent_id: "i1", receipt: { id: "r1" } } }),
  });
  await s.m.showProposal(PROPOSAL);
  await s.m.executeProposal();
  assert.deepEqual(s.names(), ["lease", "execute", "status", "release"]);
  assert.equal(s.calls[3].input.holder_token, "holder-secret");
  assert.match(s.m.S.propNote, /tk\.prop\.result/);
  assert.match(s.m.S.propNote, /"receipt":"r1"/);
});

/** Browser click: a disabled button does not fire. */
async function click(node: Node_) {
  if (node.disabled || "disabled" in node.attrs) return;
  await Promise.all((node.listeners.click ?? []).map((fn) => fn({ currentTarget: node })));
}
const runButton = (nodes: Node_[]) =>
  nodes.flatMap((n) => [n, ...n.all()]).find((n) => n.classList.contains("tk-pop__go"))!;

test("execute: a double click on the run button starts one reservation and one execution", async () => {
  let leased = 0;
  const s = await store([task()], {
    lease: () => ({ body: { ...LEASE, lease: { id: `l${++leased}`, fence: leased } } }),
    execute: () => ({ status: 409, body: { code: "approval_stale" } }),
  });
  await s.m.showProposal(PROPOSAL);
  const button = runButton(s.m.overlays());
  await Promise.all([click(button), click(button)]);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.names().filter((n) => n === "lease").length, 1);
  assert.equal(s.names().filter((n) => n === "execute").length, 1);
  assert.equal(button.disabled, true);
});

test("execute: after a completed run the re-rendered button stays disabled and starts no second run (#1651)", async () => {
  const s = await store([task()], {
    lease: () => ({ body: LEASE }),
    execute: () => ({ body: { state: "succeeded", intent_id: "i1", receipt: { id: "r1" } } }),
  });
  await s.m.showProposal(PROPOSAL);
  await click(runButton(s.m.overlays()));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.names(), ["lease", "execute", "status", "release"], "the first run releases its own holder");
  // The outcome line changes the overlay signature: the dialog is rebuilt.
  const rebuilt = runButton(s.m.overlays());
  assert.equal(rebuilt.attrs.disabled, "true");
  await click(rebuilt);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.names().filter((n) => n === "lease").length, 1, "no second reservation");
  assert.equal(s.names().filter((n) => n === "execute").length, 1, "no second execution");
});

test("execute: the run button is disabled while the change is not approved or its binding is not current", async () => {
  const s = await store();
  for (const data of [
    { ...PROPOSAL, approved: false },
    { ...PROPOSAL, binding_status: "retired" },
  ]) {
    await s.m.showProposal(data);
    const button = runButton(s.m.overlays());
    await click(button);
    assert.equal(button.attrs.disabled, "true");
  }
  await s.m.showProposal({ ...PROPOSAL, proposal: { ...PROPOSAL.proposal, status: "stale" } });
  assert.equal(runButton(s.m.overlays()), undefined, "a stale proposal offers no run button");
  assert.deepEqual(s.names(), []);
});

// ── calendar drop (moveDue) and board drop (moveTo) ─────────────────────────

const FUTURE = Date.UTC(2031, 4, 6, 7, 30); // 09:30 in Berlin (CEST), whole minute
for (const [label, over, at, msg] of [
  ["an archived task", { archived: true, archive_id: "a1" }, FUTURE, "tk.msg.noDrop"],
  ["a finished task", { state: "resolved" }, FUTURE, "tk.msg.noDrop"],
  ["a cancelled task", { state: "cancelled" }, FUTURE, "tk.msg.noDrop"],
  ["an event-based task", { schedule: { kind: "event" } }, FUTURE, "tk.msg.noDrop"],
  ["a slot in the past", {}, -120000, "tk.msg.past"],
  ["a slot without a time", {}, Number.NaN, "tk.msg.past"],
] as const) {
  test(`calendar drop: ${label} calls no mutation and says why`, async () => {
    const s = await store([task(over)]);
    const id = s.m.S.items[0].id;
    const when = at < 0 ? Date.now() + at : at;
    assert.equal(s.m.moveDue(id, when), undefined, "no action started");
    assert.deepEqual(s.names(), []);
    assert.deepEqual(s.toasts, [{ text: msg, tone: undefined }]);
  });
}

test("calendar drop: an unknown card does nothing", async () => {
  const s = await store();
  assert.equal(s.m.moveDue("missing", FUTURE), undefined);
  assert.deepEqual(s.names(), []);
  assert.deepEqual(s.toasts, []);
});

test("calendar drop: a permitted drop rereads the revision and edits only the schedule, in the task's zone", async () => {
  const s = await store();
  await s.m.moveDue("t1", FUTURE);
  assert.deepEqual(s.names(), ["get", "edit", "status"]);
  const edit = s.calls[1].input;
  assert.equal(edit.id, "t1");
  assert.equal(edit.expected_revision, "rev-1");
  assert.deepEqual(Object.keys(edit.patch), ["schedule"]);
  assert.deepEqual(
    {
      kind: edit.patch.schedule.kind,
      local_time: edit.patch.schedule.local_time,
      timezone: edit.patch.schedule.timezone,
      at: edit.patch.schedule.at,
    },
    { kind: "calendar", local_time: "2031-05-06T09:30:00", timezone: TZ, at: FUTURE }
  );
  assert.match(s.toasts.at(-1)!.text, /^tk\.msg\.moved/);
  assert.ok(!s.names().some((n) => /^(approval|lease|execute)$/.test(n)), "a drop never signs or executes");
});

test("calendar drop: a slot up to a minute in the past still counts as now", async () => {
  const s = await store();
  await s.m.moveDue("t1", Date.now() - 30000);
  assert.deepEqual(s.names().slice(0, 2), ["get", "edit"]);
});

test("board drop: a move the task does not allow calls no mutation", async () => {
  const s = await store([task({ state: "resolved" }), task({ id: "t2", archived: true, archive_id: "a1" })]);
  for (const x of s.m.S.items) for (const target of ["done", "failed", "snoozed"]) s.m.moveTo(x, target);
  s.m.moveTo(s.m.S.items[1], "planned");
  assert.deepEqual(s.names(), []);
  assert.ok(s.toasts.every((x) => x.text === "tk.msg.noDrop"));
});

test("board drop: done rereads the revision before resolving and never signs or executes", async () => {
  const s = await store();
  await s.m.moveTo(s.m.S.items[0], "done");
  assert.deepEqual(s.names(), ["get", "resolve", "status"]);
  assert.deepEqual(s.calls[1].input, { id: "t1", expected_revision: "rev-1" });
});

// ── session renewal around writes (#1219) ──────────────────────────────────

test("session: an expired session before a write renews once and repeats the write once with the fresh csrf", async () => {
  const s = await store();
  const before = s.sessions();
  s.expire();
  await s.m.lifecycle(s.m.S.items[0], "resolve");
  assert.equal(s.sessions(), before + 1);
  assert.deepEqual(
    s.calls.map((c) => [c.name, c.csrf]),
    [
      ["get", "csrf-1"],
      ["get", "csrf-2"],
      ["resolve", "csrf-2"],
      ["status", "csrf-2"],
    ]
  );
  assert.deepEqual(s.toasts.at(-1), { text: "tk.msg.resolved", tone: undefined });
});

test("session: a completed write followed by an expired refresh is not repeated and not reported as failed", async () => {
  let writes = 0;
  const s = await store([task()], {
    resolve: () => {
      writes++;
      s.expire();
      return { body: { ok: true } };
    },
  });
  await s.m.lifecycle(s.m.S.items[0], "resolve");
  assert.equal(writes, 1);
  assert.deepEqual(s.names(), ["get", "resolve", "status", "status"], "only the refresh is repeated");
  assert.deepEqual(s.toasts, [{ text: "tk.msg.resolved", tone: undefined }]);
  assert.equal(s.m.S.error, "");
});

test("session: when the renewal after a completed write fails, the write still counts and is not offered again", async () => {
  let writes = 0;
  const s = await store([task()], {
    resolve: () => {
      writes++;
      s.expire();
      s.denySession();
      return { body: { ok: true } };
    },
  });
  await s.m.lifecycle(s.m.S.items[0], "resolve");
  assert.equal(writes, 1);
  assert.deepEqual(s.toasts, [{ text: "tk.msg.resolved", tone: undefined }], "success, no request to repeat");
  assert.equal(s.m.S.error, "tk.err.offline", "the board says it lost the daemon");
});

test("session: a successful create closes its form even when the following refresh expires", async () => {
  let created = 0;
  const s = await store([task()], {
    create: () => {
      created++;
      s.expire();
      s.denySession();
      return { body: { id: "t9" } };
    },
  });
  Object.assign(s.m.S, {
    compose: true,
    F: { ...s.m.S.F, goal: "Saved reminder", timing: "after", when: "1h", tz: TZ },
  });
  await s.m.create();
  assert.equal(created, 1);
  assert.equal(s.m.S.compose, false);
  assert.equal(s.m.S.F.goal, "");
  assert.equal(s.m.S.sel, "t9");
  assert.deepEqual(s.toasts, [{ text: "tk.msg.created", tone: undefined }]);
});

test("session: a second rejection after the renewal ends the write with an error instead of looping", async () => {
  const s = await store([task()], { resolve: () => ({ status: 401, body: {} }) });
  await s.m.lifecycle(s.m.S.items[0], "resolve");
  assert.deepEqual(s.names().filter((n) => n === "resolve").length, 2);
  assert.deepEqual(s.toasts.at(-1), { text: "tk.err.generic", tone: "error" });
});
