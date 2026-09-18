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
 *   symbols, one hop     recall 91.3 %   precision 52.4 %   complete 39/44
 *   symbols, two hops    recall 95.8 %   precision 33.0 %   complete 41/44
 *
 * The one-hop symbol answer is better on BOTH axes than the file answer it
 * replaces, and it gets there through two changes: the narrowing above, and
 * the package boundary (`external-refs.ts`) that the file answer never saw.
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

/**
 * The symbols of `file` that a unified diff touches.
 *
 * Two signals, deliberately both: the LINE RANGES of the diff mapped to the
 * symbol they fall inside, and the symbol NAMES that appear in the added or
 * removed lines. The first alone misses a rename that only shows up in the
 * export list of a barrel; the second alone misses a change to a function
 * body that never names the function.
 *
 * The OLD side of the diff is used (`@@ -from,count`), because the graph was
 * built from the checked-out tree — the same tree the diff's `a/` side is.
 * Symbols carry a start line and no end, so a changed line belongs to the last
 * symbol that starts at or before it. That is a heuristic, and it is the same
 * one an editor's breadcrumb uses.
 */
export function changedSymbolsOf(graph: LoadedGraph, file: string, diff: string): CodeSymbol[] {
  const symbols = symbolsWithLine(graph, file);
  if (symbols.length === 0) return [];

  const hit = new Set<string>();
  const lines = changedLines(diff, file);
  for (const line of lines) {
    let owner: CodeSymbol | null = null;
    for (const s of symbols) {
      if ((s.line ?? 0) > line) break;
      owner = s;
    }
    if (owner !== null) hit.add(owner.id);
  }

  const body = diffBody(diff);
  if (body.length > 0) {
    for (const s of allSymbolsOf(graph, file)) {
      // Two characters match half a repository; a file node's label is its
      // basename and would match the diff header of every hunk.
      if (s.name.length <= 2 || s.kind === "file") continue;
      if (mentions(body, s.name)) hit.add(s.id);
    }
  }

  const own = allSymbolsOf(graph, file).filter((s) => hit.has(s.id));
  return [...own, ...reExportedSymbolsIn(graph, file, body)];
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
 * The specific entry is preferred over the general one and they are not
 * combined: `packages/core/src/topics.ts` is exported both as
 * `@bastra-recall/core/topics` and through the `.` barrel, and taking the
 * barrel as well turns four importers into a hundred and twenty. Measured on
 * the scenario sample, the specific-entry rule costs 0.7 points of recall and
 * buys 0.6 points of precision — but the hundred-and-twenty answer is the one
 * that makes an agent stop reading.
 */
function exportEntriesOf(graph: LoadedGraph, file: string): string[] {
  if (graph.importersByEntry.has(file)) return [file];
  const entries: string[] = [];
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
 * Measured on the 44-scenario sample: the package hits unfiltered give 91.3 %
 * recall at 48.3 % precision, this rule 91.3 % at 52.4 %. Filtering ALWAYS —
 * including the short candidate lists — costs recall (87.5 %), because a type
 * used only as a type (`DetectedProject`) is not always named in the file that
 * breaks.
 */
const PACKAGE_HITS_WORTH_READING = 20;

/** Largest candidate file read for the check. Bigger is not a module. */
const MAX_CANDIDATE_BYTES = 2 * 1024 * 1024;

export async function narrowPackageHits(
  repo: string,
  hits: readonly AffectedHit[],
  names: readonly string[],
): Promise<AffectedHit[]> {
  const packageHits = hits.filter((h) => h.relation === PACKAGE_IMPORT);
  if (names.length === 0 || packageHits.length <= PACKAGE_HITS_WORTH_READING) return [...hits];

  const keep = new Set<string>();
  await Promise.all(
    packageHits.map(async (hit) => {
      let text: string;
      try {
        const buf = await readFile(resolve(repo, hit.file));
        if (buf.byteLength > MAX_CANDIDATE_BYTES) return;
        text = buf.toString("utf8");
      } catch {
        // Unreadable is not evidence either way, and a file the graph knows
        // but the checkout does not is exactly the stale-graph case. Dropping
        // it keeps the promise the answer makes: everything listed was seen.
        return;
      }
      if (names.some((name) => mentions(text, name))) keep.add(hit.file);
    }),
  );
  return hits.filter((h) => h.relation !== PACKAGE_IMPORT || keep.has(h.file));
}

// ─── Diff reading ────────────────────────────────────────────────

/**
 * The OLD-side line numbers a unified diff touches in `file`.
 *
 * A pure insertion has no old line of its own; it is attributed to the line it
 * is inserted after, which is the line the surrounding symbol owns anyway.
 * A diff that names no file at all (someone pasted a single hunk) is read as
 * belonging to `file`.
 */
export function changedLines(diff: string, file: string): number[] {
  const out = new Set<number>();
  let inFile = !diff.includes("diff --git") && !diff.includes("--- ");
  let old = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inFile = line.includes(` a/${file}`) || line.includes(` b/${file}`);
      continue;
    }
    if (line.startsWith("--- ")) {
      if (!diff.includes("diff --git")) inFile = line.endsWith(file) || line.endsWith("/dev/null");
      continue;
    }
    if (line.startsWith("+++ ")) continue;
    if (!inFile) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+/.exec(line);
    if (hunk !== null) {
      old = Number(hunk[1]);
      continue;
    }
    if (old === 0) continue;
    if (line.startsWith("-")) out.add(old++);
    else if (line.startsWith("+")) out.add(old);
    else if (line.startsWith(" ")) old++;
  }
  return [...out];
}

/** The added and removed lines, without the file headers. */
function diffBody(diff: string): string {
  return diff
    .split("\n")
    .filter(
      (l) =>
        (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"),
    )
    .join("\n");
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

/** The symbols of `file` that carry a line, in line order. */
function symbolsWithLine(graph: LoadedGraph, file: string): CodeSymbol[] {
  return allSymbolsOf(graph, file)
    .filter((s) => s.line !== null)
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
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
