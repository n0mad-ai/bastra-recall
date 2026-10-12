/** #1189 follow-up: preserve joined identifier identity and add ICU words. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { SearchIndex } from "../src/search.js";
import { tokenizeWithIdentifiers } from "../src/query-normalize.js";

for (const prose of ["备份服务器", "デプロイ手順", "รหัสผ่านเซิร์ฟเวอร์"]) {
  for (const glue of [".", "_", "-"]) {
    test(`mixed identifier preserves legacy emissions and adds word segments: ${prose}${glue}password`, () => {
      const identifier = `${prose}${glue}password`;
      const tokens = tokenizeWithIdentifiers(identifier);
      assert.ok(tokens.includes(identifier), "whole identifier remains a discriminating term");
      assert.ok(tokens.includes(prose), "legacy unsplit component remains searchable");
      assert.ok(tokens.includes("password"), "legacy ASCII component remains searchable");
      const words = [...new Intl.Segmenter("und", { granularity: "word" }).segment(prose)]
        .filter(s => s.isWordLike).map(s => s.segment);
      assert.ok(words.length > 1, "fixture contains more than one ICU word");
      for (const word of words) assert.ok(tokens.includes(word), `additional word ${word} is searchable`);
      assert.equal(tokens.filter(t => t === "password").length, 1, "added words do not duplicate the ASCII component");
    });
  }
}

test("mixed multi-part identifier retains its whole term and all legacy components", () => {
  const tokens = tokenizeWithIdentifiers("备份-server.config.ts");
  for (const term of ["备份-server.config.ts", "备份", "server", "config", "ts"])
    assert.ok(tokens.includes(term), `${term} survives segmentation`);
});

test("real BM25 ranks an exact mixed dot identifier above its spaced neighbour", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixed-identifier-"));
  await mkdir(join(dir, "memories"));
  const notes: [string, string][] = [
    ["z-cn-identifier", "服务器.password"],
    ["a-cn-neighbour", "服务器 password"],
    ...Array.from({ length: 12 }, (_, i): [string, string] => [`filler-${i}`, `gardening weather ${i}`]),
  ];
  for (const [id, title] of notes) await writeFile(join(dir, "memories", `${id}.md`),
    `---\nid: ${id}\ntitle: "${title}"\ntype: reference\nsummary: "${title}"\ntopic_path: [fixture]\ntags: [fixture]\nscope: fixture\nrecall_when: ["${title}"]\ncreated: 2026-10-01\nupdated: 2026-10-01\n---\n\n${title}\n`);
  const vault = new Vault(dir); await vault.init();
  const search = new SearchIndex(vault); search.start();
  try {
    const hits = search.recall("服务器.password", { k: 5 });
    assert.equal(hits[0]?.id, "z-cn-identifier");
    const exact = hits.find(h => h.id === "z-cn-identifier");
    const neighbour = hits.find(h => h.id === "a-cn-neighbour");
    assert.ok(exact && neighbour, "both exact and spaced form remain retrievable");
    assert.ok(exact.score > neighbour.score, "exact identity has a stronger score, not a tie-break win");
    assert.ok(exact.matched_terms.includes("服务器.password"), "index and query both retain the joined term");
  } finally { search.stop(); await vault.stop(); }
});
