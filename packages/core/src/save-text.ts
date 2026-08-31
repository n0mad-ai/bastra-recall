/**
 * Split out of `save.ts` (#360 follow-up): the write path had grown past 800
 * lines, which is a context cost on every edit that touches it. Pure move —
 * no behaviour change, no renamed export.
 *
 * The pure text side of a save: slug derivation, the auto-related markers and
 * the body strippers that read around them. No I/O, no schema, no vault
 * knowledge — every function here is a string in, a string out, which is what
 * makes them safe to share with `related-enrich.ts` and the daemon.
 */
const SLUG_MAX_LEN = 80;

/**
 * Folder-Werte sind legitim mehrsegmentig ("memories/people/extern") — kein
 * Charset-Verbot wie bei id/scope, aber jedes Segment muss harmlos sein:
 * kein "..", kein ".", kein führender Punkt, keine Backslashes/NUL, nicht
 * absolut. Der Containment-Assert in saveMemory() bleibt als zweite Schicht.
 */
export function isPathSafeFolder(value: string): boolean {
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) {
    return false;
  }
  const segments = value.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  return segments.every((s) => s !== ".." && s !== "." && !s.startsWith("."));
}

/**
 * Marker-Kommentare, zwischen denen der RelatedEnricher die Auto-Wikilink-
 * Section im Body verwaltet. Obsidian rendert HTML-Kommentare als unsichtbar,
 * Wikilinks dazwischen werden aber als Edges im Graph erkannt — so kriegt
 * Obsidian unseren Auto-Graph, ohne dass die User-Notizen vermüllt werden.
 *
 * Die Konstanten sind hier (und nicht in related-enrich.ts), damit
 * `extractWikilinks()` die Section überspringen kann — sonst würde der
 * Save-Pfad die Auto-Wikilinks erneut in `related[]` spiegeln, was die
 * Trennung von Hand- und Auto-Links zerfließen ließe.
 */
export const AUTO_RELATED_START = "<!-- bastra:auto-related:start -->";
export const AUTO_RELATED_END = "<!-- bastra:auto-related:end -->";

/** Entfernt die Auto-Related-Section (Heading-Zeile inklusive Markern bis
 *  zur End-Marker-Zeile inkl.) aus dem Body. Wenn keine Section da ist,
 *  unverändert zurück. */
export function stripAutoRelatedSection(body: string): string {
  const startIdx = body.indexOf(AUTO_RELATED_START);
  const endIdx = body.indexOf(AUTO_RELATED_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return body;
  const lineStart = body.lastIndexOf("\n", startIdx) + 1;
  const afterEndNewline = body.indexOf("\n", endIdx + AUTO_RELATED_END.length);
  const cutEnd = afterEndNewline === -1 ? body.length : afterEndNewline + 1;
  return body.slice(0, lineStart) + body.slice(cutEnd);
}

/**
 * Blankt Code aus einem Markdown-Body: fenced Blöcke (``` / ~~~) und Inline-
 * Code (`…`). Zeilen bleiben erhalten (durch Leerzeichen ersetzt), damit
 * zeilenbasierte Heuristiken die Struktur nicht verlieren. Zweck: ein Body,
 * der ÜBER Wikilink-Syntax redet (`[[x]]` im Code-Beispiel), darf keine
 * Phantom-`related[]` erzeugen — genau zzallirogs Parser-Noise-Befund
 * (2026-07-18): 7 seiner „Ghosts" waren `[[x]]`/`[[slug]]` aus Prosa über
 * Links, nie echte Kanten.
 */
export function stripCodeSpans(body: string): string {
  let fenceChar: string | null = null;
  return body
    .split("\n")
    .map((line) => {
      const fm = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceChar !== null) {
        if (fm && fm[1][0] === fenceChar) fenceChar = null; // schließender Zaun
        return "";
      }
      if (fm) {
        fenceChar = fm[1][0]; // öffnender Zaun
        return "";
      }
      return line.replace(/`[^`]*`/g, " "); // Inline-Code
    })
    .join("\n");
}

/**
 * Extrahiert `[[memory-id]]`-Wikilinks aus einem Memory-Body. Slugs sind
 * `^[a-z0-9][a-z0-9_-]{0,79}$` (passt zur `slugify()`-Ausgabe). Ergebnis ist
 * dedupliziert, in der Reihenfolge des ersten Vorkommens.
 *
 * Die Auto-Related-Section und Code-Spans werden übersprungen — sonst floaten
 * Auto-Links bzw. Code-Beispiele in `related[]` rein.
 */
// `\p{L}\p{N}` statt `a-z0-9`: `slugify()` behält seit dem Cyrillic/CJK-Fix
// Buchstaben jeder Schrift, also KANN eine id `记忆` heißen — das ASCII-Muster
// fand sie nie, und `[[记忆]]` erzeugte keine Relation (Codex-Gegenreview, P2).
// Die Faltung bleibt außen vor: ids sind kanonisch klein (siehe
// `canonicalMemoryId`), und ein Wikilink zeigt auf die id, nicht auf eine
// Schreibvariante davon.
const WIKILINK_RE = /\[\[(\p{L}[\p{L}\p{N}_-]{0,79}|\p{N}[\p{L}\p{N}_-]{0,79})\]\]/gu;
export function extractWikilinks(body: string): string[] {
  const scanned = stripCodeSpans(stripAutoRelatedSection(body));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of scanned.matchAll(WIKILINK_RE)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function slugify(input: string): string {
  const lower = input
    .toLowerCase()
    // Umlaut-Transliteration MUSS vor NFKD laufen: NFKD zerlegt ä→a+combining,
    // der Diacritic-Strip macht daraus ein nacktes "a", und ein späteres
    // .replace(/ä/) fände dann kein ä mehr (→ ä/ö/ü würden zu a/o/u verstümmelt).
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "");
  const slug = lower
    // `[^a-z0-9]` erased every non-Latin letter into a separator, so a
    // Cyrillic/CJK-only title collapsed to "" and threw. `\p{L}\p{N}` + `u`
    // keep letters of any script (UTF-8 filenames are fine); ASCII titles are
    // unaffected. Umlauts still transliterate above, before this runs.
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LEN);
  if (!slug) throw new Error(`cannot slugify: ${JSON.stringify(input)}`);
  return slug;
}

/**
 * Die EINE Ableitung der Memory-id (#360-Folgefund D, Codex-Gegenreview).
 *
 * Auto-generierte ids sind über `slugify()` immer klein — eine vom Caller
 * EXPLIZIT gesetzte id passierte dagegen nur `isPathSafeComponent` und durfte
 * Großbuchstaben tragen. Folgen: (a) `doku-CarNexus-area` und
 * `doku-carnexus-area` sind zwei logische Memories, auf case-insensitiven
 * Dateisystemen aber EINE Datei — ein stilles Überschreiben; (b) das
 * Wikilink-Muster akzeptiert nur `[a-z0-9][a-z0-9_-]*`, eine großgeschriebene
 * id ist also per `[[id]]` gar nicht verlinkbar und fällt aus dem
 * Multi-Hop-Recall heraus.
 *
 * Deshalb gefaltet statt abgelehnt: ein Caller mit CamelCase-id soll schreiben
 * können, nur eben auf die kanonische id. `save-target.ts` (Zielpfad) und
 * `audit-save.ts` (diff_before-Lookup) MÜSSEN dieselbe Ableitung benutzen —
 * dass beide sie einst getrennt kopierten, war die Wurzel von #240/C6.
 */
export function canonicalMemoryId(explicitId: string | undefined, title: string): string {
  return explicitId === undefined ? slugify(title) : explicitId.toLowerCase();
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function dedupe<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
