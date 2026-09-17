/**
 * Git path resolution for the code graph (#574, #581).
 *
 * WHY THIS FILE EXISTS AT ALL. The original plan watched `<repo>/.git/HEAD`
 * and `<repo>/.git/refs` to notice a commit, a checkout or a pull. That is
 * wrong in exactly the setup the issues promise to support: in a LINKED
 * WORKTREE `<repo>/.git` is a FILE, not a directory — one line of
 * `gitdir: /path/to/main/.git/worktrees/<name>` — so every hard-coded
 * `<repo>/.git/...` path resolves to nothing, the watcher silently never
 * fires, and the graph of the worktree quietly rots. Nothing errors; the
 * feature just stops working, which is the worst failure shape available.
 *
 * Worse, the two paths do not even live in the same place. Measured on this
 * repo's own linked worktree (git 2.39):
 *
 *   --git-dir          .../main/.git/worktrees/wt-a      (worktree-private)
 *   --git-common-dir   .../main/.git                     (shared)
 *   --git-path HEAD    .../main/.git/worktrees/wt-a/HEAD (private — per worktree)
 *   --git-path refs    .../main/.git/refs                (shared — common dir)
 *
 * So a single "the git dir" does not exist, and joining `HEAD` and `refs`
 * onto the same base is wrong for one of them whichever base is picked. Git
 * answers the question itself, per path, and that is the only answer that
 * stays right across plain clones, linked worktrees, submodules, `GIT_DIR`
 * overrides and whatever git does next. So every path here goes through
 * `git rev-parse`, and no caller is given a way to guess one.
 *
 * NOTHING HERE THROWS. Not being in a git repo is a normal state (#574: the
 * manifest's `commit` is `null` outside one), git may be missing from PATH,
 * and a hung git on a network filesystem must not hang the daemon. Every call
 * is bounded by a timeout and reports failure as `null`, because a code graph
 * that cannot answer "which commit" is still a usable code graph.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, resolve } from "node:path";

const run = promisify(execFile);

/**
 * Upper bound for one `git rev-parse`. Measured locally at 4-9 ms; 5 s is
 * three orders of magnitude of headroom and still bounds the pathological
 * case (a repo on an unreachable network mount) that would otherwise wedge
 * the refresh coordinator.
 */
export const GIT_TIMEOUT_MS = 5_000;

/** The git paths a refresh watcher needs. Any of them may be null. */
export interface GitWatchPaths {
  /** The worktree's own HEAD — moves on commit, checkout, merge, pull. */
  head: string | null;
  /** The refs directory. In a worktree this is usually the COMMON dir's. */
  refs: string | null;
  /** `packed-refs`: a fetch or gc rewrites refs here instead of under refs/. */
  packedRefs: string | null;
}

/**
 * One `git rev-parse` with the repo as cwd. Returns the trimmed first line,
 * or null for "git said no" — which covers a non-repo, a missing git binary,
 * a timeout and an empty answer alike. The caller cannot act differently on
 * those, so they are deliberately not distinguished.
 */
async function git(repoRoot: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", [...args], {
      cwd: repoRoot,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const first = stdout.split("\n", 1)[0]?.trim() ?? "";
    return first === "" ? null : first;
  } catch {
    return null;
  }
}

/** True only when `repoRoot` is inside a git WORK TREE (not a bare repo). */
export async function isGitRepo(repoRoot: string): Promise<boolean> {
  return (await git(repoRoot, ["rev-parse", "--is-inside-work-tree"])) === "true";
}

/**
 * The absolute path git reports for `name`, e.g. `HEAD`, `refs`, `index`.
 *
 * `git rev-parse --git-path` answers relative to the CWD on the git versions
 * that ship on macOS and on older Linux distributions, and absolute on newer
 * ones. Both are resolved against `repoRoot` here, so callers get an absolute
 * path either way and no watcher ends up registered on a relative path that
 * happens to resolve against the daemon's own working directory.
 */
export async function gitPath(repoRoot: string, name: string): Promise<string | null> {
  const p = await git(repoRoot, ["rev-parse", "--git-path", name]);
  if (p === null) return null;
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

/**
 * The shared git directory. In a linked worktree this is the MAIN repo's
 * `.git`, not the worktree's private one — that difference is the whole
 * reason this is a separate call and not `join(repoRoot, ".git")`.
 */
export async function gitCommonDir(repoRoot: string): Promise<string | null> {
  const p = await git(repoRoot, ["rev-parse", "--git-common-dir"]);
  if (p === null) return null;
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

/**
 * `git rev-parse HEAD`, or null outside a repo and on an unborn branch (a
 * fresh `git init` has a HEAD that points at a ref with no commit).
 *
 * The answer is checked to be a full object name before it is handed back:
 * it ends up verbatim in the manifest and is cross-checked against the
 * graph's own `built_at_commit`, and a stray line of git output in that field
 * would turn a comparison into a false "stale".
 */
export async function headCommit(repoRoot: string): Promise<string | null> {
  const c = await git(repoRoot, ["rev-parse", "HEAD"]);
  return c !== null && /^[0-9a-f]{40}$/.test(c) ? c : null;
}

/** The repository root git itself reports for a directory, or null. */
export async function repoRootOf(dir: string): Promise<string | null> {
  return git(dir, ["rev-parse", "--show-toplevel"]);
}

/**
 * The paths whose change means "the checkout moved" (#581, trigger 2).
 *
 * All three are resolved through git, and `packed-refs` is included because a
 * `git fetch` or `git gc` can move branch tips without touching a single file
 * under `refs/` — watching `refs` alone misses exactly the pull case the
 * trigger is named after.
 */
export async function gitWatchPaths(repoRoot: string): Promise<GitWatchPaths> {
  const [head, refs, packedRefs] = await Promise.all([
    gitPath(repoRoot, "HEAD"),
    gitPath(repoRoot, "refs"),
    gitPath(repoRoot, "packed-refs"),
  ]);
  return { head, refs, packedRefs };
}

/**
 * The repository root for a directory — SYNCHRONOUSLY, cached, no process.
 *
 * Everything above spawns `git`, which the hook lanes must not do. The
 * PreToolUse Write/Edit lane runs at p50 49 ms / p90 87 ms against a 200 ms
 * target (`hook-budgets.ts`), and one `git rev-parse` is a process start plus,
 * in the bad case, a 5 s timeout — an order of magnitude over the whole budget
 * for a question that is answered by a few `existsSync` calls.
 *
 * Without this the lane used the hook payload's `cwd` as the repository
 * anchor, so an edit made from `packages/daemon/` looked for a graph at
 * `packages/daemon/graphify-out/` and quietly found none. The graph exists;
 * the anchor was wrong.
 *
 * `.git` IS TESTED FOR EXISTENCE, NOT FOR BEING A DIRECTORY. In a linked
 * worktree and in a submodule it is a FILE, and an `isDirectory()` test walks
 * straight past exactly the setup #574 promises to support — the same trap the
 * async helpers above exist to avoid. The worktree's own root is the right
 * answer here: each worktree has its own checkout and therefore its own graph.
 *
 * The cache is process-local and unbounded in principle, bounded in practice
 * by the number of directories a session edits in; a directory does not change
 * which repository it belongs to while the daemon runs. It mirrors
 * `detectProjectDetailed()` in `packages/core/src/topics.ts`, which solved the
 * same problem for project detection.
 */
export function repoRootSync(startDir: string): string | null {
  if (startDir === "") return null;
  const cached = rootCache.get(startDir);
  if (cached !== undefined) return cached;
  const found = findRepoRoot(startDir);
  // Misses are cached too: a directory outside any repository is asked about
  // just as often as one inside, and re-walking to the filesystem root every
  // time is the expensive half of this lookup.
  rootCache.set(startDir, found);
  return found;
}

/** The repository root a file belongs to, synchronously. */
export function repoRootOfFileSync(filePath: string): string | null {
  return filePath === "" ? null : repoRootSync(dirname(resolve(filePath)));
}

/** For tests, and for anything that moves a checkout under a running daemon. */
export function clearRepoRootCache(): void {
  rootCache.clear();
}

const rootCache = new Map<string, string | null>();

/** Upper bound on the walk — a path this deep is a symlink loop, not a repo. */
const MAX_WALK_DEPTH = 64;

function findRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    // File OR directory: a worktree's `.git` is a file.
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
