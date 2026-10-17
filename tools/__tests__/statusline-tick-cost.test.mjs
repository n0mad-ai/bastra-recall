import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GitService } from "../../packages/statusline/src/segments/git.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "statusline-1227-"));
function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
async function tick(cwd) {
  const svc = new GitService();
  const commands = [];
  const run = svc.execGitAsync.bind(svc);
  svc.execGitAsync = async (...args) => { commands.push(args[0]); return run(...args); };
  const info = await svc.getGitInfo(cwd, { showWorkingTree: true });
  return { info, commands };
}

test("#1227: fresh GitService instances reuse the disk cache and invalidate on file/ref changes", async () => {
  const dir = temporary();
  try {
    const remote = path.join(dir, "remote.git");
    const repo = path.join(dir, "repo");
    git(dir, "init", "--bare", remote);
    fs.mkdirSync(repo);
    git(repo, "init", "-b", "main");
    fs.writeFileSync(path.join(repo, "tracked"), "one\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "initial");
    git(repo, "remote", "add", "origin", remote); git(repo, "push", "-u", "origin", "main");
    assert.equal((await tick(repo)).info.status, "clean");
    assert.deepEqual((await tick(repo)).commands, [], "valid cache must start no git processes");
    assert.deepEqual((await tick(repo + path.sep)).commands, [], "trailing separator names the same checkout");

    fs.writeFileSync(path.join(repo, "tracked"), "two\n");
    assert.equal((await tick(repo)).info.unstaged, 1, "unstaged edits need no index mtime change");
    assert.deepEqual((await tick(repo)).commands, []);
    git(repo, "add", ".");
    assert.equal((await tick(repo)).info.staged, 1);
    git(repo, "commit", "-m", "second");
    assert.equal((await tick(repo)).info.ahead, 1, "commit invalidates at the next tick");
    assert.deepEqual((await tick(repo)).commands, []);
    git(repo, "push");
    assert.equal((await tick(repo)).info.ahead, 0, "push changes upstream without changing HEAD");
    git(repo, "checkout", "-b", "other");
    assert.equal((await tick(repo)).info.branch, "other");
    git(repo, "checkout", "main");
    assert.equal((await tick(repo)).info.branch, "main");

    fs.mkdirSync(path.join(repo, "empty"));
    await tick(repo);
    fs.mkdirSync(path.join(repo, "empty", "nested"));
    fs.writeFileSync(path.join(repo, "empty", "nested", "new"), "new\n");
    assert.equal((await tick(repo)).info.untracked, 1, "new files inside a previously empty directory invalidate");
    fs.rmSync(path.join(repo, "empty"), { recursive: true });
    assert.equal((await tick(repo)).info.status, "clean");

    // Ignored output must not force a recursive walk through build/dependency trees.
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored/\n");
    fs.mkdirSync(path.join(repo, "ignored"));
    fs.writeFileSync(path.join(repo, "ignored", "output"), "first\n");
    git(repo, "add", ".gitignore"); git(repo, "commit", "-m", "ignore output");
    git(repo, "push");
    await tick(repo);
    fs.writeFileSync(path.join(repo, "ignored", "output"), "changed\n");
    assert.deepEqual((await tick(repo)).commands, [], "ignored-file edits do not invalidate the cache");

    git(repo, "pack-refs", "--all");
    assert.equal((await tick(repo)).info.ahead, 0);
    const worktree = path.join(dir, "worktree");
    git(repo, "worktree", "add", "-b", "worktree", worktree);
    git(worktree, "branch", "--set-upstream-to=origin/main");
    assert.equal((await tick(worktree)).info.branch, "worktree");
    assert.deepEqual((await tick(worktree)).commands, []);
    fs.writeFileSync(path.join(worktree, "tracked"), "worktree\n");
    git(worktree, "commit", "-am", "worktree commit");
    assert.equal((await tick(worktree)).info.ahead, 1);
    git(worktree, "push", "origin", "HEAD:main");
    assert.equal((await tick(worktree)).info.ahead, 0, "worktree uses refs in commondir");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function child(code, home) {
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude") },
    encoding: "utf8",
  });
}

for (const comm of ["claude", "zsh"]) {
  test(`#1227: a ${comm} ancestor is resolved once across independent tick processes`, () => {
    const home = temporary();
    try {
      const code = `
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        let calls = 0;
        cp.execFileSync = () => { calls++; return process.ppid + ' 1 ${comm}\\n'; };
        syncBuiltinESMExports();
        const { BastraProvider } = await import('./packages/statusline/src/segments/bastra.ts');
        new BastraProvider().getBastraInfo();
        console.log(calls);
      `;
      assert.equal(child(code, home).trim(), "1");
      assert.equal(child(code, home).trim(), "0", "warm tick must reuse the cached PID/parent walk");
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
}

test("#1227: install and path updates retain a chosen or omitted interval; new blocks default to 1s", () => {
  const home = temporary();
  try {
    const code = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { claudeCodeAdapter } from './packages/daemon/dist/cli/adapters/claude-code.js';
      import { STATUSLINE_BIN } from './packages/daemon/dist/cli/paths.js';
      const settings = path.join(process.env.HOME, '.claude/settings.json');
      fs.mkdirSync(path.dirname(settings), {recursive:true});
      const read = () => JSON.parse(fs.readFileSync(settings, 'utf8'));
      const install = async () => {
        const r = await claudeCodeAdapter.install({dryRun:false, vaultPath:path.join(process.env.HOME, 'vault'), useStub:false});
        assert.notEqual(r.status, 'error', r.message);
        return r;
      };
      fs.writeFileSync(settings, '{}');
      await install();
      assert.equal(read().statusLine.refreshInterval, 1);
      for (const interval of [30, undefined]) {
        const data = read();
        data.statusLine.refreshInterval = interval;
        fs.writeFileSync(settings, JSON.stringify(data));
        const r = await install();
        assert.match(r.message, /already in place/);
        assert.equal(read().statusLine.refreshInterval, interval);
        data.statusLine.command = 'node /old/statusline/dist/index.mjs --style=powerline';
        fs.writeFileSync(settings, JSON.stringify(data));
        await install();
        assert.equal(read().statusLine.refreshInterval, interval);
        assert.ok(read().statusLine.command.includes(STATUSLINE_BIN));
      }
    `;
    child(code, home);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("#1227: stdin session id reuses Git and Claude PID behind a fresh wrapper shell per tick", () => {
  const dir = temporary();
  try {
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-b", "main");
    fs.writeFileSync(path.join(repo, "file"), "one\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "initial");
    const preload = path.join(dir, "count.mjs");
    fs.writeFileSync(preload, `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      let calls = 0;
      const original = cp.execFile;
      cp.execFile = function(...args) { calls++; return Reflect.apply(original, this, args); };
      cp.execFileSync = () => { calls++; return process.ppid + ' ${process.pid} sh\\n${process.pid} 1 claude\\n'; };
      syncBuiltinESMExports();
      process.on('exit', () => console.error('CALLS=' + calls));
    `);
    const config = path.join(dir, "config.json");
    fs.writeFileSync(config, JSON.stringify({ display: { lines: [{ segments: {
      git: { enabled: true }, bastra: { enabled: true },
    } }] } }));
    const payload = JSON.stringify({ session_id: "wrapper-session", workspace: { project_dir: repo, current_dir: repo }, cwd: repo });
    const code = `
      import { spawnSync } from 'node:child_process';
      const result = spawnSync(process.execPath, ['--import', ${JSON.stringify(preload)},
        './packages/statusline/dist/index.mjs', '--config=' + ${JSON.stringify(config)}],
        { input: ${JSON.stringify(payload)}, encoding: 'utf8', env: {...process.env, COLUMNS:'160'} });
      if (result.status !== 0) throw new Error(result.stderr);
      console.log(JSON.stringify({ parent: process.pid, output: result.stdout,
        calls: Number(result.stderr.match(/CALLS=(\\d+)/)?.[1]) }));
    `;
    const cold = JSON.parse(child(code, dir));
    const warm = JSON.parse(child(code, dir));
    assert.notEqual(cold.parent, warm.parent, "each tick really has a new intermediate parent");
    assert.equal(cold.calls, 6, "five Git queries and one parent walk populate the session cache");
    assert.equal(warm.calls, 0, "session id must bridge changing parent PIDs");
    assert.equal(warm.output, cold.output);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
