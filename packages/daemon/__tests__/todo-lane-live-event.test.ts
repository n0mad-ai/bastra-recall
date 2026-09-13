/**
 * #506 — the plan lane against the event a REAL client actually sends.
 *
 * The lane emitted nothing in seven days of real use. It was not broken: it
 * was bound to `PreToolUse: TodoWrite`, and Claude Code 2.1.268 retired that
 * tool in favour of per-task `TaskCreate` / `TaskUpdate` / `TaskGet` /
 * `TaskList`. `TodoWrite` is emitted only when a session sets
 * `CLAUDE_CODE_ENABLE_TASKS=0`.
 *
 * ── PROVENANCE OF THE FIXTURE ───────────────────────────────────────────────
 * `LIVE_TASK_CREATE` below is not a shape this repo invented. It was captured
 * from Claude Code **2.1.269** on 2026-09-12 by running the real client
 * headless against an ISOLATED settings file (`claude -p --settings …`, a
 * scratch cwd, nothing of the user's configuration touched) whose only hook
 * was a probe that appended its stdin verbatim:
 *
 *     "hooks": { "PreToolUse": [{ "matcher":
 *        "TodoWrite|TaskCreate|TaskUpdate|TaskGet|TaskList",
 *        "hooks": [{ "type": "command", "command": "…probe.sh" }] }] }
 *
 * Asked for a three-step plan, the client emitted THREE `TaskCreate` calls and
 * ZERO `TodoWrite` calls. That run is the evidence that the client triggers
 * this lane automatically; the tests below only pin that our side answers the
 * payload that run produced — including `description`, a field the published
 * documentation does not list but every observed payload carried.
 *
 * `LIVE_UPDATE_PLAN` is the Codex half, captured the same way from Codex CLI
 * 0.153.4. Its seven-day zero had a different cause: the wiring was right, but
 * Codex 0.152.0 turned the planning tool off by default and this host never
 * turned it back on.
 *
 * These tests deliberately assert against the captured payloads rather than
 * hand-written ones: a test that feeds the shape the fix expects proves nothing
 * about the shape the client sends.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/todo-lane-live-event.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTopicsFromTodos, isLowConfidence, runTodoLane } from "../src/todo-lane.js";
import { planHookEntries } from "../src/cli/adapters/claude-code.js";
import { planCodexHooks } from "../src/cli/adapters/codex.js";

/** Verbatim stdin of the first probe hit — Claude Code 2.1.269, 2026-09-12. */
const LIVE_TASK_CREATE = {
  session_id: "5f660da9-d27e-4564-ba6a-b691e2ae0ea4",
  cwd: "/private/tmp/scratch/proof506/work",
  prompt_id: "1a86c724-b475-42fb-a6cb-929453d72e6d",
  permission_mode: "auto",
  hook_event_name: "PreToolUse",
  tool_name: "TaskCreate",
  tool_input: {
    subject: "Health-Route definieren",
    description:
      'Neuen Endpoint (z.B. GET /health) im Web-Service registrieren, der eine einfache 200-Antwort mit Status "ok" liefert.',
    activeForm: "Health-Route wird definiert",
  },
  tool_use_id: "toolu_01MaxcfWWQoddVVfoi3jcbbB",
};

/** The legacy batched shape — still real under CLAUDE_CODE_ENABLE_TASKS=0. */
const LEGACY_TODO_WRITE = {
  session_id: "legacy-506",
  cwd: "/tmp",
  hook_event_name: "PreToolUse",
  tool_name: "TodoWrite",
  tool_input: {
    todos: [
      { content: "Migrate the auth middleware to the new session store", status: "pending" },
      { content: "Write regression tests for the session store migration", status: "pending" },
    ],
  },
};

/**
 * Verbatim stdin of a real Codex `PreToolUse` hook — Codex CLI 0.153.4 on this
 * host, 2026-09-12, captured the same way as the Claude Code payload above:
 * the real binary run headless (`codex exec`) with one hook that recorded its
 * stdin, asked for a plan. The probe that produces it lives in
 * `tools/probes/codex-plan-event/`.
 *
 * The reason it took a deliberate run to capture: Codex 0.152.0 turned the
 * planning tool OFF by default ("enable it with `tools.update_plan.enabled =
 * true`", release rust-v0.152.0), and this host's `~/.codex/config.toml` has no
 * `[tools]` section at all. So `^update_plan$` was correctly registered and
 * correctly trusted and still could not fire — which is the Codex half of
 * #506's seven-day zero, and not a wiring bug.
 */
const LIVE_UPDATE_PLAN = {
  session_id: "01a09555-a6aa-7170-8673-d6a854dc536b",
  turn_id: "01a09555-a6e9-7261-8215-1fcbf7904c76",
  transcript_path: null,
  cwd: "/private/tmp/probe/work",
  hook_event_name: "PreToolUse",
  model: "gpt-6-astra",
  permission_mode: "bypassPermissions",
  tool_name: "update_plan",
  tool_input: {
    plan: [
      { step: "think", status: "pending" },
      { step: "draft", status: "pending" },
      { step: "polish", status: "pending" },
    ],
  },
  tool_use_id: "exec-f9983b58-1e5b-4821-99a9-7ebbdaffcad5",
};

// ─── the matcher, evaluated the way Claude Code evaluates it ────────────────

/**
 * Claude Code's documented matcher semantics: a matcher made only of letters,
 * digits, `_`, `-`, spaces, `|` and `,` is exact-string alternation; anything
 * else is treated as an (unanchored) regular expression.
 */
function matcherMatches(matcher: string, toolName: string): boolean {
  if (/^[A-Za-z0-9_\-|, ]+$/.test(matcher)) {
    return matcher.split("|").map((s) => s.trim()).includes(toolName);
  }
  return new RegExp(matcher).test(toolName);
}

function todoLaneMatcher(): string {
  const plan = planHookEntries("install", {}, { includeStop: false, stubPresent: false });
  const entries = (plan.after.PreToolUse ?? []) as Array<Record<string, unknown>>;
  const entry = entries.find((e) =>
    ((e.hooks ?? []) as Array<{ command?: string }>).some((h) => (h.command ?? "").includes("todo-hook.js")),
  );
  assert.ok(entry, "no PreToolUse entry registers the todo lane at all");
  return String(entry.matcher ?? "");
}

test("#506: the registered matcher fires on the tool a live Claude Code session sends", () => {
  // The whole bug in one assertion: the installer wrote `TodoWrite`, the
  // client sent `TaskCreate`, and nothing anywhere noticed for seven days.
  assert.equal(
    matcherMatches(todoLaneMatcher(), LIVE_TASK_CREATE.tool_name),
    true,
    `matcher ${todoLaneMatcher()} does not match ${LIVE_TASK_CREATE.tool_name}`,
  );
});

test("#506: the matcher keeps firing on the legacy batched tool", () => {
  // CLAUDE_CODE_ENABLE_TASKS=0 and every client before 2.1.268 still send it.
  // Binding to the new event must ADD a trigger, not swap one dead name for
  // another.
  assert.equal(matcherMatches(todoLaneMatcher(), LEGACY_TODO_WRITE.tool_name), true);
});

test("#506: the matcher stays a plain alternation, not an accidental regex", () => {
  // A matcher containing anything outside [A-Za-z0-9_\-|, ] switches Claude
  // Code into regex mode, where `TaskCreate.` or a stray `(` silently changes
  // what fires. Pin the class, not the literal string.
  assert.match(todoLaneMatcher(), /^[A-Za-z0-9_\-|]+$/);
});

test("#506: TaskUpdate is accepted by the lane but deliberately NOT registered", () => {
  // A status transition is not a new plan: registering it would re-fire the
  // lane on every pending -> in_progress -> completed move.
  assert.equal(matcherMatches(todoLaneMatcher(), "TaskUpdate"), false);
});

test("#506: the Codex matcher fires on the tool a live Codex session sends", () => {
  // Same assertion as the Claude Code one, against a payload captured the same
  // way. `^update_plan$` is written by the installer and accepted by the lane
  // in two different files; if one is renamed without the other, the lane goes
  // quiet — and quiet is exactly the failure this issue is about.
  const plan = planCodexHooks("install", {}, { includeStop: false, stubPresent: false });
  const entry = (plan.after.PreToolUse ?? []).find((e) =>
    (((e as Record<string, unknown>).hooks ?? []) as Array<{ command?: string }>).some((h) =>
      (h.command ?? "").includes("todo-hook.js"),
    ),
  ) as Record<string, unknown> | undefined;
  assert.ok(entry, "the Codex installer registers no plan lane at all");
  const matcher = String(entry.matcher ?? "");
  // Codex matchers are regexes and PreToolUse matches them against `tool_name`.
  assert.equal(
    new RegExp(matcher).test(LIVE_UPDATE_PLAN.tool_name),
    true,
    `${matcher} does not match ${LIVE_UPDATE_PLAN.tool_name}`,
  );
  // Anchored, so it cannot start matching a longer tool name by accident.
  assert.equal(new RegExp(matcher).test("update_plan_v2"), false);
});

test("#506: the captured update_plan payload produces hints and a todo_hook_call row", async () => {
  // The lane has normalised `{ plan: [{ step, status }] }` since #15, but never
  // against a payload a real Codex session produced — the shape was taken from
  // documentation. This is that payload.
  await withIsolatedLogs(async (logDir) => {
    await withDaemon(async (url) => {
      const out = await runTodoLane(LIVE_UPDATE_PLAN, url);
      assert.match(out, /recall-hints/, "the live Codex payload must reach the hint block");
      // JSON-escaped inside the hook document, hence the backslash.
      assert.match(out, /surface=\\"codex\\"/, "a Codex plan must be framed as Codex");
      const ev = (await readEvents(logDir)).find((e) => e.kind === "todo_hook_call");
      assert.ok(ev, "the lane that fired must leave its own telemetry row");
      assert.equal(ev.todo_count, 3, "three plan steps, three todos");
      assert.equal(ev.status, "ok");
    });
  });
});

// ─── the lane, against the captured payload ────────────────────────────────

const RECALL = JSON.stringify({
  hits: [{ id: "m1", title: "Health endpoint layout", type: "project-fact", scope: "proj", summary: "Ein Fakt.", score: 150 }],
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

/** Run `fn` with a throwaway log directory, whatever the ambient one is. */
async function withIsolatedLogs(fn: (logDir: string) => Promise<void>): Promise<void> {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-506-"));
  try {
    await withEnv({ BASTRA_LOG_PATH: logDir }, () => fn(logDir));
  } finally {
    await rm(logDir, { recursive: true, force: true });
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

test("#506: the captured TaskCreate payload produces hints and a todo_hook_call row", async () => {
  await withIsolatedLogs(async (logDir) => {
    await withDaemon(async (url) => {
      const out = await runTodoLane(LIVE_TASK_CREATE, url);
      assert.match(out, /recall-hints/, "the live payload must reach the hint block");
      const ev = (await readEvents(logDir)).find((e) => e.kind === "todo_hook_call");
      assert.ok(ev, "the lane that fired must leave its own telemetry row");
      // One tool call is one plan step, however many text fields carried it.
      assert.equal(ev.todo_count, 1);
      assert.equal(ev.status, "ok");
      assert.ok(typeof ev.topic === "string" && ev.topic.length > 0, "a single-step plan must still yield topic words");
    });
  });
});

test("#506: the legacy TodoWrite payload still produces hints", async () => {
  // `runTodoLane` writes a telemetry row, and BASTRA_LOG_PATH is only filled in
  // by scripts/test-env.mjs, which the root `npm test` wires via --import. Run
  // this file directly (`npx tsx --test …`) and that import is absent, so the
  // row lands in the developer's REAL ~/.bastra/logs — which `bastra logs
  // --stats` reports from and `bastra bridges mint` mines. Isolating here costs
  // one wrapper and does not depend on how the file was invoked.
  await withIsolatedLogs(async () => {
    await withDaemon(async (url) => {
      assert.match(await runTodoLane(LEGACY_TODO_WRITE, url), /recall-hints/);
    });
  });
});

test("#506: a TaskCreate carries enough text to clear the confidence gate", () => {
  // The gate is what silently dropped every thin payload before. The captured
  // `subject` alone is 23 chars; with `description` it is far past the floor.
  const payload = LIVE_TASK_CREATE.tool_input;
  const extraction = extractTopicsFromTodos([{ content: `${payload.subject}. ${payload.description}` }]);
  assert.equal(isLowConfidence(extraction), false);
  assert.equal(extraction.todoCount, 1);
  assert.ok(extraction.topics.length > 0);
});

test("#506: a contentless Task payload is still gated, not turned into an empty query", () => {
  // TaskUpdate can arrive with nothing but an id and a status. Whatever
  // registers it, the lane must not run a recall on "".
  assert.equal(isLowConfidence(extractTopicsFromTodos([])), true);
});

test("#506: multi-step topic extraction is unchanged by the single-step rule", () => {
  // The ">= 2 todos" threshold only relaxes when there IS only one step —
  // a chatty todo must still not be able to dominate a real plan's topics.
  const shared = extractTopicsFromTodos(LEGACY_TODO_WRITE.tool_input.todos);
  assert.deepEqual(shared.topics, ["session", "store"]);
  // "middleware" appears in exactly one of the two todos and must stay out.
  assert.equal(shared.topics.includes("middleware"), false);
});
