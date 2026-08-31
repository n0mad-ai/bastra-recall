/**
 * Codex-Gegenreview: Learned-Bridge-Erweiterungen konnten Autorenabsicht
 * vortäuschen.
 *
 * Der Anker (`matched_recall_when`, `anchor_strength`) misst genau eine Sache:
 * ob ein HAND-geschriebener Trigger ein SELBST GETIPPTES Wort trifft. Beide
 * Seiten müssen von einem Menschen stammen — das ist der Grund, warum
 * `recall_when_expanded_flat` (maschinell) seit #148 nicht zählt.
 *
 * Auf der Query-Seite fehlte dieselbe Regel: `expandQuery()` hängt gelernte
 * Bridge-Terme an, und die gingen ungetrennt als „Query-Terme" in den Anker.
 * Ein Term, den der Benutzer nie geschrieben hat, konnte damit
 * `matched_recall_when` setzen, `weak_result` unterdrücken und einen
 * Cross-Scope-Bypass erzeugen.
 *
 * Runner: `tsx --test packages/core/__tests__/authored-query-anchor.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "../src/index.js";

async function vaultWithTrigger(): Promise<{ search: SearchIndex; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "authored-"));
  await mkdir(join(dir, "memories", "projects", "proj"), { recursive: true });
  await writeFile(
    join(dir, "memories", "projects", "proj", "ziel.md"),
    "---\nid: ziel\ntitle: Ziel\ntype: lesson\nsummary: Über Kaninchen\ntopic_path:\n  - t\ntags:\n  - t\nscope: proj\nrecall_when:\n  - wenn es um Kaninchen geht\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nKaninchen.\n",
  );
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  return {
    search,
    close: async () => {
      search.stop();
      await vault.stop?.();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("ein Bridge-Term im Query-Text setzt keinen Anker", async () => {
  const { search, close } = await vaultWithTrigger();
  try {
    // Der Benutzer schrieb "Hasen"; "Kaninchen" hat die Bridge-Expansion
    // angehängt. Der Treffer ist legitim — die ABSICHT ist es nicht.
    const expanded = "Hasen Kaninchen";
    const authored = "Hasen";

    const withoutAuthored = search.recall(expanded, { k: 5, minScore: 0 });
    const ziel1 = withoutAuthored.find((h) => h.id === "ziel");
    assert.ok(ziel1, "der Treffer wird über die Erweiterung gefunden");
    assert.equal(ziel1.matched_recall_when, true, "vorher: der Bridge-Term ankerte");

    const withAuthored = search.recall(expanded, {
      k: 5,
      minScore: 0,
      authored_query: authored,
    });
    const ziel2 = withAuthored.find((h) => h.id === "ziel");
    assert.ok(ziel2, "derselbe Treffer — das Ranking nutzt weiter die Erweiterung");
    assert.equal(ziel2.matched_recall_when, false, "aber er ankert nicht mehr");
    assert.equal(ziel2.anchor_strength, undefined);
  } finally {
    await close();
  }
});

test("ein selbst getippter Term ankert weiterhin", async () => {
  const { search, close } = await vaultWithTrigger();
  try {
    const hits = search.recall("Kaninchen Hasen", {
      k: 5,
      minScore: 0,
      authored_query: "Kaninchen",
    });
    const ziel = hits.find((h) => h.id === "ziel");
    assert.ok(ziel);
    assert.equal(ziel.matched_recall_when, true);
  } finally {
    await close();
  }
});

test("ohne authored_query bleibt alles wie bisher — Aufrufer ohne Expansion ändern nichts", async () => {
  const { search, close } = await vaultWithTrigger();
  try {
    const a = search.recall("Kaninchen", { k: 5, minScore: 0 });
    const b = search.recall("Kaninchen", { k: 5, minScore: 0, authored_query: "Kaninchen" });
    assert.equal(a.find((h) => h.id === "ziel")?.matched_recall_when, true);
    assert.equal(b.find((h) => h.id === "ziel")?.matched_recall_when, true);
  } finally {
    await close();
  }
});
