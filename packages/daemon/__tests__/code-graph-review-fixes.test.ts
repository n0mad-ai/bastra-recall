import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeGraphRefresher } from "../src/code-graph/refresh.js";
import { changedLines } from "../src/code-graph/affected.js";
import { diffLines, parseHunkHeader } from "../src/code-graph/diff-lines.js";
import { unresolvedEntries } from "../src/code-graph/applies-to.js";
import { graphDirOf, GRAPH_FILE_NAME, loadGraph } from "../src/code-graph/reader.js";
import type { BuildResult } from "../src/code-graph/build.js";

const settled = () => new Promise<void>(resolve => setImmediate(resolve));
const ok: BuildResult = { ok: true, durationMs: 1, tookOverLock: false, manifest: {
  graphifyVersion: "fixture", builtAt: "2026-10-10T00:00:00Z", commit: null,
  repoRoot: "/fixture", command: "fixture", fileState: { count: 1, newestMtimeMs: 1 }, lastError: null, dirty: false,
} };

test("#670: lock waits double, automatic bursts cannot accelerate them, and retries stop", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, locked = true;
  const refresher = new CodeGraphRefresher({ lockRetryMs: 10, build: async () => {
    calls++; return locked ? { ok: false, reason: "locked", detail: "invented lease" } : ok;
  } });
  try {
    refresher.enqueue("/fixture", "git"); t.mock.timers.tick(0); await settled();
    assert.equal(calls, 1);
    for (const wait of [10, 20, 40, 80, 160, 320]) {
      const before = calls;
      for (const reason of ["watcher", "git", "stop-hook", "startup"] as const)
        for (let i = 0; i < 20; i++) refresher.enqueue("/fixture", reason);
      t.mock.timers.tick(wait - 1); await settled(); assert.equal(calls, before);
      t.mock.timers.tick(1); await settled(); assert.equal(calls, before + 1);
    }
    assert.equal(calls, 7); assert.equal(refresher.statusOf("/fixture")?.givenUp, true);
    assert.equal(refresher.statusOf("/fixture")?.failures, 0);
    assert.match(refresher.statusOf("/fixture")?.lastError ?? "", /locked after 7 attempts/);
    refresher.enqueue("/fixture", "git"); t.mock.timers.tick(10_000); await settled(); assert.equal(calls, 7);
    locked = false;
    refresher.enqueue("/fixture", "manual"); t.mock.timers.tick(0); await settled();
    assert.equal(calls, 8); assert.equal(refresher.statusOf("/fixture")?.givenUp, false);
    assert.equal(refresher.statusOf("/fixture")?.lastError, null);
    locked = true;
    refresher.enqueue("/fixture", "git"); t.mock.timers.tick(0); await settled();
    t.mock.timers.tick(9); await settled(); assert.equal(calls, 9);
    t.mock.timers.tick(1); await settled(); assert.equal(calls, 10, "success resets the next lock wait");
  } finally { refresher.stop(); }
});

test("#605: CRLF diffs map the same changes and file boundaries as LF", () => {
  const lf = ["diff --git a/demo.ts b/demo.ts", "--- a/demo.ts", "+++ b/demo.ts", "@@ -1,2 +1,2 @@ demo()", " same", "-old", "+new",
    "diff --git a/other.ts b/other.ts", "--- a/other.ts", "+++ b/other.ts", "@@ -1 +1 @@", "-x", "+y", ""].join("\n");
  const crlf = lf.replaceAll("\n", "\r\n");
  assert.deepEqual([...diffLines(crlf)], [...diffLines(lf)]);
  assert.deepEqual(changedLines(crlf, "demo.ts"), { lines: [2], mappable: true });
  assert.deepEqual(changedLines(crlf, "other.ts"), changedLines(lf, "other.ts"));
  assert.equal(parseHunkHeader("@@ -1 +1 @@ demo()\r")?.trailer, " demo()");
  assert.equal(parseHunkHeader("not a hunk\r"), null);
});

test("#594: function anchors accept parentheses and bare labels without inventing symbols", async () => {
  const repo = await mkdtemp(join(tmpdir(), "code-anchor-review-"));
  try {
    await mkdir(graphDirOf(repo), { recursive: true });
    const node = (id: string, label: string, file: string) => ({ id, label, source_file: file, source_location: "L1", file_type: "code", community: 0, _origin: "ast" });
    await writeFile(join(graphDirOf(repo), GRAPH_FILE_NAME), JSON.stringify({ directed: true, multigraph: false, graph: {},
      nodes: [node("calc", "calculate()", "demo.ts"), node("plain", "plain", "demo.ts"), node("foreign", "onlyOther()", "other.ts")], links: [], hyperedges: [] }));
    const loaded = await loadGraph(repo); assert.ok(loaded.ok); if (!loaded.ok) return;
    const check = (anchor: string) => unresolvedEntries([{ id: "fixture-note", affects_files: [anchor] }], { graph: loaded.graph, exists: () => true });
    for (const name of ["calculate", "calculate()", "CALCULATE", "plain", "plain()"])
      assert.deepEqual(check(`demo.ts#${name}`), [], name);
    for (const name of ["calculateMore", "calculate(arg)", "onlyOther", "absent"])
      assert.equal(check(`demo.ts#${name}`)[0]?.reason, "symbol-missing", name);
  } finally { await rm(repo, { recursive: true, force: true }); }
});
