/**
 * The daemon-side code-awareness service: preload, startup reconciliation and
 * the file and git watchers (#581).
 *
 * The pieces existed after #574/#575/#581 but nothing started them. This is
 * the wiring, and it is deliberately one module so that "who starts the code
 * graph" has a single answer.
 *
 * WHY `fs.watch` AND NOT CHOKIDAR. The vault watcher uses chokidar, but that
 * dependency lives in `@bastra-recall/core`, not here, and adding a runtime
 * dependency to the daemon is a decision with a blast radius (package size,
 * audit surface) that this change has no mandate to take. `fs.watch` with
 * `recursive: true` covers macOS and Linux, which is this sub-release's entire
 * scope (C-094), and Node >= 22 is already required.
 *
 * The reliability gap that buys is affordable HERE, and only here, because the
 * watcher is not the only trigger: git events, the Stop hook and startup
 * reconciliation all enqueue the same refresh, and a missed event costs
 * freshness, never correctness — a graph that fell behind is marked stale by
 * the manifest and the Write/Edit block says so (C-092). The vault watcher has
 * no such backstop, which is why it needs chokidar and this does not.
 *
 * WHY THE WATCHER IS COARSE. It does not try to decide which files matter.
 * `extract --code-only` re-walks the tree anyway and costs ~2 s incrementally,
 * so a precise filter would spend more effort than it saves. What it does
 * filter is noise that would otherwise retrigger forever: the graph directory
 * itself (the build writes there — watching it would be a refresh loop) and
 * `.git`, `node_modules` and dot-directories.
 */

import { watch, type FSWatcher } from "node:fs";
import { relative, sep } from "node:path";
import { CodeGraphRefresher, needsReconcile } from "./refresh.js";
import { gitWatchPaths } from "./git-paths.js";
import { enabledRepos } from "./enabled-repos.js";
import { codeGraphCache } from "./dependents-block.js";
import { GRAPH_DIR_NAME } from "./reader.js";

/** Directory names whose subtrees never trigger a refresh. */
const IGNORED_SEGMENTS = new Set([GRAPH_DIR_NAME, ".git", "node_modules", "dist", "build"]);

/**
 * The process-wide refresher. One per daemon, like the graph cache — two would
 * each think they hold single flight, which is the same failure as no single
 * flight at all.
 */
let refresher: CodeGraphRefresher | null = null;
export function codeGraphRefresher(): CodeGraphRefresher {
  refresher ??= new CodeGraphRefresher();
  return refresher;
}

const watchers: FSWatcher[] = [];

export interface CodeAwarenessHandle {
  /** Repositories the service actually took on. */
  repos: string[];
  /** Stop every watcher and timer. Idempotent. */
  stop: () => void;
}

/**
 * Start code awareness for every enabled repository.
 *
 * Never throws and never blocks the caller: a daemon must boot even if a
 * repository moved, a graph is corrupt or a watcher cannot be installed. Each
 * repository is independent — one failing does not stop the others.
 */
export async function startCodeAwareness(
  onEvent?: (line: string) => void,
): Promise<CodeAwarenessHandle> {
  const repos = await enabledRepos();
  if (repos.length === 0) return { repos: [], stop: () => {} };

  const refresh = codeGraphRefresher();

  for (const repoRoot of repos) {
    // Preload, so the first Write/Edit in this repository is warm rather than
    // paying the 20-26 ms cold start inside the hook (C-092). Not awaited:
    // boot does not wait for ~20 MB of parsing per repository.
    void codeGraphCache()
      .ensureLoaded(repoRoot)
      .catch(() => {});

    // Startup reconciliation: the on-disk `dirty` flag, or a file newer than
    // the build, means the daemon died mid-build or the tree moved while it
    // was down. Exactly one refresh either way.
    void needsReconcile(repoRoot)
      .then((needed) => {
        if (needed) refresh.enqueue(repoRoot, "startup");
      })
      .catch(() => {});

    watchRepo(repoRoot, refresh, onEvent);
    void watchGit(repoRoot, refresh, onEvent);
  }

  return {
    repos,
    stop: () => {
      for (const w of watchers.splice(0)) {
        try {
          w.close();
        } catch {
          /* a watcher that is already gone needs no closing */
        }
      }
      refresh.stop();
    },
  };
}

/**
 * Watch the working tree. Every change enqueues one debounced refresh; the
 * refresher collapses a burst into a single run and at most one follow-up.
 */
function watchRepo(
  repoRoot: string,
  refresh: CodeGraphRefresher,
  onEvent?: (line: string) => void,
): void {
  try {
    const w = watch(repoRoot, { recursive: true, persistent: false }, (_event, filename) => {
      if (filename !== null && isIgnored(filename.toString())) return;
      refresh.enqueue(repoRoot, "watcher");
    });
    w.on("error", () => {
      // A watcher that dies takes freshness with it, not correctness: the
      // other three triggers still fire and a stale graph still says so.
      onEvent?.(`code-graph: file watcher stopped for ${repoRoot}`);
    });
    watchers.push(w);
  } catch {
    onEvent?.(`code-graph: could not watch ${repoRoot}`);
  }
}

/**
 * Watch HEAD, the refs and `packed-refs`, so a commit, checkout, merge or pull
 * refreshes immediately rather than after the debounce — a branch switch
 * changes far more than an edit does.
 *
 * The paths come from `git rev-parse`, never from `<repo>/.git/...`: in a
 * linked worktree `.git` is a file, and the refs may live in the common dir
 * shared with the main checkout.
 */
async function watchGit(
  repoRoot: string,
  refresh: CodeGraphRefresher,
  onEvent?: (line: string) => void,
): Promise<void> {
  let paths: string[];
  try {
    const p = await gitWatchPaths(repoRoot);
    // `packed-refs` is watched too: a fetch or a gc rewrites refs THERE rather
    // than under refs/, so watching only the directory misses exactly the
    // updates that follow a pull.
    paths = [p.head, p.refs, p.packedRefs].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
  } catch {
    return; // not a git repository, or git is unavailable — the file watcher covers it
  }

  for (const path of paths) {
    try {
      const w = watch(path, { persistent: false }, () => {
        refresh.enqueue(repoRoot, "git");
      });
      w.on("error", () => onEvent?.(`code-graph: git watcher stopped for ${repoRoot}`));
      watchers.push(w);
    } catch {
      /* a ref path that cannot be watched is not worth failing the boot for */
    }
  }
}

/**
 * Is this relative path inside a directory we never refresh for?
 *
 * Only DIRECTORY segments are filtered — every segment but the last, plus the
 * last one when it names an ignored directory itself. The distinction matters:
 * a dot-directory like `.git` or `.obsidian` is noise, but a dot-FILE is not.
 * `.gitignore` changing genuinely changes what gets indexed, and filtering it
 * by the same rule would drop exactly the edit that should trigger a rebuild.
 */
export function isIgnored(relativePath: string): boolean {
  const segments = relativePath.split(/[/\\]/).filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  const last = segments[segments.length - 1]!;
  if (IGNORED_SEGMENTS.has(last)) return true;
  return segments
    .slice(0, -1)
    .some((s) => IGNORED_SEGMENTS.has(s) || (s.startsWith(".") && s !== "." && s !== ".."));
}

/**
 * Enqueue a refresh for the repository a path belongs to, if it is enabled.
 * The Stop hook's entry point: it enqueues and returns, and never waits for a
 * build (#581) — a multi-second build inside the Stop hook is a latency
 * regression by construction.
 */
export async function enqueueForPath(absolutePath: string): Promise<boolean> {
  const repos = await enabledRepos();
  const match = repos.find((repo) => absolutePath === repo || absolutePath.startsWith(repo + sep));
  if (match === undefined) return false;
  if (isIgnored(relative(match, absolutePath))) return false;
  codeGraphRefresher().enqueue(match, "stop-hook");
  return true;
}
