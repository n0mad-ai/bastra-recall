/**
 * Cue lexicons for the stop-lane heuristics (#476) — data, not code.
 *
 * The frustration and decision cue lists used to be `const` arrays baked into
 * stop-lane.ts: adding a term — or a language — meant editing source and
 * cutting a release. They live here now as SHIPPED DEFAULTS plus an optional,
 * user-editable runtime file per lexicon. The defaults are always the floor;
 * the file EXTENDS them (it never has to restate a built-in). A missing or
 * malformed file falls back to defaults, so the Stop hook is never broken by
 * it. Every read hits the file fresh (see loadCues), so an edit takes effect on
 * the next Stop event with no daemon restart and no rebuild.
 *
 * File format: one cue per line, `#` starts a comment, blank lines ignored.
 * A cue is a regex fragment in the same dialect as the defaults; stop-heuristics.ts
 * wraps it with the Unicode letter-boundary lookarounds. This is the
 * write-target a future automatic harvester would populate — but the floor is
 * just: stop baking the lexicon into the binary.
 *
 * Location: $BASTRA_LEXICON_DIR, else ~/.bastra/lexicon/<name>.txt.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Shipped cue lists keyed by ISO-639-1 code (#678) — a new language is one
 * entry here, no code change. Every shipped list stays active whatever
 * `language.primary` says: users mix languages (an English "again" in a German
 * session), and dropping a list on a settings change would silently lose cues.
 * A language WITHOUT a list is not left without a signal any more — the stop
 * lane's language-neutral checks cover it: a repeated correction for
 * frustration (#678), a pick among the agent's numbered options for a
 * decision (#707, stop-lane-choice.ts).
 * Within a list, longer variants first so the same span is not double-counted.
 *
 * #756: the plain adverb for "again" (`wieder`, `again`, `снова`, `опять`) is
 * NOT a cue on its own — "jetzt geht es wieder", "I'm back home again" and
 * "снова работает" say something works. It counts only inside a frustration
 * construction: "schon wieder", "immer wieder", "wieder nicht", "not again",
 * "broken again", "опять не …". A user who wants the bare word back can add
 * it to their frustration.txt.
 */
export const DEFAULT_FRUSTRATION_CUES_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  de: [
    "schon\\s+wieder", "immer\\s+wieder", "wieder\\s+und\\s+wieder",
    "wieder\\s+(?:nicht|kaputt|falsch|dasselbe|derselbe|das\\s+gleiche|der\\s+gleiche)",
    "wie\\s+oft", "verdammt", "schei(?:ss|ß)e",
  ],
  en: [
    "yet\\s+again", "not\\s+again", "again\\s+and\\s+again", "again\\s+the\\s+same",
    "(?:broken|wrong|failed|failing|fails)\\s+again",
    "how\\s+(?:often|many\\s+times)", "damn", "fuck", "shit",
  ],
  ru: [
    "(?:снова|опять)\\s+не", "(?:снова|опять)\\s+то\\s+же", "(?:снова|опять)\\s{1,8}слома\\p{L}*",
    "сколько\\s+раз", "ч[её]рт", "бл(?:ин|ять)",
  ],
};

export const DEFAULT_DECISION_CUES_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  de: ["ok\\s+dann", "lass\\s+uns", "entschieden", "gehen\\s+wir\\s+mit"],
  en: [
    "ok(?:ay)?\\s+then", "let['’]?s\\s+(?:go\\s+with|use)", "we['’]ll\\s+go\\s+with", "we\\s+will\\s+go\\s+with",
    "decided", "settled\\s+on",
  ],
  ru: ["решено", "остановимся\\s+на", "договорились"],
  // language-neutral
  neutral: ["final"],
};

export const DEFAULT_FRUSTRATION_CUES: readonly string[] = Object.values(DEFAULT_FRUSTRATION_CUES_BY_LANGUAGE).flat();
export const DEFAULT_DECISION_CUES: readonly string[] = Object.values(DEFAULT_DECISION_CUES_BY_LANGUAGE).flat();

export function lexiconDir(): string {
  return process.env.BASTRA_LEXICON_DIR ?? join(homedir(), ".bastra", "lexicon");
}

/** A real cue fragment is a few characters; anything this long is a mistake
 *  and only bloats the compiled alternation. */
const MAX_CUE_LENGTH = 200;

/**
 * Catastrophic (exponential) backtracking needs a repeated GROUP whose body can
 * match the same text in more than one way — `(a+)+`, `((a+))+`, `(a{1,2})+`,
 * `(a|a)+`. Recognising the ambiguous bodies is a losing game (every narrower
 * guard here had a bypass), so a cue may not repeat a group at all: `)`
 * followed by `+`, `*` or `{` is rejected. `?` stays allowed (`ok(?:ay)?`), and
 * none of the shipped defaults repeat a group. Such a cue compiles fine, but it
 * runs in the daemon on every Stop event: `(a+)+b` costs ~1 minute on a long
 * line and freezes the daemon for every session meanwhile. A repeated word is
 * still expressible without it (`haha+`, `ha(?:ha)?(?:ha)?`).
 *
 * Polynomial blowup from overlapping repeats WITHOUT a group is closed by
 * {@link tooManyQuantifiers} (#517).
 */
const RE_QUANTIFIED_GROUP = /\)[+*{]/;

/**
 * #517: A narrower cue grammar — at most {@link MAX_CUE_QUANTIFIERS}
 * quantifiers per cue. Overlapping repeats cost about n^k on a word run of
 * length n with k quantifiers: `\w*\w*\w*\w*x` took 15.6 s on 500 × `a`,
 * `\w*\w*\w*x` ~1 s on 2,000, `\w*\w*x` 28 ms on 8,000. Recognising which
 * repeats overlap is the same losing game as above (`\w*a\w*a\w*x` overlaps on
 * `aaaa…` although a literal separates the repeats), so the budget counts
 * EVERY quantifier — `*`, `+`, `?` and `{…}` — which also bounds the classic
 * `a?a?a?…aaa` explosion.
 *
 * One exemption keeps multi-word cues writable: `\s+`/`\s*` directly between
 * two literal letters (`schon\s+wieder`) cannot overlap with its neighbours —
 * a letter is never whitespace — so it does not count. All shipped defaults
 * fit this budget.
 *
 * At most ONE of them may be long (`*`, `+`, `{n,}` or an upper bound above 8). The `a`-run
 * measurements above understated the cost: the wrapper only bars a start
 * inside a run of LETTERS, so on a hex blob or a run of digits every position
 * is a start and `\w*\w*y` took 859 ms on 2,000 characters and 64 s on 8,000
 * — inside the Stop lane, in the daemon, past its own one-second budget. One
 * long repeat avoids the combinations measured above.
 */
const MAX_CUE_QUANTIFIERS = 2;
const MAX_LONG_QUANTIFIERS = 1;

function tooManyQuantifiers(cue: string): boolean {
  const counted = cue
    // letter-bounded \s+ / \s* — a LITERAL letter, not the `W` of `\W`
    .replace(/(?<=(?<!\\)\p{L})\\s[+*](?=\p{L})/gu, " ")
    .replace(/\\(?:[pP]|u)\{[^}]+\}/g, "e") // Unicode property/code point escape is one atom
    .replace(/\\./g, "e") // escapes: `\*` is a literal, `\w` one atom
    .replace(/\[(?:[^\]\\]|\\.)*\]/g, "c"); // a class is one atom
  // `?` right after `(` is group syntax, after another quantifier it is lazy.
  const quantifiers = counted.match(/(?<![(*+?}])[*+?]|\{\d+(?:,\d*)?\}/g) ?? [];
  const longRepeats = quantifiers.filter((q) => {
    if (q === "*" || q === "+") return true;
    const range = /^\{(\d+)(?:,(\d*))?\}$/.exec(q);
    if (!range) return false;
    const upper = range[2] === undefined ? Number(range[1]) : range[2] === "" ? Infinity : Number(range[2]);
    return upper > 8;
  });
  return quantifiers.length > MAX_CUE_QUANTIFIERS || longRepeats.length > MAX_LONG_QUANTIFIERS;
}

/**
 * A cue is a regex fragment, and a hand-edited file's likeliest malformation is
 * a regex typo (`schei(`). stop-heuristics.ts compiles the cues into a RegExp, so a
 * single invalid fragment would throw there — outside the Stop lane's try/catch
 * — and kill every heuristic. Validate each fragment in the SAME wrapped shape
 * both call sites compile (`(?<!\p{L})(?:…)(?!\p{L})`, `u`), and skip the bad
 * ones. This is what makes this module's "malformed → falls back to defaults"
 * guarantee actually hold for the malformation users will actually produce.
 *
 * The fragment must ALSO compile on its own. The wrapped check alone lets an
 * unbalanced cue close the wrapper's group and reopen one (`a+)+(b` compiles
 * wrapped as `(?:a+)+(b)`), which smuggles a repeated group past the wrapper
 * and lets one cue rewrite the joined alternation.
 */
function isValidCue(cue: string): boolean {
  if (cue.length > MAX_CUE_LENGTH) return false;
  if (RE_QUANTIFIED_GROUP.test(cue)) return false;
  if (tooManyQuantifiers(cue)) return false;
  try {
    new RegExp(cue, "u");
    new RegExp(`(?<!\\p{L})(?:${cue})(?!\\p{L})`, "u");
    return true;
  } catch {
    return false;
  }
}

/** A real cue file is well under a kilobyte. Cap the read so a pathological
 *  file (a 200k-line paste) cannot turn every Stop event into a multi-second
 *  read+validate pass — only the first MAX_LEXICON_BYTES are ever parsed. */
const MAX_LEXICON_BYTES = 64 * 1024;

/**
 * Read at most `max` bytes from `path` without pulling a huge file into memory.
 * If the file exceeds the cap the read stops at the boundary and the final,
 * possibly half-written line is dropped, so a cue is never truncated into a
 * different (still valid) cue.
 *
 * #517: Opened non-blocking and refused unless it is a regular file — a FIFO
 * at the cue path with no writer blocked `openSync` forever, and the Stop lane
 * runs inside the daemon. One byte more than the cap is read, so a file of
 * exactly `max` bytes counts as whole and keeps its last complete line.
 */
function readCapped(path: string, max: number): string {
  // O_NONBLOCK does not exist on Windows, where a FIFO cannot sit at a file path.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`not a regular file: ${path}`);
    const buf = Buffer.alloc(max + 1);
    const n = readSync(fd, buf, 0, max + 1, 0);
    if (n <= max) return buf.toString("utf8", 0, n); // whole file fit under the cap
    const text = buf.toString("utf8", 0, max);
    const cut = text.lastIndexOf("\n");
    return cut >= 0 ? text.slice(0, cut) : ""; // drop the truncated last line
  } finally {
    closeSync(fd);
  }
}

/**
 * Defaults + the file's additions, deduped, defaults first. Never throws: any
 * fs or parse error falls back to the shipped defaults, and a regex-invalid
 * line is dropped (see isValidCue) rather than poisoning the set.
 *
 * Read fresh every call. The file is tiny and this runs ~twice per Stop event,
 * so a cache buys nothing worth its cost — and dropping it removes the whole
 * class of freshness bugs a stat/mtime cache brings: no mtime granularity, no
 * same-millisecond staleness, no check-then-read (TOCTOU) race. An edit to the
 * file is simply picked up on the next read.
 */
function loadCues(name: string, defaults: readonly string[]): string[] {
  const path = join(lexiconDir(), `${name}.txt`);
  try {
    const extra = readCapped(path, MAX_LEXICON_BYTES)
      .split("\n")
      .map((line) => line.replace(/#.*$/, "").trim())
      .filter((line) => line.length > 0);
    const seen = new Set<string>(defaults);
    const merged = [...defaults];
    for (const e of extra) {
      if (!seen.has(e) && isValidCue(e)) {
        seen.add(e);
        merged.push(e);
      }
    }
    return merged;
  } catch {
    return [...defaults];
  }
}

/** Frustration cues: shipped defaults extended by ~/.bastra/lexicon/frustration.txt. */
export function frustrationCues(): string[] {
  return loadCues("frustration", DEFAULT_FRUSTRATION_CUES);
}

/** Decision cues: shipped defaults extended by ~/.bastra/lexicon/decision.txt. */
export function decisionCues(): string[] {
  return loadCues("decision", DEFAULT_DECISION_CUES);
}

/**
 * #707 — the #159 save-quality admission flags (save-quality.ts), formerly
 * three EN/DE regex literals. Same shape as the stop-lane cues: per-language
 * data, extended by a user file (`negative-claim.txt`, `fix-marker.txt`,
 * `imperative-lead.txt`), matched with Unicode letter boundaries.
 *
 * The neutral path for a language without a list: the flags are advisory
 * penalties, so an unlisted language gets NO penalty rather than a guessed
 * one — and the fix check has a structural half that works in every script
 * (a code span or fenced block in the body counts as a captured fix).
 */
export const DEFAULT_NEGATIVE_CLAIM_CUES_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  en: ["is\\s+broken", "does\\s?n[o']?t\\s+work", "not\\s+working", "no\\s+longer\\s+works", "never\\s+works"],
  de: ["funktioniert\\s+nicht(?:\\s+mehr)?", "ist\\s+kaputt", "geht\\s+nicht(?:\\s+mehr)?"],
  ru: ["не\\s+работает", "больше\\s+не\\s+работает", "сломан[аоы]?"],
};

export const DEFAULT_FIX_MARKER_CUES_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  en: ["fix(?:ed)?", "solution", "workaround", "instead", "how\\s+to\\s+apply"],
  de: ["lösung", "abhilfe", "stattdessen"],
  ru: ["исправлен[оаы]?", "решение", "вместо", "обходной\\s+путь"],
};

export const DEFAULT_IMPERATIVE_LEAD_CUES_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  en: ["always", "never", "don'?t", "do\\s+not", "avoid", "remember\\s+to", "ensure"],
  de: ["immer", "nie(?:mals)?", "benutze", "verwende", "vermeide", "nutze", "stelle\\s+sicher"],
  ru: ["всегда", "никогда", "не\\s+используй", "избегай", "используй"],
};

/** Negative-claim cues: defaults extended by ~/.bastra/lexicon/negative-claim.txt. */
export function negativeClaimCues(): string[] {
  return loadCues("negative-claim", Object.values(DEFAULT_NEGATIVE_CLAIM_CUES_BY_LANGUAGE).flat());
}

/** Fix-marker cues: defaults extended by ~/.bastra/lexicon/fix-marker.txt. */
export function fixMarkerCues(): string[] {
  return loadCues("fix-marker", Object.values(DEFAULT_FIX_MARKER_CUES_BY_LANGUAGE).flat());
}

/** Imperative-lead cues: defaults extended by ~/.bastra/lexicon/imperative-lead.txt. */
export function imperativeLeadCues(): string[] {
  return loadCues("imperative-lead", Object.values(DEFAULT_IMPERATIVE_LEAD_CUES_BY_LANGUAGE).flat());
}

/**
 * One alternation over `cues`, bounded by Unicode letters and digits — JS `\b`
 * is ASCII-only, so a Cyrillic cue could never match behind it. `anchored`
 * pins the match to the start of the text instead.
 */
export function cueRegex(cues: readonly string[], anchored = false): RegExp {
  const lead = anchored ? "^" : "(?<![\\p{L}\\p{N}])";
  return new RegExp(`${lead}(?:${cues.join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

/**
 * #707 — the prompt lane's assertion signals (#252, prompt-classify.ts),
 * formerly four DE/EN regex literals. Per-language data, extended by a user
 * file each (`compose-verb.txt`, `outward-artifact.txt`, `state-question.txt`,
 * `project-state.txt`), matched with {@link cueRegex}.
 *
 * The neutral path for a language without a list: the prompt is not labelled
 * `assertion` on a guess. It stays an ordinary prompt, which still recalls and
 * delivers what clears the must-load score — the label only lowers that floor.
 */
export const DEFAULT_COMPOSE_VERB_CUES_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  en: ["draft", "write", "compose", "announce", "reply", "respond", "publish"],
  de: [
    "schreib\\p{L}*", "verfass\\p{L}*", "formulier\\p{L}*", "entwirf", "entwerfe", "antworte\\p{L}*",
    "beantworte", "ver(?:ö|oe)ffentlich\\p{L}*",
  ],
  ru: [
    "напиши\\p{L}*", "написать", "составь\\p{L}*", "подготовь\\p{L}*", "сформулируй\\p{L}*", "ответь\\p{L}*",
    "ответить", "опубликуй\\p{L}*", "опубликовать",
  ],
};

export const DEFAULT_OUTWARD_ARTIFACT_CUES_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  en: [
    "release[- ]?notes?", "changelog", "announcement", "blog\\p{L}*", "newsletter", "readme", "docs?",
    "documentation", "issue", "pr", "pull[- ]?requests?", "comment", "reply", "thread", "discord", "mail",
    "e-?mail", "posting", "tweet",
  ],
  de: [
    "release-?notizen", "(?:ä|ae)nderungsprotokoll", "ank(?:ü|ue)ndigung", "dokumentation", "kommentar",
    "antwort", "beitrag",
  ],
  ru: [
    "анонс\\p{L}*", "блог\\p{L}*", "рассылк\\p{L}*", "документаци\\p{L}*", "комментари\\p{L}*", "ответ(?:а|у|ом|е|ы|ов)?",
    "тред\\p{L}*", "письм\\p{L}*",
  ],
};

export const DEFAULT_STATE_QUESTION_CUES_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  en: ["what'?s", "what\\s+is", "how\\s+(?:far|many|much|good)", "status", "state"],
  de: ["wie\\s+(?:ist|weit|viele?|gut)", "stand", "wo\\s+stehen\\s+wir"],
  ru: ["сколько", "насколько", "статус\\p{L}*", "состояни\\p{L}*", "как\\s+обстоят"],
};

export const DEFAULT_PROJECT_STATE_CUES_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  en: [
    "measured?", "measurement", "benchmark", "eval", "recall@\\w*", "numbers?", "metrics?", "coverage",
    "latency", "ceiling", "milestone", "roadmap", "release", "version", "tests?",
  ],
  de: ["zahlen", "gemessen", "messung", "kennzahl\\p{L}*"],
  ru: [
    "замер\\p{L}*", "измерен\\p{L}*", "бенчмарк\\p{L}*", "метрик\\p{L}*", "цифр\\p{L}*", "покрыти\\p{L}*",
    "релиз\\p{L}*", "верси\\p{L}*", "тест\\p{L}*",
  ],
};

/** Compose-verb cues: defaults extended by ~/.bastra/lexicon/compose-verb.txt. */
export function composeVerbCues(): string[] {
  return loadCues("compose-verb", Object.values(DEFAULT_COMPOSE_VERB_CUES_BY_LANGUAGE).flat());
}

/** Outward-artifact cues: defaults extended by ~/.bastra/lexicon/outward-artifact.txt. */
export function outwardArtifactCues(): string[] {
  return loadCues("outward-artifact", Object.values(DEFAULT_OUTWARD_ARTIFACT_CUES_BY_LANGUAGE).flat());
}

/** State-question cues: defaults extended by ~/.bastra/lexicon/state-question.txt. */
export function stateQuestionCues(): string[] {
  return loadCues("state-question", Object.values(DEFAULT_STATE_QUESTION_CUES_BY_LANGUAGE).flat());
}

/** Project-state cues: defaults extended by ~/.bastra/lexicon/project-state.txt. */
export function projectStateCues(): string[] {
  return loadCues("project-state", Object.values(DEFAULT_PROJECT_STATE_CUES_BY_LANGUAGE).flat());
}
