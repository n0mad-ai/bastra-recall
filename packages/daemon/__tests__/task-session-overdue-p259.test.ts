/**
 * #1468/P259 (owner decision 24.11.2026): an overdue, unanswered task or
 * reminder is presented at every session start until the user reacts. The
 * notification cap (max_attempts) no longer applies to the session channel;
 * every other channel keeps it.
 */
import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential, authenticateTask } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readTaskStore } from "../src/task-store.js";
import { reconcileTaskTime } from "../src/task-events.js";
import { taskDueInput, taskDueProjection, recordTaskDelivery } from "../src/task-outbox.js";

test("an unanswered overdue item outlives the delivery cap at session start only", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-session-overdue-"));
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => 3000 };
  const owner = await mintTaskCredential(ctx.authPath, { actor_id: "owner", domains: ["personal"], role: "owner" });
  await callTaskCrud(ctx, `Bearer ${owner.token}`, "task_create", {
    idempotency_key: "overdue",
    original_request: "Remind me of the invented appointment",
    goal: "Invented appointment",
    resolution_condition: "User reacts",
    schedule: { kind: "instant", at: 2000 },
    timezone: "Europe/Berlin",
    scope: { kind: "personal", name: "fixture" },
    owner_domains: ["personal"],
    arm: true,
    notification_policy: { muted: false, retry_interval_ms: 60000, max_attempts: 2 },
  });
  await reconcileTaskTime(ctx);
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "agent", domains: ["personal"], role: "agent" });
  const principal = await authenticateTask(`Bearer ${agent.token}`, ctx.authPath);
  const due = async (channel: "session" | "prompt" | "mcp", now: number) =>
    taskDueProjection(
      await readTaskStore(ctx.path),
      principal,
      taskDueInput.parse({ session: "s", channel }),
      now,
      true
    );

  // Two session starts deliver it and use up the cap of two attempts.
  let now = 3000;
  for (let i = 0; i < 2; i++) {
    const shown = await due("session", now);
    assert.equal(shown.cards.length, 1, `session start ${i + 1}`);
    await recordTaskDelivery(ctx.path, principal, shown.client, shown.occurrenceIds, now, "s", "session");
    now += 2 * 60 * 60 * 1000;
  }
  assert.equal((await due("prompt", now)).cards.length, 0, "other channels keep the cap");
  assert.equal((await due("mcp", now)).cards.length, 0, "other channels keep the cap");
  assert.equal((await due("session", now)).cards.length, 1, "the next session start still presents it");
});
