/**
 * The intent gate for the prompt lane's change-impact block (#606).
 *
 * WHY A GATE AT ALL. The Write/Edit block has a natural trigger: a file is
 * about to be written. A prompt has none, and "inject the graph on every
 * prompt" is the failure the counter-review named first — context cost on
 * every turn for an answer almost no turn asked for. So the block is delivered
 * only when the prompt IS the question the graph answers.
 *
 * TWO CONDITIONS, BOTH REQUIRED. A phrase that asks about change impact, AND a
 * concrete target — a file, a symbol — named in the prompt. Either alone is
 * not enough: "was bricht das?" without a name has nothing to look up, and
 * "packages/core/src/save.ts" in a prompt about formatting is not a question
 * about blast radius.
 *
 * THE SECOND GATE IS THE GRAPH, NOT THIS FILE. Nothing here decides whether a
 * candidate is real; the caller resolves every candidate against the graph and
 * injects nothing when none resolves. That is what keeps the extraction below
 * able to be generous without the gate being loose: an ordinary German or
 * English word that happens to look like an identifier is simply not in
 * `idsByLabel`, and a path that is not indexed is not in `symbolsByFile`.
 *
 * WORDING, NOT PARSING. These are the phrasings the issue names, in the two
 * languages this vault is used in. They are deliberately narrow — a question
 * about dependencies in the other direction ("wovon hängt X ab?") is a
 * different question and is not in here — and they are pinned by a list of 30+
 * negative prompts in the tests, which is the only thing that keeps a widening
 * from going unnoticed.
 */

/** Phrases that ask what a change breaks — German. */
const IMPACT_DE: readonly RegExp[] = [
  // "was bricht", "was geht (dann) kaputt", "was macht das kaputt"
  /\bwas\s+(?:\w+\s+){0,3}?(?:kaputt|bricht)\b/i,
  /\bbricht\b[^.?!]{0,60}\bwenn ich\b/i,
  // "welche Dateien muss ich anpassen", "welche Stellen muss ich nachziehen"
  /\bwelche\s+(?:dateien|files|stellen|module|aufrufe)\b[^.?!]{0,80}\b(?:anpass|ändern|andern|nachzieh|mitzieh|aktualisier|anfassen|umbau)/i,
  // the call-site question, in all the shapes it gets asked in
  /\baufrufstelle/i,
  /\baufrufer\b/i,
  /\bwer\s+(?:ruft|benutzt|nutzt|verwendet)\b/i,
  /\bwas\s+h(?:ä|ae)ngt\s+(?:alles\s+)?(?:an|dran|davon)\b/i,
  /\bkompiliert\b[^.?!]{0,40}\bnicht\s+mehr\b/i,
  /\bauswirkung(?:en)?\b[^.?!]{0,60}\b(?:änder|ander|umbenenn|entfern|lösch|losch)/i,
];

/** Phrases that ask what a change breaks — English. */
const IMPACT_EN: readonly RegExp[] = [
  /\bwhat\s+(?:else\s+)?(?:will|would|could|might|does)?\s*breaks?\b/i,
  /\bbreaks?\b[^.?!]{0,60}\bif I (?:change|rename|remove|delete|move)\b/i,
  /\bwhich\s+files\b[^.?!]{0,80}\b(?:change|update|adapt|touch|adjust|fix|migrate)/i,
  /\bcall[- ]?sites?\b/i,
  /\bwho\s+(?:calls|uses|depends on)\b/i,
  /\bwhat\s+(?:calls|uses|depends on)\b/i,
  /\bblast\s+radius\b/i,
  /\bimpact\s+of\s+(?:chang|renam|remov|delet|mov)/i,
  /\b(?:stop|no longer|won't|will not)\s+compil/i,
  /\bmiss(?:ed|ing)?\s+(?:a|any|some)\s+(?:call|caller|usage)/i,
];

/** Source extensions a path candidate must carry to be one. */
const SOURCE_EXT =
  "ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|scala|sh|sql|vue|svelte";

const PATH_RE = new RegExp(String.raw`(?:^|[\s\`'"(\[,])([\w.@/-]*[\w-]\.(?:${SOURCE_EXT}))\b`, "gi");

/** Anything the user set in backticks — they marked it as code themselves. */
const BACKTICKED_RE = /`([^`\n]{2,80})`/g;

/**
 * A bare identifier worth looking up: long enough not to be an article, and
 * shaped like code rather than like prose — an internal capital (camelCase,
 * PascalCase past the first letter) or an underscore. A lowercase German or
 * English word cannot match, which is what keeps the resolver from being
 * handed the whole sentence.
 */
const IDENTIFIER_RE = /\b([A-Za-z_$][A-Za-z0-9_$]{3,})\b/g;

function looksLikeCode(token: string): boolean {
  if (token.includes("_") || token.includes("$")) return true;
  return /[a-z][A-Z]/.test(token) || /^[A-Z][a-z0-9]+[A-Z]/.test(token);
}

export interface ImpactIntent {
  /** A change-impact phrase matched. */
  asked: boolean;
  /** Repo-relative or bare file paths the prompt names, in order of appearance. */
  paths: string[];
  /** Symbol candidates the prompt names, in order of appearance. */
  symbols: string[];
}

/** Nothing is looked at past this — a pasted stack trace is not a question. */
const MAX_PROMPT_CHARS = 4000;

/**
 * Read a prompt as a change-impact question.
 *
 * `asked` alone never injects anything: the caller must also resolve one of
 * `paths` or `symbols` against the graph. Both lists are capped, because the
 * cost of resolving them is paid inside the prompt lane's budget.
 */
export function changeImpactIntent(prompt: string): ImpactIntent {
  const text = prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt;
  const asked = [...IMPACT_DE, ...IMPACT_EN].some((re) => re.test(text));
  if (!asked) return { asked: false, paths: [], symbols: [] };

  const paths = take(matches(text, PATH_RE), 4);
  const symbols: string[] = [];
  for (const raw of matches(text, BACKTICKED_RE)) {
    const token = raw.replace(/\(\)$/, "").trim();
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token) && token.length >= 2) symbols.push(token);
  }
  for (const token of matches(text, IDENTIFIER_RE)) {
    if (looksLikeCode(token)) symbols.push(token);
  }
  return { asked: true, paths, symbols: take(symbols, 8) };
}

function matches(text: string, re: RegExp): string[] {
  const out: string[] = [];
  // Cloned per call: a module-level /g regex carries `lastIndex` between calls.
  const local = new RegExp(re.source, re.flags);
  let m: RegExpExecArray | null;
  while ((m = local.exec(text)) !== null) {
    const value = (m[1] ?? "").trim();
    if (value.length > 0) out.push(value);
  }
  return out;
}

function take(values: readonly string[], n: number): string[] {
  return [...new Set(values)].slice(0, n);
}
