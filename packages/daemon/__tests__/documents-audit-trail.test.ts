/**
 * #452 — der Dokument-Schreibpfad steht auf demselben Audit-Trail wie der
 * Memory-Pfad (#206). Vorher schrieben `save_document`, `recategorize_document`
 * und `move_document` keinen einzigen Eintrag nach `.bastra/audit-log.ndjson`.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/documents-audit-trail.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "@bastra-recall/core";

import { saveDocument, recategorizeDocument, moveDocument } from "../src/documents-write-handler.js";
import { resetAuditLogCache } from "../src/audit-trail.js";

interface AuditLine {
  memory_id: string;
  operation: string;
  actor: string;
  actor_detail?: string;
  reason?: string;
  file_path?: string;
  diff_before: Record<string, unknown> | null;
  diff_after: Record<string, unknown> | null;
}

async function auditEntries(vaultRoot: string): Promise<AuditLine[]> {
  const raw = await readFile(join(vaultRoot, ".bastra", "audit-log.ndjson"), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuditLine);
}

test("#452: save_document, recategorize_document und move_document schreiben je einen Audit-Eintrag", async (t) => {
  resetAuditLogCache();
  const dir = await mkdtemp(join(tmpdir(), "bastra-452-"));
  t.after(async () => {
    resetAuditLogCache();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const source = join(dir, "vertrag.pdf");
  await writeFile(source, "fake-pdf-bytes");
  const vaultDir = join(dir, "vault");
  const vault = new Vault(vaultDir);
  await vault.init();

  const base = {
    original_path: source,
    folder_path: "Inbox",
    title: "Mietvertrag",
    tags: ["miete"],
    category: "vertrag" as const,
    linked_file: false,
    overwrite: false,
  };
  const created = await saveDocument(vault, base);
  await saveDocument(vault, { ...base, overwrite: true, recall_when: ["find the rental contract"] });
  await recategorizeDocument(vault, { id: created.id, title: "Mietvertrag 2026" });
  const moved = await moveDocument(vault, { id: created.id, folder_path: "Archiv" });

  const entries = (await auditEntries(vaultDir)).filter((e) => e.memory_id === created.id);
  assert.deepEqual(
    entries.map((e) => [e.operation, e.actor_detail]),
    [
      ["create", "mcp:save_document"],
      ["update", "mcp:save_document"],
      ["update", "mcp:recategorize_document"],
      ["update", "mcp:move_document"],
    ],
  );
  assert.ok(entries.every((e) => e.actor === "assistant"));

  const [create, overwrite, recategorize, move] = entries;
  assert.equal(create.diff_before, null);
  assert.equal(create.diff_after?.id, created.id);
  // Der Overwrite ersetzt die Trigger — Vor- und Nachbild zeigen beide Fassungen.
  assert.notDeepEqual(overwrite.diff_before?.recall_when, overwrite.diff_after?.recall_when);
  assert.equal(recategorize.diff_before?.title, "Mietvertrag");
  assert.equal(recategorize.diff_after?.title, "Mietvertrag 2026");
  assert.equal(move.diff_before?.folder_path, "Inbox");
  assert.equal(move.diff_after?.folder_path, "Archiv");
  assert.equal(move.file_path, moved.sidecar_path);
  assert.match(move.reason ?? "", /move_document: .*Inbox.* → .*Archiv/);
});
