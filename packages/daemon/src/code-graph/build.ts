/**
 * Building the code graph with the pinned Graphify binary (#574).
 *
 * THE COMMAND IS ALWAYS `graphify extract <repo> --code-only`. Never
 * `graphify update`. The pre-build counter-review measured both on this repo:
 *
 *   graphify extract . --code-only   6,677 nodes  19,444 edges  11.14 s
 *   graphify update .                7,671 nodes  20,603 edges   9.32 s
 *
 * `update` looks like the cheaper one and is the wrong one: it has no
 * `--code-only` flag, so it indexed 65 Markdown files as well. That breaks the
 * code-only boundary of C-089/C-090 and §23 — documents must not be pulled
 * into the code graph — and the speed difference is an artefact of comparing
 * two different workloads, not a saving. `assertNoForbiddenCommand` below
 * makes the rule testable rather than a comment nobody re-reads.
 *
 * `extract --code-only` IS INCREMENTAL, and that fact retired two earlier
 * decisions. Re-measured here:
 *
 *   unchanged tree     1.53 s / 2.11 s (800 files cached, 18 re-extracted)
 *   one changed file   2.18 s
 *   one deleted file   2.68 s — the deletion was picked up WITHOUT `--force`
 *
 * The old premise ("a refresh costs 9-12 s even for one file") was simply
 * wrong, and it was the premise behind both the 20 s debounce (#581 now uses a
 * few seconds) and the automatic `--force`.
 *
 * `--force` IS NEVER PASSED AUTOMATICALLY. Graphify refuses to replace a good
 * graph with a much smaller one; that refusal is a safety property — it is
 * what stops a half-checked-out tree or a failed extraction from wiping a
 * working graph — not an obstacle to route around. `--force` exists here only
 * behind `rebuild: true`, which one explicitly confirmed CLI repair uses.
 *
 * THE BINARY IS ALWAYS ABSOLUTE. `~/.bastra/tools/bin/graphify` (#573),
 * overridable with BASTRA_GRAPHIFY_BIN for tests and for a developer's own
 * checkout. Never a bare `graphify` on PATH: the daemon is started by launchd,
 * whose PATH is not the user's shell PATH, and a PATH lookup would also let an
 * unrelated binary of that name run against the user's repositories.
 *
 * TWO ENVIRONMENT VARIABLES, ALWAYS. `GRAPHIFY_QUERY_LOG_DISABLE=1` keeps
 * Graphify from writing a query log into the user's project, and
 * `PYTHONHASHSEED=0` makes its community detection reproducible — without it
 * two builds of an unchanged tree produce different community ids, which shows
 * up as spurious graph churn.
 *
 * FAILURE LEAVES THE PREVIOUS GRAPH ALONE. Nothing here deletes graph files.
 * A failed build writes `dirty: true` and `lastError` into Recall's manifest
 * and returns; recall keeps working on the last good graph with the staleness
 * marker (#577), which is strictly better than having no graph at all.
 */

import { spawn } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, extname } from "node:path";
import { graphDirOf } from "./reader.js";
import { readManifest, writeManifest, type CodeGraphManifest } from "./manifest.js";
import { acquireRepoLock, type RepoLock } from "./lock.js";
import { headCommit } from "./git-paths.js";

/** Where #573 installs the pinned binary. */
export const DEFAULT_GRAPHIFY_BIN = join(homedir(), ".bastra", "tools", "bin", "graphify");

/** The only subcommand Recall ever runs. */
export const BUILD_SUBCOMMAND = "extract";

/** Subcommands Recall must never run — see the file comment. */
export const FORBIDDEN_SUBCOMMANDS: readonly string[] = ["update"];

/** Env every Graphify run gets, no exceptions. */
export const GRAPHIFY_ENV: Readonly<Record<string, string>> = {
  GRAPHIFY_QUERY_LOG_DISABLE: "1",
  PYTHONHASHSEED: "0",
};

/**
 * Hard ceiling for one build. A full build of this repo is ~11 s; ten minutes
 * covers a repository two orders of magnitude larger and still bounds a
 * Graphify that hangs on a pathological file instead of leaving a Python
 * process attached to the daemon for the rest of the session.
 */
export const BUILD_TIMEOUT_MS = 10 * 60_000;

/** How long a killed build gets to exit before SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** How long after the SIGKILL the build stops waiting for the child to be gone. */
const KILL_BACKSTOP_MS = 2_000;

/** Stderr kept for `lastError`. Enough for a Python traceback, not a log dump. */
const STDERR_KEEP_BYTES = 8 * 1024;

export type BuildFailureReason =
  | "unsupported-platform"
  | "graphify-missing"
  | "locked"
  | "timeout"
  | "failed"
  /**
   * The child did not die, not even on SIGKILL. The build lock is deliberately
   * LEFT BEHIND in this case — see `stop()` below — so this reason is also the
   * signal that the repository is blocked until the lock goes stale.
   */
  | "stuck";

export interface BuildSuccess {
  ok: true;
  manifest: CodeGraphManifest;
  durationMs: number;
  /** True when a lock left by a dead holder was taken over (#581). */
  tookOverLock: boolean;
}

export interface BuildFailure {
  ok: false;
  reason: BuildFailureReason;
  detail: string;
}

export type BuildResult = BuildSuccess | BuildFailure;

export interface BuildOptions {
  repoRoot: string;
  /** Absolute path of the Graphify binary. Defaults to the pinned install. */
  bin?: string;
  /**
   * Pass `--force`. ONLY for the explicitly confirmed `bastra code index
   * --rebuild` repair. Never set by a watcher, a hook or reconciliation.
   */
  rebuild?: boolean;
  /** Run under `nice` when the platform has it. Default true. */
  lowPriority?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Recall does not promise this feature on Windows yet (#581, platform scope). */
export function isSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "linux";
}

/** The binary path: env override, else the pinned install. Always absolute. */
export function graphifyBinPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BASTRA_GRAPHIFY_BIN?.trim();
  return override !== undefined && override !== "" ? override : DEFAULT_GRAPHIFY_BIN;
}

/**
 * The argument vector. Pure and exported so the acceptance test "no code path
 * invokes `graphify update`, and `--force` never appears in an automatically
 * triggered build" is an assertion over this function, not an inspection.
 */
export function buildArgs(repoRoot: string, opts: { rebuild?: boolean } = {}): string[] {
  const args = [BUILD_SUBCOMMAND, repoRoot, "--code-only"];
  if (opts.rebuild === true) args.push("--force");
  return args;
}

/** Throws when an argument vector violates the command rules above. */
export function assertNoForbiddenCommand(args: readonly string[]): void {
  const sub = args[0];
  if (sub !== BUILD_SUBCOMMAND) {
    throw new Error(`code graph: refusing to run "graphify ${String(sub)}" — only "extract" is allowed`);
  }
  if (!args.includes("--code-only")) {
    throw new Error("code graph: refusing to run extract without --code-only");
  }
}

/** Human-readable record of what ran, for the manifest and for `doctor`. */
export function commandString(bin: string, args: readonly string[]): string {
  return [bin, ...args].join(" ");
}

/** A Graphify build in progress or the reason there is none. */
export async function buildCodeGraph(opts: BuildOptions): Promise<BuildResult> {
  const { repoRoot } = opts;
  if (!isSupportedPlatform()) {
    return { ok: false, reason: "unsupported-platform", detail: process.platform };
  }

  const bin = opts.bin ?? graphifyBinPath();
  if (!(await isExecutable(bin))) {
    return { ok: false, reason: "graphify-missing", detail: bin };
  }

  const args = buildArgs(repoRoot, { rebuild: opts.rebuild });
  assertNoForbiddenCommand(args);

  const graphDir = graphDirOf(repoRoot);
  const lock = await acquireRepoLock(graphDir);
  if (lock === null) {
    return { ok: false, reason: "locked", detail: graphDir };
  }

  // A build whose child outlived SIGKILL keeps the lock: releasing it would
  // invite a second Graphify into a directory the first one can still write to,
  // which is the one thing this lock exists to prevent (#582 counter-review 3).
  let keepLock = false;
  try {
    const run = await runBuild({ ...opts, bin, args, graphDir, lock });
    keepLock = run.keepLock;
    return run.result;
  } finally {
    if (!keepLock) await lock.release();
  }
}

interface RunContext extends BuildOptions {
  bin: string;
  args: string[];
  graphDir: string;
  lock: RepoLock;
}

/** A build's answer, plus whether the caller must hold on to the lock. */
interface RunOutcome {
  result: BuildResult;
  keepLock: boolean;
}

async function runBuild(ctx: RunContext): Promise<RunOutcome> {
  const { repoRoot, bin, args, graphDir, lock } = ctx;
  const command = commandString(bin, args);
  const version = await graphifyVersion(bin);

  // `dirty` goes to disk BEFORE the first byte of the build: if the daemon is
  // killed mid-build, this flag is the only thing that still knows the graph
  // was being rewritten, and startup reconciliation (#581) reads exactly it.
  const previous = await readManifest(graphDir);
  await writeManifest(graphDir, {
    ...(previous ?? emptyManifest(repoRoot)),
    graphifyVersion: version,
    repoRoot,
    command,
    dirty: true,
  });

  const started = Date.now();
  const run = await spawnGraphify(ctx);
  const durationMs = Date.now() - started;

  if (!run.ok) {
    const failed: CodeGraphManifest = {
      ...((await readManifest(graphDir)) ?? emptyManifest(repoRoot)),
      graphifyVersion: version,
      repoRoot,
      command,
      lastError: run.detail,
      dirty: true,
    };
    await writeManifest(graphDir, failed);
    return {
      result: { ok: false, reason: run.reason, detail: run.detail },
      keepLock: run.childAlive === true,
    };
  }

  // Everything below describes a build that COMPLETED, so `builtAt` is taken
  // here and not at the start: a start time would make a build that died
  // halfway look newer than the files it never read.
  const [commit, fileState] = await Promise.all([headCommit(repoRoot), scanFileState(repoRoot)]);
  const manifest: CodeGraphManifest = {
    graphifyVersion: version,
    builtAt: new Date().toISOString(),
    commit,
    repoRoot,
    command,
    fileState,
    lastError: null,
    dirty: false,
  };
  await writeManifest(graphDir, manifest);
  return {
    result: { ok: true, manifest, durationMs, tookOverLock: lock.tookOver },
    keepLock: false,
  };
}

type SpawnOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: BuildFailureReason;
      detail: string;
      /** Set when the child is still running: the lock must NOT be released. */
      childAlive?: boolean;
    };

function spawnGraphify(ctx: RunContext): Promise<SpawnOutcome> {
  const { bin, args, repoRoot } = ctx;
  const timeoutMs = ctx.timeoutMs ?? BUILD_TIMEOUT_MS;
  const useNice = ctx.lowPriority !== false && niceAvailable();
  const file = useNice ? "nice" : bin;
  const argv = useNice ? ["-n", "10", bin, ...args] : args;

  return new Promise((resolve) => {
    const child = spawn(file, argv, {
      cwd: repoRoot,
      env: { ...process.env, ...GRAPHIFY_ENV },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < STDERR_KEEP_BYTES) stderr += chunk;
    });

    let settled = false;
    /** The outcome a stop() is waiting to report, once the child is gone. */
    let pending: SpawnOutcome | null = null;
    const timers: NodeJS.Timeout[] = [];
    const finish = (outcome: SpawnOutcome) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      ctx.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    /**
     * Stop the child and settle only once it has EXITED (#582 counter-review).
     *
     * SIGTERM first, SIGKILL after a grace period: Graphify writes its own
     * build cache, and a hard kill on the first signal is how that cache ends
     * up half-written and every later run rebuilds from scratch. But that
     * grace is also up to five seconds in which the child keeps writing into
     * the graph directory — and resolving straight away released the build
     * lock right into that window, so the next daemon started a second
     * Graphify on the same files. So the outcome is held until `close`.
     *
     * A backstop bounds the WAIT, not the lock (#582 counter-review 3). A child
     * that survives SIGKILL is stuck in the kernel and may still be writing
     * into the graph directory, so the earlier backstop — resolve anyway, and
     * let the `finally` release the lock — handed that directory to the next
     * builder while the first one was still in it. It now reports `stuck`, and
     * `buildCodeGraph` reads that as "keep the lock": the repository stays
     * blocked until the missing heartbeat makes the lock stale, which is a
     * bounded wait for one build rather than two Graphifys on one tree.
     */
    const stop = (outcome: SpawnOutcome) => {
      if (settled || pending !== null) return;
      pending = outcome;
      child.kill("SIGTERM");
      timers.push(setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS));
      timers.push(
        setTimeout(() => {
          finish({
            ok: false,
            reason: "stuck",
            detail: `${outcome.ok ? "build" : outcome.detail}: child still running ${
              KILL_BACKSTOP_MS
            } ms after SIGKILL — build lock left in place until it goes stale`,
            childAlive: true,
          });
        }, KILL_GRACE_MS + KILL_BACKSTOP_MS),
      );
      for (const t of timers) t.unref?.();
    };

    const timer = setTimeout(() => {
      stop({ ok: false, reason: "timeout", detail: `no result after ${timeoutMs} ms` });
    }, timeoutMs);
    timer.unref?.();
    timers.push(timer);

    const onAbort = () => {
      stop({ ok: false, reason: "failed", detail: "aborted" });
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      finish({ ok: false, reason: "failed", detail: err.message });
    });
    child.on("close", (code, signal) => {
      if (pending !== null) return finish(pending);
      if (code === 0) return finish({ ok: true });
      const why = signal !== null ? `killed by ${signal}` : `exit code ${String(code)}`;
      finish({ ok: false, reason: "failed", detail: `${why}${stderr === "" ? "" : `: ${stderr.trim()}`}` });
    });
  });
}

/** What the pinned binary reports, or "unknown" — never a guess, never fatal. */
export async function graphifyVersion(bin: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], {
      env: { ...process.env, ...GRAPHIFY_ENV },
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      if (out.length < 256) out += c;
    });
    const done = (value: string) => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done("unknown");
    }, GIT_LIKE_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", () => done("unknown"));
    child.on("close", () => {
      const line = out.split("\n", 1)[0]?.trim() ?? "";
      // "graphify, version 0.9.63" and "0.9.63" both occur; keep the number.
      const m = /\d+\.\d+\.\d+\S*/.exec(line);
      done(m?.[0] ?? (line === "" ? "unknown" : line));
    });
  });
}

const GIT_LIKE_TIMEOUT_MS = 10_000;

/** Directories that are never source and are expensive to walk. */
const SKIP_DIRS = new Set([
  ".git",
  "graphify-out",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
  ".cache",
]);

/** Extensions Graphify extracts from, and therefore the ones staleness is about. */
const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".scala", ".sh",
]);

/** Ceiling on the walk, so a mistakenly enabled home directory cannot stall it. */
const MAX_SCAN_FILES = 200_000;

/**
 * Count and newest mtime of the repository's source files.
 *
 * This is the manifest's `fileState` and the input to the read-time staleness
 * check (#577): a file whose mtime is newer than `builtAt` means the graph may
 * be out of date. It walks rather than asking git, deliberately — a file
 * edited but not yet staged is exactly the case the marker exists for, and an
 * enabled directory need not be a git repository at all.
 */
export async function scanFileState(repoRoot: string): Promise<{ count: number; newestMtimeMs: number }> {
  let count = 0;
  let newestMtimeMs = 0;
  const stack: string[] = [repoRoot];

  while (stack.length > 0 && count < MAX_SCAN_FILES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: not a reason to fail a build
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Hidden directories are never source here, and SKIP_DIRS covers the
        // visible ones that are generated or vendored.
        if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile() || !CODE_EXTS.has(extname(entry.name))) continue;
      try {
        const st = await stat(full);
        count++;
        if (st.mtimeMs > newestMtimeMs) newestMtimeMs = st.mtimeMs;
      } catch {
        // Vanished between readdir and stat — a build in a live checkout.
      }
      if (count >= MAX_SCAN_FILES) break;
    }
  }
  return { count, newestMtimeMs };
}

function emptyManifest(repoRoot: string): CodeGraphManifest {
  return {
    graphifyVersion: "unknown",
    builtAt: null,
    commit: null,
    repoRoot,
    command: "",
    fileState: { count: 0, newestMtimeMs: 0 },
    lastError: null,
    dirty: false,
  };
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let nicePresent: boolean | null = null;

/**
 * `nice` where it exists, never assumed. It is not portable (absent on
 * Windows, and on a minimal container image), and a build that fails because
 * the priority wrapper is missing would be a strictly worse outcome than a
 * build at normal priority.
 */
function niceAvailable(): boolean {
  if (nicePresent !== null) return nicePresent;
  if (process.platform === "win32") return (nicePresent = false);
  nicePresent = existsSync("/usr/bin/nice") || existsSync("/bin/nice");
  return nicePresent;
}
