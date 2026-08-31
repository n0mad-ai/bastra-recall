import assert from "node:assert/strict";
import test from "node:test";
import { harvestReviewedMisses } from "../src/learned-recall/reviewed-miss-harvest.js";

function line(value: unknown): string { return JSON.stringify(value); }

test("harvest keeps an explicit Recall miss separate from its later source", () => {
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__bastra-recall__recall", input: { query: "rail" } }], weak_result: true } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
  ].join("\n");
  const [candidate] = harvestReviewedMisses(session, "session.jsonl");
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.query, "where is the deployment rail");
  assert.match(candidate.sourceRef ?? "", /^sha256:/);
  assert.doesNotMatch(JSON.stringify(candidate), /private|rail\.md/);
});

test("nonempty Recall chains remain unreviewed rather than becoming false misses", () => {
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__bastra-recall__recall", input: { query: "rail" } }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
  ].join("\n");
  assert.equal(harvestReviewedMisses(session, "session.jsonl")[0].status, "needs-relevance-label");
});
