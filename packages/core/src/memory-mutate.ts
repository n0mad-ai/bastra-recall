/**
 * Ein Memory-File ändern, ohne es zu verlieren.
 *
 * Der Vault hat mehrere Writer, die nicht der Save-Pfad sind: Conflict-Marking
 * hängt einen Block an, `superseded_by` stempelt eine Kante, das Archiv setzt
 * `obsolete`. Jeder tat es auf eigene Weise, und zwei Muster kamen dabei immer
 * wieder vor (Codex-Audit, P1):
 *
 *   - Ein direktes `writeFile` auf die Zieldatei. Das lässt sie kurzzeitig
 *     leer oder halb geschrieben — ein Fenster, in dem Watcher, Cloud-Sync und
 *     jeder parallele Reader eine kaputte Datei sehen. Genau deshalb schreibt
 *     der Save-Pfad seit jeher temp+rename.
 *   - Kein Vergleich zwischen Read und Commit. Wer zwischendurch schreibt,
 *     verliert: Der Transformierende rechnet auf dem alten Inhalt und macht
 *     die fremde Änderung mit seinem Rename rückgängig.
 *
 * Dazu kommt die Identitätsfrage, die dieselbe ist wie im Save-Pfad: Ein Pfad
 * beweist nicht, welches Memory dort liegt. Wer `superseded_by` auf eine Datei
 * stempelt, muss wissen, dass es die gemeinte ist.
 *
 * Prozessübergreifend gesperrt wird über die ID-Transaktion: Jede Mutation mit
 * einem `expectedId` läuft unter demselben id-Lock wie der Save-Pfad, und
 * `vaultRoot` ist dafür Pflicht — optional war es genau das Loch, durch das ein
 * Aufrufer an der Transaktion vorbeischreiben konnte. Codex-Gegenreview (P0): Ohne ihn lag zwischen Read und
 * Rename ein Fenster, in dem ein anderer Writer schrieb — und dessen Änderung
 * machte der Rename hier still rückgängig. Der Vergleich vor dem Commit
 * schließt das Fenster nicht, er erkennt nur, dass es zugeschlagen hat.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import matter from "gray-matter";
import { occupantOfRaw } from "./memory-locator.js";
import { withIdClaim } from "./id-transaction.js";

export type MutateOutcome =
  /** Geschrieben — mit dem Frontmatter VOR und NACH diesem Schreibvorgang.
   *
   *  Codex-Gegenreview Runde 10 (P1-2): Die Aufrufer bauten ihren Audit-Beleg
   *  aus dem Vault-CACHE, weil die Mutation nichts zurückgab. Nachgestellt am
   *  Conflict-Marking: Auf der Platte stand `external-on-disk`, das Audit
   *  meldete als Vorbild `cache-summary`. Wer schreibt, weiß als Einziger, was
   *  vorher dastand — also gibt er es zurück. Beide Abbilder sind tief
   *  kopiert, damit sie kein gray-matter-Cache-Objekt teilen. */
  | { kind: "written"; before: Record<string, unknown>; after: Record<string, unknown> }
  /** Der Patch hatte nichts zu tun (`frontmatter` gab `null` zurück). Kein
   *  Fehlschlag — die Datei steht schon so da, wie sie soll.
   *
   *  Codex-Gegenreview (P0): Das meldete diese Funktion früher ebenfalls als
   *  `raced`, und damit konnte kein Aufrufer „nichts zu tun" von „jemand hat
   *  dazwischengeschrieben, mein Stempel liegt NICHT drauf" unterscheiden. Wer
   *  die Vollständigkeit einer Operation prüfen will (der Area-Rename tut das),
   *  braucht genau diese Unterscheidung. */
  | { kind: "noop" }
  /** Zwischen Read und Commit hat jemand anderes geschrieben — nichts getan. */
  | { kind: "raced" }
  /** Die Datei hält nicht das erwartete Memory — nichts getan. */
  | { kind: "identity-mismatch"; found: string | null };

export interface MemoryMutation {
  /** Frontmatter-Patch. Rückgabe `null` heißt „nichts zu tun" und liefert
   *  {@link MutateOutcome} `noop` — ausdrücklich kein Fehlschlag. */
  frontmatter?: (fm: Record<string, unknown>) => Record<string, unknown> | null;
  /** Body-Transformation. */
  body?: (body: string) => string;
}

/**
 * Frontmatter und/oder Body eines Memory-Files ändern.
 *
 * @param filePath Die Datei, die geändert werden soll.
 * @param expectedId Welches Memory dort liegen MUSS. `null` überspringt die
 *   Identitätsprüfung — nur für Dateien, die per Definition kein indexiertes
 *   Memory mehr sind (der Archiv-Stempel auf einer Datei im Trash).
 */
export async function mutateMemoryFile(
  filePath: string,
  expectedId: string,
  mutation: MemoryMutation,
  opts: MutateOptions & { vaultRoot: string },
): Promise<MutateOutcome>;
export async function mutateMemoryFile(
  filePath: string,
  expectedId: null,
  mutation: MemoryMutation,
  opts?: MutateOptions,
): Promise<MutateOutcome>;
export async function mutateMemoryFile(
  filePath: string,
  expectedId: string | null,
  mutation: MemoryMutation,
  opts: MutateOptions = {},
): Promise<MutateOutcome> {
  // Der Trash-Stempel (expectedId === null) trifft eine Datei, die per
  // Definition kein indexiertes Memory mehr ist — es gibt keine id, an der ein
  // Lock hängen könnte. Das bleibt beim Compare-and-Swap allein.
  if (expectedId === null) {
    return mutateUnderClaim(filePath, expectedId, mutation);
  }
  // Codex-Gegenreview (P0): `vaultRoot` war optional, und ohne ihn lief dieser
  // öffentlich exportierte Writer ganz ohne Claim — die Invariante „withIdClaim
  // ist der einzige Weg" galt damit nur für die internen Aufrufstellen, nicht
  // für die API. Nachgestellt: ein Aufruf ohne `vaultRoot` schrieb an jeder
  // Transaktion vorbei und machte den Rename eines parallelen Writers still
  // rückgängig. Wer ein Memory bei seiner id anfasst, muss sagen, in welchem
  // Vault es lebt — die Überladungen oben erzwingen das im Typsystem, diese
  // Prüfung auch für Aufrufer ohne Typen.
  if (opts.vaultRoot === undefined) {
    throw new Error(
      `mutateMemoryFile('${expectedId}') requires a vaultRoot: mutating a memory by its id ` +
        `must run under the id transaction, never beside it.`,
    );
  }
  return withIdClaim({ vaultRoot: opts.vaultRoot, id: expectedId, filePath, op: opts.op ?? "mutate" }, () =>
    mutateUnderClaim(filePath, expectedId, mutation),
  );
}

export interface MutateOptions {
  /** Welcher Writer hier mutiert — geht in die Scan-Messung ein. */
  op?: string;
  /** Der Vault, unter dessen ID-Transaktion die Mutation läuft. Pflicht, sobald
   *  ein `expectedId` im Spiel ist; nur der Trash-Stempel (`expectedId === null`)
   *  kommt ohne aus, weil dort keine id zu sperren ist. */
  vaultRoot?: string;
}

async function mutateUnderClaim(
  filePath: string,
  expectedId: string | null,
  mutation: MemoryMutation,
): Promise<MutateOutcome> {
  // EIN Read für alles: Identität, Transform und der Vergleich vor dem Commit
  // müssen auf denselben Bytes beruhen. Vorher las die Identitätsprüfung die
  // Datei separat (`readOccupant`) und der Transform ein zweites Mal — zwischen
  // beiden Reads liegt ein await, und wer dort die Datei durch ein anderes
  // Memory ersetzt, bekommt die Prüfung der einen Fassung und den Stempel auf
  // der anderen.
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    // Ohne Identitätsanspruch (Trash-Stempel) ist ein Lesefehler ein echter
    // Fehler; mit Anspruch ist er schlicht der Beweis, dass das erwartete
    // Memory hier nicht liegt.
    if (expectedId === null) throw err;
    return { kind: "identity-mismatch", found: null };
  }

  if (expectedId !== null) {
    const occupant = occupantOfRaw(raw, filePath);
    if (occupant.kind !== "memory" || occupant.id !== expectedId) {
      return {
        kind: "identity-mismatch",
        found: occupant.kind === "memory" ? occupant.id : null,
      };
    }
  }

  const parsed = matter(raw);
  // Copy statt in-place: gray-matter cached `matter(content)` per Input-String,
  // eine Mutation von `parsed.data` vergiftet den Cache-Eintrag für jeden
  // späteren Parser desselben Inhalts.
  const fmBefore = { ...(parsed.data as Record<string, unknown>) };
  const fmAfter = mutation.frontmatter ? mutation.frontmatter(fmBefore) : fmBefore;
  if (fmAfter === null) return { kind: "noop" };
  const bodyAfter = mutation.body ? mutation.body(parsed.content) : parsed.content;
  const next = matter.stringify(bodyAfter, fmAfter);

  // Eindeutig je SCHREIBVORGANG, nicht je Prozess: Zwei überlappende
  // Mutationen derselben Datei im selben Prozess teilten sich sonst die
  // Zwischendatei und rannten um das Rename (#240/B3).
  const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.mutate.tmp`;
  await writeFile(tmp, next, "utf8");
  try {
    const current = await readFile(filePath, "utf8").catch(() => null);
    if (current !== raw) {
      await unlink(tmp).catch(() => {});
      return { kind: "raced" };
    }
    await rename(tmp, filePath);
    return {
      kind: "written",
      before: JSON.parse(JSON.stringify(fmBefore)) as Record<string, unknown>,
      after: JSON.parse(JSON.stringify(fmAfter)) as Record<string, unknown>,
    };
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
