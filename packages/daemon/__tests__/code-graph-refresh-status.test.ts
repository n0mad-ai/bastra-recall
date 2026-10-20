/**
 * The refresh state a user gets to see (#1148): the wording, the wire shape
 * both ways, and the loopback door `bastra code` and `bastra doctor` read it
 * through — including the `manual` request that ends a pause or a stop.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { CodeGraphRefresher, type RepoStatus } from "../src/code-graph/refresh.js";
import type { BuildResult } from "../src/code-graph/build.js";
import {
  parseRefreshStatusRows,
  refreshStatusLines,
  toRefreshStatusRows,
} from "../src/code-graph/refresh-status.js";
import { dispatchLocalRoutes, type LocalRouteCtx } from "../src/http-local-routes.js";
import { fetchRefreshStatus, requestManualRefresh, resumeRefreshIfGivenUp } from "../src/cli/code-refresh-client.js";

const NOW = new Date("2026-10-20T10:00:00Z");

function status(over: Partial<RepoStatus> = {}): RepoStatus {
  return {
    repoRoot: "/repo",
    state: "idle",
    pending: false,
    failures: 0,
    lastError: null,
    givenUp: false,
    lastReason: null,
    builds: 0,
    nextAttemptAt: null,
    ...over,
  };
}

describe("refresh status wording", () => {
  it("says nothing about a healthy repository", () => {
    assert.deepEqual(refreshStatusLines(status(), NOW), []);
    assert.deepEqual(refreshStatusLines(status({ state: "waiting", nextAttemptAt: "2026-10-20T10:00:03Z" }), NOW), []);
  });

  it("names the hourly attempt of a lock pause and the way out", () => {
    const lines = refreshStatusLines(
      status({ givenUp: true, state: "waiting", lastError: "locked after 7 attempts: locked: /repo/graphify-out", nextAttemptAt: "2026-10-20T10:42:00Z" }),
      NOW,
    );
    assert.deepEqual(lines, [
      "refresh paused: locked after 7 attempts: locked: /repo/graphify-out",
      "next automatic attempt in 42 min — 'bastra code index' tries now",
    ]);
    assert.match(refreshStatusLines(status({ givenUp: true, nextAttemptAt: "2026-10-20T11:05:00Z" }), NOW)[1]!, /in 1 h 5 min/);
    assert.match(refreshStatusLines(status({ givenUp: true, nextAttemptAt: "2026-10-20T09:59:00Z" }), NOW)[1]!, /any moment now/);
  });

  it("says a stop after failed builds waits for the user, and which command", () => {
    const lines = refreshStatusLines(
      status({ givenUp: true, failures: 3, lastError: "failed: exit code 1" }),
      NOW,
    );
    assert.deepEqual(lines, [
      "refresh stopped after 3 failed builds: failed: exit code 1",
      "no automatic retry — run 'bastra code index' to retry",
    ]);
  });
});

describe("refresh status on the wire", () => {
  it("survives the round trip and drops rows it cannot read", () => {
    const s = status({ givenUp: true, failures: 2, lastError: "x", lastReason: "git", builds: 4, nextAttemptAt: "2026-10-20T11:00:00Z", state: "waiting" });
    assert.deepEqual(parseRefreshStatusRows({ repos: toRefreshStatusRows([s]) }), [s]);
    assert.deepEqual(parseRefreshStatusRows({ repos: [{ repo_root: "/x", state: "unknown" }, null, 3] }), []);
    assert.deepEqual(parseRefreshStatusRows(null), []);
    assert.deepEqual(parseRefreshStatusRows({}), []);
  });
});

describe("GET and POST /code/refresh", () => {
  async function withServer<T>(refresher: CodeGraphRefresher, fn: (baseUrl: string) => Promise<T>): Promise<T> {
    const ctx = { codeRefresh: refresher, toolDeps: {} } as unknown as LocalRouteCtx;
    const server: Server = createServer((req, res) => {
      if (dispatchLocalRoutes(req, res, req.method ?? "GET", req.url ?? "", Date.now(), ctx)) return;
      res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      return await fn(`http://127.0.0.1:${port}`);
    } finally {
      refresher.stop();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  }

  const fail = (): BuildResult => ({ ok: false, reason: "failed", detail: "boom" });
  const ok: BuildResult = { ok: true, durationMs: 1, tookOverLock: false, manifest: {
    graphifyVersion: "fixture", builtAt: new Date().toISOString(), commit: null, repoRoot: "/repo",
    command: "fixture", fileState: { count: 1, newestMtimeMs: 1 }, lastError: null, dirty: false,
  } };

  it("shows a stopped repository, and a manual request builds it again", async () => {
    let calls = 0;
    const refresher = new CodeGraphRefresher({
      debounceMs: 1,
      backoffMs: [1],
      maxFailures: 1,
      build: async () => (++calls === 1 ? fail() : ok),
    });
    refresher.enqueue("/repo", "watcher");
    await refresher.whenIdle();
    assert.equal(refresher.statusOf("/repo")?.givenUp, true);

    await withServer(refresher, async (baseUrl) => {
      const seen = await fetchRefreshStatus(baseUrl);
      assert.ok(seen !== null);
      assert.equal(seen.get("/repo")?.givenUp, true);
      assert.deepEqual(refreshStatusLines(seen.get("/repo")!, NOW), [
        "refresh stopped after 1 failed build: failed: boom",
        "no automatic retry — run 'bastra code index' to retry",
      ]);

      assert.equal(await requestManualRefresh("/repo", baseUrl), true);
      await refresher.whenIdle();
      assert.equal(calls, 2, "the manual request built despite the stop");
      assert.equal((await fetchRefreshStatus(baseUrl))?.get("/repo")?.givenUp, false);
    });
  });

  it("resumes only a repository the daemon gave up on, never a healthy one", async () => {
    let calls = 0;
    const refresher = new CodeGraphRefresher({
      debounceMs: 1,
      backoffMs: [1],
      maxFailures: 1,
      build: async () => (++calls === 1 ? fail() : ok),
    });
    refresher.enqueue("/stopped", "watcher");
    await refresher.whenIdle();
    assert.equal(calls, 1);
    await withServer(refresher, async (baseUrl) => {
      assert.equal(await resumeRefreshIfGivenUp("/healthy", baseUrl), false, "unknown to the daemon");
      assert.equal(calls, 1, "no build for a repository the daemon never gave up on");
      assert.equal(await resumeRefreshIfGivenUp("/stopped", baseUrl), true);
      await refresher.whenIdle();
      assert.equal(calls, 2);
      assert.equal(await resumeRefreshIfGivenUp("/stopped", baseUrl), false, "healthy again: no second build");
      await refresher.whenIdle();
      assert.equal(calls, 2);
    });
  });

  it("rejects a request without a repository and answers 405 to other methods", async () => {
    await withServer(new CodeGraphRefresher({ build: async () => ok }), async (baseUrl) => {
      const bad = await fetch(`${baseUrl}/code/refresh`, { method: "POST", body: "{}" });
      assert.equal(bad.status, 400);
      assert.equal((await fetch(`${baseUrl}/code/refresh`, { method: "DELETE" })).status, 405);
      assert.equal(await requestManualRefresh("/repo", "http://127.0.0.1:1"), false, "no daemon: nothing to resume");
      assert.equal(await fetchRefreshStatus("http://127.0.0.1:1"), null, "no daemon: nothing to report");
    });
  });
});
