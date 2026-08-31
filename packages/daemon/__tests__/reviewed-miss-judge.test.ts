import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewJudgePrompt, extractReviewTraces, parseReviewJudgment } from "../src/learned-recall/reviewed-miss-judge.js";

const line = (value: unknown): string => JSON.stringify(value);

test("extracts recap after Read result and exactly one later reply", () => {
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall", content: '{"hits":[]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "rail content" }] } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "Found the deployment rail in the source." }] } }),
    line({ type: "user", message: { content: "what is next" } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "The rail controls deployment ownership." }] } }),
  ].join("\n");
  const [trace] = extractReviewTraces(session, "fixture");
  assert.equal(trace.status, "candidate");
  assert.equal(trace.recap, "Found the deployment rail in the source.");
  assert.equal(trace.nextReply, "The rail controls deployment ownership.");
  assert.doesNotMatch(buildReviewJudgePrompt(trace), /private\/rail/);
});

test("judge output fails closed and keeps a valid note draft bounded", () => {
  assert.deepEqual(parseReviewJudgment('{"decision":"note-draft","reason":"source resolved a durable missing fact","note":{"title":"Deployment rail","summary":"The rail assigns deployment ownership."}}'), {
    decision: "note-draft", reason: "source resolved a durable missing fact", note: { title: "Deployment rail", summary: "The rail assigns deployment ownership." },
  });
  assert.equal(parseReviewJudgment('```json\n{"decision":"recall-relevant","reason":"Recall answered it","note":null}\n```').decision, "recall-relevant");
  assert.equal(parseReviewJudgment("sure, looks good").decision, "uncertain");
});
