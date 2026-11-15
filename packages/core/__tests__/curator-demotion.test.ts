/**
 * Curator demotion (#155) — the engine half of the deterministic staleness
 * pass, pinned as a survival-by-id arm: setDemotions() halves the recall
 * score of a demoted memory and does NOTHING else. By-id resolution, the
 * file on disk, and un-demoted neighbors are untouched; clearing the set
 * restores the original score exactly (demotion is state, not history).
 *
 * Runner: node --import tsx --test packages/core/__tests__/curator-demotion.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { SearchIndex, CURATOR_DEMOTION_MULTIPLIER } from "../src/search.js";

function memoryMarkdown(id: string, title: string): string {
  const now = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: lesson",
    `summary: probe for ${title}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: test-scope",
    "recall_when:",
    `  - ${title}`,
    `created: ${now}`,
    `updated: ${now}`,
    "---",
    "",
    `Body about zebra migrations for ${title}.`,
    "",
  ].join("\n");
}

test("survival-by-id: curator demotion is score-only and fully reversible", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-curator-demote-"));
  await writeFile(join(dir, "demoted.md"), memoryMarkdown("demoted", "zebra migration lesson"), "utf8");
  await writeFile(join(dir, "neighbor.md"), memoryMarkdown("neighbor", "zebra migration checklist"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const idx = new SearchIndex(vault);
  idx.start();
  try {
    const fileBefore = await readFile(join(dir, "demoted.md"), "utf8");
    const before = idx.recall("zebra migration", { k: 5 });
    const beforeDemoted = before.find((h) => h.id === "demoted");
    const beforeNeighbor = before.find((h) => h.id === "neighbor");
    assert.ok(beforeDemoted && beforeNeighbor, "both memories rank before the demotion");

    idx.setDemotions(["demoted"]);
    const during = idx.recall("zebra migration", { k: 5 });
    const duringDemoted = during.find((h) => h.id === "demoted");
    const duringNeighbor = during.find((h) => h.id === "neighbor");

    // demoted: exactly the multiplier, still findable
    assert.ok(duringDemoted, "demoted memory is still findable (demote ≠ hide)");
    assert.ok(
      Math.abs(duringDemoted!.score - beforeDemoted!.score * CURATOR_DEMOTION_MULTIPLIER) < 0.01,
      `score is ×${CURATOR_DEMOTION_MULTIPLIER} (was ${beforeDemoted!.score}, got ${duringDemoted!.score})`
    );
    // neighbor: untouched
    assert.equal(duringNeighbor!.score, beforeNeighbor!.score, "un-demoted neighbor keeps its score");
    // by-id resolution + file: untouched
    assert.ok(vault.get("demoted"), "by-id resolution survives the demotion");
    assert.equal(await readFile(join(dir, "demoted.md"), "utf8"), fileBefore, "file is byte-identical");

    // reactivation: clearing the set restores the exact original score
    idx.setDemotions([]);
    const after = idx.recall("zebra migration", { k: 5 });
    assert.equal(after.find((h) => h.id === "demoted")!.score, beforeDemoted!.score, "reversible");
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
