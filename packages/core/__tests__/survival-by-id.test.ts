/**
 * Regression test — the "survival-by-id" substrate invariant.
 *
 * From the dev.to consensus with Mike Czerwinski (jugeni-contracts) and Raffaele
 * Zarrelli (cowork-os): a third-party layer — decisions/citations, govern-state —
 * can build on bastra-recall ONLY because a memory's id survives the engine's own
 * lifecycle operations. Turning that promise into a CI break is what makes it a
 * contract instead of a courtesy: survival becomes a result a third party can
 * re-run, not something either side has to remember to preserve.
 *
 * The invariant, pinned here:
 *   - demote (staleness aging) changes the recall SCORE only — never the file,
 *     never by-id resolution.
 *   - soft-delete moves the file into an append-only trash and records a delete
 *     entry; the active index drops it, but nothing evaporates — the trash file
 *     and the audit record persist, and a restore brings the id back.
 *
 * The day either operation starts evaporating the cell instead of demoting /
 * trashing it, this test goes red.
 *
 * NOTE: the #142 pin/floor primitive is implemented as DAEMON-side state
 * (packages/daemon/src/floors.ts — injection-layer-only, the engine score and
 * vault files are untouched by construction). Its survival arm is therefore
 * pinned next to the module, in the daemon suite (core must not import daemon;
 * cross-package imports in this repo only run daemon → core):
 *   packages/daemon/__tests__/floors.test.ts
 *   ("survival-by-id: retire/unpin drops to ranked without delete …")
 * The test.todo below stays as a signpost only.
 *
 * Runner: node --import tsx --test packages/core/__tests__/survival-by-id.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Vault,
  AuditLog,
  auditedSoftDelete,
  auditedRestore,
} from "../src/index.js";
import { computeStaleness } from "../src/search.js";

interface MemorySpec {
  id: string;
  title: string;
  type: string;
  summary: string;
  updated?: string;
}

function memoryMarkdown(spec: MemorySpec): string {
  const updated = spec.updated ?? new Date().toISOString();
  return [
    "---",
    `id: ${spec.id}`,
    `title: ${spec.title}`,
    `type: ${spec.type}`,
    `summary: ${spec.summary}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: test-scope",
    "recall_when:",
    `  - ${spec.title}`,
    `created: ${updated}`,
    `updated: ${updated}`,
    "---",
    "",
    `Body for ${spec.title}.`,
    "",
  ].join("\n");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

test("survival-by-id: demote (staleness) degrades score only — id resolves, file untouched", async () => {
  // A 200-day-old lesson: type default expiry is 180d → ratio ~1.1 → "stale"
  // (its recall score is multiplied down). Demote is a pure read-time effect.
  const oldDate = new Date(Date.now() - 200 * 86400_000).toISOString();
  const dir = await mkdtemp(join(tmpdir(), "bastra-survival-"));
  const file = join(dir, "demoted.md");
  await writeFile(
    file,
    memoryMarkdown({ id: "demoted", title: "demote probe", type: "lesson", summary: "x", updated: oldDate }),
    "utf8",
  );
  const vault = new Vault(dir);
  await vault.init();
  try {
    const before = await readFile(file, "utf8");

    const mem = vault.get("demoted");
    assert.ok(mem, "memory resolves by id");

    // It IS demoted — aging pushes it below fresh (multiplier < 1).
    const status = computeStaleness(mem!.fm as unknown as Record<string, unknown>, new Date());
    assert.ok(status === "stale" || status === "expired", `aged lesson is demoted (got "${status}")`);

    // ...yet by-id resolution survives, and demote never wrote to the file.
    assert.ok(vault.get("demoted"), "demoted memory still resolves by id");
    const after = await readFile(file, "utf8");
    assert.equal(after, before, "demote changed score only — the file is byte-identical");
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("survival-by-id: soft-delete trashes append-only — id leaves the active index but is recoverable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-survival-"));
  const file = join(dir, "trashed.md");
  await writeFile(
    file,
    memoryMarkdown({ id: "trashed", title: "trash probe", type: "lesson", summary: "x" }),
    "utf8",
  );
  const vault = new Vault(dir);
  await vault.init();
  const auditLog = new AuditLog(dir);
  try {
    const original = vault.get("trashed")?.filePath;
    assert.ok(original, "memory resolves by id before delete");

    // Soft-delete: move to append-only trash + record the delete.
    const { trashPath, audit } = await auditedSoftDelete({
      vault,
      auditLog,
      vaultRoot: dir,
      memoryID: "trashed",
      context: { actor: "user" },
    });
    // The fs watcher is cloud-unreliable; drop the index entry deterministically
    // (this is exactly what Vault.forgetFile exists for).
    vault.forgetFile(original!);

    // The "kill": it left the ACTIVE index.
    assert.equal(vault.get("trashed"), undefined, "after soft-delete, id is gone from the active index");

    // ...but nothing evaporated: the trash file and the append-only audit record persist.
    assert.ok(await fileExists(trashPath), "trashed file exists under .bastra/trash/");
    assert.ok(audit, "audit is null only when logging itself failed"); // #542
    assert.equal(audit.operation, "delete");
    const lastDelete = await auditLog.lastDeleteFor("trashed");
    assert.ok(lastDelete, "append-only audit holds the delete record");
    assert.equal(lastDelete!.file_path, original, "delete record carries the original path for restore");

    // Restore brings the id back — survival, not a tombstone.
    const { restoredTo } = await auditedRestore({
      auditLog,
      vaultRoot: dir,
      memoryID: "trashed",
      context: { actor: "user" },
    });
    await vault.reindexFile(restoredTo);
    assert.ok(vault.get("trashed"), "after restore, id resolves again");

    // The delete record SURVIVES the restore — the log is append-only.
    const history = await auditLog.forMemory("trashed");
    const ops = history.map((e) => e.operation);
    assert.ok(
      ops.includes("delete") && ops.includes("restore"),
      "audit keeps both delete and restore (append-only)",
    );
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// The #142 pin/floor primitive landed as daemon-side state (floors.ts), so the
// "retire" arm of the invariant lives in the daemon suite next to the module —
// packages/daemon/__tests__/floors.test.ts pins: floor + release leave the
// vault file BYTE-IDENTICAL and the engine ranking IDENTICAL before/during/
// after flooring (drop-to-ranked, never delete). Signpost only; core does not
// import daemon.
test.todo(
  "survival-by-id: retire/unpin drops to ranked without delete — pinned in packages/daemon/__tests__/floors.test.ts (#142/#153)",
);
