import "./tasks-opt-in.js";
/**
 * #1514: characterization of `bastra tasks <sub>` before and after cmdTasks
 * became a handler table. Each case pins which daemon operations the CLI calls,
 * with which body, in which order, plus exit code and output. A recording fake
 * daemon answers; agent mode keeps the owner terminal prompt out of the way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdTasks } from "../src/cli/tasks-cmd.js";
import { friendlyTaskResult, taskWhen } from "../src/cli/task-friendly.js";
import { taskCliLanguage } from "../src/cli/task-cli-words.js";
import { readTaskStore } from "../src/task-store.js";
import { resolveDaemonEndpoint } from "../src/daemon-endpoint.js";

type Call = { operation: string; body: unknown; authorization: string | undefined };

async function body(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined; // #1644: a bodyless call is recorded, not a crash
}

test("#1514 task CLI sub-commands keep their daemon calls, output and exit codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-cli-dispatch-"));
  const calls: Call[] = [];
  const server = createServer(async (req, res) => {
    const operation = req.url!.replace("/api/v1/", "");
    const input = (await body(req)) as Record<string, unknown>;
    calls.push({ operation, body: input, authorization: req.headers.authorization });
    const reply =
      operation === "task_get"
        ? { id: input.id, expected_revision: "rev-from-get", timezone: "UTC", state: "pending" }
        : operation === "task_list" && input.archive_id
          ? { tasks: [{ id: "t1", expected_revision: "rev-from-archive" }] }
          : { ok: true, operation };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const token = "a".repeat(43);
  const saved = {
    url: process.env.BASTRA_DAEMON_URL,
    token: process.env.BASTRA_TASK_TOKEN,
    path: process.env.BASTRA_TASKS_PATH,
  };
  process.env.BASTRA_DAEMON_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.BASTRA_TASK_TOKEN = token;
  process.env.BASTRA_TASKS_PATH = join(root, "tasks.json");
  const inputFile = join(root, "input.json");
  await writeFile(inputFile, JSON.stringify({ goal: "from file" }));

  const run = async (sub: string, rest: string[], json = true) => {
    calls.length = 0;
    let stdout = "",
      stderr = "";
    const out = process.stdout.write,
      err = process.stderr.write;
    process.stdout.write = ((chunk: any) => ((stdout += String(chunk)), true)) as any;
    process.stderr.write = ((chunk: any) => ((stderr += String(chunk)), true)) as any;
    try {
      const argv = ["tasks", sub, ...rest, "--agent", ...(json ? ["--json"] : [])];
      const code = await cmdTasks({ sub, positional: [], argv, json });
      return { code, stdout, stderr, calls: calls.map(({ operation, body }) => [operation, body]) };
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
  };

  try {
    let r = await run("get", ["t1"]);
    assert.deepEqual(r.calls, [["task_get", { id: "t1" }]]);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout).id, "t1");

    r = await run("list", []);
    assert.deepEqual(r.calls, [["task_list", {}]]);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, operation: "task_list" });

    r = await run("cancel", ["t1", "--revision", "r9"]);
    assert.deepEqual(r.calls, [["task_cancel", { id: "t1", expected_revision: "r9" }]]);

    r = await run("cancel", ["t1"]);
    assert.deepEqual(r.calls, [
      ["task_get", { id: "t1" }],
      ["task_cancel", { id: "t1", expected_revision: "rev-from-get" }],
    ]);

    r = await run("snooze", ["t1", "--until", "2030-01-02T10:00"]);
    assert.deepEqual(r.calls, [
      ["task_get", { id: "t1" }],
      ["task_snooze", { id: "t1", expected_revision: "rev-from-get", until: taskWhen("2030-01-02T10:00", "UTC") }],
    ]);

    r = await run("snooze", ["t1", "--revision", "r2", "--until", "2030-01-02T10:00"]);
    assert.equal(r.calls.length, 2, "--until fetches the task's timezone even with a revision");
    assert.deepEqual(r.calls[1], [
      "task_snooze",
      { id: "t1", expected_revision: "r2", until: taskWhen("2030-01-02T10:00", "UTC") },
    ]);

    r = await run("snooze", ["t1", "--until", "not a time"]);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stderr).reason, "time_format");
    assert.deepEqual(r.calls, [["task_get", { id: "t1" }]]);

    r = await run("edit", ["t1", "--expires", "none"]);
    assert.deepEqual(r.calls[1], [
      "task_edit",
      { id: "t1", expected_revision: "rev-from-get", patch: { expires_at: null } },
    ]);

    r = await run("acknowledge", ["t1", "--revision", "r3", "--occurrence", "o1"]);
    assert.deepEqual(r.calls, [["task_acknowledge", { id: "t1", expected_revision: "r3", occurrence_id: "o1" }]]);

    r = await run("release", ["L1"]);
    assert.deepEqual(r.calls, [["task_release", { lease_id: "L1" }]]);

    r = await run("release", ["--id", "t1", "--revision", "r4"]);
    assert.deepEqual(r.calls, [["task_release", { expected_revision: "r4" }]]);

    r = await run("delete", ["t1", "--archive", "A1"]);
    assert.deepEqual(r.calls, [
      ["task_list", { archive_id: "A1" }],
      ["task_delete", { id: "t1", archive_id: "A1", expected_revision: "rev-from-archive" }],
    ]);

    r = await run("delete", ["t2", "--archive", "A1"]);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stderr).code, "not_found");

    r = await run("due", ["t1", "--revision", "r5"]);
    assert.deepEqual(r.calls, [["task_due", { include_acknowledged: true, max_bytes: 16384 }]]);

    for (const [sub, controls] of [
      ["mute", { muted: true }],
      ["unmute", { muted: false }],
      ["off", { enabled: false }],
      ["on", { enabled: true }],
      ["stop", { execution_stopped: true }],
    ] as const) {
      r = await run(sub, []);
      assert.deepEqual(r.calls, [["task_controls", controls]], sub);
      assert.equal(r.code, 0);
    }

    r = await run("resume", []);
    assert.deepEqual(r.calls, [
      ["task_controls", { execution_stopped: false, adapter: { id: "local-artifact-v1", enabled: true } }],
    ]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.length > 0 && !r.stdout.startsWith("{"));

    r = await run("execution-enable", []);
    assert.deepEqual(r.calls, [
      ["task_controls", { execution_stopped: false, adapter: { id: "local-artifact-v1", enabled: true } }],
    ]);

    r = await run("resume", ["t1", "--revision", "r6"]);
    assert.deepEqual(r.calls, [["task_resume", { id: "t1", expected_revision: "r6" }]]);

    r = await run("create", [inputFile]);
    assert.deepEqual(r.calls, [["task_create", { goal: "from file" }]]);

    r = await run("create", ["--input", inputFile, "--id", "x"]);
    assert.deepEqual(r.calls, [["task_create", { goal: "from file", id: "x" }]]);

    r = await run("create", ["--goal", "Friendly", "--after", "7d", "--timezone", "UTC"]);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0][0], "task_create");
    assert.equal((r.calls[0][1] as any).goal, "Friendly");

    r = await run("create", ["--goal", "Bad", "--after", "soon"]);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stderr).code, "validation");
    assert.deepEqual(r.calls, []);

    const snapshot = await readTaskStore(process.env.BASTRA_TASKS_PATH);
    r = await run("archive", ["t1", "t2"]);
    assert.deepEqual(r.calls, [
      [
        "task_archive",
        {
          task_ids: ["t1", "t2"],
          expected_revision: snapshot.revision,
          recovery_epoch: snapshot.recovery_epoch,
        },
      ],
    ]);
    r = await run("archive", ["--id", "t1,t2"]);
    assert.deepEqual((r.calls[0][1] as any).task_ids, ["t1", "t2"]);

    r = await run("bogus-command", []);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stderr).code, "validation");
    assert.deepEqual(r.calls, []);

    // #1644: inherited property names are unknown commands, never a task_controls call.
    for (const sub of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      r = await run(sub, []);
      assert.equal(r.code, 1, sub);
      assert.equal(JSON.parse(r.stderr).code, "validation", sub);
      assert.deepEqual(r.calls, [], sub);
    }

    r = await run("list", ["--nope"]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.calls, []);

    r = await run("ui", [], false);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.startsWith(`${resolveDaemonEndpoint().baseUrl}/ui/#tasks `));
    assert.deepEqual(r.calls, []);

    r = await run("boundary", [], false);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.endsWith("\n") && r.stdout.length > 1);

    r = await run("list", [], false);
    assert.equal(r.code, 0);
    assert.equal(
      r.stdout,
      friendlyTaskResult("list", { ok: true, operation: "task_list" }, await taskCliLanguage()) + "\n",
      "human output without --json"
    );

    delete process.env.BASTRA_TASK_TOKEN;
    r = await run("list", []);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stderr).code, "unauthorized");
    assert.deepEqual(r.calls, []);
  } finally {
    for (const [key, value] of [
      ["BASTRA_DAEMON_URL", saved.url],
      ["BASTRA_TASK_TOKEN", saved.token],
      ["BASTRA_TASKS_PATH", saved.path],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
