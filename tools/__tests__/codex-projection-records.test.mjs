/**
 * #1530 characterization of CodexProjection.accept, one test per record type
 * it reads. Pinned before the method was cut along those record types; the
 * refactor must leave every expectation here unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CodexProjection, emptyStatus } from "../../packages/statusline/src/codex/state.ts";

const T0 = Date.parse("2026-11-17T10:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();
const event = (payload, ms = 0) => ({ type: "event_msg", timestamp: at(ms), payload });
const started = (turn, ms = 0, extra = {}) => event({ type: "task_started", turn_id: turn, ...extra }, ms);
const tool = (item, turn = "t1", ms = 1000) =>
  event({ type: "item_completed", turn_id: turn, item: { type: "McpToolCall", server: "bastra-recall", ...item } }, ms);
const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const feed = (...rows) => {
  const p = new CodexProjection();
  for (const row of rows) p.accept(row);
  return p;
};

test("session_meta sets identity, cwd, branch, window and start; missing fields fall back or reset", () => {
  const p = feed({
    type: "session_meta",
    timestamp: at(5),
    payload: { id: "s1", cwd: "/w/repo", git: { branch: "main" }, context_window: 4000, timestamp: at(0) },
  });
  assert.equal(p.state.sessionId, "s1");
  assert.equal(p.state.cwd, "/w/repo");
  assert.equal(p.state.branch, "main");
  assert.equal(p.state.contextWindow, 4000);
  assert.equal(p.state.startedAt, T0, "the payload timestamp wins over the row timestamp");

  p.accept({ type: "session_meta", timestamp: at(9), payload: { session_id: "s2", context_window: -1 } });
  assert.equal(p.state.sessionId, "s2", "session_id is the fallback for id");
  assert.equal(p.state.cwd, "/w/repo", "a missing cwd keeps the previous one");
  assert.equal(p.state.branch, null, "a missing git branch resets to unknown");
  assert.equal(p.state.contextWindow, 4000, "an invalid window keeps the previous one");
  assert.equal(p.state.startedAt, T0 + 9, "without a payload timestamp the row timestamp counts");

  p.accept({ type: "session_meta", payload: { id: 7 } });
  assert.equal(p.state.sessionId, null, "non-string ids are unknown");
  assert.equal(p.state.startedAt, null, "an unparseable start is unknown");
});

test("turn_context updates model, effort and cwd only where the record carries strings", () => {
  const p = feed(
    { type: "turn_context", payload: { model: "gpt-a", effort: "high", cwd: "/w/a" } },
    { type: "turn_context", payload: { model: 1, effort: null } }
  );
  assert.equal(p.state.model, "gpt-a");
  assert.equal(p.state.effort, "high");
  assert.equal(p.state.cwd, "/w/a");
});

test("records that are neither meta, context nor a known event leave the state untouched", () => {
  const p = feed(
    null,
    "text",
    [],
    { type: "response_item", payload: { type: "task_started", turn_id: "x" } },
    event({ type: "agent_reasoning", text: "…" }),
    event({ type: "user_message", message: "secret" })
  );
  assert.deepEqual(p.state, emptyStatus());
});

test("task_started and turn_started open a turn; only a new turn id resets the turn counters", () => {
  const p = feed(started("t1", 0, { model_context_window: 2000 }), tool({ id: "a", tool: "recall" }));
  assert.equal(p.state.active, true);
  assert.equal(p.state.turnId, "t1");
  assert.equal(p.state.turnStartedAt, T0);
  assert.equal(p.state.contextWindow, 2000);
  assert.equal(p.state.calls, 1);

  p.accept(event({ type: "turn_started", turn_id: "t1" }, 50));
  assert.equal(p.state.calls, 1, "the same turn id keeps its counters");
  assert.equal(p.state.turnStartedAt, T0 + 50);
  p.accept(tool({ id: "a", tool: "recall" }));
  assert.equal(p.state.calls, 1, "a repeated item id stays counted once within the turn");

  p.accept(started("t2", 100));
  assert.equal(p.state.calls, 0);
  assert.equal(p.state.turnId, "t2");
  assert.deepEqual(p.state.loadedTitles, []);
  p.accept(tool({ id: "a", tool: "recall" }, "t2"));
  assert.equal(p.state.calls, 1, "the dedup table is cleared with the turn");

  p.accept(event({ type: "task_started" }, 200));
  assert.equal(p.state.turnId, null);
  assert.equal(p.state.calls, 0, "a turn without id always resets");
  p.accept(tool({ id: "b", tool: "recall" }, "t2"));
  p.accept(event({ type: "task_started", timestamp: "x" }));
  assert.equal(p.state.calls, 0, "and resets again on the next id-less start");
  p.accept({ type: "event_msg", payload: { type: "task_started", turn_id: "t3" } });
  assert.equal(p.state.turnStartedAt, null, "an unparseable start time is unknown");
});

test("task_complete, task_interrupted and turn_completed end only the current turn", () => {
  for (const type of ["task_complete", "task_interrupted", "turn_completed"]) {
    const p = feed(started("t1"));
    p.accept(event({ type, turn_id: "older" }));
    assert.equal(p.state.active, true, `${type} of another turn keeps the turn running`);
    p.accept(event({ type, turn_id: "t1" }));
    assert.equal(p.state.active, false, `${type} ends the current turn`);
    p.accept(started("t2"));
    p.accept(event({ type }));
    assert.equal(p.state.active, false, `${type} without a turn id ends the turn`);
  }
  const unknownTurn = feed(event({ type: "task_started" }));
  unknownTurn.accept(event({ type: "task_complete", turn_id: "any" }));
  assert.equal(unknownTurn.state.active, false, "with no known turn id any completion ends it");
});

test("token_count maps totals, last usage and window; absent rate limits never become 0 %", () => {
  const p = feed(
    event({
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: 900, cached_input_tokens: 300, input_tokens: 600 },
        last_token_usage: { total_tokens: 120 },
        model_context_window: 1000,
      },
      rate_limits: {
        primary: { window_minutes: 10080, used_percent: 18, resets_at: 1791400000 },
        secondary: { window_minutes: 300, used_percent: 42 },
      },
    })
  );
  assert.equal(p.state.tokens, 900);
  assert.equal(p.state.cachedInputTokens, 300);
  assert.equal(p.state.inputTokens, 600);
  assert.equal(p.state.contextUsed, 120);
  assert.equal(p.state.contextWindow, 1000);
  assert.deepEqual(p.state.limits, [
    { minutes: 10080, used: 18, resetsAt: 1791400000 },
    { minutes: 300, used: 42, resetsAt: null },
  ]);

  p.accept(event({ type: "token_count", info: null, rate_limits: null }));
  assert.equal(p.state.tokens, 900, "missing info keeps every value");
  assert.equal(p.state.limits.length, 2, "null rate limits mean no update");

  p.accept(
    event({
      type: "token_count",
      rate_limits: {
        primary: { window_minutes: 0, used_percent: 5 },
        secondary: { window_minutes: 300, used_percent: null },
      },
    })
  );
  assert.deepEqual(p.state.limits, [], "windows without minutes or usage are dropped, the update itself counts");
});

test("item_completed: the final answer ends the turn, commentary and other turns do not", () => {
  const message = (type, phase, turn = "t1") => event({ type: "item_completed", turn_id: turn, item: { type, phase } });
  const p = feed(started("t1"), message("AgentMessage", "commentary"));
  assert.equal(p.state.active, true);
  p.accept(message("agentMessage", "final_answer", "older"));
  assert.equal(p.state.active, true);
  p.accept(message("agentMessage", "final_answer"));
  assert.equal(p.state.active, false);
  assert.equal(p.state.calls, 0, "messages are not tool calls");
});

test("item_completed: only Recall MCP calls with an id count, once each", () => {
  const p = feed(
    started("t1"),
    tool({ id: "a", tool: "recall", server: "github" }),
    tool({ id: "b", tool: "recall", server: 3 }),
    tool({ tool: "recall" }),
    event({ type: "item_completed", turn_id: "t1", item: { type: "CommandExecution", id: "c" } }),
    tool({ id: "d", tool: "recall" }, "older"),
    tool({ id: "e", tool: "recall", server: "bastra_recall", type: "mcpToolCall" }),
    tool({ id: "f" })
  );
  assert.equal(p.state.calls, 2);
  assert.equal(p.state.searches, 1);
  assert.equal(p.state.lastTool, "tool", "a call without a tool name is labelled generically");
  assert.equal(p.state.lastAt, T0 + 1000);
});

test("item_completed: every failure shape counts as an error and adds nothing else", () => {
  const failures = [
    { status: "failed" },
    { status: "error" },
    { error: "boom" },
    { result: { isError: true, content: [] } },
    { result: { structuredContent: { error: "x", hits: [1] } } },
    { result: json({ isError: true, hits: [1, 2] }) },
  ];
  const p = feed(started("t1"), ...failures.map((f, i) => tool({ id: `f${i}`, tool: "recall", ...f })));
  assert.equal(p.state.calls, failures.length);
  assert.equal(p.state.errors, failures.length);
  assert.equal(p.state.searches, 0);
  assert.equal(p.state.hits, 0);
});

test("item_completed: searches, loads and saves are counted by tool, hits and titles from the result", () => {
  const titles = Array.from({ length: 34 }, (_, i) => `T${i}`);
  const p = feed(
    started("t1"),
    tool({ id: "r1", tool: "recall", result: { structuredContent: { hits: [1, 2, 3], vault_size: 40 } } }),
    tool({ id: "r2", tool: "find_document", result: json({ hits: [1] }) }),
    tool({ id: "r3", tool: "recall", result: { content: [{ type: "text", text: "not json" }] } }),
    tool({ id: "r4", tool: "recall", result: { structuredContent: { hits: "many" } } }),
    tool({ id: "l1", tool: "load_memory", result: json({ frontmatter: { title: "Front" }, title: "Plain" }) }),
    tool({ id: "l2", tool: "read_document", result: json({ title: "Plain" }) }),
    tool({ id: "l3", tool: "load_memory", result: json({ id: "only-id" }) }),
    tool({ id: "l4", tool: "load_memory", result: json({ title: "Plain" }) }),
    tool({ id: "l5", tool: "load_memory", result: json({}) }),
    ...["save_memory", "save_document", "save_product_doc", "edit_memory"].map((name, i) =>
      tool({ id: `s${i}`, tool: name })
    ),
    tool({ id: "x1", tool: "list_rules" })
  );
  assert.equal(p.state.calls, 14);
  assert.equal(p.state.searches, 4);
  assert.equal(p.state.hits, 4);
  assert.equal(p.state.loads, 5);
  assert.equal(p.state.saves, 4);
  assert.equal(p.state.errors, 0);
  assert.deepEqual(p.state.loadedTitles, ["Front", "Plain", "only-id"]);
  assert.equal(p.state.vaultSize, 40, "the last reported vault size stays when later results omit it");
  assert.equal(p.state.lastTool, "list_rules");

  const many = feed(
    started("t1"),
    ...titles.map((title, i) => tool({ id: `m${i}`, tool: "load_memory", result: json({ title }) }))
  );
  assert.deepEqual(many.state.loadedTitles, titles.slice(-32), "titles are bounded to the newest 32");
});

test("item_completed: duration comes from durationMs or secs/nanos and accumulates", () => {
  const p = feed(
    started("t1"),
    tool({ id: "a", tool: "recall", durationMs: 120 }),
    tool({ id: "b", tool: "recall", duration: { secs: 1, nanos: 500000000 } }),
    tool({ id: "c", tool: "recall", durationMs: -5, duration: { nanos: 2000000 } }),
    tool({ id: "d", tool: "recall" })
  );
  assert.equal(p.state.ms, 120 + 1500 + 2);
  p.accept({
    type: "event_msg",
    payload: { type: "item_completed", turn_id: "t1", item: { type: "McpToolCall", server: "bastra-recall", id: "e" } },
  });
  assert.equal(p.state.lastAt, null, "a row without a timestamp has no last-call time");
});

test("the dedup table stays bounded in a turn that never changes", () => {
  const rows = Array.from({ length: 4097 }, (_, i) => tool({ id: `id${i}`, tool: "recall" }));
  const p = feed(started("t1"), ...rows);
  assert.equal(p.state.calls, 4097);
  p.accept(tool({ id: "id0", tool: "recall" }));
  assert.equal(p.state.calls, 4098, "the oldest id was evicted and counts again");
  p.accept(tool({ id: "id4096", tool: "recall" }));
  assert.equal(p.state.calls, 4098, "recent ids stay deduplicated");
});

test("empty, non-string and zero turn ids: an empty id counts as no turn, others never match", () => {
  const empty = feed(started(""), tool({ id: "a", tool: "recall" }, "other"));
  assert.equal(empty.state.turnId, "");
  assert.equal(empty.state.calls, 1, "an empty current turn id filters nothing");
  empty.accept(event({ type: "task_complete", turn_id: "other" }));
  assert.equal(empty.state.active, false, "an empty current turn id lets any completion end it");

  const numeric = feed(started("t1"));
  numeric.accept(event({ type: "task_started", turn_id: 0 }));
  assert.equal(numeric.state.turnId, null, "a numeric id is no id and resets");
  numeric.accept(started("t1"));
  numeric.accept(tool({ id: "a", tool: "recall" }, 0));
  numeric.accept(tool({ id: "b", tool: "recall" }, ""));
  assert.equal(numeric.state.calls, 1, "a non-string item turn id is no foreign turn, an empty string is");
  numeric.accept(event({ type: "turn_completed", turn_id: 7 }));
  assert.equal(numeric.state.active, false, "a non-string completion id ends the current turn");

  const foreign = feed(started("t1"));
  foreign.accept(event({ type: "task_interrupted", turn_id: "" }));
  assert.equal(foreign.state.active, true, "an empty completion id is a different turn");
});

test("null, missing and non-object payloads are ignored without throwing", () => {
  const p = feed(
    { type: "event_msg", payload: null },
    { type: "event_msg" },
    { type: "event_msg", payload: "task_started" },
    { type: "event_msg", payload: [{ type: "task_started" }] },
    { type: "session_meta", payload: null },
    { type: "turn_context", payload: 5 },
    event({ type: "item_completed", turn_id: "t", item: null }),
    event({ type: "item_completed", item: "McpToolCall" })
  );
  assert.deepEqual(p.state, emptyStatus());
});

test("rate limits update only from an object, which may also clear them", () => {
  const limited = () =>
    feed(event({ type: "token_count", rate_limits: { primary: { window_minutes: 300, used_percent: 5 } } }));
  for (const value of [null, undefined, 0, false, "", "x", 7, true]) {
    const p = limited();
    p.accept(event({ type: "token_count", rate_limits: value }));
    assert.equal(p.state.limits.length, 1, `rate_limits ${JSON.stringify(value)} keeps the limits`);
  }
  for (const value of [{}, [], { primary: null }]) {
    const p = limited();
    p.accept(event({ type: "token_count", rate_limits: value }));
    assert.deepEqual(p.state.limits, [], `rate_limits ${JSON.stringify(value)} clears them`);
  }
});

test("a mixed rollout produces the same state after every row (golden digest)", () => {
  const rows = [
    { type: "session_meta", timestamp: at(0), payload: { id: "s", cwd: "/w/r", git: { branch: "b" } } },
    { type: "turn_context", payload: { model: "m", effort: "low", cwd: "/w/r2" } },
    started("t1", 10, { model_context_window: 5000 }),
    tool({ id: "1", tool: "recall", durationMs: 30, result: json({ hits: [1, 2], vault_size: 9 }) }, "t1", 20),
    tool({ id: "2", tool: "load_memory", status: "failed" }, "t1", 30),
    tool({ id: "3", tool: "load_memory", result: { structuredContent: { frontmatter: { title: "A" } } } }, "t1", 40),
    event({ type: "token_count", info: { last_token_usage: { total_tokens: 7 } }, rate_limits: {} }, 50),
    event({ type: "item_completed", turn_id: "t1", item: { type: "AgentMessage", phase: "final_answer" } }, 60),
    event({ type: "task_complete", turn_id: "t1" }, 70),
    started("t2", 80),
    tool({ id: "1", tool: "save_memory", duration: { secs: 0, nanos: 1e6 } }, "t2", 90),
    event({ type: "turn_completed" }, 100),
  ];
  const p = new CodexProjection();
  const trace = rows.map((row) => {
    p.accept(row);
    return JSON.stringify(p.state);
  });
  const digest = createHash("sha256").update(trace.join("\n")).digest("hex");
  assert.equal(digest, GOLDEN_TRACE, `state trace changed: ${digest}`);
});

// Generated from main before the #1530 split.
const GOLDEN_TRACE = "8d62d76fcc2a5cac2c237660db2eff6d001b12a558977b3f3ed27da69f885076";
