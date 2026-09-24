/**
 * #239 — save_quality must exclude the memory being saved from its own
 * duplicate and trigger-collision checks.
 *
 * `scoreSaveQuality` filtered against `input.id`, but the effective id is
 * `input.id ?? slugify(input.title)` and is derived later, inside saveMemory.
 * On the documented normal path the agent sends only a title, so `input.id`
 * was `undefined`, the filter excluded nothing, and every overwrite reported
 * the memory as its own top duplicate — while its own recall_when phrases
 * counted as collisions against itself.
 *
 * Same root cause as #240/C6 (auditedSave classifying slug-inferred
 * overwrites as `create`), which is covered in the core audit tests.
 *
 * Runner: `tsx --test __tests__/save-quality-self-exclusion.test.ts`
 * Real file vault, no mocking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { saveMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";

async function makeDeps(): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-self-exclusion-"));
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dir };
  return {
    deps,
    close: async () => {
      search.stop();
      await vault.stop?.();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

/** The shape an agent actually sends: a title, no explicit id. */
const REFRESH = {
  title: "Deploy Runbook Rollback Steps",
  type: "lesson",
  summary: "How to roll back a failed deploy of the ingest worker.",
  topic_path: ["ops", "deploy"],
  tags: ["deploy", "rollback"],
  scope: "selftest",
  recall_when: [
    "about to roll back a failed ingest deploy",
    "deploy of the ingest worker went wrong",
  ],
  body: "Roll back with the previous image tag, then drain the queue.",
};

test("overwrite without an explicit id does not flag the memory as its own duplicate", async (t) => {
  const { deps, close } = await makeDeps();
  t.after(close);

  const first = await saveMemoryHandler(deps, REFRESH);
  assert.equal(first.created, true);

  // Exactly the same call again — the documented update path.
  const second = await saveMemoryHandler(deps, { ...REFRESH, overwrite: true });
  assert.equal(second.created, false, "second save must be an update");
  assert.ok(second.save_quality); // #542: absent only on a conflict diversion

  const dupIds = second.save_quality.duplicate_candidates.map((c) => c.id);
  assert.ok(
    !dupIds.includes(second.id),
    `the memory must not be its own duplicate candidate, got ${JSON.stringify(dupIds)}`,
  );

  for (const collision of second.save_quality.trigger_collisions) {
    assert.ok(
      !collision.examples.includes(second.id),
      `trigger '${collision.trigger}' must not collide with the memory itself`,
    );
  }
});

test("an explicit id behaves the same as a slug-inferred one", async (t) => {
  const { deps, close } = await makeDeps();
  t.after(close);

  await saveMemoryHandler(deps, { ...REFRESH, id: "explicit-runbook" });
  const again = await saveMemoryHandler(deps, {
    ...REFRESH,
    id: "explicit-runbook",
    overwrite: true,
  });
  assert.ok(again.save_quality); // #542: absent only on a conflict diversion

  const dupIds = again.save_quality.duplicate_candidates.map((c) => c.id);
  assert.ok(!dupIds.includes("explicit-runbook"));
  assert.equal(again.created, false);
});

test("a genuinely different memory is still reported as a candidate", async (t) => {
  const { deps, close } = await makeDeps();
  t.after(close);

  // Guard against 'fixed' by excluding everything: a real neighbour must survive.
  await saveMemoryHandler(deps, REFRESH);
  const sibling = await saveMemoryHandler(deps, {
    ...REFRESH,
    title: "Deploy Runbook Rollback Steps For Staging",
    body: "Same procedure, staging cluster.",
  });

  assert.notEqual(sibling.id, "deploy-runbook-rollback-steps");
  assert.ok(sibling.save_quality); // #542: absent only on a conflict diversion
  const dupIds = sibling.save_quality.duplicate_candidates.map((c) => c.id);
  assert.ok(
    dupIds.includes("deploy-runbook-rollback-steps"),
    `the near-identical sibling must still be surfaced, got ${JSON.stringify(dupIds)}`,
  );
});
