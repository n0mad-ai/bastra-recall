#!/usr/bin/env node
// Linux-only #1079 measurement: real service, real inotify fdinfo, synthetic tree.
// Optional baseline git ref demonstrates that the same watch-count gate fails
// before the fix. Run after npm run build; never connects to a running daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

if (process.platform !== "linux") {
  console.log("#1079 measurement requires Linux /proc (run in CI).");
  process.exit(0);
}
const repo = fileURLToPath(new URL("../", import.meta.url));
const service = path.join(repo, "packages/daemon/dist/code-graph/service.js");
const kernelWatches = () => fs.readdirSync("/proc/self/fdinfo").reduce((n, fd) => {
  try { return n + fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").split("\n").filter(l => l.startsWith("inotify ")).length; }
  catch { return n; }
}, 0);

if (process.argv[2] === "--child") {
  const [, , , modulePath, ignoredFiles] = process.argv;
  const svc = await import(pathToFileURL(modulePath).href);
  const { CodeGraphRefresher } = await import(pathToFileURL(path.join(path.dirname(service), "refresh.js")).href);
  const { GRAPH_DIR_NAME } = await import(pathToFileURL(path.join(path.dirname(service), "reader.js")).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bastra-watch-measure-"));
  let handle;
  let builds = 0;
  const refresh = new CodeGraphRefresher({ debounceMs: 100, isFresh: async () => false, build: async () => {
    builds++;
    return { ok: true, durationMs: 1, tookOverLock: false, manifest: {} };
  } });
  // Startup is irrelevant to the file-watcher measurement; real debounce/build
  // coordination remains in use for the watcher trigger itself.
  svc.codeGraphRefresher().enqueue = (repoRoot, reason) => { if (reason === "watcher") refresh.enqueue(repoRoot, reason); };
  try {
    fs.mkdirSync(path.join(root, "src/nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/nested/main.ts"), "export {};\n");
    for (const name of ["node_modules", "dist", "build", ".git", ".ruff_cache", GRAPH_DIR_NAME]) {
      fs.mkdirSync(path.join(root, name, "deep"), { recursive: true });
      for (let i = 0; i < Number(ignoredFiles) / 6; i++) fs.writeFileSync(path.join(root, name, "deep", `${i}.ts`), "ignored");
    }
    const before = kernelWatches();
    handle = await svc.startCodeAwareness(undefined, async () => [root], 600_000);
    await sleep(2500);
    const watches = kernelWatches() - before;
    fs.writeFileSync(path.join(root, "node_modules/deep/0.ts"), "ignored edit");
    await sleep(350);
    assert.equal(builds, 0, "ignored edit must not refresh");
    fs.writeFileSync(path.join(root, "src/nested/main.ts"), "export const changed = true;\n");
    const deadline = Date.now() + 5000;
    while (builds === 0 && Date.now() < deadline) await sleep(20);
    await sleep(350);
    assert.equal(builds, 1, "a source edit must build exactly once");
    handle.stop();
    await sleep(100);
    assert.equal(kernelWatches(), before, "stop must free every working-tree watch");
    console.log(JSON.stringify({ ignoredFiles: Number(ignoredFiles), eligibleDirectories: 3, watches, sourceRefreshes: builds, ignoredRefreshes: 0 }));
  } finally {
    handle?.stop(); refresh.stop(); fs.rmSync(root, { recursive: true, force: true });
  }
} else {
  const baselineRef = process.argv[2];
  let baselinePath;
  try {
    if (baselineRef) {
      const ts = await import("typescript");
      const source = execFileSync("git", ["show", `${baselineRef}:packages/daemon/src/code-graph/service.ts`], { cwd: repo, encoding: "utf8" });
      baselinePath = path.join(path.dirname(service), `baseline-watch-${process.pid}.js`);
      fs.writeFileSync(baselinePath, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
    }
    const rows = [];
    for (const ignored of [1500, 6000]) {
      for (const [label, modulePath] of [["before", baselinePath], ["after", service]]) {
        if (!modulePath) continue;
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", modulePath, String(ignored)], { cwd: repo, encoding: "utf8", timeout: 30_000 });
        assert.equal(child.status, 0, `${label}: ${child.stderr || child.stdout || child.error}`);
        const result = JSON.parse(child.stdout.trim());
        rows.push({ version: label, ...result });
        if (label === "after") assert.equal(result.watches, 3, "regression gate: eligible directories only");
      }
    }
    console.table(rows);
    const beforeRows = rows.filter(row => row.version === "before");
    if (beforeRows.length) {
      assert.ok(beforeRows.every(row => row.watches > 3), "baseline must fail the same <=3 watch regression gate");
      assert.ok(beforeRows[1].watches > beforeRows[0].watches, "baseline must scale with ignored files");
      console.log("Baseline watch-count regression: RED; fixed watch-count regression: GREEN.");
    }
  } finally { if (baselinePath) fs.rmSync(baselinePath, { force: true }); }
}
