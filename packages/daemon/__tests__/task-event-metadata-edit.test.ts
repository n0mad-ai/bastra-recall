import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential, authenticateTask } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { reconcileTaskTime } from "../src/task-events.js";
import { readTaskStore } from "../src/task-store.js";
import { taskDueProjection, taskDueInput } from "../src/task-outbox.js";

for (const field of ["scope", "expires_at"])
  for (const acknowledged of [false, true])
    test(`event reminder keeps its occurrence after ${field} edit (acknowledged=${acknowledged})`, async () => {
      const root = await mkdtemp(join(tmpdir(), "review121-event-edit-"));
      const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => 1000 };
      const cred = await mintTaskCredential(ctx.authPath, { actor_id: "owner", domains: ["personal"], role: "owner" });
      const auth = `Bearer ${cred.token}`;
      const principal = await authenticateTask(auth, ctx.authPath);
      await callTaskCrud(ctx, auth, "task_source_register", {
        id: "source",
        kind: "event",
        producer_actor: "owner",
        owner_domains: ["personal"],
        sensitivity: "private",
        max_age_ms: 10000,
        enabled: true,
      });
      let task: any = await callTaskCrud(ctx, auth, "task_create", {
        idempotency_key: "event-edit",
        original_request: "Observe yes",
        goal: "Observe yes",
        resolution_condition: "Owner evaluation",
        schedule: { kind: "event", source_id: "source", predicate: "equals", expected: "yes" },
        timezone: "Europe/Berlin",
        scope: { kind: "personal", name: "initial" },
        owner_domains: ["personal"],
        arm: true,
      });
      await callTaskCrud(ctx, auth, "task_event", {
        source_id: "source",
        source_revision: 0,
        dedup_key: "yes",
        value: "yes",
        state_updated_at: 1000,
      });
      let store = await reconcileTaskTime(ctx);
      assert.equal(taskDueProjection(store, principal, taskDueInput.parse({}), 1000).cards.length, 1);
      task = await callTaskCrud(ctx, auth, "task_get", { id: task.id });
      const occurrenceId = store.occurrences[0].id;
      if (acknowledged)
        task = await callTaskCrud(ctx, auth, "task_acknowledge", {
          id: task.id,
          expected_revision: task.expected_revision,
          occurrence_id: occurrenceId,
        });
      await callTaskCrud(ctx, auth, "task_edit", {
        id: task.id,
        expected_revision: task.expected_revision,
        patch: field === "scope" ? { scope: { kind: "personal", name: "renamed" } } : { expires_at: 5000 },
      });
      await reconcileTaskTime(ctx);
      store = await readTaskStore(ctx.path);
      const cards = taskDueProjection(store, principal, taskDueInput.parse({}), 1000).cards;
      assert.equal(cards.length, 1, "the reminder remains visible in owner inspection");
      assert.equal(store.occurrences.length, 1);
      assert.equal(store.occurrences[0].id, occurrenceId);
      assert.equal(store.tasks[0].generation, 0);
      assert.equal(!!store.occurrences[0].acknowledgement, acknowledged);
      assert.equal(
        taskDueProjection(store, principal, taskDueInput.parse({}), 1000, true).cards.length,
        acknowledged ? 0 : 1
      );
    });
