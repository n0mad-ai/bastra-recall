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
 * local file and asked for `crossProcess`. An orphaned lock file (owner died)
 * is taken over after {@link LOCK_STALE_MS}; a writer that cannot get the lock
 * within {@link LOCK_WAIT_MS} proceeds WITHOUT the cross-process lock and says
 * so on stderr. That fail-open is deliberate: the worst case is exactly the
 * behaviour from before this module, while a setting that can no longer be
 * saved — or a Stop hook that hangs on a wedged lock — would be the more
 * expensive failure.
 *
 * NOT covered: a state file on a network share where O_EXCL is not atomic.
 * That would need a lease with a heartbeat, which these files are not worth.
 */
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** When a lock left behind counts as orphaned and may be taken over. */
const LOCK_STALE_MS = 10_000;
/** How long a writer waits for the lock before continuing fail-open. */
const LOCK_WAIT_MS = 5_000;

const chains = new Map<string, Promise<unknown>>();

export interface PathLockOptions {
  /**
   * Also take an O_EXCL lock file, so writers in OTHER processes queue too.
   * Only switch this on where a second process demonstrably writes the same
   * path — it costs a create/unlink per mutation.
   */
  crossProcess?: boolean;
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

async function acquireFileLock(path: string): Promise<boolean> {
  const lockPath = pathLockFilePath(path);
  const body = JSON.stringify({ pid: process.pid, host: hostnameSafe(), ts: Date.now() });
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
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
        // No writable directory or similar — then without the lock, as before.
        process.stderr.write(
          `[bastra-recall] cannot create lock ${lockPath} (${(err as Error).message}) — writing unserialized\n`,
        );
        return false;
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
        `[bastra-recall] lock ${lockPath} busy for ${LOCK_WAIT_MS}ms — writing unserialized\n`,
      );
      return false;
    }
    await delay(5 + Math.floor(Math.random() * 10));
  }
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
        const held = await acquireFileLock(path);
        try {
          return await fn();
        } finally {
          if (held) await unlink(pathLockFilePath(path)).catch(() => undefined);
        }
      }
    : fn;
  const prev = chains.get(path) ?? Promise.resolve();
  const next = prev.then(guarded, guarded);
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
