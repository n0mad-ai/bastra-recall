/**
 * Welche Datei ist das WIRKLICH — und liegt sie im Vault?
 *
 * Beide Fragen wurden im Schreibpfad über Pfad-STRINGS beantwortet, und beide
 * Antworten waren falsch, sobald das Dateisystem nicht buchstabengetreu ist:
 *
 *   - Re-Filing verglich `previous.filePath !== result.file_path`. Auf APFS
 *     (case-insensitiv) trifft ein Save mit `folder: memories/people` die
 *     bestehende Datei `memories/People/case-id.md`, meldet aber die andere
 *     Schreibweise zurück. Der Stringvergleich hielt die beiden für zwei
 *     Dateien und schob die „alte" in den Trash — dieselbe Datei, die gerade
 *     geschrieben worden war. Ergebnis: „Save complete", und danach existiert
 *     keiner der beiden gemeldeten Pfade mehr.
 *
 *   - Die Containment-Prüfung war lexikalisch (`resolve(p).startsWith(root)`).
 *     Ein Symlink `memories/linked -> /outside` plus `folder: memories/linked`
 *     erzeugte damit erfolgreich `/outside/escaped.md`: der String beginnt
 *     brav mit dem Vault-Pfad, das Dateisystem geht trotzdem woanders hin.
 *
 * Die Antwort auf beides ist dieselbe: nicht den Pfad fragen, sondern das
 * Dateisystem. Identität über `dev`/`ino`, Containment über `realpath` des
 * tiefsten bereits EXISTIERENDEN Vorfahren — der Zielpfad selbst existiert
 * beim Schreiben ja noch nicht. `auditedRestore` in `audit-save.ts` macht das
 * seit Codex-Befund 6a schon so; hier steht es wiederverwendbar.
 *
 * Bewusst synchron: `resolveMemoryTarget` ist ein synchrones Routing-Primitiv,
 * das auch der Audit-Pfad ohne `await` aufruft.
 */
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Sind das zwei Namen für DIESELBE Datei?
 *
 * Über `dev`/`ino`, nicht über den Pfad: ein case-insensitives Dateisystem,
 * ein Symlink, ein Hardlink oder ein Unicode-normalisierender Mount lassen
 * dieselbe Datei unter mehreren Schreibweisen erscheinen.
 *
 * Existiert eine der beiden nicht (oder ist sie unlesbar), lautet die Antwort
 * `false` — „nicht nachweisbar dieselbe". Für den Aufrufer ist das die sichere
 * Richtung: er behandelt sie dann als getrennte Dateien und räumt keine auf,
 * die er nicht sehen kann.
 */
export function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const statA = statSync(a);
    const statB = statSync(b);
    return statA.dev === statB.dev && statA.ino === statB.ino;
  } catch {
    return false;
  }
}

/**
 * Der reale Pfad eines Ziels, das es noch nicht gibt: den tiefsten bereits
 * existierenden Vorfahren auflösen und den Rest wieder anhängen. So hilft ein
 * Symlink auf halbem Weg nicht mehr aus dem Vault heraus.
 */
export function realpathOfNearestExisting(p: string): string {
  const tail: string[] = [];
  let probe = resolve(p);
  for (;;) {
    let real: string | undefined;
    try {
      real = realpathSync(probe);
    } catch {
      real = undefined;
    }
    if (real !== undefined) return tail.length === 0 ? real : join(real, ...tail);
    const parent = dirname(probe);
    // Bei der Wurzel angekommen, ohne dass irgendetwas existierte.
    if (parent === probe) return resolve(p);
    tail.unshift(basename(probe));
    probe = parent;
  }
}

/**
 * Liegt `dest` REAL im Vault? Wirft, wenn nicht.
 *
 * Auch der Vault-Root wird über den tiefsten existierenden Vorfahren
 * aufgelöst: Ein frisch angelegter Vault existiert beim ersten Save noch
 * nicht, und `/var` ist auf macOS selbst ein Symlink — ohne beidseitige
 * Auflösung schlüge die Prüfung dort für jeden legitimen Pfad fehl.
 */
export function assertInsideVault(vaultRoot: string, dest: string, action = "write"): void {
  assertInsideDir(vaultRoot, dest, action, "the vault");
}

/**
 * Liegt `dest` REAL innerhalb von `boundary`? Wirft, wenn nicht.
 *
 * Der Vault ist nicht die einzige Grenze, die zählt. Sicherheitsrunde: Die
 * Containment-Prüfung war überall an den GESAMTEN Vault gebunden, und damit
 * blieb ein Symlink, der den Vault gar nicht verlässt, unbemerkt:
 *
 *   - `dokumente/linked -> ../memories` ließ `save_document` das Original und
 *     sein Sidecar mitten ins Memory-Regal schreiben. Der Pfad liegt im Vault,
 *     das Dokumentenregal hat er trotzdem verlassen.
 *   - `.bastra -> memories` oder `.bastra/trash -> <aktives Regal>` machte aus
 *     dem Löschen ein Verschieben in den aktiven Bestand: „gelöscht" gemeldet,
 *     im Vault weiterhin auffindbar.
 *   - Ein Projektordner als Symlink auf ein anderes Regal ließ `renameArea()`
 *     dort die Scopes umschreiben.
 *
 * Wer eine Grenze meint, muss sie also benennen — `assertInsideVault` ist nur
 * der Sonderfall „die äußerste".
 */
/**
 * Ist `dir` das EIGENE Unterverzeichnis von `parent` — und kein Link
 * irgendwohin?
 *
 * Für `.bastra` reicht „liegt im Vault" nicht. Sicherheitsrunde: Zeigt
 * `.bastra` selbst auf ein aktives Regal, liegt sein Inhalt formal weiterhin
 * im Vault, und jede Containment-Prüfung geht durch — Lock-Dateien und
 * gelöschte Memories landen dann mitten im Bestand: in Obsidian sichtbar,
 * mitsynchronisiert, und ein Aufräumen dort öffnet einen gehaltenen Lock.
 *
 * `.bastra` ist private Daemon-Ablage. Wer sie woanders haben will, sagt das
 * über Konfiguration, nicht über einen Symlink, den kein Aufrufer sieht.
 */
export function assertOwnSubdir(parent: string, dir: string, action = "write"): void {
  const expected = join(realpathOfNearestExisting(parent), basename(dir));
  const actual = realpathOfNearestExisting(dir);
  if (actual !== expected) {
    throw new Error(
      `refusing to ${action}: ${dir} is not ${parent}'s own ${basename(dir)} — ` +
        `it resolves to ${actual}. Private daemon state must not be a symlink.`,
    );
  }
}

export function assertInsideDir(
  boundary: string,
  dest: string,
  action = "write",
  label = boundary,
): void {
  const boundaryReal = realpathOfNearestExisting(boundary);
  const destReal = realpathOfNearestExisting(dest);
  if (destReal !== boundaryReal && !destReal.startsWith(boundaryReal + sep)) {
    throw new Error(
      `refusing to ${action} outside ${label}: ${dest} resolves to ${destReal}, ` +
        `which is not inside ${boundaryReal}.`,
    );
  }
}
