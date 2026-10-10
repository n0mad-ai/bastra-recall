/**
 * Per-path write serialisation (#240/A9, #529, #534, #532/#533).
 *
 * Every read-modify-write against a small state file has the same defect when
 * nothing serialises it: Node serves overlapping HTTP requests — and a plain
 * `Promise.all` of CLI/UI calls — concurrently, so all writers read the same
 * old content and the last write wins. The tmp+rename these call sites use
 * prevents a TORN file; it does not serialise the TRANSACTION. Measured, each
 * time with every call reporting success:
 *
 *   - floors (#240):    12 parallel adds → 1 persisted, HTTP 200 throughout
 *   - imports (#529):   80 concurrent stageImport() → 80 reported, 1 on disk;
 *                       same for 80 concurrent buildQueue()
 *   - settings (#534):  `Promise.all([setUpdateMode, setDocsMode])` lost one
 *                       field in 20 of 20 runs in one process, and in 10 of 10
 *                       rounds across two processes
 *   - pending (#532):   40 concurrent writes → 1 persisted, inside a cap of 5
 *   - skills (#533):    40 unique adds → 40 successes, 1 persisted
 *
 * Two levels, because there are two races, and a call site opts into the
 * second one only when it needs it:
 *
 *   1. IN THIS PROCESS ({@link withPathLock}, the default): a promise chain
 *      per path. Enough for the common case — one surface writing several
 *      fields, one daemon serving overlapping requests — and it costs nothing
 *      beyond the queueing it exists to do.
 *   2. ACROSS PROCESSES (`{ crossProcess: true }`): a lock file next to the
 *      state file, created with O_EXCL ("wx") — the same pattern as the commit
 *      claim in core/save-commit.ts. Needed wherever a SECOND process writes
 *      the same file, which is demonstrably the case for settings (CLI,
 *      onboarding wizard, daemon), for the skills registry (`bastra skills
 *      add|remove` next to the daemon's POST /ui/skills) and for both import
 *      stores (#529: `bastra import` next to the daemon's POST /ui/import,
 *      and every `bastra import mine` step its own process). Off by default
 *      so the in-process-only call sites (floors, the pending relay) do not
 *      pay a filesystem round trip they have no writer for.
 *
 * PROMISE: mutations of the same path are fully serialised — guaranteed within
 * this process, and across processes as long as every writer sees the same
 * local file, asked for `crossProcess` and actually acquired the lease.
 * Takeover after {@link LOCK_STALE_MS} uses age only, not owner liveness;
 * a paused live process can therefore still own a stale snapshot. A writer that cannot get the lock
 * within {@link LOCK_WAIT_MS} proceeds WITHOUT the cross-process lock and says
 * so on stderr. That fail-open is deliberate: the worst case is exactly the
 * behaviour from before this module (including an acknowledged update or
 * rejected/undone draft tombstone lost to a later stale rename), while a setting that can no longer be
 * saved — or a Stop hook that hangs on a wedged lock — would be the more
 * expensive failure.
 *
 * NOT covered: a state file on a network share where O_EXCL is not atomic.
 * That would need a lease with a heartbeat, which these files are not worth.
 */
import { openSync, writeFileSync, closeSync, statSync, unlinkSync } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/** Age-only lease takeover; this does not establish that the owner died. */
const LOCK_STALE_MS = 10_000;
/** How long a writer waits for the lock before continuing fail-open. */
const LOCK_WAIT_MS = 5_000;

const chains = new Map<string, Promise<unknown>>();
const depths = new Map<string, number>();

export interface PathLockOptions {
  /** Response-path claims skip a busy local chain rather than joining it. */
  noQueue?: boolean;
  /**
   * Also take an O_EXCL lock file, so writers in OTHER processes queue too.
   * Only switch this on where a second process demonstrably writes the same
   * path — it costs a create/unlink per mutation.
   */
  crossProcess?: boolean;
  /**
   * With `crossProcess`: do NOT fall back to running without the lock. If the
   * lock file cannot be had within {@link LOCK_WAIT_MS}, `fn` is not called
   * and the returned promise rejects with {@link PathLockUnavailableError}.
   *
   * For the few writers where "unserialized" is worse than "not written": an
   * exclusive claim (two holders of a claim are no claim), or a write the user
   * is told about and can simply repeat. Off by default — every existing
   * caller keeps the fail-open described above (#1114 is about that default).
   */
  requireLock?: boolean;
}

/** The cross-process lock was required (`requireLock`) and not acquired. */
export class PathLockUnavailableError extends Error {
  constructor() {
    super("could not get the lock on the settings file — another bastra process holds it, or one was interrupted; nothing was written. Try again in a few seconds");
    this.name = "PathLockUnavailableError";
  }
}

export function pathLockFilePath(path: string): string {
  return `${path}.lock`;
}

function hostnameSafe(): string {
  try {
    return hostname();
  } catch {
    return "unknown";
  }
}

interface LockBody {
  pid: number;
  host: string;
  ts: number;
  token: string;
}

/**
 * Returns the token this call wrote into the lock file, or null when it gave
 * up without the lock (no writable directory, or busy past {@link
 * LOCK_WAIT_MS}). The token is what makes release() safe (see there): two
 * lock files can carry the same pid+host+ts down to the millisecond, but never
 * the same random token.
 */
async function acquireFileLock(path: string, giveUp = "writing unserialized"): Promise<string | null> {
  const lockPath = pathLockFilePath(path);
  const token = randomUUID();
  const body = JSON.stringify({ pid: process.pid, host: hostnameSafe(), ts: Date.now(), token });
  const deadline = Date.now() + LOCK_WAIT_MS;
  // The lock sits next to the state file; on the very first write the
  // directory may not exist yet (the writers create it themselves otherwise).
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => undefined);
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(body, "utf8");
      } finally {
        await handle.close();
      }
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
        // No writable directory or similar — then without the lock, as before.
        process.stderr.write(
          `[bastra-recall] cannot create lock ${lockPath} (${(err as Error).message}) — ${giveUp}\n`,
        );
        return null;
      }
    }
    // Orphaned? Age is the only indicator that needs no extra state; the loser
    // of a takeover race lands in the old behaviour, not in something worse.
    try {
      const st = await stat(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
    } catch {
      continue; // The lock vanished meanwhile — retry immediately.
    }
    if (Date.now() >= deadline) {
      process.stderr.write(
        `[bastra-recall] lock ${lockPath} busy for ${LOCK_WAIT_MS}ms — ${giveUp}\n`,
      );
      return null;
    }
    await delay(5 + Math.floor(Math.random() * 10));
  }
}

/**
 * A blind `unlink` on release deleted whatever lock file was there —
 * including a SUCCESSOR's, if this holder's own lock had already been taken
 * over as orphaned (a slow filesystem, a critical section past {@link
 * LOCK_STALE_MS}). Same fix as `core/save-commit.ts` releaseCommitClaim: read
 * the file back, and only unlink when its token still matches the one this
 * call wrote. Gone, unreadable or unparsable — none of that is provably still
 * ours, so it is left alone; it ages out on its own.
 */
async function releaseFileLock(path: string, token: string): Promise<void> {
  const lockPath = pathLockFilePath(path);
  try {
    const raw = await readFile(lockPath, "utf8");
    const lock = JSON.parse(raw) as LockBody;
    if (lock.token !== token) return; // not our lock any more
  } catch {
    return;
  }
  await unlink(lockPath).catch(() => undefined);
}

/**
 * Runs `fn` once every earlier holder of `path` has finished — and, with
 * `{ crossProcess: true }`, once every holder in another process has too. The
 * chain survives a rejection: a failing writer never poisons the next waiter,
 * and the caller still sees its own error.
 *
 * `fn` must do its whole read-modify-write inside; a snapshot taken before the
 * call is exactly the stale read this exists to prevent.
 */
export function withPathLock<T>(path: string, fn: () => Promise<T>, opts: PathLockOptions = {}): Promise<T> {
  const guarded = opts.crossProcess
    ? async (): Promise<T> => {
        const token = await acquireFileLock(path, opts.requireLock ? "not writing" : undefined);
        if (token === null && opts.requireLock) throw new PathLockUnavailableError();
        try {
          return await fn();
        } finally {
          if (token) await releaseFileLock(path, token);
        }
      }
    : fn;
  depths.set(path, (depths.get(path) ?? 0) + 1);
  const prev = chains.get(path) ?? Promise.resolve();
  const next = prev.then(guarded, guarded).finally(() => {
    const depth = (depths.get(path) ?? 1) - 1;
    if (depth === 0) depths.delete(path); else depths.set(path, depth);
  });
  // Keep the chain alive but never hand a rejection to the next waiter.
  chains.set(
    path,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** Reserve advisory feedback immediately when its deferred callback starts.
 * No mkdir/queued open before the attempt: a busy lock must not become a late
 * booking after its owner releases it. Called only off the response path. */
function tryFileLock(path: string, takeOverStale: boolean): string | null {
  const lockPath = pathLockFilePath(path);
  // At most one age-only takeover and one retry; never wait or diagnose.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | undefined;
    try {
      const token = randomUUID();
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostnameSafe(), ts: Date.now(), token }), "utf8");
      return token;
    } catch (err) {
      if (!takeOverStale || attempt !== 0 || (err as NodeJS.ErrnoException)?.code !== "EEXIST") return null;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs <= LOCK_STALE_MS) return null;
        unlinkSync(lockPath);
      } catch { return null; }
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  return null;
}

/** Advisory feedback normally queues off the response path. `noQueue` skips a
 * busy local chain immediately. An aged lease is left alone unless the caller
 * explicitly opts into age-only takeover. Never writes without the
 * cross-process lock; busy/unwritable means no mutation. */
export function tryWithPathLock<T>(path: string, fn: () => Promise<T>, opts: PathLockOptions & { takeOverStale?: boolean } = {}): Promise<T | undefined> {
  if (opts.noQueue && (depths.get(path) ?? 0) > 0) return Promise.resolve(undefined);
  return withPathLock(path, async () => {
    const token = opts.crossProcess ? tryFileLock(path, opts.takeOverStale === true) : null;
    if (opts.crossProcess && token === null) return undefined;
    try { return await fn(); }
    finally { if (token) await releaseFileLock(path, token); }
  });
}
