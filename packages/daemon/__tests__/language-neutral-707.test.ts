/**
 * #707 — the fixed-language places the #679 guard found, each checked with a
 * non-Latin language:
 *
 *   save-similarity  function words are shared per-language data; an unlisted
 *                    language drops no word (neutral), duplicates still score
 *   todo-lane        the tokenizer keeps every script; task verbs are data
 *   tool-handlers    acted-on tokens keep non-Latin words
 *   taxonomy         a convention title in Cyrillic covers its cluster
 *   reflex           alternatives split by per-language data (`или`) and by a
 *                    free-standing `/` in any script
 *   save-quality     the #159 admission flags are lexicon data: shipped `ru`,
 *                    no penalty for an unlisted language, a code span counts
 *                    as the fix in any script, a user file adds a language
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/language-neutral-707.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, tokenizeWithIdentifiers } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { fieldSimilarity, DUPLICATE_SIMILARITY_MIN, contentTokens } from "../src/save-similarity.js";
import { extractTopicsFromTodos } from "../src/todo-lane.js";
import { distinctiveTokensForActedOn } from "../src/tool-handlers.js";
import { detectTaxonomyDrift } from "../src/taxonomy.js";
import { phraseMatchesContext } from "../src/reflex.js";
import { scoreSaveQuality } from "../src/save-quality.js";
import type { ToolDeps } from "../src/tool-deps.js";

// ── save-similarity ──────────────────────────────────────────────────

test("#707 similarity: a Russian near-duplicate still scores as one (neutral path, no list)", () => {
  const a = {
    title: "перезапуск сервера после деплоя",
    summary: "Сервер нужно перезапускать после каждого деплоя, иначе кэш устаревает.",
    tags: ["деплой", "сервер"],
    recall_when: ["перезапуск сервера после деплоя"],
  };
  const b = { ...a, summary: "После деплоя сервер перезапускается, иначе кэш устаревает." };
  assert.ok(fieldSimilarity(a, b) >= DUPLICATE_SIMILARITY_MIN, `got ${fieldSimilarity(a, b)}`);
});

test("#707 similarity: two unrelated Russian notes stay apart although they share function words", () => {
  const a = {
    title: "перезапуск сервера",
    summary: "Это нужно и на сервере, и на стенде.",
    tags: ["сервер"],
    recall_when: ["перезапуск сервера на стенде"],
  };
  const b = {
    title: "отпуск в августе",
    summary: "Это нужно и на море, и на даче.",
    tags: ["отпуск"],
    recall_when: ["отпуск в августе на море"],
  };
  assert.ok(fieldSimilarity(a, b) < DUPLICATE_SIMILARITY_MIN, `got ${fieldSimilarity(a, b)}`);
});

test("#707 similarity: listed function words are still dropped, content words of any script kept", () => {
  assert.deepEqual([...contentTokens("the server and the сервер")], ["server", "сервер"]);
});

// ── todo-lane ────────────────────────────────────────────────────────

test("#707 todo-lane: a Cyrillic todo list yields Cyrillic topics (tokenizer keeps every script)", () => {
  const out = extractTopicsFromTodos([
    { content: "перезапуск сервера после миграции" },
    { content: "проверить логи сервера" },
  ]);
  assert.deepEqual(out.topics, ["сервера"]);
});

test("#707 todo-lane: task verbs are data — 'add'/'neue' never become topics", () => {
  const out = extractTopicsFromTodos([{ content: "add neue Migration" }, { content: "add neue Migration tests" }]);
  assert.deepEqual(out.topics, ["migration"]);
});

// ── tool-handlers (acted-on overlap) ─────────────────────────────────

test("#707 acted-on: Greek content words are kept, listed function words dropped", () => {
  assert.deepEqual(distinctiveTokensForActedOn("which zebra επανεκκίνηση διακομιστή"), [
    "zebra",
    "επανεκκίνηση",
    "διακομιστή",
  ]);
});

// ── taxonomy ─────────────────────────────────────────────────────────

test("#707 taxonomy: a convention title in Cyrillic covers its cluster", async () => {
  process.env.BASTRA_DRIFT_MIN_CLUSTER = "3";
  const dir = await mkdtemp(join(tmpdir(), "bastra-707-taxonomy-"));
  const day = new Date().toISOString().slice(0, 10);
  const file = (id: string, title: string, scope: string, tags: string[]) =>
    [
      "---",
      `id: ${id}`,
      `title: ${title}`,
      "type: lesson",
      `summary: ${title}`,
      "topic_path:",
      "  - test",
      "tags:",
      ...tags.map((t) => `  - ${t}`),
      `scope: ${scope}`,
      "recall_when:",
      `  - ${title}`,
      `created: ${day}`,
      `updated: ${day}`,
      "---",
      "",
      "body",
      "",
    ].join("\n");
  await mkdir(join(dir, "memories/taxonomy"), { recursive: true });
  await writeFile(join(dir, "memories/taxonomy/conv.md"), file("conv", "конвенция логистика", "taxonomy", ["convention"]));
  for (const i of [1, 2, 3]) await writeFile(join(dir, `m${i}.md`), file(`m${i}`, `заметка ${i}`, "proj", ["логистика"]));
  const vault = new Vault(dir);
  await vault.init();
  try {
    assert.deepEqual(
      detectTaxonomyDrift(vault).map((c) => c.key),
      [],
      "the Cyrillic title word must count as covered",
    );
  } finally {
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ── reflex ───────────────────────────────────────────────────────────

const ctx = (text: string): Set<string> => new Set(tokenizeWithIdentifiers(text.toLowerCase()));

test("#707 reflex: Russian 'или' splits alternatives (per-language data)", () => {
  assert.equal(phraseMatchesContext("письмо или ответ написать", ctx("надо ответ написать")), true);
});

test("#707 reflex: a free-standing '/' splits alternatives in an unlisted language", () => {
  const phrase = "μήνυμα γράψιμο / απάντηση γράψιμο";
  assert.equal(phraseMatchesContext(phrase, ctx("γράψιμο μήνυμα τώρα")), true);
  assert.equal(phraseMatchesContext("μήνυμα απάντηση γράψιμο", ctx("γράψιμο μήνυμα τώρα")), false, "without '/' every token is required");
});

// ── save-quality (#159 admission flags) ──────────────────────────────

async function makeDeps(): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-707-quality-"));
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

function input(title: string, summary: string, body: string) {
  return {
    title,
    type: "lesson",
    summary,
    body,
    topic_path: ["test"],
    tags: ["сервер"],
    scope: "q707",
    recall_when: ["перезапуск сервера после деплоя на стенде"],
  } as Parameters<typeof scoreSaveQuality>[1];
}

const NEGATIVE = "negative capability claim";
const IMPERATIVE = "imperative phrasing";

async function withLexiconDir(files: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-707-lexicon-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content, "utf8");
  const prev = process.env.BASTRA_LEXICON_DIR;
  process.env.BASTRA_LEXICON_DIR = dir;
  try {
    await run();
  } finally {
    if (prev === undefined) delete process.env.BASTRA_LEXICON_DIR;
    else process.env.BASTRA_LEXICON_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("#707 save-quality: shipped Russian cues flag a negative claim without a fix, and an imperative lead", async (t) => {
  const { deps, close } = await makeDeps();
  t.after(close);
  await withLexiconDir({}, async () => {
    const broken = scoreSaveQuality(deps, input("сервер", "Сервер не работает после деплоя.", "Пока без идей."), "x");
    assert.ok(broken.issues.some((i) => i.includes(NEGATIVE)), JSON.stringify(broken.issues));
    const fixed = scoreSaveQuality(deps, input("сервер", "Сервер не работает после деплоя.", "Решение: перезапуск."), "x");
    assert.ok(!fixed.issues.some((i) => i.includes(NEGATIVE)), JSON.stringify(fixed.issues));
    const lead = scoreSaveQuality(deps, input("Всегда перезапускать сервер", "Сервер после деплоя.", "…"), "x");
    assert.ok(lead.issues.some((i) => i.includes(IMPERATIVE)), JSON.stringify(lead.issues));
  });
});

test("#707 save-quality: a code span in the body counts as the captured fix in any script", async (t) => {
  const { deps, close } = await makeDeps();
  t.after(close);
  await withLexiconDir({}, async () => {
    const res = scoreSaveQuality(deps, input("сервер", "Сервер не работает после деплоя.", "`systemctl restart app`"), "x");
    assert.ok(!res.issues.some((i) => i.includes(NEGATIVE)), JSON.stringify(res.issues));
  });
});

test("#707 save-quality: an unlisted language gets no guessed penalty, and a lexicon file adds it", async (t) => {
  const { deps, close } = await makeDeps();
  t.after(close);
  const greek = input("διακομιστής", "Ο διακομιστής δεν λειτουργεί μετά την ανάπτυξη.", "Καμία ιδέα ακόμα.");
  await withLexiconDir({}, async () => {
    const res = scoreSaveQuality(deps, greek, "x");
    assert.ok(!res.issues.some((i) => i.includes(NEGATIVE)), "no Greek list → neutral, no penalty");
  });
  await withLexiconDir({ "negative-claim.txt": "δεν\\s+λειτουργεί\n" }, async () => {
    const res = scoreSaveQuality(deps, greek, "x");
    assert.ok(res.issues.some((i) => i.includes(NEGATIVE)), JSON.stringify(res.issues));
  });
});
