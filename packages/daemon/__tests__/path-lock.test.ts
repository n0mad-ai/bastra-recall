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

// Force the exact #1207 interleaving at the filesystem boundary. No sleep or
// probabilistic timing: the age check returns the old stat after replacement.
test("#1207: a replacement between age inspection and removal survives", async (t) => {
  const fs = await import("node:fs/promises");
  const { syncBuiltinESMExports } = await import("node:module");
  const { utimes } = fs;
  const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-stale-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, "state.json");
  const lock = pathLockFilePath(state);
  await writeFile(lock, JSON.stringify({ token: "old" }));
  const start = Date.now();
  await utimes(lock, new Date(start - 20_000), new Date(start - 20_000));
  const successor = JSON.stringify({ token: "new" });
  const originalStat = fs.default.stat;
  let replaced = false;
  t.mock.method(fs.default, "stat", async (...args: Parameters<typeof originalStat>) => {
    const result = await originalStat(...args);
    if (args[0] === lock && !replaced) {
      await fs.unlink(lock);
      await writeFile(lock, successor);
      replaced = true;
      // Reach the existing timeout without making the successor stale.
      t.mock.method(Date, "now", () => start + 6_000);
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let ran = false;
  const { PathLockUnavailableError } = await import("../src/path-lock.js");
  await assert.rejects(withPathLock(state, async () => { ran = true; }, { crossProcess: true, requireLock: true }), PathLockUnavailableError);
  assert.equal(replaced, true);
  assert.equal(ran, false);
  assert.equal(await readFile(lock, "utf8"), successor);
});

test("#1207: an unchanged stale token is reclaimed, including the advisory lane", async (t) => {
  const { utimes } = await import("node:fs/promises");
  const { tryWithPathLock } = await import("../src/path-lock.js");
  const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-reclaim-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const advisory of [false, true]) {
    const state = join(dir, String(advisory));
    const lock = pathLockFilePath(state);
    await writeFile(lock, JSON.stringify({ token: "old" }));
    const old = new Date(Date.now() - 20_000);
    await utimes(lock, old, old);
    const callback = async () => {
      assert.notEqual(JSON.parse(await readFile(lock, "utf8")).token, "old");
      return "held";
    };
    assert.equal(advisory
      ? await tryWithPathLock(state, callback, { crossProcess: true, takeOverStale: true })
      : await withPathLock(state, callback, { crossProcess: true, requireLock: true }), "held");
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(`${lock}.mutation`), false);
  }
});

test("#1207: overlapping processes reclaim once and retain every write", { timeout: 30_000 }, async (t) => {
  const { spawn } = await import("node:child_process");
  const { utimes, readdir } = await import("node:fs/promises");
  const module = new URL("../src/path-lock.ts", import.meta.url).href;
  const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-load-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worker = join(dir, "worker.mts");
  await writeFile(worker, `
    import { withPathLock } from ${JSON.stringify(module)};
    import { readFile, writeFile, open, unlink } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    const [state, id, count] = process.argv.slice(2);
    process.send('ready');
    await new Promise(resolve => process.once('message', resolve));
    for (let i = 0; i < Number(count); i++) {
      await withPathLock(state, async () => {
        // Independent O_EXCL sentinel detects ANY overlapping callback.
        const active = state + '.active';
        const handle = await open(active, 'wx');
        try {
          const rows = JSON.parse(await readFile(state, 'utf8'));
          await delay(2);
          rows.push(id + ':' + i);
          await writeFile(state, JSON.stringify(rows));
        } finally { await handle.close(); await unlink(active); }
      }, { crossProcess: true, requireLock: true });
    }
  `);
  const rounds = 5, processes = 4, writes = 25;
  for (let round = 0; round < rounds; round++) {
    const state = join(dir, `round-${round}.json`);
    await writeFile(state, "[]");
    await writeFile(pathLockFilePath(state), JSON.stringify({ token: `stale-${round}` }));
    const old = new Date(Date.now() - 20_000);
    await utimes(pathLockFilePath(state), old, old);
    const children = Array.from({ length: processes }, (_, id) => {
      const child = spawn(process.execPath, ["--import", "tsx", worker, state, String(id), String(writes)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let stderr = "";
      child.stderr!.on("data", chunk => { stderr += chunk; });
      const ready = new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve());
        child.once("error", reject);
        child.once("exit", () => reject(new Error(`worker exited before start: ${stderr}`)));
      });
      const done = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => code === 0 ? resolve() : reject(new Error(`worker ${id} exited ${code}: ${stderr}`)));
      });
      // Attach immediately so a startup failure cannot become unhandled.
      void done.catch(() => {});
      t.after(() => { if (child.exitCode === null) child.kill(); });
      return { child, ready, done };
    });
    await Promise.all(children.map(c => c.ready));
    for (const c of children) c.child.send("start");
    await Promise.all(children.map(c => c.done));
    const rows = JSON.parse(await readFile(state, "utf8")) as string[];
    assert.equal(rows.length, processes * writes, `round ${round}: lost writes`);
    assert.equal(new Set(rows).size, processes * writes);
  }
  assert.equal((await readdir(dir)).filter(name => name.endsWith(".lock") || name.endsWith(".mutation") || name.endsWith(".active")).length, 0);
  t.diagnostic(`${rounds} rounds × ${processes} processes × ${writes} writes = ${rounds * processes * writes} writes; 0 simultaneous holders, 0 lost writes`);
});

test("#1207: an interrupted mutation guard still honors timeout and fail-open", async (t) => {
  const { PathLockUnavailableError, tryWithPathLock } = await import("../src/path-lock.js");
  const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-guard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, "state.json");
  const guard = `${pathLockFilePath(state)}.mutation`;
  await writeFile(guard, "");
  const start = Date.now();
  let ticks = 0;
  t.mock.method(Date, "now", () => start + 6_000 * ticks++);
  assert.equal(await withPathLock(state, async () => "fail-open", { crossProcess: true }), "fail-open");
  await assert.rejects(withPathLock(state, async () => assert.fail("must not write"), { crossProcess: true, requireLock: true }), PathLockUnavailableError);
  assert.equal(await tryWithPathLock(state, async () => assert.fail("must not write"), { crossProcess: true, takeOverStale: true }), undefined);
  assert.equal(existsSync(guard), true, "a busy/unknown guard must never be reaped by age");
  assert.equal(existsSync(pathLockFilePath(state)), false);
});
