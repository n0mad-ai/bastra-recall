/**
 * #1126 — edge cases of the reviewed-miss harvester, one test each: a BOM in
 * front of the first line, subagent (`isSidechain`) records, a recall and a
 * load in the same message after a first result, a recall after a slash
 * command in `transcript_recalls`, and `hit_count: 1` next to `hits: []`.
 *
 * Runner: node --import tsx --import ../../scripts/test-env.mjs --test __tests__/reviewed-miss-edge-cases.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractReviewedMissChains, type RecallCallStats } from "../src/learned-recall/reviewed-miss-harvest.js";
import { loadTelemetry } from "../src/learned-recall/reviewed-miss-engines.js";

const RECALL = "mcp__bastra-recall__recall";
const LOAD = "mcp__bastra-recall__load_memory";
const line = (value: unknown): string => JSON.stringify(value);
const typed = (text: string, extra: Record<string, unknown> = {}): string =>
  line({ type: "user", ...extra, message: { content: text } });
const uses = (
  tools: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  extra: Record<string, unknown> = {}
): string =>
  line({ type: "assistant", ...extra, message: { content: tools.map((t) => ({ type: "tool_use", ...t })) } });
const result = (id: string, recallId: string, hits: string[], extra: Record<string, unknown> = {}): string =>
  line({
    type: "user",
    ...extra,
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: JSON.stringify({ hits: hits.map((h) => ({ id: h })), recall_id: recallId }),
        },
      ],
    },
  });
const recall = (id: string) => ({ id, name: RECALL, input: { query: "q" } });
const load = (id: string, memory: string) => ({ id, name: LOAD, input: { id: memory } });

test("#1126 a BOM in front of the first line does not cost the first record", () => {
  const jsonl = [
    "﻿" + typed("where is the release key"),
    uses([recall("t1")]),
    result("t1", "r1", ["release-key"]),
    uses([load("l1", "release-key")]),
  ].join("\n");
  const chains = extractReviewedMissChains(jsonl, "s");
  assert.equal(chains.length, 1, "the typed intent on the BOM line is read");
  assert.equal(chains[0].query, "where is the release key");
});

test("#1126 subagent records are not the main thread's intent, recalls or steps", () => {
  const side = { isSidechain: true };
  const jsonl = [
    typed("summarise the open tasks"),
    // A subagent: its prompt, its recall, its load — none of it is the owner's chain.
    typed("You are a helper agent; find the deploy notes", side),
    uses([recall("s1")], side),
    result("s1", "rs", ["deploy-notes"], side),
    uses([load("sl", "deploy-notes")], side),
    // The main thread goes on.
    uses([recall("t1")]),
    result("t1", "r1", ["open-tasks"]),
    uses([load("l1", "open-tasks")]),
  ].join("\n");
  const stats: RecallCallStats = { recalls: 0, withRecallId: 0 };
  const chains = extractReviewedMissChains(jsonl, "s", stats);
  assert.deepEqual(
    chains.map((c) => [c.query, c.recallIds, c.evidence]),
    [["summarise the open tasks", ["r1"], { kind: "load-memory", memoryId: "open-tasks" }]]
  );
  assert.equal(stats.recalls, 1);
});

test("#1126 a load in the same message as a second recall is judged against the first result only", () => {
  const jsonl = [
    typed("which port does the daemon use"),
    uses([recall("t1")]),
    result("t1", "r1", ["daemon-port"]),
    // Second recall and the load in one message: the load cannot have seen r2.
    uses([recall("t2"), load("l1", "daemon-port")]),
    result("t2", "r2", ["unrelated"]),
  ].join("\n");
  const stats: RecallCallStats = { recalls: 0, withRecallId: 0 };
  const chains = extractReviewedMissChains(jsonl, "s", stats);
  assert.equal(chains.length, 1);
  assert.deepEqual(chains[0].recallIds, ["r1"]);
  assert.deepEqual(chains[0].servedIds, ["daemon-port"]);
  assert.equal(stats.recalls, 2, "the second recall still counts as a transcript recall");
});

test("#1126 a recall after a slash command counts in transcript_recalls without forming a chain", () => {
  const jsonl = [
    typed("<command-name>/review</command-name>"),
    uses([recall("t1")]),
    result("t1", "r1", ["review-rules"]),
    uses([load("l1", "review-rules")]),
  ].join("\n");
  const stats: RecallCallStats = { recalls: 0, withRecallId: 0 };
  assert.deepEqual(extractReviewedMissChains(jsonl, "s", stats), [], "no typed intent, no chain");
  assert.deepEqual(stats, { recalls: 1, withRecallId: 1 });
});

test("#1126 hit_count above zero next to an empty hits list is no proven empty pool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rm-1126-"));
  try {
    const ts = new Date().toISOString();
    const event = (recallId: string, hitCount: number) =>
      line({
        kind: "recall",
        ts,
        recall_id: recallId,
        hit_count: hitCount,
        hits: [],
        score_kind: "bm25",
        score_arms: ["bm25"],
      });
    await writeFile(join(dir, "events-2026-11-17.jsonl"), [event("empty", 0), event("contradicts", 1)].join("\n"));
    const { pools } = await loadTelemetry(dir);
    assert.ok(pools.has("empty"), "the daemon's own empty result stays a known empty pool");
    assert.equal(pools.has("contradicts"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
