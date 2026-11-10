import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

test("probe credential copy refuses a source swapped to a symlink", async (t) => {
  const fs = await import("node:fs/promises");
  const { copyAuthSource } = await import("../probes/convention-e2e/auth-source.ts");
  const root = await mkdtemp(join(tmpdir(), "bastra-probe-auth-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "auth.json"), outside = join(root, "outside.json"), destination = join(root, "copy.json");
  await writeFile(file, "fixture"); await writeFile(outside, "outside-secret");
  let swapped = false;
  const swap = async () => { if (!swapped) { swapped = true; await fs.unlink(file); await symlink(outside, file); } };
  const originalLstat = fs.default.lstat, originalOpen = fs.default.open;
  t.mock.method(fs.default, "lstat", async (...args) => {
    const result = await originalLstat(...args); if (args[0] === file) await swap(); return result;
  });
  t.mock.method(fs.default, "open", async (...args) => {
    if (args[0] === file) await swap(); return originalOpen(...args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(copyAuthSource(file, destination));
  assert.equal(swapped, true); assert.equal(existsSync(destination), false);
});
