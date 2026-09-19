import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  assertNoForbiddenCommand,
  buildArgs,
  buildCodeGraph,
  commandString,
  DEFAULT_GRAPHIFY_BIN,
  FORBIDDEN_SUBCOMMANDS,
  graphifyBinPath,
  isSupportedPlatform,
  scanFileState,
} from "../src/code-graph/build.js";
import { acquireRepoLock, isStaleLock, lockPath, readLock, LOCK_STALE_MS } from "../src/code-graph/lock.js";
import {
  clearRepoRootCache,
  gitPath,
  gitCommonDir,
  headCommit,
  isGitRepo,
  gitWatchPaths,
  repoRootOfFileSync,
  repoRootSync,
} from "../src/code-graph/git-paths.js";
import { graphDirOf } from "../src/code-graph/reader.js";
import { readManifest } from "../src/code-graph/manifest.js";

const run = promisify(execFile);

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-code-build-"));
  await writeFile(join(dir, "a.ts"), "export const a = 1;\n", "utf8");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "b.ts"), "export const b = 2;\n", "utf8");
  return dir;
}

/**
 * A stand-in for the pinned Graphify binary that records exactly how it was
 * called. The acceptance criteria are about the argv and the environment, so
 * the test observes the real spawn rather than the function that produced it.
 */
async function fakeGraphify(dir: string, exitCode = 0, stderr = ""): Promise<{ bin: string; argvFile: string; envFile: string }> {
  const bin = join(dir, "graphify");
  const argvFile = join(dir, "argv.txt");
  const envFile = join(dir, "env.txt");
  const script = [
    "#!/bin/sh",
    `if [ "$1" = "--version" ]; then echo "graphify, version 0.9.63"; exit 0; fi`,
    `printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}`,
    `printf '%s\\n' "$GRAPHIFY_QUERY_LOG_DISABLE" "$PYTHONHASHSEED" > ${JSON.stringify(envFile)}`,
    stderr === "" ? "" : `echo ${JSON.stringify(stderr)} >&2`,
    `exit ${exitCode}`,
    "",
  ].join("\n");
  await writeFile(bin, script, "utf8");
  await chmod(bin, 0o755);
  return { bin, argvFile, envFile };
}

describe("code graph build command", () => {
  it("only ever runs `extract … --code-only`", () => {
    assert.deepEqual(buildArgs("/repo"), ["extract", "/repo", "--code-only"]);
    assert.ok(!buildArgs("/repo").includes("--force"));
  });

  it("adds --force only for an explicitly confirmed rebuild", () => {
    assert.deepEqual(buildArgs("/repo", { rebuild: true }), ["extract", "/repo", "--code-only", "--force"]);
    assert.ok(!buildArgs("/repo", { rebuild: false }).includes("--force"));
  });

  it("refuses `graphify update` and a missing --code-only", () => {
    for (const forbidden of FORBIDDEN_SUBCOMMANDS) {
      assert.throws(() => assertNoForbiddenCommand([forbidden, "/repo"]), /only "extract"/);
    }
    assert.throws(() => assertNoForbiddenCommand(["extract", "/repo"]), /--code-only/);
    assert.doesNotThrow(() => assertNoForbiddenCommand(buildArgs("/repo")));
  });

  it("resolves the binary absolutely, never from PATH", () => {
    assert.ok(DEFAULT_GRAPHIFY_BIN.endsWith("/.bastra/tools/bin/graphify"));
    assert.equal(graphifyBinPath({}), DEFAULT_GRAPHIFY_BIN);
    assert.equal(graphifyBinPath({ BASTRA_GRAPHIFY_BIN: "/opt/g" }), "/opt/g");
    assert.equal(graphifyBinPath({ BASTRA_GRAPHIFY_BIN: "  " }), DEFAULT_GRAPHIFY_BIN);
  });

  it("names macOS and Linux as the supported platforms", () => {
    assert.equal(isSupportedPlatform("darwin"), true);
    assert.equal(isSupportedPlatform("linux"), true);
    assert.equal(isSupportedPlatform("win32"), false);
  });

  it("no module in code-graph/ mentions a forbidden subcommand", async () => {
    const dir = new URL("../src/code-graph/", import.meta.url);
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".ts"));
    assert.ok(files.length >= 4);
    for (const file of files) {
      const src = await readFile(new URL(file, dir), "utf8");
      for (const line of src.split("\n")) {
        // Comments explain why `update` is out; the allowlist constant names
        // it so it can be asserted against. Neither is a call site.
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        if (line.includes("FORBIDDEN_SUBCOMMANDS")) continue;
        assert.ok(
          !/["'`]update["'`]/.test(line),
          `${file} uses "update" as a literal outside a comment: ${line.trim()}`,
        );
      }
    }
  });
});

describe("buildCodeGraph against a stand-in binary", () => {
  it("spawns exactly the agreed command and environment, and writes the manifest", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    const { bin, argvFile, envFile } = await fakeGraphify(repo);

    const result = await buildCodeGraph({ repoRoot: repo, bin, lowPriority: false });
    assert.equal(result.ok, true, JSON.stringify(result));

    const argv = (await readFile(argvFile, "utf8")).trim().split("\n");
    assert.deepEqual(argv, ["extract", repo, "--code-only"]);
    assert.equal((await readFile(envFile, "utf8")).trim(), "1\n0");

    const manifest = await readManifest(graphDirOf(repo));
    assert.ok(manifest !== null);
    assert.equal(manifest.dirty, false);
    assert.equal(manifest.lastError, null);
    assert.ok(manifest.builtAt !== null && Number.isFinite(Date.parse(manifest.builtAt)));
    assert.equal(manifest.repoRoot, repo);
    assert.equal(manifest.command, commandString(bin, ["extract", repo, "--code-only"]));
    assert.equal(manifest.graphifyVersion, "0.9.63");
    assert.equal(manifest.fileState.count, 2);
    assert.ok(manifest.fileState.newestMtimeMs > 0);
  });

  it("leaves the previous graph in place and keeps `dirty` on disk when the build fails", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    const graphDir = graphDirOf(repo);
    await mkdir(graphDir, { recursive: true });
    await writeFile(join(graphDir, "graph.json"), '{"nodes":[],"links":[]}', "utf8");
    const { bin } = await fakeGraphify(repo, 2, "boom: extraction failed");

    const result = await buildCodeGraph({ repoRoot: repo, bin, lowPriority: false });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "failed");
    assert.match(result.ok === false ? result.detail : "", /boom: extraction failed/);

    // The graph the last good build produced is untouched.
    assert.equal(await readFile(join(graphDir, "graph.json"), "utf8"), '{"nodes":[],"links":[]}');

    const manifest = await readManifest(graphDir);
    assert.ok(manifest !== null);
    assert.equal(manifest.dirty, true, "dirty must survive on disk for startup reconciliation");
    assert.match(manifest.lastError ?? "", /boom/);
  });

  it("reports a missing binary instead of falling back to PATH", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    const result = await buildCodeGraph({ repoRoot: repo, bin: join(repo, "nope") });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "graphify-missing");
  });

  it("holds the lock until the killed child is actually gone", async (t) => {
    // THE REPRODUCTION (#582 counter-review). On a timeout the build resolved
    // immediately and `buildCodeGraph`'s `finally` released the lock — while
    // Graphify still had its whole SIGTERM grace period to keep writing into
    // the graph directory. The next daemon took the free lock and started a
    // second Graphify on the same files.
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    const bin = join(repo, "slow-graphify");
    await writeFile(
      bin,
      [
        "#!/bin/sh",
        `if [ "$1" = "--version" ]; then echo "graphify, version 0.9.63"; exit 0; fi`,
        // Keeps writing for a while after SIGTERM, the way a real Graphify
        // finishes its build cache. `wait` is what makes the trap arrive.
        "trap 'sleep 0.6; exit 143' TERM",
        "sleep 30 2>/dev/null &",
        "wait",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(bin, 0o755);

    const build = buildCodeGraph({ repoRoot: repo, bin, lowPriority: false, timeoutMs: 120 });
    await new Promise((r) => setTimeout(r, 350)); // past the timeout, inside the grace
    assert.equal(
      await acquireRepoLock(graphDirOf(repo), { heartbeat: false }),
      null,
      "the lock must not be free while the child may still be writing",
    );

    const result = await build;
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "timeout");
    const after = await acquireRepoLock(graphDirOf(repo), { heartbeat: false });
    assert.ok(after !== null, "and it is free once the child has exited");
    await after.release();
  });

  it("keeps the lock and reports `stuck` when the child never reports gone", async (t) => {
    // THE REPRODUCTION (#582 counter-review 3). The backstop resolved the build
    // seven seconds after the kill whether or not the child was gone, and the
    // `finally` then released the lock — handing the graph directory to the
    // next daemon while a process that may still write to it was alive.
    //
    // A child that survives SIGKILL cannot be staged, but the observable the
    // code keys on — `close` never arriving — can: the script ignores SIGTERM
    // and leaves a grandchild holding the stderr pipe open, so the pipe (and
    // with it `close`) outlives the SIGKILLed shell. That is the real shape of
    // it too: Graphify runs under `nice` and spawns children of its own.
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    const bin = join(repo, "stuck-graphify");
    const pidFile = join(repo, "grandchild.pid");
    await writeFile(
      bin,
      [
        "#!/bin/sh",
        `if [ "$1" = "--version" ]; then echo "graphify, version 0.9.63"; exit 0; fi`,
        "trap '' TERM",
        // `wait` is a shell builtin, so the grandchild is the ONLY process
        // left holding the stderr pipe once the shell is SIGKILLed — which is
        // what lets the test end the stuck state on purpose below.
        "sleep 30 & echo $! > " + JSON.stringify(pidFile),
        "wait",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(bin, 0o755);
    t.after(async () => {
      try {
        process.kill(Number((await readFile(pidFile, "utf8")).trim()), "SIGKILL");
      } catch {
        /* already gone */
      }
    });

    const result = await buildCodeGraph({ repoRoot: repo, bin, lowPriority: false, timeoutMs: 120 });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "stuck");
    assert.match(result.ok === false ? result.detail : "", /SIGKILL/);
    assert.equal(
      await acquireRepoLock(graphDirOf(repo), { heartbeat: false }),
      null,
      "the lock must be LEFT BEHIND: it expires as stale, it is never handed over early",
    );

    // AND THE LEASE MUST BE GONE WITH IT (#582 counter-review 4). Keeping the
    // lock used to mean keeping the heartbeat, so the record never aged and
    // `refresh` retried `locked` until the daemon was restarted. The record is
    // left to expire — and when the child does exit after all, the lock goes
    // back at once rather than waiting out the stale window.
    process.kill(Number((await readFile(pidFile, "utf8")).trim()), "SIGKILL");
    for (let i = 0; i < 100; i++) {
      if ((await readLock(graphDirOf(repo))) === null) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const freed = await acquireRepoLock(graphDirOf(repo), { heartbeat: false });
    assert.ok(freed !== null, "a child that exits late must free the lock immediately");
    await freed.release();
  });

  it("reports `locked` when another holder is building the same repo", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    const { bin, argvFile } = await fakeGraphify(repo);
    const held = await acquireRepoLock(graphDirOf(repo), { heartbeat: false });
    assert.ok(held !== null);
    t.after(() => held.release());

    const result = await buildCodeGraph({ repoRoot: repo, bin, lowPriority: false });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "locked");
    await assert.rejects(stat(argvFile), "the binary must not have run");
  });
});

describe("scanFileState", () => {
  it("counts source files and skips generated trees", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    for (const dir of ["node_modules", "graphify-out", ".git", "dist"]) {
      await mkdir(join(repo, dir), { recursive: true });
      await writeFile(join(repo, dir, "ignored.ts"), "export const x = 0;\n", "utf8");
    }
    await writeFile(join(repo, "README.md"), "# not code\n", "utf8");

    const state = await scanFileState(repo);
    assert.equal(state.count, 2);

    const before = state.newestMtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await writeFile(join(repo, "src", "b.ts"), "export const b = 3;\n", "utf8");
    const after = await scanFileState(repo);
    assert.ok(after.newestMtimeMs > before, "an edit must move the newest mtime");
  });
});

describe("the repo build lock", () => {
  it("lets exactly one holder in", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    const dir = graphDirOf(repo);

    const first = await acquireRepoLock(dir, { heartbeat: false });
    assert.ok(first !== null);
    const second = await acquireRepoLock(dir, { heartbeat: false });
    assert.equal(second, null, "two daemons racing: exactly one builds");

    await first.release();
    const third = await acquireRepoLock(dir, { heartbeat: false });
    assert.ok(third !== null, "the lock is free again after release");
    await third.release();
    assert.equal(await readLock(dir), null);
  });

  it("takes over a lock left behind by a dead daemon", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    const dir = graphDirOf(repo);
    await mkdir(dir, { recursive: true });

    const dead = {
      pid: 999_999_999,
      host: "some-other-host",
      token: "deadbeef",
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      renewedAt: new Date(Date.now() - 600_000).toISOString(),
    };
    await writeFile(lockPath(dir), JSON.stringify(dead), "utf8");

    const taken = await acquireRepoLock(dir, { heartbeat: false });
    assert.ok(taken !== null, "a stale lock is taken over, not waited on");
    assert.equal(taken.tookOver, true);
    assert.notEqual(taken.record.token, dead.token);
    await taken.release();
  });

  it("judges staleness by heartbeat, and by pid only on the same host", () => {
    const fresh = new Date().toISOString();
    const old = new Date(Date.now() - LOCK_STALE_MS - 1_000).toISOString();
    const base = { pid: process.pid, host: "elsewhere", token: "t", startedAt: fresh };
    assert.equal(isStaleLock({ ...base, renewedAt: fresh }, LOCK_STALE_MS), false);
    assert.equal(isStaleLock({ ...base, renewedAt: old }, LOCK_STALE_MS), true);
    assert.equal(isStaleLock({ ...base, renewedAt: "not-a-date" }, LOCK_STALE_MS), true);
  });

  it("never removes a lock that was taken over in the meantime", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    const dir = graphDirOf(repo);

    const mine = await acquireRepoLock(dir, { heartbeat: false });
    assert.ok(mine !== null);
    // A real takeover, so the successor owns the next generation's marker —
    // which is what makes the replaced holder's release a no-op.
    const taken = await acquireRepoLock(dir, { staleMs: -1, heartbeat: false });
    assert.ok(taken !== null);
    t.after(() => taken.release());
    await writeFile(lockPath(dir), JSON.stringify({ ...taken.record, token: "someone-else" }), "utf8");

    await mine.release();
    const still = await readLock(dir);
    assert.equal(still?.token, "someone-else", "the successor's lock must survive our release");
  });
});

describe("git path resolution", () => {
  it("resolves HEAD, refs and the common dir through git — also in a linked worktree", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "bastra-code-git-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const main = join(root, "main");
    await mkdir(main, { recursive: true });

    try {
      await run("git", ["init", "-q", "-b", "main", main], { cwd: root });
    } catch {
      return; // no git on this machine: the rest of the suite still stands
    }
    await run("git", ["config", "user.email", "t@example.com"], { cwd: main });
    await run("git", ["config", "user.name", "Test"], { cwd: main });
    await writeFile(join(main, "a.ts"), "export const a = 1;\n", "utf8");
    await run("git", ["add", "."], { cwd: main });
    await run("git", ["commit", "-q", "-m", "init"], { cwd: main });

    assert.equal(await isGitRepo(main), true);
    const commit = await headCommit(main);
    assert.match(commit ?? "", /^[0-9a-f]{40}$/);

    const wt = join(root, "wt-a");
    await run("git", ["worktree", "add", "-q", "-b", "side", wt], { cwd: main });

    // The point of git-paths.ts: in a worktree `.git` is a FILE, so every
    // hard-coded `<repo>/.git/...` path would be wrong.
    assert.ok((await stat(join(wt, ".git"))).isFile(), "a linked worktree has a .git FILE");

    const head = await gitPath(wt, "HEAD");
    const common = await gitCommonDir(wt);
    assert.ok(head !== null && head.startsWith("/"), "HEAD must be absolute");
    assert.ok(head.includes("worktrees"), `the worktree's own HEAD, got ${head}`);
    assert.ok(common !== null && !common.includes("worktrees"), `the shared git dir, got ${common}`);

    const watch = await gitWatchPaths(wt);
    assert.ok(watch.head !== null && watch.refs !== null && watch.packedRefs !== null);
    assert.ok(watch.refs.startsWith("/"));

    assert.equal(await isGitRepo(root), false, "outside a repo is a normal state");
    assert.equal(await headCommit(root), null);
  });
});

describe("synchronous repo-root lookup for the hook lanes", () => {
  it("finds the root from a subdirectory without spawning anything", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "bastra-code-root-"));
    t.after(() => {
      clearRepoRootCache();
      return rm(root, { recursive: true, force: true });
    });
    clearRepoRootCache();

    const repo = join(root, "repo");
    const deep = join(repo, "packages", "daemon", "src");
    await mkdir(deep, { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(deep, "x.ts"), "export const x = 1;\n", "utf8");

    // This is the case the Write/Edit lane got wrong with `payload.cwd`.
    assert.equal(repoRootSync(deep), repo);
    assert.equal(repoRootSync(repo), repo);
    assert.equal(repoRootOfFileSync(join(deep, "x.ts")), repo);
  });

  it("finds a worktree root, where .git is a FILE", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "bastra-code-root-wt-"));
    t.after(() => {
      clearRepoRootCache();
      return rm(root, { recursive: true, force: true });
    });
    clearRepoRootCache();

    const wt = join(root, "wt-a");
    await mkdir(join(wt, "src"), { recursive: true });
    await writeFile(join(wt, ".git"), "gitdir: /elsewhere/.git/worktrees/wt-a\n", "utf8");

    assert.equal(repoRootSync(join(wt, "src")), wt, "an isDirectory() test would miss this");
  });

  it("returns null outside any repository, and caches both answers", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "bastra-code-root-none-"));
    t.after(() => {
      clearRepoRootCache();
      return rm(root, { recursive: true, force: true });
    });
    clearRepoRootCache();

    const plain = join(root, "plain", "deeper");
    await mkdir(plain, { recursive: true });
    assert.equal(repoRootSync(plain), null);
    assert.equal(repoRootSync(""), null);
    assert.equal(repoRootOfFileSync(""), null);

    // The cached miss must survive a `.git` appearing — the cache is explicit
    // state, cleared on purpose and not by guesswork.
    await mkdir(join(root, "plain", ".git"), { recursive: true });
    assert.equal(repoRootSync(plain), null);
    clearRepoRootCache();
    assert.equal(repoRootSync(plain), join(root, "plain"));
  });
});
