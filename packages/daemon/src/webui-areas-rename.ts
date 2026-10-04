/**
 * Area rename (#216, split out of webui-areas.ts in #680) — folder move,
 * scope and doc-metadata rewrite, the stale-scope check afterwards and the
 * rollback when any of it fails. Ground rules: see webui-areas.ts.
 */
import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { clearAreaMark, isMarkdownFile, markAreaRenamed, mutateMemoryFile, readOccupant, slugify, withAreaExclusive } from "@bastra-recall/core";
import { scopeEquals } from "@bastra-recall/core/scope";
import { areaPath, assertEditable, docsShelfPath, isDir } from "./webui-areas-shared.js";

/** Rewrite `scope:` in every memory frontmatter under dir (recursive) whose
 *  scope equals oldScope. Files without parseable frontmatter are skipped.
 *
 *  #360-Folgefund A: der Vergleich lief exakt (`!== oldScope`) — ein Ordner
 *  `carnexus` mit Frontmatter `scope: CarNexus` wurde verschoben, aber kein
 *  einziger Scope umgeschrieben (`scopesRewritten: 0`), und die Memories waren
 *  danach im eigenen Projekt fremd. Gefaltet über die zentrale
 *  Scope-Identität (`scopeEquals`) statt einer eigenen Kopie. */
async function rewriteScopes(
  vaultRoot: string,
  dir: string,
  oldScope: string,
  newScope: string,
  failed: string[],
): Promise<number> {
  let rewritten = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Codex-Gegenreview (P1): Ein unlesbarer Teilbaum galt als leerer
    // Teilbaum, und der Rename meldete Erfolg über Dateien, die er nie
    // gesehen hat. Was nicht gelesen werden konnte, wird gemeldet.
    failed.push(`${dir} (${(err as NodeJS.ErrnoException)?.code ?? String(err)})`);
    return 0;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      rewritten += await rewriteScopes(vaultRoot, full, oldScope, newScope, failed);
      continue;
    }
    if (!e.isFile() || !isMarkdownFile(e.name)) continue;
    // Codex-Befund 1: die Prüfung war „irgendein YAML-Feld `scope` vorhanden".
    // Nachgestellt: eine gewöhnliche Obsidian-Notiz mit `scope: carnexus` im
    // Projektordner wurde beim Rename umgeschrieben. Was der Vault nicht als
    // Memory indexieren würde, darf ein Rename nicht anfassen — dieselbe
    // Entscheidung wie im Save-Pfad, aus derselben Quelle.
    const occupant = readOccupant(full);
    // Codex-Gegenreview (P1): `unreadable` lief hier durch dieselbe Tür wie
    // „kein Memory". Ein Memory, das nicht gelesen werden konnte, behielt
    // damit still seinen alten Scope, lag danach aber im neuen Ordner — und
    // der Rename meldete Erfolg. Unlesbar ist nicht abwesend.
    if (occupant.kind === "unreadable") {
      failed.push(`${full} (${occupant.reason})`);
      continue;
    }
    if (occupant.kind !== "memory") continue;
    try {
      const outcome = await mutateMemoryFile(
        full,
        occupant.id,
        {
          frontmatter: (fm) => {
            const cur = fm.scope;
            if (typeof cur !== "string" || !scopeEquals(cur, oldScope)) return null;
            return { ...fm, scope: newScope };
          },
        },
        { vaultRoot },
      );
      // `noop` heißt „hier war nichts umzuschreiben" (ein fremdes Memory im
      // Ordner), `raced` und `identity-mismatch` heißen „mein Stempel liegt
      // NICHT drauf". Erst seit `mutateMemoryFile` die beiden trennt, ist das
      // hier ohne Hilfsflagge unterscheidbar.
      if (outcome.kind === "written") rewritten++;
      else if (outcome.kind !== "noop") failed.push(`${full} (${outcome.kind})`);
    } catch (err) {
      // Nicht schreibbar — melden statt still übergehen.
      failed.push(`${full} (${(err as Error).message})`);
    }
  }
  return rewritten;
}

/**
 * Nachprüfung nach dem Umschreiben: Behauptet im umgezogenen Regal noch
 * irgendeine Datei, zur ALTEN Area zu gehören?
 *
 * Codex-Gegenreview (P0): Ein Area-Rename und ein normaler Save waren nicht
 * gegeneinander serialisiert. Nachgestellt: `renameArea(alt → neu)` hatte ein
 * Memory bereits auf `scope: neu` umgeschrieben; danach lief ein gewöhnlicher
 * `saveMemory` derselben id, der noch die ALTE Area-Identität in der Hand
 * hatte. Beide meldeten Erfolg. Endzustand: Datei im neuen Regal, Frontmatter
 * wieder `scope: alt` — im Recall des neuen Projekts als fremd gefiltert, im
 * alten nicht auffindbar. Der id-Lock greift dabei korrekt; er sperrt nur EINE
 * Datei für die Dauer EINER Mutation, und ein Rename ist eine Operation über
 * ein ganzes Regal, die aus vielen solcher Mutationen besteht.
 *
 * ENTSCHEIDUNG (und ihre Grenze, ehrlich benannt): Zwei Wege waren denkbar.
 * Der eine ist eine Area-Marke im Vault (`.bastra/`), die einen laufenden
 * Rename anzeigt und die der Save-Pfad respektieren MÜSSTE — nur der schließt
 * das Fenster wirklich, und er ist nicht hier zu bauen, sondern in
 * `packages/core/src/save.ts`. Der andere, hier gebaute, ist diese
 * Nachprüfung: Nach allen Rewrites wird das umgezogene Regal noch einmal
 * gelesen, und was dort weiterhin den alten Namen trägt, lässt den Rename
 * scheitern und zurückrollen.
 *
 * Was das GARANTIERT: Ein Rename, der Erfolg meldet, hat das Regal zum
 * Zeitpunkt seiner letzten Lesung tatsächlich vollständig umgeschrieben — ein
 * dazwischengeratener Save wird erkannt, nicht verschwiegen, und der Vault
 * bleibt in EINEM der beiden konsistenten Zustände (alt oder neu).
 * Was es NICHT garantiert: Das Fenster ist nicht geschlossen, nur beobachtet.
 * Ein Save, der NACH der Nachprüfung mit der alten Area-Identität schreibt,
 * hinterlässt denselben Zustand wie zuvor — er wird nur von niemandem mehr
 * gesehen. Und die Nachprüfung selbst ist ein zweiter Durchgang: Kosten sind
 * ein weiterer Read je Memory des Regals.
 *
 * Gelesen wird unter demselben id-Lock wie jeder Writer — `frontmatter` gibt
 * immer `null` zurück, die Mutation ist also garantiert ein `noop` und fasst
 * keine Datei an; sie leiht sich nur den Lock und den EINEN Read.
 */
async function findStaleScopes(
  vaultRoot: string,
  dir: string,
  oldScope: string,
  stale: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Wer nicht hinsehen konnte, darf nicht „sauber" behaupten.
    stale.push(`${dir} (${(err as NodeJS.ErrnoException)?.code ?? String(err)})`);
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await findStaleScopes(vaultRoot, full, oldScope, stale);
      continue;
    }
    if (!e.isFile() || !isMarkdownFile(e.name)) continue;
    const occupant = readOccupant(full);
    if (occupant.kind === "unreadable") {
      stale.push(`${full} (${occupant.reason})`);
      continue;
    }
    if (occupant.kind !== "memory") continue;
    let found: string | undefined;
    const outcome = await mutateMemoryFile(
      full,
      occupant.id,
      {
        frontmatter: (fm) => {
          const cur = fm.scope;
          if (typeof cur === "string" && scopeEquals(cur, oldScope)) found = cur;
          return null;
        },
      },
      { vaultRoot },
    );
    // Fremde Scopes bleiben unangetastet — geprüft wird nur, ob der ALTE
    // Area-Name noch irgendwo steht. Ein Memory eines anderen Projekts im
    // Regal war schon vorher keins dieser Area und wird hier keins.
    if (found !== undefined) stale.push(`${full} (scope: ${found})`);
    else if (outcome.kind !== "noop") stale.push(`${full} (${outcome.kind})`);
  }
}

export interface RenameResult {
  name: string;
  scopesRewritten: number;
  docsFolderMoved: boolean;
  /** Produktdokumente, deren topic_path/Tags auf das neue Projekt gezogen
   *  wurden. Die id bleibt bewusst stehen — siehe {@link rewriteDocMetadata}. */
  docsRetagged: number;
}

/**
 * Produktdokumente tragen den Projektnamen nicht nur im Scope, sondern auch in
 * `topic_path[1]` und in den Tags. Die zieht ein Rename mit.
 *
 * Was er ausdrücklich NICHT mitzieht, ist die id (Codex-Gegenreview): Ein
 * Umbenennen von `doku-carnexus-area` nach `doku-new-project-area` bricht
 * jedes `related: [doku-carnexus-area]` und jeden `[[doku-carnexus-area]]` im
 * Vault — der Graph löst keine Aliase auf, es bliebe ein Geisterknoten, und
 * die Verbindung zum echten Dokument wäre weg. Es widerspräche auch der
 * Grundregel dieses Moduls, dass ids einen Rename überleben.
 *
 * Dass der nächste `save_product_doc`-Aufruf das Dokument trotzdem findet,
 * löst der Handler auf der anderen Seite: Er sucht zuerst über Scope + Area
 * im Index und leitet erst dann eine neue id ab. Die id ist damit ein
 * historischer Name, kein Schlüssel — genau wie bei jedem anderen Memory.
 */
/**
 * Die Produktdoku-Signatur, wie sie `findDocFor()` in product-doc-handler.ts
 * liest — dieselbe Frage, dieselbe Antwort: `type: doc`, Scope des Projekts,
 * und ein `topic_path` der Länge 3 in der Form `["doku", <projekt>, <area>]`.
 * Alles andere im Doku-Regal gehört jemand anderem.
 */
function isProductDocOf(data: Record<string, unknown>, projectName: string): boolean {
  if (data.type !== "doc") return false;
  if (typeof data.scope !== "string" || !scopeEquals(data.scope, projectName)) return false;
  const path = data.topic_path;
  if (!Array.isArray(path) || path.length !== 3) return false;
  if (path[0] !== "doku") return false;
  return typeof path[1] === "string" && scopeEquals(path[1], projectName);
}

async function rewriteDocMetadata(
  vaultRoot: string,
  dir: string,
  oldName: string,
  newName: string,
  failed: string[],
): Promise<number> {
  let touched = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    failed.push(`${dir} (${(err as NodeJS.ErrnoException)?.code ?? String(err)})`);
    return 0;
  }
  for (const e of entries) {
    if (!e.isFile() || !isMarkdownFile(e.name)) continue;
    const full = join(dir, e.name);
    // Codex-Befund 2: geprüft wurde weder `type: doc` noch die vollständige
    // Signatur. Nachgestellt: eine normale Notiz im Doku-Regal, die zufällig
    // `tags: [carnexus]` und `topic_path: [doku, carnexus, area]` trug, wurde
    // beim Rename umgeschrieben. Erste Hürde wie überall: Ist das überhaupt
    // ein Memory?
    const occupant = readOccupant(full);
    if (occupant.kind === "unreadable") {
      failed.push(`${full} (${occupant.reason})`);
      continue;
    }
    if (occupant.kind !== "memory") continue;
    try {
      const outcome = await mutateMemoryFile(full, occupant.id, {
        frontmatter: (fm) => {
          if (!isProductDocOf(fm, oldName)) return null;
          const next = { ...fm };
          let changed = false;
          // #360: gefaltet — ein Bestandsdokument kann `doku-CarNexus-…` heißen
          // und `topic_path: [doku, CarNexus, …]` tragen.
          if (Array.isArray(next.topic_path) && typeof next.topic_path[1] === "string" &&
              scopeEquals(next.topic_path[1] as string, oldName)) {
            const path = [...(next.topic_path as unknown[])];
            path[1] = newName;
            next.topic_path = path;
            changed = true;
          }
          if (Array.isArray(next.tags)) {
            const tags = (next.tags as unknown[]).map((t) =>
              typeof t === "string" && scopeEquals(t, oldName) ? newName : t,
            );
            if (tags.some((t, i) => t !== (next.tags as unknown[])[i])) {
              next.tags = tags;
              changed = true;
            }
          }
          return changed ? next : null;
        },
      }, { vaultRoot });
      if (outcome.kind === "written") touched++;
      else if (outcome.kind !== "noop") failed.push(`${full} (${outcome.kind})`);
    } catch (err) {
      failed.push(`${full} (${(err as Error).message})`);
    }
  }
  return touched;
}

/**
 * Rename an area folder. Project areas additionally get their memories'
 * `scope:` frontmatter rewritten (recall filters, hook scope-gate and save
 * routing all key on it) and a sibling `dokumentationen/<scope>` moves along.
 * Memory ids never change, so related[]-links survive by construction.
 *
 * WAS DIE KONSTRUKTION AUS GRABSTEIN + NACHPRÜFUNG GARANTIERT — und was
 * nicht. Beide Hälften decken verschiedene Richtungen desselben Rennens ab:
 *   - Der Grabstein (unten, vor dem `rename()`) deckt den Save auf das ALTE
 *     Regal ab. Ein Save mit dem alten Scope scheitert ab jetzt laut, egal wie
 *     lange nach dem Rename er kommt — der alte Name wird nicht durch einen
 *     Save wiederbelebt, sondern nur durch ein ausdrückliches `createArea`.
 *   - Die Nachprüfung ({@link findStaleScopes}) deckt die Gegenrichtung ab:
 *     ein Memory, das im NEUEN Regal weiterhin den alten Scope trägt. Sie
 *     bleibt, weil sie billig ist (ein Read je Memory) und ein Fall ist, den
 *     der Grabstein prinzipiell nicht sieht.
 * Was NICHT garantiert ist: Zwischen `assertAreaWritable()` im Save-Pfad und
 * dem eigentlichen Schreiben liegt ein mikroskopisches Fenster. Ein Save, der
 * den Grabstein eine Mikrosekunde vor `markAreaRenamed()` liest, darf noch
 * schreiben — und trifft dann auf die Nachprüfung, wenn er ins neue Regal
 * geschrieben hat, bzw. bleibt als frisch angelegtes altes Regal stehen, wenn
 * er das alte getroffen hat. Das Fenster ist von Sekunden auf einen
 * Syscall-Abstand geschrumpft, aber nicht zu. Es ganz zu schließen, hieße
 * Save und Rename unter EINE Sperre zu stellen, die es im Vault nicht gibt
 * und deren Freigabe nach einem Absturz ein neues Problem wäre — siehe die
 * Begründung in core/area-claim.ts.
 * Ebenfalls nicht garantiert: Der Grabstein trägt nur den NAMEN. Wird eine
 * Area gelöscht und später unter demselben Namen neu angelegt, gilt sie
 * danach als dieselbe — der Vault kennt keine Area-Identität jenseits des
 * Ordnernamens.
 */
export async function renameArea(
  vaultRoot: string,
  kind: "project" | "top",
  name: string,
  rawNewName: string,
): Promise<RenameResult> {
  assertEditable(kind, name);
  const newName = slugify(rawNewName);
  assertEditable(kind, newName);
  if (newName === name) throw new Error("new name equals the current name");
  // BEIDE Namen, und `withAreaExclusive` erwirbt sie sortiert. Codex-
  // Gegenreview Runde 10 (P0-2): Zwölf parallele Versuche `carnexus → ziel-a`
  // gegen `carnexus → ziel-b` ergaben in 12 von 12 Läufen einen Grabstein, der
  // auf das Ziel des VERLIERERS zeigte — ein alter Client bekam eine sachlich
  // falsche Weiterleitung. Der Zielname gehört mit unter den Claim, sonst
  // könnte ein `createArea(ziel)` mitten in den Umzug laufen.
  return withAreaExclusive(vaultRoot, [name, newName], () =>
    renameAreaLocked(vaultRoot, kind, name, newName),
  );
}

async function renameAreaLocked(
  vaultRoot: string,
  kind: "project" | "top",
  name: string,
  newName: string,
): Promise<RenameResult> {
  const from = areaPath(vaultRoot, kind, name);
  const to = areaPath(vaultRoot, kind, newName);
  if (!(await isDir(from))) throw new Error(`area not found: ${name}`);
  if (await isDir(to)) throw new Error(`area already exists: ${newName}`);
  // dokumentationen/<scope> is the same area's docs shelf — keep it in step.
  const docsFrom = docsShelfPath(vaultRoot, name);
  const docsTo = docsShelfPath(vaultRoot, newName);
  // Codex-Befund 3: Existierten BEIDE Doku-Regale, verschob der Rename nur das
  // Projektregal, ließ `dokumentationen/<alt>` verwaist zurück, das fremde
  // `dokumentationen/<neu>` stehen — und meldete Erfolg. Die Kollision gehört
  // dem Aufrufer gemeldet, und zwar bevor irgendetwas bewegt ist: eine Area
  // zieht als Ganzes um oder gar nicht.
  if (kind === "project" && (await isDir(docsFrom)) && (await isDir(docsTo))) {
    throw new Error(
      `docs folder already exists: dokumentationen/${newName} — move or merge it first, ` +
        `renaming would leave dokumentationen/${name} behind.`,
    );
  }
  // Codex-Gegenreview (P0): Die Nachprüfung am Ende (`findStaleScopes`) sieht
  // nur ins NEUE Regal. Nachgestellt: Nachdem das vorhandene Memory nach `neu`
  // gewandert war, legte ein Save mit `scope: carnexus` das ALTE Regal wieder
  // an — `memories/projects/carnexus` existierte danach neben
  // `memories/projects/neu`, und der Rename meldete trotzdem Erfolg. Derselbe
  // Save kann auch lange NACH dem Rename kommen, etwa aus einer Agent-Session,
  // die den alten Projektnamen noch im Kontext hat; eine Marke, die nur
  // „Rename läuft gerade“ sagt, hilft dagegen nicht. Der alte Name bleibt
  // deshalb dauerhaft als fortgezogen registriert (core/area-claim.ts).
  //
  // REIHENFOLGE, und warum genau so: Der Grabstein steht VOR dem `rename()`
  // des Ordners. Die beiden Absturzfenster sind nicht gleich viel wert:
  //   - Grabstein zuerst, Absturz dazwischen → alter Name gesperrt, nichts
  //     bewegt. Ein Save auf den alten Namen scheitert LAUT; aufzuheben ist das
  //     mit `createArea(<alt>)`, der bewussten Wiederinbetriebnahme.
  //   - `rename()` zuerst, Absturz dazwischen → Regal umgezogen, alter Name
  //     FREI. Das ist exakt der gemeldete Defekt, nur ohne jeden Zeugen.
  // Nur die erste Richtung ist im Zweifel still nicht falsch. Deshalb bleibt
  // der Grabstein auch stehen, wenn das `rename()` unten selbst scheitert: Ob
  // ein Absturz vor oder in der Bewegung lag, ist hinterher nicht mehr zu
  // unterscheiden, und „gesperrt“ ist die Seite, auf der niemand Daten
  // verliert.
  //
  // Nur für Projekt-Areas: Ein Save landet über `subfolderFor()` in
  // `memories/projects/<scope>` bzw. `dokumentationen/<scope>` — ein Top-Regal
  // (`memories/<name>`) kann er gar nicht wiederbeleben. Ein Grabstein auf
  // einen Top-Namen würde dafür ein gleichnamiges PROJEKT sperren, das mit
  // dem umbenannten Ordner nichts zu tun hat.
  if (kind === "project") await markAreaRenamed(vaultRoot, name, newName);
  try {
    await rename(from, to);
  } catch (err) {
    // Codex-Gegenreview Runde 10 (P1-1): Dieses `rename` lag außerhalb des
    // Rollback-Blocks. Nachgestellt mit einer Datei am Zielpfad: Der Rename
    // scheiterte mit ENOTDIR, das alte Regal stand unverändert da — und der
    // Grabstein behauptete trotzdem „carnexus → neu", also war das Projekt ab
    // sofort unbeschreibbar. Ein GEWORFENER `rename()` ist unter dem
    // exklusiven Area-Claim beweisbar folgenlos geblieben (rename ist atomar,
    // und niemand sonst darf hier gerade arbeiten); das unterscheidet ihn von
    // einem Absturz, bei dem der Grabstein bewusst stehen bleibt.
    if (kind === "project") {
      try {
        await clearAreaMark(vaultRoot, name);
      } catch (clearErr) {
        throw new Error(
          `rename failed, nothing was moved: ${(err as Error).message}. ` +
            `AND the tombstone for '${name}' could not be removed ` +
            `(${(clearErr as Error).message}) — saves into '${name}' will keep failing ` +
            `until that is fixed.`,
        );
      }
    }
    throw err;
  }
  // Und die Gegenrichtung: `a → b` und später `b → a` liefe sonst in den
  // eigenen alten Grabstein — das Regal läge wieder unter `a`, und kein Save
  // dürfte hinein. Ein Rename NIMMT den Zielnamen in Betrieb, genau wie
  // `createArea`.
  if (kind === "project") await clearAreaMark(vaultRoot, newName);

  let scopesRewritten = 0;
  let docsFolderMoved = false;
  let docsRetagged = 0;
  // Codex-Gegenreview (P1): Ein unlesbares Memory im umziehenden Projekt wurde
  // nicht umgeschrieben, der Rename meldete trotzdem Erfolg — die Datei lag
  // danach im neuen Ordner und trug den alten Scope. Was nicht umgeschrieben
  // werden konnte, sammelt sich hier und lässt den Rename zurückrollen: eine
  // Area zieht ganz um oder gar nicht.
  const failed: string[] = [];
  try {
    if (kind === "project") {
      scopesRewritten = await rewriteScopes(vaultRoot, to, name, newName, failed);
      if (await isDir(docsFrom)) {
        await rename(docsFrom, docsTo);
        docsFolderMoved = true;
      }
      // #360-Folgefund B: der Doku-Ordner zog mit, seine Dokumente behielten
      // aber `scope: <alt>` — sie lagen danach im neuen Regal und wurden beim
      // Recall fürs neue Projekt als fremd gefiltert. Betrifft JEDEN Rename,
      // unabhängig von der Schreibweise. Zählt in dieselbe Summe: es sind
      // Scope-Rewrites derselben Area.
      if (await isDir(docsTo)) {
        // Reihenfolge: erst retaggen, dann Scopes. Die Produktdoku-Signatur
        // prüft `scope` gegen den ALTEN Namen — liefe der Scope-Rewrite zuerst,
        // erkennte `rewriteDocMetadata` kein einziges Dokument mehr wieder.
        docsRetagged = await rewriteDocMetadata(vaultRoot, docsTo, name, newName, failed);
        scopesRewritten += await rewriteScopes(vaultRoot, docsTo, name, newName, failed);
      }
    }
    if (failed.length > 0) {
      throw new Error(
        `${failed.length} Datei(en) im Projekt konnten nicht umgeschrieben werden: ` +
          `${failed.join("; ")}`,
      );
    }
    // Die Transaktionsgrenze, die dieser Operation fehlt — siehe
    // {@link findStaleScopes}: Der Rename glaubt sich fertig; nachgesehen wird
    // trotzdem, ob inzwischen wieder jemand den alten Namen hineingeschrieben
    // hat.
    if (kind === "project") {
      const stale: string[] = [];
      await findStaleScopes(vaultRoot, to, name, stale);
      if (await isDir(docsTo)) await findStaleScopes(vaultRoot, docsTo, name, stale);
      if (stale.length > 0) {
        throw new Error(
          `der Rename ist unvollständig: ${stale.length} Datei(en) im umgezogenen Regal ` +
            `tragen weiterhin die alte Area "${name}" — wahrscheinlich hat ein paralleler ` +
            `Save währenddessen mit der alten Area-Identität geschrieben: ${stale.join("; ")}`,
        );
      }
    }
  } catch (err) {
    throw await rollbackRename(
      { vaultRoot, kind, name, newName, from, to, docsFrom, docsTo, docsFolderMoved },
      err as Error,
    );
  }
  return { name: newName, scopesRewritten, docsFolderMoved, docsRetagged };
}

/**
 * Rollback nach einem gescheiterten Rename — der zweite Halt gegen die
 * geteilte Area.
 *
 * ENTSCHEIDUNG (warum Rollback und nicht „noch mehr Preflight"): Der
 * vorhandene Preflight deckt genau EINEN Grund ab, aus dem der Doku-Zug
 * scheitern kann (das Zielregal existiert schon). `rename()` scheitert aber
 * auch an Rechten, an einem gerade gehaltenen Handle, an EXDEV auf einem
 * gemounteten Vault, und an einer Datei, die am Zielpfad liegt statt eines
 * Ordners — isDir() sagt dazu nein, der rename trotzdem auch. Preflight kann
 * das prinzipiell nicht abschließen: zwischen Prüfung und Bewegung liegt
 * immer ein Fenster. Also wird das, was schon bewegt wurde, zurückbewegt —
 * inklusive der Scope- und Tag-Rewrites, die sonst mit dem neuen Namen im
 * alten Ordner zurückblieben.
 *
 * Scheitert der Rollback selbst, wird das nicht verschwiegen: die Meldung
 * nennt dann PFADGENAU, was in welchem Zustand liegen blieb. Ein „meldet
 * Erfolg, obwohl geteilt" gibt es auf keinem der beiden Wege.
 */
async function rollbackRename(
  a: {
    vaultRoot: string;
    kind: "project" | "top";
    name: string;
    newName: string;
    from: string;
    to: string;
    docsFrom: string;
    docsTo: string;
    docsFolderMoved: boolean;
  },
  cause: Error,
): Promise<Error> {
  const stuck: string[] = [];
  // Codex-Gegenreview (P1): Hier standen an beiden Aufrufen NEUE LEERE
  // `failed`-Arrays, die danach niemand mehr ansah. Nachgestellt: Ein Memory
  // blieb nach dem Rollback auf dem NEUEN Scope, der Ordner war zurückbenannt,
  // und die Meldung behauptete trotzdem „nothing was changed" — derselbe
  // geteilte Zustand wie auf dem Hinweg, nur auf dem Fehlerpfad und diesmal
  // verschwiegen. Der Rollback weiß genauso wenig wie der Hinweg, was er nicht
  // schreiben konnte; also sammelt er es und sagt es, pfadgenau wie `stuck`.
  const notRestored: string[] = [];
  if (a.docsFolderMoved) {
    try {
      // Gleiche Reihenfolge wie im Hinweg, nur mit vertauschten Namen: die
      // Produktdoku-Signatur prüft `scope`, der hier schon der neue ist.
      await rewriteDocMetadata(a.vaultRoot, a.docsTo, a.newName, a.name, notRestored);
      await rewriteScopes(a.vaultRoot, a.docsTo, a.newName, a.name, notRestored);
      await rename(a.docsTo, a.docsFrom);
    } catch {
      stuck.push(`dokumentationen/${a.newName} (sollte dokumentationen/${a.name} sein)`);
    }
  }
  try {
    if (a.kind === "project") await rewriteScopes(a.vaultRoot, a.to, a.newName, a.name, notRestored);
    await rename(a.to, a.from);
  } catch {
    stuck.push(`${a.to} (sollte ${a.from} sein)`);
  }
  if (stuck.length > 0 || notRestored.length > 0) {
    const detail: string[] = [];
    if (stuck.length > 0) detail.push(`Von Hand zu richten: ${stuck.join("; ")}`);
    if (notRestored.length > 0) {
      detail.push(
        `${notRestored.length} Datei(en) konnten nicht zurückgeschrieben werden und tragen ` +
          `womöglich noch "${a.newName}" in Scope oder Tags: ${notRestored.join("; ")}`,
      );
    }
    return new Error(
      `rename failed AND could not be fully undone: ${cause.message}. ${detail.join(". ")}.`,
    );
  }
  // Vollständig zurückgerollt: Das Regal liegt wieder unter dem alten Namen,
  // also ist der alte Name wieder der richtige — der Grabstein muss weg, sonst
  // wäre ein Projekt nach einem gescheiterten Rename dauerhaft unbeschreibbar.
  // Bewusst NUR hier, hinter dem `return` oben: Blieb etwas stecken oder konnte
  // eine Datei nicht zurückgeschrieben werden, ist der Zustand geteilt, und
  // dann ist „alter Name gesperrt“ die sichere Seite.
  if (a.kind === "project") await clearAreaMark(a.vaultRoot, a.name);
  return new Error(`rename failed, nothing was changed: ${cause.message}`);
}
