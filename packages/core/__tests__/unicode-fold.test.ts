/**
 * One spelling and one case fold for every matcher (core/fold.ts).
 *
 * Revert-check: make `processTerm` in search.ts the MiniSearch default again
 * (drop the line) and the GRÖSSE and fullwidth lookups go red.
 *
 * Runner: node --import tsx --test packages/core/__tests__/unicode-fold.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { SearchIndex } from "../src/search.js";
import { foldTerm, normalizeText } from "../src/fold.js";

test("foldTerm: one spelling per word, whatever the keyboard or the host locale", () => {
  assert.equal(foldTerm("İstanbul"), foldTerm("istanbul"), "Turkish capital İ");
  assert.equal(foldTerm("ISTANBUL"), foldTerm("ıstanbul"), "dotless ı");
  assert.equal(foldTerm("GRÖSSE"), foldTerm("größe"), "ß folds with SS");
  assert.equal(foldTerm("café"), foldTerm("café"), "NFD (macOS) meets NFC");
  assert.equal(foldTerm("ＡＰＩ"), "api", "fullwidth from an IME");
  assert.equal(foldTerm("ﾃｽﾄ"), foldTerm("テスト"), "half-width katakana");
  assert.equal(foldTerm("dep​loy"), "deploy", "an invisible ZWSP is not part of the word");
  assert.equal(foldTerm("deploy"), "deploy", "ASCII is just lowercased");
});

test("normalizeText: identity for ASCII, case left alone", () => {
  assert.equal(normalizeText("Deploy the API"), "Deploy the API");
  assert.equal(normalizeText("Ｄｅｐｌｏｙ"), "Deploy");
});

test("BM25: a fullwidth query finds the note written in ASCII, and back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-fold-"));
  await mkdir(join(dir, "memories"), { recursive: true });
  const note = (id: string, title: string) =>
    writeFile(
      join(dir, "memories", `${id}.md`),
      `---\nid: ${id}\ntitle: "${title}"\ntype: reference\nsummary: "${title}"\ntopic_path: [t]\ntags: [t]\nscope: s\nrecall_when:\n  - "${title}"\ncreated: 2026-10-01\nupdated: 2026-10-01\n---\n\n${title}.\n`,
    );
  await note("api-key-rotation", "Rotate the API key every quarter");
  await note("ime-note", "ｓｔａｇｉｎｇ ｓｅｒｖｅｒ ｐａｓｓｗｏｒｄ");
  await note("backup-size", "Größe der Sicherung");
  await note("pause", "Grosse Pause im Büro");
  for (let i = 0; i < 10; i++) await note(`filler-${i}`, `unrelated gardening note ${i}`);
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  try {
    assert.equal(search.recall("ＡＰＩ ｋｅｙ ｒｏｔａｔｅ", { k: 3 })[0]?.id, "api-key-rotation");
    assert.equal(search.recall("staging server password", { k: 3 })[0]?.id, "ime-note");
    // GRÖSSE is the upper case of größe (ß → SS); without the fold only the
    // one-edit fuzzy neighbour "grosse" answers.
    assert.equal(search.recall("GRÖSSE", { k: 3 })[0]?.id, "backup-size");
  } finally {
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true });
  }
});
