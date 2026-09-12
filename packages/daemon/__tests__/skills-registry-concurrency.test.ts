/**
 * #533 — concurrent skill declarations reported success while losing registry
 * entries. `addSkill()` repeated the read-modify-write race #240/A9 fixed for
 * the floor registry: every concurrent call read the same snapshot, every call
 * returned its entry as a success, and the last rename left one arbitrary
 * winner. Measured on the broken code: 40 unique adds → 40 reported successes,
 * 1 persisted entry. `MAX_SKILLS` was defeated the same way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSkill, removeSkill, listSkills, MAX_SKILLS } from "../src/skills-registry.js";

async function withRegistry(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-skills-533-"));
  try {
    await fn(join(dir, "skills.json"));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("#533 — concurrent adds keep the whole durable union, not one winner", async () => {
  await withRegistry(async (path) => {
    const ids = Array.from({ length: 40 }, (_, i) => `concurrent-skill-${i}`);
    const results = await Promise.allSettled(ids.map((id) => addSkill({ id }, path)));
    const reported = results.filter((r) => r.status === "fulfilled").length;
    const persisted = await listSkills(path);

    assert.equal(reported, ids.length, "every add below the cap must report success");
    // Reported success must mean durable success: the caller's entry is in the
    // persisted union by the time its promise resolves.
    assert.equal(
      persisted.length,
      ids.length,
      `${reported} successes must leave ${ids.length} entries, got ${persisted.length}`,
    );
    assert.deepEqual(persisted.map((e) => e.id).sort(), [...ids].sort());
  });
});

test("#533 — a duplicate id concurrently upserts instead of multiplying", async () => {
  await withRegistry(async (path) => {
    await Promise.all(Array.from({ length: 20 }, () => addSkill({ id: "same-skill", note: "n" }, path)));
    const persisted = await listSkills(path);
    assert.deepEqual(persisted.map((e) => e.id), ["same-skill"]);
  });
});

test("#533 — the cap is enforced against the durable state, not an in-memory snapshot", async () => {
  await withRegistry(async (path) => {
    const over = MAX_SKILLS + 20;
    const results = await Promise.allSettled(
      Array.from({ length: over }, (_, i) => addSkill({ id: `capped-${i}` }, path)),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    const persisted = await listSkills(path);

    assert.equal(persisted.length, MAX_SKILLS, `the durable registry must stop at ${MAX_SKILLS}`);
    assert.equal(ok, MAX_SKILLS, "exactly the entries that fit may report success");
    assert.equal(rejected, over - MAX_SKILLS, "every add beyond the cap must be rejected, not silently dropped");
    for (const r of results) {
      if (r.status === "rejected") assert.match((r.reason as Error).message, /skills cap reached/);
    }
  });
});

test("#533 — a concurrent remove is not undone by an overlapping add", async () => {
  await withRegistry(async (path) => {
    await addSkill({ id: "doomed" }, path);
    await addSkill({ id: "keeper" }, path);
    const [removed] = await Promise.all([
      removeSkill("doomed", path),
      addSkill({ id: "newcomer" }, path),
    ]);
    assert.equal(removed, true);
    const ids = (await listSkills(path)).map((e) => e.id).sort();
    assert.deepEqual(ids, ["keeper", "newcomer"], "the remove and the add must both survive");
  });
});
