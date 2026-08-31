import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildHotFileTemplate, harvestReviewedMisses } from "../src/learned-recall/reviewed-miss-harvest.js";

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

test("a hot-file template counts only private file evidence relative to its live zone", () => {
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content: '{"hits":[]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/zone/docs/rail.md" } }] } }),
  ].join("\n");
  const records = harvestReviewedMisses(session, "session.jsonl", { includePrivateEvidence: true });
  assert.deepEqual(buildHotFileTemplate(records, "/zone", "deployment"), {
    kind: "recall-hot-files-template/v1",
    zone: "deployment",
    validation: "resolve relative to the live zone root; ignore missing paths",
    excludedEphemeralObservations: 0,
    files: [{ path: "docs/rail.md", observations: 1, explicitMisses: 1, needsRelevanceLabel: 0 }],
  });
});

test("a hot-file template excludes session artifacts even when they are frequent", () => {
  const records = [{
    kind: "reviewed-recall-miss-candidate/v1" as const,
    status: "candidate" as const,
    query: "rail",
    sessionRef: "sha256:session",
    sourceRef: "sha256:source",
    sourcePath: "/tmp/claude-1000/session/scratchpad/rail.md",
    evidence: { recall: "explicit-miss" as const, sourceReadAfterRecall: true as const },
  }];
  assert.deepEqual(buildHotFileTemplate(records, "/tmp/claude-1000", "scratch"), {
    kind: "recall-hot-files-template/v1",
    zone: "scratch",
    validation: "resolve relative to the live zone root; ignore missing paths",
    excludedEphemeralObservations: 1,
    files: [],
  });
});

test("a hot-file template excludes nested Claude tool results", () => {
  const records = [{
    kind: "reviewed-recall-miss-candidate/v1" as const,
    status: "candidate" as const,
    query: "rail",
    sessionRef: "sha256:session",
    sourceRef: "sha256:source",
    sourcePath: "/home/zzalli/.claude/projects/-home-zzalli/session/tool-results/result.txt",
    evidence: { recall: "explicit-miss" as const, sourceReadAfterRecall: true as const },
  }];
  assert.equal(buildHotFileTemplate(records, "/home/zzalli", "arch-home").excludedEphemeralObservations, 1);
});
