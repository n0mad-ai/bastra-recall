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
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { acquireRepoLock, lockPath, readLock, LOCK_STALE_MS, UNREADABLE_GRACE_MS } from "../src/code-graph/lock.js";

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
      "a lock file that just appeared is a competitor mid-publish, not junk"
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
      "the successor's lock must survive every beat of the holder it replaced"
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
      "the replaced holder must not unlink the file its successor created"
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
    await writeFile(lockPath(dir), JSON.stringify({ ...successor.record, token: mine.record.token }), "utf8");

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
    //
    // WAIT FOR THE BEATS, NOT FOR THE CLOCK. Sleeping a fixed span and then
    // reading the record as a baseline was flaky on a loaded runner in two
    // ways: the sleep is no promise that any beat ran, and a beat landing
    // between the baseline read and `suspend()` moved the record after the
    // baseline was taken — a renewal the test then blamed on the suspension.
    const dir = await tempDir("bastra-lock-suspend-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const beats = beatCounter();
    const mine = await acquireRepoLock(dir, { renewMs: 5, onRenew: beats.count });
    assert.ok(mine !== null);
    await beats.atLeast(2); // beating, observed rather than assumed

    // `suspend()` resolves once the beat in flight has landed, so the record
    // it leaves behind is this holder's last word: nothing can still be racing
    // the read below.
    await mine.suspend();
    const beating = (await readLock(dir))?.renewedAt;
    assert.equal(beating, mine.record.renewedAt, "the beats must have reached the file");

    const quiet = beats.total;
    await sleep(60); // many more beats, had it kept beating
    assert.equal(beats.total, quiet, "a suspended lock must not beat again");
    assert.equal((await readLock(dir))?.renewedAt, beating, "a suspended lock must not renew");
    assert.notEqual(await readLock(dir), null, "and the lock file must stay behind");

    // The descriptor is gone, but the release still works: it publishes the
    // next generation, which is what a late `close` from the child triggers.
    await mine.release();
    assert.equal(await readLock(dir), null, "a late release must free the lock at once");
  });

  it("does not wedge on a generation marker that was claimed and never published", async (t) => {
    // A contender claimed marker gen+1 and died before its record landed. Every
    // later contender read the same stale record, lost the mkdir to that marker
    // and gave up — the repository stayed locked until the directory was removed
    // by hand.
    const dir = await tempDir("bastra-lock-orphan-marker-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const dead = await acquireRepoLock(dir, { heartbeat: false });
    assert.ok(dead !== null);
    await dead.suspend(); // the holder is gone; its record stays behind
    const marker = join(dir, ".bastra-build.lock.gens", String(dead.record.gen + 1));
    await mkdir(marker);

    // A fresh marker is a contender mid-publish: still busy.
    assert.equal(await acquireRepoLock(dir, { staleMs: -1, heartbeat: false }), null);

    // Older than the lock's own stale age, it is abandoned.
    const old = new Date(Date.now() - LOCK_STALE_MS - 1_000);
    await utimes(marker, old, old);
    const next = await acquireRepoLock(dir, { staleMs: -1, heartbeat: false });
    assert.ok(next !== null, "an abandoned marker must not lock the repository for good");
    assert.equal(next.record.gen, dead.record.gen + 1);
    await next.release();
    // The takeover lives inside the marker it took over (#1148) …
    assert.match((await readdir(marker)).join(","), /^takeover-\d+$/);
    // … and is pruned with that generation.
    for (let i = 0; i < 6; i++) {
      const l = await acquireRepoLock(dir, { heartbeat: false });
      assert.ok(l !== null);
      await l.release();
    }
    assert.equal(await stat(marker).catch(() => null), null);
  });

  it("lets exactly one of several contenders take over an abandoned marker", async (t) => {
    // Regression: removing the old marker and claiming it again is two steps.
    // A contender that judged the marker abandoned could remove the one another
    // contender had just claimed, and both would hold the lock.
    for (let round = 0; round < 60; round++) {
      const dir = await tempDir("bastra-lock-orphan-race-");
      t.after(() => rm(dir, { recursive: true, force: true }));
      const dead = await acquireRepoLock(dir, { heartbeat: false });
      assert.ok(dead !== null);
      await dead.suspend();
      const marker = join(dir, ".bastra-build.lock.gens", String(dead.record.gen + 1));
      await mkdir(marker);
      const old = new Date(Date.now() - LOCK_STALE_MS - 1_000);
      await utimes(marker, old, old);

      const got = await Promise.all(
        Array.from({ length: 6 }, () => acquireRepoLock(dir, { staleMs: -1, heartbeat: false }))
      );
      const holders = got.filter((l) => l !== null);
      const generations = holders.map((h) => h!.record.gen);
      // staleMs: -1 also permits a later contender to take over a newly
      // published record. That is a new generation, not a duplicate claim.
      assert.equal(
        new Set(generations).size,
        generations.length,
        `round ${round}: duplicate generation in ${generations}`
      );
      for (const h of holders) await h!.release();
    }
  });

  it("recovers a takeover that was interrupted between its two steps (#1148)", async (t) => {
    // Before #1148 a takeover claimed `<marker>.abandoned-<ino>-<mtime>`, then
    // removed and re-created the marker. A process stopped between the claim
    // and the removal left both behind: every later contender judged the
    // marker abandoned, lost the sibling claim, and the repository was wedged
    // until someone deleted the directory by hand. Both halves of that
    // interruption — sibling present with the old marker still in place, and
    // the marker already gone — must now recover without help.
    const dir = await tempDir("bastra-lock-interrupted-takeover-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const dead = await acquireRepoLock(dir, { heartbeat: false });
    assert.ok(dead !== null);
    await dead.suspend();
    const gens = join(dir, ".bastra-build.lock.gens");
    const marker = join(gens, String(dead.record.gen + 1));
    await mkdir(marker);
    const old = new Date(Date.now() - LOCK_STALE_MS - 1_000);
    await utimes(marker, old, old);
    const seen = await stat(marker);
    // What the older scheme left behind when it died between its two steps.
    await mkdir(join(gens, `${dead.record.gen + 1}.abandoned-${seen.ino}-${Math.trunc(seen.mtimeMs)}`));

    const next = await acquireRepoLock(dir, { staleMs: -1, heartbeat: false });
    assert.ok(next !== null, "an interrupted takeover must not wedge the repository");
    assert.equal(next.record.gen, dead.record.gen + 1);
    await next.release();
    assert.equal(await readLock(dir), null);
  });

  it("a takeover whose claimant died is taken over in turn, and a live one is not (#1148)", async (t) => {
    const dir = await tempDir("bastra-lock-dead-takeover-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const dead = await acquireRepoLock(dir, { heartbeat: false });
    assert.ok(dead !== null);
    await dead.suspend();
    const marker = join(dir, ".bastra-build.lock.gens", String(dead.record.gen + 1));
    await mkdir(marker);
    const old = new Date(Date.now() - LOCK_STALE_MS - 1_000);
    await utimes(marker, old, old);
    // The first takeover claimant: it won the claim of this mtime and died before publishing.
    await mkdir(join(marker, `takeover-${Math.trunc((await stat(marker)).mtimeMs)}`));
    // Its claim is fresh, so the marker is busy — a contender a moment later waits.
    assert.equal(await acquireRepoLock(dir, { staleMs: -1, heartbeat: false }), null);
    // Once it has aged out, the next contender claims the entry of that later mtime.
    const later = new Date(Date.now() - LOCK_STALE_MS - 500);
    await utimes(marker, later, later);
    const next = await acquireRepoLock(dir, { staleMs: -1, heartbeat: false });
    assert.ok(next !== null, "a dead takeover claimant must not wedge the repository either");
    assert.equal((await readdir(marker)).length, 2);
    await next.release();
  });

  it("keeps numeric generation markers bounded across normal acquire/release cycles", async (t) => {
    const dir = await tempDir("bastra-lock-generations-");
    t.after(() => rm(dir, { recursive: true, force: true }));

    for (let i = 0; i < 20; i++) {
      const lock = await acquireRepoLock(dir, { heartbeat: false });
      assert.ok(lock !== null);
      await lock.release();
    }

    const markerDir = join(dir, ".bastra-build.lock.gens");
    const numeric = (await readdir(markerDir)).filter((name) => /^\d+$/.test(name));
    assert.ok(numeric.length <= 4, `generation markers grew to ${numeric.length}: ${numeric.join(", ")}`);
  });

  it("lets exactly one of two REAL processes build, over many rounds", async (t) => {
    // Both processes report ready before either may acquire. Every round has
    // an acquire barrier and a release barrier: even a delayed loser attempts
    // acquisition while the winner still holds its lock. The old autonomous
    // retry loops could finish before their peer started, or let one peer
    // lose all sixty times; a mutex does not promise fair scheduling (#1437).
    const dir = await tempDir("bastra-lock-procs-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const script = join(dir, "contender.mjs");
    await writeFile(script, TAKEOVER_CONTENDER, "utf8");

    // Disable lease expiry for this exclusion test: a paused contender must
    // still be busy when it resumes, however long the scheduler delayed it.
    const contenders = [startTaker(script, dir, Infinity), startTaker(script, dir, Infinity)];
    t.after(() => contenders.forEach((c) => c.kill()));
    await Promise.all(contenders.map((c) => c.ready));
    const phase = async (participants: Taker[], action: "acquire" | "release") => {
      const done = participants.map((c) => c.round());
      for (const c of participants) c.go(action);
      await Promise.all(done);
    };

    for (let round = 0; round < 60; round++) {
      await phase(contenders, "acquire");
      await phase(contenders, "release");
    }
    // Force each process to be the holder once, then let its peer contend
    // against that held lock. This tests both directions without assuming
    // that simultaneous acquisition ever happens to pick a different winner.
    for (const holder of contenders) {
      await phase([holder], "acquire");
      await phase(
        contenders.filter((c) => c !== holder),
        "acquire"
      );
      await phase(contenders, "release");
    }
    const results = await Promise.all(contenders.map((c) => c.finish()));
    const shown = JSON.stringify(results);
    assert.equal(
      results.reduce((n, r) => n + r.held, 0),
      62,
      `one holder per round: ${shown}`
    );
    assert.equal(
      results.reduce((n, r) => n + r.violations, 0),
      0,
      `two holders at once: ${shown}`
    );
    assert.ok(
      results.every((r) => r.held > 0),
      `each process must hold the lock: ${shown}`
    );
    assert.equal(
      results.reduce((n, r) => n + r.tookOver, 0),
      0,
      `no live lock may be taken over: ${shown}`
    );
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
    assert.equal(tookOver, TAKEOVER_ROUNDS, `one stale takeover per round: ${shown}`);
    // Exactly one holder per round. A second winner shows up as an extra
    // acquisition whether or not it collides inside the critical section, so
    // this counts double builds the marker on its own can miss.
    assert.equal(held, TAKEOVER_ROUNDS, `more holders than rounds: ${shown}`);
    assert.equal(violations, 0, `two holders inside the critical section: ${shown}`);
  });

  it(
    "never waits on a FIFO or a device symlink at the lock path; an aged one is replaced",
    { skip: process.platform === "win32" ? "no mkfifo on Windows" : false, timeout: 60_000 },
    async (t) => {
      const { execFileSync } = await import("node:child_process");
      const { symlink } = await import("node:fs/promises");
      for (const kind of ["fifo", "device"] as const) {
        const dir = await tempDir("bastra-lock-special-");
        t.after(() => rm(dir, { recursive: true, force: true }));
        if (kind === "fifo") execFileSync("mkfifo", [lockPath(dir)]);
        else await symlink("/dev/zero", lockPath(dir));
        if (kind === "fifo") {
          const old = new Date(Date.now() - UNREADABLE_GRACE_MS - 1_000);
          await utimes(lockPath(dir), old, old);
        }
        // A child with a kill timer: a blocking read would never return here.
        const code = `const { acquireRepoLock } = await import(${JSON.stringify(LOCK_MODULE)});
const lock = await acquireRepoLock(${JSON.stringify(dir)}, { heartbeat: false });
process.stdout.write(lock ? "taken" : "busy");
await lock?.release();`;
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "ignore"],
        });
        let out = "";
        child.stdout!.on("data", (chunk) => (out += chunk));
        const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
        const signal = await new Promise((resolve) => child.once("exit", (_code, sig) => resolve(sig)));
        clearTimeout(timer);
        assert.equal(signal, null, `${kind}: the acquisition hung`);
        assert.equal(out, "taken", kind);
      }
    }
  );

  it("keeps a live holder's REGULAR lock of another account (sudo, shared folder)", async (t) => {
    // A regular lock file is a holder judged by its record, whoever owns the
    // file. Reading it with an owner check made it "unreadable", and after the
    // two-second grace a second build replaced the lock of a live holder.
    const dir = await tempDir("bastra-lock-foreign-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const now = new Date().toISOString();
    const record = { pid: process.pid, host: hostname(), token: "f".repeat(24), startedAt: now, renewedAt: now };
    const text = `${JSON.stringify({ ...record, gen: 1, state: "held" }, null, 2)}\n`;
    await writeFile(lockPath(dir), text, "utf8");
    const old = new Date(Date.now() - UNREADABLE_GRACE_MS - 1_000);
    await utimes(lockPath(dir), old, old);
    // Simulate a file of another account: this process now claims another uid.
    const realGetuid = process.getuid;
    process.getuid = () => (realGetuid?.call(process) ?? 0) + 4242;
    try {
      assert.equal(await acquireRepoLock(dir, { heartbeat: false }), null, "a live holder is busy, not junk");
      assert.equal((await readLock(dir))?.token, record.token);
    } finally {
      process.getuid = realGetuid;
    }
    assert.equal(await readFile(lockPath(dir), "utf8"), text, "the lock was not replaced");
  });
});

/**
 * Counts heartbeats and lets a test WAIT for them. A beat is an event the lock
 * reports, so waiting for one is exact however slow the machine is — which a
 * sleep long enough to "surely" contain a beat is not.
 */
function beatCounter(): { readonly total: number; count: () => void; atLeast: (n: number) => Promise<void> } {
  let total = 0;
  return {
    get total() {
      return total;
    },
    count: () => {
      total++;
    },
    // WAITING ON A BEAT NEEDS A TIMER OF ITS OWN. The heartbeat's interval is
    // `unref`ed — by design, so a finished build may exit — so awaiting a
    // promise that only the beat resolves leaves NOTHING referenced: Node 22
    // runs the loop dry and the runner cancels the test with "promise
    // resolution is still pending but the event loop has already resolved".
    // `sleep` is referenced, so the loop lives and the unreferenced beat fires;
    // the condition is still the observed count, never an elapsed span.
    atLeast: async (n: number) => {
      while (total < n) await sleep(1);
    },
  };
}

/**
 * A holder whose heartbeat stopped an hour ago: stale for everyone, at once.
 * Seeded from whatever record is there, so it continues the lock's own history
 * the way a SIGKILLed daemon does rather than arriving from nowhere.
 */
async function publishStaleLock(dir: string): Promise<void> {
  const old = new Date(Date.now() - 3_600_000).toISOString();
  const previous = JSON.parse(await readFile(lockPath(dir), "utf8").catch(() => "{}")) as Record<string, unknown>;
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
    "utf8"
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
 * A contender driven down its stdin. Each acknowledgement is a barrier: no
 * release starts until every acquisition has finished, regardless of scheduling.
 */
function startTaker(script: string, dir: string, staleMs = 10_000): Taker {
  const child = spawn(process.execPath, ["--import", "tsx", script, LOCK_MODULE, dir, String(staleMs)], {
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
 * One contender for either a fresh or a stale lock. Blocks on stdin between
 * phases, so all acquisition attempts finish before any holder can release.
 */
const TAKEOVER_CONTENDER = `
import { createInterface } from "node:readline";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";

const [, , modulePath, dir, staleMs] = process.argv;
const { acquireRepoLock, readLock } = await import(modulePath);
const marker = join(dir, "building.marker");

let held = 0;
let violations = 0;
let tookOver = 0;
let mine = null;
process.stdout.write("ready\\n");

for await (const phase of createInterface({ input: process.stdin })) {
  if (phase === "acquire") {
    mine = await acquireRepoLock(dir, { heartbeat: false, staleMs: Number(staleMs) });
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
