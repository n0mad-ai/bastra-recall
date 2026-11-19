/**
 * A git test file started on its own, without `scripts/test-env.mjs` (#1669).
 *
 * test-env drops a caller's GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE (#1668), but
 * only in processes that load it. `node --import tsx --test <file>` does not,
 * and git-archive.test.ts then ran its fixtures' git — `reset --hard` among
 * them — against the caller's repository. Every git test file now drops them
 * itself (`scripts/caller-git-env.mjs`). The caller here is a freshly created
 * decoy repository, compared byte for byte.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs script, no declarations
import { dropCallerGitEnv } from "../../../scripts/caller-git-env.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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

test("a git test file run without test-env leaves the caller's repository byte-identical (#1669)", () => {
  const decoy = realpathSync(mkdtempSync(join(tmpdir(), "git-decoy-")));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=d", "-c", "user.email=d@example.invalid", ...args], {
        cwd: decoy,
        env: dropCallerGitEnv({ ...process.env }),
        stdio: "ignore",
      });
    git("init", "-q");
    writeFileSync(join(decoy, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-qm", "decoy");
    writeFileSync(join(decoy, "a.txt"), "one\nuncommitted\n");
    const before = fingerprint(decoy);

    // This process's environment (run home, temp root) minus test-env itself:
    // no `--import scripts/test-env.mjs`, and the caller's git variables on top.
    const { NODE_TEST_CONTEXT: _child, ...env } = process.env;
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", "--test", "--test-concurrency=1", "packages/daemon/__tests__/git-archive.test.ts"],
      {
        cwd: REPO,
        encoding: "utf8",
        timeout: 300_000,
        env: {
          ...env,
          GIT_DIR: join(decoy, ".git"),
          GIT_WORK_TREE: decoy,
          GIT_INDEX_FILE: join(decoy, ".git", "index"),
        },
      }
    );

    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.slice(-4000));
    assert.equal(fingerprint(decoy), before, "the caller's repository is byte-identical");
  } finally {
    rmSync(decoy, { recursive: true, force: true });
  }
});
