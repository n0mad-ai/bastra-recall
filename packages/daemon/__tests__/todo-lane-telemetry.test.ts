/**
 * #373 — the TodoWrite lane's telemetry row, pinned like the other lanes'
 * (#356 series): `session_id` from the payload, synthetic UUID only as
 * fallback, `hook_version` present, kind `todo_hook_call`. #372 stamped
 * `randomUUID()` here unnoticed because nothing read the row.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/todo-lane-telemetry.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTodoLane } from "../src/todo-lane.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function readEvents(logDir: string): Promise<Record<string, unknown>[]> {
  const files = (await readdir(logDir)).filter((n) => n.startsWith("events-") && n.endsWith(".jsonl"));
  const out: Record<string, unknown>[] = [];
  for (const f of files) {
    for (const l of (await readFile(join(logDir, f), "utf8")).split("\n")) {
      if (l.trim()) out.push(JSON.parse(l) as Record<string, unknown>);
    }
  }
  return out;
}

/** Three substantive todos — enough for the confidence gate to let the recall run. */
const TODOS = {
  todos: [
    { content: "Migrate the auth middleware to the new session store", status: "pending" },
    { content: "Write regression tests for the session store migration", status: "pending" },
    { content: "Update the deployment notes for the session store", status: "pending" },
  ],
};

const RECALL = JSON.stringify({
  hits: [{ id: "m1", title: "Session store lesson", type: "lesson", scope: "proj", summary: "Eine Lektion.", score: 150 }],
  vault_size: 1,
  latency_ms: 1,
  recall_id: "r1",
  score_kind: "rrf",
});

async function withDaemon(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    req.on("data", () => {});
    req.on("end", () => {
      const body = path === "/hook/recall" ? RECALL : path === "/hook/hinted" ? "{}" : null;
      res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
      res.end(body ?? "{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("#373: todo_hook_call carries the payload session_id, hook_version and the injected token count", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-todo-telemetry-"));
  try {
    await withDaemon(async (base) => {
      const out = await withEnv({ BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir, BASTRA_SESSION_STATE_DIR: logDir }, () =>
        runTodoLane(
          { hook_event_name: "PreToolUse", tool_name: "TodoWrite", session_id: "todo-373", cwd: "/tmp", tool_input: TODOS },
          base,
        ),
      );
      assert.doesNotThrow(() => JSON.parse(out));
    });
    const ev = (await readEvents(logDir)).find((e) => e.kind === "todo_hook_call");
    assert.ok(ev, "a todo_hook_call event must be written");
    assert.equal(ev.session_id, "todo-373", "the payload session, not a synthetic one (#372)");
    assert.equal(typeof ev.hook_version, "string");
    assert.equal(ev.daemon_reachable, true);
    assert.equal(ev.todo_count, 3);
    assert.equal(typeof ev.hint_tokens_est, "number");
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});

test("#373: without a payload session_id the row carries a synthetic UUID — fallback only", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-todo-telemetry-uuid-"));
  try {
    await withEnv({ BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir, BASTRA_SESSION_STATE_DIR: logDir }, () =>
      runTodoLane({ hook_event_name: "PreToolUse", tool_name: "TodoWrite", cwd: "/tmp", tool_input: TODOS }, "http://127.0.0.1:1"),
    );
    const ev = (await readEvents(logDir)).find((e) => e.kind === "todo_hook_call");
    assert.ok(ev);
    assert.match(String(ev.session_id), UUID);
    assert.equal(ev.daemon_reachable, false);
    assert.equal(ev.status, "daemon-unreachable");
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});

test("#373: the event gate returns `{}` for other tools and writes nothing", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-todo-telemetry-gate-"));
  try {
    await withEnv({ BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir }, async () => {
      assert.equal(await runTodoLane({ hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "x" }, "http://127.0.0.1:1"), "{}");
      assert.equal(await runTodoLane({ hook_event_name: "PostToolUse", tool_name: "TodoWrite", session_id: "x" }, "http://127.0.0.1:1"), "{}");
    });
    assert.equal((await readdir(logDir)).length, 0, "a gated call writes no telemetry");
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});

test("#373: a low-confidence todo list is recorded as gated, with the payload session", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-todo-telemetry-thin-"));
  try {
    const out = await withEnv({ BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir }, () =>
      runTodoLane(
        { hook_event_name: "PreToolUse", tool_name: "TodoWrite", session_id: "todo-thin", tool_input: { todos: [{ content: "fix", status: "pending" }] } },
        "http://127.0.0.1:1",
      ),
    );
    assert.equal(out, "{}");
    const ev = (await readEvents(logDir)).find((e) => e.kind === "todo_hook_call");
    assert.ok(ev, "the gate branch still writes its row");
    assert.equal(ev.session_id, "todo-thin");
    assert.equal(ev.daemon_reachable, null, "#352: null = never asked");
    assert.equal(ev.hint_tokens_est, 0);
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});
