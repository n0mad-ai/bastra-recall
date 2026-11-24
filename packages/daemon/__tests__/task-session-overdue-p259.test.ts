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
  const due = async (channel: "session" | "prompt" | "mcp", now: number, max_bytes = 2048) =>
    taskDueProjection(
      await readTaskStore(ctx.path),
      principal,
      taskDueInput.parse({ session: "s", channel, max_bytes }),
      now,
      true
    );

  assert.equal((await due("session", 2000)).cards[0]?.state, undefined, "exactly due is not yet overdue");
  assert.equal((await due("prompt", 3000)).cards[0]?.state, undefined, "only session starts mark overdue reminders");
  const compact = (await due("session", 3000, 760)).cards[0];
  assert.equal(compact?.compact, true);
  assert.equal(compact?.state, "overdue");
  assert.match(String(compact?.decision_hint), /Overdue.*please decide/);

  // Two session starts deliver it and use up the cap of two attempts.
  let now = 3000;
  for (let i = 0; i < 2; i++) {
    const shown = await due("session", now);
    assert.equal(shown.cards.length, 1, `session start ${i + 1}`);
    assert.equal(shown.cards[0].state, "overdue");
    assert.match(String(shown.cards[0].decision_hint), /Overdue.*please decide/);
    assert.deepEqual(shown.cards[0].controls, ["acknowledge", "snooze", "resolve", "cancel"]);
    await recordTaskDelivery(ctx.path, principal, shown.client, shown.occurrenceIds, now, "s", "session");
    now += 1;
  }
  now += 2 * 60 * 60 * 1000;
  assert.equal((await due("prompt", now)).cards.length, 0, "other channels keep the cap");
  assert.equal((await due("mcp", now)).cards.length, 0, "other channels keep the cap");
  const next = await due("session", now);
  assert.equal(next.cards.length, 1, "the next session start still presents it");
  await callTaskCrud(ctx, `Bearer ${owner.token}`, "task_acknowledge", {
    id: next.cards[0].task_id,
    expected_revision: next.cards[0].expected_revision,
    occurrence_id: next.cards[0].occurrence_id,
  });
  assert.equal((await due("session", now)).cards.length, 0, "an acknowledged item is omitted");
});
