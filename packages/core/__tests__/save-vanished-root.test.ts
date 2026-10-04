/**
 * A save into a vault root this daemon once saw, but that is gone now (an
 * unmounted drive, a dropped share), must not recreate it on the parent
 * filesystem: `mkdir(recursive)` would bring the root back empty and
 * `vault_missing` would never be reported again. A root never seen keeps
 * the "created on first save" behaviour.
 *
 * #892 take-over: the knowledge moved from a per-process `Vault.rootKnownPresent`
 * flag passed into `saveMemory` to the guard in vault-root-guard.ts, which every
 * writer consults and which persists outside the vault; the cases stay the same.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";
import { vaultRootFirstSeen } from "../src/vault-root-guard.js";
import { saveMemory } from "../src/save.js";
import { AuditLog } from "../src/audit-log.js";
import { auditedSave } from "../src/audit-save.js";
import type { SaveMemoryInput } from "../src/save-schema.js";

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

test("save refuses to recreate a vault root that was present at init", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "bastra-vanished-root-"));
  const root = path.join(parent, "vault");
  try {
    await mkdir(root);
    const vault = new Vault(root);
    await vault.init();
    assert.notEqual(vaultRootFirstSeen(root), null);

    // The mount goes away under the running daemon.
    await rm(root, { recursive: true, force: true });

    await assert.rejects(
      saveMemory(root, input()),
      /missing/,
    );
    assert.equal(existsSync(root), false, "the vault root must not be recreated");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a root never seen present is still created on first save", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "bastra-vanished-root-"));
  const root = path.join(parent, "vault");
  try {
    const vault = new Vault(root);
    await vault.init().catch(() => undefined);
    assert.equal(vaultRootFirstSeen(root), null);

    await saveMemory(root, input());
    assert.equal(existsSync(root), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the bridge's audited save refuses a vanished root too", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "bastra-vanished-root-"));
  const root = path.join(parent, "vault");
  try {
    await mkdir(root);
    const vault = new Vault(root);
    await vault.init();
    await rm(root, { recursive: true, force: true });

    await assert.rejects(
      auditedSave({
        vault,
        auditLog: new AuditLog(root),
        vaultRoot: root,
        input: input(),
        context: { actor: "user" },
      }),
      /missing/,
    );
    assert.equal(existsSync(root), false, "the vault root must not be recreated");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a re-run of init while the root is gone does not forget it was there", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "bastra-vanished-root-"));
  const root = path.join(parent, "vault");
  try {
    await mkdir(root);
    const vault = new Vault(root);
    await vault.init();
    await rm(root, { recursive: true, force: true });
    await vault.init().catch(() => undefined);

    await assert.rejects(saveMemory(root, input()), /missing/);
    assert.equal(existsSync(root), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a root created by the first save is known from then on", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "bastra-vanished-root-"));
  const root = path.join(parent, "vault");
  try {
    const vault = new Vault(root);
    await vault.init().catch(() => undefined);
    const first = await saveMemory(root, input());
    await vault.reindexFile(first.file_path);
    await rm(root, { recursive: true, force: true });

    await assert.rejects(saveMemory(root, input()), /missing/);
    assert.equal(existsSync(root), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
