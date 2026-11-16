import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./tasks-opt-in.js";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readTaskStore } from "../src/task-store.js";
import { writeAppRecord } from "../src/app-record-store.js";
import { reconcileTaskTime } from "../src/task-events.js";

for (const rows of [9898, 9900])
  test(`event burst at ${rows} history rows and later expiry must not stop unrelated reminder`, async () => {
    const root = await mkdtemp(join(tmpdir(), "review121-history-"));
    let now = 1000;
    const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => now };
    const owner = await mintTaskCredential(ctx.authPath, { actor_id: "owner", domains: ["personal"], role: "owner" });
    const auth = `Bearer ${owner.token}`;
    const input = {
      idempotency_key: "event-task",
      original_request: "Evaluate",
      goal: "Evaluate",
      resolution_condition: "Owner evaluation",
      expires_at: 4000,
      timezone: "Europe/Berlin",
      scope: { kind: "personal", name: "fixture" },
      owner_domains: ["personal"],
      arm: true,
    };
    await callTaskCrud(ctx, auth, "task_source_register", {
      id: "source",
      kind: "event",
      producer_actor: "owner",
      owner_domains: ["personal"],
      sensitivity: "private",
      max_age_ms: 10000,
      enabled: true,
    });
    await callTaskCrud(ctx, auth, "task_create", {
      ...input,
      schedule: { kind: "event", source_id: "source", predicate: "equals", expected: "yes" },
    });
    await callTaskCrud(ctx, auth, "task_create", {
      ...input,
      idempotency_key: "once",
      original_request: "One reminder",
      goal: "One reminder",
      expires_at: 10000,
      schedule: { kind: "instant", at: 5000 },
    });
    for (const [i, value] of ["yes", "no", "yes", "no", "yes"].entries())
      await callTaskCrud(ctx, auth, "task_event", {
        source_id: "source",
        source_revision: 0,
        dedup_key: `event-${i}`,
        value,
        state_updated_at: 1000,
      });
    const before = await readTaskStore(ctx.path);
    const eventTask = before.tasks.find((t) => t.schedule.kind === "event")!;
    const row = eventTask.history[0];
    while (eventTask.history.length < rows) eventTask.history.push({ ...row, operation: "fire", reason: "fire" });
    await writeAppRecord("tasks", ctx.path, JSON.stringify(before));
    now = 3000;
    let after = await reconcileTaskTime(ctx);
    assert.equal(after.tasks.find((t) => t.id === eventTask.id)!.armed, false);
    assert.equal(after.tasks.find((t) => t.id === eventTask.id)!.last_failure?.code, "history_capacity");
    now = 6000;
    after = await reconcileTaskTime(ctx);
    assert.equal(after.tasks.find((t) => t.goal === "One reminder")!.state, "due");
  });
