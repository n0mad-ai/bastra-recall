/**
 * Codex-Gegenreview: Der produktive `vaultLocator` sah zwei Dateien derselben
 * id nur als `unique` — ein Save lief durch und ließ das Duplikat bestehen.
 *
 * Der Vault ERKENNT den Fall seit #240/A2.3 und quarantäniert die zweite
 * Datei; er behielt die Information nur nicht abfragbar. Zwei Dateien mit
 * einer id sind kein Randfall, sondern ein Zustand, in dem jede
 * Schreibentscheidung geraten wäre: Welche der beiden ist gemeint?
 *
 * Runner: `tsx --test __tests__/duplicate-id-locator.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, saveMemory } from "@bastra-recall/core";
import { vaultLocator } from "../src/vault-locator.js";

const memory = (id: string) =>
  `---\nid: ${id}\ntitle: T\ntype: reference\nsummary: s\ntopic_path:\n  - t\ntags:\n  - t\nscope: proj\nrecall_when:\n  - t\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nBody.\n`;

async function vaultWithDuplicate(): Promise<{ dir: string; vault: Vault; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "dupe-"));
  await mkdir(join(dir, "memories", "projects", "proj"), { recursive: true });
  await mkdir(join(dir, "memories", "people"), { recursive: true });
  // Der klassische Fall: eine Cloud-Sync-Konfliktkopie unter anderem Namen.
  await writeFile(join(dir, "memories", "projects", "proj", "dupe.md"), memory("dupe"));
  await writeFile(join(dir, "memories", "people", "dupe-kopie.md"), memory("dupe"));
  const vault = new Vault(dir);
  await vault.init();
  return { dir, vault, close: async () => { await vault.stop?.(); await rm(dir, { recursive: true, force: true }); } };
}

test("pathsFor kennt die quarantänisierte Zweitdatei, get() nicht", async () => {
  const { vault, close } = await vaultWithDuplicate();
  try {
    assert.ok(vault.get("dupe"), "der Gewinner steht im Index");
    assert.equal(vault.pathsFor("dupe").length, 2, "beide Pfade sind bekannt");
  } finally {
    await close();
  }
});

test("der Locator meldet ambiguous — und der Save verweigert statt zu raten", async () => {
  const { dir, vault, close } = await vaultWithDuplicate();
  try {
    const located = vaultLocator(vault).locate("dupe");
    assert.equal(located.kind, "ambiguous");

    await assert.rejects(
      saveMemory(
        dir,
        {
          id: "dupe",
          title: "T",
          type: "reference",
          summary: "s",
          body: "NEU",
          topic_path: ["t"],
          tags: ["t"],
          scope: "proj",
          recall_when: ["t"],
          overwrite: true,
        },
        { locator: vaultLocator(vault) },
      ),
      /exists in more than one file/,
    );
  } finally {
    await close();
  }
});

test("ist das Duplikat weg, ist die id wieder eindeutig", async () => {
  const { dir, vault, close } = await vaultWithDuplicate();
  try {
    const kopie = join(dir, "memories", "people", "dupe-kopie.md");
    await unlink(kopie);
    // Der Watcher ist auf Cloud-Mounts unzuverlässig — der Vault räumt beim
    // Reconcile auf, und danach darf der Locator nicht mehr blockieren.
    await vault.reconcile?.();
    assert.deepEqual(vault.pathsFor("dupe"), [
      join(dir, "memories", "projects", "proj", "dupe.md"),
    ]);
    assert.equal(vaultLocator(vault).locate("dupe").kind, "unique");
  } finally {
    await close();
  }
});
