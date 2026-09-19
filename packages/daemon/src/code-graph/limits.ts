/**
 * Hard limits for the Graphify code graph (#575).
 *
 * `graph.json` is written by a third-party tool, carries no schema version,
 * and lives inside a repository Recall does not own. Its symbol, path and
 * metadata fields are free-form and end up verbatim in an agent's context.
 * The pre-build counter-review (17.09.2026) named this as the missing trust
 * boundary: the planned "format guard" checked shape, but bounded neither
 * file size nor string length, and prevented neither path traversal nor
 * control characters reaching the hook context.
 *
 * So the graph is treated like external data, not like our own artifact.
 * Every limit here is a NUMBER, deliberately — "reasonable" is not a limit
 * anyone can test, and the counter-review's objection was precisely that the
 * budgets were unquantified.
 *
 * Crossing any of them has exactly one outcome: code awareness reports itself
 * unavailable. Nothing is silently truncated, nothing is repaired, and recall
 * itself is never degraded by it (§23, C-089).
 *
 * Dependency-free on purpose: the reader runs inside the PreToolUse Write/Edit
 * lane, whose p90 target is 200 ms (`hook-budgets.ts`).
 */

/**
 * Largest `graph.json` Recall will open. Measured reference: this repo
 * (800 files, 6812 nodes, 20008 edges) produces 9.7 MB, and the counter-review
 * measured 11.1 MB on a slightly larger tree. 64 MB is roughly six times that
 * — room for a repository several times this size, while still bounding the
 * 20 MB of heap a parse of this size already costs.
 */
export const MAX_GRAPH_BYTES = 64 * 1024 * 1024;

/** Node ceiling. This repo sits at 6.8k; 500k is a different class of repo. */
export const MAX_NODES = 500_000;

/** Edge ceiling. This repo sits at 20k. */
export const MAX_EDGES = 2_000_000;

/**
 * Longest string Recall will accept in any single field of the graph.
 * A symbol name, a path or a location — none of them has a legitimate reason
 * to be longer, and an unbounded string is the cheapest way to push a wall of
 * text into a hook context.
 */
export const MAX_STRING_BYTES = 512;

/**
 * Daemon-wide heap budget across every enabled repository, enforced by LRU
 * eviction (#575). One graph of this repo costs ~20 MB of heap, so this is
 * about a dozen repositories held at once — after which the least recently
 * used one is dropped rather than the daemon growing without a ceiling.
 * The counter-review flagged exactly this: several enabled repositories with
 * no fixed limit grow the daemon indefinitely.
 */
export const MAX_TOTAL_HEAP_BYTES = 256 * 1024 * 1024;

/**
 * Relations that carry dependency direction: "who would be affected if this
 * changed". Settled against the real graph rather than assumed — the measured
 * graph has FIFTEEN relation types, not the four the original plan listed.
 *
 *   contains       5327   structure, not a dependency  -> STRUCTURE_RELATIONS
 *   calls          4516   dependency                   (153 of them INFERRED)
 *   imports        4293   dependency
 *   imports_from   4119   dependency
 *   re_exports      554   dependency
 *   indirect_call   449   excluded: 100 % INFERRED
 *   method          346   structure, not a dependency  -> STRUCTURE_RELATIONS
 *   references      307   excluded: field reference, too weak to act on
 *   inherits         41   dependency
 *   rationale_for    24   excluded: non-code node
 *   implements       12   dependency
 *   dynamic_import   12   dependency
 *   defines           5   excluded: non-code node
 *   cites             2   excluded: doc-reference node
 *   extends           1   excluded: this is `tsconfig` inheritance in the
 *                         measured graph, NOT class extends — the obvious
 *                         reading of the name is the wrong one here.
 */
export const DEPENDENCY_RELATIONS: ReadonlySet<string> = new Set([
  "calls",
  "imports",
  "imports_from",
  "inherits",
  "re_exports",
  "dynamic_import",
  "implements",
]);

/**
 * Relations that describe containment, not impact: which symbols live in a
 * file, which methods live on a class. Used to answer "what is in this file",
 * never presented as blast radius.
 */
export const STRUCTURE_RELATIONS: ReadonlySet<string> = new Set(["contains", "method"]);

/**
 * Only directly extracted edges are used in normal recall (13.1, C-089).
 * The filter is per EDGE, not per relation: `calls` carries 153 inferred
 * edges among 4516, so trusting the relation name alone would let them in.
 */
export const EXTRACTED = "EXTRACTED";

/**
 * Node classes that are real code locations. Measured: even under
 * `--code-only`, the graph also contains `concept` (220) and `rationale` (24)
 * nodes extracted from code comments, with ids like `docref_rfc_6761`. They
 * stay inside the code-only boundary — they came out of code — but they are
 * not places an agent can navigate to, so they never reach a hook context.
 */
export const CODE_FILE_TYPE = "code";
