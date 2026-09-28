/**
 * Tests for src/learned-recall/harvest.ts — reconstruct reaches + mint bridges offline.
 *
 * Run: npx tsx --test packages/daemon/__tests__/learned-recall-harvest.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  reconstructReaches,
  harvestBridges,
  extractCandidatePools,
  harvestFarBridges,
  queryOrigin,
  bridgeTeachingEvents,
  type TelemetryEvent,
  type MemoryInfo,
} from "../src/learned-recall/harvest.js";
import type { ChatFn } from "../src/learned-recall/reranker.js";
import { mintBridge } from "../src/learned-recall/bridges.js";

function ev(kind: string, fields: Record<string, unknown>): TelemetryEvent {
  return { kind, ts: "2026-06-14T00:00:00.000Z", ...fields };
}

test("reconstructReaches joins query (hook_recall/recall) to acted-on memory by recall_id", () => {
  const events = [
    ev("hook_recall", { recall_id: "r1", query: "warum schließt sich das Panel", tool_name: "UserPromptSubmit" }),
    ev("recall", { recall_id: "r2", query: "wie speichere ich das Feld" }),
    ev("recall_episode", { recall_id: "r1", memory_id: "nspanel-lesson", acted_on: true }),
    ev("recall_episode", { recall_id: "r2", memory_id: "save-lesson", acted_on: false }), // not acted on
    ev("recall_episode", { recall_id: "rX", memory_id: "orphan", acted_on: true }), // no matching query
  ];
  const reaches = reconstructReaches(events);
  assert.equal(reaches.length, 1, "only the acted_on episode with a known query counts");
  // #672: the episode's ts rides along — it seeds the bridge's first_seen.
  assert.deepEqual(reaches[0], { query: "warum schließt sich das Panel", memoryId: "nspanel-lesson", ts: events[2].ts });
});

test("harvestBridges mints from reaches, using non-overlapping memory terms as expansion", () => {
  const reaches = [{ query: "warum schließt sich das Panel beim Dialog", memoryId: "m1" }];
  const terms: Record<string, string[]> = { m1: ["nspanel", "resignkey", "observer", "panel"] };
  const { bridges, minted } = harvestBridges(reaches, (id) => terms[id] ?? []);
  assert.equal(minted, 1);
  const b = bridges[0];
  assert.equal(b.lang, "de");
  assert.ok(b.trigger_terms.includes("panel"));
  assert.ok(b.expansion_terms.includes("resignkey"));
  assert.ok(b.expansion_terms.includes("observer"));
  assert.ok(!b.expansion_terms.includes("panel"), "a term in the query is not also an expansion");
  assert.equal(b.evidence, 1);
});

test("harvestBridges accumulates evidence when the same bridge is reached repeatedly", () => {
  const reaches = [
    { query: "warum schließt sich das Panel beim Dialog", memoryId: "m1" },
    { query: "warum schließt sich das Panel beim Dialog", memoryId: "m1" },
    { query: "warum schließt sich das Panel beim Dialog", memoryId: "m1" },
  ];
  const { bridges, minted } = harvestBridges(reaches, () => ["nspanel", "resignkey", "observer"]);
  assert.equal(minted, 1, "identical reaches dedupe to one bridge");
  assert.equal(bridges[0].evidence, 3, "evidence counts the reaches");
});

test("harvestBridges skips reaches with no language signal or no usable expansion", () => {
  const reaches = [
    { query: "NSPanel resignKey Observer", memoryId: "m1" }, // code-shaped → language abstains
    { query: "warum schließt das Panel", memoryId: "m2" }, // memory terms all already in query → no expansion
  ];
  const terms: Record<string, string[]> = { m1: ["foo", "bar"], m2: ["panel", "schließt"] };
  const { minted } = harvestBridges(reaches, (id) => terms[id] ?? []);
  assert.equal(minted, 0);
});

test("harvestBridges skips a memory with no terms (e.g. deleted memory)", () => {
  const reaches = [{ query: "warum schließt sich das Panel", memoryId: "gone" }];
  const { minted } = harvestBridges(reaches, () => []);
  assert.equal(minted, 0);
});

// ─── Teacher 2: deep harvest over the far slice ──────────────────────────────

test("extractCandidatePools pulls (query, pool) from recall/hook_recall events", () => {
  const events = [
    ev("hook_recall", { tool_name: "UserPromptSubmit", query: "warum schließt das Panel", candidate_pool: [{ id: "a", score: 80 }, { id: "b", score: 12 }], top_score: 80 }),
    ev("recall", { query: "no pool here" }), // no candidate_pool → skipped
  ];
  const pools = extractCandidatePools(events);
  assert.equal(pools.length, 1);
  assert.equal(pools[0].query, "warum schließt das Panel");
  assert.equal(pools[0].pool.length, 2);
  assert.equal(pools[0].topScore, 80);
});

const MEM: Record<string, MemoryInfo> = {
  wrong: { text: "some unrelated css note", terms: ["css", "flexbox"] },
  right: { text: "NSPanel resignKey observer attachedSheet", terms: ["nspanel", "resignkey", "observer", "attachedsheet"] },
};
const getInfo = (id: string): MemoryInfo | null => MEM[id] ?? null;

test("harvestFarBridges mints when the reranker rescues a LOW-ranked candidate", async () => {
  // #542: scoreKind null = "the event didn't say" (see CandidatePoolEntry) —
  // exactly what these hand-built fixtures are.
  const pools = [{ query: "warum schließt sich mein Panel beim Dialog", pool: [{ id: "wrong", score: 80 }, { id: "right", score: 12 }], topScore: 80, scoreKind: null }];
  const chat: ChatFn = async () => "2"; // picks candidate 2 = "right" (rank 2)
  const r = await harvestFarBridges(pools, getInfo, chat, { maxScore: 100 });
  assert.equal(r.judged, 1);
  assert.equal(r.minted, 1, "a low-ranked rescue mints a bridge");
  assert.ok(r.bridges[0].expansion_terms.includes("resignkey"));
  assert.equal(r.bridges[0].lang, "de");
});

test("harvestFarBridges skips a confident hit (top_score >= maxScore) — not a far case", async () => {
  const pools = [{ query: "warum schließt das Panel", pool: [{ id: "right", score: 160 }, { id: "wrong", score: 12 }], topScore: 160, scoreKind: null }];
  let called = 0;
  const chat: ChatFn = async () => { called++; return "1"; };
  const r = await harvestFarBridges(pools, getInfo, chat, { maxScore: 100 });
  assert.equal(called, 0, "strong hits never reach the reranker");
  assert.equal(r.minted, 0);
});

test("harvestFarBridges does not mint when the reranker keeps the top candidate (no rescue)", async () => {
  const pools = [{ query: "warum schließt sich mein Panel beim Dialog", pool: [{ id: "right", score: 80 }, { id: "wrong", score: 12 }], topScore: 80, scoreKind: null }];
  const chat: ChatFn = async () => "1"; // keeps rank 1 → no far rescue
  const r = await harvestFarBridges(pools, getInfo, chat, { maxScore: 100 });
  assert.equal(r.judged, 1);
  assert.equal(r.minted, 0);
});

test("harvestFarBridges respects the maxJudge budget", async () => {
  const pools = Array.from({ length: 10 }, (_, i) => ({
    query: `warum schließt sich mein Panel nummer ${i}`,
    pool: [{ id: "wrong", score: 80 }, { id: "right", score: 12 }],
    topScore: 80,
    scoreKind: null,
  }));
  let called = 0;
  const chat: ChatFn = async () => { called++; return "0"; };
  await harvestFarBridges(pools, getInfo, chat, { maxScore: 100, maxJudge: 3 });
  assert.equal(called, 3, "stops after maxJudge LLM calls");
});

// ─── #704: bridges learn only from owner-typed (and explicit MCP) queries ────

const TASK_NOTIFICATION =
  "<task-notification><task-id>b1</task-id><tool-use-id>toolu_0135deYEhUmCu82AjaPJPT9c</tool-use-id>" +
  "<output-file>/home/user/.claude/tasks/b1.output</output-file><status>completed</status></task-notification>";

test("#704 queryOrigin: explicit field, system-turn text, lane, legacy tool_name", () => {
  assert.equal(queryOrigin(ev("hook_recall", { query: "x y", origin: "system", dimensions: { hook_source: "prompt" } })), "system");
  assert.equal(queryOrigin(ev("hook_recall", { query: TASK_NOTIFICATION, tool_name: "UserPromptSubmit" })), "system");
  assert.equal(queryOrigin(ev("hook_recall", { query: "  [Subagent hand-back] done", dimensions: { hook_source: "prompt" } })), "system");
  assert.equal(queryOrigin(ev("hook_recall", { query: "Another Claude session sent a message: hi", tool_name: "UserPromptSubmit" })), "system");
  assert.equal(queryOrigin(ev("hook_recall", { query: "why does the panel close", dimensions: { hook_source: "prompt" } })), "owner");
  assert.equal(queryOrigin(ev("hook_recall", { query: "why does the panel close", tool_name: "UserPromptSubmit" })), "owner");
  assert.equal(queryOrigin(ev("hook_recall", { query: "panel dismiss", dimensions: { hook_source: "mcp" } })), "agent");
  assert.equal(queryOrigin(ev("recall", { query: "panel dismiss" })), "agent");
  assert.equal(queryOrigin(ev("hook_recall", { query: "src/panel.swift", dimensions: { hook_source: "pre-tool" }, tool_name: "Edit" })), "tool");
  assert.equal(queryOrigin(ev("hook_recall", { query: "npm test", tool_name: "Bash" })), "tool");
  assert.equal(queryOrigin(ev("hook_recall", { query: "no lane at all" })), "unknown");
});

test("#704 bridgeTeachingEvents + reconstructReaches: a task-notification reach mints nothing, the owner prompt onto the same memory still does", () => {
  const events = [
    ev("hook_recall", { recall_id: "sys", query: TASK_NOTIFICATION, tool_name: "UserPromptSubmit" }),
    ev("recall_episode", { recall_id: "sys", memory_id: "archive-note", acted_on: true }),
    ev("hook_recall", { recall_id: "tool", query: "Write /Users/me/project/src/panel.swift", dimensions: { hook_source: "pre-tool" }, tool_name: "Write" }),
    ev("recall_episode", { recall_id: "tool", memory_id: "archive-note", acted_on: true }),
    ev("hook_recall", { recall_id: "legacy", query: "no lane recorded on this row" }),
    ev("recall_episode", { recall_id: "legacy", memory_id: "archive-note", acted_on: true }),
    ev("hook_recall", { recall_id: "own", query: "warum schließt sich mein Fenster von allein", dimensions: { hook_source: "prompt" } }),
    ev("recall_episode", { recall_id: "own", memory_id: "archive-note", acted_on: true }),
  ];
  const reaches = reconstructReaches(bridgeTeachingEvents(events));
  assert.deepEqual(reaches.map((r) => r.query), ["warum schließt sich mein Fenster von allein"]);
  const { bridges } = harvestBridges(reaches, () => ["nspanel", "resignkey", "observer"]);
  assert.equal(bridges.length, 1, "the owner sentence still mints");
});

test("#704 bridgeTeachingEvents + extractCandidatePools: the far harvest skips system and tool queries too", () => {
  const pool = [{ id: "a", score: 40 }, { id: "b", score: 12 }];
  const pools = extractCandidatePools(bridgeTeachingEvents([
    ev("hook_recall", { query: TASK_NOTIFICATION, tool_name: "UserPromptSubmit", candidate_pool: pool }),
    ev("hook_recall", { query: "npm run build", tool_name: "Bash", candidate_pool: pool }),
    ev("hook_recall", { query: "warum schließt das Panel", dimensions: { hook_source: "prompt" }, candidate_pool: pool }),
  ]));
  assert.deepEqual(pools.map((p) => p.query), ["warum schließt das Panel"]);
});

test("#704 mintBridge: zzallirog's machine trigger does not mint; machine terms drop out of an owner trigger", () => {
  assert.equal(mintBridge("task notification tool toolu output claude home", ["nspanel", "resignkey"], "en"), null);
  const b = mintBridge("why does the claude panel close on resign", ["nspanel", "resignkey"], "en");
  assert.ok(b, "an owner sentence mints");
  assert.ok(!b.trigger_terms.includes("claude"), "a machine term never becomes a trigger");
  assert.ok(b.trigger_terms.includes("panel"));
});
