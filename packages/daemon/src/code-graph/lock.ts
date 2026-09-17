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
 *   3. Two daemons race for the same free lock. `open(..., "wx")` is O_EXCL:
 *      exactly one of them creates the file, and the loser gets `null`
 *      rather than a queue position. That is deliberate — a refresh that
 *      cannot run now is re-enqueued by the coordinator, and a queue of
 *      builds waiting on each other would be strictly worse than one build
 *      and one follow-up.
 *
 * A stolen lock is stolen safely: every holder writes a random `token` and
 * only removes a lock file that still carries its own token, so the daemon
 * whose lock was taken over cannot delete its successor's.
 *
 * NOT covered: a checkout on a network share where O_EXCL is not atomic —
 * the same limit `path-lock.ts` documents, and the same judgement: a lease
 * with a quorum is not what a code-graph rebuild is worth.
 */

import { open, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

  // Two attempts, not a loop: create, and — if a stale lock was in the way and
  // was removed — create once more. A third attempt could only mean another
  // process won the freed lock, which is a legitimate "busy", not a retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    const record = newRecord();
    if (await tryCreate(path, record)) {
      return makeLock(path, record, attempt > 0, renewMs, opts.heartbeat !== false);
    }
    const existing = await readRecord(path);
    if (existing !== null && !isStaleLock(existing, staleMs)) return null;
    // Unreadable (truncated, or written by an older format) counts as stale:
    // a lock file nobody can prove is alive would otherwise block the repo
    // for good, and its holder — if any — will find its token gone.
    await removeIfUnchanged(path, existing);
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
      const current = await readRecord(path);
      if (current !== null && current.token !== record.token) return; // taken over
      try {
        await rm(path, { force: true });
      } catch {
        // A lock file we cannot remove becomes a stale lock someone else takes
        // over in LOCK_STALE_MS. Failing the build over it would be worse.
      }
    },
  };
}

async function tryCreate(path: string, record: LockRecord): Promise<boolean> {
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrite the heartbeat. Atomically, because a reader deciding staleness must
 * never see a half-written record — it would read as unparseable and be taken
 * over while its holder is mid-build.
 */
async function renew(path: string, record: LockRecord): Promise<void> {
  const current = await readRecord(path);
  if (current === null || current.token !== record.token) return;
  record.renewedAt = new Date().toISOString();
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  } catch {
    try {
      await rm(tmp, { force: true });
    } catch {
      /* nothing left to do */
    }
  }
}

async function readRecord(path: string): Promise<LockRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
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

/**
 * Remove a lock we judged stale — but only if it is still the same one.
 * Between the read and the removal another daemon may have taken it over and
 * started a build; deleting its fresh lock would produce exactly the double
 * build this module exists to prevent.
 */
async function removeIfUnchanged(path: string, seen: LockRecord | null): Promise<void> {
  try {
    const current = await readRecord(path);
    if (seen !== null && current !== null && current.token !== seen.token) return;
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
