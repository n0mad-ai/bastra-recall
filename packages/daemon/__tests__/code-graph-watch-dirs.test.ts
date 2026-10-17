import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startCodeAwareness, codeGraphRefresher } from "../src/code-graph/service.js";
import { GRAPH_DIR_NAME } from "../src/code-graph/reader.js";
import { CodeGraphRefresher } from "../src/code-graph/refresh.js";

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "watcher condition timed out");
    await sleep(20);
  }
}

// Real directory-only event behavior is Linux-specific: FSEvents coalesces
// transient trees differently. Error handling is exercised on every OS below.
test("#1079: watch only eligible directories, discover new trees and release removed watches", { skip: process.platform !== "linux" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "code-watch-dirs-"));
  const outside = await mkdtemp(join(tmpdir(), "code-watch-outside-"));
  let handle: Awaited<ReturnType<typeof startCodeAwareness>> | undefined;
  const active = new Map<string, fs.FSWatcher>();
  const originalWatch = fs.watch;
  const enqueued: string[] = [];
  // Keep startup reconciliation independent; only observe file watcher events.
  t.mock.method(codeGraphRefresher(), "enqueue", (_repo: string, reason: string) => { enqueued.push(reason); });
  t.mock.method(fs, "watch", (...args: Parameters<typeof fs.watch>) => {
    const watcher = originalWatch(...args);
    const path = String(args[0]);
    active.set(path, watcher);
    watcher.once("close", () => { if (active.get(path) === watcher) active.delete(path); });
    return watcher;
  });
  syncBuiltinESMExports();
  try {
    for (const dir of ["src/nested", "node_modules/pkg", "dist/x", "build/x", ".git/x", ".ruff_cache/x", "src/.cache/x", `${GRAPH_DIR_NAME}/x`]) {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, "file.ts"), "export {};\n");
    }
    await symlink(outside, join(root, "linked"), "dir");
    handle = await startCodeAwareness(undefined, async () => [root], 600_000);
    await until(() => active.size >= 3);
    assert.deepEqual([...active.keys()].map(p => relative(root, p)).sort(), ["", "src", "src/nested"]);
    await sleep(100); enqueued.length = 0;
    await writeFile(join(root, "node_modules/pkg/file.ts"), "ignored");
    await writeFile(join(root, ".ruff_cache/x/file.ts"), "ignored");
    await writeFile(join(outside, "file.ts"), "ignored");
    await sleep(150);
    assert.equal(enqueued.filter(r => r === "watcher").length, 0);
    await writeFile(join(root, "src/nested/file.ts"), "changed");
    await until(() => enqueued.includes("watcher"));
    enqueued.length = 0;
    await writeFile(join(root, ".gitignore"), "node_modules\n");
    await until(() => enqueued.includes("watcher"));
    await mkdir(join(root, "src/new/deeper"), { recursive: true });
    await until(() => active.has(join(root, "src/new/deeper")));
    enqueued.length = 0;
    await writeFile(join(root, "src/new/deeper/new.ts"), "changed");
    await until(() => enqueued.includes("watcher"));
    await rename(join(root, "src/new"), join(root, "moved"));
    await until(() => active.has(join(root, "moved/deeper")) && !active.has(join(root, "src/new")));
    await rm(join(root, "moved"), { recursive: true });
    await until(() => ![...active.keys()].some(p => p.startsWith(join(root, "moved"))));
    handle.stop();
    await until(() => active.size === 0);
  } finally {
    handle?.stop();
    t.mock.restoreAll(); syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

function kernelWatches(): number {
  let count = 0;
  for (const fd of fs.readdirSync("/proc/self/fdinfo")) {
    try { count += fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").split("\n").filter(l => l.startsWith("inotify ")).length; }
    catch { /* fd closed */ }
  }
  return count;
}

test("#1079 Linux: kernel watch count stays constant with large ignored trees; one source edit builds once", { skip: process.platform !== "linux" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "code-inotify-"));
  const baseline = kernelWatches();
  let handle: Awaited<ReturnType<typeof startCodeAwareness>> | undefined;
  let builds = 0;
  const refresh = new CodeGraphRefresher({ debounceMs: 50, isFresh: async () => false, build: async () => {
    builds++;
    return { ok: false, reason: "graphify-missing", detail: "fixture" };
  } });
  t.mock.method(codeGraphRefresher(), "enqueue", (repo: string, reason: Parameters<CodeGraphRefresher["enqueue"]>[1]) => {
    if (reason === "watcher") refresh.enqueue(repo, reason);
  });
  try {
    await mkdir(join(root, "src/nested"), { recursive: true });
    await writeFile(join(root, "src/nested/main.ts"), "export {};\n");
    for (const name of ["node_modules", "dist", "build", ".git", ".ruff_cache", GRAPH_DIR_NAME]) {
      await mkdir(join(root, name, "deep"), { recursive: true });
      for (let i = 0; i < 250; i++) await writeFile(join(root, name, "deep", `${i}.ts`), "ignored");
    }
    // No actual git repo: this isolates the working-tree watcher from git triggers.
    handle = await startCodeAwareness(undefined, async () => [root], 600_000);
    await sleep(500);
    const count = kernelWatches() - baseline;
    t.diagnostic(`inotify watches: ${count}; eligible directories: 3; ignored files: 1500`);
    assert.equal(count, 3, "ignored trees and source files must not consume watches");
    await writeFile(join(root, "node_modules/deep/0.ts"), "ignored edit");
    await sleep(200); assert.equal(builds, 0);
    await writeFile(join(root, "src/nested/main.ts"), "export const changed = true;\n");
    await until(() => builds === 1);
    await sleep(200); assert.equal(builds, 1);
    t.diagnostic(`source edit refreshes: ${builds}; ignored edit refreshes: 0`);
    handle.stop(); await until(() => kernelWatches() === baseline);
  } finally {
    handle?.stop(); refresh.stop();
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["sync", "async"] as const) {
  test(`#1079: ${mode} ENOSPC warns once without paths; other refresh triggers still work`, async t => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    const root = await mkdtemp(join(tmpdir(), "private-watch-limit-"));
    const notices: string[] = [];
    const events: string[] = [];
    const fake = new EventEmitter() as fs.FSWatcher;
    let closed = 0;
    fake.close = () => { closed++; };
    let attempts = 0;
    const error = Object.assign(new Error(`private stderr ${root}`), { code: "ENOSPC" });
    t.mock.method(fs, "watch", () => { attempts++; if (mode === "sync") throw error; return fake; });
    syncBuiltinESMExports();
    t.mock.method(codeGraphRefresher(), "enqueue", (_repo: string, reason: string) => { events.push(reason); });
    let handle: Awaited<ReturnType<typeof startCodeAwareness>> | undefined;
    try {
      await mkdir(join(root, "a")); await mkdir(join(root, "b"));
      handle = await startCodeAwareness(line => notices.push(line), async () => [root], 600_000);
      if (mode === "async") { fake.emit("error", error); fake.emit("error", error); }
      assert.deepEqual(notices, ["code-graph: watch_limit"]);
      if (mode === "sync") assert.equal(attempts, 1, "stop registering after kernel exhaustion");
      else assert.ok(closed > 0, "release failed watch handles");
      codeGraphRefresher().enqueue(root, "stop-hook");
      codeGraphRefresher().enqueue(root, "git");
      assert.ok(events.includes("stop-hook")); assert.ok(events.includes("git"));
    } finally {
      handle?.stop(); t.mock.restoreAll(); syncBuiltinESMExports();
      Object.defineProperty(process, "platform", platform);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("#1079: macOS retains the recursive FSEvents watcher", async t => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  const root = await mkdtemp(join(tmpdir(), "code-fsevents-"));
  const options: unknown[] = [];
  const fake = new EventEmitter() as fs.FSWatcher;
  fake.close = () => {};
  t.mock.method(fs, "watch", (_path: unknown, opts: unknown) => { options.push(opts); return fake; });
  syncBuiltinESMExports();
  let handle: Awaited<ReturnType<typeof startCodeAwareness>> | undefined;
  try {
    handle = await startCodeAwareness(undefined, async () => [root], 600_000);
    assert.deepEqual(options, [{ recursive: true, persistent: false }]);
  } finally {
    handle?.stop(); t.mock.restoreAll(); syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
    await rm(root, { recursive: true, force: true });
  }
});
