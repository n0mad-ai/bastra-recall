/**
 * `find_document` liefert `docs_indexed` — das Gegenstück zu `vault_size`
 * bei `recall`.
 *
 * Ohne die Zahl ist `hits: []` auf einem nie befüllten Doc-Vault nicht von
 * „gesucht und nichts gefunden" zu unterscheiden. Ein Agent liest die leere
 * Liste dann als Aussage über die Welt („der User hat das Dokument nicht")
 * statt als Zustand des Index — und die Tool-Beschreibung weist ihn an,
 * `find_document` VOR anderen Lookups zu fragen. Genau dieser stille
 * Nullfall wird hier festgenagelt.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/documents-empty-corpus.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";

import { findDocument, readDocument, openDocument } from "../src/documents-handler.js";

function memoryMarkdown(
  id: string,
  title: string,
  type: string,
  sensitivity?: string,
): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    `type: ${type}`,
    `summary: ${title} summary`,
    ...(sensitivity ? [`sensitivity: ${sensitivity}`] : []),
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: empty-corpus-test",
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

async function makeVault(
  files: Array<{ name: string; content: string }>,
): Promise<{ vault: Vault; search: SearchIndex; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-empty-corpus-"));
  for (const f of files) {
    await writeFile(join(dir, f.name), f.content, "utf8");
  }
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  return {
    vault,
    search,
    close: async () => {
      search.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("leerer Doc-Vault meldet docs_indexed: 0", async () => {
  const { vault, search, close } = await makeVault([
    // Memories ja, Documents nein — der reale Zustand eines frischen Vaults.
    { name: "lesson.md", content: memoryMarkdown("a-lesson", "zebra handling", "lesson") },
  ]);
  try {
    const res = findDocument(search, vault, { query: "zebra handling" });
    assert.equal(res.docs_indexed, 0);
    assert.deepEqual(res.hits, []);
  } finally {
    await close();
  }
});

test("befüllter Doc-Vault: erfolgloser Query liefert hits: [] MIT docs_indexed > 0", async () => {
  const { vault, search, close } = await makeVault([
    { name: "doc.md", content: memoryMarkdown("zebra-doc", "zebra handling", "doc") },
  ]);
  try {
    const miss = findDocument(search, vault, { query: "quantenchromodynamik" });
    // Der eigentliche Punkt: dieselbe leere hits-Liste wie oben, aber
    // unterscheidbar — hier wurde wirklich gesucht.
    assert.deepEqual(miss.hits, []);
    assert.equal(miss.docs_indexed, 1);

    const hit = findDocument(search, vault, { query: "zebra handling" });
    assert.equal(hit.docs_indexed, 1);
    assert.ok(hit.hits.length > 0, "passender Query muss den Doc-Hit liefern");
  } finally {
    await close();
  }
});

test("docs_indexed respektiert den Sensitivity-Filter des Callers", async () => {
  const { vault, search, close } = await makeVault([
    {
      name: "private-doc.md",
      content: memoryMarkdown("secret-doc", "zebra handling", "doc", "private"),
    },
  ]);
  try {
    // Externer MCP-Caller: private Docs existieren für ihn nicht — die Zahl
    // darf ihre Existenz nicht verraten.
    const external = findDocument(search, vault, { query: "zebra handling" });
    assert.equal(external.docs_indexed, 0);

    // Mac-App ruft mit allowPrivate.
    const internal = findDocument(
      search,
      vault,
      { query: "zebra handling" },
      { allowPrivate: true },
    );
    assert.equal(internal.docs_indexed, 1);
  } finally {
    await close();
  }
});


test("Windows: opening reports missing support while extracted text stays searchable and readable", async () => {
  const { vault, search, close } = await makeVault([
    { name: "doc.md", content: memoryMarkdown("zebra-doc", "zebra handling", "doc") },
  ]);
  try {
    const result = await openDocument(vault, { id: "zebra-doc" }, { platform: "win32" });
    assert.equal(result.ok, false);
    assert.ok(result.path);
    if (!result.ok) {
      assert.match(result.message, /Windows.*no supported backend/);
      assert.match(result.message, /Open this path manually/);
      assert.match(result.message, /already-extracted document text remain available/);
    }
    assert.equal(findDocument(search, vault, { query: "zebra handling" }).hits.length, 1);
    assert.match(readDocument(vault, { id: "zebra-doc" })?.body ?? "", /Body for zebra handling/);
    const missing = await openDocument(vault, { id: "unknown" }, { platform: "win32" });
    assert.deepEqual(missing, { ok: false, message: "document not found: unknown" });
  } finally {
    await close();
  }
});
