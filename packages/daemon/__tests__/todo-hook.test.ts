/**
 * Tests for the TodoWrite lane (Issue #36).
 *
 * Strategy: unit-test the pure helpers (extractTopicsFromTodos,
 * isLowConfidence, formatHintBlock) directly, then end-to-end against a
 * mock daemon HTTP server.
 *
 * #369 moved the pipeline out of todo-hook.ts into todo-lane.ts (the hook is a
 * thin client now), so the end-to-end cases call `runTodoLane` against the mock
 * daemon instead of spawning the CLI: same payloads, same assertions, no tsx
 * process per case — and it covers the path the compiled stub reaches.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractTopicsFromTodos,
  isLowConfidence,
  formatHintBlock,
  runTodoLane,
  type RecallHit,
} from "../src/todo-lane.ts";

// ─── Pure unit tests ─────────────────────────────────────────────────────

test("extractTopicsFromTodos — picks topic words that appear in >=2 todos", () => {
  const todos = [
    { content: "Refactor the bastra-recall daemon hook pipeline", status: "pending" },
    { content: "Update bastra-recall daemon telemetry events", status: "pending" },
    { content: "Document the new daemon hook config", status: "pending" },
  ];
  const ex = extractTopicsFromTodos(todos);
  // "daemon" appears in all 3, "bastra-recall" + "hook" each in 2.
  assert.ok(ex.topics.includes("daemon"), `topics: ${ex.topics.join(",")}`);
  assert.ok(ex.topics.includes("hook"), `topics: ${ex.topics.join(",")}`);
  assert.equal(ex.todoCount, 3);
  assert.ok(ex.query.length > 0);
  // Query should start with the topics
  assert.ok(ex.query.startsWith(ex.topics.join(" ")));
});

test("extractTopicsFromTodos — handles missing/empty payload", () => {
  assert.deepEqual(extractTopicsFromTodos(undefined), {
    query: "",
    topics: [],
    todoCount: 0,
  });
  assert.deepEqual(extractTopicsFromTodos([]), {
    query: "",
    topics: [],
    todoCount: 0,
  });
  const onlyEmptyContent = extractTopicsFromTodos([{ content: "" }, { content: "" }]);
  assert.equal(onlyEmptyContent.query, "");
  assert.equal(onlyEmptyContent.topics.length, 0);
});

test("extractTopicsFromTodos — filters stopwords and short words", () => {
  const todos = [
    { content: "fix the and or but if then for to of in" },
    { content: "fix the and or but if then for to of in" },
  ];
  const ex = extractTopicsFromTodos(todos);
  // "fix" is stopword too; everything else is < 3 chars or stopword.
  assert.equal(ex.topics.length, 0);
});

test("isLowConfidence — triggers when no topics and short query", () => {
  assert.equal(isLowConfidence({ query: "hi", topics: [], todoCount: 1 }), true);
  assert.equal(isLowConfidence({ query: "", topics: [], todoCount: 0 }), true);
});

test("isLowConfidence — passes with >=2 topics", () => {
  assert.equal(
    isLowConfidence({ query: "x", topics: ["alpha", "beta"], todoCount: 2 }),
    false,
  );
});

test("isLowConfidence — passes with long query even if no topics", () => {
  assert.equal(
    isLowConfidence({
      query: "implement a complete user-prompt-submit hook end to end",
      topics: [],
      todoCount: 1,
    }),
    false,
  );
});

test("formatHintBlock — emits todo-plan trigger + load instruction", () => {
  const hits: RecallHit[] = [
    {
      id: "bastra-projekt-ubersicht-master",
      title: "Bastra Projekt Übersicht",
      type: "project-fact",
      scope: "bastra-recall",
      summary: "Master entry covering the whole project.",
      score: 130,
    },
  ];
  const block = formatHintBlock(hits, "bastra-recall", ["daemon", "hook"]);
  assert.match(block, /<recall-hints surface="claude-code" trigger="todo-plan"/);
  assert.match(block, /project="bastra-recall"/);
  assert.match(block, /topics="daemon,hook"/);
  assert.match(block, /Before starting these todos, load the project-facts/);
  assert.match(block, /bastra-projekt-ubersicht-master/);
});

// ─── Integration test via mock daemon ────────────────────────────────────

function startMockDaemon(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return new Promise<{ port: number; close: () => Promise<void> }>((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      ok({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** The lane call as the route makes it, with telemetry off for the duration. */
async function runLane(payload: object, daemonUrl: string): Promise<{ stdout: string }> {
  const before = process.env.BASTRA_TELEMETRY;
  process.env.BASTRA_TELEMETRY = "off";
  try {
    return { stdout: await runTodoLane(payload, daemonUrl) };
  } finally {
    if (before === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = before;
  }
}

test("integration — TodoWrite with topical todos yields hints + type=project-fact filter", async () => {
  let received: { url: string | undefined; body: { type?: string; query?: string } } | null =
    null;
  const daemon = await startMockDaemon((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      // The hook now also fires a /hook/hinted usage ping (#154) — only the
      // recall request is what this test asserts on.
      if (req.url === "/hook/recall") received = { url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          hits: [
            {
              id: "bastra-projekt-ubersicht-master",
              title: "Bastra Projekt Übersicht",
              type: "project-fact",
              scope: "bastra-recall",
              summary: "Master entry.",
              score: 135,
            },
          ],
          vault_size: 100,
          latency_ms: 10,
          recall_id: "test",
        }),
      );
    });
  });

  try {
    const { stdout } = await runLane(
      {
        hook_event_name: "PreToolUse",
        tool_name: "TodoWrite",
        cwd: process.cwd(),
        tool_input: {
          todos: [
            { content: "Implement bastra-recall daemon hook for TodoWrite", status: "pending" },
            { content: "Wire up bastra-recall daemon telemetry", status: "pending" },
            { content: "Test the daemon hook pipeline", status: "pending" },
          ],
        },
      },
      `http://127.0.0.1:${daemon.port}`,
    );

    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { additionalContext?: string; hookEventName?: string };
    };
    assert.ok(parsed.hookSpecificOutput, "hook should emit hookSpecificOutput");
    assert.equal(parsed.hookSpecificOutput?.hookEventName, "PreToolUse");
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";
    assert.match(ctx, /trigger="todo-plan"/);
    assert.match(ctx, /bastra-projekt-ubersicht-master/);

    assert.ok(received, "mock daemon should have been called");
    const r = received as { url: string | undefined; body: { type?: string; query?: string } };
    assert.equal(r.url, "/hook/recall");
    assert.equal(r.body.type, "project-fact", "must filter by type=project-fact");
    assert.match(r.body.query ?? "", /daemon/);
  } finally {
    await daemon.close();
  }
});

test("integration — Codex update_plan is normalized and identified as codex (#15)", async () => {
  let received: { client?: string; tool_name?: string; query?: string } | null = null;
  const daemon = await startMockDaemon((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      if (req.url === "/hook/recall") received = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        hits: [{ id: "codex-layout", title: "Layout", type: "project-fact", scope: "all-projects", summary: "Current adapter layout.", score: 130 }],
        vault_size: 1,
        latency_ms: 1,
        recall_id: "codex-plan",
      }));
    });
  });
  try {
    const { stdout } = await runLane({
      hook_event_name: "PreToolUse",
      tool_name: "update_plan",
      model: "gpt-5.6-codex",
      cwd: process.cwd(),
      tool_input: {
        plan: [
          { step: "Implement Codex adapter hooks", status: "in_progress" },
          { step: "Test Codex adapter hooks", status: "pending" },
        ],
      },
    }, `http://127.0.0.1:${daemon.port}`);
    const context = JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? "";
    assert.match(context, /surface="codex"/);
    assert.match(context, /via update_plan/);
    assert.equal((received as { client?: string } | null)?.client, "codex");
    assert.equal((received as { tool_name?: string } | null)?.tool_name, "update_plan");
    assert.match((received as { query?: string } | null)?.query ?? "", /Codex adapter hooks/i);
  } finally {
    await daemon.close();
  }
});

test("integration — low-confidence todos emit empty object", async () => {
  let hit = false;
  const daemon = await startMockDaemon((_req, res) => {
    hit = true;
    res.writeHead(200);
    res.end('{"hits":[],"vault_size":0,"latency_ms":1,"recall_id":"x"}');
  });
  try {
    const { stdout } = await runLane(
      {
        hook_event_name: "PreToolUse",
        tool_name: "TodoWrite",
        tool_input: { todos: [{ content: "ok", status: "pending" }] },
      },
      `http://127.0.0.1:${daemon.port}`,
    );
    assert.equal(stdout.trim(), "{}");
    assert.equal(hit, false, "daemon must not be called for low-confidence todos");
  } finally {
    await daemon.close();
  }
});

test("integration — wrong tool_name emits empty object", async () => {
  const daemon = await startMockDaemon((_req, res) => {
    res.writeHead(200);
    res.end("{}");
  });
  try {
    const { stdout } = await runLane(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/tmp/x.ts" },
      },
      `http://127.0.0.1:${daemon.port}`,
    );
    assert.equal(stdout.trim(), "{}");
  } finally {
    await daemon.close();
  }
});

/**
 * Codex-Gegenreview: die Todo-Lane las `unfused` überhaupt nicht. Für
 * BM25-only-Maschinen (kein Embedding-Modell) wurden rohe, nach oben offene
 * Scores an 50/100 gemessen, als wären es RRF-Werte — praktisch jeder Treffer
 * landete im REQUIRED-Band, samt Backoff-Bypass.
 */
test("formatHintBlock — unfused: no bands, no scores, honest headline", () => {
  const hits: RecallHit[] = [
    {
      id: "roher-bm25-treffer",
      title: "Roher Treffer",
      type: "project-fact",
      scope: "bastra-recall",
      summary: "Ein lexikalischer Treffer auf offener Skala.",
      score: 41337, // #302: rohe BM25-Spitzen sind fünf-/sechsstellig
    },
  ];
  const block = formatHintBlock(hits, "bastra-recall", ["daemon"], true);
  // Kein Band-Vokabular: weder REQUIRED noch OPTIONAL noch "both search paths".
  assert.doesNotMatch(block, /REQUIRED|OPTIONAL/);
  assert.doesNotMatch(block, /agreed/);
  assert.match(block, /open-ended scale/);
  // Die Zahl wird nicht gezeigt — sie lädt zum Vergleichen ein, den sie nicht trägt.
  assert.doesNotMatch(block, /41337/);
  assert.doesNotMatch(block, /score \d/);
  assert.match(block, /roher-bm25-treffer/);
});

test("formatHintBlock — fused path keeps its bands and scores", () => {
  const hits: RecallHit[] = [
    {
      id: "fusionierter-treffer",
      title: "Fusioniert",
      type: "project-fact",
      scope: "bastra-recall",
      summary: "Beide Arme stimmten überein.",
      score: 130,
    },
  ];
  const block = formatHintBlock(hits, "bastra-recall", ["daemon"], false);
  assert.match(block, /score 130/);
  assert.doesNotMatch(block, /open-ended scale/);
});

test("integration — an unfused recall response reaches the block honestly", async () => {
  const daemon = await startMockDaemon((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          hits: [
            {
              id: "bm25-only-treffer",
              title: "Nur lexikalisch",
              type: "project-fact",
              scope: "bastra-recall",
              summary: "Kein Vektor-Arm gelaufen.",
              score: 98765,
            },
          ],
          vault_size: 100,
          latency_ms: 10,
          recall_id: "test",
          unfused: true,
        }),
      );
    });
  });

  try {
    const { stdout } = await runLane(
      {
        hook_event_name: "PreToolUse",
        tool_name: "TodoWrite",
        session_id: `unfused-${Date.now()}`,
        cwd: process.cwd(),
        tool_input: {
          todos: [
            { content: "Implement bastra-recall daemon hook for TodoWrite", status: "pending" },
            { content: "Wire up bastra-recall daemon telemetry", status: "pending" },
            { content: "Test the daemon hook pipeline", status: "pending" },
          ],
        },
      },
      `http://127.0.0.1:${daemon.port}`,
    );
    const ctx =
      (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } })
        .hookSpecificOutput?.additionalContext ?? "";
    assert.match(ctx, /bm25-only-treffer/);
    assert.match(ctx, /open-ended scale/);
    assert.doesNotMatch(ctx, /REQUIRED/);
    assert.doesNotMatch(ctx, /98765/);
  } finally {
    await daemon.close();
  }
});

/**
 * §20.5: der Scope-Filter dieser Lane. Shadow misst und lässt durch, enforce
 * verwirft — hier über die echte Lane, damit die Verdrahtung mitgeprüft ist.
 */
function startForeignScopeDaemon() {
  return startMockDaemon((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          hits: [
            {
              id: "eigener-fakt",
              title: "Eigen",
              type: "project-fact",
              scope: "bastra-recall",
              summary: "Gehört zu diesem Projekt.",
              score: 135,
            },
            {
              id: "fremder-fakt",
              title: "Fremd",
              type: "project-fact",
              scope: "carnexus",
              summary: "Gehört zu einem anderen Projekt.",
              score: 130,
              matched_recall_when: true,
              anchor_strength: "strong",
            },
          ],
          vault_size: 100,
          latency_ms: 10,
          recall_id: "test",
        }),
      );
    });
  });
}

const SCOPE_TODOS = {
  todos: [
    { content: "Implement bastra-recall daemon hook for TodoWrite", status: "pending" },
    { content: "Wire up bastra-recall daemon telemetry", status: "pending" },
    { content: "Test the daemon hook pipeline", status: "pending" },
  ],
};

async function runScopeLane(mode: string | undefined, port: number): Promise<string> {
  const before = process.env.BASTRA_SCOPE_FILTER_LANES;
  if (mode === undefined) delete process.env.BASTRA_SCOPE_FILTER_LANES;
  else process.env.BASTRA_SCOPE_FILTER_LANES = mode;
  try {
    const { stdout } = await runLane(
      {
        hook_event_name: "PreToolUse",
        tool_name: "TodoWrite",
        session_id: `scope-${mode}-${Date.now()}`,
        // Ein echter Projekt-Root-Pfad: detectProject liefert "bastra-recall".
        cwd: "/Users/x/Projekte/bastra-recall",
        tool_input: SCOPE_TODOS,
      },
      `http://127.0.0.1:${port}`,
    );
    return (
      (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } })
        .hookSpecificOutput?.additionalContext ?? ""
    );
  } finally {
    if (before === undefined) delete process.env.BASTRA_SCOPE_FILTER_LANES;
    else process.env.BASTRA_SCOPE_FILTER_LANES = before;
  }
}

test("scope filter — shadow (default) lets a foreign project-fact through", async () => {
  const daemon = await startForeignScopeDaemon();
  try {
    const ctx = await runScopeLane(undefined, daemon.port);
    assert.match(ctx, /eigener-fakt/);
    assert.match(ctx, /fremder-fakt/);
  } finally {
    await daemon.close();
  }
});

test("scope filter — enforce drops it, anchor or not (this lane has no exception)", async () => {
  const daemon = await startForeignScopeDaemon();
  try {
    const ctx = await runScopeLane("enforce", daemon.port);
    assert.match(ctx, /eigener-fakt/);
    assert.doesNotMatch(ctx, /fremder-fakt/);
  } finally {
    await daemon.close();
  }
});
