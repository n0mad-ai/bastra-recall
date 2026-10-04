/**
 * Gemeinsame Bausteine der Document-Hub-Write-Tools (save/recategorize/move):
 * Pfad-Auflösung, Sidecar-Veröffentlichung per Compare-and-Swap, Frontmatter
 * und Sidecar-Identität. Aus documents-write-handler.ts herausgelöst (#680).
 */
import {
  writeFile,
  readFile,
  unlink,
  rename,
  access,
  link,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import matter from "gray-matter";
import type { Vault } from "@bastra-recall/core";
import {
  assertInsideDir,
  assertOwnSubdir,
} from "@bastra-recall/core";
import { scopeEquals } from "@bastra-recall/core/scope";

// ─── Helpers ────────────────────────────────────────────────────

export const DOCUMENTS_ROOT = "documents";

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isCloudMount(path: string): boolean {
  return /(CloudStorage|Dropbox|iCloud)/i.test(path);
}

export function vaultRoot(vault: Vault): string {
  return vault.root;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Join a caller-supplied folder_path under the documents root and verify the
 * result stays inside it. folder_path is legitimately multi-segment
 * ("Rechnungen/2026"), so we can't ban separators — but `..` segments survive
 * join() unharmed, so a containment check is the only reliable gate against
 * mkdir/copyFile/rename landing outside the vault.
 */
export function resolveDocsFolder(vaultRoot: string, docsRoot: string, folderPath: string): string {
  const folder = folderPath ? join(docsRoot, folderPath) : docsRoot;
  const docsAbs = resolve(docsRoot);
  const folderAbs = resolve(folder);
  if (folderAbs !== docsAbs && !folderAbs.startsWith(docsAbs + sep)) {
    throw new Error(`folder_path escapes the documents folder: ${folderPath}`);
  }
  // Codex-Gegenreview (P0): Die Prüfung war rein lexikalisch. Ein Symlink
  // `dokumente/linked -> /außerhalb` plus `folder_path: "linked"` ging glatt
  // durch — der String beginnt brav mit dem Dokumentenordner, das Dateisystem
  // geht trotzdem woanders hin, und Original wie Sidecar landeten außerhalb
  // des Vaults.
  //
  // Sicherheitsrunde: Die Grenze ist NICHT der Vault, sondern das
  // Dokumentenregal. `dokumente/linked -> ../memories` verlässt den Vault
  // nicht, verlässt aber sehr wohl das Regal — Original und Sidecar landeten
  // damit mitten im Memory-Bestand. Wer eine Grenze meint, muss sie benennen.
  // Sicherheitsrunde, zweite Ebene: Geprüft wurden bisher nur die NACHFAHREN
  // der Grenze — die Grenze selbst musste lediglich irgendwo im Vault liegen.
  // Nachgestellt: `dokumente -> memories` (der Dokumentenordner SELBST ein
  // Symlink auf ein aktives Regal). `assertInsideVault` geht durch, weil das
  // Ziel im Vault liegt, und `assertInsideDir` vergleicht danach Ziel gegen
  // Ziel — jeder `folder_path` gilt als „im Dokumentenordner", und Original
  // wie Sidecar landen mitten im Memory-Bestand.
  //
  // Und es bleibt nicht bei falscher Ablage: Der autoritative Plattenscan der
  // ID-Transaktion steigt nicht in Symlink-Verzeichnisse ab
  // (`Dirent.isDirectory()` ist lstat-basiert). Läge das Dokumentenregal
  // hinter einem Link, wäre JEDES Sidecar darin für `claim.locate()`
  // unsichtbar — die Invariante „eine ID, eine Datei" gölte für Dokumente nur
  // noch auf dem Papier. Der Dokumenten-Root muss deshalb das EIGENE
  // Unterverzeichnis des Vaults sein, dieselbe Zusage wie für `.bastra`. Wer
  // sein Dokumentenregal woanders haben will, sagt das über Konfiguration,
  // nicht über einen Symlink, den kein Aufrufer sieht.
  //
  // Das frühere `assertInsideVault(vaultRoot, docsRoot)` ist damit erledigt:
  // Das eigene Unterverzeichnis des Vaults liegt im Vault, per Definition.
  assertOwnSubdir(vaultRoot, docsRoot, "write a document");
  assertInsideDir(docsRoot, folder, "write a document", "the documents folder");
  return folder;
}

/**
 * Den Bytestand an einem Pfad lesen, ohne einen I/O-Fehler als „da liegt
 * nichts" zu verbuchen. Nur ENOENT beweist, dass der Pfad frei ist; EACCES
 * oder EIO müssen fail-closed nach oben, sonst ginge ein unlesbares Sidecar
 * als leerer Ausgangszustand durch. Gleiches Muster wie `readTarget` in
 * core/save-commit.ts.
 */
export async function readTargetRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/** Frontmatter eines Rohstands, ohne dass ein Parse-Fehler den Aufrufer
 *  wirft — an der Stelle unten ist „unparsbar" schlicht „kein Sidecar". */
export function frontmatterOf(content: string): Record<string, unknown> | undefined {
  try {
    return { ...(matter(content).data as Record<string, unknown>) };
  } catch {
    return undefined;
  }
}

/**
 * Ein Sidecar veröffentlichen: write-to-tmp, Compare-and-Swap, rename.
 *
 * write-to-tmp + rename, damit ein Absturz mitten im Schreiben nie ein
 * zerrissenes Sidecar hinterlässt. Der Tempname trug früher nur die PID — zwei
 * gleichzeitige Writes auf DASSELBE Sidecar (derselbe Prozess, zwei
 * Tool-Calls) benutzten damit dieselbe Tempdatei: der erste rename zog sie
 * weg, der zweite lief ins Leere (ENOENT) und meldete einen Fehler für einen
 * Write, der inhaltlich fertig war. Pro Write ein eigener Name.
 *
 * Codex-Gegenreview (P1): Veröffentlicht wurde OHNE Bytevergleich. Die
 * ID-Transaktion serialisiert nur BASTRA-Writer; Obsidian, ein Cloud-Sync oder
 * ein Nutzer mit einem Editor kennen den Claim nicht, und die mtime-Prüfung in
 * `recategorizeDocument` liegt VOR dem Claim. Nachgestellt ohne `force`: eine
 * externe Änderung, die nach dem Lesen des Sidecars und vor dem rename landet,
 * war danach spurlos weg — und der Call meldete Erfolg. Deshalb werden hier
 * unmittelbar vor der Veröffentlichung noch einmal genau die Bytes geprüft,
 * auf denen der Kandidat gebaut wurde; weichen sie ab, gewinnt der andere
 * Writer und der eigene Vorgang meldet einen Konflikt. Dasselbe Muster wie
 * `commitMemory` (#285) im Save-Pfad für Memories.
 *
 * `preimage === null` heißt „am Pfad lag nichts" — ein gültiger
 * Ausgangszustand (das frisch entstehende Sidecar eines `save_document`), der
 * vom Fall „hat sich geändert" unterscheidbar bleiben muss. Er wird per
 * `link()` statt `rename()` veröffentlicht: rename ersetzt ein inzwischen
 * entstandenes Ziel stillschweigend, link scheitert mit EEXIST.
 *
 * Zu `force` (nur `recategorize_document`): Es heißt „überschreib die externe
 * Bearbeitung bewusst" — der Nutzer hat den Verlust abgenickt —, also hebt es
 * den Vergleich auf. Aber nur, solange die Datei am Pfad nachweislich noch DAS
 * Sidecar dieses Dokuments ist. Liegt dort inzwischen etwas anderes (eine
 * handgeschriebene Notiz, das Sidecar eines fremden Dokuments), ist das kein
 * Konflikt, den jemand abnicken konnte, sondern fremdes Material — dagegen
 * hilft kein Flag. `force` überstimmt eine Bearbeitung, nie eine Identität.
 *
 * Codex-Gegenreview (P0): Der Vergleich lag VOR dem eigentlichen
 * Commit-Fenster. Geprüft wurde, DANN die Tempdatei geschrieben, DANN
 * veröffentlicht — bei einem großen Sidecar liegt zwischen Prüfung und
 * `rename` also das komplette Schreiben der Tempdatei. Nachgestellt: eine
 * externe Änderung, die einsetzt, sobald die Tempdatei erscheint, war danach
 * spurlos überschrieben (`externalSurvived: false`), und der Call meldete
 * Erfolg. Geprüft wird deshalb ZWEIMAL — einmal früh, um billig zu scheitern,
 * und einmal unmittelbar vor der Veröffentlichung, wenn die Tempdatei fertig
 * dasteht. Preis: ein zusätzlicher Sidecar-Read.
 *
 * Was bleibt, wird nicht verschwiegen: Zwischen der späten Prüfung und dem
 * `rename` bleibt ein mikroskopisches Restfenster. Es zuzumachen bräuchte
 * einen atomaren Compare-and-Swap des Dateisystems, den POSIX nicht anbietet.
 * Das Fenster schrumpft von „so lange wie das Schreiben dauert" auf „zwei
 * Syscalls" — es verschwindet nicht.
 */
export async function publishSidecar(
  path: string,
  content: string,
  opts: {
    id: string;
    /** Die Bytes, auf denen der Kandidat gebaut wurde. `null` = Pfad war frei. */
    preimage: string | null;
    /** `undefined`: dieser Aufrufer kennt kein `force` (save, move). */
    force?: boolean;
  },
): Promise<void> {
  const preimage = opts.preimage;
  /**
   * Was gerade an `path` liegt, gegen das Preimage. Gibt den gelesenen Stand
   * zurück, damit der Aufrufer weiß, ob er per `link` (Pfad frei) oder per
   * `rename` (Pfad belegt) veröffentlichen muss.
   */
  const check = async (): Promise<string | null> => {
    const current = await readTargetRaw(path);
    if (current === preimage) return current;
    if (!opts.force) {
      throw new Error(
        `${path} changed on disk while this update was being prepared — something ` +
          `outside Bastra (Obsidian, a sync client, an editor) wrote to it. Nothing ` +
          `was written here, so that edit is still intact. Read the document again ` +
          `(read_document ${opts.id}), redo your change on top of what you get, and ` +
          `write again` +
          (opts.force === false
            ? `. If you mean to discard the external edit, pass force=true.`
            : `.`),
      );
    }
    // Auch spät gilt: `force` heißt „überschreib die fremde BEARBEITUNG", nie
    // „schreib in irgendeine Datei". Wer erst nach der frühen Prüfung eine
    // handgeschriebene Notiz an den Pfad legt, hat dort kein Sidecar mehr
    // liegen, dessen Verlust jemand hätte abnicken können.
    if (current === null || !isDocumentSidecar(frontmatterOf(current), opts.id)) {
      throw new Error(
        `refusing to write ${path} even with force=true: the file there is no longer ` +
          `the sidecar of ${opts.id}` +
          (current === null ? ` — it is gone` : ``) +
          `. force overrides an external EDIT of this document, not a different file ` +
          `at its path. Move that file out of the way, or run without force to see ` +
          `the conflict.`,
      );
    }
    return current;
  };

  await check();
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, content, "utf8");
  try {
    // Die maßgebliche Prüfung: die Tempdatei steht, gleich wird veröffentlicht.
    const current = await check();
    if (current === null) {
      try {
        await link(tmp, path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
          throw new Error(
            `${path} was created by someone else during commit — nothing was written. ` +
              `Read the document again (read_document ${opts.id}) and repeat the change.`,
          );
        }
        throw err;
      }
      await unlink(tmp);
    } else {
      await rename(tmp, path);
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export interface DocumentFrontmatter {
  id: string;
  title: string;
  type: "doc";
  aliases: string[];
  summary: string;
  topic_path: string[];
  tags: string[];
  scope: string;
  recall_when: string[];
  related: string[];
  confidence: number;
  created: string;
  updated: string;
  original_path: string;
  document_category: string;
  linked_file: boolean;
  folder_path: string;
  /** #147: Injection-Marker-Kategorien aus dem Capture-Scan. Nur gesetzt
   *  wenn der Scan anschlug — Review-Surfaces (Vault-Health) lesen es. */
  injection_flags?: string[];
}

/** Exported for tests (pure). */
export function buildFrontmatter(args: {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  category: string;
  recallWhen: string[];
  originalPath: string;
  linkedFile: boolean;
  folderPath: string;
  created: string;
  updated: string;
  /** Bestehende Aliases (User-editiert in Obsidian) — werden übernommen. */
  aliases?: string[];
  /** #147: Kategorien aus dem Capture-Injection-Scan. */
  injectionFlags?: string[];
}): DocumentFrontmatter {
  const topicPath: string[] = ["documents"];
  if (args.folderPath) {
    topicPath.push(...args.folderPath.split("/").filter(Boolean));
  } else {
    topicPath.push(args.category);
  }
  // Obsidian löst [[wikilinks]] gegen die `aliases`-Frontmatter-Liste auf
  // (Standard-Obsidian-Feature). Das Sidecar heißt nach dem Original-File
  // (`<file>.jpg.md`), nicht nach der id — ohne die id als Alias wären die
  // [[<doc-id>]]-Cross-Links des RelatedEnrichers in Obsidian unauflösbar
  // und ein Klick legt eine leere Stray-Note an (#188).
  const existingAliases = args.aliases ?? [];
  const aliases = existingAliases.includes(args.id)
    ? existingAliases
    : [...existingAliases, args.id];
  return {
    id: args.id,
    title: args.title,
    type: "doc",
    aliases,
    summary: args.summary,
    topic_path: topicPath,
    tags: args.tags,
    scope: "documents",
    recall_when: args.recallWhen,
    related: [],
    confidence: 1.0,
    created: args.created,
    updated: args.updated,
    original_path: args.originalPath,
    document_category: args.category,
    linked_file: args.linkedFile,
    folder_path: args.folderPath,
    ...(args.injectionFlags && args.injectionFlags.length > 0
      ? { injection_flags: args.injectionFlags }
      : {}),
  };
}

export function renderSidecar(fm: DocumentFrontmatter, body: string): string {
  return matter.stringify(body, fm as unknown as Record<string, unknown>);
}

// ─── Identität: was darf ein Document-Write überhaupt anfassen ───

/**
 * Ein PRODUKTDOKUMENT aus `save_product_doc` — die lebende Nutzer-Doku unter
 * `dokumentationen/<projekt>/`. Sie trägt `type: doc` wie ein Sidecar, ist
 * aber ein völlig anderes Ding: kein Original-File, kein Documents-Ordner.
 * Ihre Signatur ist der topic_path `["doku", <projekt>, <area>]` (siehe
 * findDocFor in product-doc-handler.ts).
 */
export function isProductDoc(fm: unknown): boolean {
  const f = fm as { type?: unknown; topic_path?: unknown };
  if (f?.type !== "doc") return false;
  const path = f.topic_path;
  return Array.isArray(path) && path.length === 3 && path[0] === "doku";
}

/**
 * Ein Document-Hub-Sidecar — und nur das darf save/recategorize/move
 * überschreiben, verschieben oder umschreiben.
 *
 * `type === "doc"` allein war die Prüfung, und sie war zu weit: eine
 * Produktdoku ging damit glatt durch `recategorize_document` und kam als
 * Sidecar mit `scope: documents` wieder heraus — der Text blieb, das Dokument
 * war weg. Ein Sidecar muss deshalb seine VOLLE Signatur zeigen: den Scope,
 * unter dem der Hub schreibt, und die beiden Felder, über die es sein
 * Original wiederfindet. `expectedId` kommt dazu, wo der Aufrufer weiß,
 * welches Dokument an einem Pfad liegen müsste.
 */
export function isDocumentSidecar(fm: unknown, expectedId?: string): boolean {
  const f = fm as {
    id?: unknown;
    type?: unknown;
    scope?: unknown;
    original_path?: unknown;
    folder_path?: unknown;
  };
  if (f?.type !== "doc") return false;
  // Gefaltet über die zentrale Scope-Identität: ein von Hand auf
  // `scope: Documents` gesetztes Sidecar war sich mit `!==` selbst fremd —
  // der Hub verweigerte seinem eigenen Dokument Move und Recategorize.
  if (typeof f.scope !== "string" || !scopeEquals(f.scope, "documents"))
    return false;
  if (typeof f.original_path !== "string" || f.original_path.length === 0)
    return false;
  if (typeof f.folder_path !== "string") return false;
  if (isProductDoc(f)) return false;
  if (expectedId !== undefined && f.id !== expectedId) return false;
  return true;
}

/**
 * Das Frontmatter, wie es auf der Platte steht — nicht wie der Vault es
 * geparst hat. Genau die Felder, die das Schema wegnormalisiert oder gar
 * nicht kennt, sind die, die ein Metadaten-Patch nicht verlieren darf.
 */
export async function readSidecarRaw(
  path: string,
): Promise<{ data: Record<string, unknown>; body: string; raw: string }> {
  // `raw` ist nicht Dekoration: Genau diese Bytes sind das Preimage des
  // Compare-and-Swap in {@link publishSidecar}. Ein aus `data`/`body` neu
  // gerendertes Vergleichsobjekt wäre wertlos — es zeigte Unterschiede der
  // YAML-Serialisierung an und nicht die des Inhalts.
  const raw = await readFile(path, "utf8");
  const parsed = matter(raw);
  return {
    data: { ...(parsed.data as Record<string, unknown>) },
    body: parsed.content,
    raw,
  };
}

/**
 * Metadaten PATCHEN statt Frontmatter neu bauen.
 *
 * Der Rebuild kannte nur seine eigene Feldliste — alles andere fiel beim
 * Recategorize lautlos raus: die Graph-Kanten des Related-Enrichers
 * (`related`, `related_via`), das Sensitivity-Level, die Provenienz
 * (`source`) und eine von Hand heruntergesetzte `confidence`. Ein
 * Ordnerwechsel ist keine Neuerfassung; er ändert genau die Felder, die er
 * meint.
 */
export function patchSidecarFrontmatter(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({ ...existing, ...patch })) {
    // `undefined` im Patch heißt „Feld entfernen" — der einzige Weg, ein
    // Feld loszuwerden, dessen Wert der Call gerade neu bestimmt hat (die
    // Injection-Flags, wenn der Scan diesmal nichts mehr findet). Ohne die
    // Ausnahme würde js-yaml beim Dump über den undefined-Wert stolpern.
    if (value === undefined) continue;
    // YAML liefert `created: 2026-05-01` als Date zurück; ungefiltert
    // zurückgeschrieben würde daraus ein Zeitstempel mit Uhrzeit.
    out[key] = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  }
  return out;
}

export function renderPatched(fm: Record<string, unknown>, body: string): string {
  return matter.stringify(body, fm);
}

/**
 * Was eine Metadaten-Operation tatsächlich ändern darf.
 *
 * `buildFrontmatter` ERFINDET Werte für Felder, über die ein Ordner- oder
 * Titelwechsel nichts weiß: `related: []`, `confidence: 1.0`, dazu Summary,
 * Trigger und `created` aus dem Vault-geparsten Stand. Nur die Felder, die
 * dieser Call meint, wandern in den Patch; alles andere bleibt, was auf der
 * Platte steht — und `related_via`, `sensitivity`, `source` und der Rest
 * werden gar nicht erst angefasst.
 */
export function metadataPatch(
  existing: Record<string, unknown>,
  rebuilt: DocumentFrontmatter,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    id: rebuilt.id,
    title: rebuilt.title,
    type: rebuilt.type,
    aliases: rebuilt.aliases,
    topic_path: rebuilt.topic_path,
    tags: rebuilt.tags,
    scope: rebuilt.scope,
    updated: rebuilt.updated,
    original_path: rebuilt.original_path,
    document_category: rebuilt.document_category,
    linked_file: rebuilt.linked_file,
    folder_path: rebuilt.folder_path,
  };
  if (rebuilt.injection_flags) patch.injection_flags = rebuilt.injection_flags;
  // Pflichtfelder, die ein hand-editiertes Sidecar verloren haben kann: der
  // Vault repariert sie beim Indexieren, die Datei kennt sie dann nicht.
  for (const field of [
    "summary",
    "recall_when",
    "created",
    "confidence",
  ] as const) {
    if (existing[field] === undefined) patch[field] = rebuilt[field];
  }
  return patch;
}

/**
 * Was ein `save_document(overwrite: true)` gegenüber einem Ordnerwechsel
 * ZUSÄTZLICH meint.
 *
 * Ein Overwrite ist eine Neu-Erfassung derselben Datei, keine Neu-Anlage:
 * Titel, Tags, Kategorie, Summary, Trigger und die frisch gescannten
 * Injection-Flags kommen aus dem Call; `created`, `related`, `related_via`,
 * `sensitivity`, `source`, eine heruntergestufte `confidence` und ein von
 * Hand vergebener Alias gehören der Platte. Basis ist deshalb derselbe
 * {@link metadataPatch} wie bei Recategorize/Move — er lässt genau diese
 * Felder in Ruhe.
 */
export function savePatch(
  existing: Record<string, unknown>,
  rebuilt: DocumentFrontmatter,
): Record<string, unknown> {
  const patch = metadataPatch(existing, rebuilt);
  // Anders als ein Ordnerwechsel bringt der Save beides mit (oder hat es
  // oben aus dem Bestand übernommen) — in jedem Fall der gemeinte Wert.
  patch.summary = rebuilt.summary;
  patch.recall_when = rebuilt.recall_when;
  // #147: Der Capture-Scan ist gerade über Titel, Summary und Body gelaufen.
  // Sein Ergebnis ersetzt das alte auch dann, wenn es leer ist — sonst bliebe
  // ein Flag stehen, dessen Anlass aus dem Dokument verschwunden ist.
  patch.injection_flags = rebuilt.injection_flags;
  return patch;
}
