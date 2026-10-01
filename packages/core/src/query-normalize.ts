/**
 * Query-Normalizer + Identifier-erhaltender Tokenizer (#162).
 *
 * Problem: Code-Lesson-Queries tragen gepunktete/gebundene/unterstrichene
 * Identifier (`my-app.config.ts`, `chat-send`, `P2.2`, `--force-push`).
 * MiniSearchs Default-Tokenizer splittet auf jeder Punktuation — Index- wie
 * Query-seitig zerfällt `my-app.config.ts` zu `my app config ts`: lauter
 * generische Terme, die Präzision genau bei der Query-Klasse kosten, für die
 * Recall gebaut ist.
 *
 * Entscheidung: Der Index splittet Identifier heute selbst (Default-
 * Tokenizer) — ein rein query-seitiges Bewahren oder Expandieren würde also
 * nie matchen. Stattdessen wird der Tokenizer auf BEIDEN Seiten getauscht:
 * MiniSearch nutzt das top-level `tokenize` auch für Queries, solange kein
 * `searchOptions.tokenize` gesetzt ist — eine Funktion, garantierte
 * Symmetrie. `tokenizeWithIdentifiers` macht Dual-Emission: der
 * zusammenhängende Identifier UND seine Teile werden emittiert. Recall
 * bleibt damit ≥ Status quo (alle bisherigen Sub-Terme sind weiter im Index
 * und in der Query), Präzision steigt über den exakten, IDF-starken
 * Identifier-Term. Kein Migrationsproblem: der Index lebt in-memory und
 * wird bei jedem Daemon-Start aus dem Vault neu gebaut.
 *
 * `normalizeQuery` ist davon unabhängige Query-Hygiene am Recall-Entry
 * (SearchIndex.recall / recallHybrid — MCP- und Hook-Pfad laufen beide da
 * durch): Längen-Cap gegen hostile Input, Whitespace-Kollaps, dangling
 * boolean-artige Operatoren an den Rändern strippen.
 */

/** Query-Längen-Cap — REINE hostile-input defense, kein Relevanz-Knob.
 *  8000 statt 1000, damit lange, legitime Hook-Prompts (gepastete Stack-
 *  traces) ihre diskriminierenden Identifier nicht verlieren (#162). */
export const QUERY_MAX_CHARS = 8000;

/** A hard cut can land between the two halves of an astral character (𠮷, an
 *  emoji) — the dangling high surrogate is not text, so it goes. */
function withoutLoneHighSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

/**
 * Schneidet `text` auf höchstens `maxChars` Zeichen — an einer Whitespace-
 * Grenze, nie mitten im Token (ein halbierter Identifier matcht nichts und
 * vergiftet fuzzy/prefix). Fallback: enthält der Kopf gar kein Whitespace
 * (ein Monster-Token), wird hart geschnitten — Defense bleibt Defense.
 * Pure, wirft nie; Rückgabe ist rechts getrimmt, wenn geschnitten wurde.
 */
export function capAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  // Schnitt fällt genau AUF Whitespace → letztes Token im Kopf ist komplett.
  if (/\s/.test(text.charAt(maxChars))) return head.trimEnd();
  // Sonst würde das Token am Schnitt halbiert → auf die letzte
  // Whitespace-Grenze im Kopf zurückfallen.
  const partialStart = head.search(/\S+$/);
  // -1: Kopf endet auf Whitespace (Grenze schon sauber). 0: Monster-Token
  // ohne jedes Whitespace → harter Schnitt.
  if (partialStart <= 0) return withoutLoneHighSurrogate(head).trimEnd();
  return head.slice(0, partialStart).trimEnd();
}

// MiniSearch-Default-Splitter ist /[\n\r\p{Z}\p{P}]+/u. Ein Token-Zeichen
// ist alles, was der Default NICHT splittet — plus `.`, `-`, `_` als
// Identifier-Kleber. Alles andere (Slash, Doppelpunkt, Quotes, …) trennt
// weiterhin, damit Pfade wie `src/search.ts:42` in Segmente zerfallen.
// Token-Zeichen = Nicht-Splitter ∪ {._-}. Als Einzelzeichen-Tests statt
// einer quantifizierten Alternation-Regex: der Scan unten ist damit
// beweisbar linear (CodeQL js/polynomial-redos flaggte die Alternation-Form,
// obwohl die Zweige disjunkt waren; die v-Flag-Klassen-Union bräuchte
// target es2024).
const GLUE_CHARS = new Set([".", "-", "_"]);
const SPLIT_CHAR_RE = /[\n\r\p{Z}\p{P}]/u;
const GLUE_SPLIT_RE = /[._-]+/;

/** Rand-Kleber (`.` `-` `_`) per Index-Scan trimmen — die naheliegende
 *  Regex (`/^[._-]+|[._-]+$/`) ist am `$`-Anker auf langen Kleber-Läufen
 *  quadratisch (CodeQL js/polynomial-redos, PR-#191-Findings). */
function trimGlue(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && GLUE_CHARS.has(token[start])) start++;
  while (end > start && GLUE_CHARS.has(token[end - 1])) end--;
  return token.slice(start, end);
}

function isTokenChar(ch: string): boolean {
  return GLUE_CHARS.has(ch) || !SPLIT_CHAR_RE.test(ch);
}

/** Linearer Roh-Token-Scan (Ersatz für die geflaggte matchAll-Regex). */
function scanRawTokens(text: string): string[] {
  const tokens: string[] = [];
  let start = -1;
  let i = 0;
  for (const ch of text) {
    if (isTokenChar(ch)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      tokens.push(text.slice(start, i));
      start = -1;
    }
    i += ch.length; // Surrogatpaare zählen 2 UTF-16-Einheiten
  }
  if (start >= 0) tokens.push(text.slice(start));
  return tokens;
}

/**
 * Gemeinsamer Tokenizer für Index- UND Query-Seite (Symmetrie-Invariante,
 * siehe Header). Emittiert pro Roh-Token den von Rand-Punktuation befreiten
 * Identifier als Ganzes; enthält er inneren Kleber (`.` `-` `_`), zusätzlich
 * seine Teile. Lowercasing übernimmt MiniSearchs `processTerm` — hier nicht
 * duplizieren.
 */
export function tokenizeWithIdentifiers(text: string): string[] {
  const out: string[] = [];
  for (const raw of scanRawTokens(text)) {
    const token = trimGlue(raw);
    if (!token) continue;
    out.push(token);
    if (GLUE_SPLIT_RE.test(token)) {
      for (const part of token.split(GLUE_SPLIT_RE)) {
        if (part) out.push(part);
      }
    }
  }
  return out;
}

// Dangling boolean-artige Operatoren an den Query-Rändern. Nur
// alleinstehende Tokens — Identifier wie `--force-push` bleiben unberührt,
// ebenso Operatoren mitten in der Query.
const DANGLING_OPS = new Set([
  "and",
  "or",
  "not",
  "&&",
  "||",
  "&",
  "|",
  "+",
  "!",
  "-",
  "--",
]);

/**
 * Pure Query-Hygiene für den Recall-Entry: Cap auf QUERY_MAX_CHARS (an
 * Whitespace-Grenze, nie mitten im Token), Whitespace-Kollaps, dangling
 * Operatoren an beiden Enden strippen. Idempotent; wirft nie.
 * Identifier-Tokens bleiben byte-identisch erhalten.
 */
export function normalizeQuery(query: string): string {
  // Cap zuerst — alles Weitere arbeitet auf gedeckelter Länge.
  const capped = capAtWordBoundary(query, QUERY_MAX_CHARS);
  const collapsed = capped.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const words = collapsed.split(" ");
  while (words.length > 0 && DANGLING_OPS.has(words[0].toLowerCase())) {
    words.shift();
  }
  while (words.length > 0 && DANGLING_OPS.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  return words.join(" ");
}
