/**
 * The per-repo graph cache, its heap budget, and the cold-start rule (#575).
 *
 * Two findings from the pre-build counter-review are implemented here.
 *
 * COLD START. A first access costs 20-26 ms (read + parse + index) against a
 * hook that may add ~10 ms. So `get()` NEVER blocks: it answers from memory or
 * it answers `null` and kicks off the load. A hook that arrives cold emits no
 * code block at all — silently. This is the whole reason the reader is split
 * from the cache: the load is async, the lookup is not.
 *
 * MEMORY. Several enabled repositories with no ceiling grow the daemon without
 * bound; one graph of this repo costs ~20 MB of heap. So the cache holds a
 * daemon-wide byte budget and evicts least-recently-used repositories when it
 * is exceeded.
 *
 * Heap is charged at the graph's FILE size. It is an approximation — measured,
 * the indexes cost roughly twice the file — but it is a stable, observable
 * number, and a budget computed from `process.memoryUsage()` would move under
 * GC and make eviction unreproducible in a test. The budget is therefore
 * deliberately conservative rather than exact.
 */

import { stat } from "node:fs/promises";
import { loadGraph, graphFileOf, type LoadedGraph } from "./reader.js";
import { MAX_TOTAL_HEAP_BYTES } from "./limits.js";
import type { RejectReason } from "./validate.js";

/** What the cache knows about one repository. */
export interface RepoState {
  /** Loaded and usable, or null while cold / loading / degraded. */
  graph: LoadedGraph | null;
  /** Set while a load is in flight, so two hooks do not load the same file. */
  loading: Promise<void> | null;
  /** Why the last load failed, or null. Surfaced in `bastra doctor`. */
  degraded: RejectReason | null;
  /** Monotonic counter for LRU ordering. */
  lastUsed: number;
}

export interface CacheStats {
  repos: number;
  loadedRepos: number;
  bytes: number;
  budgetBytes: number;
  degraded: Array<{ repoRoot: string; reason: RejectReason }>;
}

/**
 * Holds the graphs of the enabled repositories.
 *
 * Deliberately not a singleton: tests build their own, and the daemon owns one
 * instance next to its other long-lived services.
 */
export class CodeGraphCache {
  private readonly repos = new Map<string, RepoState>();
  private tick = 0;

  constructor(
    private readonly budgetBytes: number = MAX_TOTAL_HEAP_BYTES,
    /**
     * Whether a repository may be served at all (#585). The daemon's shared
     * cache passes the enabled list plus the kill switch; a cache a test builds
     * for itself serves whatever it is pointed at. Checked on every `get()`, so
     * `bastra code disable` takes effect on the next call, not the next restart.
     */
    private readonly allow: (repoRoot: string) => boolean = () => true,
  ) {}

  /**
   * The graph for a repository IF it is already in memory, else null plus a
   * background load. Never awaits the load — see the cold-start rule above.
   *
   * A caller that gets `null` must behave as if code awareness did not exist
   * for this call. It must not wait, retry in a loop, or tell the user
   * anything: the next call will have it.
   */
  get(repoRoot: string): LoadedGraph | null {
    if (!this.allow(repoRoot)) {
      // Disabled: drop the graph too, so a disabled repository does not keep
      // ~20 MB of heap for a feature that is switched off.
      if (this.repos.has(repoRoot)) this.forget(repoRoot);
      return null;
    }
    const state = this.repos.get(repoRoot);
    if (state?.graph != null) {
      state.lastUsed = ++this.tick;
      return state.graph;
    }
    if (state?.degraded != null) return null;
    void this.ensureLoaded(repoRoot);
    return null;
  }

  /** Whether this cache serves the repository at all — see `allow`. */
  allows(repoRoot: string): boolean {
    return this.allow(repoRoot);
  }

  /**
   * Load a repository's graph if it is not loaded and not already loading.
   * Called on enable and on daemon start to preload, and by `get()` on a miss.
   * Resolves when the graph is available or has been marked degraded; it never
   * rejects.
   */
  async ensureLoaded(repoRoot: string): Promise<void> {
    const existing = this.repos.get(repoRoot);
    if (existing?.graph != null) return;
    if (existing?.loading != null) return existing.loading;

    const state: RepoState = existing ?? {
      graph: null,
      loading: null,
      degraded: null,
      lastUsed: ++this.tick,
    };
    this.repos.set(repoRoot, state);

    const run = (async () => {
      const result = await loadGraph(repoRoot);
      if (result.ok) {
        state.graph = result.graph;
        state.degraded = null;
        state.lastUsed = ++this.tick;
      } else {
        state.graph = null;
        state.degraded = result.reason;
      }
      state.loading = null;
      this.evictIfOverBudget();
    })();
    state.loading = run;
    return run;
  }

  /**
   * Swap in the graph on disk if it is not the one in memory (#583).
   *
   * Called after every successful build and on the daemon's periodic check.
   * Before, nothing called it: a refresh rewrote `graph.json` and every reader
   * went on answering from the graph loaded at start, until the daemon was
   * restarted — the refresh was real, and invisible.
   *
   * The old graph keeps serving while the new one parses; the swap is one
   * assignment. Dropping first and loading lazily would make every hook and
   * `find_code` call in those ~25 ms answer "unavailable" after each build.
   * A repository nobody has asked about yet is left alone — its first `get()`
   * loads the current file anyway.
   */
  async reloadIfChanged(repoRoot: string): Promise<boolean> {
    const state = this.repos.get(repoRoot);
    if (state === undefined) return false;
    if (state.loading !== null) await state.loading;
    if (state.graph !== null) {
      try {
        const st = await stat(graphFileOf(repoRoot));
        if (st.mtimeMs === state.graph.mtimeMs && st.size === state.graph.sizeBytes) return false;
      } catch {
        // Gone: fall through, the load below marks it degraded.
      }
    }
    const result = await loadGraph(repoRoot);
    if (this.repos.get(repoRoot) !== state) return false; // forgotten meanwhile
    if (result.ok) {
      state.graph = result.graph;
      state.degraded = null;
      state.lastUsed = ++this.tick;
      this.evictIfOverBudget();
    } else {
      state.graph = null;
      state.degraded = result.reason;
    }
    return true;
  }

  /** Forget a repository entirely — on disable, or on uninstall. */
  forget(repoRoot: string): void {
    this.repos.delete(repoRoot);
  }

  /** What `bastra doctor` reports. */
  /**
   * Is a load for this repository actually in flight? The honest answer to
   * "why is there nothing yet" depends on it: a graph that is being read WILL
   * be there next call, and one that was never built never will (#582).
   */
  isLoading(repoRoot: string): boolean {
    return this.repos.get(repoRoot)?.loading != null;
  }

  stats(): CacheStats {
    const degraded: Array<{ repoRoot: string; reason: RejectReason }> = [];
    let bytes = 0;
    let loadedRepos = 0;
    for (const [repoRoot, s] of this.repos) {
      if (s.graph != null) {
        bytes += s.graph.sizeBytes;
        loadedRepos++;
      }
      if (s.degraded != null) degraded.push({ repoRoot, reason: s.degraded });
    }
    return { repos: this.repos.size, loadedRepos, bytes, budgetBytes: this.budgetBytes, degraded };
  }

  /**
   * Evict least-recently-used graphs until the budget holds.
   *
   * The most recently loaded graph is never evicted, even alone over budget:
   * evicting it would mean loading it again on the very next call, forever.
   * A single graph too large to hold is refused earlier, by the file-size
   * limit in the reader.
   */
  private evictIfOverBudget(): void {
    let total = 0;
    const loaded: Array<[string, RepoState]> = [];
    for (const entry of this.repos) {
      if (entry[1].graph != null) {
        total += entry[1].graph.sizeBytes;
        loaded.push(entry);
      }
    }
    if (total <= this.budgetBytes || loaded.length <= 1) return;

    loaded.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [, state] of loaded.slice(0, -1)) {
      if (total <= this.budgetBytes) break;
      if (state.graph == null) continue;
      total -= state.graph.sizeBytes;
      state.graph = null;
    }
  }
}
