/**
 * Funktionswörter ohne eigenes Trigger-Signal in natürlich formulierten
 * `recall_when`-Phrasen.
 *
 * Ursprünglich nur in `reflex.ts` (Daemon) für das harte Phrasen-Matching.
 * #360 braucht denselben Begriff von "Allerweltswort" für die
 * "signifikant"-Bedingung der Zweierregel in `anchorStrength` (search.ts) —
 * eine Liste, damit Reflex-Lane und Anker-Stärke nicht auseinanderlaufen.
 *
 * #707: Daten pro Sprache (ISO-639-1), wie die Cue-Listen in
 * `daemon/src/lexicon.ts` — eine neue Sprache ist ein Eintrag, kein Code.
 * Alle Listen gelten immer (Nutzer mischen Sprachen). Der NEUTRALE Weg für
 * eine Sprache ohne Liste: kein Wort wird als Funktionswort verworfen, jedes
 * Token ab {@link MIN_SIGNIFICANT_TOKEN_LEN} Zeichen zählt. Das heißt nie
 * "feuert nie": die Reflex-Lane verlangt dann alle Tokens der Phrase im
 * Kontext (strenger), die Zweierregel des Ankers zählt ein Funktionswort mit
 * (großzügiger). Ein sprachfreier Ersatz (Dokumenthäufigkeit im Vault) ist
 * in #707 als Folgearbeit notiert.
 */
export const PHRASE_STOPWORDS_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  en: [
    "about", "after", "and", "any", "are", "before", "for", "from", "have",
    "into", "just", "should", "that", "the", "then", "this", "when", "will",
    "with", "would", "you", "your",
  ],
  de: [
    "aber", "als", "auch", "auf", "aus", "bei", "beim", "bitte", "das", "dass",
    "dem", "den", "der", "die", "ein", "eine", "einem", "einen", "einer", "für",
    "mal", "mit", "nach", "oder", "sich", "sind", "soll", "und", "von", "vor",
    "wenn", "wird", "über",
  ],
};

export const PHRASE_STOPWORDS: ReadonlySet<string> = new Set(Object.values(PHRASE_STOPWORDS_BY_LANGUAGE).flat());

/** Mindestlänge, unter der ein Token so oder so kein Inhaltswort ist
 *  (Artikel, Kurzpräpositionen wie "an", "zu"). Gleicher Wert wie
 *  `MIN_TOKEN_LEN` im Reflex-Pfad — ein Wort, kein zwei Zahlen. */
export const MIN_SIGNIFICANT_TOKEN_LEN = 3;

/**
 * #707: die BREITE Funktionswort-Liste für Ähnlichkeit und Themenwörter —
 * Duplikat-Ähnlichkeit (`daemon/src/save-similarity.ts`), Todo-Themen
 * (`todo-lane.ts`) und Acted-on-Überlappung (`tool-handlers.ts`). Vorher
 * drei eigene EN/DE-Konstanten in drei Dateien; jetzt Daten pro Sprache an
 * einer Stelle. Getrennt von {@link PHRASE_STOPWORDS_BY_LANGUAGE}, weil jene
 * Liste das Trigger-Matching (Reflex, Anker-Zweierregel) kalibriert und eng
 * bleiben muss; hier geht es nur darum, Rauschen aus Mengenvergleichen zu
 * nehmen.
 *
 * NEUTRALER Weg für eine Sprache ohne Liste: kein Wort wird verworfen. Die
 * Verbraucher vergleichen Mengen (gewichteter Jaccard, Dokumenthäufigkeit
 * über Todos, Überlappung), die Funktionswörter einer ungelisteten Sprache
 * zählen dort also mit — das dämpft die Werte, schaltet aber nichts ab. Eine
 * neue Sprache ist ein Eintrag, kein Code.
 */
export const FUNCTION_WORDS_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  en: [
    "a", "about", "after", "all", "also", "an", "and", "any", "are", "as", "at",
    "be", "because", "been", "before", "between", "but", "by", "can", "for",
    "from", "has", "have", "how", "i", "if", "in", "into", "is", "it", "its",
    "just", "not", "of", "on", "only", "or", "should", "than", "that", "the",
    "their", "then", "there", "these", "they", "this", "those", "through", "to",
    "was", "we", "were", "what", "when", "which", "will", "with", "without",
    "would", "you", "your",
  ],
  de: [
    "aber", "alle", "alles", "als", "am", "an", "auch", "auf", "aus", "bei",
    "beim", "bitte", "dann", "das", "dass", "dem", "den", "der", "des", "die",
    "durch", "ein", "eine", "einem", "einen", "einer", "für", "fur", "hat", "im",
    "in", "ist", "kann", "kein", "keine", "mal", "man", "mit", "nach", "nicht",
    "noch", "nur", "oder", "sich", "sind", "soll", "und", "von", "vor", "war",
    "waren", "wenn", "werden", "wie", "wird", "zu", "zum", "zur", "über",
  ],
};

export const FUNCTION_WORDS: ReadonlySet<string> = new Set(Object.values(FUNCTION_WORDS_BY_LANGUAGE).flat());

/**
 * #707: Wörter, die eine `recall_when`-Phrase in Alternativen teilen
 * („Nachricht oder Antwort entwerfen" → zwei Phrasen). Vorher ein festes
 * `oder|or` in `reflex.ts`. Daten pro Sprache; der sprachneutrale Teil ist
 * strukturell: ein freistehendes `/` oder `|` teilt in jeder Schrift. Eine
 * Sprache ohne Eintrag und ohne Trennzeichen fällt auf die normale Regel
 * zurück (alle Inhaltstokens müssen im Kontext stehen) — strenger, nie stumm
 * für die ganze Sprache.
 */
export const ALTERNATIVE_WORDS_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  en: ["or"],
  de: ["oder"],
  ru: ["или"],
};

export const ALTERNATIVE_WORDS: ReadonlySet<string> = new Set(Object.values(ALTERNATIVE_WORDS_BY_LANGUAGE).flat());
