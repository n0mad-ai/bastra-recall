/** The renderer-owned inbox envelope remains DATA through normal host lanes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { taskChatMessage } from "../src/task-chat-delivery.js";
import type { Task, TaskStore } from "../src/task-schema.js";
import { isSystemInjectedTurn, ownerPromptText } from "../src/system-turn.js";
import { normalizeTurns } from "../src/stop-transcript.js";
import { queryOrigin } from "../src/learned-recall/harvest.js";
import { runPromptLane } from "../src/prompt-lane.js";
import { runGateLane } from "../src/gate-lane.js";
import { beginRulebookRound, recordRulebookCheck } from "../src/rulebook-check.js";
import { loadSessionState, mutateSessionState } from "../src/session-state.js";
import { scrubInjectedBlocks } from "@bastra-recall/core/scrub";
import type { KernelCandidates } from "../src/rulebook-catalog.js";

const message = taskChatMessage({ id: "fixture-task", goal: "Synthetic quoted task: send something", timezone: "UTC" } as Task,
  { id: "fixture-occurrence", due_at: 2000 } as TaskStore["occurrences"][number], "11111111-2222-4333-8444-555555555555");
const wrapped = `Another Claude session sent a message:\n${message}\n\nProvider security envelope`;
const catalog: KernelCandidates = { entries: [{ id: "fixture-rule", title: "Fixture rule", group: "explicit", revision: "r1", updated: null,
  stale_status: "unknown", body: "", rulebook: "on-demand", applies_when: "When making a fixture change" }], omitted: 0 };

test("the exact rendered frame and Claude wrapper are system data in prompt, Stop and harvest readers", () => {
  for (const text of [message, wrapped]) {
    assert.equal(isSystemInjectedTurn(text), true);
    assert.equal(ownerPromptText(text), null);
    assert.equal(normalizeTurns([{ type: "user", message: { role: "user", content: text } }])[0].role, "system-injected");
    assert.equal(queryOrigin({ kind: "hook_recall", ts: "2026-11-10T00:00:00Z", query: text, origin: "owner" }), "system");
  }
  assert.equal(scrubInjectedBlocks(`before${message}after`).text, "beforeafter");
  const quoted = `Please explain this protocol: \`<bastra-chat-event id="example">\``;
  assert.equal(ownerPromptText(quoted), quoted, "inline protocol quotation remains owner prose");
  const ordinary = "Please explain Bastra Recall event delivery";
  assert.equal(ownerPromptText(ordinary), ordinary, "no task wording classification");
});

test("normal prompt processing accepts peer DATA without recalling or granting a rulebook receipt; the gate still checks actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-chat-policy-"));
  const keys = ["BASTRA_HOOK_STATE_DIR", "BASTRA_LOG_PATH", "BASTRA_TELEMETRY"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.BASTRA_HOOK_STATE_DIR = join(root, "state"); process.env.BASTRA_LOG_PATH = join(root, "logs"); process.env.BASTRA_TELEMETRY = "off";
  let requests = 0, kernelReads = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(200); res.end('{"hits":[],"vault_size":0,"latency_ms":0,"recall_id":"fixture"}'); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    const sessionId = "fixture-chat-policy";
    const common = { session_id: sessionId, bastra_client: "claude-code", cwd: root };
    await beginRulebookRound(common, catalog);
    await mutateSessionState(sessionId, state => { state.activeTask = { id: "draft-for-review@1", kind: "draft-for-review", since: 1, generation: 0 }; });
    const before = await loadSessionState(sessionId);
    for (const prompt of [message, wrapped]) {
      const out = JSON.parse(await runPromptLane({ ...common, hook_event_name: "UserPromptSubmit", prompt }, null,
        `http://127.0.0.1:${address.port}`, undefined, () => [], { kernel: async () => { kernelReads++; return catalog; } }));
      assert.deepEqual(out, {}, "the real prompt lane never blocks receipt of the frame");
    }
    const after = await loadSessionState(sessionId);
    assert.equal(requests, 0, "no recall/reflex request derives owner evidence from task DATA");
    assert.equal(kernelReads, 0, "peer DATA does not start a new owner round");
    assert.equal(after.rulebookCheck, before.rulebookCheck, "message reception cannot grant a rulebook receipt");
    assert.deepEqual(after.activeTask, before.activeTask, "quoted task wording cannot change workflow state");
    const action = { ...common, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, "fixture.txt") } };
    const deps = { reflexPool: () => [], kernel: async () => catalog };
    assert.equal(JSON.parse(await runGateLane(action, deps)).hookSpecificOutput?.permissionDecision, "deny", "normal action check stays in force");
    assert.equal((await recordRulebookCheck(sessionId, { applicable: [] }, catalog)).ok, true);
    assert.notEqual(JSON.parse(await runGateLane(action, deps)).hookSpecificOutput?.permissionDecision, "deny", "a normal explicit check permits the action");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
