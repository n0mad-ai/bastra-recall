import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneRepoRoot, repoRootSync, clearRepoRootCache } from "../src/code-graph/git-paths.js";

/**
 * Which repository a Write/Edit lane call belongs to (#577).
 *
 * The lane used to anchor on the session's `cwd`, which is right only when the
 * agent sits at the repository root. Editing a file from a subdirectory found
 * no graph and the feature silently did nothing — the failure a user reads as
 * "it just doesn't work". These tests hold the rule that the FILE decides.
 */

let root: string;
let repo: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "bastra-lane-anchor-"));
  repo = join(root, "repo");
  await mkdir(join(repo, "packages", "core", "src"), { recursive: true });
  // A real checkout marker; `.git` as a DIRECTORY here.
  await mkdir(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, "packages", "core", "src", "save.ts"), "export {};\n", "utf8");
  clearRepoRootCache();
});

after(async () => {
  clearRepoRootCache();
  await rm(root, { recursive: true, force: true });
});

describe("lane anchor: the file decides, not the working directory", () => {
  it("resolves the checkout root from a file deep in the tree", () => {
    const file = join(repo, "packages", "core", "src", "save.ts");
    // This is the case that was broken: cwd is the package, not the checkout.
    assert.equal(laneRepoRoot(file, join(repo, "packages", "core")), repo);
  });

  it("resolves the same root when cwd IS the repository root", () => {
    const file = join(repo, "packages", "core", "src", "save.ts");
    assert.equal(laneRepoRoot(file, repo), repo);
  });

  it("ignores a cwd that points at an entirely different place", () => {
    const file = join(repo, "packages", "core", "src", "save.ts");
    assert.equal(laneRepoRoot(file, "/tmp"), repo);
  });

  it("falls back to cwd when the file is in no repository", () => {
    // Preserves the previous behaviour instead of turning a working case into
    // a null: an anchor is only ever a lookup key.
    const stray = join(root, "not-a-repo", "file.ts");
    assert.equal(laneRepoRoot(stray, "/some/cwd"), "/some/cwd");
  });

  it("falls back to cwd for an empty file path", () => {
    assert.equal(laneRepoRoot("", "/some/cwd"), "/some/cwd");
  });

  it("finds a worktree, where .git is a FILE and not a directory", async () => {
    const wt = join(root, "worktree");
    await mkdir(join(wt, "src"), { recursive: true });
    await writeFile(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`, "utf8");
    await writeFile(join(wt, "src", "a.ts"), "export {};\n", "utf8");
    clearRepoRootCache();
    // An `isDirectory()` check would miss this entirely.
    assert.equal(laneRepoRoot(join(wt, "src", "a.ts"), "/tmp"), wt);
  });

  it("caches misses as well as hits", () => {
    clearRepoRootCache();
    const outside = join(root, "nowhere");
    assert.equal(repoRootSync(outside), null);
    assert.equal(repoRootSync(outside), null);
  });
});
