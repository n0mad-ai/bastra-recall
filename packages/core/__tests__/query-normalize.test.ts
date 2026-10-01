/**
 * Tests for the query normalizer + identifier-preserving tokenizer (#162).
 *
 * Code-lesson queries carry dotted/hyphenated/underscored identifiers
 * (`my-app.config.ts`, `chat-send`, `P2.2`, `--force-push`). The shared
 * tokenizer dual-emits (joined identifier + split parts) on BOTH the index
 * and the query side, so precision improves without losing any match the
 * old split-only tokenization produced. `normalizeQuery` adds hostile-input
 * hygiene (length cap, whitespace collapse, dangling boolean-ish operators)
 * at the SearchIndex.recall entry — MCP and hook paths both run through it.
 *
 * Runner: node --import tsx --test packages/core/__tests__/query-normalize.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "../src/index.js";
import {
  normalizeQuery,
  tokenizeWithIdentifiers,
  capAtWordBoundary,
  QUERY_MAX_CHARS,
} from "../src/query-normalize.js";

// ─── tokenizer matrix ────────────────────────────────────────────

test("tokenizer: dual-emits dotted identifier plus its parts", () => {
  assert.deepEqual(tokenizeWithIdentifiers("my-app.config.ts"), [
    "my-app.config.ts",
    "my",
    "app",
    "config",
    "ts",
  ]);
});

test("tokenizer: hyphenated command name stays a unit", () => {
  assert.deepEqual(tokenizeWithIdentifiers("chat-send"), ["chat-send", "chat", "send"]);
});

test("tokenizer: leading punctuation is trimmed (--force-push)", () => {
  assert.deepEqual(tokenizeWithIdentifiers("--force-push"), [
    "force-push",
    "force",
    "push",
  ]);
});

test("tokenizer: versioned identifier P2.2 survives", () => {
  assert.deepEqual(tokenizeWithIdentifiers("P2.2 release"), ["P2.2", "P2", "2", "release"]);
});

test("tokenizer: snake_case survives", () => {
  assert.deepEqual(tokenizeWithIdentifiers("snake_case_name"), [
    "snake_case_name",
    "snake",
    "case",
    "name",
  ]);
});

test("tokenizer: plain prose is unchanged vs. split-only tokenization", () => {
  assert.deepEqual(tokenizeWithIdentifiers("plain words here"), ["plain", "words", "here"]);
});

test("tokenizer: sentence-final period does not create a fake identifier", () => {
  assert.deepEqual(tokenizeWithIdentifiers("edit the config."), ["edit", "the", "config"]);
});

test("tokenizer: path separators and colons still split (file segments survive)", () => {
  assert.deepEqual(tokenizeWithIdentifiers("src/search.ts:42"), [
    "src",
    "search.ts",
    "search",
    "ts",
    "42",
  ]);
});

test("tokenizer: punctuation-only input yields no tokens", () => {
  assert.deepEqual(tokenizeWithIdentifiers("... --- ___"), []);
  assert.deepEqual(tokenizeWithIdentifiers(""), []);
});

// ─── normalizeQuery matrix ───────────────────────────────────────

test("normalizeQuery: collapses whitespace and trims", () => {
  assert.equal(normalizeQuery("  foo \n\t bar  "), "foo bar");
});

test("normalizeQuery: strips dangling boolean-ish operators at both ends", () => {
  assert.equal(normalizeQuery("foo AND"), "foo");
  assert.equal(normalizeQuery("AND foo"), "foo");
  assert.equal(normalizeQuery("NOT and foo bar && ||"), "foo bar");
});

test("normalizeQuery: operator-only query becomes empty", () => {
  assert.equal(normalizeQuery("AND OR NOT"), "");
  assert.equal(normalizeQuery("+ - !"), "");
});

test("normalizeQuery: inner operators and operator-like identifiers survive", () => {
  assert.equal(normalizeQuery("foo - bar"), "foo - bar");
  assert.equal(normalizeQuery("--force-push crashes"), "--force-push crashes");
  assert.equal(normalizeQuery("git push --force"), "git push --force");
});

test("normalizeQuery: identifiers stay byte-identical", () => {
  assert.equal(normalizeQuery("my-app.config.ts chat-send P2.2"), "my-app.config.ts chat-send P2.2");
});

test("normalizeQuery: caps hostile input at QUERY_MAX_CHARS", () => {
  const hostile = "x".repeat(50_000);
  assert.ok(normalizeQuery(hostile).length <= QUERY_MAX_CHARS);
});

// ─── cap semantics (#162: defense cap, not a relevance knob) ─────

test("cap: QUERY_MAX_CHARS is 8000 — hostile-input defense must not truncate pasted stack traces", () => {
  // The 1000-char cap silently dropped discriminating identifiers from long
  // hook prompts on BOTH search arms. 8000 keeps legitimate prompts intact.
  assert.equal(QUERY_MAX_CHARS, 8000);
});

test("capAtWordBoundary: text within the cap is returned byte-identical", () => {
  assert.equal(capAtWordBoundary("aaa bbb ccc", 11), "aaa bbb ccc");
  assert.equal(capAtWordBoundary("aaa bbb ccc", 500), "aaa bbb ccc");
});

test("capAtWordBoundary: never cuts mid-token — partial trailing token is dropped", () => {
  // index 9 is inside "ccc" → the partial token must go, not be halved
  assert.equal(capAtWordBoundary("aaa bbb ccc", 9), "aaa bbb");
  assert.equal(capAtWordBoundary("aaa bbb ccc", 5), "aaa");
});

test("capAtWordBoundary: cut landing exactly on whitespace keeps the full last token", () => {
  // index 7 is the space after "bbb"
  assert.equal(capAtWordBoundary("aaa bbb ccc", 7), "aaa bbb");
});

test("capAtWordBoundary: cut landing right after whitespace drops the next token cleanly", () => {
  // index 8 is the first char of "ccc" — head ends in a space
  assert.equal(capAtWordBoundary("aaa bbb ccc", 8), "aaa bbb");
});

test("capAtWordBoundary: single whitespace-free monster token falls back to a hard cut", () => {
  assert.equal(capAtWordBoundary("x".repeat(100), 10), "x".repeat(10));
});

test("capAtWordBoundary: a hard cut never leaves half of an astral character", () => {
  // 𠮷 and 😀 are two UTF-16 units each; a cut between them left a lone high
  // surrogate, which is not text.
  const kanji = "𠮷".repeat(10);
  const cut = capAtWordBoundary(kanji, 7);
  assert.equal(cut, "𠮷".repeat(3));
  assert.ok(!/[\uD800-\uDBFF]$/.test(capAtWordBoundary("😀".repeat(10), 5)), "no dangling high surrogate");
  assert.equal(capAtWordBoundary("😀".repeat(10), 6), "😀".repeat(3), "an even cut keeps whole characters");
});

test("normalizeQuery: long hook prompt keeps identifiers past the old 1000-char cap", () => {
  // Regression for #162: a pasted stack trace pushed the discriminating
  // identifier past the old slice(0, 1000) and it vanished from the query.
  const stackNoise = "at Object.handler (webpack-internal:///./src/foo.ts) ".repeat(40); // > 2000 chars
  const query = `${stackNoise} my-app.config.ts crashes on rebuild`;
  assert.ok(query.length > 1000 && query.length < QUERY_MAX_CHARS);
  assert.ok(
    normalizeQuery(query).includes("my-app.config.ts"),
    "identifier beyond the old cap must survive normalization",
  );
});

test("normalizeQuery: over-cap query is cut at a word boundary, never mid-token", () => {
  // 1599 × "word " = 7995 chars; the straddler starts at 7995 so index 8000
  // falls inside it — the partial token must be dropped entirely.
  const query = "word ".repeat(1599) + "identifier-straddling-the-cap";
  const normalized = normalizeQuery(query);
  assert.ok(normalized.length <= QUERY_MAX_CHARS);
  assert.ok(normalized.endsWith("word"), "cut falls back to the last full token");
  assert.ok(!normalized.includes("ident"), "no fragment of the straddling token survives");
});

test("normalizeQuery: idempotent", () => {
  const q = "  foo AND  my-app.config.ts OR ";
  assert.equal(normalizeQuery(normalizeQuery(q)), normalizeQuery(q));
});

// ─── retrieval fixtures (index + query symmetry) ─────────────────

/** Identifier-heavy memory fixture — recall_when/title carry the identifiers. */
function memo(
  id: string,
  title: string,
  recallWhen: string,
  body: string,
): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: lesson",
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
  const dir = await mkdtemp(join(tmpdir(), "bastra-qnorm-test-"));
  // Target: identifier appears verbatim in recall_when + title.
  await writeFile(
    join(dir, "cfg.md"),
    memo(
      "cfg",
      "vite aliases in my-app.config.ts",
      "editing my-app.config.ts build settings",
      "Alias block in my-app.config.ts must mirror tsconfig paths.",
    ),
    "utf8",
  );
  // Decoy: carries the generic split parts but NOT the joined identifier.
  await writeFile(
    join(dir, "decoy.md"),
    memo(
      "decoy",
      "general app housekeeping",
      "app config ts cleanup chores",
      "Misc notes about app config and ts housekeeping.",
    ),
    "utf8",
  );
  await writeFile(
    join(dir, "send.md"),
    memo(
      "send",
      "chat-send handler debounce",
      "touching the chat-send handler",
      "Debounce lives in the chat-send handler, not the socket layer.",
    ),
    "utf8",
  );
  await writeFile(
    join(dir, "phase.md"),
    memo(
      "phase",
      "P2.2 rollout gate",
      "planning P2.2 rollout",
      "Gate criteria for P2.2 were fixed in the kickoff.",
    ),
    "utf8",
  );
  const vault = new Vault(dir);
  await vault.init();
  const idx = new SearchIndex(vault);
  idx.start();
  return { idx, dir };
}

test("retrieval: joined identifier query ranks the exact memory above the split-parts decoy", async () => {
  const { idx, dir } = await makeIndex();
  try {
    const hits = idx.recall("my-app.config.ts", { k: 5 });
    assert.ok(hits.length >= 1, "identifier query returns hits");
    assert.equal(hits[0].id, "cfg", "exact-identifier memory ranks first");
    // The joined token itself matched — not just the generic parts.
    assert.ok(
      hits[0].matched_terms.includes("my-app.config.ts"),
      `joined identifier is a matched term (got: ${hits[0].matched_terms.join(", ")})`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("retrieval: split-parts recall is not reduced (decoy still findable)", async () => {
  const { idx, dir } = await makeIndex();
  try {
    // Old behavior: "my-app.config.ts" degraded to these parts. Both memories
    // must still match — dual-emission may not lose any previous hit.
    const hits = idx.recall("app config ts", { k: 5 });
    const ids = hits.map((h) => h.id);
    assert.ok(ids.includes("cfg"), "identifier memory matches on its parts");
    assert.ok(ids.includes("decoy"), "parts-only memory still matches");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("retrieval: hyphenated identifier in recall_when triggers deliberate match", async () => {
  const { idx, dir } = await makeIndex();
  try {
    const hits = idx.recall("chat-send", { k: 5 });
    assert.equal(hits[0]?.id, "send");
    assert.equal(hits[0]?.matched_recall_when, true, "recall_when field fired");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("retrieval: versioned identifier P2.2 is retrievable", async () => {
  const { idx, dir } = await makeIndex();
  try {
    const hits = idx.recall("P2.2", { k: 5 });
    assert.equal(hits[0]?.id, "phase");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("retrieval: normalization applies at the recall entry (dangling operator, hostile length)", async () => {
  const { idx, dir } = await makeIndex();
  try {
    // Dangling operator is stripped before search + cache key.
    const hits = idx.recall("my-app.config.ts AND", { k: 5 });
    assert.equal(hits[0]?.id, "cfg");
    // Operator-only query normalizes to empty → no hits, no throw.
    assert.deepEqual(idx.recall("AND OR NOT", { k: 5 }), []);
    // 50k-char hostile query is capped and must not throw.
    assert.doesNotThrow(() => idx.recall("z".repeat(50_000), { k: 5 }));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
