import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeGraphRefresher, needsReconcile, type RefreshEvent } from "../src/code-graph/refresh.js";
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
    let started = 0;
    let release: (() => void) | null = null;
    const r = new CodeGraphRefresher({
      debounceMs: 1,
      build: async () => {
        started++;
        await new Promise<void>((res) => (release = res));
        return OK;
      },
    });

    r.enqueue("/repo", "watcher");
    await tick(10);
    assert.equal(started, 1);

    // Two quick edits while the first build is in flight.
    r.enqueue("/repo", "watcher");
    r.enqueue("/repo", "watcher");
    assert.equal(r.statusOf("/repo")?.pending, true);

    release!();
    await tick(20);
    assert.equal(started, 2, "two edits during a run must lead to exactly one follow-up");
    release!();
    await r.whenIdle();
    assert.equal(started, 2);
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
    await writeManifest(graphDir, manifest({ repoRoot: repo }));

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

    r.stop();
    assert.ok(r.status().every((s) => s.state === "idle"));
    r.enqueue("/a", "manual");
    assert.equal(r.statusOf("/a")?.state, "idle", "a stopped refresher takes no new work");
    await r.whenIdle();
  });
});
