/**
 * #365/3 — the audit ledger is cross-process, its read cache was per-instance.
 *
 * `AuditLog` kept `readAll()` in an instance field and only invalidated it in
 * its own `record()`. But `<vault>/.bastra/audit-log.ndjson` is written by the
 * daemon, the bridge and the CLI alike, so an instance never saw a foreign
 * append: `lastDeleteFor()` returned undefined for a delete that sits in the
 * file (and `auditedRestore` then threw `no delete audit-entry found`), and a
 * read of a not-yet-existing ledger cached `[]` for the life of the process —
 * the Mac-app audit view froze after its first call.
 *
 * The cache is now keyed on the file's `mtimeMs` + `size`, so a foreign append
 * invalidates it while an unchanged file still hits.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";
import { AuditLog } from "../src/audit-log.js";
import {
  auditedSave,
  auditedSoftDelete,
  auditedRestore,
} from "../src/audit-save.js";
import type { SaveMemoryInput } from "../src/save.js";

const CONTEXT = { actor: "assistant", reason: "test mutation" } as const;

const INPUT = {
  title: "Ledger Crossing",
  type: "lesson",
  summary: "Two processes, one ledger.",
  topic_path: ["ops"],
  tags: ["audit"],
  scope: "audittest",
  recall_when: ["when two processes share a ledger"],
  body: "Body v1.",
} as SaveMemoryInput;

/** A vault root plus two AuditLog instances on it — the daemon and the bridge. */
async function twoProcesses(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-audit-xproc-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { dir, writer: new AuditLog(dir), reader: new AuditLog(dir) };
}

test("a reader primed on a missing ledger still sees a foreign create", async (t) => {
  const { dir, writer, reader } = await twoProcesses(t);

  // The bridge reads before anything was ever written — this used to cache [].
  assert.deepEqual(await reader.readAll(), []);

  await writer.record({
    memory_id: "ledger-crossing",
    actor: "assistant",
    operation: "create",
    diff_before: null,
    diff_after: { id: "ledger-crossing" },
    file_path: path.join(dir, "ledger-crossing.md"),
    reason: "created elsewhere",
  });

  const seen = await reader.readAll();
  assert.equal(seen.length, 1, "the foreign create must be visible to the second instance");
  assert.equal(seen[0].memory_id, "ledger-crossing");
});

test("lastDeleteFor finds a delete another process appended", async (t) => {
  const { dir, writer, reader } = await twoProcesses(t);

  await writer.record({
    memory_id: "victim",
    actor: "user",
    operation: "create",
    diff_before: null,
    diff_after: { id: "victim" },
    file_path: path.join(dir, "victim.md"),
  });

  // The bridge primes its cache with a perfectly normal audit_for_memory call.
  assert.equal((await reader.forMemory("victim")).length, 1);
  assert.equal(await reader.lastDeleteFor("victim"), undefined);

  await writer.record({
    memory_id: "victim",
    actor: "user",
    operation: "delete",
    diff_before: { id: "victim" },
    diff_after: null,
    file_path: path.join(dir, "victim.md"),
  });

  const lastDelete = await reader.lastDeleteFor("victim");
  assert.ok(lastDelete, "the delete written by the other process must be found");
  assert.equal(lastDelete.operation, "delete");
  assert.equal((await reader.since("1970-01-01T00:00:00.000Z")).length, 2);
});

test("auditedRestore works when the delete was recorded through another instance", async (t) => {
  const { dir, writer, reader } = await twoProcesses(t);
  const vault = new Vault(dir);
  await vault.init();
  t.after(() => vault.stop?.());

  const saved = await auditedSave({
    vault,
    auditLog: writer,
    vaultRoot: dir,
    input: INPUT,
    context: CONTEXT,
  });
  await vault.reindexFile(saved.result.file_path);

  // The reader is warm — every earlier audit_for_memory/audit_since call does this.
  await reader.readAll();

  // Delete happens in the daemon...
  const deleted = await auditedSoftDelete({
    vault,
    auditLog: writer,
    vaultRoot: dir,
    memoryID: saved.result.id,
    context: CONTEXT,
  });

  // ...the restore in the bridge, with its own long-lived AuditLog instance.
  const restored = await auditedRestore({
    auditLog: reader,
    vaultRoot: dir,
    memoryID: saved.result.id,
    context: CONTEXT,
  });

  assert.equal(restored.restoredTo, saved.result.file_path);
  assert.match(await readFile(restored.restoredTo, "utf8"), /Body v1\./);
  assert.equal(deleted.trashPath.endsWith(`${saved.result.id}.md`), true);
});

test("an unchanged ledger still serves from the cache", async (t) => {
  const { writer } = await twoProcesses(t);

  await writer.record({
    memory_id: "cached",
    actor: "system",
    operation: "create",
    diff_before: null,
    diff_after: { id: "cached" },
  });

  const first = await writer.readAll();
  const second = await writer.readAll();
  assert.equal(second, first, "an unchanged file must not be re-parsed");

  await writer.record({
    memory_id: "cached",
    actor: "system",
    operation: "update",
    diff_before: { id: "cached" },
    diff_after: { id: "cached", v: 2 },
  });

  const third = await writer.readAll();
  assert.notEqual(third, first, "an append must invalidate the cache");
  assert.equal(third.length, 2);
});

/**
 * A stat() failure is not the same as a missing file. Keying the cache on
 * stat() means every read can fail for reasons that have nothing to do with
 * the ledger's content — an EIO/EACCES blip on a network or cloud mount. If
 * that dropped the warm cache, the blip would turn into a wrong answer:
 * lastDeleteFor() → undefined → auditedRestore throws `no delete
 * audit-entry found` (audit-save.ts:158) for a delete that is in the file.
 * Only ENOENT means "not there"; anything else serves the cache if warm and
 * throws if cold, rather than reporting an unreadable ledger as an empty one.
 */

/** stat() inside a 0o000 directory fails with EACCES — unless we are root. */
async function withUnreadableAuditDir(
  dir: string,
  fn: () => Promise<void>,
): Promise<void> {
  const bastraDir = path.join(dir, ".bastra");
  await chmod(bastraDir, 0o000);
  try {
    await fn();
  } finally {
    await chmod(bastraDir, 0o700);
  }
}

const rootless = process.getuid === undefined || process.getuid() !== 0;

test("a stat blip serves the warm cache instead of dropping it", { skip: !rootless }, async (t) => {
  const { dir, writer, reader } = await twoProcesses(t);

  await writer.record({
    memory_id: "victim",
    actor: "user",
    operation: "delete",
    diff_before: { id: "victim" },
    diff_after: null,
    file_path: path.join(dir, "victim.md"),
  });

  // The reader is warm — it read the ledger successfully once.
  assert.equal((await reader.readAll()).length, 1);

  await withUnreadableAuditDir(dir, async () => {
    const seen = await reader.readAll();
    assert.equal(seen.length, 1, "a read error must not empty out a valid cache");
    assert.equal(seen[0].memory_id, "victim");

    const lastDelete = await reader.lastDeleteFor("victim");
    assert.ok(lastDelete, "the delete must stay findable across a stat blip");
    assert.equal(lastDelete.operation, "delete");
  });
});

test("a stat error on a cold instance throws instead of reporting an empty ledger", { skip: !rootless }, async (t) => {
  const { dir, writer } = await twoProcesses(t);

  await writer.record({
    memory_id: "victim",
    actor: "user",
    operation: "delete",
    diff_before: { id: "victim" },
    diff_after: null,
  });

  await withUnreadableAuditDir(dir, async () => {
    // Cold instance: nothing cached, and the ledger is not missing — it is
    // unreadable. Claiming "no entries" here is the lie this guards against.
    const cold = new AuditLog(dir);
    await assert.rejects(() => cold.readAll(), (err: NodeJS.ErrnoException) => {
      assert.equal(err.code, "EACCES");
      return true;
    });
  });
});

test("a genuinely missing ledger is still an empty one, not a throw", async (t) => {
  const { reader } = await twoProcesses(t);
  assert.deepEqual(await reader.readAll(), [], "ENOENT stays the empty-ledger case");
});
