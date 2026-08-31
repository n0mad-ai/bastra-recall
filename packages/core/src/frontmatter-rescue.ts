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
function parseYamlFragment(fragment: string): unknown {
  return (matter as unknown as {
    engines: { yaml: { parse: (input: string) => unknown } };
  }).engines.yaml.parse(fragment);
}

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
        Object.assign(data, parsed as Record<string, unknown>);
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
  isPathSafe: (value: string) => boolean,
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
