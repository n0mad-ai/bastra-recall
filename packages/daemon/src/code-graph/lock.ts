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
 *   3. Two daemons race for the same lock. THE LOCK FILE IS NEVER DELETED,
 *      and every change to it has to win a turn first (#582 counter-review 4).
 *
 *      WHY NOT "CHECK THE TOKEN, THEN REMOVE THE PATH", which is what taking
 *      over a stale lock did before: those are two steps. Four contenders
 *      reading the same stale record all passed the token check; the first
 *      removed the file and published its successor, and a loser whose read
 *      had landed a moment earlier removed THAT one and published its own.
 *      Both then believed they held the repository — 386 double holdings in
 *      875 acquisitions, measured. No ordering of a check and a delete fixes
 *      it, because POSIX has no compare-and-delete to build one on.
 *
 *      SO THE LOCK IS A CHAIN OF GENERATIONS. Every record carries `gen`, and
 *      writing generation N means first creating the directory `N` under
 *      `<lock>.gens` — `mkdir` is atomic and fails with EEXIST, so exactly one
 *      process in the world may ever write generation N. A contender numbers
 *      its generation one past the record it read, so two contenders reading
 *      the same record compete for the same marker and exactly one wins; the
 *      loser reads again and finds the successor. The record itself is then
 *      `rename`d into place, which is atomic and leaves no window where the
 *      path is missing or empty. Releasing is the same move: it publishes a
 *      `free` record as the next generation, so a holder that was taken over
 *      loses the `mkdir` and its release does nothing — which is right,
 *      because it has nothing left to release.
 *
 *      TWO CASES HAVE NO PREDECESSOR TO NUMBER FROM, and each has its own
 *      atomic step. A lock path that does not exist is published with
 *      `link()`, which creates the name and the record in ONE step and fails
 *      with EEXIST for everyone else — numbering cannot settle it, because
 *      two contenders reading an empty directory would pick generations of
 *      their own and both succeed. A lock file nobody can PARSE (an older
 *      format, an interrupted write from before this scheme) is replaced by
 *      whoever wins a marker named after those very bytes, so contenders
 *      seeing the same junk compete for the same turn, and different bytes
 *      are a different turn — this can never wedge a repository for good. It
 *      is only done once the file is older than {@link UNREADABLE_GRACE_MS},
 *      because "cannot be parsed yet" is also what a competitor mid-publish
 *      looked like before `link` and `rename` closed that window.
 *
 *      The loser of any of these gets `null` rather than a queue position.
 *      That is deliberate — a refresh that cannot run now is re-enqueued by
 *      the coordinator, and a queue of builds waiting on each other would be
 *      strictly worse than one build and one follow-up.
 *
 * A STOLEN LOCK IS STOLEN SAFELY, and "safely" means the former holder can
 * neither write to nor free its successor's lock (#582 counter-review 3 and 4).
 *
 *   RENEW writes through the holder's OWN DESCRIPTOR, never through the lock
 *   path. A takeover renames its own file over the name, so the descriptor
 *   then refers to an inode no name points at any more: the heartbeat lands
 *   nowhere and the successor's lock is untouched. There is no window at all
 *   here, because the name is never used.
 *
 *   RELEASE claims the next generation and publishes a `free` record. A
 *   successor already owns that marker, so the replaced holder's release is a
 *   no-op. There is no token comparison and no unlink to race with.
 *
 * NOT covered: a checkout on a network share where O_EXCL is not atomic —
 * the same limit `path-lock.ts` documents, and the same judgement: a lease
 * with a quorum is not what a code-graph rebuild is worth.
 */

import { link, mkdir, open, readdir, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { createHash, randomBytes } from "node:crypto";
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
  /** Random per acquisition, so a holder only ever writes its OWN record. */
  token: string;
  /** When this holder took the lock, ISO. */
  startedAt: string;
  /** Last heartbeat, ISO. This — not `startedAt` — decides staleness. */
  renewedAt: string;
  /**
   * Which generation of the lock this record is. Strictly increasing, and the
   * thing acquisitions actually compete for: writing generation N requires
   * winning `mkdir` on that generation's marker, which exactly one process can.
   */
  gen: number;
  /** `free` is a released lock: the record stays, the holder does not. */
  state: "held" | "free";
}

export interface RepoLock {
  /** Absolute path of the lock file. */
  path: string;
  /** The record this holder wrote. */
  record: LockRecord;
  /** Whether this acquisition took over a lock left behind by someone else. */
  tookOver: boolean;
  /** Release. Idempotent, never throws, never frees a foreign lock. */
  release(): Promise<void>;
  /**
   * Stop beating and let go of the descriptor WITHOUT releasing (#582
   * counter-review 4). For the one case that must not release and must not
   * hold on either: a build whose child survived SIGKILL and may still be
   * writing into the graph directory. Releasing would invite a second
   * Graphify in; keeping the heartbeat running would renew the lease forever,
   * so the repository would never unblock short of a daemon restart. After
   * `suspend()` the record simply ages out over {@link LOCK_STALE_MS} — and
   * `release()` still works, so a child that exits later frees it at once.
   */
  suspend(): void;
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

/** Where the per-generation claim markers live. One empty directory each. */
function gensDir(graphDir: string): string {
  return join(graphDir, `${LOCK_NAME}.gens`);
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
  const gens = gensDir(graphDir);

  await mkdir(gens, { recursive: true });

  // Two attempts, not a loop: claim a turn, and — if another contender claimed
  // it first — read what it published and claim once more. A third attempt
  // could only mean a third contender won, which is a legitimate "busy".
  let tookOver = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await readState(path);

    // NO LOCK FILE AT ALL. There is no predecessor to number from, so the
    // generation cannot decide this one — two contenders reading an empty
    // directory would pick different generations and BOTH succeed, which is
    // how the first version of this let two processes build. Creating the
    // name exclusively is what settles it: `link` either publishes the record
    // or fails with EEXIST, and it never leaves an empty file behind.
    if (state.kind === "free") {
      const record = newRecord(await nextGeneration(gens, null));
      const handle = await publish(path, record, "create");
      if (handle === null) continue;
      return makeLock(path, gens, handle, record, tookOver, renewMs, opts.heartbeat !== false);
    }

    if (state.kind === "unreadable") {
      // A lock file nobody can parse is normally junk — an interrupted write,
      // an older format — and blocking the repository on it forever would be
      // worse than replacing it. Only once it has had its grace period,
      // though: a file that just appeared may be a competitor mid-publish.
      if (await isYoungerThan(path, UNREADABLE_GRACE_MS)) return null;
      // Junk carries no generation, so the turn is claimed against the junk
      // ITSELF: contenders that read the same bytes compete for the same
      // marker and exactly one replaces them. Different bytes are a different
      // marker, so this can never wedge a repository for good.
      const claim = `reset-${digest(state.text)}`;
      if (!(await claimTurn(gens, claim))) continue;
      const record = newRecord(await nextGeneration(gens, null));
      const handle = await publish(path, record, "replace");
      if (handle === null) continue;
      return makeLock(path, gens, handle, record, true, renewMs, opts.heartbeat !== false);
    }

    if (state.record.state === "held") {
      if (!isStaleLock(state.record, staleMs)) return null;
      tookOver = true;
    }
    const gen = state.record.gen + 1;
    // THE ATOMIC STEP, and the whole of the exclusion (#582 counter-review 4).
    // `mkdir` either creates the marker or fails with EEXIST, so exactly one
    // process may ever succeed the record it just read. Nothing is deleted and
    // nothing is checked-then-acted-upon, which is what the previous takeover
    // did: several contenders read the same stale record, all passed the token
    // check, and each removed the lock the one before it had just published.
    if (!(await claimTurn(gens, String(gen)))) continue;
    const record = newRecord(gen);
    const handle = await publish(path, record, "replace");
    if (handle === null) continue;
    await pruneOldGenerations(gens, gen);
    return makeLock(path, gens, handle, record, tookOver, renewMs, opts.heartbeat !== false);
  }
  return null;
}

function digest(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/**
 * The generation to write when there is no readable predecessor: one past the
 * furthest marker, so that a lock file removed by hand or written by an older
 * Recall does not restart the chain at a number already in use. It is a
 * NUMBER, not the exclusion — `link` and the reset marker are.
 */
async function nextGeneration(gens: string, _unused: null): Promise<number> {
  let max = 0;
  for (const name of await readdir(gens).catch(() => [] as string[])) {
    const n = Number(name);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

/** True when this process, and only this process, won this turn's marker. */
async function claimTurn(gens: string, name: string): Promise<boolean> {
  try {
    await mkdir(join(gens, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Markers are empty directories and they accumulate, one per acquisition and
 * one per release. Everything far enough behind the current generation is gone
 * for good — a contender that won a marker and has still not published after
 * {@link GENERATION_KEEP} generations is not coming back, and {@link publish}
 * refuses to write a generation the file has already passed anyway.
 */
const GENERATION_KEEP = 4;

async function pruneOldGenerations(gens: string, gen: number): Promise<void> {
  const drop = gen - GENERATION_KEEP;
  if (drop < 1) return;
  const names = await readdir(gens).catch(() => [] as string[]);
  await Promise.all(
    names.map(async (name) => {
      const n = Number(name);
      if (!Number.isInteger(n) || n < 1 || n > drop) return;
      try {
        await rm(join(gens, name), { recursive: true, force: true });
      } catch {
        /* another process may already have swept it */
      }
    }),
  );
}

/** True when this record's holder is provably or presumably gone. */
export function isStaleLock(r: LockRecord, staleMs: number, now = Date.now()): boolean {
  if (r.state === "free") return true;
  const beat = Date.parse(r.renewedAt);
  if (!Number.isFinite(beat)) return true;
  if (now - beat > staleMs) return true;
  // A pid check only means something on the machine that wrote the record.
  if (r.host === safeHostname() && !isPidAlive(r.pid)) return true;
  return false;
}

/** The current holder's record, or null when the lock is free or unreadable. */
export async function readLock(graphDir: string): Promise<LockRecord | null> {
  const record = await readRecord(lockPath(graphDir));
  return record !== null && record.state === "held" ? record : null;
}

function makeLock(
  path: string,
  gens: string,
  handle: FileHandle,
  record: LockRecord,
  tookOver: boolean,
  renewMs: number,
  heartbeat: boolean,
): RepoLock {
  let released = false;
  let live: FileHandle | null = handle;
  // `unref()` so a pending heartbeat never keeps the daemon's event loop
  // alive — a CLI build must be able to exit the moment the build is done.
  let timer = heartbeat
    ? setInterval(() => {
        if (live !== null) void renew(live, record);
      }, renewMs)
    : null;
  timer?.unref?.();

  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    const open = live;
    live = null;
    void closeQuietly(open);
  };

  return {
    path,
    record,
    tookOver,
    suspend: stop,
    async release() {
      if (released) return;
      released = true;
      stop();
      await freeLock(path, gens, record);
    },
  };
}

/**
 * Hand the lock back by publishing a RELEASED record as the next generation —
 * never by deleting the file (#582 counter-review 4).
 *
 * Deleting is what could not be made safe: "the token still matches, so remove
 * the path" is two steps, and a takeover landing between them lost its fresh
 * lock to the holder it had replaced. Releasing through the generation chain
 * needs no check at all. A successor that took this lock over already owns the
 * next generation's marker, so this `mkdir` fails, and the release does
 * nothing — which is exactly right, because there is nothing left to release.
 */
async function freeLock(path: string, gens: string, record: LockRecord): Promise<void> {
  const gen = record.gen + 1;
  if (!(await claimTurn(gens, String(gen)))) return;
  const handle = await publish(path, { ...record, gen, state: "free" }, "replace");
  await closeQuietly(handle);
  if (handle !== null) await pruneOldGenerations(gens, gen);
}

/**
 * Write this generation's record and keep the descriptor.
 *
 * `create` is for a lock path that does not exist: `link` publishes the name
 * and the record in ONE step, so the path is never an empty file a competitor
 * could mistake for junk, and EEXIST means somebody else got there first.
 *
 * `replace` is for a path that does: the record goes to a private temporary
 * file and is RENAMED over it, so a reader sees either the previous generation
 * or this one, never half of either. The caller has already won this turn's
 * marker, so it is the only process that may write here; the generation check
 * catches only the case the marker cannot — a turn won so long ago that the
 * marker has since been pruned and the chain has moved on without it.
 *
 * The descriptor returned is the one the holder beats through: both `link` and
 * `rename` give the temporary file's inode the lock's name, so the descriptor
 * and the lock path are the same file until the next generation replaces it.
 */
async function publish(
  path: string,
  record: LockRecord,
  mode: "create" | "replace",
): Promise<FileHandle | null> {
  const tmp = `${path}.new-${process.pid}-${record.token}`;
  let handle: FileHandle | null = null;
  try {
    handle = await open(tmp, "wx");
    await handle.write(serialize(record), 0, "utf8");
    if (mode === "create") {
      await link(tmp, path);
    } else {
      const current = await readRecord(path);
      if (current !== null && current.gen >= record.gen) throw new Error("superseded");
      await rename(tmp, path);
    }
    return handle;
  } catch {
    await closeQuietly(handle);
    return null;
  } finally {
    // `link` leaves the temporary name behind — the lock path is a second name
    // for the same inode, so dropping this one leaves the lock intact. After a
    // `rename` there is nothing there, and after a failure this is the cleanup.
    try {
      await rm(tmp, { force: true });
    } catch {
      /* a stray temp file is harmless; the next acquisition writes its own */
    }
  }
}

async function closeQuietly(handle: FileHandle | null): Promise<void> {
  try {
    await handle?.close();
  } catch {
    /* an already-closed descriptor is the state we wanted */
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
 * Rewrite the heartbeat THROUGH THE HOLDER'S OWN DESCRIPTOR, never through the
 * lock path (#582 counter-review 3).
 *
 * Every path-based version of this had the same hole: the token was checked
 * and the file was then replaced, and a stale-takeover landing between the two
 * got its fresh lock overwritten by the heartbeat of the holder it had just
 * replaced. Writing through the descriptor closes it by construction — after a
 * takeover the descriptor points at an unlinked inode, so the beat goes
 * nowhere and the successor's lock is never touched. No check, no window.
 *
 * The record is written in one `write` at offset 0 and the file is trimmed to
 * its length AFTERWARDS, so a reader never finds the file shorter than a whole
 * record. Should it nonetheless catch a partial line, the mtime it just saw is
 * fresh, and {@link UNREADABLE_GRACE_MS} makes that "busy", not "junk".
 */
async function renew(handle: FileHandle, record: LockRecord): Promise<void> {
  const beat = { ...record, renewedAt: new Date().toISOString() };
  const text = serialize(beat);
  try {
    await handle.write(text, 0, "utf8");
    await handle.truncate(Buffer.byteLength(text, "utf8"));
    record.renewedAt = beat.renewedAt;
  } catch {
    /* a missed beat is not worth failing over: the next one renews the lease */
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
  /** `text` is what could not be parsed — the reset marker is claimed on it. */
  | { kind: "unreadable"; text: string }
  | { kind: "held"; record: LockRecord };

async function readState(path: string): Promise<LockState> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "free" }
      : { kind: "unreadable", text: String((err as NodeJS.ErrnoException).code ?? "unreadable") };
  }
  const record = parseRecord(text);
  return record === null ? { kind: "unreadable", text } : { kind: "held", record };
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
    // `gen` and `state` are read leniently: a lock written by a Recall from
    // before the generation chain is a held lock at generation zero, which is
    // exactly how the next acquisition should treat it.
    return {
      pid: r.pid,
      host: r.host,
      token: r.token,
      startedAt: r.startedAt,
      renewedAt: r.renewedAt,
      gen: typeof r.gen === "number" && Number.isInteger(r.gen) && r.gen >= 0 ? r.gen : 0,
      state: r.state === "free" ? "free" : "held",
    };
  } catch {
    return null;
  }
}

async function readRecord(path: string): Promise<LockRecord | null> {
  const state = await readState(path);
  return state.kind === "held" ? state.record : null;
}



function newRecord(gen: number): LockRecord {
  const now = new Date().toISOString();
  return {
    pid: process.pid,
    host: safeHostname(),
    token: randomBytes(12).toString("hex"),
    startedAt: now,
    renewedAt: now,
    gen,
    state: "held",
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
