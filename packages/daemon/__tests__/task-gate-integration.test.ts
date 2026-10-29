/** #1306 / #1305 / #1303: task metadata survives the real gate/load paths. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGateLane } from "../src/gate-lane.js";
import { runTaskStep } from "../src/prompt-task.js";
import {
  bookPendingMustLoad,
  clearPendingMustLoad,
  loadSessionState,
  mutateSessionState,
} from "../src/session-state.js";
import { scrubInjectedBlocks } from "@bastra-recall/core/scrub";

let dir: string;
const previous = process.env.BASTRA_HOOK_STATE_DIR;
const validator = { tool: "validate_artifact", channel: "discord", limit: 2000, unit: "code-points" };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "bastra-task-gate-"));
  process.env.BASTRA_HOOK_STATE_DIR = dir;
});
after(async () => {
  if (previous === undefined) delete process.env.BASTRA_HOOK_STATE_DIR;
  else process.env.BASTRA_HOOK_STATE_DIR = previous;
  await rm(dir, { recursive: true, force: true });
});

for (const scope of [undefined, "task"] as const) {
  test(`gate claim and successful load preserve ${scope ?? "session"} scope and validator`, async () => {
    const sessionId = `task-gate-${scope ?? "session"}`;
    await mutateSessionState(sessionId, (s) => {
      s.activeTask = { kind: "draft-for-review", since: 1, generation: 0 };
      s.activeConventions = [{ id: "rule", revision: "old", setAt: 1, ...(scope ? { scope } : {}), validator }];
      bookPendingMustLoad(s, ["rule"], "prompt:first", 1);
    });
    const action = {
      session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Edit",
      bastra_client: "claude-code", tool_input: { file_path: "/fixture.txt" },
    };
    const first = JSON.parse(await runGateLane(action, { reflexPool: () => [] }));
    assert.equal(first.hookSpecificOutput.permissionDecision, "deny");
    assert.equal((await loadSessionState(sessionId)).pendingMustLoad, undefined);
    await clearPendingMustLoad("rule", { revision: "new" });
    const loaded = await loadSessionState(sessionId);
    assert.equal(loaded.claimedMustLoad, undefined);
    assert.equal(loaded.activeConventions?.[0]?.scope, scope);
    assert.deepEqual(loaded.activeConventions?.[0]?.validator, validator);
    assert.equal(loaded.activeConventions?.[0]?.revision, "new");

    // A deduped, already-loaded rule can activate the task without booking a
    // second must-load; its metadata survives task reactivation and reload.
    const block = await runTaskStep({
      sessionId, snapshot: loaded, prompt: "Bitte einen Antwortentwurf erstellen",
      mode: "generic", candidates: [{ id: "rule", type: "workflow", matched_recall_when: true }],
      revisionOf: async () => "new", surface: "claude-code",
    });
    assert.match(block!, /validator: tool=validate_artifact channel=discord limit=2000 unit=code-points/);
    assert.equal(scrubInjectedBlocks(`before${block}after`).text, "beforeafter");
    const state = await loadSessionState(sessionId);
    assert.equal(state.activeConventions?.[0]?.scope, scope);
    assert.deepEqual(state.activeConventions?.[0]?.validator, validator);
    assert.equal(state.pendingMustLoad, undefined);
    assert.equal(state.claimedMustLoad, undefined);
    const retry = JSON.parse(await runGateLane(action, { reflexPool: () => [] }));
    assert.notEqual(retry.hookSpecificOutput?.permissionDecision, "deny");
  });
}
