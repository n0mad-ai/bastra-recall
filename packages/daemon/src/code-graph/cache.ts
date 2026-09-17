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

  constructor(private readonly budgetBytes: number = MAX_TOTAL_HEAP_BYTES) {}

  /**
   * The graph for a repository IF it is already in memory, else null plus a
   * background load. Never awaits the load — see the cold-start rule above.
   *
   * A caller that gets `null` must behave as if code awareness did not exist
   * for this call. It must not wait, retry in a loop, or tell the user
   * anything: the next call will have it.
   */
  get(repoRoot: string): LoadedGraph | null {
    const state = this.repos.get(repoRoot);
    if (state?.graph != null) {
      state.lastUsed = ++this.tick;
      return state.graph;
    }
    if (state?.degraded != null) return null;
    void this.ensureLoaded(repoRoot);
    return null;
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
   * Drop a repository's graph if the file changed since it was read, so the
   * next `get()` reloads it. Cheap enough (one `stat`) to call from the
   * refresh coordinator (#581) rather than watching from in here.
   */
  async invalidateIfChanged(repoRoot: string): Promise<boolean> {
    const state = this.repos.get(repoRoot);
    if (state?.graph == null) return false;
    try {
      const st = await stat(graphFileOf(repoRoot));
      if (st.mtimeMs === state.graph.mtimeMs && st.size === state.graph.sizeBytes) return false;
    } catch {
      // The graph went away: forget it rather than serving a graph for a file
      // that no longer exists.
    }
    state.graph = null;
    state.degraded = null;
    return true;
  }

  /** Forget a repository entirely — on disable, or on uninstall. */
  forget(repoRoot: string): void {
    this.repos.delete(repoRoot);
  }

  /** What `bastra doctor` reports. */
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
