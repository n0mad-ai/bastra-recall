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
 * behaviour from before this module (an acknowledged update lost to a later
 * stale rename; the draft store opts out with `strictLocal`, #1114), while a setting that can no longer be
 * saved — or a Stop hook that hangs on a wedged lock — would be the more
 * expensive failure.
 *
 * The non-strict mutation guard covers only synchronous filesystem operations.
 * Its owner body permits recovery after a confirmed local process death.
 * Every guard (including empty, live and remote owners) expires after 4 s;
 * a confirmed dead local owner is recovered immediately. An exclusive
 * recovery marker serialises rechecking and deleting the observed inode,
 * bytes and mtime without moving any marker. Owners release only their own
 * inode and tolerate an already removed marker. The recovery marker also
 * expires after 4 s, leaving one second before the acquisition wait expires.
 * A process paused inside synchronous work beyond that grace can be displaced. Old writers must be stopped before relying on
 * this guarantee.
 *
 * NOT covered: a state file on a network share where O_EXCL is not atomic.
 * That would need a lease with a heartbeat, which these files are not worth.
 */
import {
  openSync,
  writeFileSync,
  closeSync,
  statSync,
  unlinkSync,
  readSync,
  renameSync,
  rmdirSync,
  lstatSync,
  fstatSync,
  readFileSync,
  linkSync,
  constants,
  type Stats,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/** Age-only lease takeover; this does not establish that the owner died. */
const LOCK_STALE_MS = 10_000;
/** How long a writer waits for the lock before continuing fail-open. */
const LOCK_WAIT_MS = 5_000;
// Both guards cover synchronous filesystem work only. Four seconds leaves
// ample headroom for slow disks and one second to recover interrupted/remote
// markers before the five-second acquisition deadline.
const MUTATION_STALE_MS = 4_000;

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
  constructor(
    message = "could not get the lock on the settings file — another bastra process holds it, or one was interrupted; nothing was written. Try again in a few seconds"
  ) {
    super(message);
    this.name = "PathLockUnavailableError";
  }
}

/** Strict-local stores (tasks, assistant addresses, drafts #1114) are not the
 * settings file (#1587). No path: strict diagnostics never name the private store. */
const STRICT_LOCK_UNAVAILABLE =
  "could not get the lock on a private bastra store (tasks, assistant addresses or drafts) — another bastra process holds it, or one was interrupted; nothing was written. Try again in a few seconds. A lock whose process has ended, or that dates from before the last restart of this computer, is taken over automatically";

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
  /** Strict leases only (#1587): this kernel boot's random id, when readable. */
  boot?: unknown;
}

let bootCache: string | null | undefined;
/** The form a real boot id has (lowercase UUID); anything else proves nothing. */
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** This kernel boot's random identity, fixed for the life of the process:
 * Linux `boot_id`, macOS `kern.bootsessionuuid`. Null when unreadable
 * (Windows, sandboxes): then only the host + pid rule applies, as before. */
function currentBoot(): string | null {
  if (bootCache !== undefined) return bootCache;
  let id = "";
  try {
    if (process.platform === "linux") id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
    else if (process.platform === "darwin")
      id = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
  } catch {
    /* unknown boot */
  }
  id = id.trim().toLowerCase();
  bootCache = BOOT_ID.test(id) ? id : null;
  return bootCache;
}

/** Strict leases also carry the boot identity that proves a later boot (#1587). */
function newLeaseBody(token: string, strictLocal: boolean): string {
  const boot = strictLocal ? currentBoot() : null;
  return JSON.stringify({ pid: process.pid, host: hostnameSafe(), ts: Date.now(), token, ...(boot && { boot }) });
}

/**
 * Returns the token this call wrote into the lock file, or null when it gave
 * up without the lock (no writable directory, or busy past {@link
 * LOCK_WAIT_MS}). The token is what makes release() safe (see there): two
 * lock files can carry the same pid+host+ts down to the millisecond, but never
 * the same random token.
 */
async function acquireFileLock(
  path: string,
  giveUp = "writing unserialized",
  strictLocal = false
): Promise<string | null> {
  const lockPath = pathLockFilePath(path);
  const token = randomUUID();
  const body = newLeaseBody(token, strictLocal);
  const deadline = Date.now() + LOCK_WAIT_MS;
  // The lock sits next to the state file; on the very first write the
  // directory may not exist yet (the writers create it themselves otherwise).
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => undefined);
  for (;;) {
    try {
      if (!strictLocal) {
        const acquired = mutateLock(lockPath, () => {
          const fd = openSync(lockPath, "wx", 0o600);
          try {
            writeFileSync(fd, body, "utf8");
          } finally {
            closeSync(fd);
          }
          return true;
        });
        if (acquired) return token;
        throw Object.assign(new Error("lock mutation busy"), { code: "EEXIST" });
      }
      createLease(lockPath, body);
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
        // No writable directory or similar — then without the lock, as before.
        process.stderr.write(
          `[bastra-recall] cannot create lock ${strictLocal ? "[private store]" : lockPath} (${strictLocal ? "unavailable" : (err as Error).message}) — ${giveUp}\n`
        );
        return null;
      }
    }
    const next = await inspectHeldLock(lockPath, body, strictLocal);
    if (next === "acquired") return token;
    if (next === "retry") continue;
    if (Date.now() >= deadline) {
      process.stderr.write(
        `[bastra-recall] lock ${strictLocal ? "[private store]" : lockPath} busy for ${LOCK_WAIT_MS}ms — ${giveUp}\n`
      );
      return null;
    }
    await delay(5 + Math.floor(Math.random() * 10));
  }
}

/** #1114: a lease appears with its whole body or not at all. `link` fails with
 * EEXIST exactly like an O_EXCL create, so a writer that dies while creating
 * the lease never leaves an empty one that no owner check can ever release
 * (strict leases are freed only on proof that their owner ended). Where the
 * filesystem has no hard links, the plain exclusive create remains. */
function createLease(lockPath: string, body: string): void {
  const tmp = `${lockPath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    linkSync(tmp, lockPath);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw err;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
  const fd = openSync(lockPath, "wx", 0o600);
  try {
    writeFileSync(fd, body, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** What to do about a lease that already exists: strict-local reclaims only a
 * dead local owner; the other lane removes an aged or invalid lease. */
async function inspectHeldLock(
  lockPath: string,
  body: string,
  strictLocal: boolean
): Promise<"acquired" | "retry" | "wait"> {
  try {
    if (strictLocal) {
      // lstat, not stat: a dangling symlink exists and must not spin this loop.
      await lstat(lockPath);
      return reclaimDeadLocal(lockPath, body) ? "acquired" : "wait";
    }
    // Capture the body BEFORE the age check: a replacement between this
    // snapshot and removal must never become the object of the old decision.
    const observed = readMarker(lockPath);
    if (!observed.regular || Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS)
      return removeStaleLock(lockPath, observed) ? "retry" : "wait";
    return "wait";
  } catch {
    // Strict-local retries at once; a missing lease in the other lane can also
    // mean an interrupted mutation guard, so it honors the deadline instead.
    return strictLocal ? "retry" : "wait";
  }
}

/** Serialize every non-strict create/reclaim/release. There is no await while
 * the guard is held, and the lease path never disappears during validation.
 * A rename-and-restore would allow a new holder into that empty interval. */
function mutateLock<T>(lockPath: string, fn: () => T): T | undefined {
  const guard = `${lockPath}.mutation`;
  let fd: number;
  try {
    fd = openSync(guard, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      if (!recoverMutationGuard(guard)) return undefined;
      try {
        fd = openSync(guard, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      } catch (retry) {
        if ((retry as NodeJS.ErrnoException).code === "EEXIST") return undefined;
        throw retry;
      }
    } else throw err;
  }
  try {
    writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, host: hostnameSafe(), ts: Date.now(), token: randomUUID() }),
      "utf8"
    );
    return fn();
  } finally {
    releaseMutationGuard(guard, fd);
  }
}

/** Close after checking ownership; never remove a successor's marker. */
function releaseMutationGuard(path: string, fd: number): void {
  try {
    const owned = fstatSync(fd);
    try {
      const current = lstatSync(path);
      if (current.ino === owned.ino && current.dev === owned.dev) unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  } finally {
    closeSync(fd);
  }
}

/** A lock body is about 150 bytes; anything larger is read as an empty body. */
const MARKER_MAX_BYTES = 64 * 1024;

/** A lock-family file as found. `regular: false` is a FIFO, device, socket,
 * directory or symlink — nothing this module ever writes, so never an owner. */
interface Marker {
  raw: string;
  st: Stats;
  regular: boolean;
}

/** Inspect and read ONE descriptor: O_NOFOLLOW refuses a symlink, O_NONBLOCK
 * keeps a FIFO from wedging the event loop, and only a regular file is read,
 * at most {@link MARKER_MAX_BYTES} (contributor audit, after #1213). A missing
 * file throws ENOENT as before. */
function readMarker(path: string): Marker {
  let fd: number;
  try {
    // Windows has neither flag; there a symlink is followed as before.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    const st = lstatSync(path); // ENOENT surfaces here
    if (st.isFile()) throw err;
    return { raw: "", st, regular: false };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { raw: "", st, regular: false };
    // An oversized regular file stays a regular file: judged by age like any
    // unparsable body, never as "not an owner".
    if (st.size > MARKER_MAX_BYTES) return { raw: "", st, regular: true };
    const bytes = Buffer.alloc(MARKER_MAX_BYTES + 1);
    // Read to EOF: a short read must not hand a cut body to the decisions.
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, length);
      if (n === 0) break;
      length += n;
    }
    return { raw: length > MARKER_MAX_BYTES ? "" : bytes.toString("utf8", 0, length), st, regular: true };
  } finally {
    closeSync(fd);
  }
}

/** Remove a lock-family entry found as `st`. A directory is removed only when
 * it is empty (rmdir fails otherwise and the caller keeps its normal error);
 * nothing here ever deletes recursively. */
function removeEntry(path: string, st: Stats): void {
  if (st.isDirectory()) rmdirSync(path);
  else unlinkSync(path);
}

function sameMutationSnapshot(a: Marker, b: Marker): boolean {
  return a.st.ino === b.st.ino && a.st.dev === b.st.dev && a.st.mtimeMs === b.st.mtimeMs && a.raw === b.raw;
}

function expiredMutation(snapshot: Marker): boolean {
  return !snapshot.regular || Date.now() - snapshot.st.mtimeMs > MUTATION_STALE_MS || deadLocal(snapshot.raw);
}

/** Validate the still-named inode immediately before deletion. */
function removeObservedMutation(path: string, observed: Marker): boolean {
  const current = readMarker(path);
  if (!sameMutationSnapshot(observed, current) || !expiredMutation(current)) return false;
  const named = lstatSync(path);
  if (named.ino !== current.st.ino || named.dev !== current.st.dev || named.mtimeMs !== current.st.mtimeMs)
    return false;
  removeEntry(path, named);
  return true;
}

/** Serialise recovery without renaming or restoring another owner's marker.
 * Both marker sections are synchronous; age bounds even unknown owners. */
function recoverMutationGuard(guard: string): boolean {
  try {
    const observed = readMarker(guard);
    if (!expiredMutation(observed)) return false;
    const recovery = `${guard}.recover`;
    let fd: number;
    try {
      fd = openSync(recovery, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
      // An interrupted recovery must not wedge the next recovery forever.
      // Back off after cleanup; contenders still acquire this marker via wx.
      removeObservedMutation(recovery, readMarker(recovery));
      return false;
    }
    try {
      writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, host: hostnameSafe(), ts: Date.now(), token: randomUUID() }),
        "utf8"
      );
      return removeObservedMutation(guard, observed);
    } finally {
      releaseMutationGuard(recovery, fd);
    }
  } catch {
    return false;
  } // Real filesystem failures remain conservative.
}

function removeStaleLock(lockPath: string, observed: Marker): boolean {
  return (
    mutateLock(lockPath, () => {
      const current = readMarker(lockPath);
      // A non-regular lease is never an owner; remove that same inode only.
      // Otherwise exact bytes bind the age decision to the token as well as
      // every other field. Keep age recovery of legacy/empty bodies, too.
      const invalid = !observed.regular && !current.regular && current.st.ino === observed.st.ino;
      const stale =
        observed.regular &&
        current.regular &&
        current.raw === observed.raw &&
        Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      if (!invalid && !stale) return false;
      removeEntry(lockPath, current.st);
      return true;
    }) === true
  );
}

/** Strict local reclaim has no age-only live-owner takeover. The existing
 * claim remains present until an exclusive reclaimer atomically replaces it.
 * Unknown owner or an interrupted reclaim marker requires explicit recovery.
 *
 * A writer is dead only on proof (#1587): no process outlives its kernel boot,
 * so this host's lease from another boot is ownerless whoever has its pid now.
 * Within one boot the pid decides. A boot id is random per boot; on macOS
 * (one process table) the same boot proves the same machine, so a renamed
 * host is judged by its pid. Linux containers share a boot id across pid
 * namespaces, so there a foreign host name still proves nothing. */
function deadLocal(raw: string): boolean {
  try {
    const body = JSON.parse(raw) as LockBody;
    if (!Number.isSafeInteger(body.pid) || body.pid <= 0 || !body.token) return false;
    // A damaged or foreign boot field is treated as absent: host + pid decide.
    const boot = typeof body.boot === "string" && BOOT_ID.test(body.boot) ? currentBoot() : null;
    const sameHost = body.host === hostnameSafe();
    if (sameHost && boot && body.boot !== boot) return true;
    if (!sameHost && !(process.platform === "darwin" && boot && body.boot === boot)) return false;
    try {
      process.kill(body.pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

/** Recover the *same* marker inode only when its local owner provably died.
 * Once removed, this contender backs off; the next acquisition retries.
 * Read through {@link readMarker}: one non-blocking descriptor, no symlink,
 * bounded size (#1213). An oversized body has no owner to prove dead. */
function removeDeadMarker(mark: string): void {
  try {
    const original = readMarker(mark);
    if (original.regular && deadLocal(original.raw) && statSync(mark).ino === original.st.ino) unlinkSync(mark);
  } catch {
    /* unknown marker stays blocked for explicit operator recovery */
  }
}

/** The body of a regular lease, or null for a missing or non-regular one. A
 * non-regular strict lease is an unknown owner: refused, never reclaimed. */
function leaseBody(lockPath: string): string | null {
  try {
    const marker = readMarker(lockPath);
    return marker.regular ? marker.raw : null;
  } catch {
    return null;
  }
}

function reclaimDeadLocal(lockPath: string, replacement: string): boolean {
  const stale = leaseBody(lockPath);
  if (stale === null || !deadLocal(stale)) return false;
  const mark = `${lockPath}.reclaim`;
  let fd: number;
  try {
    fd = openSync(mark, "wx", 0o600);
  } catch {
    const cleanup = `${mark}.cleanup`;
    let cleanupFd: number;
    try {
      cleanupFd = openSync(cleanup, "wx", 0o600);
    } catch {
      return false;
    }
    try {
      removeDeadMarker(mark);
    } finally {
      closeSync(cleanupFd);
      try {
        unlinkSync(cleanup);
      } catch {
        /* fail closed */
      }
    }
    return false;
  }
  const tmp = `${mark}.${randomUUID()}.tmp`;
  try {
    writeFileSync(fd, replacement, "utf8");
    if (leaseBody(lockPath) !== stale || !deadLocal(stale)) return false;
    writeFileSync(tmp, replacement, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // No empty-lock interval; all other strict reclaimers see the marker.
    renameSync(tmp, lockPath);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* not created or already renamed */
    }
    try {
      unlinkSync(mark);
    } catch {
      /* ownership stays in the lock */
    }
  }
}

function ownershipCheck(path: string, token: string): () => void {
  return () => {
    try {
      const current = JSON.parse(leaseBody(pathLockFilePath(path)) ?? "") as LockBody;
      if (current.token === token && current.pid === process.pid && current.host === hostnameSafe()) return;
    } catch {
      /* unknown is not ours */
    }
    throw new PathLockUnavailableError(STRICT_LOCK_UNAVAILABLE);
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
          const current = JSON.parse(leaseBody(lockPath) ?? "") as LockBody;
          if (current.token === token) unlinkSync(lockPath);
          return true;
        });
        if (released) return;
      } catch {
        return;
      } // Missing/unknown lock is never ours to remove.
      if (Date.now() >= deadline) return;
      await delay(5 + Math.floor(Math.random() * 10));
    } while (true);
  }
  try {
    const lock = JSON.parse(leaseBody(lockPath) ?? "") as LockBody;
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
export function withPathLock<T>(
  path: string,
  fn: (assertOwnership: () => void) => Promise<T>,
  opts: PathLockOptions = {}
): Promise<T> {
  if (opts.noQueue && (depths.get(path) ?? 0) > 0) return Promise.reject(new PathLockUnavailableError());
  const required = opts.requireLock || opts.strictLocal;
  const guarded =
    opts.crossProcess || opts.strictLocal
      ? async (): Promise<T> => {
          const token = await acquireFileLock(path, required ? "not writing" : undefined, opts.strictLocal);
          if (token === null && required)
            throw new PathLockUnavailableError(opts.strictLocal ? STRICT_LOCK_UNAVAILABLE : undefined);
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
    if (depth === 0) depths.delete(path);
    else depths.set(path, depth);
  });
  // Keep the chain alive but never hand a rejection to the next waiter.
  chains.set(
    path,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

/** Reserve advisory feedback immediately when its deferred callback starts.
 * No mkdir/queued open before the attempt: a busy lock must not become a late
 * booking after its owner releases it. Called only off the response path.
 * Strict-local (#1691): one pass of the waiting strict lane, without the wait —
 * the same lease body (boot identity) and the same dead-owner-only reclaim. */
function tryFileLock(path: string, takeOverStale: boolean, strictLocal = false): string | null {
  const lockPath = pathLockFilePath(path);
  if (strictLocal) {
    const token = randomUUID();
    const body = newLeaseBody(token, true);
    try {
      createLease(lockPath, body);
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return null;
      return reclaimDeadLocal(lockPath, body) ? token : null;
    }
  }
  try {
    return (
      mutateLock(lockPath, () => {
        if (takeOverStale) {
          try {
            // The guard protects this whole age check and removal, including
            // legacy bodies without tokens. No acquisition can replace it.
            if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
          } catch {
            /* Missing/unknown stays subject to the exclusive create. */
          }
        }
        const token = randomUUID();
        createLease(lockPath, JSON.stringify({ pid: process.pid, host: hostnameSafe(), ts: Date.now(), token }));
        return token;
      }) ?? null
    );
  } catch {
    return null;
  }
}

/** Advisory feedback normally queues off the response path. `noQueue` skips a
 * busy local chain immediately. An aged lease is left alone unless the caller
 * explicitly opts into age-only takeover. Never writes without the
 * cross-process lock; busy/unwritable means no mutation. */
export function tryWithPathLock<T>(
  path: string,
  fn: () => Promise<T>,
  opts: PathLockOptions & { takeOverStale?: boolean } = {}
): Promise<T | undefined> {
  if (opts.noQueue && (depths.get(path) ?? 0) > 0) return Promise.resolve(undefined);
  return withPathLock(path, async () => {
    const fileLock = opts.crossProcess || opts.strictLocal;
    const token = fileLock ? tryFileLock(path, opts.takeOverStale === true, opts.strictLocal) : null;
    if (fileLock && token === null) return undefined;
    try {
      return await fn();
    } finally {
      if (token) await releaseFileLock(path, token, opts.strictLocal);
    }
  });
}
