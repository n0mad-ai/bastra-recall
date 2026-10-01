/**
 * #528 — `dist/.build-revision` says whether the tree matched HEAD when the
 * build ran, and `bastra update` and the freshness checks trust `dirty`.
 *
 * `git()` in scripts/write-build-revision.mjs returns null on any failure (the
 * 15 s timeout, a held index.lock), and `null ?? ""` turned that into
 * `dirty=false`: a stamp claiming a clean tree that nobody checked. A status
 * git could not answer is "could not tell", which reads as dirty — the same
 * reading headState() in cli/source-build.ts takes.
 *
 * The script derives its repo root from its own location, so it is copied into
 * a throwaway repo whose config makes `git status` fail while `rev-parse`
 * still answers.
 *
 * Runner: node --test tools/__tests__/write-build-revision-status-unreadable.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_SRC = fileURLToPath(new URL("../../scripts/write-build-revision.mjs", import.meta.url));

async function stampWith({ statusWorks }, t) {
  const dir = await mkdtemp(join(tmpdir(), "build-revision-status-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
  await mkdir(join(dir, "scripts"), { recursive: true });
  await mkdir(join(dir, "dist"), { recursive: true });
  await copyFile(SCRIPT_SRC, join(dir, "scripts", "write-build-revision.mjs"));
  await writeFile(join(dir, ".gitignore"), "dist/\n", "utf8");
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@local");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");

  // `git status` that cannot answer while `rev-parse` still can: a bad value
  // for a status-only setting makes status fail with exit 128.
  if (!statusWorks) git("config", "status.showUntrackedFiles", "bogus");

  execFileSync(process.execPath, [join(dir, "scripts", "write-build-revision.mjs"), "dist"], {
    cwd: dir,
    stdio: "pipe",
  });
  return readFile(join(dir, "dist", ".build-revision"), "utf8");
}

test("a git status that cannot be read stamps dirty=true", { skip: process.platform === "win32" }, async (t) => {
  const stamp = await stampWith({ statusWorks: false }, t);
  assert.match(stamp, /^revision=[0-9a-f]{40}$/m);
  assert.match(stamp, /^dirty=true$/m, `an unanswered status was stamped as clean:\n${stamp}`);
});

test("a clean tree whose status answers still stamps dirty=false", { skip: process.platform === "win32" }, async (t) => {
  const stamp = await stampWith({ statusWorks: true }, t);
  assert.match(stamp, /^dirty=false$/m);
});
