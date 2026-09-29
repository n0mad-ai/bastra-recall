/**
 * Der Query-Router (#362): welche Arme braucht diese Anfrage?
 *
 * `routeRetrieval` (`retrieval-mode.ts`) fragt, ob der lexikalische Arm ins
 * Budget PASST — das ist die Frage der langen Prompts. Dieser Router fragt die
 * andere Hälfte: ob der dichte Arm überhaupt etwas BEITRAGEN kann. Auf zwei
 * Anfrageformen kaum:
 *
 *   - `short`: höchstens {@link ROUTER_SHORT_MAX_TERMS} eindeutige Wörter. Ein
 *     Ein- oder Zwei-Wort-Anliegen hat keinen Satz, dessen Bedeutung ein
 *     Embedding einfangen könnte, das die Wörter selbst nicht schon tragen.
 *     Gezählt wird mit `Intl.Segmenter` (Unicode-Wortgrenzen, für Schriften
 *     ohne Leerzeichen wörterbuchgestützt) — ein japanischer Satz ist sieben
 *     Wörter, nicht ein „Term" ohne Leerzeichen.
 *   - `identifier`: mindestens die Hälfte der Terme ist bezeichnerförmig
 *     (`recall_mode`, `prompt-lane.ts`, `routeRetrieval`, `a/b`, `v2`). Ein
 *     Bezeichner ist eine exakte Zeichenkette; die findet BM25, und ein
 *     Embedding verwischt sie eher, als dass es hilft.
 *
 * Alles andere bleibt `hybrid`.
 *
 * **Sprachneutral, ohne Wortliste** (Owner-Regel, #679): Beide Formen sind
 * STRUKTURELL erkannt — Termzahl, innerer Kleber (`.` `_` `/` `\` `:`),
 * Binnenmajuskel, Buchstabe neben Ziffer. Nichts davon hängt an einer Sprache;
 * `\p{Ll}`/`\p{Lu}`/`\p{L}`/`\p{N}` gelten für jede Schrift, und eine Schrift
 * ohne Groß-/Kleinschreibung fällt schlicht nicht unter die Binnenmajuskel,
 * statt falsch erkannt zu werden. „Ack-artige" Anfragen („ok", „weiter") sind
 * damit nicht über eine Liste erkannt, sondern über ihre Kürze — dieselbe
 * Regel, die jede Sprache gleich behandelt.
 *
 * Der Router ist rein rechnerisch, ohne I/O. Ob er etwas bewirkt, entscheidet
 * der Aufrufer (`BASTRA_QUERY_ROUTER`, #362: seit v1.0.1 `live`, `shadow`
 * schreibt nur die Entscheidung und die Zeit, die er gespart hätte).
 */

export type QueryArms = "bm25" | "hybrid";
export type QueryRouteReason = "short" | "identifier" | "default";

export interface QueryRoute {
  arms: QueryArms;
  reason: QueryRouteReason;
  /** Eindeutige Wörter (Unicode-Segmentierung, klein geschrieben) — die
   *  Größe, an der `short` hängt. */
  unique_terms: number;
  /** Davon bezeichnerförmig. */
  identifier_terms: number;
}

/** Bis zu so vielen eindeutigen Termen gilt eine Anfrage als `short`. */
export const ROUTER_SHORT_MAX_TERMS = 2;

/** Rand-Satzzeichen, die ein Term verliert, bevor er beurteilt wird. */
const EDGE_PUNCT = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;
/** Innerer Kleber zwischen zwei Buchstaben/Ziffern: `a.b`, `a_b`, `a/b`, `a\b`, `a::b`. */
const INNER_GLUE = /[\p{L}\p{N}][._/\\:]+[\p{L}\p{N}]/u;
/** Binnenmajuskel: `routeRetrieval`, `getHTTP`. */
const CAMEL = /\p{Ll}\p{Lu}/u;
/** Buchstabe direkt neben Ziffer: `v2`, `utf8`, `h264`. */
const LETTER_DIGIT = /\p{L}\p{N}|\p{N}\p{L}/u;
/** Ein Term zählt nur, wenn er überhaupt einen Buchstaben oder eine Ziffer trägt. */
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/** Unicode-Wortsegmentierung, einmal gebaut. Ohne Locale: die Wortgrenzen
 *  des Unicode-Standards plus ICU-Wörterbücher für CJK/Thai — keine Sprache
 *  wird bevorzugt. */
const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });

/** Ist dieser (randbereinigte) Term bezeichnerförmig? */
export function isIdentifierTerm(term: string): boolean {
  return INNER_GLUE.test(term) || CAMEL.test(term) || LETTER_DIGIT.test(term);
}

export function routeQueryArms(query: string): QueryRoute {
  // Wörter für `short`: eindeutig nach Kleinschreibung.
  const words = new Set<string>();
  for (const seg of WORDS.segment(query)) {
    if (seg.isWordLike) words.add(seg.segment.toLowerCase());
  }
  // Leerzeichen-Terme für `identifier`: Ein Bezeichner ist eine Zeichenkette
  // ohne Leerraum — die Wortsegmentierung würde `prompt-lane.ts` zerteilen.
  // Eindeutig nach Kleinschreibung, beurteilt in Originalschreibweise — die
  // Binnenmajuskel ist genau das, was ein `toLowerCase` zerstören würde.
  const terms = new Map<string, string>();
  for (const raw of query.split(/[\s\p{Z}]+/u)) {
    const term = raw.replace(EDGE_PUNCT, "");
    if (!term || !HAS_WORD_CHAR.test(term)) continue;
    const key = term.toLowerCase();
    if (!terms.has(key)) terms.set(key, term);
  }
  const unique = words.size;
  let identifiers = 0;
  for (const term of terms.values()) if (isIdentifierTerm(term)) identifiers++;
  // Eine leere Anfrage hat nichts zu routen; sie bleibt beim heutigen Weg.
  if (unique === 0) return { arms: "hybrid", reason: "default", unique_terms: 0, identifier_terms: 0 };
  if (unique <= ROUTER_SHORT_MAX_TERMS) {
    return { arms: "bm25", reason: "short", unique_terms: unique, identifier_terms: identifiers };
  }
  if (identifiers * 2 >= terms.size) {
    return { arms: "bm25", reason: "identifier", unique_terms: unique, identifier_terms: identifiers };
  }
  return { arms: "hybrid", reason: "default", unique_terms: unique, identifier_terms: identifiers };
}
