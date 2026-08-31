/**
 * Codex-Gegenreview (P1): Das Audit-Vorbild war ein gecachtes gray-matter-
 * Objekt und ließ sich NACHTRÄGLICH verändern.
 *
 * `matter(content)` cached je Input-String und gibt allen Parsern desselben
 * Inhalts dasselbe `data`-Objekt zurück. Wer es ungeklont ins Audit reicht,
 * hält über mehrere `await`s hinweg einen fremden Cache-Eintrag — ein zweiter
 * Parse desselben Inhalts mutiert dann das schon protokollierte `diff_before`.
 * Dieselbe Falle wie in related-enrich.ts:230 und memory-mutate.ts:153.
 *
 * Runner: node --import tsx --test packages/core/__tests__/audit-preimage-clone.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { Vault } from "../src/vault.js";
import { AuditLog } from "../src/audit-log.js";
import { auditedSoftDelete } from "../src/audit-save.js";
import { saveMemory } from "../src/save.js";
import type { SaveMemoryInput } from "../src/save-schema.js";

test("das Vorbild eines Soft-Deletes hängt nicht am gray-matter-Cache", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-audit-clone-"));
  const vault = new Vault(dir);
  await vault.init();
  const auditLog = new AuditLog(dir);
  t.after(async () => {
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const saved = await saveMemory(dir, {
    id: "loeschling",
    title: "Löschling",
    type: "lesson",
    summary: "s",
    body: "Body.",
    topic_path: ["t"],
    tags: ["eins", "zwei"],
    scope: "proj",
    recall_when: ["t"],
  } as SaveMemoryInput);
  await vault.reindexFile(saved.file_path);
  const raw = await readFile(saved.file_path, "utf8");

  const { audit } = await auditedSoftDelete({
    vault,
    auditLog,
    vaultRoot: dir,
    memoryID: "loeschling",
    context: { actor: "user" },
  });
  assert.deepEqual(audit.diff_before?.tags, ["eins", "zwei"]);

  // Derselbe Inhalt, zweiter Parse: gray-matter liefert den Cache-Eintrag,
  // aus dem das Vorbild gebildet wurde.
  const parsed = matter(raw).data as Record<string, unknown>;
  (parsed.tags as string[]).push("GESCHMUGGELT");
  parsed.title = "GESCHMUGGELT";

  assert.deepEqual(
    audit.diff_before?.tags,
    ["eins", "zwei"],
    "ein protokolliertes Vorbild darf sich nicht nachträglich ändern lassen",
  );
  assert.equal(audit.diff_before?.title, "Löschling");
});
