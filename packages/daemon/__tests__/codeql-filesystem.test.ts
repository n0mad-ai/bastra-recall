import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { cleanupMacAddressAdminStaging } from "../src/assistant-address-admin.js";

test("state paths normalize within the trusted root and reject sibling/absolute escapes", async () => {
  const { resolveStatePath } = await import("../src/state-path.js");
  const root = resolve(tmpdir(), "bastra-codeql-fixture");
  assert.equal(resolveStatePath(root, join(root, "nested", "..", "session.json")), join(root, "session.json"));
  for (const candidate of [join(root, "..", "outside.json"), `${root}-sibling/session.json`, resolve(root, ".."), root, "/etc/passwd"]) {
    assert.throws(() => resolveStatePath(root, candidate), /outside.*state root/);
  }
});

test("a metadata symlink swapped at the check/open boundary never authorizes staging removal", async (t) => {
  const fs = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "bastra-codeql-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "bastra-address-admin-fixture"); await mkdir(dir, { mode: 0o700 });
  const metadata = join(dir, "process.json"), outside = join(root, "outside.json");
  const content = JSON.stringify({ version: 1, createdAt: Date.now() - 3600000, adminPid: 2147483647 });
  await writeFile(metadata, content, { mode: 0o600 }); await writeFile(outside, content, { mode: 0o600 });
  let replaced = false;
  const replace = async () => { if (replaced) return; replaced = true; await fs.unlink(metadata); await symlink(outside, metadata); };
  const originalLstat = fs.default.lstat, originalOpen = fs.default.open;
  t.mock.method(fs.default, "lstat", async (...args: Parameters<typeof originalLstat>) => {
    const result = await originalLstat(...args);
    if (args[0] === metadata) await replace();
    return result;
  });
  t.mock.method(fs.default, "open", async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] === metadata) await replace();
    return originalOpen(...args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await cleanupMacAddressAdminStaging(root);
  assert.equal(replaced, true);
  assert.equal(existsSync(dir), true, "a swapped metadata path must not authorize deletion");
  assert.equal(await readFile(outside, "utf8"), content);
});

test("hostile session IDs keep state and lock artifacts below the configured directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-codeql-session-"));
  const previous = process.env.BASTRA_HOOK_STATE_DIR;
  process.env.BASTRA_HOOK_STATE_DIR = join(root, "state");
  t.after(async () => { if (previous === undefined) delete process.env.BASTRA_HOOK_STATE_DIR; else process.env.BASTRA_HOOK_STATE_DIR = previous; await rm(root, { recursive: true, force: true }); });
  const { saveSessionState, loadSessionState } = await import("../src/session-state.js");
  for (const id of ["../../outside", "/etc/passwd", "..\\..\\outside", "a/../../../outside", "session-normal"]) {
    await saveSessionState(id, { shown: { fixture: { count: 1, at: 1 } } });
    assert.equal((await loadSessionState(id)).shown.fixture?.count, 1);
  }
  const files = await (await import("node:fs/promises")).readdir(root);
  assert.deepEqual(files, ["state"]);
  const saved = await (await import("node:fs/promises")).readdir(join(root, "state"));
  assert.ok(saved.length > 0);
  assert.ok(saved.every(name => dirname(join(root, "state", name)) === join(root, "state")));
});
