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
import { CodeGraphRefresher, needsReconcile, type RefreshEvent } from "./refresh.js";
import { shortRepo } from "./unavailable-note.js";
import { gitWatchPaths } from "./git-paths.js";
import { enabledRepos, isRepoEnabledSync } from "./enabled-repos.js";
import { codeGraphCache } from "./dependents-block.js";
import { GRAPH_DIR_NAME } from "./reader.js";

/** Directory names whose subtrees never trigger a refresh. */
const IGNORED_SEGMENTS = new Set([GRAPH_DIR_NAME, ".git", "node_modules", "dist", "build"]);

/**
 * The process-wide refresher. One per daemon, like the graph cache — two would
 * each think they hold single flight, which is the same failure as no single
 * flight at all.
 *
 * Wired to the shared cache (#583): a successful build swaps the new graph in
 * for every reader, and a repository that is no longer enabled is not built
 * (#585).
 */
let refresher: CodeGraphRefresher | null = null;
export function codeGraphRefresher(): CodeGraphRefresher {
  refresher ??= new CodeGraphRefresher({
    onBuilt: (repoRoot) => codeGraphCache().reloadIfChanged(repoRoot),
    allow: (repoRoot) => isRepoEnabledSync(repoRoot),
    onEvent: reportRefresh,
  });
  return refresher;
}

// ─── Refresh telemetry (#589) ────────────────────────────────────

/**
 * How long a repository was behind: wall clock from the `started` row to the
 * terminal one. Measured HERE rather than inside the builder because that is
 * the span the freshness question asks about — a run that waited on a lock was
 * behind for that time too, and the build's own duration does not say so.
 */
const startedAt = new Map<string, number>();

/**
 * Where refresh rows go. Set by the daemon (`daemon-jobs.ts`) once telemetry
 * exists; unset everywhere else, so a test or a CLI that touches the refresher
 * writes nothing at all.
 */
export type RefreshObserver = (event: CodeGraphRefreshRow) => void;

export interface CodeGraphRefreshRow {
  repo: string;
  reason: string;
  outcome: RefreshEvent["outcome"];
  detail?: string;
  duration_ms?: number;
  external_total?: number;
  external_resolved?: number;
}

let refreshObserver: RefreshObserver | null = null;
export function observeCodeGraphRefresh(fn: RefreshObserver | null): void {
  refreshObserver = fn;
}

/**
 * The bounded set of reasons a refresh row may carry, and nothing else (#582
 * review).
 *
 * `RefreshEvent.detail` is free text assembled upstream: `graphify-missing:
 * /Users/<name>/.bastra/bin/graphify`, `locked: /Users/<name>/Projekte/<repo>/
 * .bastra-code`, and — the one that decided this — `failed: exit code 1:` plus
 * Graphify's whole stderr. The event type had said "never a path or a command
 * line" since it was written; the observer passed it through anyway, so home
 * directory, repository layout and whatever a third-party binary chose to
 * print all landed in telemetry. The repository name is already carried by
 * `repo`, deliberately as its last two segments.
 *
 * So the text is mapped to a code and never forwarded. An unrecognised detail
 * becomes `other` rather than itself: a classifier that falls back to the raw
 * string is a classifier that leaks exactly the cases nobody anticipated.
 */
export function detailCode(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  if (/^not enabled$/.test(detail)) return "not_enabled";
  if (/^given up$/.test(detail)) return "given_up";
  if (/unsupported-platform/.test(detail)) return "unsupported_platform";
  if (/graphify-missing/.test(detail)) return "binary_missing";
  // Checked BEFORE `timeout`: `build.ts` folds the reason that led to the kill
  // into a stuck detail's own text (`stuck: no result after 600000 ms: child
  // still running …`), so a plain substring match on "no result after" would
  // read a stuck build as a timed-out one and hide that the lock was left in
  // place on purpose (P2, #582 review).
  if (/^stuck:/.test(detail)) return "stuck";
  if (/timeout|no result after/.test(detail)) return "timeout";
  if (/^locked|failed: locked/.test(detail)) return "locked";
  if (/\baborted\b/.test(detail)) return "aborted";
  const killed = /killed by (SIG[A-Z]+)/.exec(detail);
  if (killed !== null) return `graphify_killed_${killed[1].toLowerCase()}`;
  const exit = /exit code (-?\d+)/.exec(detail);
  if (exit !== null) return `graphify_exit_${exit[1]}`;
  return "other";
}

function reportRefresh(event: RefreshEvent): void {
  if (event.outcome === "started") {
    startedAt.set(event.repoRoot, Date.now());
  }
  if (refreshObserver === null) {
    if (event.outcome !== "started") startedAt.delete(event.repoRoot);
    return;
  }
  const began = startedAt.get(event.repoRoot);
  if (event.outcome !== "started") startedAt.delete(event.repoRoot);
  // `external nodes / resolved` is what `bastra doctor` prints per repository
  // and the one number that goes quiet when Graphify changes its id spelling
  // (#582). Carried on a successful build, where it has just been re-derived.
  const stats =
    event.outcome === "ok" ? (codeGraphCache().get(event.repoRoot)?.externalStats ?? null) : null;
  const detail = detailCode(event.detail);
  try {
    refreshObserver({
      repo: shortRepo(event.repoRoot),
      reason: event.reason,
      outcome: event.outcome,
      ...(detail !== undefined ? { detail } : {}),
      ...(event.outcome !== "started" && began !== undefined
        ? { duration_ms: Date.now() - began }
        : {}),
      ...(stats !== null
        ? { external_total: stats.total, external_resolved: stats.resolved }
        : {}),
    });
  } catch {
    /* a refresh must never fail because nobody could write it down */
  }
}

/**
 * How often the running daemon re-reads the enabled list and checks each
 * graph file for a rebuild it did not run itself (#583, #585).
 *
 * Before, the list was read once at boot: `bastra code enable` started nothing
 * and `bastra code disable` stopped nothing until a restart, and a graph built
 * by `bastra code index` in a terminal was never picked up. A few seconds is
 * the same order as the refresh debounce; each tick costs one settings read
 * and one `stat` per enabled repository.
 */
export const SYNC_INTERVAL_MS = 5_000;

/** Watchers per repository, so one repository can be stopped on its own. */
const watchers = new Map<string, FSWatcher[]>();

export interface CodeAwarenessHandle {
  /** Repositories the service took on at start. */
  repos: string[];
  /** Stop every watcher and timer. Idempotent. */
  stop: () => void;
}

/**
 * Start code awareness for every enabled repository, and keep following the
 * enabled list while the daemon runs.
 *
 * Never throws and never blocks the caller: a daemon must boot even if a
 * repository moved, a graph is corrupt or a watcher cannot be installed. Each
 * repository is independent — one failing does not stop the others.
 */
export async function startCodeAwareness(
  onEvent?: (line: string) => void,
  /**
   * Which repositories to start for. Injectable so a test states its own
   * world instead of reading the machine's: this used to call `enabledRepos()`
   * unconditionally, so the test asserting "does nothing when none is enabled"
   * passed in CI and failed on any machine where someone had actually switched
   * the feature on. A test that depends on the developer's configuration tests
   * the configuration.
   */
  repoList: () => Promise<string[]> = enabledRepos,
  syncIntervalMs: number = SYNC_INTERVAL_MS,
): Promise<CodeAwarenessHandle> {
  let stopped = false;
  const sync = async (): Promise<void> => {
    let wanted: Set<string>;
    try {
      wanted = new Set(await repoList());
    } catch {
      return; // an unreadable list changes nothing this tick
    }
    if (stopped) return;
    for (const repoRoot of wanted) {
      if (!watchers.has(repoRoot)) startRepo(repoRoot, onEvent);
      // Picks up a graph built by another process (`bastra code index`).
      void codeGraphCache()
        .reloadIfChanged(repoRoot)
        .catch(() => {});
    }
    for (const repoRoot of [...watchers.keys()]) {
      if (!wanted.has(repoRoot)) stopRepo(repoRoot);
    }
  };

  await sync();
  const repos = [...watchers.keys()];
  const timer = setInterval(() => void sync(), syncIntervalMs);
  timer.unref?.();

  return {
    repos,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      for (const repoRoot of [...watchers.keys()]) closeWatchers(repoRoot);
      codeGraphRefresher().stop();
    },
  };
}

function startRepo(repoRoot: string, onEvent?: (line: string) => void): void {
  watchers.set(repoRoot, []);
  const refresh = codeGraphRefresher();

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

/** Disabled while running: no watcher, no graph in memory (#585). */
function stopRepo(repoRoot: string): void {
  closeWatchers(repoRoot);
  codeGraphCache().forget(repoRoot);
}

function closeWatchers(repoRoot: string): void {
  for (const w of watchers.get(repoRoot) ?? []) {
    try {
      w.close();
    } catch {
      /* a watcher that is already gone needs no closing */
    }
  }
  watchers.delete(repoRoot);
}

function track(repoRoot: string, w: FSWatcher): void {
  const list = watchers.get(repoRoot);
  // Stopped while an async watch was being set up: close it right away.
  if (list === undefined) w.close();
  else list.push(w);
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
    track(repoRoot, w);
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
      track(repoRoot, w);
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
