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
import { readFile, access, open, stat, lstat, readlink, symlink, mkdir, readdir, rmdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join, dirname, basename } from "node:path";
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
  /** Only for retiring pre-draft reclaim files after interrupted takeover. */
  legacy_marks?: string[];
}

// The link target carries data; it is never followed. Junctions provide
// a native Windows representation. Legacy regular-file claims remain readable.
const CLAIM_LINK_PREFIX = "bastra-claim-v1-";
function linkBody(target: string): string {
  const value = basename(target);
  return value.startsWith(CLAIM_LINK_PREFIX)
    ? Buffer.from(value.slice(CLAIM_LINK_PREFIX.length), "base64url").toString("utf8")
    : `unknown-link:${target}`;
}
async function publishRecord(path: string, raw: string): Promise<void> {
  const value = CLAIM_LINK_PREFIX + Buffer.from(raw).toString("base64url");
  await symlink(process.platform === "win32" ? join(dirname(path), value) : value, path,
    process.platform === "win32" ? "junction" : "file");
}
async function readClaimRaw(path: string): Promise<string> {
  try { return linkBody(await readlink(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EINVAL") throw error;
    return readFile(path, "utf8");
  }
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
    try {
      raw = linkBody(await readlink(lockPath));
      let timestamp: number | undefined;
      try { timestamp = (JSON.parse(raw) as CommitClaim).ts; } catch { /* unknown link */ }
      ageMs = Number.isFinite(timestamp) ? Date.now() - timestamp! : Date.now() - (await lstat(lockPath)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EINVAL") throw error;
      // Legacy regular claims: read bytes and age through the same descriptor.
      const handle = await open(lockPath, "r");
      try {
        const [content, info] = await Promise.all([handle.readFile("utf8"), handle.stat()]);
        raw = content;
        ageMs = Date.now() - info.mtimeMs;
      } finally { await handle.close(); }
    }
  } catch (err) {
    // Gone between EEXIST and here: no checked generation to reclaim.
    // Anything else also stays a conflict: unknown is not free.
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
 * Take a complete commit claim atomically, reclaiming an abandoned predecessor
 * once. Two writers racing to reclaim the same dead generation must not both
 * win; contention reports a conflict, which is the
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
  try {
    // One atomic publication: no open-before-write empty generation exists.
    await publishRecord(lockPath, body);
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    const checked = await inspectCommitClaim(lockPath);
    if (checked?.abandoned && checked.raw !== null) {
      if (await reclaimStaleClaim(lockPath, body, checked.raw)) {
        // #377: Ein übernommener Lock heißt, dass ein früherer Schreibvorgang
        // gestorben ist, ohne aufzuräumen. Für DIESEN Aufrufer geht es
        // weiter; der tote Vorgänger ist der Befund: Einzeln ein
        // abgebrochenes Terminal, gehäuft ein Hinweis auf Abstürze oder eine
        // zu kurze Verwaisungsfrist. Ohne Ereignis sieht das niemand, weil
        // der Reclaim geräuschlos gelingt.
        //
        // `reclaimed` ist dafür der eigene Status: Die anderen fünf würden
        // hier alle etwas Falsches behaupten (siehe `MutationStatus`).
        //
        // Eigene `operation_id`: Die Mutation des Vorgängers ist von hier aus
        // nicht identifizierbar (sein Claim trägt pid und Zeit, keine
        // Operations-id). `memory_id` ist die Verbindung, an der man im
        // Audit-Log weitersucht.
        reportMutationIncident({
          operation_id: newOperationId(),
          op: "claim_reclaim",
          status: "reclaimed",
          phase: "claim-reclaim",
          memory_id: id,
          detail: "abandoned claim taken over",
        });
        return token;
      }
      // Der Reclaim ging an jemand anderen, oder der Claim war zwischendurch
      // wieder frisch. Beides ist ein Konflikt, kein zweiter Versuch.
      throw writeConflict(id, filePath, "another save is reclaiming this claim");
    }
    throw writeConflict(id, filePath, "another save is committing this target");
  }
}

/**
 * Wie lange eine Reclaim-Markierung liegen darf, bevor sie selbst als
 * verwaist gilt. Bewusst das Doppelte des Claim-Fensters: Ein Reclaim dauert
 * wenige Dateisystemaufrufe, und die Markierung soll nie vor dem Claim
 * ablaufen, den sie gerade übernimmt.
 */
const RECLAIM_MARK_STALE_MS = COMMIT_CLAIM_STALE_MS * 2;

/**
 * A takeover is bound to the exact bytes whose abandonment was checked. A
 * complete atomic marker serializes ordinary takeovers. Only an expired marker
 * needs unique timestamped reservations, which expire after 60 seconds and are
 * cleaned after successful release. No permanent per-id marker or lock-directory
 * scan is part of normal acquire/release.
 *
 * Known baseline boundaries remain: a reclaimer stalled beyond its lease (LIM1),
 * release's final token-read/unlink gap (LIM2), and a live owner misclassified as
 * abandoned before takeover publication (LIM3). No heartbeat is added here.
 */
interface RecoveryMarker { token: string; ts: number; legacy_observed?: number }
const recoveryPath = (lock: string): string => `${lock}.recovery`;

async function reclaimStaleClaim(lockPath: string, body: string, checkedGeneration: string): Promise<boolean> {
  const digest = createHash("sha256").update(checkedGeneration).digest("hex").slice(0, 16);
  const recovery = recoveryPath(lockPath), phase = join(recovery, digest), marker = join(phase, "marker");
  const legacy = `${lockPath}.reclaim-${digest}`;
  let lease: { raw: string; data: RecoveryMarker } | null = null;
  let retainMarker = false, directoriesChecked = false;
  try {
    if (await readClaimRaw(lockPath) !== checkedGeneration) return false;
    let legacyAge: number | null = null;
    try { legacyAge = Date.now() - (await stat(legacy)).mtimeMs; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    await ensureRecoveryDirectory(recovery);
    await ensureRecoveryDirectory(phase);directoriesChecked = true;
    lease = await takeRecoveryMarker(phase, legacyAge);
    if (!lease) return false;
    // A fresh legacy marker gets one bounded grace window. The observation is
    // content-bound, so a provider reporting mtime as "now" cannot block forever.
    if (legacyAge !== null && legacyAge <= RECLAIM_MARK_STALE_MS
      && Date.now() - (lease.data.legacy_observed ?? Date.now()) <= RECLAIM_MARK_STALE_MS) {
      retainMarker = true;return false;
    }
    // Retire obsolete legacy artifacts while the old claim is still the durable
    // reference. A later claimant may win the publication gap; our exclusive
    // create then fails instead of replacing that claimant's complete record.
    let inherited: string[] = [];
    try { const value = (JSON.parse(checkedGeneration) as CommitClaim).legacy_marks;inherited = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; } catch { /* legacy empty */ }
    const marks = [...new Set([digest, ...inherited])].filter(value => /^[0-9a-f]{16}$/.test(value));
    await cleanupLegacyMarks(lockPath, marks);
    if (await readClaimRaw(lockPath) !== checkedGeneration) return false;
    await unlink(lockPath);
    await publishRecord(lockPath, body);
    return true;
  } catch { return false; }
  finally {
    if (lease && !retainMarker) {
      try { if (await readClaimRaw(marker) === lease.raw) await unlink(marker); } catch { /* bounded lease expiry */ }
    }
    if(directoriesChecked){await rmdir(phase).catch(() => {});await rmdir(recovery).catch(() => {});}
  }
}

async function ensureRecoveryDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid recovery directory");
}

/** New markers are complete atomic records. Only an expired marker needs the
 * heavier reservation path; normal uncontended commit claims never enter it. */
async function takeRecoveryMarker(phase: string, legacyAge: number | null): Promise<{ raw: string; data: RecoveryMarker } | null> {
  const marker = join(phase, "marker");
  let data: RecoveryMarker = { token: randomUUID(), ts: Date.now(),
    ...(legacyAge !== null ? { legacy_observed: Date.now() - Math.min(legacyAge, RECLAIM_MARK_STALE_MS + 1) } : {}) };
  let raw = JSON.stringify(data);
  try { await publishRecord(marker, raw);return { raw, data }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const seen = await readClaimRaw(marker);
  const old = JSON.parse(seen) as RecoveryMarker;
  if (!Number.isFinite(old.ts) || Date.now() - old.ts <= RECLAIM_MARK_STALE_MS) return null;
  data = { ...data, ...(old.legacy_observed !== undefined ? { legacy_observed: old.legacy_observed } : {}) };
  raw = JSON.stringify(data);
  // A reservation's complete deadline and unique generation are its name.
  // Never delete a reused path based on a stale stat, never leave a witness.
  const reservation = join(phase, `${Date.now()}-${randomUUID()}`);
  try {
    await mkdir(reservation, { mode: 0o700 });
    for (const name of await readdir(phase)) {
      if (join(phase, name) === reservation) continue;
      const at = leaseTime(name);
      if (at === null) continue;
      if (Date.now() - at <= RECLAIM_MARK_STALE_MS) return null;
      await removeReservation(join(phase, name));
    }
    if ((await readdir(phase)).some(name => leaseTime(name) !== null && join(phase, name) !== reservation)) return null;
    if (await readClaimRaw(marker) !== seen) return null;
    // The reservation serializes expiry. Exclusive publication also handles a
    // normal marker creator winning the gap, without replacing its generation.
    await unlink(marker);
    await publishRecord(marker, raw);
    return { raw, data };
  } finally {
    await rmdir(reservation).catch(() => {});
  }
}

function leaseTime(name: string): number | null {
  const match = /^(\d+)-[0-9a-f-]{36}$/.exec(name);
  return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
}
async function removeReservation(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid recovery reservation");
  await unlink(join(path, "candidate")).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  await rmdir(path);
}
async function cleanupLegacyMarks(lockPath: string, marks: string[]): Promise<void> {
  // Migration-only: old unpublished witness names. No modern operation creates
  // them, and this parent scan is never used for normal acquire/release.
  const names = await readdir(dirname(lockPath)).catch(() => readdir(dirname(lockPath)));
  for (const digest of marks) {
    const base = `${basename(lockPath)}.reclaim-${digest}`;
    for (const name of names) if (name === base || name.startsWith(`${base}.abandoned-`))
      await unlink(join(dirname(lockPath), name)).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return unlink(join(dirname(lockPath), name)).catch(() => {});
        return undefined;
      });
  }
}

/** Only this id's recovery directory is inspected in normal release, never the
 * lock directory. Obsolete generation reservations cannot publish again: each
 * modern claim has unique complete bytes and takeover checks them before unlink. */
async function cleanupRecovery(lockPath: string, raw: string): Promise<void> {
  const recovery = recoveryPath(lockPath);
  try {
    const root = await lstat(recovery);if(!root.isDirectory()||root.isSymbolicLink())return;
    const current = createHash("sha256").update(raw).digest("hex").slice(0, 16);
    for (const generation of await readdir(recovery)) {
      if (generation === current || !/^[0-9a-f]{16}$/.test(generation)) continue;
      const phase = join(recovery, generation);
      const info = await lstat(phase);if(!info.isDirectory()||info.isSymbolicLink())continue;
      for (const name of await readdir(phase)) {
        if (leaseTime(name) !== null) await removeReservation(join(phase, name));
        else if (name === "marker" || /^take-[0-9a-f-]{36}$/.test(name)) await unlink(join(phase, name));
      }
      await rmdir(phase);
    }
    await rmdir(recovery);
  } catch { /* A later successful release retries cleanup; no permanent witness. */ }
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
  let raw: string;
  let claim: CommitClaim;
  try {
    raw = await readClaimRaw(lockPath);
    claim = JSON.parse(raw) as CommitClaim;
    if (claim.token !== token) return; // nicht mehr unserer
  } catch {
    // Weg, unlesbar oder unparsebar: nichts davon ist nachweislich unser Lock.
    // Stehen lassen — er altert aus, statt dass wir den eines anderen löschen.
    return;
  }
  if (claim.legacy_marks?.length) {
    // Keep the claim as the durable cleanup pointer until migration cleanup
    // completes. Recheck our token afterwards: do not widen the final release
    // read/unlink window with a directory scan (the unchanged LIM2 boundary).
    try {
      await cleanupLegacyMarks(lockPath, claim.legacy_marks);
      raw = await readClaimRaw(lockPath).catch(() => readClaimRaw(lockPath));
      if ((JSON.parse(raw) as CommitClaim).token !== token) return;
    } catch { return; }
  }
  const removed = await unlink(lockPath).then(() => true, () => false);
  if (removed) await cleanupRecovery(lockPath, raw);
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
