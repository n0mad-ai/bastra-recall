/**
 * Funktionswörter (DE+EN) ohne eigenes Trigger-Signal in natürlich
 * formulierten `recall_when`-Phrasen.
 *
 * Ursprünglich nur in `reflex.ts` (Daemon) für das harte Phrasen-Matching.
 * #360 braucht denselben Begriff von "Allerweltswort" für die
 * "signifikant"-Bedingung der Zweierregel in `anchorStrength` (search.ts) —
 * eine Liste, damit Reflex-Lane und Anker-Stärke nicht auseinanderlaufen.
 */
export const PHRASE_STOPWORDS = new Set([
  // EN
  "about", "after", "and", "any", "are", "before", "for", "from", "have",
  "into", "just", "should", "that", "the", "then", "this", "when", "will",
  "with", "would", "you", "your",
  // DE
  "aber", "als", "auch", "auf", "aus", "bei", "beim", "bitte", "das", "dass",
  "dem", "den", "der", "die", "ein", "eine", "einem", "einen", "einer", "für",
  "mal", "mit", "nach", "oder", "sich", "sind", "soll", "und", "von", "vor",
  "wenn", "wird", "über",
]);

/** Mindestlänge, unter der ein Token so oder so kein Inhaltswort ist
 *  (Artikel, Kurzpräpositionen wie "an", "zu"). Gleicher Wert wie
 *  `MIN_TOKEN_LEN` im Reflex-Pfad — ein Wort, kein zwei Zahlen. */
export const MIN_SIGNIFICANT_TOKEN_LEN = 3;
