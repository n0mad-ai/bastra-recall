/**
 * Cue lexicons for the stop-lane heuristics (#476) — data, not code.
 *
 * The frustration and decision cue lists used to be `const` arrays baked into
 * stop-lane.ts: adding a term — or a language — meant editing source and
 * cutting a release. They live here now as SHIPPED DEFAULTS plus an optional,
 * user-editable runtime file per lexicon. The defaults are always the floor;
 * the file EXTENDS them (it never has to restate a built-in). A missing or
 * malformed file falls back to defaults, so the Stop hook is never broken by
 * it. Reads are mtime-cached, so an edit takes effect on the next session with
 * no daemon restart and no rebuild.
 *
 * File format: one cue per line, `#` starts a comment, blank lines ignored.
 * A cue is a regex fragment in the same dialect as the defaults; stop-lane.ts
 * wraps it with the Unicode letter-boundary lookarounds. This is the
 * write-target a future automatic harvester would populate — but the floor is
 * just: stop baking the lexicon into the binary.
 *
 * Location: $BASTRA_LEXICON_DIR, else ~/.bastra/lexicon/<name>.txt.
 */
import { readFileSync, statSync } from "node:fs";
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

interface CacheEntry {
  mtimeMs: number;
  merged: string[];
}
// Keyed by the full resolved path (not the bare name), so a changed
// BASTRA_LEXICON_DIR — as tests flip it — never returns another dir's list.
const cache = new Map<string, CacheEntry>();

/**
 * A cue is a regex fragment, and a hand-edited file's likeliest malformation is
 * a regex typo (`schei(`). stop-lane.ts compiles the cues into a RegExp, so a
 * single invalid fragment would throw there — outside the Stop lane's try/catch
 * — and kill every heuristic. Validate each fragment in the SAME wrapped shape
 * both call sites compile (`(?<!\p{L})(?:…)(?!\p{L})`, `u`), and skip the bad
 * ones. This is what makes this module's "malformed → falls back to defaults"
 * guarantee actually hold for the malformation users will actually produce.
 */
function isValidCue(cue: string): boolean {
  try {
    new RegExp(`(?<!\\p{L})(?:${cue})(?!\\p{L})`, "u");
    return true;
  } catch {
    return false;
  }
}

/**
 * Defaults + the file's additions, deduped, defaults first. mtime-cached.
 * Never throws: any fs or parse error falls back to the shipped defaults, and a
 * regex-invalid line is dropped (see isValidCue) rather than poisoning the set.
 *
 * Freshness is keyed on mtime only: fine for human cross-session edits (each
 * gets a distinct mtime). A same-millisecond programmatic rewrite — e.g. a
 * future harvester writing repeatedly in one process — could read stale; add a
 * size/content hash here if that lands.
 */
function loadCues(name: string, defaults: readonly string[]): string[] {
  const path = join(lexiconDir(), `${name}.txt`);
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.merged;
    const extra = readFileSync(path, "utf8")
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
    cache.set(path, { mtimeMs, merged });
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
