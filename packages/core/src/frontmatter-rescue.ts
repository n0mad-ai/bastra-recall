/**
 * #222 — field-level leniency for the vault loader.
 *
 * Reported by zzallirog: 28 editor-written notes dropped at daemon load, and
 * the only trace was a `console.warn` a launchd-started daemon never shows
 * anyone. README promises editing the vault in Obsidian or by hand, so a note
 * falling out of the index for one bad character is a broken promise, and a
 * silent one.
 *
 * The damage splits into two layers, and only the second is a schema problem:
 *
 *   A. The YAML never parses. Unknown escape sequences inside double-quoted
 *      values (`"it\'s"`) and unquoted scalars containing `:` or `·` throw out
 *      of gray-matter, so no `data` object is produced at all. This was 24 of
 *      the 28 files. `rescueFrontmatter` re-parses the block one TOP-LEVEL
 *      ENTRY at a time and keeps the ones that survive.
 *   B. The YAML parses but required keys are missing (4 of the 28).
 *      `repairRequired` fills them from what is knowable — the filename, the
 *      body, the file mtime — instead of rejecting the node.
 *
 * The line this does NOT cross: structural strictness. A file without
 * frontmatter, or without a recognizable `type:`, is still not a memory. And
 * nothing here is ever written back — the file on disk stays exactly as the
 * user wrote it. Repairs live in `Memory.damaged` so the vault report can show
 * them, which is the whole point: visible degradation instead of silent loss.
 */
import matter from "gray-matter";
import type { DamagedField } from "./schema.js";

/** gray-matter's public YAML engine — parses a bare fragment, no document
 *  delimiters and therefore no constructed parser input. It runs js-yaml's
 *  safe loader, so no custom tag can instantiate anything. */
function parseYamlFragment(fragment: string, options?: { listener: YamlListener }): unknown {
  return (
    matter as unknown as {
      engines: { yaml: { parse: (input: string, options?: { listener: YamlListener }) => unknown } };
    }
  ).engines.yaml.parse(fragment, options);
}

/** js-yaml's documented `listener` option: called when a node opens and closes. */
type YamlListener = (event: "open" | "close", state: { input: string; position: number; result: unknown }) => void;

export interface RescueResult {
  data: Record<string, unknown>;
  content: string;
  damaged: DamagedField[];
}

type MatterFn = (input: string) => { data: unknown; content: string };

/** Path-safe fallback id from a filename. Deliberately NOT `slugify` from
 *  `save.ts`: that module imports the schema, and the schema imports this one,
 *  so reusing it would close an import cycle for five lines of logic. */
function slugFromFilename(filePath: string): string {
  const base = (filePath.split(/[\\/]/).pop() ?? "").replace(/\.md$/i, "");
  return (
    base
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "untitled"
  );
}

/** Split a frontmatter block into its top-level entries. A new entry starts at
 *  a line with no leading whitespace that looks like `key:`; indented lines,
 *  `- ` items and blank lines belong to the entry above them. Without this a
 *  line-by-line rescue would tear a list away from its key and quietly turn
 *  `tags:\n  - a` into an empty node.
 *
 *  #365: a list item at COLUMN ZERO is still a list item. `- "when it: fires"`
 *  has no leading whitespace and contains a `:`, so it used to start a new
 *  entry — leaving the key above it parsed as `null` and the orphaned items
 *  parsed as a bare array. Obsidian and hand-written frontmatter put lists at
 *  column zero routinely (Bastra's own writer indents, which is why this never
 *  showed up in-house). The lookahead excludes `- ` and a bare `-` only: a key
 *  that merely begins with a dash (`-notakey:`) stays a key. */
function splitTopLevelEntries(block: string): string[] {
  const entries: string[] = [];
  let current: string[] = [];
  for (const line of block.split("\n")) {
    const startsEntry = /^(?!-(?:\s|$))[^\s#][^:]*:/.test(line);
    if (startsEntry && current.length > 0) {
      entries.push(current.join("\n"));
      current = [];
    }
    if (startsEntry || current.length > 0) current.push(line);
  }
  if (current.length > 0) entries.push(current.join("\n"));
  return entries;
}

/** The key an entry declares, for the damage report. */
function entryField(entry: string): string {
  return /^([^:]+):/.exec(entry)?.[1]?.trim() ?? "(unknown)";
}

/** Parse frontmatter, falling back to an entry-by-entry rescue when the block
 *  as a whole is not valid YAML. Returns null when there is no frontmatter at
 *  all — that is a plain note, not a damaged memory. */
export function rescueFrontmatter(matter: MatterFn, raw: string): RescueResult | null {
  try {
    const { data, content } = matter(raw);
    if (!data || typeof data !== "object") return null;
    return { data: data as Record<string, unknown>, content, damaged: [] };
  } catch {
    /* fall through to the rescue below */
  }

  // gray-matter refused the whole block, so find the delimiters ourselves.
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(raw);
  if (!match) return null; // unterminated or absent frontmatter — not a memory
  const [, block, rest] = match;

  const data: Record<string, unknown> = {};
  const damaged: DamagedField[] = [];
  for (const entry of splitTopLevelEntries(block)) {
    if (entry.trim().length === 0) continue;
    try {
      // An entry is a YAML fragment, so parse it AS one. The earlier version
      // wrapped it back into a `---`-delimited document and re-ran the
      // frontmatter parser over that string — which meant building a parser
      // input out of file content, flagged by CodeQL as unsafe code
      // construction (js/unsafe-code-construction). It was also the wrong
      // shape: nothing here is a document. `matter.engines.yaml.parse` is
      // gray-matter's public YAML engine and takes the fragment directly.
      const parsed = parseYamlFragment(entry);
      // An ARRAY is not a `key: value` entry — assigning one would write
      // positional `"0"`, `"1"` keys into the frontmatter. Unreachable now
      // that the splitter keeps column-zero lists with their key, and kept as
      // the belt to that pair of braces (#365).
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // #613: `parsed` is a fragment out of a block that already failed to
        // parse as a whole — the least trusted input this module sees.
        // js-yaml can hand back `__proto__` as an OWN key on `parsed`, but a
        // bare `Object.assign(data, parsed)` merges through `data`'s
        // `[[Set]]`: since `data` has no own `__proto__`, the write hits
        // `Object.prototype`'s `__proto__` accessor and replaces data's
        // prototype instead of landing as an own property — every check
        // that enumerates own keys then sees a clean frontmatter while a
        // reader using dot access (schema validation, the presence checks
        // below) picks up the smuggled fields anyway. A frontmatter field
        // literally named `__proto__` has no legitimate meaning, so it is
        // dropped rather than merged; every other key becomes a plain own
        // property via direct assignment, which is not a pollution vector
        // for a plain object (`constructor`/`prototype` are ordinary data
        // properties, not accessors).
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (key === "__proto__") continue;
          data[key] = value;
        }
      } else {
        damaged.push({ field: entryField(entry), reason: "frontmatter entry did not parse as a `key: value` mapping" });
      }
    } catch (err) {
      damaged.push({
        field: entryField(entry),
        reason: `unparseable YAML — ${String((err as Error).message).split("\n")[0]}`,
      });
    }
  }
  return { data, content: rest ?? "", damaged };
}

/** First non-empty, non-heading line of the body — the most useful thing we
 *  know about a note whose `summary:` did not survive. */
function firstProseLine(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("---")) continue;
    return trimmed.slice(0, 200);
  }
  return "";
}

/** Fill in required fields that are missing or unusable, recording each repair.
 *  Mutates `data` in place — it is the throwaway object the loader just built.
 *  `type` is deliberately NOT repaired: it is the structural marker that says
 *  "this file is a memory at all", and guessing it would pull plain Obsidian
 *  notes into the index. */
export function repairRequired(
  data: Record<string, unknown>,
  filePath: string,
  mtime: number,
  body: string,
  damaged: DamagedField[],
  isPathSafe: (value: string) => boolean
): void {
  const note = (field: string, reason: string): void => {
    if (!damaged.some((d) => d.field === field)) damaged.push({ field, reason });
  };
  const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  const nonEmptyArray = (v: unknown): v is unknown[] => Array.isArray(v) && v.length > 0;

  if (!nonEmptyString(data.id) || !isPathSafe(data.id)) {
    const had = nonEmptyString(data.id);
    data.id = slugFromFilename(filePath);
    note("id", had ? "id was not path-safe — replaced with the filename" : "missing id — derived from the filename");
  }
  if (!nonEmptyString(data.title)) {
    data.title = String(data.id).replace(/-/g, " ");
    note("title", "missing title — derived from the id");
  }
  if (!nonEmptyString(data.summary)) {
    data.summary = firstProseLine(body) || String(data.title);
    note("summary", "missing summary — derived from the body");
  }
  if (!nonEmptyArray(data.topic_path)) {
    data.topic_path = ["unsorted"];
    note("topic_path", "missing topic_path — filed under 'unsorted'");
  }
  if (!nonEmptyArray(data.tags)) {
    data.tags = ["unsorted"];
    note("tags", "missing tags — filed under 'unsorted'");
  }
  if (!nonEmptyString(data.scope)) {
    data.scope = "unsorted";
    note("scope", "missing scope — filed under 'unsorted'");
  }
  if (!nonEmptyArray(data.recall_when)) {
    // A memory with no trigger is findable by title and body only — worse than
    // an authored trigger, far better than being absent from the index.
    data.recall_when = [String(data.title)];
    note("recall_when", "missing recall_when — falling back to the title as its only trigger");
  }
  const fileDay = new Date(mtime).toISOString().slice(0, 10);
  if (data.created == null || data.created === "") {
    data.created = fileDay;
    note("created", "missing created — taken from the file mtime");
  }
  if (data.updated == null || data.updated === "") {
    data.updated = fileDay;
    note("updated", "missing updated — taken from the file mtime");
  }
}

/** js-yaml's date and timestamp shapes, plus the zone forms `Date.parse` reads. */
const WRITTEN_DATE =
  /^(\d{4})-(\d\d?)-(\d\d?)(?:(?:[Tt]|[ \t]+)(\d\d?):(\d\d):(\d\d)(?:\.\d*)?(?:[ \t]*(?:Z|[-+](\d\d?)(?::?(\d\d))?))?)?$/;

/** Anything `Date.parse` reads before this instant kept a year below 100 (with a day of zone slack). */
const EARLY_YEAR_LIMIT = Date.parse("0100-01-02T00:00:00Z");

/** False when `text` is written as a date but names an instant the calendar lacks. js-yaml and
 *  `Date.parse` roll such a value silently (`2026-02-31` → March 3, `T24:00` → next day). Years
 *  below 100 move into the 1900s when YAML builds the Date (`yamlDate`), and when `Date.parse`
 *  reads a string outside its ISO format; `'0099-03-01'` keeps its year. Text in any other shape
 *  is not judged here. */
function writtenDateExists(text: string, yamlDate: boolean): boolean {
  const m = WRITTEN_DATE.exec(text.trim());
  if (!m) return true;
  const [y, mo, d, h, mi, s, zh, zm] = m.slice(1).map((part) => Number(part ?? 0));
  // 2000 + y % 400 has the same leap years as y, and stays clear of Date.UTC's 0–99 mapping.
  const daysInMonth = new Date(Date.UTC(2000 + (y % 400), mo, 0)).getUTCDate();
  const dayExists = mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth;
  const yearKept = y >= 100 || (!yamlDate && Date.parse(text.trim()) < EARLY_YEAR_LIMIT);
  return dayExists && yearKept && h < 24 && mi < 60 && s < 60 && zh < 24 && zm < 60;
}

/** #1731: the date fields the loader checks. `created` and `updated` that name an impossible day
 *  become missing, so `repairRequired` takes them from the file mtime; `last_reviewed_at` is
 *  dropped. `valid_until` keeps the day it rolls into and is only reported: dropping an end date
 *  would serve a note that is expired today again (owner decision pending in #1731). */
const CHECKED_DATE_FIELDS = ["created", "updated", "last_reviewed_at", "valid_until"] as const;

/** An implicit YAML Date needs either a literal YYYY-MM-DD or a clock. Explicit tags
 * can also construct timestamps from quoted or folded text. Leave those forms to YAML. */
function mayContainRolledDate(block: string): boolean {
  if (/!|\d{1,2}:\d{2}:\d{2}/.test(block)) return true;
  for (const [day] of block.matchAll(/\d{4}-\d{2}-\d{2}/g)) {
    if (!writtenDateExists(day, true)) return true;
  }
  return false;
}

/** The text YAML read a timestamp from, given the node's source: without anchor and tag, quotes or
 *  a block header (`!!timestamp "…"`, `>-`), and with line breaks folded to spaces as YAML folds
 *  a multi-line scalar (`2026-02-31\n  12:30:00Z`). */
function timestampText(source: string): string {
  const text = source.trim().replace(/^(?:[&!]\S*\s+)+/, "");
  const quoted = /^(["'])([\s\S]*)\1$/.exec(text);
  // Decode escaped date digits as YAML did before constructing the timestamp.
  const decoded = quoted?.[1] === '"' && quoted[2].includes("\\") ? parseYamlFragment(text) : undefined;
  const content =
    typeof decoded === "string" ? decoded : (quoted?.[2] ?? text.replace(/^[|>][-+\d]*[ \t]*(?:#.*)?\n/, ""));
  return content.replace(/\s+/g, " ").trim();
}

/** The source text of each checked field js-yaml turned into a Date, whatever the key's quoting,
 *  spacing or trailing comment. The check skips the second parse when every date spelling in
 *  the block is a valid calendar day. A block that only loads through the rescue is read entry by entry. */
function writtenDates(raw: string): Record<string, unknown> {
  const block = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "";
  if (!mayContainRolledDate(block)) return {};
  const starts: number[] = [];
  // An alias (`*when`) hands back the anchored node's own Date; its text is where the anchor was written.
  const texts = new Map<Date, string>();
  const listener: YamlListener = (event, state) => {
    if (event === "open") {
      starts.push(state.position);
      return;
    }
    const start = starts.pop() ?? state.position;
    const date = state.result;
    if (!(date instanceof Date)) return;
    const text = texts.get(date) ?? timestampText(state.input.slice(start, state.position));
    texts.set(date, text);
    state.result = text;
  };
  const written: Record<string, unknown> = {};
  const read = (fragment: string): void => {
    const parsed = parseYamlFragment(fragment, { listener });
    if (!parsed || typeof parsed !== "object") return;
    for (const field of CHECKED_DATE_FIELDS) {
      if (Object.hasOwn(parsed, field)) written[field] = (parsed as Record<string, unknown>)[field];
    }
  };
  try {
    read(block);
  } catch {
    for (const entry of splitTopLevelEntries(block)) {
      starts.length = 0;
      try {
        read(entry);
      } catch {
        /* the rescue already reported this entry */
      }
    }
  }
  return written;
}

/** True when a checked field holds a day the calendar lacks: a Date js-yaml rolled over, or a
 *  string written as such a day. Any other value is left to the schema as before. */
function namesImpossibleDay(value: unknown, written: () => Record<string, unknown>, field: string): boolean {
  if (typeof value === "string") return !writtenDateExists(value, false);
  if (!(value instanceof Date)) return false;
  const text = written()[field];
  return !Number.isFinite(value.getTime()) || (typeof text === "string" && !writtenDateExists(text, true));
}

/** #1720/#1731: an impossible calendar day in `created`, `updated` or `last_reviewed_at` — in any
 *  YAML spelling, quoted or not — is treated as not set and reported, instead of loading as the
 *  day it rolls into. An `updated` that is no date at all (`false`, a list) is treated the same
 *  way; the other fields keep their validation. `valid_until` keeps its value and is only
 *  reported. Only the loader's copy changes, never the file. */
export function repairDates(data: Record<string, unknown>, raw: string, damaged: DamagedField[]): void {
  let cache: Record<string, unknown> | undefined;
  const written = (): Record<string, unknown> => (cache ??= writtenDates(raw));
  for (const field of CHECKED_DATE_FIELDS) {
    const v = data[field];
    if (v == null || v === "") continue;
    const noDate = field === "updated" && typeof v !== "string" && !(v instanceof Date);
    if (!noDate && !namesImpossibleDay(v, written, field)) continue;
    if (field === "valid_until") {
      damaged.push({
        field,
        reason: "valid_until was not a valid date — kept as read, so the note expires on that day",
      });
      continue;
    }
    delete data[field];
    const fallback = field === "last_reviewed_at" ? "dropped" : "taken from the file mtime";
    damaged.push({ field, reason: `${field} was not a valid date — ${fallback}` });
  }
}
