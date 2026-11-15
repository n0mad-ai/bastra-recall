/**
 * Tests for the `matched_recall_when` hit signal (#148).
 *
 * A recall hit carries `matched_recall_when: true` ONLY when a query term hit the
 * HAND-written `recall_when` field — not the title, body, tags, topic, or the
 * machine-generated `recall_when_expanded`. The hook scope filter uses this bit
 * to let a strong, deliberate cross-scope hit through the #110 foreign-scope
 * hard-filter, while tag/topic-overlap noise stays filtered.
 *
 * Runner: node --import tsx --test packages/core/__tests__/matched-recall-when.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "../src/index.js";

/** A memory where the recall_when trigger is DISTINCT from title / summary / body,
 *  so a query can match exactly one field and we can tell which one fired. */
function memo(id: string, title: string, recallWhen: string, body: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: reference",
    `summary: ${title}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: test-scope",
    "recall_when:",
    `  - ${recallWhen}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

async function makeIndex(): Promise<{ idx: SearchIndex; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-mrw-test-"));
  // Title/body words and the recall_when trigger share NO terms.
  await writeFile(
    join(dir, "scope.md"),
    memo("scope", "telescope assembly manual", "orbital docking procedure", "Notes on telescope assembly manual."),
    "utf8"
  );
  const vault = new Vault(dir);
  await vault.init();
  const idx = new SearchIndex(vault);
  idx.start();
  return { idx, dir };
}

test("matched_recall_when: true when the query hits the hand-written recall_when", async () => {
  const { idx, dir } = await makeIndex();
  try {
    const hits = idx.recall("orbital docking", { k: 5 });
    const hit = hits.find((h) => h.id === "scope");
    assert.ok(hit, "the memory matches on its recall_when trigger");
    assert.equal(hit!.matched_recall_when, true, "a recall_when-field match sets the flag");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("matched_recall_when: false when the query hits only title/body (not recall_when)", async () => {
  const { idx, dir } = await makeIndex();
  try {
    const hits = idx.recall("telescope assembly", { k: 5 });
    const hit = hits.find((h) => h.id === "scope");
    assert.ok(hit, "the memory still matches — on title/summary/body");
    assert.equal(
      hit!.matched_recall_when,
      false,
      "a title/body-only match must NOT set the recall_when flag (this is the #110 noise case)"
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
