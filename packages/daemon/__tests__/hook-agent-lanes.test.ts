/**
 * The `agent` dimension on EVERY hook lane's own row, not only bash-pre.
 *
 * The PR that introduced the column wired it into six lanes by hand — six
 * `dimensionsFrom({..., agent })` call sites, and the typechecker cannot catch
 * one that drops it: a destructured sibling of `...rest` is exempt from
 * `noUnusedLocals`, and `dimensionsFrom` takes `agent?: unknown`. A lane that
 * loses the argument silently books every subagent call as "no evidence",
 * which reads like an MCP row. Only bash-pre had an end-to-end check.
 *
 * Revert-check: remove `agent` from any one lane's `dimensionsFrom(...)` call
 * → that lane's case below is red.
 *
 * Runner: node --import tsx --import ../../scripts/test-env.mjs --test __tests__/hook-agent-lanes.test.ts
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBashPreLane } from "../src/bash-pre-lane.js";
import { runBashFailLane } from "../src/bash-fail-lane.js";
import { runPromptLane } from "../src/prompt-lane.js";
import { runSessionLane } from "../src/session-lane.js";
import { runTodoLane } from "../src/todo-lane.js";
import { runWriteLane } from "../src/write-lane.js";

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
  const out: Record<string, unknown>[] = [];
  for (const f of (await readdir(logDir)).filter((n) => n.startsWith("events-") && n.endsWith(".jsonl"))) {
    for (const l of (await readFile(join(logDir, f), "utf8")).split("\n")) {
      if (l.trim()) out.push(JSON.parse(l) as Record<string, unknown>);
    }
  }
  return out;
}

const RECALL = JSON.stringify({ hits: [], vault_size: 0, latency_ms: 1, recall_id: "t", score_kind: "rrf" });

async function withDaemon(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(path === "/hook/recall" ? RECALL : "{}");
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

type Lane = {
  name: string;
  kind: string;
  run: (extra: Record<string, unknown>, base: string) => Promise<unknown>;
};

const TODOS = {
  todos: [
    { content: "Migrate the auth middleware to the new session store", status: "pending" },
    { content: "Write regression tests for the session store migration", status: "pending" },
    { content: "Update the deployment notes for the session store", status: "pending" },
  ],
};

const LANES: Lane[] = [
  {
    name: "bash-pre",
    kind: "bash_hook_call",
    run: (x, base) =>
      runBashPreLane(
        { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /tmp/whatever" }, ...x } as Parameters<typeof runBashPreLane>[0],
        base,
      ),
  },
  {
    name: "bash-fail",
    kind: "bash_fail_hook_call",
    run: (x, base) =>
      runBashFailLane(
        { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 1 }, ...x } as Parameters<typeof runBashFailLane>[0],
        base,
      ),
  },
  {
    name: "prompt",
    kind: "prompt_hook_call",
    run: (x, base) =>
      runPromptLane(
        { hook_event_name: "UserPromptSubmit", prompt: "How did we configure the session store migration last time?", cwd: "/tmp", ...x } as Parameters<typeof runPromptLane>[0],
        null,
        base,
      ),
  },
  {
    name: "session",
    kind: "session_hook_call",
    run: (x, base) =>
      runSessionLane({ hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", ...x } as Parameters<typeof runSessionLane>[0], base),
  },
  {
    name: "todo",
    kind: "todo_hook_call",
    run: (x, base) =>
      runTodoLane({ hook_event_name: "PreToolUse", tool_name: "TodoWrite", cwd: "/tmp", tool_input: TODOS, ...x } as Parameters<typeof runTodoLane>[0], base),
  },
  {
    name: "write (pre-tool)",
    kind: "hook_call",
    run: (x, base) =>
      runWriteLane(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          cwd: "/tmp",
          tool_input: { file_path: "/tmp/session-store/migrate.ts", old_string: "a", new_string: "b" },
          ...x,
        } as Parameters<typeof runWriteLane>[0],
        base,
      ),
  },
];

describe("hook agent dimension on every lane's own row", () => {
  for (const lane of LANES) {
    it(`${lane.name}: ${lane.kind} books a subagent call as subagent and a main-thread call as main`, async () => {
      const logDir = await mkdtemp(join(tmpdir(), "bastra-agent-lanes-"));
      try {
        await withDaemon(async (base) => {
          await withEnv(
            { BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir, BASTRA_HOOK_STATE_DIR: logDir, BASTRA_SESSION_STATE_DIR: logDir },
            async () => {
              await lane.run({ session_id: `agent-main-${lane.name}` }, base);
              // `claude --agent X` stamps agent_type on the MAIN thread too —
              // only agent_id marks a subagent.
              await lane.run({ session_id: `agent-flag-${lane.name}`, agent_type: "reviewer" }, base);
              await lane.run({ session_id: `agent-sub-${lane.name}`, agent_id: "a1b2c3", agent_type: "Explore" }, base);
            },
          );
        });
        const rows = (await readEvents(logDir)).filter((e) => e.kind === lane.kind);
        const agentOf = (sid: string) => {
          const row = rows.find((e) => e.session_id === sid);
          assert.ok(row, `${lane.kind} row for ${sid} must be written`);
          return (row.dimensions as Record<string, unknown>).agent;
        };
        assert.equal(agentOf(`agent-main-${lane.name}`), "main");
        assert.equal(agentOf(`agent-flag-${lane.name}`), "main");
        assert.equal(agentOf(`agent-sub-${lane.name}`), "subagent");
        // agent_type is free text (§23) — it never lands anywhere in the row.
        for (const r of rows) assert.doesNotMatch(JSON.stringify(r), /reviewer|Explore/);
      } finally {
        await rm(logDir, { recursive: true, force: true });
      }
    });
  }
});
