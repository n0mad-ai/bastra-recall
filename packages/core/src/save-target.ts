/**
 * Split out of `save.ts` (#360 follow-up): the write path had grown past 800
 * lines, which is a context cost on every edit that touches it. Pure move —
 * no behaviour change, no renamed export.
 *
 * Where a memory's file goes. `scope` + `type` decide the default subfolder,
 * an explicit `folder` overrides it, and the result is resolved against the
 * vault root. Separate from the save itself so the daemon can ask "where would
 * this land" without a write.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { assertInsideVault } from "./file-identity.js";
import { readOccupant, vaultRelative, type MemoryLocator } from "./memory-locator.js";
import type { SaveMemoryInput } from "./save-schema.js";
import { canonicalMemoryId } from "./save-text.js";
import { normalizeScopeKey } from "./scope.js";

/**
 * Subfolder routing inside the vault.
 *
 * Top-level layout (three siblings):
 *   memories/         lessons, decisions, preferences, project-facts,
 *                     workflows — anything the agent learned and wants
 *                     to recall later.
 *     ├── user/             scope = "user-preference"
 *     ├── all-projects/     scope = "all-projects"
 *     └── projects/<scope>/ everything else
 *
 *   bookmarks/        type = "bookmark" — saved URLs with url/og_image.
 *                     Kept as a sibling because bookmarks aren't really
 *                     "memories" and carry their own metadata shape.
 *
 *   dokumentationen/  type = "doc" — living per-project documentation
 *                     ("software wiki"). Routed to dokumentationen/<scope>/
 *                     so each project owns its docs.
 *
 * The vault scans recursively, so older flat `memorys/` files continue to
 * work until they are migrated.
 */
/**
 * Die exakten `scope === …`-Vergleiche hier sind seit #360-D unkritisch: der
 * EINZIGE produktive Aufrufer ist `resolveMemoryTarget`, und der übergibt den
 * kanonischen Key (`normalizeScopeKey`). Ein roher "User-Preference" kann
 * diese Zweige also nicht mehr verfehlen. Wer die Funktion künftig direkt
 * aufruft, faltet vorher selbst.
 */
export function subfolderFor(scope: string, type: string): string {
  if (type === "bookmark") return "bookmarks";
  if (type === "doc") return `dokumentationen/${scope}`;
  if (scope === "user-preference") return "memories/user";
  if (scope === "all-projects") return "memories/all-projects";
  // Reservierter Ort für selbst-etablierte Taxonomie-Konventionen (#65):
  // Regeln, die beschreiben, wie der Vault künftig strukturiert wird
  // ("Personen nach memories/people/, Tag person, …"). Die Hooks laden
  // diesen Scope bei Session-Start und injizieren ihn als Kontext.
  if (scope === "taxonomy") return "memories/taxonomy";
  return `memories/projects/${scope}`;
}

/**
 * Bestandsschutz für die Kanonisierung (#360-D, über mehrere Gegenprüfungen
 * gewachsen).
 *
 * Die Faltung ist richtig für NEUE Memories, darf aber kein bestehendes
 * unerreichbar machen. Ein Vault mit `Upper-ID.md` hätte sonst zwei Ausgänge,
 * beide falsch: auf einem case-SENSITIVEN System entsteht `upper-id.md`
 * daneben — ein Duplikat, das `overwrite: true` still ignoriert; auf einem
 * case-INSENSITIVEN System trifft der Schreibvorgang die alte Datei, lässt
 * ihren Namen stehen und setzt im Frontmatter die neue id.
 *
 * Gefragt wird der {@link MemoryLocator}, also dieselbe Identitätsauskunft,
 * die auch der Vault-Index benutzt — nicht der Dateiname und nicht ein
 * beliebiges YAML-Feld. Warum das nötig war, steht in `memory-locator.ts`.
 *
 * Gesucht wird nur, wenn die Frage offen ist: Liegt am kanonischen Ziel
 * bereits genau dieses Memory, ist nichts zu klären. Ein `ambiguous` bleibt
 * unbeantwortet und fällt auf das kanonische Ziel zurück — `saveMemory`
 * verweigert den Schreibvorgang dann mit einer Meldung, die den Defekt nennt,
 * statt eine der beiden Dateien zu raten.
 */
function resolveAgainstExisting(
  vaultRoot: string,
  input: MemoryTargetInput,
  canonicalId: string,
  canonicalSubdir: string,
  locator: MemoryLocator | undefined,
): { id: string; relPath: string; displacedPath?: string } {
  const canonical = { id: canonicalId, relPath: `${canonicalSubdir}/${canonicalId}.md` };
  // Der Fund, den ein ausdrücklicher `folder` unten VERWIRFT: Genau der ist
  // beim Re-Filing die Quelle, und der Area-Claim muss ihn kennen (P0-2).
  let displaced: string | undefined;
  const rawId = input.id ?? canonicalId;

  // Zuerst: Liegt am kanonischen Ziel schon genau dieses Memory? Dann ist
  // nichts zu klären. Die Prüfung läuft segmentweise EXAKT, denn ein
  // case-insensitives Dateisystem öffnet für `…/proj/alte-id.md` klaglos
  // `…/Proj/alte-id.md` und meldet ein Memory, das in Wahrheit in einem
  // anders geschriebenen Regal liegt — auf Linux entstünde daneben eine
  // zweite Datei. Ohne diese Vorprüfung verhielten sich die beiden
  // Plattformen unterschiedlich.
  if (existsExactPath(vaultRoot, canonical.relPath)) {
    const occupant = readOccupant(join(vaultRoot, ...canonical.relPath.split("/")));
    if (occupant.kind === "memory" && occupant.id === canonicalId) return canonical;
  }

  // Erst die rohe Schreibweise (der eigentliche Bestandsfall), dann die
  // kanonische: Ein Memory kann auch unter seinem kanonischen Namen an einem
  // ganz anderen Ort liegen — `memorys/`, `memories/people/`, oder mit einem
  // Dateinamen, der von seiner id abweicht.
  for (const candidateId of rawId === canonicalId ? [canonicalId] : [rawId, canonicalId]) {
    const located = locator?.locate(candidateId);
    // `ambiguous` und `incomplete` bleiben hier unbeantwortet und fallen auf
    // das kanonische Ziel zurück. Das ist kein Durchwinken: `saveMemory` hält
    // beide Fälle an, bevor es schreibt, und nennt dabei den Defekt. Ein
    // Routing-Primitiv soll den Ort nennen, nicht die Schreiberlaubnis.
    if (located?.kind !== "unique") continue;
    const relPath = vaultRelative(vaultRoot, located.filePath);
    // Ein EXPLIZITER `folder` ist eine Anweisung, kein Vorschlag: Wer ihn
    // setzt, sagt, wo das Memory hingehört (Re-Filing, #64). Ein Fund im
    // SELBEN Regal ist trotzdem dasselbe Memory — nur anders geschrieben —,
    // ein Fund woanders wäre eine stille Umleitung entgegen der Anweisung.
    // Den Fall entscheidet `saveMemory` anhand von `overwrite`.
    if (input.folder !== undefined && dirnameOf(relPath) !== input.folder) {
      displaced ??= located.filePath;
      continue;
    }
    return { id: candidateId, relPath };
  }
  return { ...canonical, ...(displaced !== undefined ? { displacedPath: displaced } : {}) };
}

function dirnameOf(relPath: string): string {
  const cut = relPath.lastIndexOf("/");
  return cut === -1 ? "" : relPath.slice(0, cut);
}

/** Existiert dieser Pfad mit GENAU dieser Schreibweise? Jedes Segment einzeln,
 *  weil ein case-insensitives Dateisystem sonst schon beim Ordner lügt. */
function existsExactPath(root: string, relPath: string): boolean {
  let cur = root;
  for (const segment of relPath.split("/")) {
    try {
      if (!readdirSync(cur).includes(segment)) return false;
    } catch {
      return false;
    }
    cur = join(cur, segment);
  }
  return true;
}

export type MemoryTargetInput = Pick<
  SaveMemoryInput,
  "title" | "type" | "scope" | "id" | "folder"
>;

export interface MemoryTarget {
  id: string;
  filePath: string;
  /** Der Scope, den das Frontmatter tragen MUSS, damit er zum Ordner passt.
   *  Normalerweise der kanonische Key; im Bestandsfall (siehe
   *  {@link resolveAgainstExisting}) die alte Schreibweise, weil die Datei
   *  weiterhin im alten Regal liegt. */
  scope: string;
  /**
   * Wo dieses Memory laut Routing-Auskunft HEUTE liegt, falls das nicht
   * `filePath` ist.
   *
   * Codex-Abschlussprüfung (P0-2): Beim Re-Filing (`folder` zeigt woanders hin
   * als der Bestand) berührt ein Save ZWEI Regale — es schreibt ins Ziel und
   * trasht die Quelle. Der Area-Claim braucht beide, und er wird VOR der
   * ID-Transaktion genommen, also bevor der autoritative Scan gelaufen ist.
   * Die Routing-Auskunft ist die einzige, die zu diesem Zeitpunkt vorliegt.
   */
  existingPath?: string;
}

/**
 * Resolve the exact file `saveMemory` will write.
 *
 * Callers that need a pre-write snapshot (for example the daemon audit trail)
 * must use the same routing and containment check as the writer instead of
 * duplicating `subfolderFor`. This is a routing primitive, not a second save
 * API: a path escape is a write failure and must throw rather than being
 * downgraded to "audit unavailable".
 */
export function resolveMemoryTarget(
  vaultRoot: string,
  input: MemoryTargetInput,
  locator?: MemoryLocator,
): MemoryTarget {
  const canonicalId = canonicalMemoryId(input.id, input.title);
  // #360-Folgefund D: `scope` wird hier zum ORDNERNAMEN. Ein roher
  // Projektname ("CarNexus") legte damit ein zweites Regal neben dem
  // kanonischen an — auf case-insensitiven Dateisystemen sogar dasselbe
  // Regal unter zwei Namen. Gefaltet über die zentrale Scope-Identität;
  // `save.ts` schreibt denselben Key ins Frontmatter, damit Ordner und
  // `scope:` nie auseinanderlaufen.
  const canonicalSubdir = input.folder ?? subfolderFor(normalizeScopeKey(input.scope), input.type);
  const { id, relPath, displacedPath } = resolveAgainstExisting(vaultRoot, input, canonicalId, canonicalSubdir, locator);
  const canonicalRelPath = `${canonicalSubdir}/${canonicalId}.md`;
  const scope = relPath === canonicalRelPath ? normalizeScopeKey(input.scope) : input.scope;
  const filePath = join(vaultRoot, ...relPath.split("/"));
  // Über das Dateisystem, nicht über den String: Die alte lexikalische Prüfung
  // (`resolve(filePath).startsWith(resolve(vaultRoot) + sep)`) sah Symlinks
  // nicht. Ein `memories/linked -> /outside` plus `folder: memories/linked`
  // erzeugte damit erfolgreich `/outside/escaped.md` — der Pfad-String beginnt
  // brav mit dem Vault-Pfad, das Dateisystem geht trotzdem woanders hin.
  // Dieselbe Prüfung, die `auditedRestore` seit Codex-Befund 6a benutzt.
  assertInsideVault(vaultRoot, filePath);
  return {
    id,
    filePath,
    scope,
    ...(displacedPath !== undefined && displacedPath !== filePath
      ? { existingPath: displacedPath }
      : {}),
  };
}
