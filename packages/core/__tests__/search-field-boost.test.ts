/**
 * The field-boost table is the documented "Search ranking" contract
 * (packages/daemon/README.md): an author-written recall_when trigger outranks the
 * same word buried in a body. Night 09-22: swapping the two extremes
 * (recall_when_flat 5→1, body 1→5) left all 571 core tests green — nothing pinned
 * the table or its effect. Two bites here: the exported table
 * must be the README's, and the effect must hold on a two-memory vault.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";
import { FIELD_BOOST, SearchIndex } from "../src/search.js";

const DOCUMENTED: Record<string, number> = {
  recall_when_flat: 5,
  title: 4,
  tags_flat: 3,
  recall_when_expanded_flat: 2,
  topic_path_flat: 2,
  summary: 2,
  body: 1,
};

function md(id: string, opts: { recallWhen: string; body: string; title: string }): string {
  return `---
id: ${id}
title: ${opts.title}
type: lesson
summary: plain summary
topic_path: [t]
tags: [t]
scope: t
recall_when: ["${opts.recallWhen}"]
created: 2026-01-01
updated: 2026-07-01
---

${opts.body}
`;
}

test("field boosts in search.ts are the README's numbers", () => {
  // Exact equality: a changed weight, a dropped field and an undocumented new one all fail.
  assert.deepEqual({ ...FIELD_BOOST }, DOCUMENTED);
});

test("an authored recall_when trigger outranks the same word in a body", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-boost-"));
  try {
    await writeFile(path.join(dir, "a.md"), md("trigger-side", {
      title: "first note", recallWhen: "zebrafog", body: "Body text without the word.",
    }));
    await writeFile(path.join(dir, "b.md"), md("body-side", {
      title: "second note", recallWhen: "unrelated", body: "Body text with zebrafog once.",
    }));
    const vault = new Vault(dir);
    await vault.init();
    const search = new SearchIndex(vault);
    search.start();
    try {
      const hits = search.recall("zebrafog");
      assert.equal(hits.length, 2, "both memories match the word");
      assert.equal(hits[0].id, "trigger-side", "recall_when (5) must beat body (1)");
      assert.ok(hits[0].score > hits[1].score);
    } finally {
      search.stop();
      await vault.stop?.();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
