/**
 * The build lock under attack (#582 counter-review).
 *
 * The lock exists for exactly one promise — "at most one Graphify per
 * repository" — and the ways it was broken were all races: a lock file that
 * was empty for a moment, a token checked far from the operation it guarded,
 * and a lock released while the child it protected was still writing. Each of
 * those is reproduced here, in-process where the interleaving can be forced
 * and across real processes where it cannot.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  acquireRepoLock,
  lockPath,
  readLock,
  UNREADABLE_GRACE_MS,
} from "../src/code-graph/lock.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const LOCK_MODULE = resolve(HERE, "..", "src", "code-graph", "lock.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("the build lock against adversarial interleavings", () => {
  it("does not hand the repository to two holders through an EMPTY lock file", async (t) => {
    // THE REPRODUCTION. Creating the file with O_EXCL and writing the record
    // afterwards left the lock EMPTY between the two calls. A competitor
    // reading it there parsed nothing, judged it junk, removed it and created
    // its own — two builders on the same repository, which is the one outcome
    // this module exists to prevent.
    const dir = await tempDir("bastra-lock-empty-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(lockPath(dir), "", "utf8");

    assert.equal(
      await acquireRepoLock(dir, { heartbeat: false }),
      null,
      "a lock file that just appeared is a competitor mid-publish, not junk",
    );
    assert.equal(await readFile(lockPath(dir), "utf8"), "", "and it was not removed");

    // Once it is older than the grace period it really is junk, and blocking
    // the repository on it forever would be the worse failure.
    const old = new Date(Date.now() - UNREADABLE_GRACE_MS - 1_000);
    await utimes(lockPath(dir), old, old);
    const taken = await acquireRepoLock(dir, { heartbeat: false });
    assert.ok(taken !== null, "an aged unreadable lock is taken over");
    await taken.release();
  });

  it("publishes the lock file with its record already in it", async (t) => {
    // The property the fix rests on: the lock path never exists empty. The
    // only way to observe that from here is that a reader ALWAYS finds a
    // complete record the moment the file is there.
    const dir = await tempDir("bastra-lock-atomic-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const lock = await acquireRepoLock(dir, { heartbeat: false });
    assert.ok(lock !== null);
    t.after(() => lock.release());
    const seen = await readLock(dir);
    assert.equal(seen?.token, lock.record.token);
    // No temporary file left behind next to it.
    await assert.rejects(stat(`${lockPath(dir)}.new-${process.pid}-${lock.record.token}`));
  });

  it("never lets a heartbeat overwrite a successor's lock", async (t) => {
    // The renew path checked the token, then wrote a whole file, then renamed
    // over the lock. A takeover landing inside that window was overwritten by
    // the heartbeat of the holder it had just replaced.
    const dir = await tempDir("bastra-lock-beat-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const mine = await acquireRepoLock(dir, { renewMs: 10 });
    assert.ok(mine !== null);
    t.after(() => mine.release());

    const successor = { ...mine.record, token: "successor-token" };
    await writeFile(lockPath(dir), JSON.stringify(successor), "utf8");
    await sleep(80); // several heartbeat intervals

    assert.equal(
      (await readLock(dir))?.token,
      "successor-token",
      "the successor's lock must survive every beat of the holder it replaced",
    );
  });

  it("never lets a release delete a successor's lock", async (t) => {
    const dir = await tempDir("bastra-lock-release-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const mine = await acquireRepoLock(dir, { heartbeat: false });
    assert.ok(mine !== null);
    await writeFile(lockPath(dir), JSON.stringify({ ...mine.record, token: "next" }), "utf8");
    await mine.release();
    assert.equal((await readLock(dir))?.token, "next");
  });

  it("lets exactly one of two REAL processes build, over many rounds", async (t) => {
    // In-process interleavings are the ones we can stage; this is the one we
    // cannot. Two node processes fight over the same lock sixty times each,
    // and each marks the critical section with an O_EXCL file — a marker that
    // already exists is two builds running at once, whatever the lock said.
    //
    // This is the test that FOUND the last of them: an acquisition that read
    // the lock path a moment after its holder released it saw nothing, read
    // "nothing" as "unreadable junk", and removed the file the next holder had
    // just published. Both then believed they held the lock. Nothing smaller
    // than two real processes hitting the same window reproduces it.
    const dir = await tempDir("bastra-lock-procs-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const script = join(dir, "contender.mjs");
    await writeFile(script, CONTENDER, "utf8");

    const [a, b] = await Promise.all([runContender(script, dir), runContender(script, dir)]);
    const held = a.held + b.held;
    assert.equal(a.violations + b.violations, 0, `two holders at once: ${a.log} ${b.log}`);
    assert.ok(held > 0, "nobody ever got the lock — the test proved nothing");
    assert.ok(a.held > 0 && b.held > 0, "one process never got in: the race did not happen");
    assert.equal(await readLock(dir), null, "and the lock is free again afterwards");
  });
});

/**
 * One competitor: take the lock, mark the critical section exclusively, let
 * go. Written as a file because it has to run in its OWN process — the whole
 * point is that the two contenders share nothing but the filesystem.
 */
const CONTENDER = `
import { open, rm } from "node:fs/promises";
import { join } from "node:path";

const [, , modulePath, dir] = process.argv;
const { acquireRepoLock } = await import(modulePath);
const marker = join(dir, "building.marker");

let held = 0;
let violations = 0;
for (let i = 0; i < 60; i++) {
  const lock = await acquireRepoLock(dir, { heartbeat: false });
  if (lock === null) {
    await new Promise((r) => setTimeout(r, 2));
    continue;
  }
  held++;
  try {
    const handle = await open(marker, "wx");
    await handle.close();
  } catch {
    violations++;
  }
  await new Promise((r) => setTimeout(r, 1));
  await rm(marker, { force: true });
  await lock.release();
}
process.stdout.write(JSON.stringify({ held, violations }));
`;

interface ContenderResult {
  held: number;
  violations: number;
  log: string;
}

function runContender(script: string, dir: string): Promise<ContenderResult> {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", script, LOCK_MODULE, dir],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.stderr.on("data", (c: string) => (err += c));
    child.on("error", fail);
    child.on("close", (code) => {
      if (code !== 0) return fail(new Error(`contender exited ${String(code)}: ${err}`));
      try {
        const parsed = JSON.parse(out) as { held: number; violations: number };
        done({ ...parsed, log: out });
      } catch {
        fail(new Error(`contender printed ${out} / ${err}`));
      }
    });
  });
}
