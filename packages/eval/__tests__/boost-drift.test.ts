import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Memory } from "@bastra-recall/core";
import {
  BASE_BOOST,
  TREATMENT_RECALL_WHEN_BOOST,
  EXPANDED_RECALL_WHEN_BOOST,
  buildIndex,
} from "../src/index-config.js";

/**
 * Drift guard. The ablation mirrors core's field weights by hand (the
 * harness must be able to vary ONE knob, which means it can't just import
 * core's hardcoded boost map). This test fails if core's SearchIndex boosts
 * change without the mirror in index-config.ts being updated — so a stale
 * ablation can't quietly report a lift against the wrong baseline.
 */
const searchSrc = readFileSync(resolve(import.meta.dirname, "../../core/src/search.ts"), "utf8");

test("ablation field weights stay in sync with core SearchIndex", () => {
  const expected: Record<string, number> = {
    recall_when_flat: TREATMENT_RECALL_WHEN_BOOST,
    recall_when_expanded_flat: EXPANDED_RECALL_WHEN_BOOST,
    title: BASE_BOOST.title,
    tags_flat: BASE_BOOST.tags_flat,
    topic_path_flat: BASE_BOOST.topic_path_flat,
    summary: BASE_BOOST.summary,
    body: BASE_BOOST.body,
  };
  for (const [field, weight] of Object.entries(expected)) {
    assert.match(
      searchSrc,
      new RegExp(`${field}:\\s*${weight}\\b`),
      `core/src/search.ts should boost ${field} at ${weight} — update index-config.ts if core changed`
    );
  }
});

/**
 * Tokenizer drift guard (#162). Core swapped MiniSearch's default tokenizer
 * for the identifier-preserving `tokenizeWithIdentifiers` on BOTH the index
 * and the query side. The ablation must tokenize identically, or its BM25
 * numbers describe a different index than production. index-config.ts
 * IMPORTS the tokenizer (no hand mirror), so the only drift left to guard is
 * the wiring itself — on both sides.
 */
const indexConfigSrc = readFileSync(resolve(import.meta.dirname, "../src/index-config.ts"), "utf8");

test("tokenizer wiring stays in sync with core SearchIndex", () => {
  assert.match(
    searchSrc,
    /tokenize:\s*tokenizeWithIdentifiers/,
    "core/src/search.ts should wire tokenizeWithIdentifiers as the top-level tokenizer — update index-config.ts if core changed"
  );
  assert.match(
    indexConfigSrc,
    /tokenize:\s*tokenizeWithIdentifiers/,
    "index-config.ts should pass core's tokenizeWithIdentifiers as the top-level tokenizer"
  );
  assert.doesNotMatch(
    indexConfigSrc,
    /searchOptions:[^}]*tokenize/s,
    "no separate searchOptions.tokenize — that would break index/query tokenization symmetry (see core query-normalize.ts)"
  );
});

test("ablation index dual-emits identifiers exactly like core (behavioral pin)", () => {
  const memory = {
    fm: {
      id: "tok-probe",
      title: "vite aliases in my-app.config.ts",
      summary: "alias block mirrors tsconfig paths",
      tags: ["vite"],
      topic_path: ["test"],
      recall_when: ["editing my-app.config.ts build settings"],
    },
    body: "Alias block in my-app.config.ts must mirror tsconfig paths.",
  } as unknown as Memory;
  const idx = buildIndex([memory], { kind: "treatment", boost: TREATMENT_RECALL_WHEN_BOOST });
  const hits = idx.search("my-app.config.ts");
  assert.equal(hits[0]?.id, "tok-probe");
  assert.ok(
    hits[0].terms.includes("my-app.config.ts"),
    `the JOINED identifier must be a matched term, not just its split parts (got: ${hits[0].terms.join(", ")})`
  );
});
