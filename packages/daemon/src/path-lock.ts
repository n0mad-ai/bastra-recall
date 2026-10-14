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
 *      and every `bastra import mine` step its own process), and for the pending
 *      relay (daemon plus `bastra drafts purge`). Off by default
 *      so the in-process-only call sites (such as floors) do not
 *      pay a filesystem round trip they have no writer for.
 *
 * PROMISE: mutations of the same path are fully serialised — guaranteed within
 * this process, and across processes as long as every writer sees the same
 * local file, asked for `crossProcess` and actually acquired the lease.
 * Takeover after {@link LOCK_STALE_MS} uses age, not owner liveness, and
 * removes only the observed token under an exclusive mutation guard;
 * a paused live process can therefore still own a stale snapshot. A writer that cannot get the lock
 * within {@link LOCK_WAIT_MS} proceeds WITHOUT the cross-process lock and says
 * so on stderr. That fail-open is deliberate: the worst case is exactly the
 * behaviour from before this module (including an acknowledged update or
 * rejected/undone draft tombstone lost to a later stale rename), while a setting that can no longer be
 * saved — or a Stop hook that hangs on a wedged lock — would be the more
 * expensive failure.
 *
 * The non-strict mutation guard covers only synchronous filesystem operations.
 * Its owner body permits recovery after a confirmed local process death.
 * Empty/invalid bodies from an interrupted create are recovered after 30 s;
 * live or remote owners are never displaced by age. Recovery renames and
 * compares the observed bytes, restoring a changed marker with an exclusive
 * hard link. Old writers must be stopped before relying on this guarantee.
 *
 * NOT covered: a state file on a network share where O_EXCL is not atomic.
 * That would need a lease with a heartbeat, which these files are not worth.
 */
import { openSync, writeFileSync, closeSync, statSync, unlinkSync, readFileSync, renameSync, linkSync, fstatSync, constants, type Stats } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/** Age-only lease takeover; this does not establish that the owner died. */
const LOCK_STALE_MS = 10_000;
/** How long a writer waits for the lock before continuing fail-open. */
const LOCK_WAIT_MS = 5_000;
const MUTATION_EMPTY_STALE_MS = 30_000;

const chains = new Map<string, Promise<unknown>>();
const depths = new Map<string, number>();

export interface PathLockOptions {
  /** Opt-in local transactions: never displace a live/unknown owner, never
   * fail open. Callback receives a synchronous ownership check for commits. */
  strictLocal?: boolean;
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
async function acquireFileLock(path: string, giveUp = "writing unserialized", strictLocal = false): Promise<string | null> {
  const lockPath = pathLockFilePath(path);
  const token = randomUUID();
  const body = JSON.stringify({ pid: process.pid, host: hostnameSafe(), ts: Date.now(), token });
  const deadline = Date.now() + LOCK_WAIT_MS;
  // The lock sits next to the state file; on the very first write the
  // directory may not exist yet (the writers create it themselves otherwise).
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => undefined);
  for (;;) {
    try {
      if (!strictLocal) {
        const acquired = mutateLock(lockPath, () => {
          const fd = openSync(lockPath, "wx", 0o600);
          try { writeFileSync(fd, body, "utf8"); }
          finally { closeSync(fd); }
          return true;
        });
        if (acquired) return token;
        throw Object.assign(new Error("lock mutation busy"), { code: "EEXIST" });
      }
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
          `[bastra-recall] cannot create lock ${strictLocal ? "[private store]" : lockPath} (${strictLocal ? "unavailable" : (err as Error).message}) — ${giveUp}\n`,
        );
        return null;
      }
    }
    // Capture the body BEFORE the age check: a replacement between this
    // snapshot and removal must never become the object of the old decision.
    try {
      const observed = strictLocal ? undefined : await readFile(lockPath, "utf8");
      const st = await stat(lockPath);
      if (strictLocal) {
        if (reclaimDeadLocal(lockPath, body)) return token;
      } else if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        if (removeStaleLock(lockPath, observed!)) continue;
      }
    } catch {
      if (strictLocal) continue; // Preserve the strict-local retry policy.
      // A missing lease can also mean an interrupted mutation guard. Still
      // honor the acquisition deadline instead of spinning forever.
    }
    if (Date.now() >= deadline) {
      process.stderr.write(
        `[bastra-recall] lock ${strictLocal ? "[private store]" : lockPath} busy for ${LOCK_WAIT_MS}ms — ${giveUp}\n`,
      );
      return null;
    }
    await delay(5 + Math.floor(Math.random() * 10));
  }
}

/** Serialize every non-strict create/reclaim/release. There is no await while
 * the guard is held, and the lease path never disappears during validation.
 * A rename-and-restore would allow a new holder into that empty interval. */
function mutateLock<T>(lockPath: string, fn: () => T): T | undefined {
  const guard = `${lockPath}.mutation`;
  let fd: number;
  try { fd = openSync(guard, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      if (!recoverMutationGuard(guard)) return undefined;
      try { fd = openSync(guard, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
      catch (retry) {
        if ((retry as NodeJS.ErrnoException).code === "EEXIST") return undefined;
        throw retry;
      }
    } else throw err;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostnameSafe(), ts: Date.now(), token: randomUUID() }), "utf8");
    return fn();
  }
  finally {
    closeSync(fd);
    unlinkSync(guard);
  }
}

/** Read metadata and contents through the same open descriptor. */
function mutationSnapshot(path: string): { raw: string; st: Stats } {
  const fd = openSync(path, "r");
  try { return { raw: readFileSync(fd, "utf8"), st: fstatSync(fd) }; }
  finally { closeSync(fd); }
}

/** Reclaim only the inspected orphan. Restore a concurrent replacement without
 * overwriting a marker that another contender has already acquired. */
function recoverMutationGuard(guard: string): boolean {
  let observed: string;
  let inspected: Stats;
  try {
    const snapshot = mutationSnapshot(guard);
    inspected = snapshot.st;
    observed = snapshot.raw;
    let validOwner = false;
    try {
      const body = JSON.parse(observed) as LockBody;
      validOwner = typeof body.host === "string" && Number.isSafeInteger(body.pid)
        && body.pid > 0 && typeof body.token === "string" && !!body.token;
    } catch { /* interrupted body write */ }
    if (validOwner ? !deadLocal(observed)
      : Date.now() - inspected.mtimeMs <= MUTATION_EMPTY_STALE_MS) return false;
  } catch { return false; }
  const moved = `${guard}.${randomUUID()}.orphan`;
  try { renameSync(guard, moved); } catch { return false; }
  let removeMoved = false;
  try {
    const snapshot = mutationSnapshot(moved);
    const detached = snapshot.st;
    if (detached.ino === inspected.ino && detached.dev === inspected.dev
      && detached.mtimeMs === inspected.mtimeMs && snapshot.raw === observed) {
      removeMoved = true;
      return true;
    }
    linkSync(moved, guard);
    removeMoved = true;
    return false;
  } catch { return false; } // Preserve the displaced marker if restoration failed.
  finally {
    if (removeMoved) try { unlinkSync(moved); } catch { /* best-effort cleanup */ }
  }
}

function removeStaleLock(lockPath: string, observed: string): boolean {
  return mutateLock(lockPath, () => {
    // Exact bytes bind the age decision to the token as well as every other
    // field. Keep age recovery of legacy/empty bodies, too, as before.
    if (readFileSync(lockPath, "utf8") !== observed
      || Date.now() - statSync(lockPath).mtimeMs <= LOCK_STALE_MS) return false;
    unlinkSync(lockPath);
    return true;
  }) === true;
}

/** Strict local reclaim has no age-only live-owner takeover. The existing
 * claim remains present until an exclusive reclaimer atomically replaces it.
 * Unknown owner or an interrupted reclaim marker requires explicit recovery. */
function deadLocal(raw: string): boolean {
  try {
    const body = JSON.parse(raw) as LockBody;
    if (body.host !== hostnameSafe() || !Number.isSafeInteger(body.pid) || body.pid <= 0 || !body.token) return false;
    try { process.kill(body.pid, 0); return false; }
    catch (err) { return (err as NodeJS.ErrnoException).code === "ESRCH"; }
  } catch { return false; }
}

function reclaimDeadLocal(lockPath: string, replacement: string): boolean {
  let stale: string;
  try { stale = readFileSync(lockPath, "utf8"); } catch { return false; }
  if (!deadLocal(stale)) return false;
  const mark = `${lockPath}.reclaim`;
  let fd: number;
  try { fd = openSync(mark, "wx", 0o600); }
  catch {
    const cleanup = `${mark}.cleanup`;
    let cleanupFd: number;
    try { cleanupFd = openSync(cleanup, "wx", 0o600); } catch { return false; }
    // Recover the *same* marker inode only when its local owner provably died.
    // Once removed, this contender backs off; the next acquisition retries.
    try {
      const original = statSync(mark);
      const raw = readFileSync(mark, "utf8");
      if (deadLocal(raw) && statSync(mark).ino === original.ino && readFileSync(mark, "utf8") === raw)
        unlinkSync(mark);
    } catch { /* unknown marker stays blocked for explicit operator recovery */ }
    finally { closeSync(cleanupFd); try { unlinkSync(cleanup); } catch { /* fail closed */ } }
    return false;
  }
  const tmp = `${mark}.${randomUUID()}.tmp`;
  try {
    writeFileSync(fd, replacement, "utf8");
    if (readFileSync(lockPath, "utf8") !== stale || !deadLocal(stale)) return false;
    writeFileSync(tmp, replacement, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // No empty-lock interval; all other strict reclaimers see the marker.
    renameSync(tmp, lockPath);
    return true;
  } catch { return false; }
  finally {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* not created or already renamed */ }
    try { unlinkSync(mark); } catch { /* ownership stays in the lock */ }
  }
}

function ownershipCheck(path: string, token: string): () => void {
  return () => {
    try {
      const current = JSON.parse(readFileSync(pathLockFilePath(path), "utf8")) as LockBody;
      if (current.token === token && current.pid === process.pid && current.host === hostnameSafe()) return;
    } catch { /* unknown is not ours */ }
    throw new PathLockUnavailableError();
  };
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
async function releaseFileLock(path: string, token: string, strictLocal = false): Promise<void> {
  const lockPath = pathLockFilePath(path);
  if (!strictLocal) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    do {
      try {
        const released = mutateLock(lockPath, () => {
          const current = JSON.parse(readFileSync(lockPath, "utf8")) as LockBody;
          if (current.token === token) unlinkSync(lockPath);
          return true;
        });
        if (released) return;
      } catch { return; } // Missing/unknown lock is never ours to remove.
      if (Date.now() >= deadline) return;
      await delay(5 + Math.floor(Math.random() * 10));
    } while (true);
  }
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
export function withPathLock<T>(path: string, fn: (assertOwnership: () => void) => Promise<T>, opts: PathLockOptions = {}): Promise<T> {
  const required = opts.requireLock || opts.strictLocal;
  const guarded = opts.crossProcess || opts.strictLocal
    ? async (): Promise<T> => {
        const token = await acquireFileLock(path, required ? "not writing" : undefined, opts.strictLocal);
        if (token === null && required) throw new PathLockUnavailableError();
        try {
          return await fn(token && opts.strictLocal ? ownershipCheck(path, token) : () => {});
        } finally {
          if (token) await releaseFileLock(path, token, opts.strictLocal);
        }
      }
    : () => fn(() => {});
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
  try {
    return mutateLock(lockPath, () => {
      if (takeOverStale) {
        try {
          // The guard protects this whole age check and removal, including
          // legacy bodies without tokens. No acquisition can replace it.
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS)
            unlinkSync(lockPath);
        } catch { /* Missing/unknown stays subject to the exclusive create. */ }
      }
      const token = randomUUID();
      const fd = openSync(lockPath, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostnameSafe(), ts: Date.now(), token }), "utf8"); }
      finally { closeSync(fd); }
      return token;
    }) ?? null;
  } catch { return null; }
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
