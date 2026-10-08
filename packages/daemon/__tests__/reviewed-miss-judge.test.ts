import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewJudgePrompt, buildRung2ReadAttestation, extractReviewTraces, judgeReviewTraces, parseReviewJudgment } from "../src/learned-recall/reviewed-miss-judge.js";

const line = (value: unknown): string => JSON.stringify(value);

test("extracts a post-Read attestation without importing the next topic", () => {
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall", content: '{"hits":[]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "rail content" }] } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "Found it. <rung2-read-attestation>read=exhaustive; recall=miss; vault=note-candidate; why=deployment ownership was absent from Recall</rung2-read-attestation>" }] } }),
    line({ type: "user", message: { content: "what is next" } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "The rail controls deployment ownership." }] } }),
  ].join("\n");
  const [trace] = extractReviewTraces(session, "fixture");
  assert.equal(trace.status, "candidate");
  assert.match(trace.recap ?? "", /Found it/);
  assert.deepEqual(trace.attestation, {
    readCoverage: "exhaustive", recallCoverage: "miss", vault: "note-candidate", why: "deployment ownership was absent from Recall",
  });
  assert.doesNotMatch(buildReviewJudgePrompt(trace), /private\/rail/);
});

test("judge output separates a partial Recall from an exhaustive source note", () => {
  assert.deepEqual(parseReviewJudgment('{"decision":"note-draft","read_coverage":"exhaustive","recall_coverage":"partial","reason":"source resolved a durable missing fact","note":{"title":"Deployment rail","summary":"The rail assigns deployment ownership."}}'), {
    decision: "note-draft", readCoverage: "exhaustive", recallCoverage: "partial", reason: "source resolved a durable missing fact", note: { title: "Deployment rail", summary: "The rail assigns deployment ownership." },
  });
  assert.equal(parseReviewJudgment('```json\n{"decision":"recall-relevant","read_coverage":"exhaustive","recall_coverage":"sufficient","reason":"Recall answered it","note":null}\n```').decision, "recall-relevant");
  assert.equal(parseReviewJudgment("sure, looks good").decision, "uncertain");
});

test("Rung2 attestation names the independent read and vault axes", () => {
  const prompt = buildRung2ReadAttestation();
  assert.match(prompt, /read=exhaustive\|partial\|unresolved/);
  assert.match(prompt, /recall=sufficient\|partial\|miss/);
  assert.match(prompt, /vault=none\|note-candidate/);
});

test("a recorded weak Recall cannot be relabelled sufficient by the judge", async () => {
  const [trace] = extractReviewTraces([
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall", content: '{"weak_result":true,"hits":[]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "rail content" }] } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "<rung2-read-attestation>read=partial; recall=miss; vault=note-candidate; why=ownership fact is absent</rung2-read-attestation>" }] } }),
    line({ type: "user", message: { content: "what is next" } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "The rail controls deployment ownership." }] } }),
  ].join("\n"), "fixture");
  const [judged] = await judgeReviewTraces([trace], async () =>
    '{"decision":"bridge-review","read_coverage":"exhaustive","recall_coverage":"sufficient","reason":"wrong axis","note":null}',
  );
  assert.equal(judged.recallCoverage, "miss");
  assert.equal(judged.readCoverage, "partial");
});

test("a missing attestation does not call the model or classify a note", async () => {
  const [trace] = extractReviewTraces([
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall", content: '{"hits":[]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "rail content" }] } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "Found the deployment rail in the source." }] } }),
  ].join("\n"), "fixture");
  let calls = 0;
  const [judged] = await judgeReviewTraces([trace], async () => {
    calls++;
    return "{}";
  });
  assert.equal(calls, 0);
  assert.equal(judged.decision, "uncertain");
  assert.equal(judged.readCoverage, "unknown");
});
