/**
 * #704: recall events carry who wrote the query.
 *
 * `queryOrigin` (learned-recall/harvest.ts) preferred an explicit `origin`
 * field that no producer wrote, so every prompt-lane row counted as the owner
 * by its lane alone. The sink writes the field now; these tests pin what it
 * writes per lane, on both event kinds, and that a row without it is not the
 * owner.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/recall-origin.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Telemetry } from "../src/telemetry.js";
import { recallOrigin } from "../src/telemetry-dimensions.js";
import { queryOrigin, teachesBridges, type TelemetryEvent } from "../src/learned-recall/harvest.js";

type Row = Record<string, unknown>;

async function rowsWritten(write: (t: Telemetry) => Promise<void>): Promise<Row[]> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-origin-"));
  try {
    const t = new Telemetry({ logDir: dir });
    await write(t);
    await t.flushNow();
    const out: Row[] = [];
    for (const f of (await readdir(dir)).filter((n) => n.startsWith("events-"))) {
      for (const l of (await readFile(join(dir, f), "utf8")).split("\n")) if (l.trim()) out.push(JSON.parse(l) as Row);
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const TASK_NOTIFICATION = "<task-notification><task-id>b1</task-id><status>completed</status></task-notification>";

test("#704 hook_recall rows carry the origin of their lane", async () => {
  const hookRecall = (query: string, hints: Record<string, unknown>) =>
    ({ recall_id: query, query, hits: [], ...hints }) as unknown as Parameters<Telemetry["logHookRecall"]>[0];
  const rows = await rowsWritten(async (t) => {
    await t.logHookRecall(hookRecall("why does the panel close", { hook_source: "prompt", tool_name: "UserPromptSubmit" }));
    await t.logHookRecall(hookRecall(TASK_NOTIFICATION, { hook_source: "prompt" }));
    await t.logHookRecall(hookRecall("panel dismiss", { hook_source: "mcp", tool_name: "mcp-forwarder" }));
    await t.logHookRecall(hookRecall("src/panel.swift", { hook_source: "pre-tool", tool_name: "Edit" }));
    await t.logHookRecall(hookRecall("no lane named", { tool_name: "UserPromptSubmit" }));
  });
  assert.deepEqual(
    rows.map((r) => [r.recall_id, r.origin]),
    [
      ["why does the panel close", "owner"],
      [TASK_NOTIFICATION, "system"],
      ["panel dismiss", "agent"],
      ["src/panel.swift", "tool"],
      ["no lane named", undefined],
    ],
  );
  // The reader takes what the writer wrote.
  for (const r of rows) {
    assert.equal(queryOrigin(r as TelemetryEvent), r.origin ?? "unknown", String(r.recall_id));
  }
});

test("#704 recall rows: the MCP tool is the agent, the session assembler a tool lane", async () => {
  const recall = (query: string, hints: Record<string, unknown>) =>
    ({ recall_id: query, query, hits: [], ...hints }) as unknown as Parameters<Telemetry["logRecall"]>[0];
  const rows = await rowsWritten(async (t) => {
    await t.logRecall(recall("panel dismiss", {}));
    await t.logRecall(recall("project context", { hook_source: "session-context" }));
  });
  assert.deepEqual(rows.map((r) => r.origin), ["agent", "tool"]);
});

test("#704 recallOrigin: every tool lane maps to tool, an unnamed hook lane has no origin", () => {
  assert.equal(
    recallOrigin("hook_recall", "prompt", 'Another Claude session sent a message:\n<teammate-message teammate_id="a">hi'),
    "system",
  );
  for (const source of ["pre-tool", "session", "stop", "bash-pre", "bash-fail", "todo", "session-context"] as const) {
    assert.equal(recallOrigin("hook_recall", source, "x"), "tool", source);
  }
  assert.equal(recallOrigin("hook_recall", "unknown", "x"), undefined);
  assert.equal(recallOrigin("recall", "unknown", "x"), "agent");
});

test("#704 a prompt-lane row without the field is not the owner and teaches no bridge", () => {
  const ev = (fields: Record<string, unknown>): TelemetryEvent => ({ kind: "hook_recall", ts: "2026-09-20T10:00:00.000Z", ...fields });
  // A bot's persona prompt reads like typed text: no wrapper to check for.
  const persona = "You are Mira, the support assistant of the garden shop. Answer briefly and kindly.";
  for (const legacy of [
    ev({ query: persona, tool_name: "UserPromptSubmit" }),
    ev({ query: persona, tool_name: "UserPromptSubmit", dimensions: { hook_source: "prompt" } }),
  ]) {
    assert.equal(queryOrigin(legacy), "unknown");
    assert.equal(teachesBridges(legacy), false);
  }
  assert.equal(teachesBridges(ev({ query: "why does the panel close", origin: "owner", dimensions: { hook_source: "prompt" } })), true);
});
