/**
 * Release removes the cross-process lock only while it is still this
 * holder's. A holder whose critical section outlasted the stale age has had
 * its lock taken over; its release must not delete the successor's lock.
 *
 * Run: node --import tsx --test packages/daemon/__tests__/path-lock.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathLockFilePath, withPathLock } from "../src/path-lock.js";

test("A holder whose lock was taken over leaves the successor's lock in place", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, "state.json");
  const lockPath = pathLockFilePath(state);
  const successor = JSON.stringify({ pid: 999_999, host: "other", ts: Date.now(), token: "successor" });

  await withPathLock(
    state,
    async () => {
      assert.ok(existsSync(lockPath), "the holder owns the lock file");
      // Another process took the lock over as orphaned while this one was slow.
      await writeFile(lockPath, successor, "utf8");
    },
    { crossProcess: true },
  );
  assert.equal(await readFile(lockPath, "utf8"), successor, "the successor's lock was deleted");
});

test("A holder still owning its lock removes it on release", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, "state.json");
  assert.equal(await withPathLock(state, async () => existsSync(pathLockFilePath(state)), { crossProcess: true }), true);
  assert.equal(existsSync(pathLockFilePath(state)), false);
});
