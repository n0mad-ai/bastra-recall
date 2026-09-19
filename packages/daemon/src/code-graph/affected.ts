/**
 * "What breaks if I change this?" — answered from the CHANGED SYMBOLS, not
 * from the changed file (#582).
 *
 * WHY NOT THE FILE. The file-level answer was measured on the 44 scenarios of
 * the code-roi v3 sample (`packages/eval/code-roi/v2/`, truth = new type
 * errors after the real historical change): one hop of dependents of the whole
 * file finds 87.4 % of the breaking files at 43.5 % precision. More than half
 * of what it names imports the file without touching anything that changed,
 * and an agent that has to check 56 files to find 44 goes back to grep — which
 * is what the v3 measurement recorded it doing, in 44 of 44 runs.
 *
 * So the question is narrowed by one step before the graph is asked: which
 * symbols does this diff actually touch? Then only their dependents are
 * followed. Measured offline on the same 44 scenarios (development data by
 * now — see the report, this is not a proof of effect):
 *
 *   file, one hop        recall 87.4 %   precision 43.5 %   complete 36/44
 *   symbols, one hop     recall 96.6 %   precision 47.4 %   complete 42/44
 *   symbols, two hops    recall 98.9 %   precision 32.5 %   complete 43/44
 *
 * The one-hop symbol answer is better on BOTH axes than the file answer it
 * replaces, and it gets there through two changes: the narrowing above, and
 * the package boundary (`external-refs.ts`) that the file answer never saw.
 *
 * WHERE IT DOES NOT NARROW, IT SAYS SO. Attributing a changed line to the
 * nearest symbol above it was worth 91.3 % recall at 52.4 % precision; reading
 * the real spans off the source and taking the WHOLE file whenever a line
 * falls outside every symbol buys the five points of recall above and costs
 * five of precision. That trade is deliberate: a missing dependent is a
 * mistake the agent cannot see, one candidate too many is a file it opens and
 * closes.
 *
 * THE ANSWER IS A CANDIDATE LIST, NOT A PROOF. The graph carries extracted
 * import and call edges, no type information: it cannot know whether a caller
 * passes the argument that changed. Half of what comes back is expected to be
 * a file that survives the change untouched, and a caller nothing points at
 * (reflection, a string-keyed dispatch table, a test fixture) is not in here
 * at all. `grep` for the symbol name stays the verification step.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  bareLabel,
  dependentEdgesOf,
  type CodeSymbol,
  type LoadedGraph,
} from "./reader.js";
import { diffLines, type DiffLine } from "./diff-lines.js";
import { spansCovering, symbolSpans } from "./symbol-spans.js";

/** Deepest hop followed. Two fans out multiplicatively and is opt-in. */
export const MAX_AFFECTED_DEPTH = 2;

/** Files returned. Beyond this an agent is reading a directory listing. */
export const MAX_AFFECTED_FILES = 40;

/** Bound on the re-export walk, so a cyclic barrel cannot spin. */
const MAX_REEXPORT_STEPS = 500;

/**
 * The relation reported for an import of a workspace package by its bare
 * specifier. It is NOT one of Graphify's relations: the graph has no edge
 * here at all, and the name says where the hit came from so an agent can
 * weigh it — this one is file-level, the others are symbol-level.
 */
export const PACKAGE_IMPORT = "package_import";

/** One file that may break, and why it is in the list. */
export interface AffectedHit {
  /** The dependent file. */
  file: string;
  /** `file:line` of the depending site, or just the file when the graph had no line. */
  location: string;
  /** The changed symbol this hit hangs off, or the entry file for a package import. */
  via: string;
  /** Graphify's relation, or `package_import`. */
  relation: string;
  /** Hops from the changed symbol. 1 unless depth 2 was asked for. */
  depth: number;
}

export interface AffectedResult {
  /** Names of the symbols the diff touches, in file order. */
  changedSymbols: string[];
  hits: AffectedHit[];
  /** Just the distinct files, sorted — the short form of the same answer. */
  files: string[];
  truncated: boolean;
}

/** What a diff selects, and whether it selected anything at all. */
export interface DiffSymbols {
  symbols: CodeSymbol[];
  /**
   * True when the diff could NOT be narrowed and `symbols` is the whole file:
   * a changed line fell outside every symbol, or the source could not be read
   * to place it. The caller reports this as the whole-file answer it is.
   */
  wholeFile: boolean;
}

/**
 * The symbols of `file` that a unified diff touches.
 *
 * Two signals, deliberately both: the LINE RANGES of the diff mapped to the
 * symbol they fall inside, and the symbol NAMES that appear in the added or
 * removed lines. The first alone misses a rename that only shows up in the
 * export list of a barrel; the second alone misses a change to a function
 * body that never names the function.
 *
 * The NEW side of the diff is used (`@@ +from,count`), because the spans a
 * line is looked up in are read off the WORKING TREE — the diff's `b/` side.
 * A hunk that cannot be placed there at all takes the whole file.
 *
 * A LINE OUTSIDE EVERY SYMBOL TAKES THE WHOLE FILE. The graph carries no end
 * line, so the spans are read off the source (`symbol-spans.ts`), and a
 * changed import, a top-level constant the indexer does not carry, a doc
 * comment between two symbols or a line the source cannot place at all is not
 * attributed to the nearest symbol — it selects the whole file. That is the
 * safe side: the alternative is a confident, wrong, non-empty selection, and a
 * non-empty selection is exactly what suppresses the fallback (measured: two
 * of the five incomplete scenarios of the v3 sample were that, and both are
 * found by the whole file).
 *
 * A file with no symbols of its own — an index barrel — has no line lane at
 * all and never falls back: its answer is the re-export rule below.
 */
export function diffSymbols(graph: LoadedGraph, file: string, diff: string): DiffSymbols {
  const own = allSymbolsOf(graph, file);
  const body = diffBody(diff);
  const reExported = reExportedSymbolsIn(graph, file, body);
  const whole = (): DiffSymbols => ({ symbols: [...own, ...reExported], wholeFile: true });
  if (own.length === 0) return { symbols: reExported, wholeFile: false };

  const hit = new Set<string>();
  const changed = changedLines(diff, file);
  if (!changed.mappable) return whole();
  if (changed.lines.length > 0) {
    const spans = symbolSpans(graph.repoRoot, file, own);
    if (spans === null) return whole();
    if (spans.length > 0) {
      for (const line of changed.lines) {
        const covering = spansCovering(spans, line);
        if (covering.length === 0) return whole();
        for (const id of covering) hit.add(id);
      }
    }
  }

  if (body.length > 0) {
    for (const s of own) {
      // Two characters match half a repository; a file node's label is its
      // basename and would match the diff header of every hunk.
      if (s.name.length <= 2 || s.kind === "file") continue;
      if (mentions(body, s.name)) hit.add(s.id);
    }
  }

  return { symbols: [...own.filter((s) => hit.has(s.id)), ...reExported], wholeFile: false };
}

/** The same answer as a plain list — the shape the offline diagnostics read. */
export function changedSymbolsOf(graph: LoadedGraph, file: string, diff: string): CodeSymbol[] {
  return diffSymbols(graph, file, diff).symbols;
}

/**
 * The symbols an INDEX BARREL newly names in its diff.
 *
 * A barrel holds no symbols of its own — `packages/core/src/index.ts` is one
 * file node and a fan of `re_exports` edges — so the rules above find nothing
 * in it and the answer collapses to "every file that imports this package".
 * That is the one scenario of the sample where the query was useless (S23: an
 * export line added to core's barrel, 122 candidate importers).
 *
 * A name added to or removed from an export line is a name that really did
 * change availability, and it resolves: the symbol lives in a file the barrel
 * re-exports from. So those symbols are followed as if they had changed, which
 * for "who breaks when this export line moves" is exactly the right question.
 */
function reExportedSymbolsIn(graph: LoadedGraph, file: string, body: string): CodeSymbol[] {
  const sources = graph.reExportedFrom.get(file);
  if (sources === undefined || body.length === 0) return [];
  const out: CodeSymbol[] = [];
  for (const source of sources) {
    for (const symbol of allSymbolsOf(graph, source)) {
      if (symbol.kind === "file" || symbol.name.length <= 2) continue;
      if (mentions(body, symbol.name)) out.push(symbol);
    }
  }
  return out;
}

/**
 * The files that may break when `symbols` in `file` change.
 *
 * Three sources, in this order of trust:
 *   1. direct dependents of each changed symbol (`calls`, `imports_from`, …),
 *   2. their dependents again, when `depth` is 2,
 *   3. the files that import the workspace PACKAGE this file is exported from
 *      — file-level, because the graph has no symbol for such an import.
 *
 * (3) is only added for a file the package actually exposes: the file is
 * itself an export entry, or an entry re-exports it. A file that is internal
 * to its package cannot break another package through the package boundary,
 * and adding its importers there would be the same undirected blast radius
 * the file-level answer was measured failing at.
 */
export function affectedHits(
  graph: LoadedGraph,
  file: string,
  symbols: readonly CodeSymbol[],
  depth = 1,
): AffectedHit[] {
  const hits: AffectedHit[] = [];
  const seen = new Set<string>();
  const add = (
    dependent: CodeSymbol,
    via: string,
    relation: string,
    hopDepth: number,
  ): void => {
    if (dependent.file === file) return;
    const key = `${dependent.file}|${dependent.line ?? ""}|${via}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({
      file: dependent.file,
      location: dependent.line === null ? dependent.file : `${dependent.file}:${dependent.line}`,
      via,
      relation,
      depth: hopDepth,
    });
  };

  const firstHop: Array<{ symbol: CodeSymbol; via: string }> = [];
  for (const changed of symbols) {
    for (const edge of dependentEdgesOf(graph, changed.id)) {
      add(edge.symbol, changed.name, edge.relation, 1);
      firstHop.push({ symbol: edge.symbol, via: changed.name });
    }
  }

  if (depth > 1) {
    for (const first of firstHop) {
      for (const edge of dependentEdgesOf(graph, first.symbol.id)) {
        add(edge.symbol, first.via, edge.relation, 2);
      }
    }
  }

  for (const entry of exportEntriesOf(graph, file)) {
    for (const importer of graph.importersByEntry.get(entry) ?? []) {
      if (importer === file) continue;
      const key = `${importer}||${entry}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ file: importer, location: importer, via: entry, relation: PACKAGE_IMPORT, depth: 1 });
    }
  }

  // Package imports sort LAST within their hop. They are the file-level,
  // "this file imports the package somewhere" kind of hit; a barrel export can
  // produce a hundred of them, and without this they would push the symbol-
  // level hits — the ones that name a call site — off the end of the cap.
  hits.sort(
    (a, b) =>
      a.depth - b.depth ||
      Number(a.relation === PACKAGE_IMPORT) - Number(b.relation === PACKAGE_IMPORT) ||
      a.file.localeCompare(b.file) ||
      a.via.localeCompare(b.via),
  );
  return hits;
}

/**
 * The hits as an answer: ONE line of evidence per file, capped by file count.
 *
 * The cap counts FILES, not hits, and that is not a detail. Nine changed
 * symbols in one file produce a hit per symbol per dependent — measured, one
 * scenario of the sample reached the old 40-hit cap with six distinct files in
 * it, and the file the change really broke sat below the line. The question is
 * "which files", so the budget is spent on files.
 *
 * The kept line is the first in sort order, which is the most informative one:
 * one hop before two, a real call site before a package-level import.
 *
 * Separate from `affectedHits` because the caller may narrow the package-level
 * hits first, and narrowing AFTER the cap would throw away the precise hits it
 * kept and keep the noise it dropped.
 */
export function affectedResult(
  symbols: readonly CodeSymbol[],
  hits: readonly AffectedHit[],
): AffectedResult {
  const best = new Map<string, AffectedHit>();
  for (const hit of hits) if (!best.has(hit.file)) best.set(hit.file, hit);
  const kept = [...best.values()].slice(0, MAX_AFFECTED_FILES);
  return {
    changedSymbols: symbols.map((s) => s.name),
    hits: kept,
    files: kept.map((h) => h.file).sort(),
    truncated: best.size > kept.length,
  };
}

/**
 * The package entry files through which `file` leaves its package: the file
 * itself when it is an entry, otherwise every entry that re-exports it,
 * directly or through another barrel.
 *
 * BOTH WAYS IN COUNT. `packages/core/src/topics.ts` is exported as
 * `@bastra-recall/core/topics` AND through the `.` barrel, and files really do
 * import it both ways — the one scenario the symbol query kept missing was a
 * daemon file that takes the barrel road. Preferring the specific entry and
 * dropping the barrel was the earlier rule, because the barrel alone turns
 * four importers into a hundred and twenty and that answer makes an agent stop
 * reading. What changed is that the hundred and twenty no longer reach the
 * answer: `narrowPackageHits` reads them and keeps the ones that name a
 * changed symbol first. Measured on the sample, taking both entries moves
 * recall 95.8 → 96.6 % and complete 41 → 42 of 44, for 0.5 points of
 * precision.
 */
function exportEntriesOf(graph: LoadedGraph, file: string): string[] {
  const entries: string[] = [];
  if (graph.importersByEntry.has(file)) entries.push(file);
  for (const entry of graph.importersByEntry.keys()) {
    if (reExports(graph, entry, file)) entries.push(entry);
  }
  return entries;
}

/** Does `entry` re-export `target`, following barrels? Bounded walk. */
function reExports(graph: LoadedGraph, entry: string, target: string): boolean {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  let steps = 0;
  while (queue.length > 0 && steps++ < MAX_REEXPORT_STEPS) {
    const current = queue.shift()!;
    for (const next of graph.reExportedFrom.get(current) ?? []) {
      if (next === target) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

/**
 * A barrel export makes the package boundary useless on its own: every file
 * that imports `@bastra-recall/core` looks like a dependent of every file the
 * barrel re-exports. On this repository that is 122 files for one change in
 * `packages/core`, and no agent reads 122 candidates.
 *
 * So when the package-level hits alone run past what a person would read, they
 * are checked against the file's text for one of the changed symbol names —
 * the same grep the answer asks the agent to run, done once here where the
 * candidate list is already narrow. Symbol-level hits are never touched: they
 * came from a real edge and need no confirmation.
 *
 * THE CHECK RANKS, IT DOES NOT PROVE. A file that names nothing may still use
 * the symbol — through a barrel, a renamed default import, a structural type —
 * so only a file that was read in full and shows none of those marks is
 * dropped. The rest stay, behind the ones with real evidence (`verdictFor`).
 *
 * Measured on the 44-scenario sample, filtering ALWAYS — including the short
 * candidate lists — costs recall (87.5 % against 91.3 % at the time), because
 * a type used only as a type (`DetectedProject`) is not always named in the
 * file that breaks. Hence the threshold.
 */
const PACKAGE_HITS_WORTH_READING = 20;

/** Largest candidate file read for the check. Bigger is not a module. */
const MAX_CANDIDATE_BYTES = 2 * 1024 * 1024;

/**
 * Ways a file uses a symbol WITHOUT writing its name, so the grep says nothing
 * and the file has to stay:
 *
 *   `export * from` — a barrel passing the symbol through under its own name.
 *   `import X from`, `import * as X` — a default or namespace import; the
 *     local name is the importer's choice and need not be the original.
 *
 * Structural use — a value that happens to satisfy the changed type without
 * ever naming it — has no textual mark at all and is the one case this check
 * still loses. That is the known price of the check and the reason it only
 * runs when the candidate list is already too long to read.
 */
const INDIRECT_USE =
  /^\s*(?:export\s+\*|import\s+(?:type\s+)?(?:\*\s+as\s+)?[A-Za-z_$][\w$]*\s*(?:,|from)\s)/m;

/**
 * What reading one candidate file settled.
 *
 *   `names`     — the file writes one of the changed names. Real evidence.
 *   `unclear`   — it could use the symbol without naming it (a barrel passing
 *                 it on, a default import), or it could not be read at all.
 *   `unrelated` — read in full, names nothing, re-exports nothing.
 */
type Verdict = "names" | "unclear" | "unrelated";

export async function narrowPackageHits(
  repo: string,
  hits: readonly AffectedHit[],
  names: readonly string[],
): Promise<AffectedHit[]> {
  const packageHits = hits.filter((h) => h.relation === PACKAGE_IMPORT);
  if (names.length === 0 || packageHits.length <= PACKAGE_HITS_WORTH_READING) return [...hits];

  const verdicts = new Map<string, Verdict>();
  await Promise.all(
    packageHits.map(async (hit) => {
      verdicts.set(hit.file, await verdictFor(repo, hit.file, names));
    }),
  );
  const kept = hits.filter(
    (h) => h.relation !== PACKAGE_IMPORT || verdicts.get(h.file) !== "unrelated",
  );
  // `unclear` is kept, but LAST. The answer is capped on files, and a file
  // that only might use the symbol must not push out one that demonstrably
  // does — measured: without this ordering three scenarios of the sample lost
  // their true dependent to the cap while gaining nothing.
  const doubtful = (h: AffectedHit): boolean =>
    h.relation === PACKAGE_IMPORT && verdicts.get(h.file) === "unclear";
  return [...kept.filter((h) => !doubtful(h)), ...kept.filter(doubtful)];
}

/**
 * One candidate file, read. Only a file that was READ IN FULL and names none
 * of `names`, directly or through one of the indirect forms above, is
 * `unrelated`.
 *
 * Everything else is `unclear` and stays in the answer. A file the checkout
 * does not have (the stale-graph case), one too large to read, one that
 * re-exports onward: none of those is evidence of absence, and dropping on no
 * evidence is how a real dependent disappears from a list of candidates.
 */
async function verdictFor(
  repo: string,
  file: string,
  names: readonly string[],
): Promise<Verdict> {
  let text: string;
  try {
    const buf = await readFile(resolve(repo, file));
    if (buf.byteLength > MAX_CANDIDATE_BYTES) return "unclear";
    text = buf.toString("utf8");
  } catch {
    return "unclear";
  }
  if (names.some((name) => mentions(text, name))) return "names";
  return INDIRECT_USE.test(text) ? "unclear" : "unrelated";
}

// ─── Diff reading ────────────────────────────────────────────────

/** What a diff says about the working tree, and whether it could say it. */
export interface ChangedLines {
  /** NEW-side (working-tree) line numbers the diff touches. */
  lines: number[];
  /**
   * False when a hunk could not be placed in the working tree at all — the new
   * side is `/dev/null`, or a body line arrived before any hunk header. The
   * caller takes the whole file then: an unplaceable hunk must not silently
   * become "no line changed", which reads as a confident narrow answer.
   */
  mappable: boolean;
}

/**
 * The NEW-side line numbers a unified diff touches in `file`.
 *
 * THE NEW SIDE, NOT THE OLD ONE (#582 counter-review). The spans these numbers
 * are looked up in are read off the WORKING TREE (`symbol-spans.ts`), which is
 * the diff's `b/` side. Reading `@@ -from` instead shifted every line by
 * whatever the earlier hunks inserted, so a change to a second function landed
 * inside the first, the selection came back non-empty and wrong, and the
 * whole-file fallback — which would have found the file — never fired. The
 * graph's own line numbers are old in the same way whenever the index lags the
 * checkout, and that is what the span guards are for; mixing the two
 * coordinate systems on purpose is not.
 *
 * A REPLACEMENT RUN — one or more `-` lines directly followed by one or more
 * `+` lines — is attributed to its `+` lines alone; they carry the change. A
 * PURE DELETION, a `-` run nothing `+` follows, has no new line of its own, so
 * it is mapped to the two lines it now sits between: both, because the
 * deleted text belonged to whatever surrounded it, and one of the two
 * neighbours is the symbol that lost it. `diff-lines.ts` decides where a hunk
 * really starts and ends, so a `-`/`+` source line that itself reads as
 * `--- `/`+++ ` once diff-prefixed is content here, not a skipped header
 * (P1.2, Codex counter-review 3).
 *
 * A diff that names no file at all (someone pasted a single hunk) is read as
 * belonging to `file`.
 */
export function changedLines(diff: string, file: string): ChangedLines {
  const out = new Set<number>();
  let mappable = true;
  let inFile = true;
  const hasGitHeader = diff.includes("diff --git ");
  // The next new-side line to be consumed. 0 means "no hunk header yet".
  let next = 0;

  const lines = [...diffLines(diff)];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.kind === "file-boundary") {
      inFile = line.raw.includes(` a/${file}`) || line.raw.includes(` b/${file}`);
      next = 0;
    } else if (line.kind === "old-header") {
      if (!hasGitHeader) inFile = line.raw.endsWith(file) || line.raw.endsWith("/dev/null");
    } else if (line.kind === "new-header") {
      // The file is gone on the new side: nothing in the working tree to
      // place a line in. The whole file is the only honest answer.
      if (inFile && line.raw.slice(4).trim() === "/dev/null") mappable = false;
    } else if (!inFile) {
      continue;
    } else if (line.kind === "hunk-header") {
      // `+c,0` is git's way of saying "between new lines c and c+1", so the
      // next line to be consumed is c+1 — unlike every other hunk, where the
      // header names the first line the hunk covers.
      next = line.header.new.count === 0 ? line.header.new.start + 1 : line.header.new.start;
    } else if (line.kind === "added") {
      if (next === 0) mappable = false;
      else out.add(next++);
    } else if (line.kind === "removed") {
      if (next === 0) {
        mappable = false;
      } else if (!partOfReplacementRun(lines, i)) {
        if (next > 1) out.add(next - 1);
        out.add(next);
      }
    } else if (line.kind === "context" && next > 0) {
      next++;
    }
  }
  return { lines: [...out], mappable };
}

/**
 * Does the `removed` line at `lines[i]` belong to a replacement — a `+` line
 * follows it, once any further `-` lines and `\ No newline` markers of the
 * same run are skipped over? Checked per line, not just for the line right
 * before the first `+`, so EVERY `-` of a multi-line replacement reads as
 * replaced rather than only the last one, which used to let the earlier
 * removed lines widen the selection as if they were deletions.
 */
function partOfReplacementRun(lines: readonly DiffLine[], i: number): boolean {
  for (let j = i + 1; j < lines.length; j++) {
    const kind = lines[j].kind;
    if (kind === "removed" || kind === "no-newline") continue;
    return kind === "added";
  }
  return false;
}

/** The added and removed lines, without the file headers. */
function diffBody(diff: string): string {
  const parts: string[] = [];
  for (const line of diffLines(diff)) {
    if (line.kind === "added" || line.kind === "removed") parts.push(line.raw);
  }
  return parts.join("\n");
}

/** `name` as a whole word in `text`, without building a regex per call site. */
export function mentions(text: string, name: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(name, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + name.length] ?? "";
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
}

function isWordChar(c: string): boolean {
  return c.length === 1 && /[A-Za-z0-9_$]/.test(c);
}

// ─── Symbol lookup ───────────────────────────────────────────────

/** Every symbol the graph places in `file`, file nodes included. */
export function allSymbolsOf(graph: LoadedGraph, file: string): CodeSymbol[] {
  return (graph.symbolsByFile.get(file) ?? []).map((id) => {
    const n = graph.nodes.get(id)!;
    const name = bareLabel(n.label);
    return {
      id: n.id,
      label: n.label,
      name,
      kind: n.label.endsWith("()") ? "function" : n.file.endsWith(`/${name}`) ? "file" : "type",
      file: n.file,
      line: n.line,
    } satisfies CodeSymbol;
  });
}

/**
 * The symbols of `file` named by an explicit list of names, case-insensitive
 * and tolerant of Graphify's `()`. A name nobody knows is reported back rather
 * than silently ignored — an agent that typed a symbol that is not in the
 * graph must see that, not an empty blast radius.
 */
export function symbolsNamed(
  graph: LoadedGraph,
  file: string,
  names: readonly string[],
): { found: CodeSymbol[]; unknown: string[] } {
  const inFile = allSymbolsOf(graph, file);
  const found: CodeSymbol[] = [];
  const unknown: string[] = [];
  for (const raw of names) {
    const wanted = bareLabel(raw.trim()).toLowerCase();
    if (wanted.length === 0) continue;
    const matches = inFile.filter((s) => s.name.toLowerCase() === wanted);
    if (matches.length === 0) unknown.push(raw.trim());
    else found.push(...matches);
  }
  return { found, unknown };
}
