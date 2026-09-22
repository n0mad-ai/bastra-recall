/**
 * Tests für die Doc-Dämpfung im Default-Recall (Produkt-Doku-Feature).
 *
 * type="doc"-Hits (Document-Sidecars + Produkt-Doku in dokumentationen/)
 * werden im Default-Recall mit DOC_TYPE_DAMPING (0.5) gedämpft, damit lange
 * Doc-Bodies Lessons nicht aus den Top-k drängen. Mit explizitem type-Filter
 * (= die find_document-Lane) ranken Docs ungedämpft.
 *
 * Runner: `node --import tsx --test packages/core/__tests__/doc-damping.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "../src/index.js";
import { DOC_TYPE_DAMPING } from "../src/search.js";

function memoryMarkdown(id: string, title: string, type: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    `type: ${type}`,
    `summary: ${title} summary`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: damping-test",
    "recall_when:",
    `  - ${title}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body for ${title}.`,
    "",
  ].join("\n");
}

async function makeIndex(): Promise<{ search: SearchIndex; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-doc-damping-"));
  await writeFile(join(dir, "lesson.md"), memoryMarkdown("zebra-lesson", "zebra handling", "lesson"), "utf8");
  await writeFile(join(dir, "doc.md"), memoryMarkdown("zebra-doc", "zebra handling", "doc"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  return {
    search,
    close: async () => {
      search.stop();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test("default recall dampens doc hits, lesson keeps its score", async () => {
  const { search, close } = await makeIndex();
  try {
    // Undamped reference scores via explicit type filters.
    const docOnly = search.recall("zebra handling", { type: "doc" });
    const lessonOnly = search.recall("zebra handling", { type: "lesson" });
    assert.equal(docOnly.length, 1);
    assert.equal(lessonOnly.length, 1);

    const mixed = search.recall("zebra handling");
    const docHit = mixed.find((h) => h.id === "zebra-doc");
    const lessonHit = mixed.find((h) => h.id === "zebra-lesson");
    assert.ok(docHit, "doc must still be findable in default recall");
    assert.ok(lessonHit, "lesson must appear in default recall");

    // Identische Memories bis auf type → identischer BM25-Roh-Score. Der
    // doc-Hit muss exakt um DOC_TYPE_DAMPING gedämpft sein, die Lesson nicht.
    assert.equal(lessonHit.score, lessonOnly[0].score);
    // The docstring promises 0.5. Computing the expectation through DOC_TYPE_DAMPING itself made
    // any change to the constant invisible (night 09-22) — the number is the contract here.
    assert.equal(DOC_TYPE_DAMPING, 0.5, "the shipped damping is the documented 0.5");
    const expected = Math.round(docOnly[0].score * 0.5 * 1000) / 1000;
    assert.equal(docHit.score, expected);
    assert.ok(docHit.score < lessonHit.score, "doc must rank below the equally-matching lesson");
  } finally {
    await close();
  }
});

test("explicit type:doc filter ranks docs undamped", async () => {
  const { search, close } = await makeIndex();
  try {
    const docOnly = search.recall("zebra handling", { type: "doc" });
    const lessonOnly = search.recall("zebra handling", { type: "lesson" });
    // Gleiches Memory bis auf type — ohne Dämpfung wären beide Scores gleich.
    assert.equal(docOnly[0].score, lessonOnly[0].score);
  } finally {
    await close();
  }
});
