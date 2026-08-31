/**
 * Grabsteine für Areas: Welcher Regalname gehört keiner lebenden Area mehr?
 *
 * Codex-Gegenreview (P0): Ein Area-Rename verschiebt das ganze Regal und
 * schreibt danach die Scopes um. Die Nachprüfung am Ende ERKENNT zwar ein
 * Memory, das den alten Scope behalten hat — sie kann aber nichts gegen einen
 * Save tun, der WÄHREND oder NACH dem Rename mit dem alten Scope kommt.
 * Nachgestellt:
 *
 *   1. `renameArea(carnexus → neu)` startet, das vorhandene Memory ist schon
 *      umgezogen.
 *   2. Ein Save mit `scope: carnexus` legt `memories/projects/carnexus` neu an.
 *   3. Der Rename meldet Erfolg — und danach existieren beide Regale.
 *
 * Eine Marke, die nur „Rename läuft gerade" sagt, reicht dagegen nicht: Der
 * stale Save kann beliebig lange nach dem Rename eintreffen, etwa aus einer
 * Agent-Session, die den alten Projektnamen noch im Kontext hat. Der alte Name
 * muss deshalb DAUERHAFT als vergeben-und-fortgezogen registriert bleiben, bis
 * ihn jemand bewusst wieder in Betrieb nimmt (`createArea` mit demselben
 * Namen).
 *
 * Bewusst kein Lock, sondern ein Grabstein: Ein Lock müsste gegen den ID-Claim
 * in eine Ordnung gebracht werden und wäre nach einem Absturz wieder ein
 * Freigabeproblem. Ein Grabstein ist ein Fakt — er altert nicht, er braucht
 * keine Freigabe, und ein Absturz mitten im Rename lässt ihn stehen, was
 * genau die sichere Richtung ist: Der alte Name bleibt gesperrt, bis jemand
 * hinsieht.
 *
 * Die Marke liegt unter `.bastra/areas/`, also in der privaten Daemon-Ablage,
 * für die dieselben Regeln gelten wie für Trash und Locks: eigenes
 * Unterverzeichnis, kein Symlink.
 */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { assertInsideDir, assertOwnSubdir } from "./file-identity.js";
import { acquireCommitClaim, claimIsAbandoned, releaseCommitClaim } from "./save-commit.js";
import { newOperationId, reportMutationIncident } from "./mutation-incident.js";
import { normalizeScopeKey } from "./scope.js";

const AUDIT_DIR = ".bastra";
const AREAS_DIR = "areas";

/** Was mit einem Regalnamen passiert ist. */
export interface AreaMark {
  kind: "renamed" | "deleted";
  /** Der Name, der nicht mehr gilt — kanonisch. */
  from: string;
  /** Wohin er gezogen ist. Nur bei `renamed`. */
  to?: string;
  /** ISO-Zeitpunkt, damit eine Meldung sagen kann, wann das passiert ist. */
  ts: string;
}

/**
 * Wo die Marke für einen Regalnamen liegt.
 *
 * Der Name wird gehasht statt eingesetzt: Ein Scope darf Zeichen tragen, die
 * `isPathSafeComponent` durchlässt, auf einem anderen Dateisystem aber
 * unbrauchbar sind — dieselbe Begründung wie beim Commit-Lock.
 */
function markPathFor(vaultRoot: string, name: string): string {
  const bastraDir = join(vaultRoot, AUDIT_DIR);
  const areasDir = join(bastraDir, AREAS_DIR);
  assertOwnSubdir(vaultRoot, bastraDir, "mark an area");
  assertOwnSubdir(bastraDir, areasDir, "mark an area");
  const digest = createHash("sha256").update(normalizeScopeKey(name)).digest("hex").slice(0, 32);
  const path = join(areasDir, `${digest}.json`);
  assertInsideDir(areasDir, path, "mark an area", "the areas folder");
  return path;
}

/** Die Marke zu diesem Regalnamen — `null`, wenn der Name frei ist. */
export async function readAreaMark(vaultRoot: string, name: string): Promise<AreaMark | null> {
  let raw: string;
  try {
    raw = await readFile(markPathFor(vaultRoot, name), "utf8");
  } catch (err) {
    // Nur „gibt es nicht" beweist, dass der Name frei ist. Ein Lesefehler ist
    // eine offene Frage und darf nicht als Freigabe durchgehen — dieselbe
    // fail-closed-Regel wie überall sonst im Schreibpfad.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new Error(
      `cannot tell whether the area '${name}' is still in use ` +
        `(${(err as NodeJS.ErrnoException)?.code ?? String(err)}) — refusing to guess.`,
    );
  }
  try {
    return JSON.parse(raw) as AreaMark;
  } catch {
    // Unlesbarer Inhalt: Der Name IST markiert, wir wissen nur nicht wie.
    // Auch das ist fail-closed zu behandeln.
    return { kind: "deleted", from: normalizeScopeKey(name), ts: "unknown" };
  }
}

/** Marke setzen — atomar, damit ein Absturz keine halbe Datei hinterlässt. */
async function writeMark(vaultRoot: string, name: string, mark: AreaMark): Promise<void> {
  const path = markPathFor(vaultRoot, name);
  await mkdir(join(vaultRoot, AUDIT_DIR, AREAS_DIR), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(mark), "utf8");
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Der alte Name eines umbenannten Regals ist ab jetzt vergeben. */
export async function markAreaRenamed(
  vaultRoot: string,
  oldName: string,
  newName: string,
): Promise<void> {
  await writeMark(vaultRoot, oldName, {
    kind: "renamed",
    from: normalizeScopeKey(oldName),
    to: normalizeScopeKey(newName),
    ts: new Date().toISOString(),
  });
}

/** Der Name eines gelöschten Regals ist ab jetzt vergeben. */
export async function markAreaDeleted(vaultRoot: string, name: string): Promise<void> {
  await writeMark(vaultRoot, name, {
    kind: "deleted",
    from: normalizeScopeKey(name),
    ts: new Date().toISOString(),
  });
}

/**
 * Den Namen wieder in Betrieb nehmen. Ausdrücklich NUR für den Fall, dass
 * jemand die Area bewusst neu anlegt — ein Grabstein verfällt nicht von
 * selbst.
 *
 * Codex-Gegenreview Runde 10 (P1-1): Hier stand ein `.catch(() => {})`, das
 * JEDEN Fehler schluckte, nicht nur „gibt es nicht". Nachgestellt: `createArea`
 * meldete Erfolg, der Ordner stand da — und weil der Grabstein nicht gelöscht
 * werden konnte (EACCES auf `.bastra/areas`), verweigerte `assertAreaWritable`
 * danach jeden Save in eine nachweislich lebende Area. Ein Grabstein, den
 * niemand mehr abräumen kann, ist eine dauerhafte Sperre; nur ENOENT beweist,
 * dass nichts mehr abzuräumen war.
 */
export async function clearAreaMark(vaultRoot: string, name: string): Promise<void> {
  try {
    await unlink(markPathFor(vaultRoot, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw new Error(
      `the area '${name}' is live again, but its tombstone could not be removed ` +
        `(${(err as NodeJS.ErrnoException)?.code ?? String(err)}) — every save into '${name}' ` +
        `would keep failing. Fix the permissions on .bastra/areas and retry.`,
    );
  }
}

/**
 * Darf in dieses Regal geschrieben werden? Wirft, wenn der Name fortgezogen
 * oder gelöscht ist.
 *
 * Wird im Save-Pfad UNTER dem ID-Claim gerufen: Der Grabstein ist ein Fakt auf
 * der Platte, also braucht er keine eigene Sperre und keine Ordnung gegenüber
 * dem Claim — er wird gelesen wie jede andere autoritative Auskunft auch.
 */
export async function assertAreaWritable(vaultRoot: string, scope: string): Promise<void> {
  const mark = await readAreaMark(vaultRoot, scope);
  if (mark === null) return;
  if (mark.kind === "renamed") {
    throw new Error(
      `the area '${scope}' was renamed to '${mark.to}'${mark.ts !== "unknown" ? ` on ${mark.ts.slice(0, 10)}` : ""} — ` +
        `save with scope '${mark.to}' instead. Writing to the old name would recreate the shelf ` +
        `that was just moved away. If you really want '${scope}' back as a separate area, ` +
        `create it explicitly first.`,
    );
  }
  throw new Error(
    `the area '${scope}' was deleted${mark.ts !== "unknown" ? ` on ${mark.ts.slice(0, 10)}` : ""} — ` +
      `writing to it would silently revive it. Create it explicitly first if that is what you want.`,
  );
}

/**
 * ─── Der Area-Claim ────────────────────────────────────────────────────────
 *
 * Codex-Gegenreview Runde 10 (P0-1/P0-2): Der Grabstein oben löst die
 * HISTORISCHE Namensfrage — „diesen Regalnamen gibt es nicht mehr" —, aber er
 * ist keine gegenseitige Ausschließung. Nachgestellt:
 *
 *   1. `assertAreaWritable("carnexus")` im Save-Pfad sagt ja.
 *   2. Danach setzt ein Rename den Grabstein und verschiebt das Regal.
 *   3. Der Save läuft weiter und veröffentlicht im ALTEN Regal — beide
 *      existieren, `outcome: fulfilled`.
 *
 * Zwischen Prüfung und Publish liegen Target-Read, Parsing, Frontmatter-Aufbau,
 * Tempdatei und Rename; die frühere Behauptung „Syscall-Abstand" stimmte nicht.
 * Und zwei parallele Renames desselben Namens schrieben beide ihren Grabstein,
 * sodass in 12 von 12 Läufen die Marke auf das Ziel des VERLIERERS zeigte.
 *
 * Also ein echter Lock — aber ein GETEILTER, sonst wäre der Preis falsch: Zwei
 * Saves in dasselbe Projekt dürfen sich nicht gegenseitig blockieren, sie
 * ändern das Regal ja nicht. Deshalb ein Reader-Writer-Schema auf dem
 * Dateisystem:
 *
 *   - Save nimmt einen SHARED-Claim (`withAreaShared`): eine Markierung im
 *     `readers`-Ordner, danach die Frage „liegt ein exklusiver Lock?".
 *   - Create/Rename/Delete nehmen einen EXKLUSIVEN Claim
 *     (`withAreaExclusive`): erst den Lock per O_EXCL, danach die Frage „ist
 *     der readers-Ordner leer?".
 *
 * Die Reihenfolge (erst eintragen, dann die Gegenseite prüfen) ist auf beiden
 * Seiten dieselbe und genau das, was das Schema trägt: Kreuzen sich beide,
 * SIEHT jeder den anderen und beide treten zurück — nie schreiben beide. Der
 * Save wiederholt seinen Versuch ein paar Mal, weil die Area-Operation
 * zurücktritt; die Area-Operation meldet dem Nutzer einen Konflikt, weil sie
 * ohnehin eine bewusste, seltene Handlung ist.
 *
 * REIHENFOLGE GEGENÜBER DEM ID-CLAIM: Area-Claim IMMER zuerst, ID-Claim darin.
 * Ein Rename nimmt die Claims für Quell- und Zielnamen sortiert, damit zwei
 * gekreuzte Renames (`a→b`, `b→a`) nicht ineinander laufen. Deadlock-frei ist
 * das ohnehin, weil kein Erwerb blockiert — er scheitert sofort.
 *
 * Was das NICHT löst: ein externer Writer (Obsidian, Cloud-Sync) kennt diese
 * Locks nicht. Gegen den hilft nur der Grabstein plus die Nachprüfung.
 */

const LOCKS_DIR = "locks";

/** Wo der exklusive Lock und der readers-Ordner eines Regalnamens liegen. */
function areaLockPaths(vaultRoot: string, name: string): { lock: string; readers: string } {
  const bastraDir = join(vaultRoot, AUDIT_DIR);
  const locksDir = join(bastraDir, LOCKS_DIR);
  assertOwnSubdir(vaultRoot, bastraDir, "claim an area");
  assertOwnSubdir(bastraDir, locksDir, "claim an area");
  const digest = createHash("sha256").update(normalizeScopeKey(name)).digest("hex").slice(0, 32);
  const lock = join(locksDir, `area-${digest}.lock`);
  const readers = join(locksDir, `area-${digest}.readers`);
  assertInsideDir(locksDir, lock, "claim an area", "the locks folder");
  assertInsideDir(locksDir, readers, "claim an area", "the locks folder");
  return { lock, readers };
}

function claimBody(): string {
  return JSON.stringify({
    pid: process.pid,
    host: hostname(),
    ts: Date.now(),
    token: randomUUID(),
  });
}

/**
 * Liegt ein LEBENDER exklusiver Lock auf diesem Namen?
 *
 * Fail-closed wie überall im Schreibpfad: Nur „gibt es nicht" (ENOENT, von
 * `claimIsAbandoned` als verwaist gemeldet) beweist, dass frei ist.
 */
async function exclusiveHeld(lockPath: string): Promise<boolean> {
  try {
    await stat(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    return true;
  }
  return !(await claimIsAbandoned(lockPath));
}

/**
 * Wird dieses Regal gerade exklusiv gehalten (#382)?
 *
 * Für den einen Aufrufer, der ein Regal erst ERFÄHRT, wenn er den Area-Claim
 * längst genommen hat: Der autoritative Plattenscan unter dem ID-Claim kann
 * eine Quelle in einem Regal finden, das die Routing-Auskunft nicht kannte.
 * Nachträglich mitzusperren ist keine Option — die globale Reihenfolge ist
 * Area vor ID, und ein Reader, der nach der Leerprüfung eines exklusiven
 * Erwerbers einträgt, ist genau das Fenster, das das Protokoll ausschließt.
 *
 * Fragen kann man trotzdem. Diese Auskunft ist deshalb ausdrücklich KEIN
 * Anspruch: Sie sagt, ob in diesem Moment jemand exklusiv arbeitet, und
 * erlaubt dem Save, zurückzutreten statt in eine laufende Umbenennung zu
 * schreiben. Ein Rename, der eine Mikrosekunde SPÄTER beginnt, bleibt
 * unentdeckt — das Restfenster wird kleiner, nicht null.
 */
export async function areaExclusivelyHeld(vaultRoot: string, name: string): Promise<boolean> {
  const { lock } = areaLockPaths(vaultRoot, name);
  return exclusiveHeld(lock);
}

/** Alle LEBENDEN Reader dieses Namens. Verwaiste werden gleich mitgeräumt. */
async function liveReaders(readersDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(readersDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw new Error(
      `cannot tell whether saves are in flight for this area ` +
        `(${(err as NodeJS.ErrnoException)?.code ?? String(err)}) — refusing to guess.`,
    );
  }
  const live: string[] = [];
  for (const e of entries) {
    const full = join(readersDir, e);
    // Dieselbe Besitzer-vor-Alter-Regel wie beim Commit-Claim: Ein lebender
    // lokaler Prozess ist ein Beweis, das Alter nur ein Indiz. Ein Save, der
    // per SIGKILL starb, darf eine Area nicht dauerhaft unumbenennbar machen.
    if (await claimIsAbandoned(full)) {
      await unlink(full).catch(() => {});
      continue;
    }
    live.push(full);
  }
  return live;
}

/** Wie oft ein Save es erneut versucht, wenn er sich mit einer Area-Operation
 *  gekreuzt hat. Die Gegenseite tritt zurück, also genügen wenige Runden. */
const SHARED_RETRIES = 5;
const SHARED_RETRY_MS = 20;


/**
 * Welches Regal wird an diesem Pfad wirklich beschrieben?
 *
 * Codex-Abschlussprüfung (P0-2): Der Save sperrte seinen `scope`. Das
 * PHYSISCHE Ziel kann aber ein anderes Regal sein — `folder` ist eine
 * Anweisung, die `subfolderFor()` übergeht. Bestätigt: Bei gehaltenem
 * exklusivem Lock auf `people` lief `saveMemory({ scope: "carnexus", folder:
 * "memories/people" })` glatt durch, und ein Top-Rename `people → personen`
 * war damit weiterhin nicht gegen Saves in `memories/people` serialisiert.
 *
 * Der Schlüssel kommt deshalb aus dem aufgelösten Pfad, nicht aus dem Scope:
 *
 *   memories/projects/<p>/…   → <p>
 *   dokumentationen/<p>/…     → <p>
 *   memories/<top>/…          → <top>
 *
 * `null` heißt „kein Area-Regal" (`bookmarks/`, `documents/`, eine Datei
 * direkt in `memories/`) — dort gibt es nichts zu serialisieren, weil kein
 * Rename und kein Delete diese Pfade bewegt.
 */
export function areaKeyForPath(vaultRoot: string, filePath: string): string | null {
  const rel = relative(vaultRoot, filePath).split(sep);
  // Ausserhalb des Vaults (`..`) ist keine Area — die Containment-Prüfung des
  // Aufrufers hat dazu ohnehin das letzte Wort.
  if (rel.length === 0 || rel[0] === "" || rel[0] === "..") return null;
  // Der Schlüssel muss ein ORDNER sein: `memories/projects/x.md` ist eine Datei
  // im Projektregal-Elternordner, kein Regal namens `x.md`.
  const at = (i: number): string | null =>
    rel.length > i + 1 && rel[i] !== "" ? normalizeScopeKey(rel[i]) : null;
  if (rel[0] === "memories") return rel[1] === "projects" ? at(2) : at(1);
  if (rel[0] === "dokumentationen") return at(1);
  return null;
}

/**
 * Eine Reader-Markierung entfernen — und wenn das nicht geht, sie wenigstens
 * entwerten (#379).
 *
 * WARUM DAS NICHT SCHWEIGEN DARF. Hier stand `unlink(path).catch(() => {})`.
 * Bleibt eine Markierung liegen, trägt sie die pid DIESES noch laufenden
 * Prozesses — `claimIsAbandoned` verweigert die Freigabe also völlig zu Recht,
 * und der Vault hält einen Save für aktiv, den es nicht gibt. Jedes Rename,
 * Delete und Create auf diesem Regal scheitert danach mit „saves are writing
 * into …", bis der Prozess endet. Ein verschluckter Fehler wurde so zu einer
 * Blockade, die niemand erklären konnte.
 *
 * ZWEI STUFEN, weil eine nicht reicht. Melden allein ließe den Vault blockiert
 * zurück, nur eben mit Begründung. Deshalb wird die Markierung, wenn sie sich
 * nicht löschen lässt, ENTWERTET: Ein Body ohne pid fällt in
 * `claimIsAbandoned` auf die Altersregel zurück und verfällt nach dem
 * bestehenden Fenster. Das schwächt die Zusage „ein lebender Besitzer wird nie
 * enteignet" NICHT — entwertet wird ausschließlich die eigene Markierung, und
 * erst nachdem `fn` fertig ist.
 *
 * Scheitert auch das (der Repro-Fall des Issues ist ein schreibgeschützter
 * readers-Ordner), bleibt nur die Meldung. Dann ist die Blockade echt, und
 * wenigstens steht sie als Ereignis da statt als Rätsel.
 */
async function releaseReaderMarker(path: string, area: string): Promise<void> {
  try {
    await unlink(path);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return; // schon weg
  }
  let entwertet = false;
  try {
    // Kein pid-Feld: damit greift die Altersregel statt der Besitzerregel.
    await writeFile(path, JSON.stringify({ released: true, ts: Date.now() }), {
      encoding: "utf8",
      mode: 0o600,
    });
    entwertet = true;
  } catch {
    /* auch das ging nicht — bleibt die Meldung */
  }
  reportMutationIncident({
    operation_id: newOperationId(),
    op: "area_shared",
    status: entwertet ? "rolled_back" : "partial",
    phase: "reader-marker-release",
    detail: entwertet
      ? "marker could not be removed, expires by age"
      : "marker stuck, area blocked until restart",
  });
  console.error(
    `[bastra-recall] area '${area}': a reader marker could not be removed — ` +
      (entwertet
        ? "it will expire by age."
        : "renames, deletes and creates on this area will fail until the process restarts."),
  );
}

/**
 * Den Namen für die Dauer von `fn` MITBENUTZEN — ein Save, der ins Regal
 * schreibt, ohne es zu verändern.
 */
export async function withAreaShared<T>(
  vaultRoot: string,
  names: (string | null)[],
  fn: () => Promise<T>,
): Promise<T> {
  // Sortiert und dedupliziert wie beim exklusiven Claim: Ein Re-File berührt
  // ZWEI Regale (Quelle und Ziel), und zwei Saves in gekreuzter Richtung
  // dürfen nicht jeweils die Hälfte halten. `null` ist kein Regal.
  const wanted = [...new Set(names.filter((n): n is string => n !== null).map(normalizeScopeKey))].sort();
  if (wanted.length === 0) return fn();
  const shelves = wanted.map((name) => ({ name, ...areaLockPaths(vaultRoot, name) }));
  for (const s of shelves) await mkdir(s.readers, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    const markers = shelves.map((s) => ({ shelf: s, path: join(s.readers, `${randomUUID()}.json`) }));
    const body = claimBody();
    for (const m of markers) await writeFile(m.path, body, { encoding: "utf8", mode: 0o600 });
    // ERST eintragen, DANN prüfen — nur so kann die Gegenseite uns sehen.
    let blockedBy: string | null = null;
    for (const s of shelves) {
      if (await exclusiveHeld(s.lock)) {
        blockedBy = s.name;
        break;
      }
    }
    if (blockedBy === null) {
      try {
        return await fn();
      } finally {
        for (const m of markers) await releaseReaderMarker(m.path, m.shelf.name);
      }
    }
    for (const m of markers) await releaseReaderMarker(m.path, m.shelf.name);
    if (attempt >= SHARED_RETRIES) {
      throw new Error(
        `the area '${blockedBy}' is being renamed, deleted or created right now — ` +
          `nothing was written. Retry in a moment.`,
      );
    }
    await new Promise((r) => setTimeout(r, SHARED_RETRY_MS));
  }
}

/**
 * Die Namen für die Dauer von `fn` EXKLUSIV halten — Create, Rename, Delete.
 *
 * Mehrere Namen (ein Rename braucht Quelle UND Ziel) werden sortiert
 * erworben, damit zwei gekreuzte Renames nicht jeweils die Hälfte halten.
 */
export async function withAreaExclusive<T>(
  vaultRoot: string,
  names: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const wanted = [...new Set(names.map((n) => normalizeScopeKey(n)))].sort();
  const held: { lock: string; token: string }[] = [];
  const opId = newOperationId();
  try {
    for (const name of wanted) {
      const { lock, readers } = areaLockPaths(vaultRoot, name);
      await mkdir(dirname(lock), { recursive: true });
      // Codex-Abschlussprüfung (P0-1): Hier stand ein ZWEITER, eigener
      // Reclaim-Algorithmus — `claimIsAbandoned()` gefolgt von einem
      // ungeschützten `rename(tmp, lock)`. Nachgestellt mit 30 Runden à 16
      // Konkurrenten auf demselben verwaisten Lock: 30 von 30 fehlerhaft, alle
      // 16 gleichzeitig im exklusiven Abschnitt. Nach einem Crash war
      // `withAreaExclusive` also nicht exklusiv.
      //
      // Der Vault hat genau EINE korrekte Übernahme-Konstruktion, und sie steht
      // in `acquireCommitClaim()`: O_EXCL, und für den verwaisten Fall eine
      // Reclaim-Markierung, deren NAME aus dem Inhalt des alten Claims
      // abgeleitet ist — zwei Reclaimer streiten damit um denselben Pfad, und
      // veröffentlicht wird per `rename` über den bestehenden Lock, sodass der
      // Pfad nie leer aussieht. Ein Lock-Mechanismus, zwei Aufrufer.
      let token: string;
      try {
        token = await acquireCommitClaim(lock, `area:${name}`, lock);
      } catch (err) {
        // #377: Area-Konflikte wurden bisher nirgends protokolliert. Ein
        // einzelner ist der Normalfall einer funktionierenden Sperre — häufen
        // sie sich, ist das ein Befund, und ohne Ereignis sieht ihn niemand.
        reportMutationIncident({
          operation_id: opId,
          op: "area_exclusive",
          status: "conflict",
          phase: "area-claim",
          detail: "held by another operation",
        });
        throw new Error(
          `another area operation is running on '${name}' — nothing was changed. ` +
            `Retry in a moment. (${(err as Error).message})`,
        );
      }
      held.push({ lock, token });
      // ERST der Lock, DANN die Reader — spiegelbildlich zu `withAreaShared`.
      const readersLive = await liveReaders(readers);
      if (readersLive.length > 0) {
        reportMutationIncident({
          operation_id: opId,
          op: "area_exclusive",
          status: "conflict",
          phase: "area-claim-readers",
          detail: `${readersLive.length} save(s) in flight`,
        });
        throw new Error(
          `${readersLive.length} save(s) are writing into '${name}' right now — ` +
            `nothing was changed. Retry in a moment.`,
        );
      }
    }
    return await fn();
  } finally {
    // `releaseCommitClaim` gibt nur den EIGENEN Lock frei: Wurde er
    // zwischenzeitlich als verwaist eingesammelt, gehört er jemand anderem und
    // bleibt stehen.
    for (const h of held.reverse()) await releaseCommitClaim(h.lock, h.token);
  }
}
