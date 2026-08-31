/**
 * Sicherheitsrunde, zweite Ebene: die privaten UNTERREGALE von `.bastra`.
 *
 * `.bastra` selbst ist seit der letzten Runde geschützt — es muss das eigene
 * Verzeichnis des Vaults sein, kein Symlink. Seine Unterregale waren es nicht:
 * Für `trash` und `locks` galt nur „liegt in `.bastra`", und ein Symlink, der
 * `.bastra` gar nicht verlässt, erfüllt das.
 *
 * Was daran hängt: `.bastra/trash -> .bastra/locks` legte gelöschte Memories
 * zwischen die Lock-Dateien. Beide Sorten werden von verschiedenen Stellen
 * aufgeräumt, und das Aufräumen der einen nähme die andere mit — ein
 * „recoverable, never a hard delete" wäre es dann nicht mehr.
 *
 * Für private Ablage gilt dieselbe Regel wie für `.bastra` selbst: kein
 * Symlink, auch kein nach innen zeigender.
 *
 * Runner: node --import tsx --test packages/core/__tests__/bastra-private-dirs.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, AuditLog, auditedSoftDelete, saveMemory } from "../src/index.js";

function memoryMarkdown(id: string): string {
  return [
    "---",
    `id: ${id}`,
    `title: ${id}`,
    "type: lesson",
    "summary: s",
    "topic_path:",
    "  - t",
    "tags:",
    "  - t",
    "scope: proj",
    "recall_when:",
    "  - probe",
    "created: 2026-08-01",
    "updated: 2026-08-01",
    "---",
    "",
    "Body.",
    "",
  ].join("\n");
}

test("der Trash darf kein Symlink sein, auch nicht innerhalb von .bastra", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-priv-trash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "doomed.md"), memoryMarkdown("doomed"), "utf8");
  const locks = join(root, ".bastra", "locks");
  await mkdir(locks, { recursive: true });
  await symlink(locks, join(root, ".bastra", "trash"));

  const vault = new Vault(root);
  await vault.init();
  t.after(() => vault.stop());

  await assert.rejects(
    auditedSoftDelete({
      vault,
      auditLog: new AuditLog(root),
      vaultRoot: root,
      memoryID: "doomed",
      context: { actor: "user" },
    }),
    /own trash/,
  );
  assert.deepEqual(
    (await readdir(locks)).filter((n) => n.endsWith(".md")),
    [],
    "kein gelöschtes Memory zwischen den Lock-Dateien",
  );
});

test("das Lock-Regal darf kein Symlink sein, auch nicht innerhalb von .bastra", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-priv-locks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trash = join(root, ".bastra", "trash");
  await mkdir(trash, { recursive: true });
  await symlink(trash, join(root, ".bastra", "locks"));

  await assert.rejects(
    saveMemory(root, {
      id: "neu",
      title: "Neu",
      type: "lesson",
      summary: "s",
      body: "Body.",
      topic_path: ["t"],
      tags: ["t"],
      scope: "proj",
      recall_when: ["probe"],
    }),
    /own locks/,
  );
  assert.deepEqual(await readdir(trash), [], "keine Lock-Datei im Trash");
});
