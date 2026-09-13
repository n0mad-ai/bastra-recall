/**
 * A `replaces` predecessor must not be reported as a trigger collision.
 *
 * `replaces` IS the answer to "this situation is already claimed": the claim
 * gate knows it (`unansweredClaims` marks the whole chain as answered) and
 * lets the save through. But `scoreSaveQuality` runs BEFORE the gate and knew
 * nothing about it, so a correct supersession still shipped a warning about a
 * collision the same call had already resolved. And on `overwrite: true` the
 * gate does not run at all (`tool-handlers.ts`), so nothing downstream could
 * have filtered it either — which is why the exclusion belongs in the report,
 * not in the gate.
 *
 * A collision with an unrelated memory must stay visible: the exclusion is
 * scoped to the chain this save supersedes, nothing else.
 *
 * Runner: `tsx --test __tests__/save-quality-supersession.test.ts`
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
  const dir = await mkdtemp(join(tmpdir(), "bastra-supersession-"));
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

const TRIGGER = "evaluating telemetry for the ingest worker";

const base = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  type: "project-fact",
  summary: "State of the ingest worker telemetry review.",
  topic_path: ["ops", "telemetry"],
  tags: ["telemetry", "ingest"],
  scope: "selftest",
  recall_when: [TRIGGER],
  body: "Numbers from the latest run.",
  ...extra,
});

/** Trigger collisions naming `id`, as the advisory would report them. */
function collisionsWith(result: { save_quality?: { trigger_collisions?: Array<{ claimants?: string[] }> } }): string[] {
  const out = new Set<string>();
  for (const c of result.save_quality?.trigger_collisions ?? []) {
    for (const id of c.claimants ?? []) out.add(id);
  }
  return [...out];
}

test("a normal save reports a real collision with an unrelated memory", async (t) => {
  const { deps, close } = await makeDeps();
  t.after(close);

  await saveMemoryHandler(deps, base("Telemetry Review March"));
  // No `replaces`: the older memory's claim is genuinely unanswered, so the
  // gate holds the save and names it.
  const held = await saveMemoryHandler(deps, base("Telemetry Review April"));

  assert.equal(held.created, false, "an unanswered claim must not create a memory");
  assert.match(JSON.stringify(held), /telemetry-review-march/,
    "the gate must name the memory whose claim is unanswered");
});

test("the replaces predecessor is excluded from collision warnings", async (t) => {
  const { deps, close } = await makeDeps();
  t.after(close);

  const first = await saveMemoryHandler(deps, base("Telemetry Review March"));
  const second = await saveMemoryHandler(
    deps,
    base("Telemetry Review April", { replaces: first.id }),
  );

  assert.equal(second.created, true, "a declared supersession must be written");
  assert.deepEqual(collisionsWith(second), [],
    "the predecessor answered this claim — it must not be reported as a collision");
});

test("the whole replacement chain is excluded, not just the direct predecessor", async (t) => {
  const { deps, close } = await makeDeps();
  t.after(close);

  const v1 = await saveMemoryHandler(deps, base("Telemetry Review March"));
  const v2 = await saveMemoryHandler(deps, base("Telemetry Review April", { replaces: v1.id }));
  const v3 = await saveMemoryHandler(deps, base("Telemetry Review May", { replaces: v2.id }));

  assert.equal(v3.created, true, "the third version must be written");
  assert.deepEqual(collisionsWith(v3), [],
    "v1 is reachable through v2 and must be excluded with it");
});

test("overwrite with replaces reports no collision either (the gate is skipped there)", async (t) => {
  const { deps, close } = await makeDeps();
  t.after(close);

  const first = await saveMemoryHandler(deps, base("Telemetry Review March"));
  await saveMemoryHandler(deps, base("Telemetry Review April", { replaces: first.id }));
  const again = await saveMemoryHandler(
    deps,
    base("Telemetry Review April", { replaces: first.id, overwrite: true, body: "Revised numbers." }),
  );

  assert.deepEqual(collisionsWith(again), [],
    "overwrite skips the gate, so the report itself must not name the superseded predecessor");
});

test("a foreign memory's claim stays visible even when a replaces is declared", async (t) => {
  const { deps, close } = await makeDeps();
  t.after(close);

  const predecessor = await saveMemoryHandler(deps, base("Telemetry Review March"));
  // A second, unrelated memory claiming the SAME situation. Written with the
  // gate answered by `sibling_of`, so the vault legitimately holds two.
  const foreign = await saveMemoryHandler(
    deps,
    base("Ingest Telemetry Notes", { sibling_of: [predecessor.id] }),
  );
  assert.equal(foreign.created, true, "the sibling save must be written");

  const successor = await saveMemoryHandler(
    deps,
    base("Telemetry Review April", { replaces: predecessor.id }),
  );

  const named = collisionsWith(successor);
  assert.ok(!named.includes(predecessor.id), "the superseded predecessor stays excluded");
  assert.ok(named.includes(foreign.id ?? "ingest-telemetry-notes"),
    "an unrelated memory claiming the same situation must still be reported");
});

test("overwrite carries the chain from frontmatter when the payload omits replaces", async (t) => {
  const { deps, close } = await makeDeps();
  t.after(close);

  const first = await saveMemoryHandler(deps, base("Telemetry Review March"));
  await saveMemoryHandler(deps, base("Telemetry Review April", { replaces: first.id }));
  // The realistic update: same memory, new body, and the agent does NOT repeat
  // `replaces` — the supersession is already recorded in its frontmatter.
  const updated = await saveMemoryHandler(
    deps,
    base("Telemetry Review April", { overwrite: true, body: "Revised numbers." }),
  );

  assert.deepEqual(collisionsWith(updated), [],
    "the chain must be read from the stored frontmatter, not only from the payload");
});
