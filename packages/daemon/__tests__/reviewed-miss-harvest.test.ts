import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { harvestReviewedMisses } from "../src/learned-recall/reviewed-miss-harvest.js";

function line(value: unknown): string { return JSON.stringify(value); }

test("harvest keeps an explicit Recall miss separate from its later source", () => {
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall", input: { query: "rail" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content: '{"weak_result":true,"hits":[]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
  ].join("\n");
  const [candidate] = harvestReviewedMisses(session, "session.jsonl");
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.query, "where is the deployment rail");
  assert.match(candidate.sourceRef ?? "", /^sha256:/);
  assert.doesNotMatch(JSON.stringify(candidate), /private|rail\.md/);
  assert.deepEqual(candidate.evidence, { recall: "explicit-miss", sourceReadAfterRecall: true });
});

test("nonempty Recall chains remain unreviewed rather than becoming false misses", () => {
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall", input: { query: "rail" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content: '{"hits":[{"id":"wrong-memory"}]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
  ].join("\n");
  assert.equal(harvestReviewedMisses(session, "session.jsonl")[0].status, "needs-relevance-label");
});

test("evidence before the matching Recall result cannot form a candidate", () => {
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content: '{"hits":[]}' }] } }),
  ].join("\n");
  assert.deepEqual(harvestReviewedMisses(session, "session.jsonl"), []);
});

test("a source read without an inspectable identity still records the review boundary", () => {
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content: '{"hits":[]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } }),
  ].join("\n");
  const [candidate] = harvestReviewedMisses(session, "session.jsonl");
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.sourceRef, null);
});

test("an unrelated empty tool result cannot taint a nonempty Recall", () => {
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [
      { type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall" },
      { type: "tool_use", id: "grep-1", name: "Grep" },
    ] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "grep-1", content: '{"hits":[]}' }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content: '{"hits":[{"id":"wrong-memory"}]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
  ].join("\n");
  assert.equal(harvestReviewedMisses(session, "session.jsonl")[0].status, "needs-relevance-label");
});

test("explicit miss accepts structured and text-only results", () => {
  const run = (content: string): string => {
    const session = [
      line({ type: "user", message: { content: "where is the deployment rail" } }),
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall" }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content }] } }),
      line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
    ].join("\n");
    return harvestReviewedMisses(session, "session.jsonl")[0]?.status ?? "missing";
  };
  assert.equal(run('{"weak_result":true,"hits":[{"id":"memory-1"}]}'), "candidate");
  assert.equal(run("no relevant memory found"), "candidate");
});

test("transcript control envelopes cannot become a Recall intent", () => {
  const session = [
    line({ type: "user", message: { content: "real human request" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "skill", name: "Skill" }] } }),
    line({ type: "user", isMeta: true, sourceToolUseID: "skill", message: { content: [{ type: "text", text: "Base directory for this skill: /private/skill" }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall", content: '{"hits":[]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
  ].join("\n");
  const [candidate] = harvestReviewedMisses(session, "session.jsonl");
  assert.equal(candidate.query, "real human request");
});

test("image placeholders cannot become a Recall intent", () => {
  const session = [
    line({ type: "user", isMeta: true, message: { content: [{ type: "text", text: "[Image: source: /private/screenshot.png]" }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall", content: '{"hits":[]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
  ].join("\n");
  assert.deepEqual(harvestReviewedMisses(session, "session.jsonl"), []);
});

test("seeded raw transcript preserves the expected candidate ledger", async () => {
  const fixture = fileURLToPath(new URL("../__fixtures__/reviewed-miss-harvest/explicit-miss.jsonl", import.meta.url));
  const candidates = harvestReviewedMisses(await readFile(fixture, "utf8"), "seed-explicit-miss");
  assert.deepEqual(candidates.map(({ query, status, evidence }) => ({ query, status, evidence })), [{
    query: "where is the deployment rail",
    status: "candidate",
    evidence: { recall: "explicit-miss", sourceReadAfterRecall: true },
  }]);
});

test("harvest CLI retains its first positional session file when no flags are supplied", () => {
  const fixture = fileURLToPath(new URL("../__fixtures__/reviewed-miss-harvest/explicit-miss.jsonl", import.meta.url));
  const script = resolve(import.meta.dirname, "..", "scripts", "harvest-reviewed-misses.ts");
  const result = spawnSync(process.execPath, ["--import", "tsx", script, fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const records = JSON.parse(result.stdout) as Array<{ status: string }>;
  assert.deepEqual(records.map((record) => record.status), ["candidate"]);
});

test("harvest CLI writes only the explicitly requested queue", async () => {
  const fixture = fileURLToPath(new URL("../__fixtures__/reviewed-miss-harvest/explicit-miss.jsonl", import.meta.url));
  const script = resolve(import.meta.dirname, "..", "scripts", "harvest-reviewed-misses.ts");
  const dir = await mkdtemp(join(tmpdir(), "bastra-reviewed-miss-"));
  const output = join(dir, "queue.json");
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", script, "--out", output, fixture], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readdir(dir), ["queue.json"]);
    const records = JSON.parse(await readFile(output, "utf8")) as Array<{ sourceRef: string | null }>;
    assert.match(records[0]?.sourceRef ?? "", /^sha256:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
