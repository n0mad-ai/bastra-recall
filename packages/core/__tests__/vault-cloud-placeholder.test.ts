import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { saveMemory } from "../src/save.js";
import { isCloudPlaceholderError } from "../src/cloud-placeholder.js";
import { Vault, VaultIOError } from "../src/vault.js";

test("cloud-only read errors are visible and logged once per state (#1242)", async t => {
  const root = await mkdtemp(join(tmpdir(), "bastra-invented-cloud-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "invented.md");
  await writeFile(file, "invented fixture only");
  const vault = new Vault(root);
  const error = Object.assign(new Error("Unknown system error -11"), { code: "EDEADLK", errno: -11 });
  t.mock.method(vault as any, "read", async () => { throw new VaultIOError(file, error); });
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args.join(" ")));
  t.mock.method(console, "error", (...args: unknown[]) => warnings.push(args.join(" ")));
  const report = await vault.init();
  assert.match(report.skipped[0].err, /cloud.*available offline/i);
  await vault.reconcile();
  await vault.reconcile();
  assert.equal(warnings.length, 1, "unchanged read failures must not spam retries");
  assert.deepEqual(vault.availability(), {
    not_loaded: 1, cloud_only: 1,
    warning: "1 vault files not loaded; 1 are only in the cloud (not downloaded). Make the vault folder available offline.",
  });
  t.mock.restoreAll();
  await vault.reconcile();
  assert.deepEqual(vault.availability(), { not_loaded: 0, cloud_only: 0, warning: null });
});


test("save refuses an invented cloud-only file with offline guidance (#1242)", async t => {
  const root = await mkdtemp(join(tmpdir(), "bastra-invented-save-cloud-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "invented.md");
  await writeFile(file, "invented fixture only");
  const original = fs.readFile;
  t.mock.method(fs, "readFile", async (...args: any[]) => {
    if (String(args[0]) === file) throw Object.assign(new Error("Unknown system error -11"), { code: "EDEADLK", errno: -11 });
    return (original as any)(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(saveMemory(root, {
    id: "invented", title: "Invented", type: "lesson", summary: "invented", body: "invented",
    topic_path: ["test"], tags: ["test"], scope: "test", recall_when: ["test"],
  }), /1 files are only in the cloud.*available offline/);
});

test("cloud classification keeps permission and Linux EAGAIN errors separate", () => {
  assert.equal(isCloudPlaceholderError({ code: "EACCES", errno: -13 }), false);
  assert.equal(isCloudPlaceholderError({ code: "EIO" }), false);
  if (process.platform !== "darwin") assert.equal(isCloudPlaceholderError({ code: "EAGAIN", errno: -11 }), false);
  assert.equal(isCloudPlaceholderError({ code: "EDEADLK" }), true);
});
