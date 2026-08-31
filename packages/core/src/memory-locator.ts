/**
 * Memory-Identität als EINE Auskunft: Welche Datei gehört zu dieser id, und
 * was liegt eigentlich an einem gegebenen Pfad?
 *
 * Die Reparaturkette um #360 hat gezeigt, warum das eine eigene Stelle braucht.
 * Der Save-Pfad hatte drei getrennte, jeweils zu schwache Regeln — „am
 * Zielpfad liegt irgendeine Datei, also ist sie das Ziel", „eine Datei heißt
 * so wie die id, also ist sie das Memory", „ein YAML-Feld `id` passt, also ist
 * es ein Memory" — und jede einzelne ließ sich in einen Datenverlust
 * übersetzen. Nachgestellt, alle drei:
 *
 *   - Eine gewöhnliche Obsidian-Notiz am kanonischen Zielpfad wurde bei
 *     `overwrite: true` vollständig ersetzt.
 *   - Ein FREMDES Memory (`id: other-id`) am erwarteten Pfad für `upper-id`
 *     wurde überschrieben und dabei auf `upper-id` umgeschrieben.
 *   - Eine Notiz mit einem zufälligen YAML-Feld `id: Upper-ID` (Obsidian
 *     kennt viele solche Felder) wurde als Memory behandelt und ersetzt.
 *
 * Die Antwort auf alle drei ist dieselbe: Was ein Memory ist, entscheidet
 * `parseMemoryWith` — die Funktion, mit der auch der Vault seinen Index baut.
 * Sie verlangt ein bekanntes `type` und repariert eine fehlende id aus dem
 * Dateinamen, und beides muss hier genauso gelten, sonst weichen Index und
 * Save-Pfad in ihrer Vorstellung davon ab, was existiert.
 */
import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import matter from "gray-matter";
import { parseMemoryWith } from "./schema.js";
// Case-insensitiv: Der Vault-Watcher akzeptiert `.MD`, also darf ein Scanner
// daneben nicht strenger sein — sonst sieht der Save eine Datei nicht, die der
// Index sehr wohl kennt. Die Regel steht zentral in markdown-file.ts.
import { isMarkdownFile as isMarkdown } from "./markdown-file.js";

/** Was an einem konkreten Pfad liegt. */
export type Occupant =
  /** Beweisbar nichts. NUR ENOENT/ENOTDIR — siehe {@link readOccupant}. */
  | { kind: "absent" }
  /** Ein echtes Memory, mit seiner EFFEKTIVEN id (nach der Reparatur, die
   *  auch der Vault-Index anwendet). */
  | { kind: "memory"; id: string }
  /** Eine Datei, die der Vault nicht als Memory indexieren würde — eine
   *  gewöhnliche Notiz, ein Anhang-Sidecar, was auch immer. Sie darf ein Save
   *  niemals überschreiben. */
  | { kind: "foreign" }
  /** Da liegt etwas, aber es ließ sich nicht LESEN (EACCES, EISDIR, EIO, ein
   *  hängender Cloud-Mount). Wer das mit `absent` verwechselt, zerstört genau
   *  die Dateien, die er am wenigsten beurteilen kann. Jeder Aufrufer muss
   *  fail-closed reagieren: nicht überschreiben, nicht mutieren. */
  | { kind: "unreadable"; reason: string };

/** Wo ein Memory mit dieser id liegt. `ambiguous` ist kein Ausnahmefall,
 *  sondern ein Vault-Defekt (#240/A2.3): Zwei Dateien mit derselben id lassen
 *  den Index still eine davon wählen. „Erster gewinnt" wäre hier eine
 *  Entscheidung, die dem Aufrufer nicht zusteht. */
export type Located =
  | { kind: "none" }
  | { kind: "unique"; filePath: string }
  | { kind: "ambiguous"; filePaths: string[] }
  /** Der Scan konnte nicht überall hinsehen — ein Ordner oder eine Datei war
   *  unlesbar. `none` wäre hier eine Behauptung, die der Scan nicht belegen
   *  kann: Hinter dem unlesbaren Ordner kann genau dieses Memory liegen, und
   *  ein Save darauf legte ein zweites File mit derselben id an. */
  | { kind: "incomplete"; unreadable: string[] };

/**
 * Die Auskunft, die der Save-Pfad braucht. Der Daemon reicht eine Fassung
 * durch, die den bereits geladenen Vault-Index befragt; ohne Injektion fällt
 * `saveMemory` auf {@link scanVaultForId} zurück, das dasselbe beantwortet,
 * nur teurer.
 */
export interface MemoryLocator {
  locate(id: string): Located;
}

/**
 * Was liegt an diesem Pfad?
 *
 * Nur ENOENT (und ENOTDIR, wo schon ein Vorfahre keine Ordnerkette ist) beweist
 * „da liegt nichts". Jeder ANDERE Lesefehler galt hier früher ebenfalls als
 * `absent`, und daraus wurde ein Datenverlust: Eine gewöhnliche Notiz mit
 * Dateimodus 000 am Sidecar-Pfad ließ die Schutzprüfung `absent` sehen, und
 * `save_document(overwrite=true)` ersetzte sie per `rename` vollständig. Der
 * Fehlerfall, in dem man am wenigsten über eine Datei weiß, darf nicht der
 * sein, in dem man sie am bereitwilligsten löscht.
 *
 * Ein PARSE-Fehler ist etwas anderes als ein Lesefehler: Die Datei existiert
 * und ist lesbar, sie ist nur kein Memory — `foreign`, und damit geschützt.
 */
export function readOccupant(filePath: string): Occupant {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unreadable", reason: code ?? String(err) };
  }
  return occupantOfRaw(raw, filePath);
}

/**
 * Dieselbe Identitätsauskunft, aber auf BEREITS GELESENEN Bytes.
 *
 * Wer eine Datei ändert, muss die Identität aus exakt den Bytes ableiten, auf
 * denen auch Transform und Vergleich-vor-dem-Commit beruhen. `readOccupant`
 * liest ein zweites Mal, und zwischen den beiden Reads kann die Datei durch ein
 * anderes Memory ersetzt worden sein — geprüft würde dann die eine Fassung,
 * geschrieben die andere.
 */
export function occupantOfRaw(raw: string, filePath: string): Occupant {
  try {
    // mtime 0: die Reparatur benutzt sie nur für abgeleitete Zeitstempel, und
    // hier interessiert ausschließlich die effektive id.
    const parsed = parseMemoryWith((input) => matter(input), raw, filePath, 0);
    return { kind: "memory", id: parsed.fm.id };
  } catch {
    return { kind: "foreign" };
  }
}

/**
 * Vaultweiter Scan nach der effektiven id. Der Rückfall für Aufrufer ohne
 * Index — teuer genug, dass `saveMemory` ihn nur stellt, wenn die Frage
 * überhaupt offen ist.
 */
export function scanVaultForId(vaultRoot: string, id: string): Located {
  const found: string[] = [];
  const unreadable: string[] = [];
  walk(vaultRoot, vaultRoot, id, found, unreadable);
  // Zuerst die Ehrlichkeit, dann die Funde: Ein Scan, der nicht überall
  // hinsehen konnte, darf weder `none` noch `unique` behaupten — hinter dem
  // Ordner, den er übersprungen hat, kann dieselbe id ein zweites Mal liegen.
  if (unreadable.length > 0) return { kind: "incomplete", unreadable };
  if (found.length === 0) return { kind: "none" };
  if (found.length === 1) return { kind: "unique", filePath: found[0] };
  return { kind: "ambiguous", filePaths: found };
}

function walk(
  vaultRoot: string,
  dir: string,
  id: string,
  out: string[],
  unreadable: string[],
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Ein verschwundener Ordner ist kein Defekt (paralleles Aufräumen); ein
    // Ordner, den wir nicht ÖFFNEN dürfen, ist ein blinder Fleck und muss der
    // Auskunft anzusehen sein.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") unreadable.push(dir);
    return;
  }
  for (const e of entries) {
    // `.bastra/trash` enthält gelöschte Memories, die ihre id behalten — ein
    // Treffer dort wäre eine Auferstehung, kein Fund.
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walk(vaultRoot, full, id, out, unreadable);
      continue;
    }
    if (!e.isFile() || !isMarkdown(e.name)) continue;
    const occupant = readOccupant(full);
    if (occupant.kind === "unreadable") {
      unreadable.push(full);
      continue;
    }
    if (occupant.kind === "memory" && occupant.id === id) out.push(full);
  }
}

/**
 * Dieselbe Auskunft wie {@link scanVaultForId}, nur asynchron — die Fassung,
 * die unter dem ID-Lock läuft ({@link ../id-transaction.js}).
 *
 * Zwei Unterschiede, beide notwendig, damit ein autoritativer Scan im
 * Schreibpfad überhaupt bezahlbar ist:
 *
 *   - Asynchron. `scanVaultForId` liest synchron; im Daemon blockiert das den
 *     Event-Loop für die Dauer des gesamten Vaults, und der Recall daneben
 *     steht still.
 *   - Sonst NICHTS. Insbesondere kein Vorfilter über den Rohtext.
 *
 * Hier stand ein solcher Vorfilter („enthält der Rohtext die id nicht und
 * ergibt auch der Dateiname sie nicht, kann die Datei sie nicht tragen"), und
 * er war falsch. Codex-Gegenreview (P0), nachgestellt mit
 *
 *     id: "\u0066oo"
 *
 * — gültiges YAML für `foo`. Der Vault und der synchrone Scan lasen die id als
 * `foo`, der Rohtext enthält die Zeichenfolge `foo` aber nirgends, also meldete
 * dieser Scan `none`, und der folgende Save legte eine zweite aktive
 * `foo`-Datei an. Escapes, Quoting, Zeilenfaltung, Anker/Aliase: YAML kennt
 * beliebig viele Schreibweisen für denselben String, und ein Stringtest bildet
 * keine davon ab.
 *
 * Die Regel dahinter gilt allgemein: Eine Heuristik kann nicht autoritativ
 * sein. Wer die Identitätsfrage verbindlich beantwortet, muss dieselbe Semantik
 * benutzen wie der Vault-Parser — also `occupantOfRaw`, auf jeder Datei. Was
 * das kostet, steht im Kommentar von `withIdClaim`.
 */
export async function scanVaultForIdAsync(
  vaultRoot: string,
  id: string,
  stats?: IdScanStats,
): Promise<Located> {
  const found: string[] = [];
  const unreadable: string[] = [];
  const counters: IdScanStats = stats ?? { dirs: 0, files: 0, bytes: 0, blindSpots: 0 };
  counters.dirs = 0;
  counters.files = 0;
  counters.bytes = 0;
  await walkAsync(vaultRoot, id, found, unreadable, counters);
  counters.blindSpots = unreadable.length;
  if (unreadable.length > 0) return { kind: "incomplete", unreadable };
  if (found.length === 0) return { kind: "none" };
  if (found.length === 1) return { kind: "unique", filePath: found[0] };
  return { kind: "ambiguous", filePaths: found };
}

/**
 * Was ein autoritativer Scan gekostet hat.
 *
 * Der Preis hängt nicht an der Zahl der indexierten Memories, sondern an der
 * Gesamtzahl und Gesamtgröße ALLER Markdown-Dateien im Vault — in einem großen
 * Obsidian-Vault oder auf einem Cloud-Mount ist das ein anderer Wert als lokal.
 * Deshalb wird gemessen statt geschätzt.
 */
export interface IdScanStats {
  /** Betretene Verzeichnisse. */
  dirs: number;
  /** Gelesene Markdown-Dateien. */
  files: number;
  /** Gelesene Bytes (UTF-8-Länge des Rohtexts). */
  bytes: number;
  /** Verzeichnisse und Dateien, die der Scan nicht lesen konnte. */
  blindSpots: number;
}

async function walkAsync(
  dir: string,
  id: string,
  out: string[],
  unreadable: string[],
  stats: IdScanStats,
): Promise<void> {
  stats.dirs++;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") unreadable.push(dir);
    return;
  }
  const files: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walkAsync(full, id, out, unreadable, stats);
      continue;
    }
    if (!e.isFile() || !isMarkdown(e.name)) continue;
    files.push(full);
  }
  const BATCH = 32;
  for (let i = 0; i < files.length; i += BATCH) {
    const chunk = files.slice(i, i + BATCH);
    const settled = await Promise.all(
      chunk.map(async (full) => {
        let raw: string;
        try {
          raw = await readFile(full, "utf8");
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          // Verschwunden ist kein blinder Fleck; alles andere schon.
          return code === "ENOENT" || code === "ENOTDIR"
            ? { kind: "skip" as const }
            : { kind: "unreadable" as const, full };
        }
        stats.files++;
        // Codex-Gegenreview: `raw.length` zählt UTF-16-Codeeinheiten, keine
        // Bytes. Nachgestellt an einer Datei voller Umlaute — jedes „ä" wiegt
        // auf der Platte 2 Bytes und zählte hier 1, ein Emoji 4 gegen 2. Das
        // Feld heißt „Gelesene Bytes" und trägt die Kostenmessung des
        // autoritativen Scans; auf einem deutschsprachigen Vault meldete es
        // systematisch zu wenig. `Buffer.byteLength` misst dieselbe Zeichenkette
        // ohne sie ein zweites Mal zu kodieren.
        stats.bytes += Buffer.byteLength(raw, "utf8");
        const occupant = occupantOfRaw(raw, full);
        return occupant.kind === "memory" && occupant.id === id
          ? { kind: "hit" as const, full }
          : { kind: "skip" as const };
      }),
    );
    for (const r of settled) {
      if (r.kind === "hit") out.push(r.full);
      else if (r.kind === "unreadable") unreadable.push(r.full);
    }
  }
}

/** Für Fehlermeldungen: der Pfad relativ zum Vault, in Vault-Schreibweise. */
export function vaultRelative(vaultRoot: string, filePath: string): string {
  return relative(vaultRoot, filePath).split(sep).join("/");
}

/**
 * Ein Locator aus EINEM Vault-Scan, für Aufrufer ohne geladenen Index, die
 * viele Identitätsfragen hintereinander stellen — der Folder-Import etwa
 * prüft für jede Quelldatei, ob ihre id schon jemandem gehört.
 *
 * `scanVaultForId` einzeln zu rufen wäre dort ein Scan JE DATEI. Dieser
 * Snapshot kostet einen und beantwortet alle, inklusive `ambiguous`: Die Map
 * hält je id ALLE Fundstellen, anders als ein Vault-Index, der je id genau
 * einen Eintrag führen kann.
 *
 * Der Snapshot altert, sobald geschrieben wird. Für „gehört diese id schon
 * jemandem, BEVOR ich anfange" ist genau das die richtige Frage; wer während
 * des Laufs Geschriebenes wiederfinden muss, führt sein eigenes Set (der
 * Import tut das mit `used`).
 */
export function snapshotLocator(vaultRoot: string): MemoryLocator {
  const byId = new Map<string, string[]>();
  const unreadable: string[] = [];
  collect(vaultRoot, vaultRoot, byId, unreadable);
  return {
    locate(id: string): Located {
      // Ein blinder Fleck gilt für JEDE Frage an diesen Snapshot: Der Scan
      // weiß nicht, welche ids hinter dem übersprungenen Ordner liegen, also
      // kann er für keine id `none` belegen.
      if (unreadable.length > 0) return { kind: "incomplete", unreadable };
      const hits = byId.get(id);
      if (hits === undefined || hits.length === 0) return { kind: "none" };
      if (hits.length === 1) return { kind: "unique", filePath: hits[0] };
      return { kind: "ambiguous", filePaths: hits };
    },
  };
}

function collect(
  vaultRoot: string,
  dir: string,
  out: Map<string, string[]>,
  unreadable: string[],
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") unreadable.push(dir);
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      collect(vaultRoot, full, out, unreadable);
      continue;
    }
    if (!e.isFile() || !isMarkdown(e.name)) continue;
    const occupant = readOccupant(full);
    if (occupant.kind === "unreadable") {
      unreadable.push(full);
      continue;
    }
    if (occupant.kind !== "memory") continue;
    const list = out.get(occupant.id);
    if (list === undefined) out.set(occupant.id, [full]);
    else list.push(full);
  }
}
