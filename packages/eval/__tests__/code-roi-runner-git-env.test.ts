/**
 * The code-roi runner starts the test suites of other repositories (#1670).
 *
 * Started from a git hook or a tool that exports GIT_DIR/GIT_WORK_TREE/
 * GIT_INDEX_FILE, it used to pass them on, and every git the target suite runs
 * worked on the caller's repository instead of the target's own checkout. The
 * caller here is a freshly created decoy repository, compared byte for byte.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — plain .mjs measurement scripts, no declarations
import { detectRunner, runSuite } from "../code-roi/v2/test-runner.mjs";
// @ts-expect-error — plain .mjs script, no declarations
import { dropCallerGitEnv } from "../../../scripts/caller-git-env.mjs";

// #1669: started without test-env.mjs, this file's git must still not reach a caller's GIT_DIR/GIT_WORK_TREE.
dropCallerGitEnv();

const SUITE = `const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { realpathSync } = require("node:fs");
const path = require("node:path");
test("git works in the suite's own checkout", () => {
  const root = path.join(__dirname, "..");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("-c", "user.name=suite", "-c", "user.email=suite@example.invalid", "commit", "--allow-empty", "-qm", "suite");
  assert.equal(realpathSync(git("rev-parse", "--show-toplevel")), realpathSync(root));
});
`;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    stdio: "ignore",
  });
}

/** Every file of the tree, path and bytes — `.git` included. */
function fingerprint(dir: string): string {
  const hash = createHash("sha256");
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const child = join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else
        hash
          .update(`${child}\0`)
          .update(readFileSync(join(dir, child)))
          .update("\0");
    }
  };
  walk("");
  return hash.digest("hex");
}

test("a target suite's git never reaches the caller's repository (#1670)", async () => {
  const root = mkdtempSync(join(tmpdir(), "code-roi-git-env-"));
  const saved = { ...process.env };
  try {
    const decoy = join(root, "decoy");
    mkdirSync(decoy);
    git(decoy, "init", "-q");
    writeFileSync(join(decoy, "a.txt"), "one\n");
    git(decoy, "add", "a.txt");
    git(decoy, "commit", "-qm", "decoy");
    writeFileSync(join(decoy, "a.txt"), "one\nuncommitted\n");

    const target = join(root, "target");
    mkdirSync(join(target, "tests"), { recursive: true });
    writeFileSync(
      join(target, "package.json"),
      `{ "name": "git-env-fixture", "private": true, "scripts": { "test": "node --test tests/*.test.js" } }\n`
    );
    writeFileSync(join(target, "tests", "git.test.js"), SUITE);
    git(target, "init", "-q");

    const before = fingerprint(decoy);
    Object.assign(process.env, {
      GIT_DIR: join(realpathSync(decoy), ".git"),
      GIT_WORK_TREE: realpathSync(decoy),
      GIT_INDEX_FILE: join(realpathSync(decoy), ".git", "index"),
    });
    const run = await runSuite(target, detectRunner(target), { timeoutMs: 60_000 });

    assert.equal(run.status, "ok", run.detail ?? "");
    assert.deepEqual([...run.cases.values()], ["pass"], "git in the suite stayed in its own checkout");
    assert.equal(fingerprint(decoy), before, "the caller's repository is byte-identical");
  } finally {
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});
