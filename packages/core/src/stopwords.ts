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
