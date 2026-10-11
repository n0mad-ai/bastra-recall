/**
 * #711 — scripts written without spaces reach the BM25 index as words.
 *
 * `tokenizeWithIdentifiers` split only on whitespace and punctuation, so a
 * Chinese or Japanese sentence was ONE token and only a near-verbatim query
 * found it. Runs that hold a spaceless-script character are now split by ICU
 * word segmentation, on the index and the query side alike.
 *
 * Revert-check: drop the `hasSpacelessScript` branch in
 * `tokenizeWithIdentifiers` (query-normalize.ts) — the two lookups and the
 * symmetry case go red; the identifier case stays green.
 *
 * Runner: node --import tsx --test packages/core/__tests__/segment-spaceless.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { SearchIndex } from "../src/search.js";
import { tokenizeWithIdentifiers } from "../src/query-normalize.js";
import { segmentWords, hasSpacelessScript } from "../src/segment.js";

async function withIndex(notes: [string, string, string][], fn: (s: SearchIndex) => void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-segment-"));
  await mkdir(join(dir, "memories"), { recursive: true });
  for (const [id, title, body] of notes) {
    await writeFile(
      join(dir, "memories", `${id}.md`),
      `---\nid: ${id}\ntitle: "${title}"\ntype: reference\nsummary: "${title}"\ntopic_path: [t]\ntags: [t]\nscope: s\nrecall_when:\n  - "${title}"\ncreated: 2026-10-01\nupdated: 2026-10-01\n---\n\n${body}\n`,
    );
  }
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  try {
    fn(search);
  } finally {
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true });
  }
}

const FILLER: [string, string, string][] = Array.from({ length: 12 }, (_, i) => [
  `filler-${i}`,
  `unrelated note ${i}`,
  `nothing here but gardening and weather, entry ${i}`,
]);

test("#711: a two-word Chinese query finds the note that writes the words without spaces", async () => {
  await withIndex(
    [["zh-backup", "备份服务器的密码", "备份服务器的密码存放在保险库里。"], ...FILLER],
    (s) => {
      const hits = s.recall("服务器 密码", { k: 5 });
      assert.equal(hits[0]?.id, "zh-backup");
    },
  );
});

test("#711: a Japanese query of two words finds the sentence that contains them", async () => {
  await withIndex(
    [["ja-deploy", "ステージング環境へのデプロイ手順", "ステージング環境へデプロイするときはスクリプトを使う。"], ...FILLER],
    (s) => {
      const hits = s.recall("デプロイ 手順", { k: 5 });
      assert.equal(hits[0]?.id, "ja-deploy");
    },
  );
});

test("identifiers and spaced scripts are tokenised exactly as before", () => {
  assert.deepEqual(tokenizeWithIdentifiers("my-app.config.ts"), ["my-app.config.ts", "my", "app", "config", "ts"]);
  assert.deepEqual(tokenizeWithIdentifiers("сервер падает"), ["сервер", "падает"]);
  assert.deepEqual(segmentWords("my-app.config.ts"), ["my-app.config.ts"]);
  assert.equal(hasSpacelessScript("сервер"), false);
  assert.equal(hasSpacelessScript("服务器"), true);
});

test("segmentation is one function on both sides: every query word of the note is a token of the note", () => {
  const indexed = new Set(tokenizeWithIdentifiers("备份服务器的密码"));
  for (const w of tokenizeWithIdentifiers("服务器 密码")) assert.ok(indexed.has(w), `${w} is an index token`);
});
