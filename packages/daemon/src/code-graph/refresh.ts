/**
 * The refresh coordinator: one build at a time per repository (#581).
 *
 * Four things trigger a refresh — the file watcher, a git event (commit,
 * checkout, merge, pull), the end of a turn via the Stop hook, and startup
 * reconciliation. All four run the SAME command (`graphify extract <repo>
 * --code-only`, see build.ts) and all four go through this one queue. They
 * differ only in what they mean when something is already running.
 *
 * THE STOP HOOK NEVER WAITS. {@link CodeGraphRefresher.enqueue} is
 * deliberately `void`, not `Promise<void>`: there is no way for a caller to
 * await a build even by accident. The Stop hook's own latency budget is
 * measured in tens of milliseconds and a build is measured in seconds, so a
 * build awaited inside the hook is a user-visible regression at the end of
 * every single turn. The queue is the contract; the hook only pushes into it.
 *
 * SINGLE FLIGHT, AND EXACTLY ONE FOLLOW-UP. Two edits landing during a
 * running build do not schedule two builds. They set one `pending` flag, and
 * one build runs after the current one. The flag is a boolean and not a
 * counter on purpose: `extract` is incremental and reads the tree as it finds
 * it, so a third build would re-read a tree the second one already covered.
 *
 * THE DEBOUNCE IS SECONDS, NOT TENS OF SECONDS. The original 20 s came from
 * the belief that any refresh costs 9-12 s. Re-measured, an incremental run is
 * 1.5-2.2 s (build.ts), so a short quiet period is enough to coalesce a burst
 * of saves while still meeting #581's "within 30 s" acceptance with room to
 * spare. Git events skip the wait: a branch switch is one discrete event, not
 * a burst, and waiting after it only widens the window in which the graph
 * describes the branch the user just left.
 *
 * RESTART RECOVERY IS THE POINT OF {@link CodeGraphRefresher.reconcile}.
 * Everything above lives in memory and a daemon restart loses it — that is the
 * gap the counter-review named, and the reason `dirty` is a field in an
 * on-disk manifest rather than a variable. On start, each enabled repo is
 * checked against its manifest: no manifest, `dirty` still set (a build was
 * killed mid-flight), or a file newer than `builtAt` → exactly one refresh is
 * enqueued. A stale lock from the killed daemon is taken over by lock.ts, not
 * waited on.
 *
 * REPEATED FAILURES STOP. After {@link DEFAULT_MAX_FAILURES} consecutive
 * failures a repository is given up on, with the reason kept for `bastra
 * doctor`. Retrying a broken Graphify install every few seconds forever would
 * spend the user's CPU to produce the same error; recall meanwhile keeps
 * working on the last good graph with the staleness marker (#577). An explicit
 * `manual` request always clears that state — the user asking again is the one
 * signal that something may have changed.
 *
 * A BUSY LOCK IS NOT A FAILURE. `locked` means another process — a second
 * daemon, or `bastra code index` in a terminal — is building this very repo.
 * That is the system working. It schedules one retry and does not count
 * towards the backoff.
 */

import { buildCodeGraph, scanFileState, type BuildResult } from "./build.js";
import { graphDirOf } from "./reader.js";
import { readManifest } from "./manifest.js";

export type RefreshReason = "watcher" | "git" | "stop-hook" | "startup" | "manual" | "retry";

/** Quiet period for bursty triggers. See the file comment for why it is short. */
export const DEFAULT_DEBOUNCE_MS = 3_000;

/** Git events are discrete, so they run at once. */
const IMMEDIATE_REASONS: ReadonlySet<RefreshReason> = new Set(["git", "manual", "retry"]);

/** Waits after consecutive failures, then the repo is given up on. */
export const DEFAULT_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000];

export const DEFAULT_MAX_FAILURES = 3;

/** How long to wait before retrying a repo another process is building. */
export const DEFAULT_LOCK_RETRY_MS = 10_000;

export type RefreshState = "idle" | "waiting" | "running";

export interface RepoStatus {
  repoRoot: string;
  state: RefreshState;
  /** A follow-up run is already promised for changes seen during this one. */
  pending: boolean;
  /** Consecutive failures. Reset by any success. */
  failures: number;
  lastError: string | null;
  /** Backoff exhausted: nothing automatic will retry until asked. */
  givenUp: boolean;
  lastReason: RefreshReason | null;
  /** Completed successful builds since the daemon started. */
  builds: number;
}

export type BuildFn = (repoRoot: string, reason: RefreshReason) => Promise<BuildResult>;

export interface RefresherOptions {
  /** Injectable for tests; defaults to the real Graphify build. */
  build?: BuildFn;
  debounceMs?: number;
  backoffMs?: readonly number[];
  maxFailures?: number;
  lockRetryMs?: number;
  /** Where a refresh reports what happened. Defaults to silence. */
  onEvent?: (event: RefreshEvent) => void;
}

export interface RefreshEvent {
  repoRoot: string;
  reason: RefreshReason;
  outcome: "started" | "ok" | "locked" | "failed" | "given-up" | "skipped";
  detail?: string;
}

interface RepoEntry {
  running: boolean;
  pending: boolean;
  timer: NodeJS.Timeout | null;
  reason: RefreshReason;
  failures: number;
  lastError: string | null;
  givenUp: boolean;
  lastReason: RefreshReason | null;
  builds: number;
}

export class CodeGraphRefresher {
  private readonly repos = new Map<string, RepoEntry>();
  private readonly idleWaiters: (() => void)[] = [];
  private readonly build: BuildFn;
  private readonly debounceMs: number;
  private readonly backoffMs: readonly number[];
  private readonly maxFailures: number;
  private readonly lockRetryMs: number;
  private readonly onEvent: (event: RefreshEvent) => void;
  private stopped = false;

  constructor(opts: RefresherOptions = {}) {
    this.build = opts.build ?? ((repoRoot) => buildCodeGraph({ repoRoot }));
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.lockRetryMs = opts.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  /**
   * Ask for a refresh of one repository. Returns immediately, always — this is
   * what the Stop hook calls, and awaiting a build there is out of scope by
   * construction (#581, trigger 3).
   */
  enqueue(repoRoot: string, reason: RefreshReason): void {
    if (this.stopped) return;
    const entry = this.entryOf(repoRoot);
    entry.lastReason = reason;

    if (reason === "manual") {
      // The user asking is the one signal that the world may have changed.
      entry.givenUp = false;
      entry.failures = 0;
    }
    if (entry.givenUp) {
      this.emit({ repoRoot, reason, outcome: "skipped", detail: entry.lastError ?? "given up" });
      return;
    }

    if (entry.running) {
      entry.pending = true;
      return;
    }

    const wait = IMMEDIATE_REASONS.has(reason) ? 0 : this.debounceMs;
    if (entry.timer !== null) {
      // Already waiting. A git event overtakes a debounced watcher batch
      // rather than queueing behind it.
      if (wait > 0) return;
      clearTimeout(entry.timer);
    }
    entry.reason = reason;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.run(repoRoot, entry);
    }, wait);
    entry.timer.unref?.();
  }

  /**
   * Startup reconciliation (#581). For each enabled repo: enqueue exactly one
   * refresh when there is no manifest, when `dirty` survived a restart, or
   * when a file is newer than the completed build. Returns the repos it
   * enqueued, so the daemon can log what it found rather than guess.
   */
  async reconcile(repoRoots: readonly string[]): Promise<string[]> {
    const enqueued: string[] = [];
    for (const repoRoot of repoRoots) {
      if (await needsReconcile(repoRoot)) {
        this.enqueue(repoRoot, "startup");
        enqueued.push(repoRoot);
      }
    }
    return enqueued;
  }

  status(): RepoStatus[] {
    return [...this.repos.entries()].map(([repoRoot, e]) => ({
      repoRoot,
      state: e.running ? "running" : e.timer !== null ? "waiting" : "idle",
      pending: e.pending,
      failures: e.failures,
      lastError: e.lastError,
      givenUp: e.givenUp,
      lastReason: e.lastReason,
      builds: e.builds,
    }));
  }

  statusOf(repoRoot: string): RepoStatus | null {
    return this.status().find((s) => s.repoRoot === repoRoot) ?? null;
  }

  /** Resolves once nothing is running, waiting or pending. For tests and shutdown. */
  /**
   * Resolves once nothing is queued or running.
   *
   * Holds the event loop open while it waits, and that is the whole subtlety:
   * the debounce timers are `unref`'d on purpose, so that a pending refresh
   * never keeps the daemon from exiting. A caller that explicitly asks to wait
   * for idle wants the opposite — without a ref'd handle the loop can drain
   * while the debounce is still pending, and this promise then never settles.
   * Node 22 reports exactly that ("Promise resolution is still pending but the
   * event loop has already resolved"); it surfaced in CI on 22 and not on 24.
   *
   * The keep-alive belongs to the wait, not to the refresh: it is cleared as
   * soon as the promise settles, so the `unref` discipline of the timers is
   * untouched and nothing about the daemon's shutdown behaviour changes.
   */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      const keepAlive = setInterval(() => {}, 1000);
      this.idleWaiters.push(() => {
        clearInterval(keepAlive);
        resolve();
      });
    });
  }

  /** Drop every scheduled refresh. A build already running is left to finish. */
  stop(): void {
    this.stopped = true;
    for (const entry of this.repos.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
      entry.pending = false;
    }
    this.settle();
  }

  private async run(repoRoot: string, entry: RepoEntry): Promise<void> {
    if (this.stopped) return this.settle();
    entry.running = true;
    const reason = entry.reason;
    this.emit({ repoRoot, reason, outcome: "started" });

    let result: BuildResult;
    try {
      result = await this.build(repoRoot, reason);
    } catch (err) {
      // The build path is written not to throw; if it ever does, a rejected
      // promise here would leave `running` set and wedge the repo for good.
      result = { ok: false, reason: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
    entry.running = false;

    if (result.ok) {
      entry.failures = 0;
      entry.lastError = null;
      entry.builds++;
      this.emit({ repoRoot, reason, outcome: "ok" });
    } else if (result.reason === "locked") {
      // Someone else is building this repo. Not our failure, not our backoff.
      this.emit({ repoRoot, reason, outcome: "locked", detail: result.detail });
      entry.pending = false;
      this.schedule(repoRoot, entry, this.lockRetryMs);
      return;
    } else {
      entry.failures++;
      entry.lastError = `${result.reason}: ${result.detail}`;
      this.emit({ repoRoot, reason, outcome: "failed", detail: entry.lastError });
      if (result.reason === "unsupported-platform" || entry.failures >= this.maxFailures) {
        entry.givenUp = true;
        entry.pending = false;
        this.emit({ repoRoot, reason, outcome: "given-up", detail: entry.lastError });
        return this.settle();
      }
      entry.pending = false;
      this.schedule(repoRoot, entry, this.backoffAt(entry.failures));
      return;
    }

    if (entry.pending) {
      entry.pending = false;
      this.schedule(repoRoot, entry, this.debounceMs);
      return;
    }
    this.settle();
  }

  private schedule(repoRoot: string, entry: RepoEntry, delayMs: number): void {
    if (this.stopped) return this.settle();
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.reason = "retry";
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.run(repoRoot, entry);
    }, delayMs);
    entry.timer.unref?.();
  }

  private backoffAt(failures: number): number {
    const i = Math.min(failures - 1, this.backoffMs.length - 1);
    return this.backoffMs[i] ?? this.backoffMs[this.backoffMs.length - 1] ?? DEFAULT_LOCK_RETRY_MS;
  }

  private entryOf(repoRoot: string): RepoEntry {
    let entry = this.repos.get(repoRoot);
    if (entry === undefined) {
      entry = {
        running: false,
        pending: false,
        timer: null,
        reason: "manual",
        failures: 0,
        lastError: null,
        givenUp: false,
        lastReason: null,
        builds: 0,
      };
      this.repos.set(repoRoot, entry);
    }
    return entry;
  }

  private isIdle(): boolean {
    for (const e of this.repos.values()) {
      if (e.running || e.pending || e.timer !== null) return false;
    }
    return true;
  }

  private settle(): void {
    if (!this.isIdle()) return;
    while (this.idleWaiters.length > 0) this.idleWaiters.pop()!();
  }

  private emit(event: RefreshEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // A listener must never be able to take a build down with it.
    }
  }
}

/**
 * Does this repository need a refresh after a restart?
 *
 * Deliberately conservative in the same way `isStale` is: "we cannot tell"
 * means yes. One extra incremental build costs about two seconds; a graph that
 * silently describes a tree from before the crash costs an agent acting on a
 * dependency list that no longer holds.
 */
export async function needsReconcile(repoRoot: string): Promise<boolean> {
  const manifest = await readManifest(graphDirOf(repoRoot));
  if (manifest === null) return true;
  if (manifest.dirty) return true;
  if (manifest.builtAt === null) return true;
  const builtMs = Date.parse(manifest.builtAt);
  if (!Number.isFinite(builtMs)) return true;
  const { newestMtimeMs } = await scanFileState(repoRoot);
  return newestMtimeMs > builtMs;
}
