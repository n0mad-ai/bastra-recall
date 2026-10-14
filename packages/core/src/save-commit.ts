/**
 * Split out of `save.ts` (#360 follow-up): the write path had grown past 800
 * lines, which is a context cost on every edit that touches it. Pure move —
 * no behaviour change, no renamed export.
 *
 * Commit claims — the file-level lock that keeps two writers from claiming one
 * id. Split from the save orchestration because it answers a different
 * question: not "what does this memory look like" but "may I write right now".
 *
 * The claim outlives its process on SIGKILL, OOM or power loss, so age is a
 * release criterion — but for a claim whose owner can be shown to be alive,
 * only past a ceiling (COMMIT_CLAIM_LIVE_OWNER_MAX_MS), because a reused pid
 * looks alive too. Details on each rule are at the function that implements it.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, access, open, link, stat, lstat, mkdir, readdir, rmdir, unlink, writeFile, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { MemoryWriteConflictError } from "./save-schema.js";
import { newOperationId, reportMutationIncident } from "./mutation-incident.js";

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a commit snapshot without treating I/O failures as "missing".
 * `access()`-style probes collapse EACCES/EIO and ENOENT; a writer must fail
 * closed because only ENOENT proves that an id is free.
 */
export async function readTarget(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * How long a commit claim may sit untouched before a later writer may take it.
 * The commit it guards is a read plus a link/rename — milliseconds. The margin
 * is for a stalled cloud mount, not for a slow write.
 */
const COMMIT_CLAIM_STALE_MS = 30_000;

/**
 * How long a claim whose owner pid answers alive still counts as proof of
 * life, before the age check below takes over instead.
 *
 * A dead owner's pid is not retired — the OS hands it to any later process,
 * on some systems within seconds. `process.kill(pid, 0)` cannot tell "the
 * writer that took this claim" from "an unrelated live process that happens
 * to share its old pid", so without a ceiling a claim whose owner died and
 * whose pid was reused never ages out: the alive-check above wins forever.
 * Ten minutes is far longer than the commit this guards ever takes (a read
 * plus a link/rename, margin included for a stalled cloud mount) and far
 * longer than a pid usually sits unrecycled, so a false "still alive" self-
 * heals instead of requiring the lock file to be removed by hand.
 */
const COMMIT_CLAIM_LIVE_OWNER_MAX_MS = 10 * 60_000;

/**
 * A claim names its owner so a later writer can tell "someone is committing"
 * from "someone died mid-commit". Without this the claim outlives the process
 * that took it — `finally` does not run on SIGKILL, OOM or power loss — and the
 * id stays unwritable forever.
 */
interface CommitClaim {
  pid: number;
  host: string;
  ts: number;
  /** Wer diesen Claim genommen hat — je Erwerb neu, nicht je Prozess.
   *
   *  Codex-Gegenreview (P1): Freigegeben wurde per blindem `unlink`. Zwei
   *  Writer, die denselben verwaisten Claim gleichzeitig einsammeln, löschen
   *  sich danach gegenseitig den frisch genommenen Lock — und ein dritter
   *  Writer läuft in die entstandene Lücke. Der Release prüft deshalb, ob der
   *  Claim auf der Platte noch DERSELBE ist. */
  token: string;
  /** Public main readers ignore this optional cleanup pointer. */
  reclaimed_from?: string;
}

/**
 * May this writer take a claim it found already present?
 *
 * Zwei unabhängige Gründe, und der BESITZER kommt zuerst: Lebt der eingetragene
 * Prozess auf dieser Maschine noch, ist der Claim in Benutzung — bis zur
 * Obergrenze COMMIT_CLAIM_LIVE_OWNER_MAX_MS (10 Minuten, #895); danach kann es
 * nur eine wiederverwendete PID sein, und das Alter entscheidet wie sonst. Ein
 * toter Besitzer (ESRCH) gibt den Claim sofort frei. Das Alter bleibt für alles
 * andere zuständig — ein fremder Host (eine PID
 * ist nur auf ihrer Maschine aussagekräftig, und der Vault liegt erwartbar auf
 * geteilten Cloud-Mounts) oder ein unparsebarer Claim.
 */
async function inspectCommitClaim(lockPath: string): Promise<{ raw: string | null; abandoned: boolean }> {
  let raw: string;
  let ageMs: number;
  try {
    // Read bytes and age from one inode, even if the path is replaced meanwhile.
    const handle = await open(lockPath, "r");
    try {
      const [content, info] = await Promise.all([handle.readFile("utf8"), handle.stat()]);
      raw = content;
      ageMs = Date.now() - info.mtimeMs;
    } finally { await handle.close(); }
  } catch (err) {
    // No checked generation remains to reclaim. Unknown is never free.
    return { raw: null, abandoned: (err as NodeJS.ErrnoException)?.code === "ENOENT" };
  }

  // Erst der Besitzer, dann das Alter. Codex-Gegenreview (P1): Die Reihenfolge
  // war umgekehrt, und damit enteignete ein zweiter Writer nach 30 Sekunden
  // einen Claim, dessen Besitzer auf DIESER Maschine nachweislich noch lief
  // und gerade schrieb — ein langsamer Cloud-Mount reicht dafür aus. Ein
  // lebender lokaler Prozess ist ein Beweis, das Alter nur ein Indiz — aber
  // nur bis COMMIT_CLAIM_LIVE_OWNER_MAX_MS (#895): Eine PID wird nach dem Tod
  // ihres Besitzers wiederverwendet, ein Beweis ist sie nicht für immer.
  let claim: CommitClaim | undefined;
  try {
    claim = JSON.parse(raw) as CommitClaim;
  } catch {
    claim = undefined;
  }
  if (claim && claim.host === hostname() && typeof claim.pid === "number") {
    try {
      process.kill(claim.pid, 0);
      // owner is alive and working — age says nothing here, up to the ceiling
      // a reused pid cannot plausibly still be the original owner past.
      if (ageMs <= COMMIT_CLAIM_LIVE_OWNER_MAX_MS) return { raw, abandoned: false };
    } catch (err) {
      // ESRCH: der Besitzer ist weg, der Claim ist sofort frei. Alles andere
      // (EPERM — fremder Nutzer, gleiche PID) bleibt eine Altersfrage.
      if ((err as NodeJS.ErrnoException)?.code === "ESRCH") return { raw, abandoned: true };
    }
  }
  // Fremder Host, unparsebarer oder nicht zuordenbarer Claim: nur das Alter
  // kann ihn noch freigeben.
  return { raw, abandoned: ageMs > COMMIT_CLAIM_STALE_MS };
}

export async function claimIsAbandoned(lockPath: string): Promise<boolean> {
  return (await inspectCommitClaim(lockPath)).abandoned;
}

/**
 * Take the commit claim, reclaiming it once if the previous owner provably
 * died. A single retry is deliberate: two writers racing to reclaim the same
 * dead claim means one wins and the other reports a conflict, which is the
 * documented outcome for contention and costs no data — the compare-and-swap
 * below still has to agree before anything is published.
 */
export async function acquireCommitClaim(
  lockPath: string,
  id: string,
  filePath: string,
): Promise<string> {
  const token = randomUUID();
  const body = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    ts: Date.now(),
    token,
  } satisfies CommitClaim);
  return withPreparedClaim(lockPath, body, id, filePath, async prepared => {
    try {
      await link(prepared, lockPath);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const checked = await inspectCommitClaim(lockPath);
      if (checked.abandoned && checked.raw !== null
        && await reclaimStaleClaim(lockPath, prepared, body, checked.raw)) {
        reportMutationIncident({
          operation_id: newOperationId(), op: "claim_reclaim", status: "reclaimed",
          phase: "claim-reclaim", memory_id: id, detail: "abandoned claim taken over",
        });
        return token;
      }
      throw writeConflict(id, filePath, "another save is committing or reclaiming this target");
    }
  });
}

/** Complete regular bytes precede publication. Helpers live only in this ID's
 * directory, so interrupted preparations never require a lock-directory scan. */
async function withPreparedClaim<T>(lockPath: string, raw: string, id: string, filePath: string, run: (prepared: string) => Promise<T>): Promise<T> {
  const directory = `${lockPath}.publish`;
  const name = `${Date.now()}-${process.pid}-${(JSON.parse(raw) as CommitClaim).token}.tmp`;
  const prepared = join(directory, name);
  let directoryChecked = false;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const created = await ensureDirectory(directory);
        directoryChecked = true;
        if (!created) await cleanupPreparations(directory, lockPath);
        const handle = await open(prepared, "wx", 0o600);
        try { await handle.writeFile(raw, "utf8"); }
        finally { await handle.close(); }
        break;
      } catch (error) {
        // Another preparation can remove the now-empty shared container.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (attempt > 0) throw writeConflict(id, filePath, "another save is preparing this claim");
      }
    }
    return await run(prepared);
  } finally {
    if (directoryChecked) await removeOwnFile(prepared);
    await rmdir(directory).catch(() => {});
  }
}

async function ensureDirectory(path: string): Promise<boolean> {
  try { await mkdir(path, { mode: 0o700 }); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid claim helper directory");
  return false;
}

async function removeOwnFile(path: string): Promise<void> {
  // Also retry an ENOENT raised before the actual deletion by a provider.
  await unlink(path).catch(() => unlink(path).catch(() => {}));
}

function reservationOwner(name: string, suffix = ""): { ts: number; pid: number; token: string } | null {
  const escaped = suffix.replace(/\./g, "\\.");
  const match = new RegExp(`^(\\d+)-(\\d+)-([0-9a-f-]{36})${escaped}$`).exec(name);
  return match ? { ts: Number(match[1]), pid: Number(match[2]), token: match[3]! } : null;
}
function ownerExpired(owner: { ts: number; pid: number }, ceiling: number): boolean {
  try { process.kill(owner.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; }
  return Date.now() - owner.ts > ceiling;
}
async function cleanupPreparations(directory: string, lockPath: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const owner = reservationOwner(name, ".tmp");
    if (!owner || !ownerExpired(owner, COMMIT_CLAIM_LIVE_OWNER_MAX_MS)) continue;
    const prepared = join(directory, name);
    const raw = await readFile(prepared, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error; // Keep the durable pointer for a later retry on I/O failure.
    });
    if (raw === null) continue;
    let claim: CommitClaim | undefined;
    try { claim = JSON.parse(raw) as CommitClaim; } catch { /* incomplete preparation never published */ }
    // main may already have replaced the crashed public claim, losing its
    // pointer. The still-owned preparation carries the same durable cleanup key.
    if (claim?.token === owner.token && claim.reclaimed_from && /^[0-9a-f]{16}$/.test(claim.reclaimed_from)) {
      await removeOwnedMarker(`${lockPath}.reclaim-${claim.reclaimed_from}`, owner.token);
    }
    await removeOwnFile(prepared);
  }
}

/**
 * Wie lange eine Reclaim-Markierung liegen darf, bevor sie selbst als
 * verwaist gilt. Bewusst das Doppelte des Claim-Fensters: Ein Reclaim dauert
 * wenige Dateioperationen, und die Markierung soll nie vor dem Claim
 * ablaufen, den sie gerade übernimmt.
 */
const RECLAIM_MARK_STALE_MS = COMMIT_CLAIM_STALE_MS * 2;

/** Use main's canonical marker, so both versions serialize ordinary takeovers.
 * New markers are complete regular files, hardlinked from the prepared claim.
 * Only marker expiry needs reservations. An unmodified main process still has
 * its own blind stale-marker deletion race; new code cannot fence that reader. */
async function reclaimStaleClaim(lockPath: string, prepared: string, body: string, checked: string): Promise<boolean> {
  if (await readFile(lockPath, "utf8").catch(() => null) !== checked) return false;
  const digest = createHash("sha256").update(checked).digest("hex").slice(0, 16);
  const claim = JSON.parse(body) as CommitClaim;
  const updated = JSON.stringify({ ...claim, reclaimed_from: digest });
  await writeFile(prepared, updated, "utf8");
  const marker = `${lockPath}.reclaim-${digest}`;
  let owned = false;
  try {
    owned = await takeReclaimMark(lockPath, marker, prepared);
    if (!owned) return false;
    // Recheck freshness as well as bytes: a main writer can still be between
    // open(wx) and write, so its new empty file must not match an old empty one.
    const current = await inspectCommitClaim(lockPath);
    if (current.raw !== checked || !current.abandoned) return false;
    // A predecessor killed after publication may still own its earlier marker.
    // Retire that exact token while its cleanup pointer remains durable here.
    let predecessor: CommitClaim | undefined;
    try { predecessor = JSON.parse(checked) as CommitClaim; } catch { /* empty main claim */ }
    if (predecessor?.reclaimed_from && /^[0-9a-f]{16}$/.test(predecessor.reclaimed_from)) {
      await removeOwnedMarker(`${lockPath}.reclaim-${predecessor.reclaimed_from}`, predecessor.token);
      if (await readFile(lockPath, "utf8").catch(() => null) !== checked) return false;
    }
    if (!await markerOwnedBy(marker, claim.token)) return false;
    await unlink(lockPath);
    await link(prepared, lockPath);
    // A main process can execute its pre-existing blind stale-marker deletion.
    // Do not report acquisition after observable lease loss or replacement.
    const [stillOwned, published] = await Promise.all([
      markerOwnedBy(marker, claim.token),
      readFile(lockPath, "utf8").then(raw => (JSON.parse(raw) as CommitClaim).token === claim.token),
    ]);
    return stillOwned && published;
  } catch { return false; }
  finally { if (owned) await removeOwnedMarker(marker, claim.token); }
}

async function markerOwnedBy(marker: string, token: string): Promise<boolean> {
  try { return (JSON.parse(await readFile(marker, "utf8")) as CommitClaim).token === token; }
  catch { return false; }
}

async function removeOwnedMarker(marker: string, token: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if ((JSON.parse(await readFile(marker, "utf8")) as CommitClaim).token !== token) return;
      await unlink(marker);
      return;
    } catch { /* One-shot errors retry; abandoned markers expire after 60s. */ }
  }
}

async function takeReclaimMark(lockPath: string, marker: string, prepared: string): Promise<boolean> {
  // main uses marker mtime, so refresh the private record before linking it.
  const now = new Date(Date.now());
  await utimes(prepared, now, now);
  try { await link(prepared, marker); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false; }
  let seen: string, age: number;
  try {
    [seen, age] = await Promise.all([readFile(marker, "utf8"), stat(marker).then(info => Date.now() - info.mtimeMs)]);
  } catch { return false; }
  if (age <= RECLAIM_MARK_STALE_MS) return false;
  const recovery = `${lockPath}.recovery`;
  const phase = join(recovery, marker.slice(marker.lastIndexOf(".reclaim-") + 9));
  const reservation = join(phase, `${Date.now()}-${process.pid}-${randomUUID()}`);
  let reserved = false;
  try {
    await ensureDirectory(recovery);
    await ensureDirectory(phase);
    await mkdir(reservation, { mode: 0o700 }); reserved = true;
    for (const name of await readdir(phase)) {
      if (join(phase, name) === reservation) continue;
      const owner = reservationOwner(name);
      if (!owner) return false;
      if (!ownerExpired(owner, RECLAIM_MARK_STALE_MS)) return false;
      await rmdir(join(phase, name));
    }
    // Marker bytes bind modern generations; main's empty markers are also
    // re-aged here so a fresh main replacement is never treated as expired.
    const [current, info] = await Promise.all([readFile(marker, "utf8"), stat(marker)]);
    if (current !== seen || Date.now() - info.mtimeMs <= RECLAIM_MARK_STALE_MS) return false;
    await unlink(marker);
    await link(prepared, marker);
    return true;
  } catch { return false; }
  finally {
    if (reserved) await rmdir(reservation).catch(() => rmdir(reservation).catch(() => {}));
    await rmdir(phase).catch(() => {});
    await rmdir(recovery).catch(() => {});
  }
}

/** Release never deletes another claimant's marker. Only immutable, expired
 * reservation names can be retired here; a fresh reservation remains intact. */
async function cleanupReservations(lockPath: string): Promise<void> {
  const recovery = `${lockPath}.recovery`;
  try {
    const root = await lstat(recovery);
    if (!root.isDirectory() || root.isSymbolicLink()) return;
    for (const generation of await readdir(recovery)) {
      if (!/^[0-9a-f]{16}$/.test(generation)) continue;
      const phase = join(recovery, generation);
      const info = await lstat(phase);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      for (const name of await readdir(phase)) {
        const owner = reservationOwner(name);
        if (owner && ownerExpired(owner, RECLAIM_MARK_STALE_MS)) await rmdir(join(phase, name));
      }
      await rmdir(phase).catch(() => {});
    }
    await rmdir(recovery).catch(() => {});
  } catch { /* A later release can retire bounded dead reservations. */ }
}

/**
 * Den eigenen Claim freigeben — und NUR den eigenen.
 *
 * Codex-Gegenreview (P1): Der Release war ein blindes `unlink`. Wurde der
 * Claim zwischenzeitlich als verwaist eingesammelt (langsamer Mount, 30s
 * überschritten), löschte der Nachzügler beim Aufräumen den Lock seines
 * Nachfolgers — und der übernächste Writer lief in eine Lücke, die es nach
 * dem Modell gar nicht geben darf. Der Token beweist Besitz; passt er nicht,
 * gehört der Lock jemand anderem und bleibt stehen.
 */
export async function releaseCommitClaim(lockPath: string, token: string): Promise<void> {
  let claim: CommitClaim;
  try {
    claim = JSON.parse(await readFile(lockPath, "utf8")) as CommitClaim;
    if (claim.token !== token) return;
  } catch { return; }
  if (claim.reclaimed_from && /^[0-9a-f]{16}$/.test(claim.reclaimed_from)) {
    await removeOwnedMarker(`${lockPath}.reclaim-${claim.reclaimed_from}`, token);
    // Preserve the final token-read/unlink boundary after the rare cleanup.
    try { if ((JSON.parse(await readFile(lockPath, "utf8")) as CommitClaim).token !== token) return; }
    catch { return; }
  }
  await unlink(lockPath).catch(() => {});
  await cleanupReservations(lockPath);
}

export function writeConflict(id: string, filePath: string, detail: string): MemoryWriteConflictError {
  return new MemoryWriteConflictError(id, filePath, detail);
}

/**
 * Der Lock-Pfad für eine Memory-ID — nicht für einen Zielpfad.
 *
 * Codex-Gegenreview: Der Commit-Claim lag auf `<zielpfad>.bastra-write.lock`.
 * Zwei gleichzeitige Saves DERSELBEN id in verschiedene `folder`-Regale
 * nahmen damit zwei verschiedene Locks und gelangen beide — danach trugen
 * zwei Dateien dieselbe id, und der Vault lud beim nächsten Start still nur
 * eine davon. Der Kommentar über dem Lock sprach schon von der id; die
 * Umsetzung tat es nicht.
 *
 * Der Lock liegt unter `.bastra/locks/`, weil er sonst als Datei NEBEN dem
 * Memory läge und beim Re-Filing im falschen Regal zurückbliebe. Der
 * id-Anteil wird gehasht statt eingesetzt: Eine id darf Zeichen tragen, die
 * `isPathSafeComponent` durchlässt, aber auf einem anderen Dateisystem
 * unbrauchbar sind — und der Lock muss auf JEDEM funktionieren, gerade auf
 * den Cloud-Mounts, für die er da ist.
 */
export function commitLockPathFor(vaultRoot: string, id: string): string {
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 32);
  return join(vaultRoot, ".bastra", "locks", `${digest}.bastra-write.lock`);
}
