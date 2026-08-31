import { mkdir, appendFile, readdir, stat, open, link, unlink } from "node:fs/promises";
import { join, dirname, resolve, sep } from "node:path";
import { assertInsideDir, assertOwnSubdir } from "./file-identity.js";
import { readTarget } from "./save-commit.js";
import { MemoryWriteConflictError } from "./save-schema.js";
import { assertRealClaim, type IdClaim } from "./id-transaction.js";
import matter from "gray-matter";
import { occupantOfRaw } from "./memory-locator.js";

/**
 * Audit-Log: jede Memory-Mutation wird als JSON-Zeile in
 * `<vault>/.bastra/audit-log.ndjson` festgehalten.
 *
 * Append-only — keine Datei wird je überschrieben oder gekürzt. Die
 * `.bastra/` Dotfolder wird vom Vault-Watcher ignoriert (siehe vault.ts),
 * deshalb kann sie sicher im Vault-Root liegen ohne Index-Pollution.
 *
 * Datenfluss:
 *   saveMemory / softDeleteMemory / restoreMemory  (Caller, z.B. bridge.ts)
 *       └─→  AuditLog.record(...)
 *               └─→  appendFile(.bastra/audit-log.ndjson)
 *
 * Lese-API (forMemory / since) lädt das ganze File und filtert in-memory.
 * Bei Vaults mit zigtausend Mutationen kann das später durch einen
 * Index ersetzt werden — für heute (low-volume) reicht NDJSON-Scan.
 */

export type AuditOperation = "create" | "update" | "delete" | "restore";

export type AuditActor = "user" | "assistant" | "system" | "import";

export interface AuditEntry {
  /** Eindeutige Audit-Eintrag-ID — `<timestamp-ms>-<rand>`. */
  id: string;
  memory_id: string;
  /** ISO-8601 timestamp mit Millisekunden. */
  timestamp: string;
  actor: AuditActor;
  /** Optional: User-/Session-/Tool-Bezeichner (z.B. Mac-App vs. Claude-Code-Hook). */
  actor_detail?: string;
  operation: AuditOperation;
  /** Frontmatter-Snapshot vor der Mutation (null bei `create`). */
  diff_before: Record<string, unknown> | null;
  /** Frontmatter-Snapshot nach der Mutation (null bei `delete`). */
  diff_after: Record<string, unknown> | null;
  /**
   * Original-Pfad der Memory-Datei. Bei `delete` der Pfad VOR dem Move in den
   * Trash — den wir beim Restore brauchen. Bei `create`/`update` der finale
   * Pfad nach Save.
   */
  file_path?: string;
  /** Pflicht für `assistant`-Mutationen — kurzer Klartext-Grund (1-2 Sätze). */
  reason?: string;
  /** Korreliert mit Telemetry-session-id (UUID v4). */
  session_id?: string;
}

const AUDIT_DIR = ".bastra";
const AUDIT_FILE = "audit-log.ndjson";

export class AuditLog {
  private cache: AuditEntry[] | null = null;
  /** `<mtimeMs>:<size>` der Datei, aus der `cache` stammt — siehe `readAll()`. */
  private cacheKey: string | null = null;

  constructor(public readonly vaultRoot: string) {}

  // ─── public API ───────────────────────────────────────────────

  /** Schreibt einen neuen Audit-Eintrag und invalidiert den Lese-Cache. */
  async record(input: Omit<AuditEntry, "id" | "timestamp"> & {
    id?: string;
    timestamp?: string;
  }): Promise<AuditEntry> {
    const entry: AuditEntry = {
      id: input.id ?? makeAuditID(),
      memory_id: input.memory_id,
      timestamp: input.timestamp ?? new Date().toISOString(),
      actor: input.actor,
      ...(input.actor_detail ? { actor_detail: input.actor_detail } : {}),
      operation: input.operation,
      diff_before: input.diff_before,
      diff_after: input.diff_after,
      ...(input.file_path ? { file_path: input.file_path } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.session_id ? { session_id: input.session_id } : {}),
    };

    const filePath = this.filePath();
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
    this.cache = null;
    this.cacheKey = null;
    return entry;
  }

  /**
   * Alle Einträge (sortiert nach Timestamp aufsteigend), lazy geladen.
   *
   * Das Ledger ist cross-process: Daemon, Bridge und CLI schreiben in
   * dieselbe Datei. Ein Cache, der nur an der Lebensdauer der Instanz hängt,
   * sieht fremde Appends nie — `lastDeleteFor()` findet dann einen Delete
   * nicht, der in der Datei steht, und ein einmal leer gelesenes Log bleibt
   * für den ganzen Prozess leer. Deshalb ist der Cache am Datei-Stand
   * (`mtimeMs` + `size`) gekeyt: ein `stat()` pro Read statt eines
   * Full-Reread, und bei unveränderter Datei trifft der Cache weiterhin.
   */
  async readAll(): Promise<AuditEntry[]> {
    const filePath = this.filePath();
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(filePath, "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        // Nur ENOENT heißt „die Datei ist nicht da". Ein EIO-/EACCES-Blip auf
        // einem Netz- oder Cloud-Mount ist ein LESEFEHLER — dafür einen
        // gültigen Cache wegzuwerfen macht daraus ein falsches Ergebnis:
        // `lastDeleteFor()` gäbe undefined zurück und `auditedRestore` würfe
        // `no delete audit-entry found` für einen Delete, der in der Datei
        // steht. Warm weiterliefern; kalt ehrlich scheitern, statt ein
        // unlesbares Ledger als leeres auszugeben.
        if (this.cache) return this.cache;
        throw err;
      }
      // Datei (noch) nicht vorhanden — bewusst NICHT cachen, sonst bleibt
      // ein Create aus einem anderen Prozess dauerhaft unsichtbar.
      this.cache = null;
      this.cacheKey = null;
      return [];
    }
    // stat + read über denselben Filehandle statt getrennt über den Pfad —
    // ein Replace/Rename zwischen den beiden Schritten kann die Datei unter
    // uns nicht mehr wegziehen (TOCTOU).
    try {
      const st = await handle.stat();
      const key = `${st.mtimeMs}:${st.size}`;
      if (this.cache && this.cacheKey === key) return this.cache;
      const raw = await handle.readFile("utf8");
      const out: AuditEntry[] = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          out.push(JSON.parse(trimmed) as AuditEntry);
        } catch {
          // Korrupte Zeile ignorieren — append-only-Log darf nicht abbrechen.
        }
      }
      out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      this.cache = out;
      this.cacheKey = key;
      return out;
    } finally {
      await handle.close();
    }
  }

  /** Alle Einträge zu einer bestimmten Memory-ID, neueste zuerst. */
  async forMemory(memoryID: string): Promise<AuditEntry[]> {
    const all = await this.readAll();
    return all.filter((e) => e.memory_id === memoryID).reverse();
  }

  /** Einträge ab einem Timestamp, optional gefiltert nach actor/operation. */
  async since(
    sinceISO: string,
    filters: { actor?: AuditActor; operation?: AuditOperation } = {},
  ): Promise<AuditEntry[]> {
    const all = await this.readAll();
    return all
      .filter((e) => e.timestamp >= sinceISO)
      .filter((e) => !filters.actor || e.actor === filters.actor)
      .filter((e) => !filters.operation || e.operation === filters.operation)
      .reverse();
  }

  /** Letzter `delete`-Eintrag einer Memory — für Restore. */
  async lastDeleteFor(memoryID: string): Promise<AuditEntry | undefined> {
    const all = await this.forMemory(memoryID);
    return all.find((e) => e.operation === "delete");
  }

  // ─── internals ────────────────────────────────────────────────

  private filePath(): string {
    return join(this.vaultRoot, AUDIT_DIR, AUDIT_FILE);
  }
}

function makeAuditID(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${t}-${r}`;
}

// ─── Trash-Folder helpers ─────────────────────────────────────────
//
// Soft-Delete: Memory-File wird nach `<vault>/.bastra/trash/<id>.md`
// verschoben. Der Watcher sieht ein "unlink" und entfernt aus dem Index.
// Restore kann die Datei aus dem Trash zurückmoven.

const TRASH_DIR = "trash";

export function trashPathFor(vaultRoot: string, id: string): string {
  const bastraDir = join(vaultRoot, AUDIT_DIR);
  const trashRoot = join(bastraDir, TRASH_DIR);
  const dest = join(trashRoot, `${id}.md`);
  // The id comes from file frontmatter — a crafted `id: ../../x` must not
  // turn the soft-delete rename into a write outside the trash folder.
  if (!resolve(dest).startsWith(resolve(trashRoot) + sep)) {
    throw new Error(`refusing trash path outside the trash folder for id: ${id}`);
  }
  // Sicherheitsrunde: Die Prüfung darüber ist lexikalisch und sieht keinen
  // Symlink. Zeigt `.bastra` oder `.bastra/trash` auf ein AKTIVES Regal, wird
  // aus dem Löschen ein Verschieben in den Bestand — das Memory ist als
  // „gelöscht" gemeldet und weiterhin auffindbar —, und ein Restore holt
  // umgekehrt eine beliebige Vault-Datei an den Originalpfad. Der Trash ist
  // eine eigene Grenze, nicht nur ein Ordner im Vault; deshalb drei Fragen
  // statt einer: liegt `.bastra` im Vault, liegt der Trash in `.bastra`,
  // liegt das Ziel im Trash.
  // Drei Fragen statt einer, jede an das Dateisystem: Ist `.bastra` das eigene
  // Verzeichnis dieses Vaults, ist der Trash das eigene Verzeichnis von
  // `.bastra`, und liegt das Ziel darin?
  //
  // Sicherheitsrunde, zweite Ebene: `.bastra` war geschützt, seine privaten
  // UNTERREGALE nicht. Ein `.bastra/trash -> .bastra/locks` verlässt `.bastra`
  // nicht und kam deshalb durch — gelöschte Memories lägen dann zwischen den
  // Lock-Dateien, und das Aufräumen der einen Sorte nähme die andere mit. Für
  // private Ablage gilt dieselbe Regel wie für `.bastra` selbst: kein Symlink,
  // auch kein nach innen zeigender.
  assertOwnSubdir(vaultRoot, bastraDir, "trash");
  assertOwnSubdir(bastraDir, trashRoot, "trash");
  assertInsideDir(trashRoot, dest, "trash", "the trash folder");
  return dest;
}

/**
 * #240/A4: Trash-Ziele sind versioniert. `trashPathFor()` liefert immer
 * denselben Pfad, ein zweites Löschen derselben id überschrieb also die
 * ältere Trash-Version per rename — still und unwiederbringlich. Das
 * widerspricht der Zusage "recoverable — never a hard delete".
 *
 * Der Basis-Pfad `<id>.md` bleibt der erste Wurf (damit bestehende Trash-
 * Dateien und `lastDeleteFor()`-Lookups weiter funktionieren); jede weitere
 * Version bekommt einen Zeitstempel-Suffix.
 *
 * Die Kandidaten kommen als Folge, nicht als fertiger Pfad: Ausgewählt wird
 * erst durch das ATOMARE Belegen unten. Siehe {@link moveToTrashUnderClaim}.
 */
function* trashCandidates(base: string): Generator<string> {
  yield base;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  yield base.replace(/\.md$/, `.${stamp}.md`);
  // Zwei Löschungen derselben id in derselben Millisekunde — Zähler dran.
  for (let n = 2; n < 1000; n++) {
    yield base.replace(/\.md$/, `.${stamp}-${n}.md`);
  }
}

/**
 * Das Suffix, das `uniqueTrashPath()` an den Basis-Pfad hängt:
 * `2026-08-23T16-20-37-857Z`, bei Kollision in derselben Millisekunde
 * zusätzlich `-<n>`.
 */
const TRASH_VERSION_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/;

/**
 * Neueste Trash-Fassung einer id. Nötig, seit `moveToTrash` versioniert:
 * der Basis-Pfad `<id>.md` ist dann die ÄLTESTE Fassung, und ein Restore,
 * der stur `trashPathFor()` nimmt, holte die falsche zurück.
 */
export async function latestTrashPathFor(
  vaultRoot: string,
  id: string,
): Promise<string | undefined> {
  const base = trashPathFor(vaultRoot, id);
  const trashRoot = dirname(base);
  let entries: string[];
  try {
    entries = await readdir(trashRoot);
  } catch {
    return undefined;
  }
  const baseName = `${id}.md`;
  const versionPrefix = `${id}.`;
  // Ein reines `startsWith(`${id}.`)` matcht über die id-Grenze hinweg: für
  // die id `foo` sah `foo.bar.md` wie eine Zeitstempel-Version von `foo` aus,
  // und ein Restore hätte den Trash-Stand von `foo.bar` auf `foo`s
  // Originalpfad zurückgeschrieben. Gepunktete ids entstehen zwar nie aus
  // `slugify()`, wohl aber aus hand- oder fremdgeschriebenem `id:`-
  // Frontmatter. Der Rest hinter der id muss deshalb exakt das von
  // `uniqueTrashPath()` erzeugte Stempel-Format tragen — über `slice()`
  // geprüft, damit die id selbst nicht escaped werden muss.
  const candidates = entries.filter((e) => {
    if (e === baseName) return true;
    if (!e.startsWith(versionPrefix) || !e.endsWith(".md")) return false;
    return TRASH_VERSION_STAMP.test(e.slice(versionPrefix.length, -".md".length));
  });
  if (candidates.length === 0) return undefined;
  const withTime = await Promise.all(
    candidates.map(async (name) => {
      const full = join(trashRoot, name);
      try {
        return { full, mtime: (await stat(full)).mtimeMs };
      } catch {
        return { full, mtime: -1 };
      }
    }),
  );
  withTime.sort((a, b) => b.mtime - a.mtime);
  return withTime[0].full;
}

/**
 * Eine Datei in den Trash bewegen — NUR unter dem Anspruch auf ihre id.
 *
 * Codex-Gegenreview (P0), zwei Defekte in einem:
 *
 * 1. Die Pfadwahl war `existsSync` + `rename`. Nachgestellt mit zwei
 *    parallelen Aufrufen für dieselbe id: Beide sahen den Basis-Pfad frei,
 *    beide benannten dorthin um, der zweite Rename ERSETZTE den ersten —
 *    `settled: ["fulfilled","fulfilled"]`, im Trash lag nur Inhalt B. Eine
 *    Fassung war weg, in einer Operation, deren ganze Zusage
 *    „recoverable — never a hard delete" ist. Belegt wird deshalb atomar:
 *    `link()` schlägt mit EEXIST fehl, wenn der Kandidat schon existiert,
 *    also gewinnt genau ein Aufrufer je Pfad. Dasselbe O_EXCL-Muster wie im
 *    Save-Pfad (`link(tmp, filePath)`) und in `restoreFromTrashUnderClaim`.
 *
 * 2. Die Funktion war öffentlich exportiert und nahm eine nackte id entgegen —
 *    jeder Aufrufer konnte ohne die ID-Transaktion eine Datei wegbewegen. Der
 *    `claim` ist deshalb Parameter, nicht Konvention: Wer ihn hat, hält den
 *    Lock; die id kommt aus ihm und kann nicht mehr danebenliegen.
 *
 * 3. Codex-Gegenreview Runde 10 (P0-5): Der `claim` bewies nur, dass IRGENDEIN
 *    id-Lock gehalten wurde — nicht, dass er zu `filePath` gehört.
 *    Nachgestellt mit einem echten Claim für A und dem Pfad von B: A blieb
 *    aktiv, B verschwand aus dem Bestand, und im Trash lag unter `a.md` der
 *    Inhalt von B. Die Primitive prüft die Bindung deshalb selbst: Die Datei
 *    MUSS erkennbar das Memory des Claims halten.
 *
 * 4. Codex-Gegenreview Runde 10 (P1-4): Delete und Archive lasen ihr
 *    Audit-Vorbild in einem eigenen Read und übergaben es NICHT — zwischen
 *    Beweis-Read und Trash-Move konnte eine neue externe Fassung eintreffen:
 *    verschoben wurde die neue, protokolliert die alte. Hier wird EINMAL roh
 *    gelesen, und aus genau diesen Bytes kommen Identitätsprüfung, CAS und das
 *    zurückgegebene `frontmatter` fürs Audit. Ein Vorbild, das nicht aus der
 *    verschobenen Fassung stammt, gibt es damit nicht mehr.
 *
 * @param expectedPreimage Die Bytes, die die Datei tragen MUSS. Weggelassen =
 *   keine Prüfung. Damit liegen Prüfung und Rename direkt beieinander — das
 *   Fenster dazwischen ist ein Read plus ein Link, mikroskopisch, aber NICHT
 *   null: Ein externer Writer (Obsidian, Cloud-Sync) kennt den id-Lock nicht
 *   und kann genau dort noch dazwischenschreiben. Kleiner wird es nur mit
 *   einem Vergleich, den das Dateisystem selbst atomar mitführt — den gibt es
 *   für Markdown-Dateien nicht.
 */
export interface TrashMoveResult {
  /** Wo die Fassung im Trash liegt. */
  trashPath: string;
  /** Die Rohbytes, die verschoben wurden. */
  preimage: string;
  /** Das Frontmatter EBEN DIESER Fassung — der einzige ehrliche `diff_before`. */
  frontmatter: Record<string, unknown>;
}

export async function moveToTrashUnderClaim(
  vaultRoot: string,
  filePath: string,
  claim: IdClaim,
  expectedPreimage?: string | null,
): Promise<TrashMoveResult> {
  // #381: Die Marke, bevor irgendetwas bewegt wird. Ohne sie hielt niemand den
  // Lock, auf den sich alles Weitere hier verlässt.
  assertRealClaim(claim, "moveToTrashUnderClaim");
  const id = claim.id;
  const raw = await readTarget(filePath);
  if (raw === null) {
    throw new MemoryWriteConflictError(id, filePath, "the file disappeared before it could be trashed");
  }
  if (expectedPreimage !== undefined && raw !== expectedPreimage) {
    throw new MemoryWriteConflictError(id, filePath, "the file changed before it could be trashed");
  }
  // Die Bindung, die der Claim allein nicht herstellt: Dieser Pfad muss DIESES
  // Memory halten. Ohne sie war `claim` nur ein Beweis, dass irgendwo ein Lock
  // liegt, und der Aufrufer bestimmte allein, welche Datei verschwindet.
  const occupant = occupantOfRaw(raw, filePath);
  if (occupant.kind !== "memory" || occupant.id !== id) {
    throw new Error(
      `refusing to trash ${filePath}: it does not hold memory '${id}' ` +
        `(found ${occupant.kind === "memory" ? `'${occupant.id}'` : occupant.kind}). ` +
        `The id claim proves a lock, not which file it belongs to — re-resolve the path.`,
    );
  }
  const frontmatter = JSON.parse(JSON.stringify(matter(raw).data)) as Record<string, unknown>;
  const base = trashPathFor(vaultRoot, id);
  await mkdir(dirname(base), { recursive: true });
  for (const dest of trashCandidates(base)) {
    try {
      await link(filePath, dest);
    } catch (err) {
      // Belegt — nächster Kandidat. Jeder andere Fehler gehört nach oben.
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") continue;
      throw err;
    }
    try {
      await unlink(filePath);
    } catch (err) {
      // Sonst existierten BEIDE Links: die Datei im aktiven Bestand und die
      // im Trash. Erst zurücknehmen, dann ehrlich scheitern — dieselbe Regel
      // wie beim Restore unten.
      await unlink(dest).catch(() => {});
      throw err;
    }
    return { trashPath: dest, preimage: raw, frontmatter };
  }
  throw new Error(`could not find a free trash path for id: ${id}`);
}

/**
 * Eine Trash-Fassung zurückholen — NUR unter dem Anspruch auf ihre id;
 * `claim` ist aus demselben Grund Parameter wie oben.
 */
export async function restoreFromTrashUnderClaim(
  vaultRoot: string,
  trashFile: string,
  destFile: string,
  claim: IdClaim,
): Promise<void> {
  // #381: wie oben — der Restore schreibt in den aktiven Bestand zurück und
  // braucht den Anspruch auf die id genauso.
  assertRealClaim(claim, "restoreFromTrashUnderClaim");
  // #240/A4: ein blankes rename() überschrieb eine bereits wieder aktive
  // Datei am Zielpfad — beobachtet: eine laufende Bearbeitung wurde still
  // durch den Trash-Stand ersetzt. Restore darf niemals Daten vernichten;
  // der Konflikt gehört dem Caller gemeldet, nicht weggeschrieben.
  //
  // Codex-Gegenreview (P0): Geprüft wurde per `existsSync` und danach
  // umbenannt — zwischen Prüfung und Rename lag ein Fenster, in dem die Datei
  // entstehen konnte, und der Rename ersetzte sie doch. `link()` schlägt
  // atomar mit EEXIST fehl, wenn am Ziel schon etwas liegt; erst danach wird
  // die Trash-Fassung entfernt. Trash und Vault liegen auf demselben
  // Dateisystem, ein Hardlink ist dort immer möglich.
  await mkdir(dirname(destFile), { recursive: true });
  try {
    await link(trashFile, destFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(
        `refusing to restore over an existing file: ${destFile}. ` +
          `Move or delete it first — restoring would overwrite the active version.`,
      );
    }
    throw err;
  }
  // Codex-Gegenreview: Scheitert das `unlink`, existieren BEIDE Links — die
  // aktive Datei und die im Trash —, und Restore meldete trotzdem einen
  // Fehler. Der Aufrufer sah „nicht wiederhergestellt", im Vault lagen aber
  // zwei Dateien mit einer id. Also zurücknehmen, was gerade veröffentlicht
  // wurde; erst danach ist der Fehlschlag ein ehrlicher Fehlschlag.
  try {
    await unlink(trashFile);
  } catch (err) {
    await unlink(destFile).catch(() => {});
    throw err;
  }
}
