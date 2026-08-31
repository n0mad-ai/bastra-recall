/**
 * Document-Hub WRITE Tools — `save_document`/`recategorize_document`/
 * `move_document`. Triage Issue #24:
 *
 * - Pro-Feature: Triage will diese hinter Lizenz-Gate. Bis das Pro-License-
 *   Service da ist (separates Issue), gaten wir mit env-Flag
 *   `BASTRA_DOCUMENT_WRITE=1` (Legacy: `NEXUS_DOCUMENT_WRITE`). Tool-Liste
 *   wird komplett ausgeblendet wenn das Flag fehlt — externe MCP-Caller
 *   sehen nur Read-Tools.
 *
 * - Cloud-Watcher-Mitigation: Schreib-Pfad reagiert NICHT auf chokidar
 *   (unzuverlässig auf GoogleDrive/iCloud). Stattdessen sofortiger
 *   `vault.reindexFile(sidecarPath)` nach jedem Write — analog zum
 *   `save_memory`-Pattern. Damit ist `save+find im selben Turn` zuverlässig.
 *   Triage-Acceptance: erfüllt.
 */
import {
  writeFile,
  readFile,
  mkdir,
  copyFile,
  unlink,
  stat,
  rename,
  access,
  link,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, basename, isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";
import matter from "gray-matter";
import type { Vault } from "@bastra-recall/core";
import {
  readOccupant,
  assertInsideDir,
  assertOwnSubdir,
  withIdClaim,
  type IdClaim,
} from "@bastra-recall/core";
import {
  scanForInjection,
  injectionCategories,
  formatInjectionAdvisory,
} from "@bastra-recall/core";
import { truncateSummaryTo, SUMMARY_MAX } from "@bastra-recall/core";
import { scopeEquals } from "@bastra-recall/core/scope";
import {
  openRecoveryJournal,
  type RecoveryJournalHandle,
} from "./recovery-journal.js";
import { qualifyDocumentTriggers } from "./document-triggers.js";

// ─── Argument schemas ───────────────────────────────────────────

const documentCategoryEnum = z.enum([
  "vertrag",
  "rechnung",
  "notiz",
  "code",
  "bild",
  "sonstiges",
]);

export const SaveDocumentArgs = z.object({
  /** Absoluter Pfad der Original-Datei (z.B. ~/Downloads/Vertrag.pdf). */
  original_path: z.string().min(1),
  /** Folder relativ zu `<vault>/documents/`. Leer-String = Root. */
  folder_path: z.string().default(""),
  title: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
  category: documentCategoryEnum,
  /**
   * Wenn true bleibt die Originaldatei am Quellort, das Sidecar trägt nur
   * den Verweis. Default false: Datei wird in `<vault>/documents/<folder>`
   * kopiert.
   */
  linked_file: z.boolean().default(false),
  /** Optional: extrahierter Plain-Text-Body des Sidecars. */
  body: z.string().optional(),
  /**
   * Optional: 1-Satz-Summary. Default = title-based.
   * Kein `.max` hier (analog `save_memory`): eine über-lange Summary wird
   * beim Build codepoint-sicher an der Wortgrenze geclampt, nie rejected —
   * ein `too_big`-Error würde den Caller in einen Retry-Roundtrip zwingen.
   */
  summary: z.string().optional(),
  /** Optional: zusätzliche Recall-Trigger. Default = title + tags. */
  recall_when: z.array(z.string()).optional(),
  /** Default false: existierender Document-Eintrag wirft Fehler. */
  overwrite: z.boolean().default(false),
});

export const RecategorizeDocumentArgs = z.object({
  id: z.string().min(1),
  /** Neuer Folder-Pfad. Wenn gesetzt, wird `move_document`-Logik mitgemacht. */
  folder_path: z.string().optional(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  category: documentCategoryEnum.optional(),
  /**
   * Phase 3.2: wenn das Sidecar extern editiert wurde, blockiert der Daemon
   * den Update. `force=true` überschreibt das Veto explizit.
   */
  force: z.boolean().optional(),
});

export const MoveDocumentArgs = z.object({
  id: z.string().min(1),
  folder_path: z.string().min(1),
});

// ─── Tool definitions ───────────────────────────────────────────

export const documentWriteTools = [
  {
    name: "save_document",
    description:
      "Persist a new document into the user's vault: copy (or link) the " +
      "original file and write a sidecar with frontmatter for retrieval. " +
      "Pair with find_document/read_document afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        original_path: {
          type: "string",
          description: "Absolute path to the source file.",
        },
        folder_path: {
          type: "string",
          description:
            "Target folder relative to documents-root (e.g. 'Verträge/2026'). Empty = root.",
        },
        title: { type: "string", description: "Concise human-readable title." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "1–5 retrieval tags.",
        },
        category: {
          type: "string",
          enum: documentCategoryEnum.options,
          description: "Document category.",
        },
        linked_file: {
          type: "boolean",
          description: "If true, do not copy — keep original at source path.",
        },
        body: { type: "string", description: "Optional extracted plain-text." },
        summary: {
          type: "string",
          description: "Optional 1-sentence summary (<=400 chars).",
        },
        overwrite: {
          type: "boolean",
          description: "If true, replace existing document with same id.",
        },
      },
      required: ["original_path", "title", "tags", "category"],
    },
  },
  {
    name: "recategorize_document",
    description:
      "Update folder, title, tags or category of an existing document. " +
      "Refuses to overwrite externally edited sidecars unless force=true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Document id (slug)." },
        folder_path: {
          type: "string",
          description: "New folder relative to documents-root.",
        },
        title: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        category: { type: "string", enum: documentCategoryEnum.options },
        force: {
          type: "boolean",
          description:
            "If true, override the conflict-detection veto (use when the user explicitly accepts losing the external edit).",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "move_document",
    description:
      "Move a document (original + sidecar) into a different folder. " +
      "The id stays stable; only paths and folder_path-frontmatter change.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Document id (slug)." },
        folder_path: {
          type: "string",
          description: "Target folder relative to documents-root.",
        },
      },
      required: ["id", "folder_path"],
    },
  },
];

// ─── Helpers ────────────────────────────────────────────────────

const DOCUMENTS_ROOT = "documents";
const SLUG_MAX_LEN = 80;

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LEN);
  if (!slug) throw new Error(`cannot slugify: ${JSON.stringify(input)}`);
  return slug;
}

function makeDocId(folderPath: string, filename: string): string {
  const combined = folderPath ? `${folderPath}/${filename}` : filename;
  return `doc-${slugify(combined)}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isCloudMount(path: string): boolean {
  return /(CloudStorage|Dropbox|iCloud)/i.test(path);
}

function vaultRoot(vault: Vault): string {
  return vault.root;
}

async function pathExists(p: string): Promise<boolean> {
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
function resolveDocsFolder(vaultRoot: string, docsRoot: string, folderPath: string): string {
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
async function readTargetRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/** Frontmatter eines Rohstands, ohne dass ein Parse-Fehler den Aufrufer
 *  wirft — an der Stelle unten ist „unparsbar" schlicht „kein Sidecar". */
function frontmatterOf(content: string): Record<string, unknown> | undefined {
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
async function publishSidecar(
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

interface DocumentFrontmatter {
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

function renderSidecar(fm: DocumentFrontmatter, body: string): string {
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
async function readSidecarRaw(
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
function patchSidecarFrontmatter(
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

function renderPatched(fm: Record<string, unknown>, body: string): string {
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
function metadataPatch(
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
function savePatch(
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

// ─── save_document ──────────────────────────────────────────────

export interface SaveDocumentResult {
  id: string;
  sidecar_path: string;
  original_path: string;
  reindexed: boolean;
  cloud_mount_warning?: string;
  /** #147: Capture-Scan-Advisory — geflaggt, nie geblockt. */
  injection_warning?: string;
}

export async function saveDocument(
  vault: Vault,
  args: z.infer<typeof SaveDocumentArgs>,
): Promise<SaveDocumentResult> {
  if (!isAbsolute(args.original_path)) {
    throw new Error(`original_path must be absolute: ${args.original_path}`);
  }
  // #240/A5.2: `stat` statt `access`. Ein Verzeichnis als Quelle kam bis
  // hierher durch, scheiterte erst beim copyFile — und da war die vorhandene
  // Zieldatei bereits gelöscht.
  let sourceStat;
  try {
    sourceStat = await stat(args.original_path);
  } catch {
    throw new Error(`source file not found: ${args.original_path}`);
  }
  if (!sourceStat.isFile()) {
    throw new Error(`source is not a regular file: ${args.original_path}`);
  }

  const root = vaultRoot(vault);
  const docsRoot = join(root, DOCUMENTS_ROOT);
  const folder = resolveDocsFolder(root, docsRoot, args.folder_path);
  await mkdir(folder, { recursive: true });

  const filename = basename(args.original_path);
  const docID = makeDocId(args.folder_path ?? "", filename);

  const sidecarPath = join(folder, `${filename}.md`);
  const originalDest = args.linked_file
    ? args.original_path
    : join(folder, filename);

  // Codex-Gegenreview (P0): Dokumente schrieben ganz an der ID-Transaktion
  // vorbei. Zwei parallele `saveDocument`-Aufrufe für `a+b.pdf` und `a-b.pdf`
  // slugifizieren auf DIESELBE id `doc-a-b-pdf` — beide legten ein Sidecar an,
  // und der Vault lud beim nächsten Start still nur eines davon. Ab hier gilt
  // dieselbe Sperre und dieselbe autoritative Auskunft wie im Save-Pfad.
  return withIdClaim({ vaultRoot: root, id: docID, filePath: sidecarPath, op: "save_document" }, (claim) =>
    commitDocument(claim, vault, args, { root, filename, docID, sidecarPath, originalDest }),
  );
}

/** Der schreibende Teil von {@link saveDocument} — vollständig unter der
 *  ID-Transaktion, damit Kollisionsprüfung, Kopie und Sidecar denselben Vault
 *  sehen. Eigene Funktion statt Closure, damit der Rumpf unverändert bleibt. */
async function commitDocument(
  claim: IdClaim,
  vault: Vault,
  args: z.infer<typeof SaveDocumentArgs>,
  ctx: {
    root: string;
    filename: string;
    docID: string;
    sidecarPath: string;
    originalDest: string;
  },
): Promise<SaveDocumentResult> {
  const { root, filename, docID, sidecarPath, originalDest } = ctx;
  // #240/A5: PREFLIGHT — jede Kollision prüfen, BEVOR irgendetwas mutiert
  // wird. Vorher lief erst der Copy und danach der Sidecar-Check: ein
  // Sidecar-Konflikt meldete einen Fehler und ließ die Kopie trotzdem im
  // Vault zurück (halb ausgeführte Operation).
  if (
    !args.linked_file &&
    (await pathExists(originalDest)) &&
    !args.overwrite
  ) {
    throw new Error(`destination already exists: ${originalDest}`);
  }
  // Der Bestand auf der Platte, sobald ein eigenes Sidecar am Pfad liegt —
  // Grundlage des Metadaten-Patches weiter unten (siehe metadataPatch).
  let existing:
    | { data: Record<string, unknown>; body: string; raw: string }
    | undefined;
  // Der Bytestand, auf dem dieser Kandidat gebaut wird — Preimage des
  // Compare-and-Swap unten. `null` bleibt es, wenn am Pfad nichts liegt: Ein
  // neu entstehendes Sidecar HAT kein Preimage, und das ist ein gültiger
  // Ausgangszustand, kein Konflikt.
  let preimage: string | null = null;
  const occupant = readOccupant(sidecarPath);
  if (occupant.kind !== "absent") {
    if (!args.overwrite) {
      throw new Error(`sidecar already exists: ${sidecarPath}`);
    }
    // `overwrite` heißt „ersetze MEIN Sidecar", nie „ersetze, was da liegt".
    // Eine handgeschriebene Obsidian-Notiz an `<original>.md` wurde vorher
    // vollständig überschrieben, weil allein der Pfad entschied.
    if (occupant.kind === "memory") {
      existing = await readSidecarRaw(sidecarPath);
      preimage = existing.raw;
    }
    if (occupant.kind === "foreign" || !isDocumentSidecar(existing?.data, docID)) {
      throw new Error(
        `refusing to overwrite ${sidecarPath}: not a document sidecar for ${docID}`,
      );
    }
  }
  // `a+b.pdf` und `a-b.pdf` slugifizieren auf DIESELBE id. Entstünden zwei
  // Sidecars mit einer id, behielte der Vault-Index nur eines davon — das
  // andere Dokument wäre still nicht mehr auffindbar.
  //
  // Die Auskunft kommt von der PLATTE, nicht aus `vault.pathsFor()`: Ein
  // Index kann prozessübergreifend veraltet sein und meldet dann `none`,
  // während das fremde Sidecar längst liegt.
  const located = await claim.locate();
  if (located.kind === "incomplete") {
    throw new Error(
      `cannot verify who owns id ${docID}: the vault scan could not read ` +
        `${located.unreadable.join(", ")}. Fix the permissions first — writing now ` +
        `could create a second file with the same id.`,
    );
  }
  const holder = (
    located.kind === "unique"
      ? [located.filePath]
      : located.kind === "ambiguous"
        ? located.filePaths
        : []
  ).find((p) => resolve(p) !== resolve(sidecarPath));
  if (holder) {
    throw new Error(`id ${docID} already belongs to ${holder}`);
  }

  // Codex-Gegenreview (P0): Die Originaldatei wurde ersetzt, BEVOR das Sidecar
  // veröffentlicht war. Nachgestellt mit einer externen Sidecar-Änderung im
  // Commit-Fenster: der Aufruf scheiterte („changed on disk"), das Original war
  // trotzdem schon durch die neue Fassung ersetzt — und die Meldung behauptete
  // „Nothing was written here". Ein Halbzustand, den niemand sieht.
  //
  // Ab hier bleibt die Kopie bis zum geglückten Sidecar-Commit rückrollbar:
  // Beim Overwrite wandert die alte Originaldatei in ein Backup neben dem Ziel,
  // ein NEU entstandenes Original wird im Fehlerfall wieder entfernt. Preis:
  // eine zusätzliche temporäre Datei und ein rename mehr.
  // Gibt `null` zurück, wenn wirklich alles zurückgenommen wurde — sonst den
  // pfadgenauen Text, der dem Aufrufer sagt, was liegen blieb.
  let rollbackOriginal: (() => Promise<string | null>) | undefined;
  let commitOriginal: (() => Promise<void>) | undefined;
  // #378: siehe moveDocumentFiles — der Rollback unten deckt jeden Fehler ab,
  // den dieser Prozess noch erlebt, ein Absturz dazwischen aber nicht.
  let journal: RecoveryJournalHandle | undefined;
  if (!args.linked_file) {
    // #240/A5.1: Same-File-Erkennung. Liegt die Quelle bereits exakt am Ziel
    // (der Normalfall bei einem Metadaten-Refresh — buildFrontmatter schreibt
    // bei linked_file=false den IN-VAULT-Pfad als original_path zurück, und
    // der kommt beim nächsten Aufruf als original_path wieder rein), dann
    // löschte `unlink(originalDest)` die QUELLE und das folgende
    // copyFile(src, src) schlug mit ENOENT fehl. Die Datei war weg.
    if (resolve(args.original_path) === resolve(originalDest)) {
      // Nichts zu kopieren — die Datei ist schon da, wo sie hingehört, und
      // damit gibt es auch nichts zurückzurollen.
    } else {
      // #240/A5.2: erst in eine eindeutige Tempdatei kopieren, dann atomar
      // über das Ziel ziehen. Vorher wurde das Ziel ZUERST gelöscht — schlug
      // der Copy danach fehl, war das alte Dokument unwiederbringlich weg.
      const tmpDest = `${originalDest}.tmp-${randomUUID()}`;
      const backupDest = `${originalDest}.bak-${randomUUID()}`;
      const hadOriginal = await pathExists(originalDest);
      journal = await openRecoveryJournal(root, {
        op: "save_document",
        id: docID,
        steps: [
          ...(hadOriginal ? [{ from: originalDest, to: backupDest }] : []),
          { from: args.original_path, to: originalDest },
        ],
      });
      try {
        await copyFile(args.original_path, tmpDest);
        // Die alte Fassung nicht überschreiben, sondern zur Seite legen —
        // sonst gibt es nichts mehr, worauf man zurückrollen könnte.
        if (hadOriginal) await rename(originalDest, backupDest);
        await rename(tmpDest, originalDest);
      } catch (err) {
        await unlink(tmpDest).catch(() => {});
        if (hadOriginal) await rename(backupDest, originalDest).catch(() => {});
        // #378: Nur quittieren, wenn am Zielpfad wieder der Ausgangszustand
        // steht. Der verschluckte Fehler eine Zeile höher hinterließe sonst
        // genau den Halbzustand, den das Journal benennen soll.
        if ((await pathExists(originalDest)) === hadOriginal) await journal.acknowledge();
        throw err;
      }
      // Codex-Gegenreview Runde 10 (P0-3): Der Rollback entfernte das aktuelle
      // Original BLIND und spielte das Backup blind zurück, Fehler inklusive
      // `.catch(() => {})` verschluckt. Nachgestellt: Bastra ersetzt V1 durch
      // V2, ein externer Writer schreibt V3, der Sidecar-CAS schlägt korrekt
      // fehl — und der Rollback löschte V3 und stellte V1 wieder her. Der
      // Sidecar-Schutz verschob den Datenverlust damit nur auf das Original.
      //
      // Also: nur zurücknehmen, was nachweislich noch UNSERE Fassung ist.
      // Verglichen wird die Datei-Identität direkt nach dem Publish
      // (dev+ino fangen ein Ersetzen, size+mtime eine Änderung am selben
      // Inode). Weicht etwas ab, bleibt die fremde Datei stehen, das Backup
      // bleibt liegen, und der Halbzustand wird ehrlich gemeldet.
      const published = await stat(originalDest).catch(() => null);
      const stillOurs = async (): Promise<boolean> => {
        const now = await stat(originalDest).catch(() => null);
        return (
          published !== null &&
          now !== null &&
          now.dev === published.dev &&
          now.ino === published.ino &&
          now.size === published.size &&
          now.mtimeMs === published.mtimeMs
        );
      };
      rollbackOriginal = async (): Promise<string | null> => {
        if (!(await stillOurs())) {
          return (
            `${originalDest} was changed by someone else after this write — it was left ` +
            `untouched` +
            (hadOriginal ? `, and the previous version is still at ${backupDest}.` : `.`)
          );
        }
        try {
          await unlink(originalDest);
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
            return `${originalDest} could not be removed (${(e as Error).message})` +
              (hadOriginal ? `; the previous version is still at ${backupDest}.` : `.`);
          }
        }
        if (!hadOriginal) return null;
        try {
          await rename(backupDest, originalDest);
        } catch (e) {
          return `the previous version of ${originalDest} could not be put back ` +
            `(${(e as Error).message}) — it is still at ${backupDest}.`;
        }
        return null;
      };
      commitOriginal = hadOriginal
        ? async () => {
            await unlink(backupDest).catch(() => {});
          }
        : undefined;
    }
  }

  // Wird im try unten gesetzt, aber im Ergebnis unten gebraucht.
  let injectionFindings: ReturnType<typeof scanForInjection> = [];
  try {
    const existingSummary =
      typeof existing?.data.summary === "string" ? existing.data.summary : undefined;
    // Ein Refresh ohne `summary` MEINT die Summary nicht — der abgeleitete
    // Default (`kategorie: titel`) hätte eine von Hand geschriebene ersetzt.
    const summary = args.summary ?? existingSummary ?? `${args.category}: ${args.title}`;
    // #289: die Qualifizierung liegt HINTER der Herkunftswahl, nicht in einem
    // ihrer Zweige — der gemessene Schaden kam über mitgeschickte Trigger, nicht
    // über den Default. Warum die Regel so eng gefasst ist: `document-triggers.ts`.
    const recallWhen = qualifyDocumentTriggers(
      args.recall_when ??
        (Array.isArray(existing?.data.recall_when)
          ? (existing.data.recall_when as string[])
          : undefined) ?? [
          `find document ${args.title}`,
          args.tags.slice(0, 3).join(" "),
          `file ${basename(filename, "." + (filename.split(".").pop() ?? ""))}`,
        ].filter(Boolean),
      { title: args.title, category: args.category, tags: args.tags },
    );

    // #147: Dokument-Inhalt ist Third-Party-Content — der Capture-Scan flaggt
    // Injection-Marker (nie blocken: der Flag ist billig, ein verpasster
    // Marker nicht). Kategorien wandern ins Sidecar-Frontmatter, die Advisory
    // in die Tool-Response.
    injectionFindings = scanForInjection(
      [args.title, summary, args.body ?? ""].join("\n"),
    );
    const injectionFlags = injectionCategories(injectionFindings);

    const today = todayISO();
    const fm = buildFrontmatter({
      id: docID,
      title: args.title,
      summary: truncateSummaryTo(summary, SUMMARY_MAX),
      tags: args.tags,
      category: args.category,
      recallWhen,
      originalPath: originalDest,
      linkedFile: args.linked_file,
      folderPath: args.folder_path ?? "",
      created: today,
      updated: today,
      // Ein in Obsidian von Hand vergebener Alias ist Nutzer-Eingabe; der
      // Rebuild kannte nur die id und warf ihn weg.
      aliases: existing?.data.aliases as string[] | undefined,
      injectionFlags: injectionFlags.length > 0 ? injectionFlags : undefined,
    });

    const body = args.body
      ? `> Sidecar für \`${originalDest}\`.\n\n## Extrahierter Inhalt\n\n${args.body}`
      : // Auch der Body ist Bestand: ein Refresh ohne `body` hat keinen Inhalt
        // zu melden, er hat den vorhandenen nicht zu löschen.
        (existing?.body.trim()
          ? existing.body
          : `> Sidecar für \`${originalDest}\`.\n\n_(Kein extrahierter Inhalt — vom Caller nicht mitgeliefert.)_`);

    // Beim Overwrite wird das bestehende Frontmatter GEPATCHT, nicht neu
    // gebaut. Der Rebuild verlor dieselben Felder, die er beim Recategorize
    // verlor — `created`, `related`, `related_via`, `sensitivity`, `source`,
    // eine heruntergestufte `confidence` —, nur hier zusätzlich noch über den
    // Weg, den der Hub seinen Callern selbst als Metadaten-Refresh anbietet.
    const content = existing
      ? renderPatched(
          patchSidecarFrontmatter(existing.data, savePatch(existing.data, fm)),
          body,
        )
      : renderSidecar(fm, body);
    // `save_document` kennt kein `force`: `overwrite` heißt „ersetze den
    // Dokument-Eintrag", nicht „ich habe eine externe Bearbeitung gesehen und
    // will sie loswerden". Der Vergleich gilt hier deshalb ausnahmslos.
    await publishSidecar(sidecarPath, content, { id: docID, preimage });
  } catch (err) {
    // Der Sidecar-Commit ist gescheitert — also darf auch die Kopie nicht
    // stehenbleiben. Erst damit stimmt, was `publishSidecar` dem Aufrufer
    // meldet: dass hier nichts geschrieben wurde. Konnte der Rollback das
    // nicht vollständig, sagt die Meldung es pfadgenau, statt „nichts
    // geschrieben" zu behaupten.
    const stuck = (await rollbackOriginal?.()) ?? null;
    if (stuck !== null) {
      // Halber Zustand — der Eintrag bleibt offen, damit der nächste Start ihn
      // benennt (#378).
      throw new Error(`${(err as Error).message} — AND the original could not be rolled back: ${stuck}`);
    }
    await journal?.acknowledge();
    throw err;
  }
  // Ab hier ist der Vorgang unumkehrbar geglückt: das Backup der alten
  // Originaldatei wird nicht mehr gebraucht.
  await commitOriginal?.();
  await journal?.acknowledge();

  // Cloud-Watcher-Mitigation: synchroner reindex statt auf chokidar warten.
  await vault.reindexFile(sidecarPath);

  const cloudWarn = isCloudMount(root)
    ? "Vault is on a cloud-storage mount (Dropbox/GoogleDrive/iCloud) — using polling watcher; reindex done synchronously."
    : undefined;

  return {
    id: docID,
    sidecar_path: sidecarPath,
    original_path: originalDest,
    reindexed: true,
    cloud_mount_warning: cloudWarn,
    injection_warning: formatInjectionAdvisory(injectionFindings),
  };
}

// ─── recategorize_document ──────────────────────────────────────

export async function recategorizeDocument(
  vault: Vault,
  args: z.infer<typeof RecategorizeDocumentArgs> & { force?: boolean },
): Promise<{ id: string; sidecar_path: string; reindexed: boolean }> {
  const m = vault.get(args.id);
  if (!m) {
    throw new Error(`document not found: ${args.id}`);
  }
  // `type === "doc"` allein reichte, und damit fiel eine PRODUKTDOKU in
  // diesen Pfad: sie kam als Document-Hub-Sidecar mit `scope: documents`
  // wieder heraus, der Text blieb, das Dokument war weg.
  if (!isDocumentSidecar(m.fm)) {
    throw new Error(`not a document sidecar: ${args.id}`);
  }
  // Phase 3.2 Conflict-Detection: wenn das Sidecar zwischen letztem
  // Vault-Read und jetzt extern editiert wurde, refusen wir den Update —
  // sonst überschreiben wir User-Edits aus Obsidian. Caller kann mit
  // `force: true` über das Veto gehen.
  if (!args.force) {
    try {
      const st = await stat(m.filePath);
      if (st.mtimeMs > m.mtime) {
        throw new Error(
          `sidecar was edited externally (mtime ${new Date(st.mtimeMs).toISOString()} > vault ${new Date(m.mtime).toISOString()}). Pass force=true to overwrite.`,
        );
      }
    } catch (err) {
      if ((err as Error).message.startsWith("sidecar was edited")) throw err;
      // stat-Fehler (File weg etc.) → durchlaufen, write-Logik wird erneut prüfen.
    }
  }
  // Codex-Gegenreview (P0): Dieser Pfad las das Sidecar, baute das
  // Frontmatter neu und schrieb es zurück — ohne Sperre und ohne Vergleich.
  // Gemessen: 20 parallele Läufe, einer änderte den Titel, einer die Tags,
  // BEIDE meldeten Erfolg, und in 20 von 20 Läufen blieb nur eine der beiden
  // Änderungen übrig. Ab hier gilt dieselbe Transaktion wie im Save-Pfad: Es
  // gewinnt einer, und der andere erfährt es.
  return withIdClaim(
    { vaultRoot: vaultRoot(vault), id: args.id, filePath: m.filePath, op: "recategorize_document" },
    (claim) => commitRecategorize(claim, vault, args, m),
  );
}

async function commitRecategorize(
  claim: IdClaim,
  vault: Vault,
  args: z.infer<typeof RecategorizeDocumentArgs> & { force?: boolean },
  m: { fm: Record<string, unknown> & { id: string; title: string; tags: string[]; summary: string; recall_when: string[]; created: string }; filePath: string },
): Promise<{ id: string; sidecar_path: string; reindexed: boolean }> {
  const fm = m.fm as typeof m.fm & {
    original_path?: string;
    document_category?: string;
    folder_path?: string;
    linked_file?: boolean;
    aliases?: string[];
    injection_flags?: string[];
  };

  // Wo das Sidecar WIRKLICH liegt — von der Platte, unter dem Lock. Der
  // Index kann veraltet sein, und ein Frontmatter-Patch auf einen veralteten
  // Pfad schreibt in eine Datei, die dieses Dokument nicht mehr ist.
  const located = await claim.locate();
  if (located.kind !== "unique") {
    throw new Error(
      located.kind === "none"
        ? `document not found on disk: ${args.id}`
        : `cannot recategorize ${args.id}: the vault scan is not conclusive (${located.kind}).`,
    );
  }

  // Wenn Folder geändert: erst move (verschiebt Files + Sidecar). Sonst nur
  // Sidecar-Frontmatter aktualisieren.
  const oldSidecarPath = located.filePath;
  let sidecarPath = located.filePath;
  let originalPath = fm.original_path ?? m.filePath.replace(/\.md$/, "");
  let folderPath = fm.folder_path ?? "";
  let moved: MovedDocumentFiles | undefined;

  if (args.folder_path !== undefined && args.folder_path !== folderPath) {
    moved = await moveDocumentFiles(vault, {
      op: "recategorize_document",
      id: m.fm.id,
      sidecarPath,
      originalPath,
      currentFolderPath: folderPath,
      newFolderPath: args.folder_path,
      linkedFile: fm.linked_file ?? false,
    });
    sidecarPath = moved.newSidecarPath;
    originalPath = moved.newOriginalPath;
    folderPath = args.folder_path;
  }

  // Codex-Gegenreview (P0): `vault.forgetFile()` lief FRÜHER — direkt nach dem
  // Move, also bevor die Veröffentlichung geglückt war. Scheiterte der Commit
  // danach, war das Dokument aus dem Index verschwunden UND lag am neuen Ort:
  // ein Halbzustand, den der gemeldete Fehler nicht einmal erwähnte. Index-
  // Umhängen und Reindex passieren erst nach dem Gesamtcommit.
  let raw: { data: Record<string, unknown>; body: string; raw: string } | undefined;
  try {
    const category = args.category ?? fm.document_category ?? "sonstiges";
    // Nur die Felder anfassen, die dieser Call meint. Der frühere Rebuild aus
    // buildFrontmatter warf alles weg, was nicht in seiner Feldliste stand.
    raw = await readSidecarRaw(sidecarPath);
    const rebuilt = buildFrontmatter({
      id: m.fm.id,
      title: args.title ?? m.fm.title,
      summary: m.fm.summary,
      tags: args.tags ?? m.fm.tags,
      category,
      recallWhen: m.fm.recall_when,
      originalPath,
      linkedFile: fm.linked_file ?? false,
      folderPath,
      created: m.fm.created,
      updated: todayISO(),
      aliases: (raw.data.aliases as string[] | undefined) ?? fm.aliases,
      // #147: Capture-Flags überleben den Patch — Metadaten-Ops ändern nie die
      // Provenienz-Bewertung des Inhalts.
      injectionFlags:
        (raw.data.injection_flags as string[] | undefined) ?? fm.injection_flags,
    });
    const updated = patchSidecarFrontmatter(
      raw.data,
      metadataPatch(raw.data, rebuilt),
    );

    // Die mtime-Prüfung oben lief VOR dem Claim und sieht nur, was bis dahin
    // passiert ist. Hier wird gegen die Bytes verglichen, auf denen `updated`
    // und `raw.body` tatsächlich beruhen.
    await publishSidecar(sidecarPath, renderPatched(updated, raw.body), {
      id: m.fm.id,
      preimage: raw.raw,
      force: args.force ?? false,
    });
  } catch (err) {
    if (moved) await abortMove(vault, moved, oldSidecarPath, raw?.raw, err);
    throw err;
  }
  // #378: Beide Dateien liegen am Ziel und das Sidecar ist veröffentlicht — der
  // letzte Schritt ist durch, der Eintrag quittiert.
  await moved?.journal?.acknowledge();

  // #240/A3: the OLD sidecar path must leave the index before the new one
  // enters it. Without this both paths point at the same id; the next
  // reconcile (60 s, or any /vault/count) removes the old path and takes
  // the current memory with it — the document went silently unfindable
  // until a daemon restart. Same fix pattern as tool-handlers.ts:839.
  if (sidecarPath !== oldSidecarPath) vault.forgetFile(oldSidecarPath);
  await vault.reindexFile(sidecarPath);

  return { id: m.fm.id, sidecar_path: sidecarPath, reindexed: true };
}

/**
 * Ein Commit, der nach einem Datei-Move gescheitert ist. Wirft immer.
 *
 * Zwei Ausgänge, und nur einer davon ist der saubere: Trägt der neue
 * Sidecar-Pfad noch genau unsere Bytes, wird der Move komplett zurückgenommen
 * und der ursprüngliche Fehler unverändert weitergereicht — der Zustand ist
 * dann wieder der vor dem Aufruf. Steht dort inzwischen etwas Fremdes, darf
 * kein Rollback es anfassen; dann bleiben die Dateien am neuen Ort, der Index
 * wird darauf umgehängt (sonst zeigte er auf einen leeren Pfad), und der
 * Fehler SAGT, dass der Move steht. Eine Meldung darf nur behaupten, was
 * stimmt.
 */
async function abortMove(
  vault: Vault,
  moved: MovedDocumentFiles,
  oldSidecarPath: string,
  expectedSidecar: string | undefined,
  err: unknown,
): Promise<never> {
  const undone = await moved
    .rollback(expectedSidecar)
    .catch((e: unknown) => ({ ok: false, detail: (e as Error).message }) as MoveRollbackResult);
  if (undone.ok) throw err;
  if (moved.newSidecarPath !== oldSidecarPath) {
    vault.forgetFile(oldSidecarPath);
    await vault.reindexFile(moved.newSidecarPath).catch(() => {});
  }
  throw new Error(
    `${(err as Error)?.message ?? String(err)}\n\n` +
      `Careful: the files had already been moved and the move could NOT be fully undone: ` +
      `${undone.detail ?? "reason unknown"}. The sidecar frontmatter may still name the old ` +
      `folder. Read the document again (read_document) and redo the move.`,
  );
}

// ─── move_document ──────────────────────────────────────────────

export async function moveDocument(
  vault: Vault,
  args: z.infer<typeof MoveDocumentArgs>,
): Promise<{
  id: string;
  sidecar_path: string;
  original_path: string;
  reindexed: boolean;
}> {
  const m = vault.get(args.id);
  if (!m) {
    throw new Error(`document not found: ${args.id}`);
  }
  // Wie im Recategorize: eine Produktdoku ist kein Sidecar und wird hier
  // weder verschoben noch umgeschrieben.
  if (!isDocumentSidecar(m.fm)) {
    throw new Error(`not a document sidecar: ${args.id}`);
  }
  // Dieselbe Transaktion wie beim Recategorize: Ein Move liest, verschiebt und
  // patcht — ohne Sperre trat er sich mit einem gleichzeitigen Metadaten-Patch
  // desselben Dokuments auf die Füße, und beide meldeten Erfolg.
  return withIdClaim(
    { vaultRoot: vaultRoot(vault), id: args.id, filePath: m.filePath, op: "move_document" },
    (claim) => commitMoveDocument(claim, vault, args, m),
  );
}

async function commitMoveDocument(
  claim: IdClaim,
  vault: Vault,
  args: z.infer<typeof MoveDocumentArgs>,
  m: { fm: Record<string, unknown> & { id: string; title: string; tags: string[]; summary: string; recall_when: string[]; created: string }; filePath: string },
): Promise<{
  id: string;
  sidecar_path: string;
  original_path: string;
  reindexed: boolean;
}> {
  const fm = m.fm as typeof m.fm & {
    original_path?: string;
    folder_path?: string;
    linked_file?: boolean;
    aliases?: string[];
    injection_flags?: string[];
  };
  const located = await claim.locate();
  if (located.kind !== "unique") {
    throw new Error(
      located.kind === "none"
        ? `document not found on disk: ${args.id}`
        : `cannot move ${args.id}: the vault scan is not conclusive (${located.kind}).`,
    );
  }

  const moved = await moveDocumentFiles(vault, {
    op: "move_document",
    id: m.fm.id,
    sidecarPath: located.filePath,
    originalPath: fm.original_path ?? located.filePath.replace(/\.md$/, ""),
    currentFolderPath: fm.folder_path ?? "",
    newFolderPath: args.folder_path,
    linkedFile: fm.linked_file ?? false,
  });

  // Codex-Gegenreview (P0): `vault.forgetFile()` lief hier direkt nach dem
  // Move — vor der Veröffentlichung. Scheiterte der Commit, fehlte das
  // Dokument im Index, während Original und Sidecar bereits im Zielordner
  // lagen. Index-Umhängen erst nach dem Gesamtcommit; bis dahin bleibt der
  // Move rückrollbar.
  let raw: { data: Record<string, unknown>; body: string; raw: string } | undefined;
  try {
    // Frontmatter im neuen Sidecar patchen — ein Move ändert Pfade, sonst
    // nichts. Der frühere Rebuild verlor dabei `related`, `related_via`,
    // `sensitivity`, `source` und eine gepflegte `confidence`.
    raw = await readSidecarRaw(moved.newSidecarPath);
    const rebuilt = buildFrontmatter({
      id: m.fm.id,
      title: m.fm.title,
      summary: m.fm.summary,
      tags: m.fm.tags,
      category:
        (fm as { document_category?: string }).document_category ?? "sonstiges",
      recallWhen: m.fm.recall_when,
      originalPath: moved.newOriginalPath,
      linkedFile: fm.linked_file ?? false,
      folderPath: args.folder_path,
      created: m.fm.created,
      updated: todayISO(),
      aliases: (raw.data.aliases as string[] | undefined) ?? fm.aliases,
      // #147: Capture-Flags überleben den Patch — Metadaten-Ops ändern nie die
      // Provenienz-Bewertung des Inhalts.
      injectionFlags:
        (raw.data.injection_flags as string[] | undefined) ?? fm.injection_flags,
    });
    const updated = patchSidecarFrontmatter(
      raw.data,
      metadataPatch(raw.data, rebuilt),
    );
    // `move_document` kennt kein `force` — ein Ordnerwechsel ist nie der Ort,
    // an dem jemand eine fremde Bearbeitung bewusst wegwirft.
    await publishSidecar(moved.newSidecarPath, renderPatched(updated, raw.body), {
      id: m.fm.id,
      preimage: raw.raw,
    });
  } catch (err) {
    await abortMove(vault, moved, located.filePath, raw?.raw, err);
  }
  // #378: Der letzte Schritt ist durch — Eintrag quittiert.
  await moved.journal?.acknowledge();

  // #240/A3: drop the old path from the index before the new one is read —
  // otherwise both paths carry the same id and the next reconcile deletes
  // the moved document.
  if (moved.newSidecarPath !== located.filePath) vault.forgetFile(located.filePath);
  await vault.reindexFile(moved.newSidecarPath);

  return {
    id: m.fm.id,
    sidecar_path: moved.newSidecarPath,
    original_path: moved.newOriginalPath,
    reindexed: true,
  };
}

/**
 * Das Ergebnis eines Datei-Moves — inklusive der Möglichkeit, ihn wieder
 * zurückzunehmen.
 *
 * Codex-Gegenreview (P0): Der Move war endgültig, sobald die beiden `rename`
 * durch waren; scheiterte danach der Sidecar-Commit, blieb ein halber Zustand
 * zurück. Nachgestellt: alter Ordner leer, neuer Ordner mit Original und
 * Sidecar, das Frontmatter zeigte noch auf den alten Ordner, und im
 * Vault-Index fehlte das Dokument ganz (weil `forgetFile` schon gelaufen war).
 * Der Move bleibt deshalb bis zum geglückten Commit rückrollbar.
 */
interface MovedDocumentFiles {
  newSidecarPath: string;
  newOriginalPath: string;
  /**
   * Nimmt den Move zurück. `expectedSidecar` sind die Bytes, die der Aufrufer
   * zuletzt am NEUEN Sidecar-Pfad gesehen hat; ohne Angabe gilt der Stand
   * unmittelbar nach dem Move.
   *
   * Der Vergleich ist kein Luxus: Scheitert der Commit gerade deshalb, weil
   * jemand von außen an den neuen Pfad geschrieben hat, würde ein blindes
   * Zurückbenennen genau diese fremde Bearbeitung mitschleifen — der Fix wäre
   * derselbe Datenverlust in grün.
   *
   * Codex-Gegenreview Runde 10 (P0-4): Verglichen wurde NUR der neue Sidecar.
   * Zwei Reproduktionen:
   *   A) Eine extern am ALTEN Originalpfad entstandene Datei wurde vom
   *      zurückgerollten Bastra-Original ersetzt und ging verloren — `rename`
   *      überschreibt.
   *   B) Der Original-Rollback scheiterte, sein Fehler wurde verschluckt, und
   *      `rollback()` meldete trotzdem `true`: Sidecar wieder im alten Ordner,
   *      Original weiterhin im neuen, Index auf dem alten Sidecar.
   * Deshalb ein Ergebnis PRO DATEI: `ok` nur, wenn Original UND Sidecar
   * verifiziert wieder am alten Ort liegen; sonst sagt `detail` pfadgenau, was
   * wo liegt.
   */
  rollback(expectedSidecar?: string | null): Promise<MoveRollbackResult>;
  /**
   * #378: Der Journal-Eintrag dieses Moves. Fehlt, wenn gar nichts zu bewegen
   * war (linked_file im selben Ordner) — dann gibt es auch keinen halben
   * Zustand, der einen Absturz überleben könnte.
   */
  journal?: RecoveryJournalHandle;
}

export interface MoveRollbackResult {
  /** Der Zustand von vor dem Move ist vollständig wiederhergestellt. */
  ok: boolean;
  /** Was NICHT zurückgenommen werden konnte — pfadgenau. */
  detail?: string;
}

/**
 * Eine Datei bewegen, ohne am Ziel etwas zu ersetzen.
 *
 * Codex-Gegenreview Runde 10 (P0-4): Die Zielprüfungen waren `pathExists` plus
 * ein späteres `rename` — ein zwischenzeitlich entstandenes Ziel wurde damit
 * still überschrieben, auf dem Hinweg wie auf dem Rückweg. `link()` schlägt
 * atomar mit EEXIST fehl; dasselbe Muster wie im Trash und im Save-Pfad.
 * Original und Sidecar liegen beide unter dem Dokumenten-Regal, also auf
 * einem Dateisystem — ein Hardlink ist dort immer möglich.
 */
async function moveExclusive(src: string, dest: string): Promise<void> {
  try {
    await link(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(`target already exists: ${dest}`);
    }
    throw err;
  }
  try {
    await unlink(src);
  } catch (err) {
    // Sonst existierten BEIDE Links — dieselbe Regel wie beim Trash.
    await unlink(dest).catch(() => {});
    throw err;
  }
}

/** Ist an diesem Pfad noch exakt die Datei, die wir dort hingelegt haben? */
function sameFileStat(a: Stats | null, b: Stats | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs
  );
}

async function moveDocumentFiles(
  vault: Vault,
  args: {
    /** #378: für den Journal-Eintrag — welcher Writer, welches Dokument. */
    op: string;
    id: string;
    sidecarPath: string;
    originalPath: string;
    currentFolderPath: string;
    newFolderPath: string;
    linkedFile: boolean;
  },
): Promise<MovedDocumentFiles> {
  const root = vaultRoot(vault);
  const docsRoot = join(root, DOCUMENTS_ROOT);
  const targetFolder = resolveDocsFolder(root, docsRoot, args.newFolderPath);
  await mkdir(targetFolder, { recursive: true });

  const sidecarFilename = basename(args.sidecarPath);
  const originalFilename = basename(args.originalPath);

  const newSidecarPath = join(targetFolder, sidecarFilename);
  const newOriginalPath = args.linkedFile
    ? args.originalPath
    : join(targetFolder, originalFilename);

  // #240/A5.3: BEIDE Ziele prüfen, bevor das erste umbenannt wird. Vorher
  // wanderte das Original erfolgreich ans Ziel und erst danach kollidierte
  // der Sidecar — Ergebnis war ein gemeldeter Fehler bei halb ausgeführtem
  // Move: Original im Zielordner, Sidecar in der Quelle, Frontmatter und
  // Platte widersprachen sich.
  const movesOriginal =
    !args.linkedFile && newOriginalPath !== args.originalPath;
  const movesSidecar = newSidecarPath !== args.sidecarPath;
  if (movesOriginal && (await pathExists(newOriginalPath))) {
    throw new Error(`target original already exists: ${newOriginalPath}`);
  }
  if (movesSidecar && (await pathExists(newSidecarPath))) {
    throw new Error(`target sidecar already exists: ${newSidecarPath}`);
  }

  // #378: VOR dem ersten Move steht auf der Platte, was gleich passiert. Der
  // Rollback unten deckt jeden Fehler ab, den dieser Prozess noch erlebt — ein
  // Absturz dazwischen aber nicht, und danach schaut nichts mehr hin. Nur wenn
  // wirklich etwas bewegt wird: sonst gibt es keinen halben Zustand.
  const journal =
    movesOriginal || movesSidecar
      ? await openRecoveryJournal(root, {
          op: args.op,
          id: args.id,
          steps: [
            ...(movesOriginal ? [{ from: args.originalPath, to: newOriginalPath }] : []),
            ...(movesSidecar ? [{ from: args.sidecarPath, to: newSidecarPath }] : []),
          ],
        })
      : undefined;

  if (movesOriginal) {
    try {
      await moveExclusive(args.originalPath, newOriginalPath);
    } catch (err) {
      // `moveExclusive` räumt seinen eigenen Halbzustand auf — es ist nichts
      // bewegt worden, also gibt es auch nichts zu berichten.
      await journal?.acknowledge();
      throw err;
    }
  }
  if (movesSidecar) {
    try {
      await moveExclusive(args.sidecarPath, newSidecarPath);
    } catch (err) {
      // Der Sidecar-Move ist der zweite Schritt: schlägt er fehl (ENOSPC,
      // EACCES, Cloud-Mount-Stall), das Original zurückrollen, damit kein
      // Split-State zurückbleibt. Scheitert AUCH das, wird es gesagt — vorher
      // verschluckte ein `.catch(() => {})` genau diesen Fall.
      if (movesOriginal) {
        try {
          await moveExclusive(newOriginalPath, args.originalPath);
        } catch (undoErr) {
          // Halber Zustand, und er bleibt es: der Journal-Eintrag wird NICHT
          // quittiert, damit der nächste Start ihn benennt.
          throw new Error(
            `${(err as Error).message} — AND the original could not be moved back: ` +
              `it is at ${newOriginalPath} instead of ${args.originalPath} ` +
              `(${(undoErr as Error).message}).`,
          );
        }
      }
      await journal?.acknowledge();
      throw err;
    }
  }

  // Die Identität direkt nach dem Move: Wer später zurückrollt, muss beweisen
  // können, dass am neuen Pfad noch UNSERE Datei liegt.
  const publishedOriginal = movesOriginal ? await stat(newOriginalPath).catch(() => null) : null;

  // Der Stand direkt nach dem Move — die Erwartung für einen Rollback, dessen
  // Aufrufer gar nicht mehr zum Lesen gekommen ist (ein Fehler zwischen Move
  // und Sidecar-Read). Ein Read auf eine kleine Datei; ohne ihn müsste ein
  // solcher Fehlschlag den Halbzustand stehen lassen.
  let movedBytes: string | null = null;
  if (movesSidecar) {
    try {
      movedBytes = await readTargetRaw(newSidecarPath);
    } catch (err) {
      // Codex-Gegenreview Runde 10 (P0-4): Schlug dieser Read fehl, war
      // bereits verschoben — der Caller bekam aber nie eine Rollback-Funktion
      // und blieb auf dem Halbzustand sitzen. Also hier selbst zurücknehmen.
      const undo: string[] = [];
      try {
        await moveExclusive(newSidecarPath, args.sidecarPath);
      } catch (e) {
        undo.push(`${newSidecarPath} (should be ${args.sidecarPath}): ${(e as Error).message}`);
      }
      if (movesOriginal) {
        try {
          await moveExclusive(newOriginalPath, args.originalPath);
        } catch (e) {
          undo.push(`${newOriginalPath} (should be ${args.originalPath}): ${(e as Error).message}`);
        }
      }
      // Nur der vollständig zurückgenommene Move ist quittierbar.
      if (undo.length === 0) await journal?.acknowledge();
      throw new Error(
        `the moved sidecar could not be read back (${(err as Error).message})` +
          (undo.length > 0
            ? ` AND the move could not be undone. Fix by hand: ${undo.join("; ")}.`
            : ` — the move was undone, nothing was changed.`),
      );
    }
  }

  const rollback = async (
    expectedSidecar: string | null = movedBytes,
  ): Promise<MoveRollbackResult> => {
    const problems: string[] = [];
    if (movesSidecar) {
      // Nur zurückrollen, was auch noch unser Sidecar ist — sonst schleift der
      // Rollback eine fremde Bearbeitung an den alten Pfad.
      const current = await readTargetRaw(newSidecarPath).catch(() => undefined);
      if (current !== expectedSidecar) {
        return {
          ok: false,
          detail:
            `${newSidecarPath} was written by someone else after the move — nothing was ` +
            `rolled back, both files stay in the new folder.`,
        };
      }
      try {
        await moveExclusive(newSidecarPath, args.sidecarPath);
      } catch (e) {
        problems.push(
          `${newSidecarPath} could not go back to ${args.sidecarPath} (${(e as Error).message})`,
        );
      }
    }
    if (movesOriginal) {
      // Dieselbe Frage fürs Original — sie fehlte ganz, und deshalb ersetzte
      // der Rollback eine extern am alten Pfad entstandene Datei.
      if (!sameFileStat(publishedOriginal, await stat(newOriginalPath).catch(() => null))) {
        problems.push(
          `${newOriginalPath} was changed by someone else after the move — it was left there`,
        );
      } else {
        try {
          await moveExclusive(newOriginalPath, args.originalPath);
        } catch (e) {
          problems.push(
            `${newOriginalPath} could not go back to ${args.originalPath} (${(e as Error).message})`,
          );
        }
      }
    }
    if (problems.length > 0) return { ok: false, detail: problems.join("; ") };
    // #378: Der Zustand von vor dem Move steht wieder — also ist die Operation
    // zu Ende und der Eintrag quittierbar. Genau der andere Ausgang ist der,
    // um den es geht: Blieb etwas liegen, bleibt der Eintrag offen.
    await journal?.acknowledge();
    return { ok: true };
  };

  return { newSidecarPath, newOriginalPath, rollback, journal };
}

// ─── Conflict-Detection (Phase 3.2 — basic mtime-Check) ─────────

/**
 * Vergleicht die mtime des Original-Files mit der Cache-mtime im Vault.
 * Wenn die Datei seit dem letzten Vault-Read jünger ist, signalisieren wir
 * einen Conflict — der Caller (UI) entscheidet ob er trotzdem überschreibt.
 */
export async function detectExternalEdit(
  vault: Vault,
  id: string,
): Promise<{ conflict: boolean; reason?: string }> {
  const m = vault.get(id);
  if (!m) return { conflict: false };
  const fm = m.fm as typeof m.fm & { original_path?: string };
  const target = fm.original_path ?? m.filePath;
  let st;
  try {
    st = await stat(target);
  } catch {
    return { conflict: false }; // File weg → kein Konflikt, nur Fehler-Pfad
  }
  if (st.mtimeMs > m.mtime) {
    return {
      conflict: true,
      reason: `file changed externally at ${new Date(st.mtimeMs).toISOString()} (vault mtime ${new Date(m.mtime).toISOString()})`,
    };
  }
  return { conflict: false };
}
