/**
 * `find_code` — the one code-awareness tool an agent calls (#576).
 *
 * WHY THIS IS NOT A SEARCH ENGINE. Graphify ships its own free-text `query`,
 * and the 17.09.2026 evaluation (#572) measured what it returns: 684 nodes for
 * one narrow question. A near-miss presented as an answer costs more than no
 * answer at all (§4.4 `no_answer`), so that lane is not used here. What is
 * used is the part of the graph that is not a guess — the exact lane of
 * §9.2-9.3: a symbol name resolves to the node with that label, a repo-
 * relative path resolves to the file with that path. Only when both come back
 * empty does a lexical fallback run over symbol labels and paths, and it says
 * so (`lane: "lexical"`), so the agent can see it is looking at a substring
 * match rather than an identity.
 *
 * WHY THE OUTPUT IS THIS SMALL. The tool answers "where is it and what
 * touches it", never "what does it say". It emits `symbol, kind, file:line,
 * community` and at most ONE hop of dependents (the hard hop budget of
 * §13.1) — no code bodies, no file contents. The agent follows `file:line`
 * with a targeted read, which costs it one Read of the lines it actually
 * needs instead of a graph-shaped wall of text in every turn.
 *
 * MEASURED on this repository's real graph (6810 nodes, 20005 edges, 9.7 MB),
 * warm, 200 iterations per lane, three runs (17.09.2026):
 *
 *   find_code("saveMemory")                  p50 0.013 ms   p90 0.019-0.022 ms
 *   find_code("packages/core/src/save.ts",
 *             mode: "affected")              p50 0.006 ms   p90 0.009 ms
 *   lexical fallback, hit ("audit-sav")      p50 0.35 ms    p90 0.41-0.48 ms
 *   lexical fallback, miss ("savememoryxy")  p50 0.46 ms    p90 0.57-0.62 ms
 *
 * against the 50 ms warm acceptance of #576 — three orders of magnitude of
 * headroom. The lexical lane is the slow one because it is the only lane that
 * scans (one pass over 6810 nodes) and its MISS is the slowest case of all,
 * since a miss is the one that cannot stop early. That is also why it stays
 * the fallback and not the default.
 *
 * COLD IS NOT AN ERROR. `CodeGraphCache.get()` returns null for a repository
 * whose graph is not in memory and starts the load in the background; a cold
 * load costs 20-26 ms and this call never waits for it. The answer is then
 * `status: "unavailable"` with the honest reason, not an empty hit list — an
 * empty list would read as "this symbol does not exist" (#575, §4.4).
 *
 * LABELS CARRY THEIR PARENTHESES. Graphify writes a callable's label as
 * `saveMemory()`, not `saveMemory`, and an agent types the bare name. The
 * reader indexes both spellings (`bareLabel`), so the exact lane here matches
 * the query verbatim and the acceptance case of #576 resolves on the name an
 * agent would actually send.
 */

import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { CodeGraphCache } from "./cache.js";
import {
  dependentFilesOf,
  dependentSymbolsOf,
  findSymbol,
  symbolsOfFile,
  type CodeSymbol,
  type LoadedGraph,
  type SymbolKind,
} from "./reader.js";

// ─── Budgets ─────────────────────────────────────────────────────

/** Anchors returned per call. More than this is a query, not an answer. */
export const MAX_HITS = 10;

/** Dependents listed per anchor — one hop, §13.1. */
export const MAX_DEPENDENTS = 8;

/** Files listed for an `affected` query on a path. */
export const MAX_AFFECTED_FILES = 40;

/**
 * Deepest hop `affected` will walk. One is the default and the budget; two is
 * reachable only by asking for it, and the second hop is capped harder than
 * the first because it fans out multiplicatively.
 */
export const MAX_DEPTH = 2;

/** Second-hop dependents, when `depth: 2` was asked for explicitly. */
export const MAX_DEPTH2_DEPENDENTS = 12;

/** Symbols listed when the query names a whole file. */
export const MAX_FILE_SYMBOLS = 20;

// ─── Arguments ───────────────────────────────────────────────────

export const FindCodeArgs = z.object({
  query: z.string().min(1),
  mode: z.enum(["find", "affected"]).optional(),
  /** Absolute path of the repository root. Defaults to the daemon's cwd. */
  repo: z.string().min(1).optional(),
  depth: z.number().int().min(1).max(MAX_DEPTH).optional(),
});

export type FindCodeInput = z.infer<typeof FindCodeArgs>;

// ─── Result shape ────────────────────────────────────────────────

export interface CodeLocation {
  symbol: string;
  kind: SymbolKind;
  file: string;
  line: number | null;
  /** `file:line`, or just `file` when the graph carried no usable line. */
  location: string;
  community: number | null;
  /** Hops from the anchor. Only set on dependents; 1 unless depth 2 was asked. */
  depth?: number;
}

export interface FindCodeHit extends CodeLocation {
  /** One hop of callers/dependents, capped. */
  dependents: CodeLocation[];
  /** True when the hop had more than the cap allows. */
  dependents_truncated: boolean;
}

/** Which lane produced the hits — the agent's signal for how much to trust them. */
export type FindCodeLane = "symbol" | "path" | "lexical";

export type FindCodeStatus = "ok" | "no_answer" | "unavailable";

export interface FindCodeResult {
  query: string;
  mode: "find" | "affected";
  repo: string;
  status: FindCodeStatus;
  /** Absent on `no_answer` and `unavailable` — no lane produced anything. */
  lane?: FindCodeLane;
  hits: FindCodeHit[];
  /** `affected` on a path: the files one hop away. Capped. */
  files?: string[];
  files_truncated?: boolean;
  /** True when more anchors matched than `MAX_HITS`. */
  truncated: boolean;
  /** One sentence for the agent. Always present on anything but `ok`. */
  note?: string;
  took_ms: number;
}

// ─── The tool definition ─────────────────────────────────────────

export const codeTools = [
  {
    name: "find_code",
    annotations: { readOnlyHint: true, destructiveHint: false },
    description:
      "Locate a symbol or file in the indexed code graph of a repository and " +
      "list what depends on it, one hop. Returns symbol, kind, file:line and " +
      "community — never code bodies; follow file:line with a targeted read.\n" +
      "\n" +
      "WHEN IT HELPS more than Grep: 'who calls this', 'what breaks if I " +
      "change this', 'where is this defined' — questions about relations " +
      "between files, which a text search answers only by reading everything " +
      "it matched. Grep stays the better tool for string literals, comments, " +
      "config values and anything that is not a declared symbol.\n" +
      "\n" +
      "Matching is exact first: a symbol name (with or without `()`) or a " +
      "repo-relative path. A substring fallback runs only when both come back " +
      "empty and reports itself as `lane: \"lexical\"`. Nothing matches → " +
      "`status: \"no_answer\"` and an empty list: the tool does not return " +
      "near-misses.\n" +
      "\n" +
      "`status: \"unavailable\"` means the graph for this repository is not " +
      "in memory (loading, not indexed, or degraded). It is not an error and " +
      "says nothing about whether the symbol exists — use Grep for this turn.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "A symbol name ('saveMemory'), a repo-relative path " +
            "('packages/core/src/save.ts'), or a short phrase for the " +
            "lexical fallback.",
        },
        mode: {
          type: "string",
          enum: ["find", "affected"],
          description:
            "'find' (default) locates the symbol or file. 'affected' answers " +
            "'what depends on this' and matches exactly only — no lexical " +
            "fallback, because a blast radius computed from a substring " +
            "guess is worse than none.",
        },
        repo: {
          type: "string",
          description:
            "Absolute path of the repository root. Defaults to the daemon's " +
            "working directory, so pass your own cwd when they differ.",
        },
        depth: {
          type: "number",
          description:
            "'affected' only: 1 (default) or 2 hops. The second hop fans out " +
            "multiplicatively and is capped harder than the first.",
        },
      },
      required: ["query"],
    },
  },
];

// ─── The shared cache ────────────────────────────────────────────

let shared: CodeGraphCache | null = null;

/**
 * The graph cache the MCP and REST paths share, created on first use.
 *
 * Both dispatchers are stateless functions, so without one shared instance
 * each call would arrive cold and the cache would never be warm for anyone.
 * It is a lazy singleton rather than a module constant so that a daemon that
 * never answers a `find_code` call never builds one — and so the wiring
 * (#577/#581) can hand its own instance in through `setSharedCodeGraphCache`
 * without this module needing to know it exists. Tests pass their own cache
 * to `findCode` directly and never touch this.
 */
export function sharedCodeGraphCache(): CodeGraphCache {
  if (shared === null) shared = new CodeGraphCache();
  return shared;
}

/** Hand the daemon's own cache in, once it owns one. */
export function setSharedCodeGraphCache(cache: CodeGraphCache): void {
  shared = cache;
}

// ─── The tool ────────────────────────────────────────────────────

/**
 * Answer one `find_code` call. Synchronous by construction: every lane reads
 * an index that is already in memory, or the call reports itself unavailable.
 */
export function findCode(cache: CodeGraphCache, args: FindCodeInput): FindCodeResult {
  const startedAt = performance.now();
  const mode = args.mode ?? "find";
  const repo = isAbsolute(args.repo ?? "") ? (args.repo as string) : resolve(args.repo ?? process.cwd());
  const query = args.query.trim();

  const base = { query, mode, repo, hits: [] as FindCodeHit[], truncated: false };
  const done = (r: Omit<FindCodeResult, "took_ms">): FindCodeResult => ({
    ...r,
    took_ms: Number((performance.now() - startedAt).toFixed(3)),
  });

  const graph = cache.get(repo);
  if (graph === null) {
    return done({
      ...base,
      status: "unavailable",
      note: unavailableNote(cache, repo),
    });
  }

  const anchors = mode === "affected" ? exactAnchors(graph, query) : allAnchors(graph, query);
  if (anchors === null) {
    return done({
      ...base,
      status: "no_answer",
      note:
        mode === "affected"
          ? `No symbol or file in ${shortRepo(repo)} is named exactly "${query}". ` +
            `'affected' matches exactly on purpose — run it again with the exact ` +
            `symbol or repo-relative path, or use 'find' first.`
          : `Nothing in the code graph of ${shortRepo(repo)} matches "${query}". ` +
            `The graph indexes declared symbols and files, so a string literal, ` +
            `a comment or a config value will not be in it — Grep for those.`,
    });
  }

  const depth = mode === "affected" ? (args.depth ?? 1) : 1;
  const capped = anchors.symbols.slice(0, MAX_HITS);

  // A path anchor spends its ONE hop on the file list, not on each symbol.
  // "What depends on save.ts" is a question about files; hopping from all
  // nine symbols of the file as well would repeat the same answer nine times
  // and blow the output budget on it. So a path anchor lists where its
  // symbols are, and the blast radius once, in `files`.
  const files = anchors.file !== null ? dependentFilesOf(graph, anchors.file) : null;
  const hits = capped.map((s) => (files === null ? hitFor(graph, s, depth) : anchorOnly(graph, s)));

  return done({
    ...base,
    status: "ok",
    lane: anchors.lane,
    hits,
    truncated: anchors.symbols.length > capped.length,
    ...(files !== null
      ? {
          files: files.slice(0, MAX_AFFECTED_FILES),
          files_truncated: files.length > MAX_AFFECTED_FILES,
        }
      : {}),
    ...(anchors.lane === "lexical"
      ? {
          note:
            `No exact symbol or path matched, so these are substring matches ` +
            `over symbol names and paths. Check the names before acting on them.`,
        }
      : {}),
  });
}

// ─── Lanes ───────────────────────────────────────────────────────

interface Anchors {
  lane: FindCodeLane;
  symbols: CodeSymbol[];
  /** Set when the query named a whole file, so dependents are files too. */
  file: string | null;
}

/**
 * The exact lane (§9.2-9.3): a symbol label or a repo-relative path, matched
 * as an identity. Both spellings of a callable are tried, because Graphify
 * writes `saveMemory()` where an agent types `saveMemory`.
 */
function exactAnchors(graph: LoadedGraph, query: string): Anchors | null {
  const symbols = findSymbol(graph, query);
  if (symbols.length > 0) return { lane: "symbol", symbols, file: null };

  const file = normalizePath(query);
  if (file !== null && graph.symbolsByFile.has(file)) {
    return { lane: "path", symbols: symbolsOfFile(graph, file).slice(0, MAX_FILE_SYMBOLS), file };
  }
  return null;
}

/** The exact lane, then the lexical fallback. Used by `find` only. */
function allAnchors(graph: LoadedGraph, query: string): Anchors | null {
  const exact = exactAnchors(graph, query);
  if (exact !== null) return exact;

  const needle = query.toLowerCase();
  if (needle.length < 3) return null; // two characters match half the repo.

  const symbols: CodeSymbol[] = [];
  for (const node of graph.nodes.values()) {
    if (!node.label.toLowerCase().includes(needle) && !node.file.toLowerCase().includes(needle)) {
      continue;
    }
    const symbol = symbolById(graph, node.id);
    if (symbol === null) continue;
    symbols.push(symbol);
    // One over the cap is enough to report truncation without scanning on.
    if (symbols.length > MAX_HITS) break;
  }
  return symbols.length > 0 ? { lane: "lexical", symbols, file: null } : null;
}

// ─── Hops ────────────────────────────────────────────────────────

/** One anchor with no hop — used where the hop is answered in `files`. */
function anchorOnly(graph: LoadedGraph, symbol: CodeSymbol): FindCodeHit {
  return { ...location(graph, symbol), dependents: [], dependents_truncated: false };
}

/** One anchor plus its dependents, one hop (two only when asked for). */
function hitFor(graph: LoadedGraph, symbol: CodeSymbol, depth: number): FindCodeHit {
  const first = ranked(dependentSymbolsOf(graph, symbol.id));
  const dependents = first.slice(0, MAX_DEPENDENTS).map((d) => location(graph, d, 1));

  if (depth > 1) {
    const seen = new Set([symbol.id, ...first.map((d) => d.id)]);
    for (const d of first.slice(0, MAX_DEPENDENTS)) {
      for (const second of ranked(dependentSymbolsOf(graph, d.id))) {
        if (seen.has(second.id)) continue;
        seen.add(second.id);
        dependents.push(location(graph, second, 2));
        if (dependents.length >= MAX_DEPENDENTS + MAX_DEPTH2_DEPENDENTS) break;
      }
      if (dependents.length >= MAX_DEPENDENTS + MAX_DEPTH2_DEPENDENTS) break;
    }
  }

  return {
    ...location(graph, symbol),
    dependents,
    dependents_truncated: first.length > MAX_DEPENDENTS,
  };
}

/**
 * Dependents in the order they are worth reading, and deterministically so.
 *
 * Graphify emits a file node per file, so an importing file appears twice in
 * a hop: once as the symbol that uses it and once as the file itself. Both are
 * true, but the symbol is the one an agent can act on, and on the real graph
 * the file nodes outnumber the symbols — unsorted, they ate most of the cap
 * and the useful callers fell off the end.
 */
function ranked(symbols: CodeSymbol[]): CodeSymbol[] {
  return [...symbols].sort((a, b) => {
    if ((a.kind === "file") !== (b.kind === "file")) return a.kind === "file" ? 1 : -1;
    return a.file === b.file ? (a.line ?? 0) - (b.line ?? 0) : a.file.localeCompare(b.file);
  });
}

// ─── Shaping ─────────────────────────────────────────────────────

function location(graph: LoadedGraph, s: CodeSymbol, depth?: number): CodeLocation {
  return {
    // The bare name, not Graphify's `saveMemory()` label: this is the string
    // the agent will type back into the next call or into a Grep.
    symbol: s.name,
    kind: s.kind,
    file: s.file,
    line: s.line,
    location: s.line === null ? s.file : `${s.file}:${s.line}`,
    community: graph.nodes.get(s.id)?.community ?? null,
    ...(depth === undefined ? {} : { depth }),
  };
}

/**
 * One symbol by node id. The reader indexes by label, not by id, and does not
 * export the node-to-symbol shaping — so the lexical lane, which scans nodes,
 * goes back through the label index rather than deriving `name` and `kind` a
 * second time here. Duplicating that derivation is how the two would drift.
 */
function symbolById(g: LoadedGraph, id: string): CodeSymbol | null {
  const node = g.nodes.get(id);
  if (node === undefined) return null;
  return findSymbol(g, node.label).find((s) => s.id === id) ?? null;
}

/**
 * A query treated as a path: backslashes normalized, a leading `./` dropped.
 * Deliberately NOT repaired beyond that — an absolute path or a `..` escape
 * is refused here for the same reason the reader refuses it in the graph
 * (validate.ts): a rewritten path is a guess about what the caller meant.
 */
function normalizePath(query: string): string | null {
  const norm = query.replace(/\\/g, "/").replace(/^\.\//, "");
  if (norm.length === 0 || norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) return null;
  if (norm.split("/").includes("..")) return null;
  return norm;
}

/**
 * Why code awareness is not answering. The distinction matters to the agent:
 * a graph that is loading will be there next call, one that was refused will
 * not be there until someone rebuilds it.
 */
function unavailableNote(cache: CodeGraphCache, repo: string): string {
  const degraded = cache.stats().degraded.find((d) => d.repoRoot === repo);
  if (degraded !== undefined) {
    return (
      `Code awareness is unavailable for ${shortRepo(repo)}: the code graph was ` +
      `refused (${degraded.reason}). Run \`bastra doctor\` for the detail. ` +
      `This says nothing about whether the symbol exists — use Grep for now.`
    );
  }
  return (
    `Code awareness is not ready for ${shortRepo(repo)} — the graph is not in ` +
    `memory yet and is loading in the background (this call did not wait for ` +
    `it). Use Grep for this turn; a later call may have it.`
  );
}

/** The last two path segments: enough to recognise the repo, short in context. */
function shortRepo(repo: string): string {
  const parts = repo.split("/").filter((p) => p.length > 0);
  return parts.slice(-2).join("/") || repo;
}
