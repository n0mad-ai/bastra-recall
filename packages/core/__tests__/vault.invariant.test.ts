/**
 * Invariants of the vault write path (docs/invariants.md, #1570).
 *
 * Each test title starts with its catalog ID. A test here is never weakened or
 * deleted without changing the catalog entry on purpose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMemory } from "../src/save.js";
import type { SaveMemoryInput } from "../src/save-schema.js";
import { Vault } from "../src/vault.js";

function input(over: Partial<SaveMemoryInput> = {}): SaveMemoryInput {
  return {
    title: "Invariant Fixture",
    type: "lesson",
    summary: "a fixture memory",
    topic_path: ["test"],
    tags: ["test"],
    scope: "testproj",
    recall_when: ["when testing invariants"],
    body: "The original body.",
    ...over,
  } as SaveMemoryInput;
}

async function tempVault(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-inv-vault-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

test("INV-VAULT-01: a save without overwrite never replaces an existing memory", async (t) => {
  const dir = await tempVault(t);
  const first = await saveMemory(dir, input());
  const before = await readFile(first.file_path, "utf8");

  await assert.rejects(saveMemory(dir, input({ body: "A different body." })), /already exists/);

  assert.equal(await readFile(first.file_path, "utf8"), before, "the stored bytes are untouched");
});

test("INV-VAULT-02: a saved memory is found by its id, also by a freshly opened vault", async (t) => {
  const dir = await tempVault(t);
  const body = "Body with ünïcödé, a `code span` and a second line.\n\nThird paragraph.";
  const saved = await saveMemory(dir, input({ body }));

  const vault = new Vault(dir);
  t.after(() => vault.stop());
  await vault.init();
  const loaded = vault.get(saved.id);
  assert.ok(loaded, `memory ${saved.id} resolves by id`);
  assert.equal(loaded.fm.id, saved.id);
  assert.equal(loaded.body.trim(), body);
});
