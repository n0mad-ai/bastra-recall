import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureVaultDir, noteVaultRootPresent, vaultRootFirstSeen, VaultRootHistoryError, VaultRootMissingError } from "../src/vault-root-guard.js";

test("a corrupt vault-root history never turns a missing known vault into a new one", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-root-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.BASTRA_VAULT_ROOTS_PATH;
  const marker = join(dir, "vault-roots.json");
  process.env.BASTRA_VAULT_ROOTS_PATH = marker;
  t.after(() => {
    if (previous === undefined) delete process.env.BASTRA_VAULT_ROOTS_PATH;
    else process.env.BASTRA_VAULT_ROOTS_PATH = previous;
  });
  await writeFile(marker, "{broken");
  const root = join(dir, "missing-vault");
  await assert.rejects(ensureVaultDir(root, join(root, "memories"), { createRoot: true }), VaultRootHistoryError);
  assert.equal(existsSync(root), false);
  assert.equal(await readFile(marker, "utf8"), "{broken", "the corrupt history is preserved for repair");
});

test("a lost marker is re-persisted and child creation stays inside the root", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-root-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.BASTRA_VAULT_ROOTS_PATH;
  const marker = join(dir, "vault-roots.json");
  process.env.BASTRA_VAULT_ROOTS_PATH = marker;
  t.after(() => {
    if (previous === undefined) delete process.env.BASTRA_VAULT_ROOTS_PATH;
    else process.env.BASTRA_VAULT_ROOTS_PATH = previous;
  });
  const root = join(dir, "vault");
  await mkdir(root);
  noteVaultRootPresent(root);
  await rm(marker);
  await ensureVaultDir(root, join(root, "memories", "projects"));
  assert.equal(existsSync(join(root, "memories", "projects")), true);
  assert.ok(JSON.parse(await readFile(marker, "utf8"))[root], "the marker was restored before the writer returned");
  await assert.rejects(ensureVaultDir(root, join(dir, "outside")), /outside vault root/);
  assert.equal(existsSync(join(dir, "outside")), false);
});

test("a differently cased spelling cannot recreate a recorded root on a case-insensitive volume", { skip: process.platform !== "darwin" && process.platform !== "win32" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-root-case-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.BASTRA_VAULT_ROOTS_PATH;
  const marker = join(dir, "vault-roots.json");
  process.env.BASTRA_VAULT_ROOTS_PATH = marker;
  t.after(() => {
    if (previous === undefined) delete process.env.BASTRA_VAULT_ROOTS_PATH;
    else process.env.BASTRA_VAULT_ROOTS_PATH = previous;
  });
  const recorded = join(dir, "Vault");
  const alternate = join(dir, "vault");
  await mkdir(recorded);
  if (!existsSync(alternate)) { t.skip("temporary volume is case-sensitive"); return; }
  await writeFile(marker, JSON.stringify({ [recorded]: { first_seen: "2026-10-04T00:00:00.000Z" } }));
  await rmdir(recorded);

  assert.equal(vaultRootFirstSeen(alternate), "2026-10-04T00:00:00.000Z");
  await assert.rejects(ensureVaultDir(alternate, join(alternate, "memories"), { createRoot: true }), VaultRootMissingError);
  assert.equal(existsSync(alternate), false);
});
