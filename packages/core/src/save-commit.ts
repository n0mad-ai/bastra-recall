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
 * release criterion — but only for a claim whose owner cannot be shown to be
 * alive. Details on each rule are at the function that implements it.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, access, open, rename, stat, unlink, writeFile } from "node:fs/promises";
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
}

/**
 * May this writer take a claim it found already present?
 *
 * Zwei unabhängige Gründe, und der BESITZER kommt zuerst: Lebt der eingetragene
 * Prozess auf dieser Maschine noch, ist der Claim in Benutzung, egal wie alt er
 * ist. Das Alter bleibt für alles andere zuständig — ein fremder Host (eine PID
 * ist nur auf ihrer Maschine aussagekräftig, und der Vault liegt erwartbar auf
 * geteilten Cloud-Mounts) oder ein unparsebarer Claim.
 */
export async function claimIsAbandoned(lockPath: string): Promise<boolean> {
  let raw: string;
  let ageMs: number;
  try {
    const [content, info] = await Promise.all([
      readFile(lockPath, "utf8"),
      stat(lockPath),
    ]);
    raw = content;
    ageMs = Date.now() - info.mtimeMs;
  } catch (err) {
    // Gone between EEXIST and here — another writer already cleared it, so this
    // one is free to retry. Anything else stays a conflict: unknown is not free.
    return (err as NodeJS.ErrnoException)?.code === "ENOENT";
  }

  // Erst der Besitzer, dann das Alter. Codex-Gegenreview (P1): Die Reihenfolge
  // war umgekehrt, und damit enteignete ein zweiter Writer nach 30 Sekunden
  // einen Claim, dessen Besitzer auf DIESER Maschine nachweislich noch lief
  // und gerade schrieb — ein langsamer Cloud-Mount reicht dafür aus. Ein
  // lebender lokaler Prozess ist ein Beweis, das Alter nur ein Indiz.
  let claim: CommitClaim | undefined;
  try {
    claim = JSON.parse(raw) as CommitClaim;
  } catch {
    claim = undefined;
  }
  if (claim && claim.host === hostname() && typeof claim.pid === "number") {
    try {
      process.kill(claim.pid, 0);
      return false; // owner is alive and working — age says nothing here
    } catch (err) {
      // ESRCH: der Besitzer ist weg, der Claim ist sofort frei. Alles andere
      // (EPERM — fremder Nutzer, gleiche PID) bleibt eine Altersfrage.
      if ((err as NodeJS.ErrnoException)?.code === "ESRCH") return true;
    }
  }
  // Fremder Host, unparsebarer oder nicht zuordenbarer Claim: nur das Alter
  // kann ihn noch freigeben.
  return ageMs > COMMIT_CLAIM_STALE_MS;
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
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(body, "utf8");
      } finally {
        await handle.close();
      }
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      if (attempt === 0 && (await claimIsAbandoned(lockPath))) {
        if (await reclaimStaleClaim(lockPath, body)) {
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
  /* c8 ignore next */
  throw writeConflict(id, filePath, "another save is committing this target");
}

/**
 * Wie lange eine Reclaim-Markierung liegen darf, bevor sie selbst als
 * verwaist gilt. Bewusst das Doppelte des Claim-Fensters: Ein Reclaim dauert
 * einen Read und ein Rename, und die Markierung soll nie vor dem Claim
 * ablaufen, den sie gerade übernimmt.
 */
const RECLAIM_MARK_STALE_MS = COMMIT_CLAIM_STALE_MS * 2;

/**
 * Einen verwaisten Claim übernehmen — als EINZIGER, und ohne Lücke.
 *
 * Codex-Gegenreview (P0): Hier stand `unlink(lockPath)` gefolgt von einem
 * neuen `open(wx)`. Zwei Fehler in drei Zeilen:
 *
 *   - Mehrere Reclaimer konnten denselben alten Claim gleichzeitig als
 *     verwaist erkennen und ihn danach jeweils blind löschen — einer entfernte
 *     dabei den gerade neu angelegten Lock des anderen. Gemessen: 200 Runden
 *     mit je 16 Reclaimern, 85 Runden mit mehr als einem Gewinner, bis zu drei
 *     gleichzeitig. Mit echten Saves: 11 von 80 Runden mit zwei aktiven
 *     Dateien derselben id.
 *   - Zwischen `unlink` und `open` war der Lock ABWESEND. Ein ganz normaler
 *     Acquirer, der in dieses Fenster lief, hielt den Lock für frei.
 *
 * Beides schließt dieselbe Konstruktion. Die Übernahme wird über eine
 * Markierung serialisiert, deren NAME aus dem Inhalt des verwaisten Claims
 * abgeleitet ist: Genau ein Prozess kann sie mit O_EXCL anlegen, und zwei
 * Reclaimer desselben Claims streiten damit um denselben Pfad. Veröffentlicht
 * wird per `rename` über den bestehenden Lock — der Pfad ist zu keinem
 * Zeitpunkt leer, es gibt also kein Fenster, in dem er frei aussieht.
 *
 * Was das NICHT löst: Ein Reclaimer, der zwischen Prüfung und `rename` länger
 * als {@link RECLAIM_MARK_STALE_MS} stillsteht, kann seine Markierung an einen
 * Nachfolger verlieren. Dafür ist die Lease per Heartbeat gedacht, die noch
 * aussteht — auf geteilten Cloud-Vaults bleibt sie nötig.
 *
 * @returns `true`, wenn dieser Aufrufer den Claim jetzt hält.
 */
async function reclaimStaleClaim(lockPath: string, body: string): Promise<boolean> {
  let stale: string;
  try {
    stale = await readFile(lockPath, "utf8");
  } catch {
    // Weg oder unlesbar: nichts zu übernehmen, was wir belegen könnten.
    return false;
  }
  // Der Name der Markierung IST die Identität des verwaisten Claims. Ein
  // Reclaim für eine andere Generation kollidiert damit nicht, und zwei
  // Reclaims für dieselbe können es nicht vermeiden.
  const markPath = `${lockPath}.reclaim-${createHash("sha256").update(stale).digest("hex").slice(0, 16)}`;
  if (!(await takeReclaimMark(markPath))) return false;
  try {
    // Zwischen dem Lesen oben und der Markierung kann jemand schneller
    // gewesen sein. Dann steht dort ein anderer Claim, und dieser Reclaim ist
    // gegenstandslos.
    const current = await readFile(lockPath, "utf8").catch(() => null);
    if (current !== stale) return false;
    // Per rename statt unlink+create: der Lockpfad trägt durchgehend einen
    // gültigen Claim, erst den alten, dann unseren.
    const tmp = `${lockPath}.${process.pid}.${randomUUID().slice(0, 8)}.take`;
    await writeFile(tmp, body, "utf8");
    try {
      await rename(tmp, lockPath);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    return true;
  } finally {
    await unlink(markPath).catch(() => {});
  }
}

/** Die Markierung nehmen. Eine liegengebliebene (der Reclaimer starb mitten
 *  im Vorgang) würde den Claim sonst dauerhaft unübernehmbar machen — sie
 *  altert deshalb selbst aus. */
async function takeReclaimMark(markPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(markPath, "wx", 0o600);
      await handle.close();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return false;
      if (attempt === 1) return false;
      let ageMs: number;
      try {
        ageMs = Date.now() - (await stat(markPath)).mtimeMs;
      } catch {
        continue; // gerade verschwunden — noch ein Versuch
      }
      if (ageMs <= RECLAIM_MARK_STALE_MS) return false;
      await unlink(markPath).catch(() => {});
    }
  }
  /* c8 ignore next */
  return false;
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
  try {
    const raw = await readFile(lockPath, "utf8");
    const claim = JSON.parse(raw) as CommitClaim;
    if (claim.token !== token) return; // nicht mehr unserer
  } catch {
    // Weg, unlesbar oder unparsebar: nichts davon ist nachweislich unser Lock.
    // Stehen lassen — er altert aus, statt dass wir den eines anderen löschen.
    return;
  }
  await unlink(lockPath).catch(() => {});
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
