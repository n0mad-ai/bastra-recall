/**
 * `save_document`. Aus documents-write-handler.ts herausgelöst (#680).
 */
import {
  copyFile,
  unlink,
  stat,
  rename,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, basename, isAbsolute, resolve } from "node:path";
import type { z } from "zod";
import type { Vault } from "@bastra-recall/core";
import {
  readOccupant,
  withIdClaim,
  type IdClaim,
} from "@bastra-recall/core";
import {
  scanForInjection,
  injectionCategories,
  formatInjectionAdvisory,
} from "@bastra-recall/core";
import { truncateSummaryTo, SUMMARY_MAX } from "@bastra-recall/core";
import { hiddenFromCaller, type PrivateAccess } from "./private-access.js";
import {
  acknowledgeCommittedJournal,
  openRecoveryJournal,
  type RecoveryJournalHandle,
} from "./recovery-journal.js";
import { qualifyDocumentTriggers } from "./document-triggers.js";
import { recordAudit } from "./audit-trail.js";
import { legacyDocId, makeDocId } from "./document-id.js";
import { ensureVaultDir } from "@bastra-recall/core";
import type { SaveDocumentArgs } from "./documents-write-handler.js";
import {
  DOCUMENTS_ROOT,
  todayISO,
  isCloudMount,
  vaultRoot,
  pathExists,
  resolveDocsFolder,
  frontmatterOf,
  publishSidecar,
  buildFrontmatter,
  renderSidecar,
  isDocumentSidecar,
  readSidecarRaw,
  patchSidecarFrontmatter,
  renderPatched,
  savePatch,
} from "./documents-write-shared.js";

// ─── save_document ──────────────────────────────────────────────

export interface SaveDocumentResult {
  id: string;
  sidecar_path: string;
  original_path: string;
  reindexed: boolean;
  cloud_mount_warning?: string;
  /** #147: Capture-Scan-Advisory — geflaggt, nie geblockt. */
  injection_warning?: string;
  /** #452: gesetzt, wenn der Audit-Eintrag nicht geschrieben werden konnte. */
  warning?: string;
}

export async function saveDocument(
  vault: Vault,
  args: z.infer<typeof SaveDocumentArgs>,
  /** #464: transportgebunden — siehe private-access.ts. */
  caller?: PrivateAccess,
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
  // #892: a save may make a new vault, never recreate one that is not mounted.
  await ensureVaultDir(root, folder, { createRoot: true });

  const filename = basename(args.original_path);
  const sidecarPath = join(folder, `${filename}.md`);
  const originalDest = args.linked_file
    ? args.original_path
    : join(folder, filename);
  let docID = makeDocId(args.folder_path ?? "", filename);
  if (args.overwrite && readOccupant(sidecarPath).kind === "memory") {
    const oldId = legacyDocId(args.folder_path ?? "", filename);
    if (oldId && oldId !== docID) {
      const sidecar = await readSidecarRaw(sidecarPath);
      if (isDocumentSidecar(sidecar.data, oldId)) docID = oldId;
    }
  }

  // Codex-Gegenreview (P0): Dokumente schrieben ganz an der ID-Transaktion
  // vorbei. Zwei parallele `saveDocument`-Aufrufe für `a+b.pdf` und `a-b.pdf`
  // slugifizieren auf DIESELBE id `doc-a-b-pdf` — beide legten ein Sidecar an,
  // und der Vault lud beim nächsten Start still nur eines davon. Ab hier gilt
  // dieselbe Sperre und dieselbe autoritative Auskunft wie im Save-Pfad.
  return withIdClaim({ vaultRoot: root, id: docID, filePath: sidecarPath, op: "save_document" }, (claim) =>
    commitDocument(claim, vault, args, { root, filename, docID, sidecarPath, originalDest }, caller),
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
  caller?: PrivateAccess,
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
    // #464: Es IST das eigene Sidecar — aber wenn es `sensitivity: private`
    // trägt, darf dieser Caller es nicht einmal lesen. Der Check steht im
    // Preflight, vor jedem Copy und jedem Sidecar-Write: die refusete
    // Mutation lässt Bytes und Pfade, wie sie waren.
    if (hiddenFromCaller(caller, existing?.data)) {
      throw new Error(`document not found: ${docID}`);
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
  // #452: das veröffentlichte Sidecar — Nachbild des Audit-Eintrags.
  let published = "";
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
    published = content;
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
  // Cloud-Watcher-Mitigation: synchroner reindex statt auf chokidar warten.
  await vault.reindexFile(sidecarPath);

  const cloudWarn = isCloudMount(root)
    ? "Vault is on a cloud-storage mount (Dropbox/GoogleDrive/iCloud) — using polling watcher; reindex done synchronously."
    : undefined;

  // #452: Dokument-Schreibvorgänge stehen auf demselben Trail wie Memories
  // (#206) — vorher hinterließ ein `save_document --overwrite` keine Spur.
  const auditWarning = await recordAudit({
    vaultRoot: root,
    memoryId: docID,
    operation: preimage === null ? "create" : "update",
    actor: "assistant",
    actorDetail: "mcp:save_document",
    diffBefore: preimage === null ? null : (frontmatterOf(preimage) ?? null),
    diffAfter: frontmatterOf(published) ?? null,
    filePath: sidecarPath,
  });

  const journalWarning = await acknowledgeCommittedJournal(journal);

  return {
    id: docID,
    sidecar_path: sidecarPath,
    original_path: originalDest,
    reindexed: true,
    cloud_mount_warning: cloudWarn,
    injection_warning: formatInjectionAdvisory(injectionFindings),
    ...((auditWarning || journalWarning) ? { warning: [auditWarning, journalWarning].filter(Boolean).join("; ") } : {}),
  };
}
