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
import { mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
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

  it("never lets a heartbeat overwrite the lock of a REAL stale-takeover", async (t) => {
    // THE REPRODUCTION (#582 counter-review 3). The renew path read the token
    // and then replaced the file at the PATH; a takeover landing between the
    // two got its fresh lock overwritten by the heartbeat of the holder it had
    // just replaced. The takeover is staged for real here — `staleMs: -1` makes
    // the successor judge the live lock stale, so it goes through the same
    // remove-and-publish a takeover after a dead daemon does — because an
    // in-place overwrite of the same file is not a takeover and would not have
    // shown the bug.
    const dir = await tempDir("bastra-lock-beat-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const mine = await acquireRepoLock(dir, { renewMs: 5 });
    assert.ok(mine !== null);
    t.after(() => mine.release());

    const successor = await acquireRepoLock(dir, { staleMs: -1, heartbeat: false });
    assert.ok(successor !== null, "the takeover must succeed for this test to prove anything");
    assert.equal(successor.tookOver, true);
    t.after(() => successor.release());
    await sleep(60); // many heartbeat intervals of the holder that was replaced

    assert.equal(
      (await readLock(dir))?.token,
      successor.record.token,
      "the successor's lock must survive every beat of the holder it replaced",
    );
  });

  it("never lets a release delete the lock of a REAL stale-takeover", async (t) => {
    const dir = await tempDir("bastra-lock-release-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const mine = await acquireRepoLock(dir, { heartbeat: false });
    assert.ok(mine !== null);
    const successor = await acquireRepoLock(dir, { staleMs: -1, heartbeat: false });
    assert.ok(successor !== null);
    t.after(() => successor.release());

    await mine.release();
    assert.equal(
      (await readLock(dir))?.token,
      successor.record.token,
      "the replaced holder must not unlink the file its successor created",
    );
  });

  it("beats into its own descriptor, not into the file the path names", async (t) => {
    // The TOCTOU the token check cannot see, staged so that it needs no timing:
    // a successor's lock that carries the SAME token is exactly what the old
    // renew saw when a takeover landed between its token read and its rename —
    // the check passed and it wrote over a file it did not own. The holder's
    // beats must leave that file's inode AND its bytes untouched.
    const dir = await tempDir("bastra-lock-beat-fd-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const mine = await acquireRepoLock(dir, { renewMs: 5 });
    assert.ok(mine !== null);
    t.after(() => mine.release());

    await rm(lockPath(dir), { force: true }); // what a takeover does first
    const theirs = JSON.stringify({ ...mine.record, startedAt: "2020-01-01T00:00:00.000Z" });
    await writeFile(lockPath(dir), theirs, "utf8");
    const before = await stat(lockPath(dir));
    await sleep(60); // many heartbeat intervals

    const after = await stat(lockPath(dir));
    assert.equal(after.ino, before.ino, "the beat must not replace the successor's file");
    assert.equal(await readFile(lockPath(dir), "utf8"), theirs, "nor rewrite its contents");
  });

  it("keeps the successor's lock even when the takeover reuses the same token", async (t) => {
    // The token check alone cannot see this one: a successor that happens to
    // carry the holder's token — a duplicated record, a restarted daemon
    // re-reading its own state — would pass it. What the release compares is
    // the GENERATION: the successor owns the next one's marker, so the
    // replaced holder cannot claim it and its release does nothing at all.
    const dir = await tempDir("bastra-lock-inode-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const mine = await acquireRepoLock(dir, { heartbeat: false });
    assert.ok(mine !== null);

    const successor = await acquireRepoLock(dir, { staleMs: -1, heartbeat: false });
    assert.ok(successor !== null, "the takeover must succeed for this test to prove anything");
    t.after(() => successor.release());
    // Give the successor the holder's own token, which is what defeats a check
    // made on tokens; its generation is still one past the holder's.
    await writeFile(
      lockPath(dir),
      JSON.stringify({ ...successor.record, token: mine.record.token }),
      "utf8",
    );

    await mine.release();
    const still = await readLock(dir);
    assert.notEqual(still, null, "a successor's lock must not be freed by the holder it replaced");
    assert.equal(still?.gen, successor.record.gen);
  });

  it("stops beating when suspended, and can still be released afterwards", async (t) => {
    // THE REPRODUCTION (#582 counter-review 4). A build whose child survived
    // SIGKILL must keep the lock FILE and lose the LEASE. Before this, keeping
    // the lock kept the heartbeat too: the record was renewed for as long as
    // the daemon lived, so it never went stale and the repository stayed
    // blocked until a restart.
    const dir = await tempDir("bastra-lock-suspend-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const mine = await acquireRepoLock(dir, { renewMs: 5 });
    assert.ok(mine !== null);
    await sleep(40); // many beats
    const beating = (await readLock(dir))?.renewedAt;
    assert.notEqual(beating, undefined);

    mine.suspend();
    await sleep(60); // many more beats, had it kept beating
    assert.equal((await readLock(dir))?.renewedAt, beating, "a suspended lock must not renew");
    assert.notEqual(await readLock(dir), null, "and the lock file must stay behind");

    // The descriptor is gone, but the release still works: it publishes the
    // next generation, which is what a late `close` from the child triggers.
    await mine.release();
    assert.equal(await readLock(dir), null, "a late release must free the lock at once");
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

  it("lets exactly one of ten REAL processes TAKE OVER the same stale lock", async (t) => {
    // THE REPRODUCTION (#582 counter-review 4). Taking a stale lock over was
    // "read the token, then remove the path" — two separate steps. Ten
    // contenders reading the SAME stale record all passed the token check; the
    // first removed the file and published its successor, and a loser whose
    // read had landed a moment earlier removed THAT one and published its own.
    // Two processes then believed they held the repository.
    //
    // Each round is started by a byte down every contender's stdin, so all ten
    // reach the takeover path against one record in the same event-loop tick —
    // the interleaving is far too narrow to hit by polling. The seeded record
    // is an hour past its heartbeat while the stale window is ten seconds, so
    // a lock published by a winner is NEVER stale: a second acquisition in a
    // round is a real double build, not a legitimate takeover.
    const dir = await tempDir("bastra-lock-takeover-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const script = join(dir, "taker.mjs");
    await writeFile(script, TAKEOVER_CONTENDER, "utf8");

    const contenders = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(() => startTaker(script, dir));
    t.after(() => contenders.forEach((c) => c.kill()));
    await Promise.all(contenders.map((c) => c.ready));

    // Two phases per round, so that every acquisition happens before any
    // release: a contender the machine got round to late would otherwise find
    // the round's winner already finished and inherit the lock legitimately,
    // which is not a double build but would look like one to the count below.
    for (let round = 0; round < TAKEOVER_ROUNDS; round++) {
      await publishStaleLock(dir);
      const acquired = contenders.map((c) => c.round());
      for (const c of contenders) c.go("acquire");
      await Promise.all(acquired);
      const done = contenders.map((c) => c.round());
      for (const c of contenders) c.go("release");
      await Promise.all(done);
    }
    const results = await Promise.all(contenders.map((c) => c.finish()));

    const held = results.reduce((n, r) => n + r.held, 0);
    const violations = results.reduce((n, r) => n + r.violations, 0);
    const tookOver = results.reduce((n, r) => n + r.tookOver, 0);
    const shown = JSON.stringify(results);
    assert.ok(tookOver > TAKEOVER_ROUNDS / 2, `only ${tookOver} takeovers — the race did not happen`);
    // Exactly one holder per round. A second winner shows up as an extra
    // acquisition whether or not it collides inside the critical section, so
    // this counts double builds the marker on its own can miss.
    assert.equal(held, TAKEOVER_ROUNDS, `more holders than rounds: ${shown}`);
    assert.equal(violations, 0, `two holders inside the critical section: ${shown}`);
  });
});

/**
 * A holder whose heartbeat stopped an hour ago: stale for everyone, at once.
 * Seeded from whatever record is there, so it continues the lock's own history
 * the way a SIGKILLed daemon does rather than arriving from nowhere.
 */
async function publishStaleLock(dir: string): Promise<void> {
  const old = new Date(Date.now() - 3_600_000).toISOString();
  const previous = JSON.parse(
    await readFile(lockPath(dir), "utf8").catch(() => "{}"),
  ) as Record<string, unknown>;
  const tmp = `${lockPath(dir)}.seed`;
  await writeFile(
    tmp,
    JSON.stringify({
      ...previous,
      pid: process.pid,
      host: hostname(),
      token: `stale-${Math.random().toString(36).slice(2)}`,
      startedAt: old,
      renewedAt: old,
      state: "held",
    }),
    "utf8",
  );
  await rename(tmp, lockPath(dir)); // atomic: readers never see half a record
}

/** How many rounds the ten contenders fight over a freshly stale lock. */
const TAKEOVER_ROUNDS = 600;

interface Taker {
  ready: Promise<void>;
  /** Resolves when this contender reports the current round done. */
  round(): Promise<void>;
  go(phase: "acquire" | "release"): void;
  finish(): Promise<{ held: number; violations: number; tookOver: number }>;
  kill(): void;
}

/**
 * A contender driven down its stdin. The byte is the barrier: ten processes
 * blocked on a pipe all wake in the same tick, which polling cannot match.
 */
function startTaker(script: string, dir: string): Taker {
  const child = spawn(process.execPath, ["--import", "tsx", script, LOCK_MODULE, dir], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines: string[] = [];
  const waiters: (() => void)[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      lines.push(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      waiters.shift()?.();
    }
  });
  const nextLine = async (): Promise<string> => {
    if (lines.length === 0) await new Promise<void>((r) => waiters.push(r));
    return lines.shift() as string;
  };
  return {
    ready: nextLine().then(() => undefined),
    round: () => nextLine().then(() => undefined),
    go: (phase) => child.stdin.write(`${phase}\n`),
    async finish() {
      child.stdin.end();
      const last = await nextLine();
      return JSON.parse(last) as { held: number; violations: number; tookOver: number };
    },
    kill: () => child.kill("SIGKILL"),
  };
}

/**
 * One takeover contender. Blocks on stdin between rounds, so the ten of them
 * hit `acquireRepoLock` together rather than discovering the stale record at
 * ten different moments.
 */
const TAKEOVER_CONTENDER = `
import { createInterface } from "node:readline";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";

const [, , modulePath, dir] = process.argv;
const { acquireRepoLock, readLock } = await import(modulePath);
const marker = join(dir, "building.marker");

let held = 0;
let violations = 0;
let tookOver = 0;
let mine = null;
process.stdout.write("ready\\n");

for await (const phase of createInterface({ input: process.stdin })) {
  if (phase === "acquire") {
    mine = await acquireRepoLock(dir, { heartbeat: false, staleMs: 10000 });
    if (mine !== null) {
      held++;
      if (mine.tookOver) tookOver++;
      // The marker stays until the release phase, so two holders in one round
      // collide on it however far apart the machine schedules them.
      try {
        const handle = await open(marker, "wx");
        await handle.close();
      } catch {
        violations++;
      }
    }
  } else {
    if (mine !== null) {
      // THE LOCK A HOLDER STILL HOLDS MUST STILL BE THERE. This is the damage
      // the old takeover did: a contender that had read the stale record
      // removed the file its successor had just published, so the successor
      // held a lock that no longer locked anything out.
      const onDisk = await readLock(dir);
      if (onDisk === null || onDisk.token !== mine.record.token) violations++;
      await rm(marker, { force: true });
      await mine.release();
      mine = null;
    }
  }
  process.stdout.write("done\\n");
}
process.stdout.write(JSON.stringify({ held, violations, tookOver }) + "\\n");

`;

/**
 * One competitor: take the lock, mark the critical section exclusively, let
 * go. Written as a file because it has to run in its OWN process — the whole
 * point is that the two contenders share nothing but the filesystem.
 */
const CONTENDER = `
import { open, rm } from "node:fs/promises";
import { join } from "node:path";

const [, , modulePath, dir] = process.argv;
const { acquireRepoLock, readLock } = await import(modulePath);
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
