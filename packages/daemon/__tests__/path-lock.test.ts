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
import { hostname, tmpdir } from "node:os";
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

test("#1207: dead and aged empty mutation guards recover in both lanes", async (t) => {
  const { utimes } = await import("node:fs/promises");
  const { tryWithPathLock } = await import("../src/path-lock.js");
  const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const advisory of [false, true]) for (const body of ["", "invalid", JSON.stringify({ pid: 2147483647, host: hostname(), ts: Date.now(), token: "dead" })]) {
    const state = join(dir, "state.json");
    const guard = `${pathLockFilePath(state)}.mutation`;
    await writeFile(guard, body);
    if (body === "" || body === "invalid") {
      const old = new Date(Date.now() - 6_000);
      await utimes(guard, old, old);
    }
    assert.equal(advisory
      ? await tryWithPathLock(state, async () => "recovered", { crossProcess: true })
      : await withPathLock(state, async () => "recovered", { crossProcess: true, requireLock: true }), "recovered");
    assert.equal(existsSync(guard), false);
  }
});

test("#1207: fresh live, remote and empty mutation guards stay protected", async (t) => {
  const { PathLockUnavailableError, tryWithPathLock } = await import("../src/path-lock.js");
  const { utimes } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-guard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const body of ["", JSON.stringify({ pid: process.pid, host: hostname(), ts: 1, token: "live" }), JSON.stringify({ pid: 2147483647, host: "remote", ts: 1, token: "remote" })]) {
    const state = join(dir, "state.json");
    const guard = `${pathLockFilePath(state)}.mutation`;
    await writeFile(guard, body);
    const start = Date.now();
    await utimes(guard, new Date(start + 60_000), new Date(start + 60_000));
    let ticks = 0;
    t.mock.method(Date, "now", () => start + 6_000 * ticks++);
    assert.equal(await withPathLock(state, async () => "fail-open", { crossProcess: true }), "fail-open");
    ticks = 0;
    await assert.rejects(withPathLock(state, async () => assert.fail("must not write"), { crossProcess: true, requireLock: true }), PathLockUnavailableError);
    ticks = 0;
    assert.equal(await tryWithPathLock(state, async () => assert.fail("must not write"), { crossProcess: true }), undefined);
    assert.equal(await readFile(guard, "utf8"), body);
    t.mock.restoreAll();
  }
});


test("#1207: recovery preserves a concurrently replaced live marker", async (t) => {
  const fs = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const { tryWithPathLock } = await import("../src/path-lock.js");
  const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-restore-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, "state.json");
  const guard = `${pathLockFilePath(state)}.mutation`;
  await writeFile(guard, JSON.stringify({ pid: 2147483647, host: hostname(), ts: 1, token: "dead" }));
  const replacement = JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now(), token: "live" });
  const open = fs.default.openSync;
  t.mock.method(fs.default, "openSync", (...args: Parameters<typeof open>) => {
    const fd = open(...args);
    if (args[0] === `${guard}.recover`) fs.default.writeFileSync(guard, replacement);
    return fd;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(await tryWithPathLock(state, async () => assert.fail("live marker must block"), { crossProcess: true }), undefined);
  assert.equal(await readFile(guard, "utf8"), replacement);
});


test("#1207: recovery preserves a fresh empty replacement with identical bytes", async (t) => {
  const fs = await import("node:fs");
  const { utimes } = await import("node:fs/promises");
  const { syncBuiltinESMExports } = await import("node:module");
  const { tryWithPathLock } = await import("../src/path-lock.js");
  const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-empty-restore-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, "state.json");
  const guard = `${pathLockFilePath(state)}.mutation`;
  await writeFile(guard, "");
  const old = new Date(Date.now() - 6_000);
  await utimes(guard, old, old);
  const open = fs.default.openSync;
  t.mock.method(fs.default, "openSync", (...args: Parameters<typeof open>) => {
    const fd = open(...args);
    if (args[0] === `${guard}.recover`) {
      fs.default.unlinkSync(guard);
      fs.default.writeFileSync(guard, "");
    }
    return fd;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(await tryWithPathLock(state, async () => assert.fail("fresh marker must block"), { crossProcess: true }), undefined);
  assert.equal(await readFile(guard, "utf8"), "");
});


test("#1207: aged mutation and recovery markers expire regardless of owner", async (t) => {
  const { utimes, readdir } = await import("node:fs/promises");
  const { tryWithPathLock } = await import("../src/path-lock.js");
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  t.after(() => child.kill());
  const dir = await mkdtemp(join(tmpdir(), "bastra-aged-guard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const advisory of [false, true]) for (const owner of [
    { pid: child.pid!, host: hostname(), ts: 1, token: "live-other-process" },
    { pid: process.pid, host: "another-host", ts: 1, token: "remote" },
  ]) {
    const state = join(dir, "state.json");
    const guard = `${pathLockFilePath(state)}.mutation`;
    const old = new Date(Date.now() - 6_000);
    for (const marker of [guard, `${guard}.recover`]) {
      await writeFile(marker, JSON.stringify(owner));
      await utimes(marker, old, old);
    }
    if (advisory) {
      // Cleaning an interrupted recovery backs off once before acquiring wx.
      assert.equal(await tryWithPathLock(state, async () => "held", { crossProcess: true }), undefined);
      assert.equal(await tryWithPathLock(state, async () => "held", { crossProcess: true }), "held");
    } else {
      assert.equal(await withPathLock(state, async () => "held", { crossProcess: true, requireLock: true }), "held");
    }
    assert.deepEqual(await readdir(dir), []);
  }
});

test("#1207: owner cleanup tolerates ENOENT without failing lock acquisition", async (t) => {
  const fs = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const dir = await mkdtemp(join(tmpdir(), "bastra-owner-enoent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, "state.json"), guard = `${pathLockFilePath(state)}.mutation`;
  const unlink = fs.default.unlinkSync;
  t.mock.method(fs.default, "unlinkSync", (...args: Parameters<typeof unlink>) => {
    if (args[0] === guard) { unlink(...args); throw Object.assign(new Error("already removed"), { code: "ENOENT" }); }
    return unlink(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(await withPathLock(state, async () => "held", { crossProcess: true, requireLock: true }), "held");
  assert.equal(existsSync(pathLockFilePath(state)), false);
  assert.equal(existsSync(guard), false);
});

test("#1207: competing recovery never moves a live owner's guard or strands its lease", { timeout: 15_000 }, async (t) => {
  const { spawn } = await import("node:child_process");
  const { readdir } = await import("node:fs/promises");
  const { setTimeout: delay } = await import("node:timers/promises");
  const dir = await mkdtemp(join(tmpdir(), "bastra-recovery-interleave-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, "state.json"), guard = `${pathLockFilePath(state)}.mutation`;
  await writeFile(guard, JSON.stringify({ pid: 2147483647, host: hostname(), ts: 1, token: "dead" }));
  const worker = join(dir, "worker.mts");
  await writeFile(worker, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const [state, role] = process.argv.slice(2), guard = state + '.lock.mutation';
    const flag = name => state + '.' + name;
    const signal = name => fs.writeFileSync(flag(name), '');
    const wait = name => {
      const end = Date.now() + 10000;
      while (!fs.existsSync(flag(name))) {
        if (Date.now() > end) throw new Error('timed out at '+name);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      }
    };
    const open = fs.openSync, fstat = fs.fstatSync, unlink = fs.unlinkSync, rename = fs.renameSync;
    let observedFd, paused = false;
    fs.openSync = (...args) => {
      const fd = open(...args);
      if (role === 'B' && args[0] === guard && args[1] === 'r') observedFd = fd;
      return fd;
    };
    fs.fstatSync = (...args) => {
      const st = fstat(...args);
      // B saw the dead inode. A recovers it and creates a live guard before
      // B proceeds. This is exactly the old rename-aside race window.
      if (role === 'B' && args[0] === observedFd && !paused) {
        paused = true; signal('B-observed'); wait('B-go');
      }
      return st;
    };
    fs.unlinkSync = (...args) => {
      if (role === 'A' && args[0] === guard && !paused) {
        let body; try { body = JSON.parse(fs.readFileSync(guard, 'utf8')); } catch {}
        if (body?.pid === process.pid) {
          paused = true; signal('A-owned'); wait('A-go');
        }
      }
      return unlink(...args);
    };
    fs.renameSync = (...args) => {
      const result = rename(...args);
      if (role === 'B' && args[0] === guard) {
        signal('B-moved'); wait('A-done');
      }
      return result;
    };
    syncBuiltinESMExports();
    const { withPathLock, tryWithPathLock } = await import(${JSON.stringify(new URL("../src/path-lock.ts", import.meta.url).href)});
    try {
      const result = role === 'A'
        ? await withPathLock(state, async () => 'held', { crossProcess: true, requireLock: true })
        : await tryWithPathLock(state, async () => 'held', { crossProcess: true });
      fs.writeFileSync(flag(role+'-result'), JSON.stringify({ result: result ?? null }));
    } catch (err) { fs.writeFileSync(flag(role+'-result'), JSON.stringify({ error: err.name })); }
    finally { signal(role+'-done'); }
  `);
  const start = (role: string) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, state, role], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const done = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${role}: ${stderr}`)));
    });
    void done.catch(() => {});
    return done;
  };
  const wait = async (...names: string[]) => {
    const end = Date.now() + 10_000;
    while (!names.some(name => existsSync(`${state}.${name}`))) {
      assert.ok(Date.now() < end, `timed out waiting for ${names}`);
      await delay(2);
    }
  };
  const b = start("B");
  await wait("B-observed");
  const a = start("A");
  await wait("A-owned");
  await writeFile(`${state}.B-go`, "");
  await wait("B-moved", "B-done");
  await writeFile(`${state}.A-go`, "");
  await Promise.all([a, b]);
  assert.deepEqual(JSON.parse(await readFile(`${state}.A-result`, "utf8")), { result: "held" });
  assert.equal(await withPathLock(state, async () => "next", { crossProcess: true, requireLock: true }), "next");
  assert.deepEqual((await readdir(dir)).filter(name => /\.lock(?:\.|$)/.test(name)), []);
});

test("#1207: owner cleanup leaves a replacement guard inode untouched", async (t) => {
  const fs = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const dir = await mkdtemp(join(tmpdir(), "bastra-owner-successor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, "state.json"), guard = `${pathLockFilePath(state)}.mutation`;
  const open = fs.default.openSync, fstat = fs.default.fstatSync;
  let ownerFd: number | undefined, swapped = false;
  const successor = JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now(), token: "successor" });
  t.mock.method(fs.default, "openSync", (...args: Parameters<typeof open>) => {
    const fd = open(...args);
    if (args[0] === guard && args[1] !== 'r') ownerFd = fd;
    return fd;
  });
  t.mock.method(fs.default, "fstatSync", (...args: Parameters<typeof fstat>) => {
    const st = fstat(...args);
    if (args[0] === ownerFd && !swapped) {
      swapped = true;
      fs.default.unlinkSync(guard);
      fs.default.writeFileSync(guard, successor, { flag: "wx", mode: 0o600 });
    }
    return st;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(await withPathLock(state, async () => {
    assert.equal(await readFile(guard, "utf8"), successor);
    await rm(guard); // Allow the real release to acquire its own guard.
    return "held";
  }, { crossProcess: true, requireLock: true }), "held");
  assert.equal(swapped, true);
});
