import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeGraphRefresher, needsReconcile, type RefreshEvent } from "../src/code-graph/refresh.js";
import { scanFileState } from "../src/code-graph/build.js";
import type { BuildResult } from "../src/code-graph/build.js";
import { graphDirOf } from "../src/code-graph/reader.js";
import { writeManifest, type CodeGraphManifest } from "../src/code-graph/manifest.js";

const OK: BuildResult = {
  ok: true,
  manifest: {
    graphifyVersion: "0.9.63",
    builtAt: new Date().toISOString(),
    commit: null,
    repoRoot: "/repo",
    command: "graphify extract /repo --code-only",
    fileState: { count: 1, newestMtimeMs: 1 },
    lastError: null,
    dirty: false,
  },
  durationMs: 1,
  tookOverLock: false,
};

function fail(reason: "failed" | "locked" | "unsupported-platform" = "failed"): BuildResult {
  return { ok: false, reason, detail: "test" };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-code-refresh-"));
  await writeFile(join(dir, "a.ts"), "export const a = 1;\n", "utf8");
  return dir;
}

function manifest(over: Partial<CodeGraphManifest> = {}): CodeGraphManifest {
  return {
    graphifyVersion: "0.9.63",
    builtAt: new Date(Date.now() + 60_000).toISOString(),
    commit: null,
    repoRoot: "/repo",
    command: "graphify extract /repo --code-only",
    fileState: { count: 1, newestMtimeMs: 1 },
    lastError: null,
    dirty: false,
    ...over,
  };
}

describe("refresh single flight", () => {
  it("coalesces changes during a run into exactly ONE follow-up", async () => {
    // No fixed sleeps: a start is awaited as an event. The default isFresh reads the disk, and
    // on a loaded CI runner that outlasted the old 10 ms wait, so the first build had not
    // started yet when the test asserted it had (`0 !== 1`).
    let started = 0;
    const releases: (() => void)[] = [];
    const startWaiters: (() => void)[] = [];
    const nextStart = (n: number) =>
      started >= n ? Promise.resolve() : new Promise<void>((res) => startWaiters.push(res));
    const r = new CodeGraphRefresher({
      debounceMs: 1,
      isFresh: async () => false,
      build: async () => {
        started++;
        const gate = new Promise<void>((res) => releases.push(res));
        for (const w of startWaiters.splice(0)) w();
        await gate;
        return OK;
      },
    });

    r.enqueue("/repo", "watcher");
    await nextStart(1);
    assert.equal(started, 1);

    // Two quick edits while the first build is in flight.
    r.enqueue("/repo", "watcher");
    r.enqueue("/repo", "watcher");
    assert.equal(r.statusOf("/repo")?.pending, true);

    releases[0]!();
    await nextStart(2);
    assert.equal(started, 2, "two edits during a run must lead to exactly one follow-up");
    releases[1]!();
    await r.whenIdle();
    assert.equal(started, 2, "no third build may follow");
    r.stop();
  });

  it("never starts two builds at once for the same repo", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const r = new CodeGraphRefresher({
      debounceMs: 1,
      build: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick(5);
        inFlight--;
        return OK;
      },
    });
    for (let i = 0; i < 10; i++) r.enqueue("/repo", "watcher");
    await r.whenIdle();
    assert.equal(maxInFlight, 1);
    r.stop();
  });
});

describe("the Stop hook contract", () => {
  it("enqueue returns immediately and never awaits the build", async () => {
    let finished = false;
    const r = new CodeGraphRefresher({
      debounceMs: 1,
      build: async () => {
        await tick(30);
        finished = true;
        return OK;
      },
    });

    const before = Date.now();
    const returned: void = r.enqueue("/repo", "stop-hook");
    const elapsed = Date.now() - before;

    assert.equal(returned, undefined, "enqueue must not hand back anything awaitable");
    assert.ok(elapsed < 10, `enqueue took ${elapsed} ms`);
    assert.equal(finished, false, "the build must not have completed inside the hook");

    await r.whenIdle();
    assert.equal(finished, true);
    r.stop();
  });

  it("runs a git event without waiting out the debounce", async () => {
    const seen: string[] = [];
    const r = new CodeGraphRefresher({
      debounceMs: 10_000,
      build: async (repo) => {
        seen.push(repo);
        return OK;
      },
    });
    r.enqueue("/repo", "git");
    await tick(20);
    assert.deepEqual(seen, ["/repo"], "a branch switch refreshes at once, not in 10 s");
    r.stop();
  });
});

describe("failure handling", () => {
  it("backs off and finally gives up, and a manual request revives it", async () => {
    let calls = 0;
    const events: RefreshEvent[] = [];
    const r = new CodeGraphRefresher({
      debounceMs: 1,
      backoffMs: [1, 1, 1],
      maxFailures: 3,
      onEvent: (e) => events.push(e),
      build: async () => {
        calls++;
        // Whatever was broken is fixed by the time the user asks again.
        return calls > 3 ? OK : fail();
      },
    });

    r.enqueue("/repo", "watcher");
    await r.whenIdle();
    assert.equal(calls, 3, "three consecutive failures, then no more automatic retries");

    const status = r.statusOf("/repo");
    assert.equal(status?.givenUp, true);
    assert.equal(status?.failures, 3);
    assert.match(status?.lastError ?? "", /failed: test/);
    assert.ok(events.some((e) => e.outcome === "given-up"));

    // Automatic triggers are ignored once given up …
    r.enqueue("/repo", "watcher");
    await tick(10);
    assert.equal(calls, 3);

    // … but the user asking clears the state.
    r.enqueue("/repo", "manual");
    await r.whenIdle();
    assert.equal(calls, 4);
    assert.equal(r.statusOf("/repo")?.givenUp, false);
    assert.equal(r.statusOf("/repo")?.failures, 0);
    r.stop();
  });

  it("a stop after failed builds has no next attempt; a lock pause names the hourly one (#1148)", async () => {
    const stopped = new CodeGraphRefresher({
      debounceMs: 1,
      backoffMs: [1],
      maxFailures: 1,
      build: async () => fail(),
    });
    stopped.enqueue("/repo", "watcher");
    await stopped.whenIdle();
    const s = stopped.statusOf("/repo");
    assert.equal(s?.givenUp, true);
    assert.equal(s?.nextAttemptAt, null, "a stop waits for the user, not for a timer");
    assert.equal(s?.failures, 1);
    stopped.stop();

    const paused = new CodeGraphRefresher({
      debounceMs: 1,
      lockRetryMs: 1,
      build: async () => fail("locked"),
    });
    paused.enqueue("/repo", "git");
    // Six retries at 1, 2, 4, 8, 16, 32 ms, then the hourly pause.
    for (let i = 0; i < 100 && paused.statusOf("/repo")?.givenUp !== true; i++) await tick(5);
    const p = paused.statusOf("/repo");
    assert.equal(p?.givenUp, true);
    assert.equal(p?.state, "waiting");
    const due = Date.parse(p?.nextAttemptAt ?? "");
    assert.ok(due - Date.now() > 59 * 60_000, `the next attempt is about an hour away: ${p?.nextAttemptAt}`);
    assert.match(p?.lastError ?? "", /^locked after 7 attempts/);

    // The user asking clears the pause and cancels the hourly timer.
    let built = false;
    (paused as unknown as { build: () => Promise<BuildResult> }).build = async () => ((built = true), OK);
    paused.enqueue("/repo", "manual");
    await paused.whenIdle();
    assert.equal(built, true);
    assert.equal(paused.statusOf("/repo")?.givenUp, false);
    assert.equal(paused.statusOf("/repo")?.nextAttemptAt, null);
    paused.stop();
  });

  it("stops immediately on an unsupported platform instead of retrying", async () => {
    let calls = 0;
    const r = new CodeGraphRefresher({
      debounceMs: 1,
      backoffMs: [1],
      build: async () => {
        calls++;
        return fail("unsupported-platform");
      },
    });
    r.enqueue("/repo", "watcher");
    await r.whenIdle();
    assert.equal(calls, 1);
    assert.equal(r.statusOf("/repo")?.givenUp, true);
    r.stop();
  });

  it("treats a busy lock as someone else's build, not as a failure", async () => {
    let calls = 0;
    const r = new CodeGraphRefresher({
      debounceMs: 1,
      lockRetryMs: 2,
      build: async () => {
        calls++;
        return calls === 1 ? fail("locked") : OK;
      },
    });
    r.enqueue("/repo", "watcher");
    await r.whenIdle();
    assert.equal(calls, 2, "a locked repo is retried");
    assert.equal(r.statusOf("/repo")?.failures, 0, "a busy lock must not count towards the backoff");
    assert.equal(r.statusOf("/repo")?.builds, 1);
    r.stop();
  });

  it("survives a build function that throws", async () => {
    const r = new CodeGraphRefresher({
      debounceMs: 1,
      backoffMs: [1],
      maxFailures: 1,
      build: async () => {
        throw new Error("unexpected");
      },
    });
    r.enqueue("/repo", "watcher");
    await r.whenIdle();
    assert.equal(r.statusOf("/repo")?.state, "idle");
    assert.match(r.statusOf("/repo")?.lastError ?? "", /unexpected/);
    r.stop();
  });
});

describe("startup reconciliation", () => {
  it("rebuilds exactly once after a daemon was killed mid-build", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    const graphDir = graphDirOf(repo);
    await mkdir(graphDir, { recursive: true });
    // What a killed daemon leaves behind: dirty on disk, in-memory queue gone.
    await writeManifest(graphDir, manifest({ dirty: true, repoRoot: repo }));

    assert.equal(await needsReconcile(repo), true);

    let calls = 0;
    const r = new CodeGraphRefresher({
      debounceMs: 1,
      build: async () => {
        calls++;
        return OK;
      },
    });
    const enqueued = await r.reconcile([repo]);
    assert.deepEqual(enqueued, [repo]);
    await r.whenIdle();
    assert.equal(calls, 1, "reconciliation rebuilds exactly once");
    r.stop();
  });

  it("enqueues when there is no manifest at all", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    assert.equal(await needsReconcile(repo), true);
  });

  it("enqueues when a file is newer than the completed build", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    const graphDir = graphDirOf(repo);
    await mkdir(graphDir, { recursive: true });
    await writeManifest(graphDir, manifest({ repoRoot: repo, builtAt: new Date(Date.now() - 60_000).toISOString() }));
    assert.equal(await needsReconcile(repo), true);
  });

  it("leaves a current repo alone", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    const graphDir = graphDirOf(repo);
    await mkdir(graphDir, { recursive: true });
    await writeManifest(graphDir, manifest({ repoRoot: repo, fileState: await scanFileState(repo) }));

    assert.equal(await needsReconcile(repo), false);

    let calls = 0;
    const r = new CodeGraphRefresher({ debounceMs: 1, build: async () => (calls++, OK) });
    assert.deepEqual(await r.reconcile([repo]), []);
    await tick(10);
    assert.equal(calls, 0);
    r.stop();
  });

  it("reports an unusable manifest as needing a rebuild", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    const graphDir = graphDirOf(repo);
    await mkdir(graphDir, { recursive: true });
    await writeFile(join(graphDir, ".bastra-manifest.json"), "{ not json", "utf8");
    assert.equal(await needsReconcile(repo), true);
  });
});

describe("status and shutdown", () => {
  it("reports per-repo state and drops scheduled work on stop", async () => {
    const r = new CodeGraphRefresher({ debounceMs: 5_000, build: async () => OK });
    r.enqueue("/a", "watcher");
    r.enqueue("/b", "watcher");
    const before = r.status();
    assert.equal(before.length, 2);
    assert.ok(before.every((s) => s.state === "waiting"));
    // #1148: a waiting repository says WHEN — the debounce, here.
    for (const s of before) {
      const due = Date.parse(s.nextAttemptAt ?? "");
      assert.ok(due - Date.now() > 4_000 && due - Date.now() <= 5_000, `nextAttemptAt ${s.nextAttemptAt}`);
    }

    r.stop();
    assert.ok(r.status().every((s) => s.state === "idle"));
    assert.ok(r.status().every((s) => s.nextAttemptAt === null), "nothing is due once stopped");
    r.enqueue("/a", "manual");
    assert.equal(r.statusOf("/a")?.state, "idle", "a stopped refresher takes no new work");
    await r.whenIdle();
  });
});

describe("the readers see a finished build (#583)", () => {
  it("runs onBuilt after a successful build, before the repo counts as idle", async () => {
    const order: string[] = [];
    const r = new CodeGraphRefresher({
      debounceMs: 1,
      build: async () => {
        order.push("build");
        return OK;
      },
      onBuilt: async (repoRoot) => {
        await tick(20);
        order.push(`reload:${repoRoot}`);
      },
    });
    r.enqueue("/a", "manual");
    await r.whenIdle();
    assert.deepEqual(order, ["build", "reload:/a"]);
  });

  it("does not call onBuilt for a failed build, and survives a throwing one", async () => {
    let reloads = 0;
    const failing = new CodeGraphRefresher({
      debounceMs: 1,
      maxFailures: 1,
      build: async () => fail(),
      onBuilt: () => void reloads++,
    });
    failing.enqueue("/a", "manual");
    await failing.whenIdle();
    assert.equal(reloads, 0);

    const throwing = new CodeGraphRefresher({
      debounceMs: 1,
      build: async () => OK,
      onBuilt: async () => {
        throw new Error("reload broke");
      },
    });
    throwing.enqueue("/a", "manual");
    await throwing.whenIdle();
    assert.equal(throwing.statusOf("/a")?.builds, 1, "the build still counts");
  });
});

describe("a disabled repository is not built (#585)", () => {
  it("skips a queued refresh once the repository is no longer allowed", async () => {
    let builds = 0;
    let enabled = true;
    const events: RefreshEvent[] = [];
    const r = new CodeGraphRefresher({
      debounceMs: 20,
      build: async () => {
        builds++;
        return OK;
      },
      allow: () => enabled,
      onEvent: (e) => events.push(e),
    });
    r.enqueue("/a", "watcher");
    enabled = false; // `bastra code disable` while the debounce runs
    await r.whenIdle();
    assert.equal(builds, 0);
    assert.ok(events.some((e) => e.outcome === "skipped" && e.detail === "not enabled"));
  });
});

describe("fresh graph is not rebuilt", () => {
  async function freshRepo(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    const graphDir = graphDirOf(repo);
    await mkdir(graphDir, { recursive: true });
    await writeManifest(graphDir, manifest({ repoRoot: repo, fileState: await scanFileState(repo) })); // builtAt in the future, count 1 = a.ts
    return repo;
  }

  async function runOnce(repo: string, reason: "stop-hook" | "watcher" | "git" | "manual"): Promise<number> {
    let calls = 0;
    const r = new CodeGraphRefresher({ debounceMs: 1, build: async () => (calls++, OK) });
    r.enqueue(repo, reason);
    await r.whenIdle();
    r.stop();
    return calls;
  }

  it("skips stop-hook and watcher triggers when nothing is newer than the graph", async (t) => {
    const repo = await freshRepo(t);
    assert.equal(await runOnce(repo, "stop-hook"), 0);
    assert.equal(await runOnce(repo, "watcher"), 0);
  });

  it("still builds git and manual triggers on a fresh graph", async (t) => {
    const repo = await freshRepo(t);
    assert.equal(await runOnce(repo, "git"), 1);
    assert.equal(await runOnce(repo, "manual"), 1);
  });

  it("builds a stop-hook trigger when a code file is newer than the build", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    const graphDir = graphDirOf(repo);
    await mkdir(graphDir, { recursive: true });
    await writeManifest(graphDir, manifest({ repoRoot: repo, builtAt: new Date(Date.now() - 60_000).toISOString() }));
    assert.equal(await runOnce(repo, "stop-hook"), 1);
  });

  it("builds a stop-hook trigger when the code-file count changed (a deleted file keeps the newest mtime)", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    const graphDir = graphDirOf(repo);
    await mkdir(graphDir, { recursive: true });
    await writeManifest(graphDir, manifest({ repoRoot: repo, fileState: { count: 2, newestMtimeMs: 1 } }));
    assert.equal(await runOnce(repo, "stop-hook"), 1);
  });

  it("builds a stop-hook trigger when the manifest is dirty or missing", async (t) => {
    const missing = await tempRepo();
    t.after(() => rm(missing, { recursive: true, force: true }));
    assert.equal(await runOnce(missing, "stop-hook"), 1);
    const dirty = await tempRepo();
    t.after(() => rm(dirty, { recursive: true, force: true }));
    await mkdir(graphDirOf(dirty), { recursive: true });
    await writeManifest(graphDirOf(dirty), manifest({ repoRoot: dirty, dirty: true }));
    assert.equal(await runOnce(dirty, "stop-hook"), 1);
  });
});

describe("a change during a build is not skipped as fresh", () => {
  it("the follow-up rebuilds even though builtAt is stamped after the edit", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    await mkdir(graphDirOf(repo), { recursive: true });
    let calls = 0;
    const r: CodeGraphRefresher = new CodeGraphRefresher({
      debounceMs: 1,
      build: async () => {
        calls++;
        if (calls === 1) {
          // graphify has read the tree; now a file is saved (or git checks out a branch)
          await tick(20);
          await writeFile(join(repo, "a.ts"), "export const a = 2;\n", "utf8");
          r.enqueue(repo, "git");
          await tick(20);
        }
        // like build.ts: builtAt is stamped when the build COMPLETES
        await writeManifest(graphDirOf(repo), manifest({ repoRoot: repo, builtAt: new Date().toISOString() }));
        return OK;
      },
    });
    r.enqueue(repo, "manual");
    await r.whenIdle();
    r.stop();
    assert.equal(calls, 2, "the follow-up must rebuild: the first build never saw the edit");
  });

  it("an isFresh that rejects counts as not fresh and does not wedge the repo", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    let calls = 0;
    const r = new CodeGraphRefresher({
      debounceMs: 1,
      isFresh: async () => { throw new Error("boom"); },
      build: async () => (calls++, OK),
    });
    r.enqueue(repo, "stop-hook");
    await r.whenIdle();
    r.stop();
    assert.equal(calls, 1);
  });
});
