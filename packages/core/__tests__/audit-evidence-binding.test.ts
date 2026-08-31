/**
 * Codex-Gegenreview Runde 10 — der Audit-Beleg und die committete Mutation.
 *
 *   - P1-2: Beim Restore stand `diff_after` auf `lastDelete.diff_before`. Wurde
 *     die Trash-Fassung vor dem Restore verändert, protokollierte das Audit
 *     eine Fassung, die so nie wiederhergestellt wurde.
 *   - P1-3: Das Audit-Append läuft NACH dem dauerhaften Save. Schlug es fehl,
 *     warf `auditedSave` — und ein Aufrufer wiederholte eine Mutation, die
 *     bereits vollständig auf der Platte lag.
 *   - P1-4: Delete las sein Vorbild in einem eigenen Read und band es nicht an
 *     die Fassung, die in den Trash wanderte.
 *
 * Runner: node --import tsx --test packages/core/__tests__/audit-evidence-binding.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { AuditLog, latestTrashPathFor } from "../src/audit-log.js";
import { auditedRestore, auditedSave, auditedSoftDelete } from "../src/audit-save.js";
import { saveMemory } from "../src/save.js";
import type { SaveMemoryInput } from "../src/save-schema.js";
import type { Vault } from "../src/vault.js";

function input(over: Partial<SaveMemoryInput> = {}): SaveMemoryInput {
  return {
    id: "beleg",
    title: "Beleg",
    type: "lesson",
    summary: "original-summary",
    body: "Body.",
    topic_path: ["t"],
    tags: ["t"],
    recall_when: ["t"],
    scope: "proj",
    ...over,
  } as SaveMemoryInput;
}

/** Nur das, was die Audit-Pfade wirklich anfassen. */
function stubVault(entries: Map<string, string>): Vault {
  return {
    get: (id: string) => {
      const filePath = entries.get(id);
      return filePath ? { fm: { id }, filePath, mtime: 0, body: "" } : undefined;
    },
    pathsFor: (id: string) => (entries.has(id) ? [entries.get(id)!] : []),
    forgetFile: () => {},
    reindexFile: async () => {},
  } as unknown as Vault;
}

async function vault(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bastra-auditbind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("das Delete-Vorbild stammt aus der Fassung, die wirklich in den Trash wandert", async (t) => {
  const root = await vault(t);
  const log = new AuditLog(root);
  const saved = await saveMemory(root, input());

  // Zwischen Beweis-Read und Trash-Move kam bisher eine externe Fassung durch.
  const externAlt = await readFile(saved.file_path, "utf8");
  await writeFile(
    saved.file_path,
    externAlt.replace("original-summary", "extern-auf-der-platte"),
    "utf8",
  );

  const v = stubVault(new Map([["beleg", saved.file_path]]));
  const { audit, trashPath } = await auditedSoftDelete({
    vault: v,
    auditLog: log,
    vaultRoot: root,
    memoryID: "beleg",
    context: { actor: "user" },
  });

  assert.equal(
    (audit!.diff_before as Record<string, unknown>).summary,
    "extern-auf-der-platte",
    "protokolliert wird, was verschoben wurde — nicht der Stand von vorher",
  );
  assert.match(await readFile(trashPath, "utf8"), /extern-auf-der-platte/);
});

test("der Restore protokolliert die tatsächlich veröffentlichte Fassung", async (t) => {
  const root = await vault(t);
  const log = new AuditLog(root);
  const saved = await saveMemory(root, input());
  const v = stubVault(new Map([["beleg", saved.file_path]]));

  await auditedSoftDelete({
    vault: v,
    auditLog: log,
    vaultRoot: root,
    memoryID: "beleg",
    context: { actor: "user" },
  });

  // Jemand fasst die Trash-Fassung an, bevor sie zurückgeholt wird.
  const trashFile = (await latestTrashPathFor(root, "beleg"))!;
  const raw = await readFile(trashFile, "utf8");
  await writeFile(trashFile, raw.replace("original-summary", "im-trash-geaendert"), "utf8");

  const { audit, restoredTo } = await auditedRestore({
    auditLog: log,
    vaultRoot: root,
    memoryID: "beleg",
    context: { actor: "user" },
  });

  const onDisk = matter(await readFile(restoredTo, "utf8")).data as Record<string, unknown>;
  assert.equal(onDisk.summary, "im-trash-geaendert");
  assert.equal(
    (audit!.diff_after as Record<string, unknown>).summary,
    "im-trash-geaendert",
    "das Nachbild muss die Datei beschreiben, die jetzt im Vault liegt",
  );
});

test("ein Audit-Fehler macht aus einem committeten Save keinen Fehlschlag", async (t) => {
  const root = await vault(t);
  const log = new AuditLog(root);
  // Ein VERZEICHNIS am Pfad des Ledgers: `appendFile` scheitert mit EISDIR.
  await mkdir(join(root, ".bastra", "audit-log.ndjson"), { recursive: true });

  const v = stubVault(new Map());
  const { result, audit, audit_warning } = await auditedSave({
    vault: v,
    auditLog: log,
    vaultRoot: root,
    input: input(),
    context: { actor: "user" },
  });

  assert.equal(audit, null);
  assert.match(audit_warning ?? "", /do NOT retry/);
  assert.match(
    await readFile(result.file_path, "utf8"),
    /original-summary/,
    "die Mutation steht vollständig auf der Platte",
  );
});
