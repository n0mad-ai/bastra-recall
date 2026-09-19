/**
 * Recall's own cross-platform build lock per repository (#581).
 *
 * WHY NOT GRAPHIFY'S LOCK. Graphify serialises its own runs with an
 * `fcntl`-based lock. `fcntl.flock` is a POSIX call: on Windows the Python
 * module does not exist, and the code path around it degrades to a no-op. A
 * lock that silently does nothing on one of the platforms is not a lock we
 * can build "exactly one builds" on. It is also Graphify's internal business,
 * with no stability guarantee across its versions — the same reason the
 * reader never depends on Graphify's `manifest.json` (see manifest.ts).
 *
 * WHY NOT `flock`/`fcntl` OF OUR OWN. An advisory lock's release is tied to a
 * file descriptor and a process. That is convenient when the process dies —
 * and useless for the two cases that actually occur here: telling a caller
 * WHO holds the lock, and taking over a lock left by a daemon that was
 * SIGKILLed while its file descriptor's owner was, for a while, still alive
 * in the eyes of the kernel. A plain file carrying pid, host and a timestamp
 * answers both, works identically on macOS, Linux and Windows, and is the
 * same shape `path-lock.ts` already uses for settings and the import stores.
 *
 * THE THREE WAYS A LOCK GOES WRONG, and what is done about each:
 *
 *   1. The holder died. Detected two ways, on purpose: a heartbeat that
 *      stopped ({@link LOCK_STALE_MS}), and — only for a lock written on
 *      THIS host — `process.kill(pid, 0)` reporting the pid as gone. The pid
 *      check is fast and exact but meaningless across machines (the same pid
 *      exists on a colleague's laptop sharing a network checkout), so the
 *      heartbeat is what makes takeover correct there.
 *
 *   2. The holder is alive and slow. A full build is ~11 s on this repo, an
 *      incremental one ~2 s. The heartbeat renews every
 *      {@link LOCK_RENEW_MS}, so a lock only looks stale after several
 *      missed beats — a build that takes a minute is never stolen from.
 *
 *   3. Two daemons race for the same free lock. The lock file is created
 *      ALREADY CARRYING ITS RECORD: the record is written to a private
 *      temporary file and `link()`ed onto the lock path, which fails with
 *      EEXIST when someone else got there first. Exactly one of them creates
 *      the file, and the loser gets `null` rather than a queue position. That
 *      is deliberate — a refresh that cannot run now is re-enqueued by the
 *      coordinator, and a queue of builds waiting on each other would be
 *      strictly worse than one build and one follow-up.
 *
 *      WHY NOT `open(path, "wx")` AND THEN WRITE, which is what this did
 *      before (#582 counter-review): between the two calls the lock file
 *      exists and is EMPTY. A competitor reading it in that window parses
 *      nothing, judges the lock unreadable, removes it — and both processes
 *      then believe they hold the lock and build at once, which is the one
 *      thing this module exists to prevent. `link()` publishes the name and
 *      the content in a single step, so that window does not exist. The same
 *      race is covered a second way, for a lock file written by an older
 *      Recall or by an interrupted write: an unreadable lock is only removed
 *      once it is older than {@link UNREADABLE_GRACE_MS}.
 *
 * A stolen lock is stolen safely: every holder writes a random `token` and
 * only removes a lock file that still carries its own token, so the daemon
 * whose lock was taken over cannot delete its successor's. The token is read
 * immediately before the removal and the replacement, which narrows that check
 * to as close to atomic as a plain file allows — POSIX has no
 * compare-and-delete, so what is left is a window of microseconds in which a
 * lock that was ALREADY judged stale can be removed by its former holder. A
 * lock is only judged stale after {@link LOCK_STALE_MS} without a heartbeat,
 * so reaching that window means the former holder was not running anyway.
 *
 * NOT covered: a checkout on a network share where O_EXCL is not atomic —
 * the same limit `path-lock.ts` documents, and the same judgement: a lease
 * with a quorum is not what a code-graph rebuild is worth.
 */

import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/** The lock file, inside the graph directory next to the manifest. */
export const LOCK_NAME = ".bastra-build.lock";

/**
 * A lock whose heartbeat is this old may be taken over. Six renew intervals:
 * long enough that a loaded machine missing a few beats keeps its lock,
 * short enough that a killed daemon does not block the next build for a
 * length of time a user would notice.
 */
export const LOCK_STALE_MS = 30_000;

/** Heartbeat interval. */
export const LOCK_RENEW_MS = 5_000;

/**
 * How long an UNREADABLE lock file is left alone before it counts as stale.
 *
 * A lock file that cannot be parsed is normally junk — an interrupted write,
 * an older format — and blocking a repository on it forever would be worse
 * than taking it over. But "cannot be parsed yet" is also what a competitor
 * created a moment ago looks like on a filesystem that reorders the name and
 * the content, so it gets a grace period first. Two seconds is far longer than
 * any such window and far shorter than a user notices.
 */
export const UNREADABLE_GRACE_MS = 2_000;

export interface LockRecord {
  pid: number;
  host: string;
  /** Random per acquisition, so a holder only ever removes its OWN lock. */
  token: string;
  /** When this holder took the lock, ISO. */
  startedAt: string;
  /** Last heartbeat, ISO. This — not `startedAt` — decides staleness. */
  renewedAt: string;
}

export interface RepoLock {
  /** Absolute path of the lock file. */
  path: string;
  /** The record this holder wrote. */
  record: LockRecord;
  /** Whether this acquisition took over a lock left behind by someone else. */
  tookOver: boolean;
  /** Release. Idempotent, never throws, never removes a foreign lock. */
  release(): Promise<void>;
}

export interface AcquireOptions {
  staleMs?: number;
  renewMs?: number;
  /** Off in tests that must not leave a timer behind. Default true. */
  heartbeat?: boolean;
}

export function lockPath(graphDir: string): string {
  return join(graphDir, LOCK_NAME);
}

/**
 * Take the build lock for one repository, or return null when another live
 * holder has it. Never waits: the caller decides what "busy" means.
 */
export async function acquireRepoLock(
  graphDir: string,
  opts: AcquireOptions = {},
): Promise<RepoLock | null> {
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const renewMs = opts.renewMs ?? LOCK_RENEW_MS;
  const path = lockPath(graphDir);

  await mkdir(graphDir, { recursive: true });

  // Two attempts, not a loop: create, and — if the lock was freed or a stale
  // one was removed — create once more. A third attempt could only mean
  // another process won the freed lock, which is a legitimate "busy".
  let tookOver = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const record = newRecord();
    if (await tryCreate(path, record)) {
      return makeLock(path, record, tookOver, renewMs, opts.heartbeat !== false);
    }
    const state = await readState(path);
    // ABSENT IS NOT UNREADABLE, and conflating the two handed the repository
    // to two builders (#582 counter-review): the holder had released between
    // our create and our read, so we saw nothing, decided to clear the lock
    // and removed the file the NEXT holder had published in between. Nothing
    // is removed here any more — there is nothing to remove, and the second
    // create attempt is the whole answer.
    if (state.kind === "free") continue;
    if (state.kind === "held") {
      if (!isStaleLock(state.record, staleMs)) return null;
      await removeIfUnchanged(path, state.record);
      tookOver = true;
      continue;
    }
    // Unreadable (truncated, or written by an older format) counts as stale:
    // a lock file nobody can prove is alive would otherwise block the repo
    // for good. Only once it has had its grace period, though: a lock file
    // that just appeared may be a competitor still publishing it.
    if (await isYoungerThan(path, UNREADABLE_GRACE_MS)) return null;
    await removeIfStillUnreadable(path);
    tookOver = true;
  }
  return null;
}

/** True when this record's holder is provably or presumably gone. */
export function isStaleLock(r: LockRecord, staleMs: number, now = Date.now()): boolean {
  const beat = Date.parse(r.renewedAt);
  if (!Number.isFinite(beat)) return true;
  if (now - beat > staleMs) return true;
  // A pid check only means something on the machine that wrote the record.
  if (r.host === safeHostname() && !isPidAlive(r.pid)) return true;
  return false;
}

/** The current holder's record, or null when the lock is free or unreadable. */
export async function readLock(graphDir: string): Promise<LockRecord | null> {
  return readRecord(lockPath(graphDir));
}

function makeLock(
  path: string,
  record: LockRecord,
  tookOver: boolean,
  renewMs: number,
  heartbeat: boolean,
): RepoLock {
  let released = false;
  // `unref()` so a pending heartbeat never keeps the daemon's event loop
  // alive — a CLI build must be able to exit the moment the build is done.
  const timer = heartbeat
    ? setInterval(() => {
        if (released) return;
        void renew(path, record);
      }, renewMs)
    : null;
  timer?.unref?.();

  return {
    path,
    record,
    tookOver,
    async release() {
      if (released) return;
      released = true;
      if (timer !== null) clearInterval(timer);
      // Read and compare IMMEDIATELY before the removal, with nothing awaited
      // in between: a successor's lock must not be deleted by the holder it
      // replaced. On any doubt the file is left where it is — it then expires
      // as a stale lock, which costs one build a wait and loses nothing.
      const current = await readRecord(path);
      if (current === null || current.token !== record.token) return;
      try {
        await rm(path, { force: true });
      } catch {
        // A lock file we cannot remove becomes a stale lock someone else takes
        // over in LOCK_STALE_MS. Failing the build over it would be worse.
      }
    },
  };
}

/**
 * Publish the lock file with its record already in it, or report that someone
 * else holds it. `link()` is the atomic step: it either creates the name or
 * fails with EEXIST, and it never leaves an empty file behind for a competitor
 * to mistake for junk.
 */
async function tryCreate(path: string, record: LockRecord): Promise<boolean> {
  const tmp = `${path}.new-${process.pid}-${record.token}`;
  try {
    await writeFile(tmp, serialize(record), { encoding: "utf8", flag: "wx" });
    await link(tmp, path);
    return true;
  } catch {
    return false;
  } finally {
    // The lock path is a second name for the same inode, so dropping this one
    // leaves the lock intact. On the failure path it removes the leftover.
    try {
      await rm(tmp, { force: true });
    } catch {
      /* a stray temp file is harmless; the next acquisition writes its own */
    }
  }
}

function serialize(record: LockRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** True when the file exists and was last written less than `ms` ago. */
async function isYoungerThan(path: string, ms: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs < ms;
  } catch {
    return false;
  }
}

/**
 * Rewrite the heartbeat. Atomically, because a reader deciding staleness must
 * never see a half-written record — it would read as unparseable and be taken
 * over while its holder is mid-build.
 *
 * The new record is written to the temporary file FIRST and the ownership
 * check comes last, so that nothing is awaited between "the lock still carries
 * my token" and the `rename` that replaces it. Checking first and writing
 * afterwards — what this did before (#582 counter-review) — left a whole file
 * write in that window, long enough for a successor's lock to be overwritten
 * by the heartbeat of the holder it replaced.
 */
async function renew(path: string, record: LockRecord): Promise<void> {
  const beat = { ...record, renewedAt: new Date().toISOString() };
  const tmp = `${path}.beat-${process.pid}-${record.token}`;
  try {
    await writeFile(tmp, serialize(beat), "utf8");
    const current = await readRecord(path);
    if (current !== null && current.token === record.token) {
      await rename(tmp, path);
      record.renewedAt = beat.renewedAt;
      return;
    }
  } catch {
    /* fall through to the cleanup: a missed beat is not worth failing over */
  }
  try {
    await rm(tmp, { force: true });
  } catch {
    /* nothing left to do */
  }
}

/**
 * What is at the lock path. "Nobody holds it" and "somebody wrote something
 * we cannot read" are different answers and must stay different: the first is
 * a free lock to be created, the second a file to be judged and maybe removed.
 * Reading both as `null` is what let one acquisition delete another's lock.
 */
type LockState =
  | { kind: "free" }
  | { kind: "unreadable" }
  | { kind: "held"; record: LockRecord };

async function readState(path: string): Promise<LockState> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "free" }
      : { kind: "unreadable" };
  }
  const record = parseRecord(text);
  return record === null ? { kind: "unreadable" } : { kind: "held", record };
}

function parseRecord(text: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    if (
      typeof r.pid !== "number" ||
      typeof r.host !== "string" ||
      typeof r.token !== "string" ||
      typeof r.startedAt !== "string" ||
      typeof r.renewedAt !== "string"
    ) {
      return null;
    }
    return { pid: r.pid, host: r.host, token: r.token, startedAt: r.startedAt, renewedAt: r.renewedAt };
  } catch {
    return null;
  }
}

async function readRecord(path: string): Promise<LockRecord | null> {
  const state = await readState(path);
  return state.kind === "held" ? state.record : null;
}

/**
 * Remove a lock we judged stale — but only if it is still the same one.
 * Between the read and the removal another daemon may have taken it over and
 * started a build; deleting its fresh lock would produce exactly the double
 * build this module exists to prevent.
 */
async function removeIfUnchanged(path: string, seen: LockRecord): Promise<void> {
  try {
    const current = await readRecord(path);
    if (current === null || current.token !== seen.token) return;
    await rm(path, { force: true });
  } catch {
    /* the next acquire attempt will simply fail and report busy */
  }
}

/**
 * Remove a lock file nobody could parse — but only while it is STILL
 * unparseable. A valid record appearing between the judgement and the removal
 * is a new holder, and deleting it would be the same double build.
 */
async function removeIfStillUnreadable(path: string): Promise<void> {
  try {
    if ((await readState(path)).kind !== "unreadable") return;
    await rm(path, { force: true });
  } catch {
    /* the next acquire attempt will simply fail and report busy */
  }
}

function newRecord(): LockRecord {
  const now = new Date().toISOString();
  return {
    pid: process.pid,
    host: safeHostname(),
    token: randomBytes(12).toString("hex"),
    startedAt: now,
    renewedAt: now,
  };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and belongs to another user — alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return "unknown";
  }
}
