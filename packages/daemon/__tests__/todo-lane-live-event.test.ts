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
 * These tests deliberately assert against the captured payload rather than a
 * hand-written one: a test that feeds the shape the fix expects proves nothing
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
  const logDir = await mkdtemp(join(tmpdir(), "bastra-506-"));
  try {
    await withEnv({ BASTRA_LOG_PATH: logDir }, async () => {
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
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});

test("#506: the legacy TodoWrite payload still produces hints", async () => {
  await withDaemon(async (url) => {
    assert.match(await runTodoLane(LEGACY_TODO_WRITE, url), /recall-hints/);
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
