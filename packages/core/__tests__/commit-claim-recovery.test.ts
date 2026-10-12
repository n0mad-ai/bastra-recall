/** Deterministic commit-claim recovery gates and bounded crash/error leases. */
import test from "node:test";
import assert from "node:assert/strict";
import fsPromises, { mkdtemp, mkdir, readFile, readdir, rm, writeFile, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireCommitClaim, releaseCommitClaim, commitLockPathFor } from "../src/save-commit.js";
import { MEMORY_WRITE_CONFLICT } from "../src/save-schema.js";

const ID = "shared-memory";
async function harness(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "bastra-claim-recovery-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  return vault;
}

interface ClaimIoHooks {
  beforeRead?: (actor: string, file: unknown, count: number) => Promise<void>;
  afterRead?: (actor: string, file: unknown, count: number) => Promise<void>;
  afterOpen?: (actor: string, file: unknown, flags: unknown) => Promise<void>;
  afterStat?: (actor: string, file: unknown) => Promise<void>;
  beforeWrite?: (actor: string, file: unknown) => Promise<void>;
  beforeRename?: (actor: string, target: unknown) => Promise<void>;
  afterRename?: (actor: string, target: unknown) => Promise<void>;
  alterStat?: (file: unknown, info: any) => any;
}

function gate() {
  let open!: () => void;
  const waiting = new Promise<void>(resolve => { open = resolve; });
  return { waiting, open };
}

/** Real files, with gates only around the syscall boundaries under review. */
async function withClaimIo<T>(hooks: ClaimIoHooks, work: (actors: AsyncLocalStorage<string>) => Promise<T>): Promise<T> {
  const actors = new AsyncLocalStorage<string>();
  const reads = new Map<string, number>();
  const original = {
    readFile: fsPromises.readFile,
    open: fsPromises.open,
    stat: fsPromises.stat,
    rename: fsPromises.rename,
  };
  const read = async (file: unknown, run: () => Promise<unknown>) => {
    const actor = actors.getStore();
    if (!actor) return run();
    const key = `${actor}:${String(file)}`;
    const count = (reads.get(key) ?? 0) + 1;
    reads.set(key, count);
    await hooks.beforeRead?.(actor, file, count);
    const result = await run();
    await hooks.afterRead?.(actor, file, count);
    return result;
  };
  fsPromises.readFile = (async (file: unknown, ...args: unknown[]) =>
    read(file, () => Reflect.apply(original.readFile, fsPromises, [file, ...args]))) as typeof fsPromises.readFile;
  fsPromises.open = (async (file: unknown, ...args: unknown[]) => {
    const handle = await Reflect.apply(original.open, fsPromises, [file, ...args]);
    const actor = actors.getStore();
    if (actor) {
      await hooks.afterOpen?.(actor, file, args[0]);
      const realStat = handle.stat;
      handle.stat = async (...statArgs: unknown[]) => {
        const info = await Reflect.apply(realStat, handle, statArgs);
        return hooks.alterStat?.(file, info) ?? info;
      };
      const realRead = handle.readFile;
      handle.readFile = (...readArgs: unknown[]) => read(file, () => Reflect.apply(realRead, handle, readArgs));
      const realWrite = handle.writeFile;
      handle.writeFile = async (...writeArgs: unknown[]) => {
        await hooks.beforeWrite?.(actor, file);
        return Reflect.apply(realWrite, handle, writeArgs);
      };
    }
    return handle;
  }) as typeof fsPromises.open;
  fsPromises.stat = (async (file: unknown, ...args: unknown[]) => {
    const result = await Reflect.apply(original.stat, fsPromises, [file, ...args]);
    const actor = actors.getStore();
    if (actor) await hooks.afterStat?.(actor, file);
    return hooks.alterStat?.(file, result) ?? result;
  }) as typeof fsPromises.stat;
  fsPromises.rename = (async (from: unknown, target: unknown) => {
    const actor = actors.getStore();
    if (actor) await hooks.beforeRename?.(actor, target);
    const result = await Reflect.apply(original.rename, fsPromises, [from, target]);
    if (actor) await hooks.afterRename?.(actor, target);
    return result;
  }) as typeof fsPromises.rename;
  syncBuiltinESMExports();
  try {
    return await work(actors);
  } finally {
    Object.assign(fsPromises, original);
    syncBuiltinESMExports();
  }
}

async function oldClaim(t: Parameters<typeof harness>[0], raw: string) {
  const vault = await harness(t);
  const lock = commitLockPathFor(vault, ID);
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, raw, "utf8");
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);
  return { vault, lock, old };
}

const foreignClaim = JSON.stringify({ pid: 999999, host: "foreign-fixture", ts: 0, token: "abandoned-generation" });

test("late reclaimer cannot displace a live successor of the generation it checked", { timeout: 5000 }, async (t) => {
  const { vault, lock } = await oldClaim(t, foreignClaim);
  const bChecked = gate();
  const aAcquired = gate();
  const results = await withClaimIo({
    beforeRead: async (actor, file, count) => {
      if (file !== lock || count !== 2) return;
      if (actor === "A") await bChecked.waiting;
      if (actor === "B") {
        bChecked.open();
        await aAcquired.waiting;
      }
    },
  }, async actors => {
    const a = actors.run("A", () => acquireCommitClaim(lock, ID, path.join(vault, "a.md"))).finally(aAcquired.open);
    const b = actors.run("B", () => acquireCommitClaim(lock, ID, path.join(vault, "b.md")));
    return Promise.allSettled([a, b]);
  });
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  if (results[0].status !== "fulfilled" || results[1].status !== "rejected") throw new Error("unexpected claim results");
  assert.equal((results[1].reason as MemoryWriteConflictError).code, MEMORY_WRITE_CONFLICT);
  assert.equal(JSON.parse(await readFile(lock, "utf8")).token, results[0].value);
});

test("contenders for an abandoned reclaim marker cannot delete each other's fresh marker", { timeout: 5000 }, async (t) => {
  const { vault, lock, old } = await oldClaim(t, foreignClaim);
  const mark = `${lock}.reclaim-${createHash("sha256").update(foreignClaim).digest("hex").slice(0, 16)}`;
  await writeFile(mark, "", "utf8");
  await utimes(mark, old, old);
  const eInspected = gate();
  const dClaimed = gate();
  const eFinishedCheck = gate();
  const seen = new Set<string>();
  const results = await withClaimIo({
    afterStat: async (actor, file) => {
      if (file !== mark || seen.has(actor)) return;
      seen.add(actor);
      if (actor === "D") await eInspected.waiting;
      if (actor === "E") {
        eInspected.open();
        await dClaimed.waiting;
      }
    },
    afterOpen: async (actor, file, flags) => {
      if (actor === "D" && file === mark && flags === "wx") dClaimed.open();
    },
    afterRename: async (actor, target) => {
      if (actor === "D" && target === mark) dClaimed.open();
    },
    afterRead: async (actor, file, count) => {
      if (actor === "E" && file === lock && count === 3) eFinishedCheck.open();
    },
    beforeRename: async (actor, target) => {
      if (actor === "D" && target === lock) await eFinishedCheck.waiting;
    },
  }, async actors => {
    const d = actors.run("D", () => acquireCommitClaim(lock, ID, path.join(vault, "d.md")));
    const e = actors.run("E", () => acquireCommitClaim(lock, ID, path.join(vault, "e.md"))).finally(eFinishedCheck.open);
    return Promise.allSettled([d, e]);
  });
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  if (results[0].status !== "fulfilled") throw new Error("expected D to retain the claim");
  assert.equal(JSON.parse(await readFile(lock, "utf8")).token, results[0].value);
});

test("an abandoned empty claim cannot match a newly opened unwritten generation", { timeout: 5000 }, async (t) => {
  const { vault, lock } = await oldClaim(t, "");
  const bChecked = gate();
  const cOpened = gate();
  const bFinished = gate();
  const results = await withClaimIo({
    beforeRead: async (actor, file, count) => {
      if (file !== lock || count !== 2) return;
      if (actor === "A") await bChecked.waiting;
      if (actor === "B") {
        bChecked.open();
        await cOpened.waiting;
      }
    },
    afterOpen: async (actor, file, flags) => {
      if (actor === "C" && file === lock && flags === "wx") cOpened.open();
    },
    beforeWrite: async (actor, file) => {
      if (actor === "C" && file === lock) await bFinished.waiting;
    },
  }, async actors => {
    const b = actors.run("B", () => acquireCommitClaim(lock, ID, path.join(vault, "b.md"))).finally(bFinished.open);
    const a = await actors.run("A", () => acquireCommitClaim(lock, ID, path.join(vault, "a.md")));
    await releaseCommitClaim(lock, a);
    const c = actors.run("C", () => acquireCommitClaim(lock, ID, path.join(vault, "c.md")));
    return Promise.allSettled([b, c]);
  });
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  if (results[1].status !== "fulfilled") throw new Error("expected C to retain its new claim");
  assert.equal(JSON.parse(await readFile(lock, "utf8")).token, results[1].value);
});


test("a crashed marker reservation expires without manual lock deletion", { timeout: 5000 }, async (t) => {
  const { vault, lock, old } = await oldClaim(t, foreignClaim);
  const mark = `${lock}.reclaim-${createHash("sha256").update(foreignClaim).digest("hex").slice(0, 16)}`;
  await writeFile(mark, "", "utf8");
  await utimes(mark, old, old);
  const turn = `${mark}.turns/0`;
  const module = fileURLToPath(new URL("../src/save-commit.ts", import.meta.url));
  const script = `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
    const mkdir=fs.mkdir;fs.mkdir=async(p,...args)=>{const result=await mkdir(p,...args);if(p===process.env.KILL_TURN)process.kill(process.pid,'SIGKILL');return result;};syncBuiltinESMExports();
    const {acquireCommitClaim}=await import(process.env.CLAIM_MODULE);await acquireCommitClaim(process.env.CLAIM_LOCK,'fixture',process.env.CLAIM_TARGET);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, KILL_TURN: turn, CLAIM_MODULE: module, CLAIM_LOCK: lock, CLAIM_TARGET: path.join(vault, "killed.md") },
    stdio: "ignore",
  });
  const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (_code, signal) => resolve(signal));
  });
  assert.equal(signal, "SIGKILL");
  assert.ok(existsSync(turn));
  await assert.rejects(acquireCommitClaim(lock, ID, path.join(vault, "blocked.md")), { code: MEMORY_WRITE_CONFLICT });
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 60_001);
  const token = await acquireCommitClaim(lock, ID, path.join(vault, "recovered.md"));
  assert.equal(JSON.parse(await readFile(lock, "utf8")).token, token);
  assert.ok(!existsSync(turn), "superseded crash reservation is cleaned after recovery");
});

test("a one-shot marker inspection or publication error does not poison later acquisition", async (t) => {
  for (const failure of ["stat", "read", "rename"]) {
    const { vault, lock, old } = await oldClaim(t, foreignClaim);
    const mark = `${lock}.reclaim-${createHash("sha256").update(foreignClaim).digest("hex").slice(0, 16)}`;
    await writeFile(mark, "", "utf8");
    await utimes(mark, old, old);
    let injected = false;
    await withClaimIo({
      beforeRead: async (_actor, file, count) => {
        if (failure === "read" && file === mark && count === 2 && !injected) { injected = true; throw Object.assign(new Error("injected inspection error"), { code: "EBUSY" }); }
      },
      afterStat: async (_actor, file) => {
        if (failure === "stat" && file === mark && !injected) { injected = true; throw Object.assign(new Error("injected busy marker"), { code: "EBUSY" }); }
      },
      beforeRename: async (_actor, target) => {
        if (failure === "rename" && target === mark && !injected) { injected = true; throw Object.assign(new Error("injected publication error"), { code: "EIO" }); }
      },
    }, async actors => {
      await assert.rejects(actors.run("failed", () => acquireCommitClaim(lock, ID, path.join(vault, "failed.md"))), { code: MEMORY_WRITE_CONFLICT });
    });
    assert.ok(injected);
    const token = await acquireCommitClaim(lock, ID, path.join(vault, "retry.md"));
    assert.equal(JSON.parse(await readFile(lock, "utf8")).token, token);
    const names = await readdir(path.dirname(lock));
    assert.ok(!names.some(name => name.includes(".abandoned-")));
  }
});

test("changing cloud-style file attributes cannot prevent token-based stale recovery", async (t) => {
  const { vault, lock, old } = await oldClaim(t, foreignClaim);
  const mark = `${lock}.reclaim-${createHash("sha256").update(foreignClaim).digest("hex").slice(0, 16)}`;
  await writeFile(mark, "", "utf8");
  await utimes(mark, old, old);
  let sequence = 0;
  const now = Date.now();
  await withClaimIo({
    alterStat: (_file, info) => Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
      dev: ++sequence, ino: ++sequence, birthtimeMs: now + sequence, ctimeMs: now + sequence, mtimeMs: now,
    }),
  }, async actors => {
    await assert.rejects(actors.run("first", () => acquireCommitClaim(lock, ID, path.join(vault, "first.md"))), { code: MEMORY_WRITE_CONFLICT });
    t.mock.method(Date, "now", () => now + 60_001);
    const token = await actors.run("expired", () => acquireCommitClaim(lock, ID, path.join(vault, "recovered.md")));
    assert.equal(JSON.parse(await readFile(lock, "utf8")).token, token);
    await releaseCommitClaim(lock, token);
    const again = await actors.run("new", () => acquireCommitClaim(lock, ID, path.join(vault, "fresh.md")));
    assert.equal(JSON.parse(await readFile(lock, "utf8")).token, again);
  });
});

test("an incomplete legacy claim also expires when mount timestamps keep changing", async (t) => {
  const { vault, lock, old } = await oldClaim(t, "");
  const mark = `${lock}.reclaim-${createHash("sha256").update("").digest("hex").slice(0, 16)}`;
  await writeFile(mark, "", "utf8");
  await utimes(mark, old, old);
  const now = Date.now();
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  let sequence = 0;
  await withClaimIo({
    alterStat: (_file, info) => Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
      dev: ++sequence, ino: ++sequence, birthtimeMs: clock, ctimeMs: clock, mtimeMs: clock,
    }),
  }, async actors => {
    const acquire = () => actors.run("mount", () => acquireCommitClaim(lock, ID, path.join(vault, "recovered.md")));
    await assert.rejects(acquire(), { code: MEMORY_WRITE_CONFLICT });
    clock = now + 30_001;
    await assert.rejects(acquire(), { code: MEMORY_WRITE_CONFLICT });
    clock = now + 90_002;
    const token = await acquire();
    assert.equal(JSON.parse(await readFile(lock, "utf8")).token, token);
  });
});

test("successful marker turns are removed and retire legacy recovery witnesses", async (t) => {
  const { vault, lock, old } = await oldClaim(t, foreignClaim);
  const staleMark = `${lock}.reclaim-${createHash("sha256").update(foreignClaim).digest("hex").slice(0, 16)}`;
  await writeFile(staleMark, "", "utf8");
  await utimes(staleMark, old, old);
  const witness = `${staleMark}.abandoned-old-generation`;
  await writeFile(witness, "", "utf8");
  const token = await acquireCommitClaim(lock, ID, path.join(vault, "recovered.md"));
  assert.ok(!existsSync(witness));
  await releaseCommitClaim(lock, token);
  for (let i = 0; i < 12; i++) {
    const next = await acquireCommitClaim(lock, ID, path.join(vault, "fresh.md"));
    await releaseCommitClaim(lock, next);
  }
  const creationMark = `${lock}.reclaim-${createHash("sha256").update("").digest("hex").slice(0, 16)}`;
  const turns = await readdir(`${creationMark}.turns`);
  assert.equal(turns.length, 0);
  assert.equal(JSON.parse(await readFile(creationMark, "utf8")).held, false);
});
