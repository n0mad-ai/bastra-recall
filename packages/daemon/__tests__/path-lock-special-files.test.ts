/**
 * A FIFO, a device symlink or a dangling symlink in place of a lock-family
 * file must never hang the process (contributor audit after #1213). Every case
 * runs in a child process with a hard kill timer: a blocking open() would
 * freeze this test's own event loop otherwise.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/path-lock-special-files.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathLockFilePath } from "../src/path-lock.js";

const SOURCE = new URL("../src/path-lock.ts", import.meta.url).href;
/** Exit codes of the child: the callback ran, or the regular lock error. */
const RAN = 0;
const UNAVAILABLE = 23;
const POSIX_ONLY = process.platform === "win32" ? { skip: "no mkfifo on Windows" } : {};

type Plant = "fifo" | "device" | "dangling" | "empty directory";

function plant(path: string, kind: Plant): void {
  if (kind === "fifo") execFileSync("mkfifo", [path]);
  else if (kind === "empty directory") mkdirSync(path);
  else symlinkSync(kind === "device" ? "/dev/zero" : `${path}.missing-target`, path);
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Runs one lock call in a child; resolves its exit status and elapsed time. */
async function lockInChild(state: string, call: string): Promise<{ status: number | null; ms: number }> {
  const code = `const {withPathLock,tryWithPathLock,PathLockUnavailableError}=await import(${JSON.stringify(SOURCE)});
const state=${JSON.stringify(state)};
try{const ran=await ${call};process.exit(ran===true?${RAN}:3)}catch(e){process.exit(e instanceof PathLockUnavailableError?${UNAVAILABLE}:2)}`;
  const started = Date.now();
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const [status, signal] = await once(child, "exit");
  clearTimeout(timer);
  assert.equal(signal, null, `the lock call hung: ${call}`);
  return { status, ms: Date.now() - started };
}

for (const kind of ["fifo", "device", "dangling", "empty directory"] as const) {
  test(
    `a ${kind} in place of the mutation guard is healed in every non-strict lane`,
    { ...POSIX_ONLY, timeout: 90_000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-special-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const calls = [
        "withPathLock(state,async()=>true,{crossProcess:true})",
        "withPathLock(state,async()=>true,{crossProcess:true,requireLock:true})",
        "tryWithPathLock(state,async()=>true,{crossProcess:true})",
      ];
      for (const [i, call] of calls.entries()) {
        const state = join(dir, `${i}.json`);
        const guard = `${pathLockFilePath(state)}.mutation`;
        plant(guard, kind);
        const { status } = await lockInChild(state, call);
        assert.equal(status, RAN, call);
        assert.equal(present(guard), false, "the invalid guard was removed");
      }
    }
  );

  test(
    `a ${kind} in place of the lease is removed in the non-strict lanes`,
    { ...POSIX_ONLY, timeout: 90_000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-special-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      for (const [i, opts] of ["{crossProcess:true}", "{crossProcess:true,requireLock:true}"].entries()) {
        const state = join(dir, `${i}.json`);
        plant(pathLockFilePath(state), kind);
        const { status, ms } = await lockInChild(state, `withPathLock(state,async()=>true,${opts})`);
        assert.equal(status, RAN, opts);
        // Healed at once, not by waiting out the five-second acquisition limit.
        assert.ok(ms < 4_500, `${opts} took ${ms} ms`);
        assert.equal(present(pathLockFilePath(state)), false, "released after the callback");
      }
    }
  );

  test(
    `a ${kind} in place of a strict-local lease is refused with the regular error`,
    { ...POSIX_ONLY, timeout: 60_000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-special-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const state = join(dir, "strict.json");
      const lock = pathLockFilePath(state);
      plant(lock, kind);
      const { status } = await lockInChild(state, "withPathLock(state,async()=>true,{strictLocal:true})");
      assert.equal(status, UNAVAILABLE);
      assert.ok(present(lock), "an unknown strict owner stays for explicit recovery");
    }
  );
}

test(
  "a FIFO in place of the recovery marker does not block the mutation guard",
  { ...POSIX_ONLY, timeout: 60_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-special-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const state = join(dir, "state.json");
    const guard = `${pathLockFilePath(state)}.mutation`;
    plant(guard, "fifo");
    plant(`${guard}.recover`, "fifo");
    const { status } = await lockInChild(state, "withPathLock(state,async()=>true,{crossProcess:true})");
    assert.equal(status, RAN);
  }
);

test(
  "an existing regular file stays readable: an oversized garbage lease still ages out",
  { timeout: 30_000 },
  async (t) => {
    const { writeFile, utimes } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-special-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const state = join(dir, "state.json");
    const lock = pathLockFilePath(state);
    await writeFile(lock, "x".repeat(200_000));
    const old = new Date(Date.now() - 20_000);
    await utimes(lock, old, old);
    const { status, ms } = await lockInChild(
      state,
      "withPathLock(state,async()=>true,{crossProcess:true,requireLock:true})"
    );
    assert.equal(status, RAN);
    assert.ok(ms < 4_500, `took ${ms} ms`);
    assert.equal(existsSync(lock), false);
  }
);

test(
  "a NON-EMPTY directory in place of the lease or guard is never deleted: the regular error instead",
  { ...POSIX_ONLY, timeout: 60_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-special-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    // The strict lane takes no mutation guard, so the guard case is non-strict.
    const cases = [
      {
        name: "lease",
        entry: (state: string) => pathLockFilePath(state),
        lanes: ["{crossProcess:true,requireLock:true}", "{strictLocal:true}"],
      },
      {
        name: "guard",
        entry: (state: string) => `${pathLockFilePath(state)}.mutation`,
        lanes: ["{crossProcess:true,requireLock:true}"],
      },
    ];
    await Promise.all(
      cases.flatMap(({ name, entry, lanes }) =>
        lanes.map(async (opts, i) => {
          const state = join(dir, `${name}-${i}.json`);
          mkdirSync(entry(state));
          await writeFile(join(entry(state), "keep.txt"), "content");
          const { status } = await lockInChild(state, `withPathLock(state,async()=>true,${opts})`);
          assert.equal(status, UNAVAILABLE, `${name} ${opts}`);
          assert.equal(await readFile(join(entry(state), "keep.txt"), "utf8"), "content", `${name} ${opts}`);
        })
      )
    );
  }
);

test(
  "a symlink to a regular file in place of the lease or guard: only the link goes, the target is untouched",
  { ...POSIX_ONLY, timeout: 60_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-special-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const target = join(dir, "precious.txt");
    const body = JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now(), token: "target" });
    await writeFile(target, body);
    for (const [i, entry] of [
      (state: string) => pathLockFilePath(state),
      (state: string) => `${pathLockFilePath(state)}.mutation`,
    ].entries()) {
      const state = join(dir, `${i}.json`);
      symlinkSync(target, entry(state));
      const { status } = await lockInChild(
        state,
        "withPathLock(state,async()=>true,{crossProcess:true,requireLock:true})"
      );
      assert.equal(status, RAN);
      assert.equal(present(entry(state)), false, "the link was removed");
      assert.equal(await readFile(target, "utf8"), body, "the link target is unchanged");
    }
  }
);

/** A live owner's lease or guard as this module writes it: this test's pid. */
function liveBody(): string {
  return JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now(), token: "live-owner" });
}

test(
  "a regular lease or guard of a LIVE owner is never removed: fresh, empty mid-create or oversized",
  { timeout: 60_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-special-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const bodies = { live: liveBody(), empty: "", oversized: " ".repeat(200_000) + liveBody() };
    const aged = new Date(Date.now() - 20_000);
    const cases = Object.entries(bodies).flatMap(([what, body]) => [
      // The non-strict lane decides by age alone: a fresh lease is held.
      { what, body, entry: "lease", opts: "{crossProcess:true,requireLock:true}", age: false },
      // The strict lane never takes over on age: only a provably dead owner.
      { what, body, entry: "lease", opts: "{strictLocal:true}", age: true },
    ]);
    // A fresh mutation guard is a writer inside its synchronous section. By
    // design it is bounded by age (four seconds) even for a live owner, so the
    // read logic must not cut that short: the contender waits it out.
    const guards = Object.entries(bodies).map(async ([what, body], i) => {
      const state = join(dir, `guard-${i}.json`);
      await writeFile(`${pathLockFilePath(state)}.mutation`, body);
      const { status, ms } = await lockInChild(state, "withPathLock(state,async()=>true,{crossProcess:true})");
      assert.equal(status, RAN, what);
      assert.ok(ms >= 3_500, `${what} guard was treated as dead after ${ms} ms`);
    });
    await Promise.all([
      ...cases.map(async ({ what, body, entry, opts, age }, i) => {
        const state = join(dir, `${i}.json`);
        const path = entry === "lease" ? pathLockFilePath(state) : `${pathLockFilePath(state)}.mutation`;
        await writeFile(path, body);
        if (age) await utimes(path, aged, aged);
        const { status } = await lockInChild(state, `withPathLock(state,async()=>true,${opts})`);
        assert.equal(status, UNAVAILABLE, `${what} ${entry} ${opts}`);
        assert.equal(await readFile(path, "utf8"), body, `${what} ${entry} ${opts} was kept`);
      }),
      ...guards,
    ]);
  }
);

test("an oversized reclaim marker is not taken for a dead owner's", { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-special-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, "state.json");
  const dead = JSON.stringify({ pid: 2147483647, host: hostname(), ts: 1, token: "dead" });
  await writeFile(pathLockFilePath(state), dead);
  const marker = `${pathLockFilePath(state)}.reclaim`;
  const big = " ".repeat(200_000) + dead;
  await writeFile(marker, big);
  const { status } = await lockInChild(state, "withPathLock(state,async()=>true,{strictLocal:true})");
  assert.equal(status, UNAVAILABLE);
  assert.equal(await readFile(marker, "utf8"), big, "an unprovable marker stays for explicit recovery");
});

test("a read error on a lease (EAGAIN, EINTR) never makes it dead or stale", { timeout: 60_000 }, async (t) => {
  const fs = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const { withPathLock, PathLockUnavailableError } = await import("../src/path-lock.js");
  const dir = await mkdtemp(join(tmpdir(), "bastra-path-lock-special-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const states = ["EAGAIN", "EINTR"].map((code) => ({ code, state: join(dir, `${code}.json`) }));
  const failing = new Map<number, string>();
  const open = fs.default.openSync;
  const read = fs.default.readSync;
  t.mock.method(fs.default, "openSync", (...args: Parameters<typeof open>) => {
    const fd = open(...args);
    const hit = states.find(({ state }) => args[0] === pathLockFilePath(state));
    if (hit) failing.set(fd, hit.code);
    else failing.delete(fd); // a reused descriptor number of another file
    return fd;
  });
  t.mock.method(fs.default, "readSync", (...args: Parameters<typeof read>) => {
    const code = failing.get(args[0]);
    if (code) throw Object.assign(new Error(code), { code });
    return read(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const aged = new Date(Date.now() - 20_000);
  for (const { code, state } of states) {
    // Aged and of a dead pid: only the failing read stands between it and removal.
    const body = JSON.stringify({ pid: 2147483647, host: hostname(), ts: 1, token: code });
    await writeFile(pathLockFilePath(state), body);
    await utimes(pathLockFilePath(state), aged, aged);
    for (const opts of [{ strictLocal: true }, { crossProcess: true, requireLock: true }]) {
      await assert.rejects(
        withPathLock(state, async () => true, opts),
        PathLockUnavailableError,
        `${code} ${JSON.stringify(opts)}`
      );
      assert.equal(await readFile(pathLockFilePath(state), "utf8"), body, `${code} ${JSON.stringify(opts)}`);
    }
  }
});
