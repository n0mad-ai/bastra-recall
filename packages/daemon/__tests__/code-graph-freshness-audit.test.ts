import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, rename, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphIsFresh, needsReconcile, CodeGraphRefresher } from "../src/code-graph/refresh.js";
import { scanFileState } from "../src/code-graph/build.js";
import { writeManifest } from "../src/code-graph/manifest.js";
import { graphDirOf } from "../src/code-graph/reader.js";

for (const change of ["rename", "replace", "resize", "legacy"] as const) {
  test(`codegraph freshness detects ${change} with preserved mtime`, async t => {
    const root = await mkdtemp(join(tmpdir(), "audit-fresh-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = join(root, "a.ts"), old = new Date(Date.now() - 60_000);
    await writeFile(file, "v0"); await utimes(file, old, old);
    const fileState = await scanFileState(root);
    if (change === "legacy") delete (fileState as { signature?: string }).signature;
    await mkdir(graphDirOf(root));
    await writeManifest(graphDirOf(root), { graphifyVersion: "test", builtAt: new Date().toISOString(), commit: null,
      repoRoot: root, command: "test", fileState, lastError: null, dirty: false });
    if (change !== "legacy") assert.equal(await graphIsFresh(root), true);
    if (change === "rename") await rename(file, join(root, "b.ts"));
    if (change === "replace") { await rm(file); await writeFile(join(root, "b.ts"), "v0"); await utimes(join(root, "b.ts"), old, old); }
    if (change === "resize") { await writeFile(file, "longer content"); await utimes(file, old, old); }
    assert.equal(await graphIsFresh(root), false);
    assert.equal(await needsReconcile(root), true);
  });
}

test("an event arriving during a fresh scan promises a follow-up", async t => {
  let release!: (fresh: boolean) => void, checking!: () => void;
  const started = new Promise<void>(resolve => { checking = resolve; });
  let builds = 0;
  const ref = new CodeGraphRefresher({ debounceMs: 1, isFresh: () => { checking(); return new Promise(resolve => { release = resolve; }); },
    build: async () => { builds++; return { ok: false, reason: "unsupported-platform", detail: "test" }; } });
  t.after(() => ref.stop());
  ref.enqueue("/fixture", "watcher");
  const idle = ref.whenIdle(); await started;
  ref.enqueue("/fixture", "watcher"); release(true); await idle;
  assert.equal(builds, 1);
});
