/**
 * #892: one guard for every writer under the vault root, and a marker outside
 * the vault that survives a restart. A root seen present once and missing now
 * is a drive that is not mounted: no writer may create anything there — not
 * the save, not the locks, not the audit log, not the embedding files. A root
 * never seen is created only by a writer that makes a vault (a save).
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/core/__tests__/vault-root-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";
import { saveMemory } from "../src/save.js";
import { AuditLog } from "../src/audit-log.js";
import { withIdClaim } from "../src/id-transaction.js";
import { withAreaExclusive } from "../src/area-claim.js";
import { EmbedCache } from "../src/embed-cache.js";
import { EmbeddingIndex } from "../src/embeddings.js";
import type { EmbeddingProvider } from "../src/embedding-providers.js";
import { ensureVaultDir, VaultRootMissingError, vaultRootFirstSeen, vaultRootsPath } from "../src/vault-root-guard.js";
import type { SaveMemoryInput } from "../src/save-schema.js";

// This file's own marker, so a "restart" can be staged by writing it directly.
process.env.BASTRA_VAULT_ROOTS_PATH = path.join(await mkdtemp(path.join(tmpdir(), "bastra-guard-roots-")), "vault-roots.json");

function input(): SaveMemoryInput {
  return {
    title: "Mount check",
    type: "lesson",
    summary: "a save into a vanished vault",
    topic_path: ["ops"],
    tags: ["mount"],
    scope: "testproj",
    recall_when: ["when the vault mount is gone"],
    body: "Body.",
  } as SaveMemoryInput;
}

/** A vault the daemon saw at init, then the mount goes away. */
async function vanished(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "bastra-guard-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "vault");
  await mkdir(root);
  await new Vault(root).init();
  await rm(root, { recursive: true, force: true });
  return root;
}

test("the marker is written once the root was seen, outside the vault", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "bastra-guard-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "vault");
  await mkdir(root);
  assert.equal(vaultRootFirstSeen(root), null);
  await new Vault(root).init();
  const roots = JSON.parse(await readFile(vaultRootsPath(), "utf8")) as Record<string, { first_seen: string }>;
  assert.match(roots[path.resolve(root)]?.first_seen ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!vaultRootsPath().startsWith(root), "the marker must not live inside the vault");
});

test("after a restart: a root listed in the marker but missing is never recreated", async (t) => {
  // A path this process never saw — only the marker file knows it, as after a
  // daemon restart with the drive not mounted yet.
  const parent = await mkdtemp(path.join(tmpdir(), "bastra-guard-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "vault");
  const roots = JSON.parse(await readFile(vaultRootsPath(), "utf8").catch(() => "{}")) as Record<string, unknown>;
  roots[path.resolve(root)] = { first_seen: "2026-01-02T03:04:05.000Z" };
  await writeFile(vaultRootsPath(), JSON.stringify(roots));

  await new Vault(root).init().catch(() => undefined);
  await assert.rejects(saveMemory(root, input()), (err: unknown) => {
    assert.ok(err instanceof VaultRootMissingError);
    assert.match(err.message, /first seen 2026-01-02/);
    return true;
  });
  assert.equal(existsSync(root), false, "nothing may be created on the parent filesystem");
});

test("locks: the id claim and the area claim refuse a vanished root", async (t) => {
  const root = await vanished(t);
  await assert.rejects(withIdClaim({ vaultRoot: root, id: "x", filePath: path.join(root, "x.md") }, async () => undefined), /missing/);
  await assert.rejects(withAreaExclusive(root, ["ops"], async () => undefined), /missing/);
  assert.equal(existsSync(root), false);
});

test("the audit log refuses a vanished root", async (t) => {
  const root = await vanished(t);
  await assert.rejects(
    new AuditLog(root).record({ memory_id: "x", actor: "user", operation: "create", diff_before: null, diff_after: null }),
    /missing/,
  );
  assert.equal(existsSync(root), false);
});

test("embeddings: neither the vector file nor the embed cache recreates a vanished root", async (t) => {
  const root = await vanished(t);
  const persistPath = path.join(root, ".bastra", "embeddings.json");
  const cache = new EmbedCache(root, path.join(root, ".bastra", "embed-cache.json"), "test", 4);
  cache.set("x", "h");
  await cache.save();
  const provider = { id: "test", dim: 4, embed: async () => [] } as unknown as EmbeddingProvider;
  const idx = new EmbeddingIndex(new Vault(root), provider, persistPath);
  await (idx as unknown as { persist(): Promise<void> }).persist();
  assert.equal(existsSync(root), false);
});

test("a root never seen: a save creates it, a side writer does not", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "bastra-guard-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const fresh = path.join(parent, "fresh");
  await assert.rejects(ensureVaultDir(fresh, path.join(fresh, ".bastra", "usage")), /nothing has been saved there yet/);
  await assert.rejects(new AuditLog(fresh).record({ memory_id: "x", actor: "user", operation: "create", diff_before: null, diff_after: null }), /missing/);
  assert.equal(existsSync(fresh), false);

  await saveMemory(fresh, input());
  assert.equal(existsSync(fresh), true, "created on first save");
  assert.notEqual(vaultRootFirstSeen(fresh), null, "and known from then on");
});
