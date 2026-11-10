import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { migrateTaskApprovalRegistry, readApprovalRegistry, bytesHash } from "../src/task-approval-keys.js";

const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const legacyRegistry = { schema_version: 1, revision: 7, protected_boundary: true,
  keys: [{ id: "old-key", domain: "personal", public_key: publicKey, fingerprint: bytesHash(publicKey) }],
  targets: [{ id: "artifact", root: "/synthetic/work", path: "result.txt", owner_domains: ["personal"], sensitivity: "private", adapter: "local-artifact-v1" }],
  key_storage_roots: ["/synthetic/keys"] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-chat-registry-")), legacy = join(root, "task-approval-keys.json"), current = join(root, "task-action-registry.json");
  const original = JSON.stringify(legacyRegistry, null, 2) + "\n";
  await writeFile(legacy, original, { mode: 0o600 });
  const taskBytes = await readFile(new URL("./fixtures/tasks-pre-db-e1191a2a.json", import.meta.url), "utf8");
  await writeFile(join(root, "tasks.json"), taskBytes, { mode: 0o600 });
  return { root, legacy, current, original, taskBytes };
}
test("chat registry migration backs up exact old bytes, renames legacy and preserves task fixture and targets", async () => {
  const f = await fixture();
  await migrateTaskApprovalRegistry(f.current);
  assert.equal(await readFile(f.legacy + ".pre-chat-approval.bak", "utf8"), f.original);
  assert.equal(await readFile(f.legacy + ".legacy", "utf8"), f.original);
  await assert.rejects(stat(f.legacy), { code: "ENOENT" });
  const migrated = await readApprovalRegistry(f.current);
  assert.deepEqual(migrated?.targets, legacyRegistry.targets);
  assert.deepEqual(migrated?.key_storage_roots, legacyRegistry.key_storage_roots);
  assert.deepEqual(migrated?.keys, []);
  assert.equal(migrated?.protected_boundary, false);
  assert.equal(migrated?.revision, 8);
  assert.equal(await readFile(join(f.root, "tasks.json"), "utf8"), f.taskBytes);
  const bytes = await readFile(f.current, "utf8");
  await migrateTaskApprovalRegistry(f.current);
  assert.equal(await readFile(f.current, "utf8"), bytes);
  assert.equal((await stat(f.current)).mode & 0o077, 0);
});
test("interrupted migration after rename recovers from preserved archive without replacing backup", async () => {
  const f = await fixture();
  await writeFile(f.legacy + ".pre-chat-approval.bak", f.original, { mode: 0o600 });
  await rename(f.legacy, f.legacy + ".legacy");
  await migrateTaskApprovalRegistry(f.current);
  assert.deepEqual((await readApprovalRegistry(f.current))?.targets, legacyRegistry.targets);
  assert.equal(await readFile(f.legacy + ".pre-chat-approval.bak", "utf8"), f.original);
});
test("corrupt or unsafe legacy data and mismatched backup remain untouched", async () => {
  for (const failure of ["corrupt", "backup", "symlink"]) {
    const f = await fixture();
    if (failure === "corrupt") await writeFile(f.legacy, "{broken");
    if (failure === "backup") await writeFile(f.legacy + ".pre-chat-approval.bak", "{}", { mode: 0o600 });
    if (failure === "symlink") { await rename(f.legacy, f.legacy + ".source"); await symlink(f.legacy + ".source", f.legacy); }
    const before = await readFile(f.legacy, "utf8");
    await assert.rejects(migrateTaskApprovalRegistry(f.current));
    assert.equal(await readFile(f.legacy, "utf8"), before);
    await assert.rejects(stat(f.current), { code: "ENOENT" });
  }
});
