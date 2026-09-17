/**
 * In-process reader for Graphify's `graph.json` (#575).
 *
 * Why Node and not the Graphify CLI: one `graphify affected` call costs
 * 140-220 ms of Python start-up, and the PreToolUse Write/Edit lane runs at
 * p50 49 ms / p90 87 ms against a 200 ms target (`hook-budgets.ts`). The hook
 * path never spawns Python.
 *
 * COLD START IS NOT FREE, and the original plan's flat "under 10 ms" hid that.
 * Measured twice on this repo:
 *
 *   read 3.70 ms + parse 13.34 ms + index 3.67 ms = 20.72 ms   (9.7 MB graph)
 *   read 5.89 ms + parse 15.24 ms + index 5.23 ms = 26.35 ms   (11.1 MB graph)
 *
 * with ~20 MB of heap each. The warm path is a different world: p50 0.003 ms,
 * p90 0.005 ms over 200 lookups. So the contract is warm-only, and a caller
 * arriving cold gets `null` immediately while the load runs in the background
 * (`ensureLoaded`). A cold hook emits no block — silently, not as an error.
 *
 * Everything the graph says is treated as untrusted (see validate.ts).
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  CODE_FILE_TYPE,
  DEPENDENCY_RELATIONS,
  EXTRACTED,
  MAX_EDGES,
  MAX_GRAPH_BYTES,
  MAX_NODES,
  STRUCTURE_RELATIONS,
} from "./limits.js";
import { safeEdge, safeNode, type RejectReason, type SafeNode } from "./validate.js";

export const GRAPH_DIR_NAME = "graphify-out";
export const GRAPH_FILE_NAME = "graph.json";

export function graphDirOf(repoRoot: string): string {
  return join(repoRoot, GRAPH_DIR_NAME);
}

export function graphFileOf(repoRoot: string): string {
  return join(graphDirOf(repoRoot), GRAPH_FILE_NAME);
}

/**
 * What kind of thing a node is, derived from how Graphify labels it.
 *
 * Measured on the real graph: Graphify appends `()` to callable labels
 * (`saveMemory()`, `cloneForAudit()`) and leaves types, classes and interfaces
 * bare (`DeleteMemoryResult`, `Prewarmer`). A file is a node too, labelled
 * with its basename at `L1`.
 *
 * `kind` is a presentation detail — but the parenthesis is not, see
 * `bareLabel` below.
 */
export type SymbolKind = "function" | "type" | "file";

/** A symbol as it is handed out: allowlisted fields only. */
export interface CodeSymbol {
  id: string;
  /** Graphify's label verbatim, e.g. `saveMemory()`. */
  label: string;
  /** The label without Graphify's callable parentheses, e.g. `saveMemory`. */
  name: string;
  kind: SymbolKind;
  file: string;
  line: number | null;
}

/** One loaded graph plus its indexes. Immutable once built. */
export interface LoadedGraph {
  repoRoot: string;
  /** Nodes by id, code locations only. */
  nodes: Map<string, SafeNode>;
  /** File -> ids of the symbols defined in it. */
  symbolsByFile: Map<string, string[]>;
  /**
   * Lowercased symbol name -> ids, for the exact lane. Keyed on the BARE name
   * (`savememory`), because that is what a human or an agent types; the
   * parenthesized form is indexed alongside it so both hit.
   */
  idsByLabel: Map<string, string[]>;
  /** Symbol id -> ids that depend on it (reverse dependency edges). */
  dependentsBySymbol: Map<string, string[]>;
  /** Relations seen in the file that are on neither allowlist, with counts.
   *  Surfaced in `bastra doctor` so the lists stay honest as Graphify moves. */
  unknownRelations: Map<string, number>;
  /** Bytes of the source file — the input to the LRU heap budget. */
  sizeBytes: number;
  /** mtime of the source file, for reload detection. */
  mtimeMs: number;
  /** Commit the graph itself claims, cross-checked against the manifest. */
  builtAtCommit: string | null;
}

export type LoadResult =
  | { ok: true; graph: LoadedGraph }
  | { ok: false; reason: RejectReason; detail?: string };

/**
 * Read, validate and index one graph. Never throws: every failure becomes a
 * `reason`, because the one thing this must not do is take recall down with it
 * (C-089, §23).
 */
export async function loadGraph(repoRoot: string): Promise<LoadResult> {
  const file = graphFileOf(repoRoot);

  let sizeBytes: number;
  let mtimeMs: number;
  try {
    const st = await stat(file);
    sizeBytes = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (sizeBytes > MAX_GRAPH_BYTES) {
    return { ok: false, reason: "too-large", detail: `${sizeBytes} bytes` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { ok: false, reason: "not-json" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "wrong-shape" };

  const root = parsed as Record<string, unknown>;
  const rawNodes = root.nodes;
  const rawLinks = root.links;
  if (!Array.isArray(rawNodes) || !Array.isArray(rawLinks)) {
    return { ok: false, reason: "wrong-shape" };
  }
  if (rawNodes.length > MAX_NODES) {
    return { ok: false, reason: "too-many-nodes", detail: String(rawNodes.length) };
  }
  if (rawLinks.length > MAX_EDGES) {
    return { ok: false, reason: "too-many-edges", detail: String(rawLinks.length) };
  }

  const nodes = new Map<string, SafeNode>();
  const symbolsByFile = new Map<string, string[]>();
  const idsByLabel = new Map<string, string[]>();
  for (const raw of rawNodes) {
    const n = safeNode(raw, CODE_FILE_TYPE);
    if (n === null) continue;
    nodes.set(n.id, n);
    push(symbolsByFile, n.file, n.id);
    // Indexed under both spellings: `savememory()` as written, and
    // `savememory` as asked for. Without the bare key an exact lookup of
    // `saveMemory` would miss every function in the graph.
    const label = n.label.toLowerCase();
    push(idsByLabel, label, n.id);
    const bare = bareLabel(label);
    if (bare !== label) push(idsByLabel, bare, n.id);
  }

  const dependentsBySymbol = new Map<string, string[]>();
  const unknownRelations = new Map<string, number>();
  for (const raw of rawLinks) {
    const relation = relationOf(raw);
    if (relation !== null && !DEPENDENCY_RELATIONS.has(relation) && !STRUCTURE_RELATIONS.has(relation)) {
      unknownRelations.set(relation, (unknownRelations.get(relation) ?? 0) + 1);
    }
    const e = safeEdge(raw, EXTRACTED);
    if (e === null || !DEPENDENCY_RELATIONS.has(e.relation)) continue;
    // Both ends must be known code nodes: an edge into a `concept` or
    // `rationale` node is not a place anyone can navigate to.
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
    push(dependentsBySymbol, e.target, e.source);
  }

  const builtAtCommit = typeof root.built_at_commit === "string" ? root.built_at_commit : null;
  return {
    ok: true,
    graph: {
      repoRoot,
      nodes,
      symbolsByFile,
      idsByLabel,
      dependentsBySymbol,
      unknownRelations,
      sizeBytes,
      mtimeMs,
      builtAtCommit,
    },
  };
}

/** The symbols defined in one file, repo-relative POSIX path. */
export function symbolsOfFile(g: LoadedGraph, file: string): CodeSymbol[] {
  return (g.symbolsByFile.get(file) ?? []).map((id) => toSymbol(g.nodes.get(id)!));
}

/**
 * The files that depend on `file`, one hop, extracted edges only (13.1).
 * The file itself is never in the result: a symbol calling its neighbour in
 * the same file is not blast radius, and listing it would spend the block's
 * token budget on something the agent is already looking at.
 */
export function dependentFilesOf(g: LoadedGraph, file: string): string[] {
  const out = new Set<string>();
  for (const id of g.symbolsByFile.get(file) ?? []) {
    for (const dep of g.dependentsBySymbol.get(id) ?? []) {
      const n = g.nodes.get(dep);
      if (n !== undefined && n.file !== file) out.add(n.file);
    }
  }
  return [...out].sort();
}

/** Symbols that depend on one symbol id, one hop. */
export function dependentSymbolsOf(g: LoadedGraph, symbolId: string): CodeSymbol[] {
  return (g.dependentsBySymbol.get(symbolId) ?? []).map((id) => toSymbol(g.nodes.get(id)!));
}

/**
 * Exact symbol lookup by name, case-insensitive (§9.2-9.3 exact lane).
 * Exact only, deliberately: Graphify's own free-text `query` returned 684
 * nodes for a narrow question in the evaluation, and a near-miss presented as
 * an answer is worse than an honest empty result (§4.4 `no_answer`).
 */
export function findSymbol(g: LoadedGraph, name: string): CodeSymbol[] {
  return (g.idsByLabel.get(name.trim().toLowerCase()) ?? []).map((id) => toSymbol(g.nodes.get(id)!));
}

function toSymbol(n: SafeNode): CodeSymbol {
  const name = bareLabel(n.label);
  return { id: n.id, label: n.label, name, kind: kindOf(n, name), file: n.file, line: n.line };
}

/**
 * Graphify's label without its callable parentheses. `saveMemory()` becomes
 * `saveMemory`; a bare label is returned unchanged.
 *
 * This is the one piece of Graphify's labelling convention Recall has to know,
 * and it was found by testing against the real graph rather than a fixture:
 * the acceptance case of #576 asks for `find_code("saveMemory")`, and every
 * function in the graph is labelled with the parentheses, so an exact lookup
 * of the bare name would have returned nothing for every function.
 */
export function bareLabel(label: string): string {
  return label.endsWith("()") ? label.slice(0, -2) : label;
}

/**
 * A node's kind. The file node is the one Graphify emits per file, labelled
 * with the basename at L1; callables carry the parentheses; everything else is
 * a type, class or interface.
 */
function kindOf(n: SafeNode, name: string): SymbolKind {
  if (n.label.endsWith("()")) return "function";
  return n.file.endsWith(`/${name}`) || n.file === name ? "file" : "type";
}

function relationOf(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = (raw as Record<string, unknown>).relation;
  return typeof r === "string" ? r : null;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a === undefined) m.set(k, [v]);
  else a.push(v);
}
