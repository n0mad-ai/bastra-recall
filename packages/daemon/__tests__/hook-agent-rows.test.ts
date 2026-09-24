/**
 * Every row a hook call causes carries the agent of the payload that caused it.
 *
 * A hook lane writes its own row, and its loopback calls make the daemon write
 * more: `hook_recall` (with the deadline shadow), `evidence_decision`,
 * `vector_late_settle`, `hook_act`. Those are the rows the quality numbers are
 * computed from, so an `agent` column that stops at the lane's own row splits
 * nothing that matters.
 *
 * The check runs each lane against a REAL daemon (`startHttpServer`, a dense
 * arm that misses its deadline so the late-settle row fires too), each with its
 * own log directory, so every row in that directory was caused by that one
 * subagent payload — including rows that would not carry its session id.
 *
 * Which kinds must carry the column is not a hand list: `DIMENSIONED_KINDS` is
 * probed from `Telemetry` itself (every `log*` method whose row has
 * `dimensions`). A new dimensioned kind must show up from a hook lane with the
 * right agent, or be named in `NOT_HOOK_REACHABLE` with a reason. A row a hook
 * path writes WITHOUT `dimensions` must be named in `UNDIMENSIONED` — a new
 * one is red until someone decides whether it should be split.
 *
 * Runner: node --import tsx --import ../../scripts/test-env.mjs --test __tests__/hook-agent-rows.test.ts
 */
import { describe, it, before } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { startHttpServer } from "../src/http.js";
import { runBashPreLane } from "../src/bash-pre-lane.js";
import { runBashFailLane } from "../src/bash-fail-lane.js";
import { runPromptLane } from "../src/prompt-lane.js";
import { runSessionLane } from "../src/session-lane.js";
import { runTodoLane } from "../src/todo-lane.js";
import { runWriteLane } from "../src/write-lane.js";

type Row = Record<string, unknown>;

/** Dimensioned kinds no hook payload reaches — each with the reason. */
const NOT_HOOK_REACHABLE: Record<string, string> = {
  recall: "recallHandler: MCP `recall` and the GET session-context of hookless clients; no hook payload, no agent evidence",
};

/** Kinds a hook path writes that carry no `dimensions` at all — no client,
 *  no hook_source, so no agent either. */
const UNDIMENSIONED: Record<string, string> = {
  hook_reflex: "reflex fast-lane row (#217): has never carried dimensions",
  recall_episode: "closes a load that may come from another caller (MCP load_memory); the act does not own it",
  hint_followed_shadow: "join shadow over an earlier hint; same ownership question as recall_episode",
  budget_shadow: "per-session context ledger (#458), charged across lanes; carries no dimensions at all",
};

async function readRows(dir: string): Promise<Row[]> {
  const out: Row[] = [];
  for (const f of (await readdir(dir)).filter((n) => n.startsWith("events-") && n.endsWith(".jsonl"))) {
    for (const l of (await readFile(join(dir, f), "utf8")).split("\n")) {
      if (l.trim()) out.push(JSON.parse(l) as Row);
    }
  }
  return out;
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Probe `Telemetry` for the kinds whose rows carry `dimensions`. */
async function probeDimensionedKinds(): Promise<Map<string, Row>> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-agent-probe-"));
  try {
    const t = new Telemetry({ logDir: dir });
    const methods = Object.getOwnPropertyNames(Telemetry.prototype).filter((m) => /^log[A-Z]/.test(m));
    assert.ok(methods.length > 5, "precondition: Telemetry has log* methods to probe");
    const hints = { client: "claude-code", hook_source: "bash-pre", agent: "subagent", session_id: "probe", hits: [] };
    for (const m of methods) {
      try {
        await (t as unknown as Record<string, (p: unknown) => Promise<void>>)[m](hints);
      } catch {
        // a method that rejects the probe payload writes no row — not a dimensioned kind
      }
    }
    await t.flushNow();
    const byKind = new Map<string, Row>();
    for (const r of await readRows(dir)) if (r.dimensions) byKind.set(String(r.kind), r);
    return byKind;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function memo(id: string): string {
  return [
    "---", `id: ${id}`, "title: Session store migration", "type: reference",
    "summary: How the session store migration runs", "topic_path:", "  - test", "tags:", "  - test",
    "recall_when:", "  - session store migration", "created: 2026-01-01", "updated: 2026-01-01",
    "---", "", "npm test, rm -rf, the session store migration and its deployment notes.", "",
  ].join("\n");
}

/** A dense arm that misses every hook deadline and settles later. */
function lateArm() {
  return {
    size: () => 1,
    runtimeHealth: () => ({ errorCount: 0 }),
    searchDetailed: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ outcome: "hits", hits: [{ id: "a", score: 0.9 }], providerLoadMs: null, coldStartObserved: false }), 2000),
      ),
  } as never;
}

async function withDaemon(logDir: string, fn: (base: string) => Promise<void>): Promise<void> {
  const vaultDir = await mkdtemp(join(tmpdir(), "bastra-agent-vault-"));
  await writeFile(join(vaultDir, "a.md"), memo("a"), "utf8");
  const vault = new Vault(vaultDir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  search.useEmbeddings(lateArm());
  const telemetry = new Telemetry({ logDir });
  const handle = await startHttpServer({
    port: 0, vault, search, telemetry, version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: vaultDir },
    documentWriteEnabled: false,
    embedding: { on: true, providerId: "test", source: "none" },
  });
  try {
    await fn(`http://127.0.0.1:${handle.port}`);
    // the abandoned arm settles after the lane returned — wait for its row
    for (let i = 0; i < 60 && !(await readRows(logDir)).some((r) => r.kind === "vector_late_settle"); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await telemetry.flushNow();
  } finally {
    search.stop();
    await vault.stop?.();
    await handle.close();
    await rm(vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const TODOS = {
  todos: [
    { content: "Migrate the auth middleware to the new session store", status: "pending" },
    { content: "Write regression tests for the session store migration", status: "pending" },
    { content: "Update the deployment notes for the session store", status: "pending" },
  ],
};

type Lane = { name: string; run: (payload: Row, base: string) => Promise<unknown> };

const LANES: Lane[] = [
  { name: "bash-pre", run: (x, b) => runBashPreLane({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /tmp/session-store" }, ...x } as never, b) },
  { name: "bash-fail", run: (x, b) => runBashFailLane({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test session store migration" }, tool_response: { exit_code: 1, stderr: "session store migration failed" }, ...x } as never, b) },
  { name: "prompt", run: (x, b) => runPromptLane({ hook_event_name: "UserPromptSubmit", prompt: "How did we run the session store migration last time?", cwd: "/tmp", ...x } as never, null, b) },
  { name: "session", run: (x, b) => runSessionLane({ hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", ...x } as never, b) },
  { name: "todo", run: (x, b) => runTodoLane({ hook_event_name: "PreToolUse", tool_name: "TodoWrite", cwd: "/tmp", tool_input: TODOS, ...x } as never, b) },
  { name: "write (pre-tool)", run: (x, b) => runWriteLane({ hook_event_name: "PreToolUse", tool_name: "Edit", cwd: "/tmp", tool_input: { file_path: "/tmp/session-store/migrate.ts", old_string: "a", new_string: "b" }, ...x } as never, b) },
];

describe("hook agent: every row a hook call causes carries the payload's agent", () => {
  let dimensioned: Map<string, Row>;
  const seen = new Map<string, string[]>(); // kind -> lanes that produced it

  before(async () => {
    dimensioned = await probeDimensionedKinds();
  });

  it("the probe finds the dimensioned kinds, and each keeps agent through its log method", () => {
    assert.ok(dimensioned.has("hook_recall"), "precondition: the probe reaches logHookRecall");
    for (const [kind, row] of dimensioned) {
      assert.equal((row.dimensions as Row).agent, "subagent", `${kind}: log method drops the agent hint`);
    }
  });

  /** Run one lane against its own daemon; return every row it caused. */
  async function rowsOf(lane: Lane, payload: Row): Promise<Row[]> {
    const logDir = await mkdtemp(join(tmpdir(), "bastra-agent-rows-"));
    try {
      await withDaemon(logDir, (base) =>
        withEnv({ BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir, BASTRA_HOOK_STATE_DIR: logDir, BASTRA_SESSION_STATE_DIR: logDir }, () =>
          lane.run(payload, base).then(() => undefined),
        ),
      );
      const rows = await readRows(logDir);
      // Without a loopback row the lane check below would pass on the lane's own row alone.
      assert.ok(rows.some((r) => r.kind === "hook_recall"), `precondition: ${lane.name} reached /hook/recall`);
      for (const r of rows) {
        assert.ok(r.dimensions || String(r.kind) in UNDIMENSIONED,
          `${lane.name}: ${String(r.kind)} is written on a hook path without dimensions — split it or name it in UNDIMENSIONED`);
      }
      return rows.filter((r) => r.dimensions);
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  }

  for (const lane of LANES) {
    it(`${lane.name}: a subagent payload books agent=subagent on every row it causes`, async () => {
      for (const r of await rowsOf(lane, { session_id: `rows-${lane.name}`, agent_id: "a1b2c3", agent_type: "Explore" })) {
        assert.equal((r.dimensions as Row).agent, "subagent", `${lane.name}: ${String(r.kind)} lost the payload's agent`);
        seen.set(String(r.kind), [...(seen.get(String(r.kind)) ?? []), lane.name]);
      }
    });
  }

  it("a Codex payload books no agent column on any row it causes, not a guessed main", async () => {
    const rows = await rowsOf(LANES[0], { session_id: "rows-codex", bastra_client: "codex" });
    for (const r of rows) {
      assert.equal("agent" in (r.dimensions as Row), false, `${String(r.kind)} guessed an agent for Codex`);
    }
  });

  it("every dimensioned kind is reached by some hook lane, or named as not hook-reachable", () => {
    for (const kind of dimensioned.keys()) {
      if (kind in NOT_HOOK_REACHABLE) continue;
      assert.ok(seen.has(kind), `${kind} carries dimensions but no hook lane produced it here — cover it or name it in NOT_HOOK_REACHABLE`);
    }
  });
});
