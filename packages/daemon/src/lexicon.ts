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
 * A cue is a regex fragment in the same dialect as the defaults; stop-lane.ts
 * wraps it with the Unicode letter-boundary lookarounds. This is the
 * write-target a future automatic harvester would populate — but the floor is
 * just: stop baking the lexicon into the binary.
 *
 * Location: $BASTRA_LEXICON_DIR, else ~/.bastra/lexicon/<name>.txt.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// de / en / ru — longer variants first so the same span is not double-counted.
export const DEFAULT_FRUSTRATION_CUES: readonly string[] = [
  // de
  "schon\\s+wieder", "wieder", "wie\\s+oft", "verdammt", "schei(?:ss|ß)e",
  // en
  "yet\\s+again", "again", "how\\s+(?:often|many\\s+times)", "damn", "fuck", "shit",
  // ru
  "снова", "опять", "сколько\\s+раз", "ч[её]рт", "бл(?:ин|ять)",
];

export const DEFAULT_DECISION_CUES: readonly string[] = [
  // de
  "ok\\s+dann", "lass\\s+uns", "entschieden", "gehen\\s+wir\\s+mit",
  // en
  "ok(?:ay)?\\s+then", "let['’]?s\\s+(?:go\\s+with|use)", "we(?:['’]ll|\\s+will)\\s+go\\s+with",
  "decided", "settled\\s+on",
  // ru
  "решено", "остановимся\\s+на", "договорились",
  // language-neutral
  "final",
];

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
 */
const MAX_CUE_QUANTIFIERS = 2;

function tooManyQuantifiers(cue: string): boolean {
  const counted = cue
    // letter-bounded \s+ / \s* — a LITERAL letter, not the `W` of `\W`
    .replace(/(?<=(?<!\\)\p{L})\\s[+*](?=\p{L})/gu, " ")
    .replace(/\\./g, "e") // escapes: `\*` is a literal, `\w` one atom
    .replace(/\[(?:[^\]\\]|\\.)*\]/g, "c"); // a class is one atom
  // `?` right after `(` is group syntax, after another quantifier it is lazy.
  const quantifiers = counted.match(/(?<![(*+?}])[*+?]|\{\d/g) ?? [];
  return quantifiers.length > MAX_CUE_QUANTIFIERS;
}

/**
 * A cue is a regex fragment, and a hand-edited file's likeliest malformation is
 * a regex typo (`schei(`). stop-lane.ts compiles the cues into a RegExp, so a
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
