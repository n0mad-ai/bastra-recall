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
 * killed mid-flight), or a changed source-file signature/newer file → exactly one refresh is
 * enqueued. A stale lock from the killed daemon is taken over by lock.ts, not
 * waited on.
 *
 * REPEATED FAILURES STOP. After {@link DEFAULT_MAX_FAILURES} consecutive
 * failures a repository is given up on, with the reason kept in coordinator
 * status and refresh events. Retrying a broken Graphify install every few seconds forever would
 * spend the user's CPU to produce the same error; recall meanwhile keeps
 * working on the last good graph with the staleness marker (#577). An explicit
 * `manual` request always clears that state — the user asking again is the one
 * signal that something may have changed. `bastra code index` sends that
 * request to the running daemon after its own build (#1148), and both the
 * pause and the stop are shown with their next attempt by `bastra code` and
 * `bastra doctor`, read from {@link CodeGraphRefresher.status}.
 *
 * A BUSY LOCK IS NOT A FAILURE. `locked` means another process — a second
 * daemon, or `bastra code index` in a terminal — is building this very repo.
 * That is the system working, but a stranded lock must not retry forever.
 * Six retries with doubling pauses cover an ordinary build's ten-minute
 * timeout, then pause and try at most once per hour until the lock is free.
 * Busy locks do not count as build failures, and automatic triggers cannot
 * shorten their retry pause.
 */

import { buildCodeGraph, scanFileState, type BuildResult } from "./build.js";
import { graphDirOf } from "./reader.js";
import { readManifest } from "./manifest.js";

export type RefreshReason = "watcher" | "git" | "stop-hook" | "startup" | "manual" | "retry";

/** Quiet period for bursty triggers. See the file comment for why it is short. */
export const DEFAULT_DEBOUNCE_MS = 3_000;

/** Git events are discrete, so they run at once. */
const IMMEDIATE_REASONS: ReadonlySet<RefreshReason> = new Set(["git", "manual", "retry"]);

/**
 * Triggers that carry no information about WHAT changed (a turn ended, a watcher fired on any
 * file), so they are worth a build only when the tree really moved. Git events, `manual` and
 * `startup` always build, and so does `retry`: it is also the follow-up for a change that landed
 * DURING a build. The promised follow-up must run even when a subsequent scan looks fresh.
 */
const SKIPPABLE_WHEN_FRESH: ReadonlySet<RefreshReason> = new Set(["stop-hook", "watcher"]);

/** Waits after consecutive failures, then the repo is given up on. */
export const DEFAULT_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000];

export const DEFAULT_MAX_FAILURES = 3;

/** How long to wait before retrying a repo another process is building. */
export const DEFAULT_LOCK_RETRY_MS = 10_000;
/** Six waits total 10.5 minutes at the default base interval. */
const MAX_LOCK_RETRIES = 6;
/** Rare recovery after lock contention exhausts the initial retry burst. */
const LOCK_RECOVERY_MS = 60 * 60_000;

export type RefreshState = "idle" | "waiting" | "running";

export interface RepoStatus {
  repoRoot: string;
  state: RefreshState;
  /** A follow-up run is already promised for changes seen during this one. */
  pending: boolean;
  /** Consecutive failures. Reset by any success. */
  failures: number;
  lastError: string | null;
  /** Build errors stop; exhausted lock retries pause until hourly recovery. */
  givenUp: boolean;
  lastReason: RefreshReason | null;
  /** Completed successful builds since the daemon started. */
  builds: number;
  /**
   * When the scheduled run is due, ISO; null when nothing is scheduled. For a
   * paused repository this is the hourly recovery attempt — the one number a
   * user needs to decide whether to wait or to run `bastra code index` (#1148).
   */
  nextAttemptAt: string | null;
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
  /**
   * Called after every successful build, and awaited before the repository
   * counts as idle (#583). The daemon hands the cache's reload in here: a
   * build that rewrites `graph.json` without the running readers noticing is
   * a refresh nobody sees until the next restart. Failures are swallowed —
   * the build itself succeeded, and the next build or check retries.
   */
  onBuilt?: (repoRoot: string) => Promise<unknown> | void;
  /**
   * Whether a repository may still be built (#585). Checked when a run is
   * about to start, so a repository disabled while a refresh was queued is
   * skipped instead of built. Defaults to always.
   */
  allow?: (repoRoot: string) => boolean;
  /**
   * Is the graph already current for this tree? Checked before a stop-hook or watcher
   * build; true skips it. Defaults to {@link graphIsFresh}; an error counts as "not fresh".
   */
  isFresh?: (repoRoot: string) => Promise<boolean>;
}

export interface RefreshEvent {
  repoRoot: string;
  reason: RefreshReason;
  outcome: "started" | "ok" | "locked" | "failed" | "given-up" | "skipped";
  detail?: string;
}

interface RepoEntry {
  lockAttempts: number;
  running: boolean;
  pending: boolean;
  timer: NodeJS.Timeout | null;
  reason: RefreshReason;
  failures: number;
  lastError: string | null;
  givenUp: boolean;
  lastReason: RefreshReason | null;
  builds: number;
  /** Epoch ms the pending timer fires at, null without a timer. */
  dueAt: number | null;
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
  private readonly onBuilt: (repoRoot: string) => Promise<unknown> | void;
  private readonly allow: (repoRoot: string) => boolean;
  private readonly isFresh: (repoRoot: string) => Promise<boolean>;
  private stopped = false;

  constructor(opts: RefresherOptions = {}) {
    this.build = opts.build ?? ((repoRoot) => buildCodeGraph({ repoRoot }));
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.lockRetryMs = opts.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
    this.onEvent = opts.onEvent ?? (() => {});
    this.onBuilt = opts.onBuilt ?? (() => {});
    this.allow = opts.allow ?? (() => true);
    this.isFresh = opts.isFresh ?? graphIsFresh;
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
      entry.lockAttempts = 0;
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
      if (entry.lockAttempts > 0 && reason !== "manual") return;
      // Already waiting. A git event overtakes a debounced watcher batch
      // rather than queueing behind it.
      if (wait > 0) return;
      clearTimeout(entry.timer);
    }
    entry.reason = reason;
    this.arm(repoRoot, entry, wait);
  }

  /**
   * Startup reconciliation (#581). For each enabled repo: enqueue exactly one
   * refresh when there is no manifest, when `dirty` survived a restart, or
   * when source paths or metadata changed since the last successful build. Returns the repos it
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
      nextAttemptAt: e.dueAt === null ? null : new Date(e.dueAt).toISOString(),
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
  /** May this repository be built at all? The same gate a queued run passes (#585). */
  allows(repoRoot: string): boolean {
    return this.allow(repoRoot);
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.repos.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
      entry.dueAt = null;
      entry.pending = false;
    }
    this.settle();
  }

  private async run(repoRoot: string, entry: RepoEntry): Promise<void> {
    if (this.stopped) return this.settle();
    if (!this.allow(repoRoot)) {
      entry.pending = false;
      this.emit({ repoRoot, reason: entry.reason, outcome: "skipped", detail: "not enabled" });
      return this.settle();
    }
    entry.running = true;
    const reason = entry.reason;
    if (SKIPPABLE_WHEN_FRESH.has(reason) && (await this.isFresh(repoRoot).catch(() => false))) {
      // Nothing in the tree is newer than the graph: a build would re-read every file, re-cluster
      // and rewrite the same graph. The Stop hook fires at the end of every turn of every session,
      // so on a busy host this is most of the daemon's graph CPU.
      entry.running = false;
      this.emit({ repoRoot, reason, outcome: "skipped", detail: "graph fresh" });
      if (entry.pending) {
        entry.pending = false;
        this.schedule(repoRoot, entry, this.debounceMs);
        return;
      }
      return this.settle();
    }
    this.emit({ repoRoot, reason, outcome: "started" });

    let result: BuildResult;
    try {
      result = await this.build(repoRoot, reason);
    } catch (err) {
      // The build path is written not to throw; if it ever does, a rejected
      // promise here would leave `running` set and wedge the repo for good.
      result = { ok: false, reason: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok) {
      // Still `running` while the readers reload, so `whenIdle()` means the
      // new graph is also the one being served.
      try {
        await this.onBuilt(repoRoot);
      } catch {
        // See `onBuilt`: the build stands; a failed reload is retried later.
      }
    }
    entry.running = false;

    if (result.ok) {
      entry.givenUp = false;
      entry.failures = 0;
      entry.lockAttempts = 0;
      entry.lastError = null;
      entry.builds++;
      this.emit({ repoRoot, reason, outcome: "ok" });
    } else if (result.reason === "locked") {
      // Keep lock contention separate from actual build failures, but bounded.
      entry.lockAttempts++;
      this.emit({ repoRoot, reason, outcome: "locked", detail: result.detail });
      entry.pending = false;
      if (entry.lockAttempts > MAX_LOCK_RETRIES) {
        entry.givenUp = true;
        entry.lastError = `locked after ${entry.lockAttempts} attempts: ${result.detail}`;
        this.emit({ repoRoot, reason, outcome: "given-up", detail: entry.lastError });
        this.schedule(repoRoot, entry, LOCK_RECOVERY_MS);
        return;
      }
      this.schedule(repoRoot, entry, this.lockRetryMs * 2 ** (entry.lockAttempts - 1));
      return;
    } else {
      // Leaving a lock pause restores the existing build-error policy.
      entry.givenUp = false;
      entry.lockAttempts = 0;
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
    this.arm(repoRoot, entry, delayMs);
  }

  /** The one place a timer is set, so `dueAt` can never disagree with it. */
  private arm(repoRoot: string, entry: RepoEntry, delayMs: number): void {
    entry.dueAt = Date.now() + delayMs;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.dueAt = null;
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
        lockAttempts: 0,
        running: false,
        pending: false,
        timer: null,
        reason: "manual",
        failures: 0,
        lastError: null,
        givenUp: false,
        lastReason: null,
        builds: 0,
        dueAt: null,
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
 * Is the graph on disk current for this tree? Compare sorted path/mtime/size
 * signatures as well as the build-start stamp, so renames, preserved-mtime
 * replacements and edits during a build remain stale. Old manifests without
 * a signature rebuild once. Unknown state is never considered fresh.
 */
export async function graphIsFresh(repoRoot: string): Promise<boolean> {
  try {
    const manifest = await readManifest(graphDirOf(repoRoot));
    if (manifest === null || manifest.dirty || manifest.builtAt === null) return false;
    const builtMs = Date.parse(manifest.builtAt);
    if (!Number.isFinite(builtMs)) return false;
    const { count, newestMtimeMs, signature } = await scanFileState(repoRoot);
    return newestMtimeMs <= builtMs && count === manifest.fileState.count
      && signature === manifest.fileState.signature;
  } catch {
    return false;
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
  return !(await graphIsFresh(repoRoot));
}
