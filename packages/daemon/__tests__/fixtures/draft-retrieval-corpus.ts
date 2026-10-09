/** Fixed synthetic review corpus: 200 DE/EN drafts and 200 labelled queries.
 * Literal data reviewed from the independent C-review probe; builder is local. */
import { draftFingerprint, draftId, type Draft } from "../../src/draft-store.js";
const T: [string, string[], string[], string[]][] = [
  ["drucker", ["der Purpurdrucker im Flur braucht Zyanpatronen vom Typ K9", "der Purpurdrucker druckt nur wenn das Fach zwei gefüllt ist"], ["the purple printer in the hallway needs cyan cartridges of type K9", "the purple printer only prints when tray two is filled"], ["purpurdrucker", "zyanpatronen", "printer"]],
  ["tunnel", ["der Granitserver ist nur über den Tunnel am Sprungrechner erreichbar", "für den Granitserver muss zuerst der Tunnel stehen"], ["the granite server is only reachable through the tunnel on the jump host", "the tunnel has to be up before touching the granite server"], ["granitserver", "tunnel", "granite"]],
  ["paket", ["in diesem Projekt nehmen wir pnpm und niemals npm", "das Lockfile bricht wenn jemand npm statt pnpm benutzt"], ["in this project we use pnpm and never npm", "the lockfile breaks when someone uses npm instead of pnpm"], ["pnpm", "lockfile", "npm"]],
  ["release", ["ausgeliefert wird nur dienstags nach dem Review", "am Freitag gibt es keine Auslieferung mehr"], ["we only ship on tuesdays after the review", "there is no shipping on fridays anymore"], ["auslieferung", "dienstags", "shipping"]],
  ["datenbank", ["die Testdatenbank lauscht auf Port 55432", "die Testdatenbank wird jede Nacht neu aufgesetzt"], ["the test database listens on port 55432", "the test database is rebuilt every night"], ["testdatenbank", "55432", "database"]],
  ["bilder", ["Vorschaubilder werden auf 640 Pixel skaliert", "Vorschaubilder landen im Ordner klein und nicht im Ordner roh"], ["thumbnails are scaled to 640 pixels", "thumbnails go into the small folder and not into raw"], ["vorschaubilder", "640", "thumbnails"]],
  ["farben", ["das dunkle Schema nimmt Anthrazit statt Schwarz", "Warnungen sind Bernstein und nicht Rot"], ["the dark theme uses anthracite instead of black", "warnings are amber and not red"], ["anthrazit", "bernstein", "theme"]],
  ["tabelle", ["die Tabelle order_items wird nie direkt geändert", "Änderungen an order_items laufen über eine Migration"], ["the table order_items is never changed directly", "changes to order_items go through a migration"], ["order_items", "migration", "table"]],
  ["logs", ["Logs sind JSON mit einer Anfragekennung in jeder Zeile", "die Anfragekennung steht im Feld rid"], ["logs are JSON with a request identifier on every line", "the request identifier lives in the rid field"], ["anfragekennung", "rid", "logs"]],
  ["docker", ["der Docker Build braucht das Cache Volume", "ohne Cache Volume dauert die Pipeline zwanzig Minuten"], ["the docker build needs the cache volume", "without the cache volume the pipeline takes twenty minutes"], ["docker", "volume", "pipeline"]],
  ["zweige", ["Zweige heißen wie das Ticket", "ein Zweig wird nach dem Review nicht mehr umgeschrieben"], ["branches are named after the ticket", "a branch is not rewritten after the review"], ["zweig", "ticket", "branches"]],
  ["zeit", ["Zeitstempel werden in UTC gespeichert", "umgerechnet wird erst in der Anzeige"], ["timestamps are stored in UTC", "conversion happens only in the presentation layer"], ["zeitstempel", "utc", "timestamps"]],
  ["rechnung", ["der Rechnungsexport läuft nachts", "der Rechnungsexport schreibt eine CSV auf die Finanzfreigabe"], ["the invoice export runs at night", "the invoice export writes a CSV to the finance share"], ["rechnungsexport", "csv", "invoice"]],
  ["index", ["der Suchindex wird nach jedem Massenimport neu gebaut", "der Suchindex wird nie schrittweise ergänzt"], ["the search index is rebuilt after every bulk import", "the search index is never updated incrementally"], ["suchindex", "massenimport", "index"]],
  ["tests", ["Testdaten liegen neben den Tests", "Testdaten werden mit dem Saatskript neu erzeugt"], ["test fixtures live next to the tests", "test fixtures are regenerated with the seed script"], ["testdaten", "saatskript", "fixtures"]],
  ["wetter", ["der Schlüssel zur Wetterschnittstelle liegt im Tresor unter meteo-dev", "die Wetterschnittstelle erlaubt nur zehn Abfragen pro Minute"], ["the key for the weather API is in the safe under meteo-dev", "the weather API allows only ten requests per minute"], ["wetterschnittstelle", "meteo-dev", "weather"]],
  ["zwischenspeicher", ["nach einem Schemawechsel wird der Zwischenspeicher geleert", "der Zwischenspeicher auf dem Vorschauserver hält eine Stunde"], ["after a schema change the cache gets flushed", "the cache on the preview server lasts one hour"], ["zwischenspeicher", "schemawechsel", "preview"]],
  ["schalter", ["Funktionsschalter stehen in flags.yaml", "Funktionsschalter werden jeden Sprint geprüft"], ["feature flags live in flags.yaml", "feature flags are reviewed every sprint"], ["funktionsschalter", "flags.yaml", "sprint"]],
  ["wiederholung", ["Hintergrundaufgaben versuchen es dreimal", "nach drei Versuchen gibt es einen Alarm"], ["background jobs retry three times", "after three attempts an alert goes out"], ["hintergrundaufgaben", "alarm", "retry"]],
  ["typen", ["TypeScript läuft hier im strikten Modus", "implizite any Werte sind verboten"], ["typescript runs in strict mode here", "implicit any values are forbidden"], ["typescript", "strikten", "strict"]],
];
const DE = ["Bitte denk daran, dass FACT", "Nein, FACT, das hatte ich dir schon gesagt", "Wie gesagt: FACT, und das bleibt auch so", "Ich will dass du dir merkst: FACT", "Das ist falsch, FACT, bitte ändere das"];
const EN = ["Please remember that FACT", "No, FACT, I told you that already", "As I said: FACT, and it stays that way", "I want you to keep in mind that FACT", "That is wrong, FACT, please change it"];
const unrelatedDe = ["Kannst du mir bitte erklären wie man einen Hefeteig ansetzt", "Ich will dass du die Überschrift auf der Startseite größer machst", "Bitte schreibe eine kurze Mail an die Hausverwaltung wegen der Heizung", "Das ist gut so, mach bitte mit dem nächsten Schritt weiter", "Wie gesagt, das Layout der Seite bleibt so und wird nicht geändert", "Nein, das hatte ich anders gemeint, bitte nochmal von vorne", "Sag mir bitte kurz was der Unterschied zwischen Zebra und Giraffe ist", "Ich habe dir das schon gesagt, bitte ändere die Reihenfolge der Kapitel", "Fasse mir das Protokoll vom Elternabend in drei Sätzen zusammen", "Welche Bahn fährt morgen früh am schnellsten nach Lindau", "Bitte denk daran, dass wir morgen die Fahrräder abholen", "Das ist falsch, die Summe in der Spalte muss höher sein", "Mach den Text freundlicher und kürzer", "Ich will das so nicht, bitte ändere das wieder zurück", "Übersetze den Absatz über die Gartenarbeit ins Englische"];
const unrelatedEn = ["Can you please explain how to proof a sourdough starter", "I want you to make the headline on the landing page bigger", "Please write a short mail to the landlord about the heating", "That is fine, please continue with the next step", "As I said, the layout of the page stays and it is not changed", "No, I meant that differently, please start over", "Tell me the difference between a zebra and a giraffe", "I told you that already, please change the order of the chapters", "Summarise the minutes of the parents evening in three sentences", "Which train is the fastest to the lake tomorrow morning", "Please remember that we pick up the bikes tomorrow", "That is wrong, the total in the column has to be higher", "Make the text friendlier and shorter", "I want you to change it back, that is not what I asked", "Translate the paragraph about gardening into German"];
const short = ["das ist gut", "bitte ändere das", "ich will das", "nein das nicht", "wie gesagt bitte", "das hatte ich", "bitte denk daran", "das bleibt so", "ich hatte gesagt", "du hast das", "that is it", "please change it", "I want that", "no not that", "as I said", "I told you", "please remember that", "it stays that", "you have that", "and that is", "ist das so", "und das auch", "that is wrong", "das ist falsch", "is that already", "schon gesagt bitte", "dass du das", "I want you", "keep that in", "change that please", "mach das bitte", "das auch bitte", "sag das nochmal", "do that please", "ok und das", "ja das ist", "yes that is", "nicht so bitte", "bitte so lassen", "leave it that"];
export function draftRetrievalCorpus(now = Date.now()) {
  const rows: Draft[] = [];
  const topicOf = new Map<string, string>();
  const queries: { text: string; kind: "topical" | "unrelated" | "short"; topic?: string }[] = [];
  for (const [key, de, en, kw] of T) {
    for (let v = 0; v < 5; v++) for (const [lang, templates, facts] of [["de", DE, de], ["en", EN, en]] as const) {
      const quote = templates[v].replace("FACT", facts[v % 2]);
      const fp = draftFingerprint(quote); const session = `${key}-${lang}-${v}`;
      const row: Draft = { id: draftId(session, 0, fp), fp, kind: "typed", quote,
        evidence: [{ session_id: session, turn: 0, ts: now }], created: now, last_touched: now,
        state: "open", surfaced: [], situation: { before: [], after: [], reads: [], lits: [] } };
      rows.push(row); topicOf.set(row.id, key);
    }
    for (const text of [
      `Wie war das nochmal mit ${kw[0]} und ${kw[1]}?`, `${kw[0]} ${kw[1]}`,
      `What do we know about the ${kw[2]} and ${kw[1]}?`,
      `Kannst du bitte prüfen ob das mit ${kw[0]} noch stimmt und mir danach kurz sagen was du geändert hast`,
      `Please update the docs so that ${kw[2]} and ${kw[0]} are described correctly`,
    ]) queries.push({ text, kind: "topical", topic: key });
  }
  for (let i = 0; i < 2; i++) for (const text of [...unrelatedDe, ...unrelatedEn]) queries.push({ text: i ? text + " und sag Bescheid wenn es fertig ist" : text, kind: "unrelated" });
  for (const text of short) queries.push({ text, kind: "short" });
  return { rows, queries, topicOf };
}
