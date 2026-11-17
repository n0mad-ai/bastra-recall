/**
 * The deciding half of a save: target, collision, tombstone, occupant,
 * template, frontmatter and file content — everything before the first byte
 * is written. Split out of save.ts for #1484: `previewMemory` (save_memory
 * `dry_run`) has to run exactly the checks the real save runs and show exactly
 * the content it would write, so both call the same function instead of a
 * preview keeping its own copy that drifts.
 */
import matter from "gray-matter";
import { CLOUD_OFFLINE_GUIDANCE } from "./cloud-placeholder.js";
import { SUMMARY_MAX } from "./summary.js";
import type { SaveMemoryInput, SaveMemoryCommitOptions } from "./save-schema.js";
import { assertBodyTail } from "./save-schema.js";
import { buildFrontmatter } from "./save-frontmatter.js";
import { readTarget, writeConflict } from "./save-commit.js";
import { sameFile } from "./file-identity.js";
import { normalizeScopeKey } from "./scope.js";
import { resolveMemoryTarget } from "./save-target.js";
import { assertVaultCanStartSave } from "./vault-root-guard.js";
import { areaKeyForPath, assertAreaWritable } from "./area-claim.js";
import { readOccupant, scanVaultForId, scanVaultForIdAsync, vaultRelative, type Located } from "./memory-locator.js";

export const SUMMARY_TRUNCATED_NOTE =
  `summary was auto-truncated to ${SUMMARY_MAX} chars; ` +
  `write it shorter next time (the full text lives in the body, not the summary).`;

/**
 * Wohnt diese id bereits woanders im Vault?
 *
 * `located` kommt aus der ID-Transaktion und damit von der PLATTE. Vorher
 * fragte diese Prüfung den injizierten Locator — im Daemon also den geladenen
 * Vault-Index. Stammte der aus einem anderen Prozess und war veraltet, meldete
 * er `none`, obwohl die id längst irgendwo lebte, und zwei Saves derselben id
 * in verschiedene Regale gelangen beide. Ein Lock um eine falsche Antwort
 * herum serialisiert nur den Fehler.
 */
function assertIdIsNotClaimedElsewhere(
  vaultRoot: string,
  id: string,
  filePath: string,
  overwrite: boolean,
  located: Located
): void {
  // Ein Scan mit blindem Fleck darf nicht als „die id ist frei" durchgehen:
  // Hinter dem Ordner, den er nicht öffnen konnte, kann dasselbe Memory
  // liegen, und der Save legte daneben ein zweites File mit derselben id an —
  // genau der stille Defekt aus #240/A2.3, nur ohne dass ihn jemand sieht.
  if (located.kind === "incomplete") {
    throw new Error(
      `cannot verify where memory '${id}' lives: the vault scan could not read ` +
        `${located.unreadable.map((p) => vaultRelative(vaultRoot, p)).join(", ")}. ` +
        (located.cloudOnly?.length
          ? `${located.cloudOnly.length} files are only in the cloud (not downloaded). ${CLOUD_OFFLINE_GUIDANCE} `
          : `Restore read access to the files and folders before saving. `) +
        `Writing now could create a second file with the same id.`
    );
  }
  // Ein `ambiguous` ist ein Vault-Defekt (#240/A2.3), keine Wahlmöglichkeit:
  // Der Index nimmt still eine der Dateien, und ein Save, der die andere
  // trifft, lässt die Kopie unverändert stehen. Lieber laut abbrechen.
  if (located.kind === "ambiguous") {
    throw new Error(
      `memory '${id}' exists in more than one file: ` +
        `${located.filePaths.map((p) => vaultRelative(vaultRoot, p)).join(", ")}. ` +
        `Remove or rename all but one before saving — the index silently loads only one of them.`
    );
  }
  // Dieselbe id an einem ANDEREN Ort ist eine Kollision, kein freier Platz.
  // Ohne diese Prüfung legten zwei Saves derselben id in zwei `folder`-Regalen
  // beide erfolgreich eine Datei an, und nach dem nächsten Neustart lud der
  // Vault nur die alphabetisch erste.
  //
  // Mit `overwrite` ist es dagegen ein bewusstes Re-Filing (#64): Der Caller
  // benennt DIESES Memory und einen neuen Ort dafür. Das Aufräumen der alten
  // Datei liegt bei ihm — `tool-handlers.ts` trasht sie, sobald der Pfad sich
  // geändert hat, und warnt, wenn das misslingt.
  //
  // `sameFile` statt Stringvergleich: Auf einem case-insensitiven Dateisystem
  // ist der Fund unter anderer Schreibweise DIESELBE Datei, keine Kollision.
  if (!overwrite && located.kind === "unique" && !sameFile(located.filePath, filePath)) {
    throw new Error(
      `memory already exists: ${id} (at ${vaultRelative(vaultRoot, located.filePath)}). ` +
        `Saving it to ${vaultRelative(vaultRoot, filePath)} would create a second file with the ` +
        `same id — pass the existing folder, or pick a different id.`
    );
  }
}

/** The file this save lands in, after the collision and tombstone checks. */
async function settleTargetPath(
  vaultRoot: string,
  input: SaveMemoryInput,
  target: { id: string; filePath: string; scope: string },
  located: Located
): Promise<string> {
  const { id, filePath: filePath0, scope } = target;
  // Codex-Gegenreview (P0): Der Zielpfad kam aus dem injizierten Locator, also
  // im Daemon aus dem Vault-Index — und der darf veraltet sein. War die Datei
  // extern von `memories/projects/p/` nach `memories/people/` gezogen, routete
  // der Save weiter auf den alten Pfad, und die autoritative Auskunft las die
  // Abweichung als bewusstes Re-Filing: Am Ende lagen zwei aktive Dateien mit
  // einer id.
  //
  // Die Unterscheidung, die vorher fehlte: Ein vom Index ABGELEITETER Ordner
  // ist kein Re-File-Auftrag. Nur ein ausdrücklich übergebener `folder` ist
  // einer. Ohne ihn gewinnt deshalb die Platte — sie weiß, wo das Memory
  // wirklich liegt.
  const filePath =
    input.folder === undefined && located.kind === "unique" && !sameFile(located.filePath, filePath0)
      ? located.filePath
      : filePath0;

  assertIdIsNotClaimedElsewhere(vaultRoot, id, filePath, input.overwrite === true, located);

  // Gehört der Zielscope überhaupt noch einer lebenden Area? Ein Grabstein
  // unter `.bastra/areas/` sagt: Dieser Regalname ist umgezogen oder gelöscht.
  // Nachgestellt (siehe area-claim.ts): Ein Save mit dem ALTEN Scope kam nach
  // dem Rename an und legte das gerade weggezogene Regal einfach neu an —
  // danach existierten beide. Die Prüfung steht UNTER dem Claim und vor jedem
  // Schreibvorgang: Der Grabstein ist ein Fakt auf der Platte, also wird er
  // gelesen wie die autoritative Auskunft daneben.
  await assertAreaWritable(vaultRoot, scope);
  // Und dasselbe für das Regal, in das wirklich geschrieben wird: Ein
  // ausdrücklicher `folder` kann auf ein ANDERES Projektregal zeigen als der
  // Scope, und dessen Grabstein blieb dann ungelesen (dieselbe Klasse wie
  // P0-2, nur auf der Grabstein-Achse statt auf der Lock-Achse).
  const shelf = areaKeyForPath(vaultRoot, filePath);
  if (shelf !== null && shelf !== normalizeScopeKey(scope)) {
    await assertAreaWritable(vaultRoot, shelf);
  }
  return filePath;
}

/** Wer am Ziel liegt, entscheidet, ob überhaupt geschrieben werden darf. */
function assertOccupantIsThisMemory(vaultRoot: string, filePath: string, id: string): void {
  const occupant = readOccupant(filePath);
  // Unlesbar ist nicht frei: Wer die Datei nicht lesen kann, kann auch nicht
  // behaupten, sie gehöre ihm. Ohne diesen Zweig war eine gewöhnliche Notiz
  // mit Dateimodus 000 ungeschützt — die Prüfung sah `absent`.
  if (occupant.kind === "unreadable") {
    throw new Error(
      `refusing to overwrite ${vaultRelative(vaultRoot, filePath)}: the file exists but ` +
        `cannot be read (${occupant.reason}), so it cannot be shown to be memory '${id}'. ` +
        `Fix its permissions, or move it out of the way.`
    );
  }
  if (occupant.kind === "foreign") {
    throw new Error(
      `refusing to overwrite ${vaultRelative(vaultRoot, filePath)}: it is not a memory ` +
        `(no valid memory frontmatter). Pick a different id, or move that file out of the way.`
    );
  }
  if (occupant.kind === "memory" && occupant.id !== id) {
    throw new Error(
      `refusing to overwrite ${vaultRelative(vaultRoot, filePath)}: it holds memory ` +
        `'${occupant.id}', not '${id}'. Two memories cannot share one file.`
    );
  }
}

/** Das Frontmatter der Vorlage, Date-Werte zurück in ISO-Tage. */
function parseTemplate(baseRaw: string | null): Record<string, unknown> {
  let prev: Record<string, unknown> = {};
  if (baseRaw !== null) {
    try {
      // Copy, don't alias: gray-matter caches matter(content) by string, so the
      // object handed back here is shared with every other parse of identical
      // content. The Date coercion below writes into `prev` — without this copy
      // it would poison that cache entry and hand a later parser a string where
      // the file says Date. Same reasoning as related-enrich.ts:230 and
      // trigger-expand.ts:322.
      prev = { ...((matter(baseRaw).data as Record<string, unknown> | undefined) ?? {}) };
    } catch {
      // Corrupt frontmatter is replaced only after the raw file itself was
      // captured above; the commit comparison still protects that preimage.
    }
  }
  // YAML 1.1 hands a bare `created: 2026-05-01` back as a JS `Date`, and the
  // bare form is exactly what Obsidian Properties and a hand edit write. The
  // carry-over below tests for a string, so a Date failed every check: the
  // refresh restamped `created` to today and dropped `valid_until` /
  // `last_reviewed_at` from the file — the #240/A6 loss, reachable through the
  // vault's own editor. `schema.ts` already coerces on the read path; the write
  // path has to do the same before the type checks see the value.
  // `updated` fehlt hier bewusst: es wird nie aus `prev` gelesen, `updated: today`
  // stempelt es bei jedem Schreibvorgang neu.
  for (const key of ["created", "valid_until", "last_reviewed_at"]) {
    const value = prev[key];
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      prev[key] = value.toISOString().slice(0, 10);
    }
  }
  return prev;
}

/** What a save would write and where — everything `commitMemory` decides
 *  before the first byte lands. Shared with {@link previewMemory} (#1484), so
 *  a preview runs exactly the checks the real save runs. */
export interface MemoryWritePlan {
  filePath: string;
  observedTarget: string | null;
  exists: boolean;
  refiledFrom: string | null;
  baseRaw: string | null;
  auditBefore: Record<string, unknown> | null;
  fm: Record<string, unknown>;
  content: string;
  summaryTruncated: boolean;
}

/**
 * Der Teil des Saves, der nur liest und entscheidet: Ziel, Kollision,
 * Grabstein, Belegung, Vorlage, Frontmatter, Dateiinhalt. Unter der
 * ID-Transaktion aufgerufen von `commitMemory`, ohne sie von `previewMemory`.
 */
export async function planMemoryWrite(
  vaultRoot: string,
  input: SaveMemoryInput,
  commit: Pick<SaveMemoryCommitOptions, "expectedTarget" | "precondition" | "originEvidence">,
  target: { id: string; filePath: string; scope: string },
  located: Located
): Promise<MemoryWritePlan> {
  const { id, scope } = target;
  const filePath = await settleTargetPath(vaultRoot, input, target, located);

  const observedTarget = await readTarget(filePath);
  const exists = observedTarget !== null;

  // Wer am Ziel liegt, entscheidet, ob überhaupt geschrieben werden darf.
  // Vorher galt „belegt = das ist mein Memory", und daraus wurden drei
  // Datenverlust-Pfade: eine gewöhnliche Obsidian-Notiz am kanonischen
  // Zielpfad wurde bei `overwrite: true` ersetzt, ein FREMDES Memory am
  // selben Pfad wurde überschrieben und dabei auf die neue id umgeschrieben,
  // und eine Notiz mit einem zufälligen YAML-Feld `id` galt als Memory.
  // `overwrite` ist die Erlaubnis, DIESES Memory zu ersetzen — nie die,
  // irgendeine Datei zu ersetzen.
  if (exists) assertOccupantIsThisMemory(vaultRoot, filePath, id);

  if (commit.expectedTarget !== undefined && commit.expectedTarget !== observedTarget) {
    throw writeConflict(id, filePath, "target changed after the caller inspected it");
  }
  if (exists && !input.overwrite) {
    throw new Error(
      `memory already exists: ${id}. Pass overwrite=true to replace it, ` + `or pick a different title/id.`
    );
  }

  // #240/A6: Overwrite ist ein PATCH, kein Replace. Ein Save schickt nur die
  // Felder, die er ändern will — alles andere muss den Refresh überleben.
  // Vorher wurde das Frontmatter aus dem Input neu gebaut, sodass jedes
  // Agent-Overwrite `created`, `sensitivity`, `confidence`, `source`,
  // `valid_until`, `affects_files`, … still auf Defaults zurücksetzte. Das
  // ist der häufigste Schreibvorgang überhaupt (der Skill schreibt Updates
  // per overwrite=true vor), und die Verluste sind teils nicht regenerierbar.
  //
  // Löschen bleibt ausdrückbar: `?? ` greift nur bei *fehlendem* Feld, ein
  // explizit übergebenes `[]` / null-Wert schlägt weiterhin durch.
  //
  // Historie der Einzelfall-Pflaster, die das hier ersetzt: #188 aliases,
  // #158 write_origin, #217 salience/emotion/recall_mode.
  //
  // Und die Vorlage ist die QUELLE, nicht das Ziel. Codex-Gegenreview (P0):
  // Beim Re-Filing in ein anderes Regal existiert das Ziel noch gar nicht,
  // also war `prev` leer — und ein Verschieben löschte still genau die Felder,
  // die der Patch oben schützen soll. Nachgestellt an einem Memory mit
  // `created: 2020`, `related`, `related_via`, `sensitivity: private`,
  // `source` und `confidence: 0.4`: danach stand `created` auf heute, die
  // Beziehungen waren leer, `sensitivity` auf `team`, `source` weg,
  // `confidence` auf 1. Die Basis kommt deshalb aus derselben autoritativen
  // Auskunft, unter derselben Transaktion — nicht aus nachkopierten
  // Einzelfeldern in den Aufrufern.
  const refiledFrom =
    input.overwrite && located.kind === "unique" && !sameFile(located.filePath, filePath) ? located.filePath : null;
  // Fail-closed: Ist die Vorlage unlesbar, wird nicht „ohne sie" geschrieben —
  // das wäre exakt der Metadatenverlust, den dieser Zweig verhindert.
  // `readTarget` wirft auf allem außer ENOENT.
  const baseRaw = refiledFrom !== null ? await readTarget(refiledFrom) : observedTarget;
  const prev = parseTemplate(baseRaw);
  // Codex-Gegenreview (P1): Das Audit-Vorbild bildeten die AUFRUFER selbst —
  // aus dem Vault-Cache, aus dem Zielpfad oder aus einem zweiten Vaultscan
  // neben der Mutation. Nachgestellt: Bei einem audit-behafteten Re-File
  // meldete `diff_before` Version 1, während der Save tatsächlich Version 0.4
  // (die Quelldatei) als Vorlage benutzt hat, und `saveMemoryWithAuditTrail`
  // schrieb bei einem normalen Re-File `operation: update` mit
  // `diff_before: null`. Die Mutation kennt ihr Vorbild aber genau — sie hat
  // es gerade unter dem Claim gelesen. Also gibt sie es heraus, statt es
  // rekonstruieren zu lassen. Das spart nebenbei den zweiten Vaultscan.
  const auditBefore = baseRaw === null ? null : cloneForAudit(prev);

  // #464 (wiedereröffnet): Die Vorbedingung auf dem Bestand — hier, weil `prev`
  // genau das Frontmatter der Datei ist, die dieser Save gleich ersetzt (beim
  // Re-Filing das der QUELLE, die getrasht wird), unter dem Claim gelesen. Vor
  // jedem Rename und jedem Trashen: Wer hier wirft, hat nichts geschrieben.
  commit.precondition?.(prev);

  // Aus Eingabe und Bestand wird das Frontmatter — welches Feld die Eingabe
  // gewinnt, welches der Bestand und welches wegfällt, steht in
  // `save-frontmatter.ts` jeweils am Feld.
  const { fm, summaryTruncated } = buildFrontmatter(input, prev, id, scope, commit.originEvidence);

  const body = input.body.startsWith("\n") ? input.body : `\n${input.body}`;
  const content = matter.stringify(body, fm);

  return { filePath, observedTarget, exists, refiledFrom, baseRaw, auditBefore, fm, content, summaryTruncated };
}

/**
 * Ein Frontmatter-Abbild fürs Audit — TIEF kopiert.
 *
 * Codex-Gegenreview (P1): gray-matter cached `matter(content)` je Input-String
 * und gibt allen Parsern desselben Inhalts DASSELBE `data`-Objekt zurück. Wer
 * es einfach durchreicht, hält über mehrere `await`s hinweg einen fremden
 * Cache-Eintrag: Der Reviewer konnte ein bereits gebildetes `diff_before`
 * NACHTRÄGLICH verändern, indem ein zweiter Parser den Eintrag mutierte.
 * Dieselbe Falle wie in related-enrich.ts:230 und trigger-expand.ts:322 — hier
 * aber über den JSON-Umweg, weil das Abbild ohnehin als JSON im Ledger landet
 * (Dates werden dabei zu ISO-Strings, genau wie beim Schreiben des Logs).
 */
export function cloneForAudit(fm: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fm)) as Record<string, unknown>;
}

/** #1484: what `previewMemory` reports — the file a save would write. */
export interface MemoryPreview {
  id: string;
  file_path: string;
  /** Same meaning as `SaveMemoryResult.created`: false for an update or a re-file. */
  created: boolean;
  /** The complete file (frontmatter + body) the save would write. */
  content: string;
  /** The frontmatter inside `content`, as an object. */
  frontmatter: Record<string, unknown>;
  refiled_from?: string;
  summary_note?: string;
}

/**
 * #1484 — the save without the write. Runs the same target resolution and the
 * same plan as `saveMemory`, against the disk instead of under the id claim, so
 * it takes no lock, creates no directory and writes no file. A check that would
 * refuse the real save throws the same error here.
 *
 * Not a reservation: between this answer and a real save another writer may
 * change the target; the real save still runs every check under its claim.
 */
export async function previewMemory(
  vaultRoot: string,
  input: SaveMemoryInput,
  commit: Pick<SaveMemoryCommitOptions, "locator" | "precondition" | "originEvidence"> = {}
): Promise<MemoryPreview> {
  assertBodyTail(input.body, input.body_ends_with);
  await assertVaultCanStartSave(vaultRoot);
  const locator = commit.locator ?? { locate: (wanted: string) => scanVaultForId(vaultRoot, wanted) };
  const target = resolveMemoryTarget(vaultRoot, input, locator);
  const located = await scanVaultForIdAsync(vaultRoot, target.id);
  const plan = await planMemoryWrite(vaultRoot, input, commit, target, located);
  return {
    id: target.id,
    file_path: plan.filePath,
    created: !plan.exists && plan.refiledFrom === null,
    content: plan.content,
    frontmatter: cloneForAudit(plan.fm),
    ...(plan.refiledFrom !== null ? { refiled_from: plan.refiledFrom } : {}),
    ...(plan.summaryTruncated ? { summary_note: SUMMARY_TRUNCATED_NOTE } : {}),
  };
}
