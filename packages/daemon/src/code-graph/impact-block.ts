/**
 * The change-impact block the Write/Edit lane DELIVERS (#606, epic #572).
 *
 * WHY THIS REPLACES THE DEPENDENTS BLOCK. `dependents-block.ts` answered for
 * the whole FILE: every symbol in it, every importer of any of them. Measured
 * on the 44 scenarios of the code-roi v3 sample that is 87.4 % recall at
 * 43.5 % precision — more than half of what it names imports the file without
 * touching anything the edit changes. The symbol-level answer of `affected.ts`
 * is better on both axes (96.6 % / 47.4 %) and is what `find_affected_files`
 * has been serving since #582. The tool, though, is never called: v3 recorded
 * 0 calls in 44 of 44 runs, and a full day of real sessions on 19.09.2026
 * recorded 0 as well. Server instructions reach a session once, on connect;
 * tool descriptions are advisory. So the answer stops being OFFERED and starts
 * being DELIVERED, through the lane that already runs on every write.
 *
 * `dependentsNote` stays where it is on purpose: it is the file-level arm the
 * measurement compares against (`packages/eval/code-roi/measure-deps.mjs`), and
 * deleting the baseline to ship its replacement would leave nothing to measure
 * against.
 *
 * WHERE THE DIFF COMES FROM. The lane runs BEFORE the edit, so there is no git
 * diff yet — `pending-diff.ts` builds one out of the tool input instead. A
 * Write or an Edit becomes a real unified diff against the working tree and
 * goes through `diffSymbols` unchanged; an apply_patch document cannot be
 * placed in the tree without applying it, so its changed lines are read for
 * symbol NAMES alone. Whatever cannot be narrowed takes the whole file and
 * says so in `basis`, exactly as the tool does.
 *
 * WHY IT IS STILL SILENT WHEN COLD, AND STILL FLAT. Both rules from #577 hold
 * unchanged: `CodeGraphCache.get()` answers null and loads in the background,
 * and this returns null with it rather than announcing a loading graph; and
 * nothing here is phrased as an instruction, because a candidate list is
 * information and what to do with it is the agent's call.
 *
 * WHY THE DEDUPE KEY CARRIES THE SYMBOLS. #577 deduped per session and FILE:
 * the second edit of a file was silent, however different it was. Symbol-level
 * answers are not interchangeable that way — editing `saveMemory` and then
 * `validateMemory` in the same file are two different blast radii, and
 * suppressing the second one hides the answer precisely when it changed. So
 * the key is the file, the symbol set AND the graph's generation: a rebuilt
 * graph may have a different answer for the same symbols, and #606 asks for
 * that one to be delivered again.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stripFenceMarkers } from "@bastra-recall/core/scrub";
import {
  affectedHits,
  affectedResult,
  allSymbolsOf,
  diffSymbols,
  mentions,
  narrowPackageHits,
  type AffectedHit,
} from "./affected.js";
import type { CodeGraphCache } from "./cache.js";
import { codeAwarenessDisabledByEnv } from "./enabled-repos.js";
import { codeGraphCache, repoRelative } from "./dependents-block.js";
import type { AffectedBasis } from "./find-affected-files.js";
import { isStale, readManifest } from "./manifest.js";
import { applyPatchBody, MAX_DIFF_SOURCE_BYTES, pendingText, unifiedDiff } from "./pending-diff.js";
import { graphDirOf, type CodeSymbol, type LoadedGraph } from "./reader.js";
import { MAX_SHOW, type ReadonlySessionState } from "../session-state.js";

/** Tools whose input this module can turn into a pending change. */
const SUPPORTED_TOOLS = new Set(["Write", "Edit", "MultiEdit", "apply_patch"]);

/**
 * Candidate files named one by one before the rest becomes a count.
 *
 * Twelve in #577, ten here, and the ten carry more: a file, the site that
 * depends on it and the symbol it depends on, where the old block listed a
 * bare path. `find_affected_files` caps at 40 because an agent that asked for
 * the list will read it; a block nobody asked for has to earn every line.
 */
export const MAX_IMPACT_FILES = 10;

/** Changed symbols named in the head line before the rest becomes a count. */
const MAX_SYMBOLS = 6;

/** Hard ceiling on the emitted block, ~4 chars per token ⇒ roughly 300 tokens. */
const MAX_BLOCK_CHARS = 1200;

/**
 * Wall-clock ceiling for the whole call. #577's block held 10 ms because it
 * did nothing but a map lookup; this one reads the source file, rebuilds the
 * pending text and walks the graph, so the budget is the lane's own p90 target
 * (`hook-budgets.ts`, 200 ms) minus the room the recall self-call needs. A
 * budget that is never checked is a budget nobody can hold: the finished block
 * is dropped rather than emitted late.
 */
const BUDGET_MS = 120;

/** Prefix that keeps the block's dedupe key out of the memory-id namespace. */
const DEDUPE_PREFIX = "code:";

export interface ImpactNoteOptions {
  /** The file the tool call is about to write, absolute. */
  filePath: string;
  /** The repository the file belongs to — `laneRepoRoot(target, cwd)`. */
  repoRoot: string;
  /** The tool being called, so the pending change can be read out of its input. */
  toolName: string;
  /** The call's `tool_input`, verbatim. */
  toolInput: Record<string, unknown>;
  /** The lane's session snapshot; an empty one disables the dedupe. */
  session?: ReadonlySessionState;
  /** Injectable for tests; defaults to the shared cache. */
  cache?: CodeGraphCache;
  /** Injectable for tests, exactly as in `dependents-block.ts`. */
  budgetMs?: number;
}

export interface ImpactNote {
  /** The finished block, ready to join the other deterministic notes. */
  note: string;
  /** Key to book under `shown` once the block has actually gone out. */
  dedupeKey: string;
  /** Where the changed-symbol list came from — the sharpness of the answer. */
  basis: AffectedBasis;
  /** The symbols the answer is about. */
  changedSymbols: string[];
  /** Candidate files the answer holds, before the display cap. */
  files: number;
  /** Whether the graph was behind the file when this was built. */
  stale: boolean;
  /** More candidates existed than `find_affected_files` itself returns. */
  truncated: boolean;
  /** The files the block NAMES, absolute — the `followed by an edit` join. */
  listed: string[];
  /** ~4 chars per token of the finished block. */
  tokensEst: number;
  /** Wall clock inside this call, milliseconds. */
  tookMs: number;
}

/** The session key for one file's block at one symbol set and graph generation. */
export function impactDedupeKey(repoRelFile: string, signature: string): string {
  return `${DEDUPE_PREFIX}${repoRelFile}#${signature}`;
}

/**
 * What one call decided. `note: null` is silence; `dedupeHit` separates the
 * one silence worth counting — this exact answer already went out this session
 * — from the many that are simply "no graph, no change, nothing depends on
 * it". Without that split the telemetry cannot tell a working dedupe from a
 * feature that never fires (#606).
 */
export interface ImpactResult {
  note: ImpactNote | null;
  dedupeHit: boolean;
}

const SILENT: ImpactResult = { note: null, dedupeHit: false };

/**
 * The change-impact block for a pending write, or silence.
 *
 * Silence covers every state #577 asks for it in, unchanged: the kill switch,
 * a path outside the anchor, a cold graph (load triggered, nothing emitted), a
 * repository with no graph, a file the graph does not index, a change nothing
 * depends on, a block already delivered for this file at this symbol set, and
 * an overrun budget. Never throws — code awareness must not be able to degrade
 * the lane (§23).
 */
export async function impactNote(opts: ImpactNoteOptions): Promise<ImpactResult> {
  if (codeAwarenessDisabledByEnv()) return SILENT;
  if (!SUPPORTED_TOOLS.has(opts.toolName)) return SILENT;
  const startedAt = Date.now();
  const budgetMs = opts.budgetMs ?? BUDGET_MS;

  const rel = repoRelative(opts.repoRoot, opts.filePath);
  if (rel === null) return SILENT;

  // Cold or unknown repository: silence AND a scheduled load, so the next edit
  // of the session is warm. Before the dedupe check, as in #577 — a deduped
  // file must still keep the graph coming.
  const graph = (opts.cache ?? codeGraphCache()).get(opts.repoRoot);
  if (graph === null) return SILENT;
  if (!graph.symbolsByFile.has(rel)) return SILENT;

  const selection = await changedSymbols(graph, rel, opts);
  if (selection === null || selection.symbols.length === 0) return SILENT;

  const signature = signatureOf(graph, selection);
  const dedupeKey = impactDedupeKey(rel, signature);
  if ((opts.session?.shown?.[dedupeKey]?.count ?? 0) >= MAX_SHOW) {
    return { note: null, dedupeHit: true };
  }
  if (Date.now() - startedAt > budgetMs) return SILENT;

  const names = selection.symbols.filter((s) => s.kind !== "file").map((s) => s.name);
  const hits = await narrowPackageHits(
    opts.repoRoot,
    affectedHits(graph, rel, selection.symbols, 1),
    names,
  );
  const result = affectedResult(selection.symbols, hits);
  if (result.files.length === 0) return SILENT;

  // Only now, with an emit decided, does this touch the disk again.
  const stale = await isGraphStale(opts.repoRoot, opts.filePath);

  const shown = displayOrder(result.hits);
  const note = renderImpactBlock({
    file: rel,
    basis: selection.basis,
    changed: result.changedSymbols,
    hits: shown,
    total: result.hits.length,
    stale,
    lead:
      selection.basis === "whole_file"
        ? "Code graph, one hop from EVERY symbol in this file — the pending change " +
          "touches something outside them all (an import, top-level code), which " +
          "narrows to nothing trustworthy. Candidates, not proof."
        : "Code graph, one hop from the symbols this change touches. " +
          "Candidates, not proof — the graph carries no type information.",
  });
  if (Date.now() - startedAt > budgetMs) return SILENT;
  return {
    dedupeHit: false,
    note: {
      note,
      dedupeKey,
      basis: selection.basis,
      changedSymbols: result.changedSymbols,
      files: result.files.length,
      stale,
      truncated: result.truncated,
      listed: shown.map((h) => join(opts.repoRoot, h.file)),
      tokensEst: Math.ceil(note.length / 4),
      tookMs: Date.now() - startedAt,
    },
  };
}

// ─── The pending change ──────────────────────────────────────────

interface Selection {
  basis: AffectedBasis;
  symbols: CodeSymbol[];
}

/**
 * The symbols the pending call changes, from a per-graph cache keyed on the
 * file and the content hash of the change.
 *
 * The cache is what keeps this inside the lane budget when an agent edits the
 * same file repeatedly: the source read, the pending rewrite and the span
 * analysis all hang off exactly those two inputs. It is keyed by the GRAPH
 * OBJECT, so a rebuilt graph starts with an empty cache and no stale selection
 * can survive a reindex.
 */
async function changedSymbols(
  graph: LoadedGraph,
  rel: string,
  opts: ImpactNoteOptions,
): Promise<Selection | null> {
  if (opts.toolName === "apply_patch") {
    const body = applyPatchBody(opts.toolInput.command, rel);
    if (body === null || body.length === 0) return null;
    return cached(graph, rel, body, () => fromNames(graph, rel, body));
  }

  const current = await readIfPresent(resolve(opts.repoRoot, rel));
  if (current === null) return null;
  const next = pendingText(opts.toolName, opts.toolInput, current);
  if (next === null || next.length > MAX_DIFF_SOURCE_BYTES) return null;
  const diff = unifiedDiff(rel, current, next);
  if (diff === null) return null;
  return cached(graph, rel, next, () => fromDiff(graph, rel, diff));
}

/** The working-tree text, "" for a file that does not exist yet, null if unreadable. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path);
    return buf.byteLength > MAX_DIFF_SOURCE_BYTES ? null : buf.toString("utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "" : null;
  }
}

/** `diffSymbols`, reported the way `find_affected_files` reports it. */
function fromDiff(graph: LoadedGraph, rel: string, diff: string): Selection {
  const picked = diffSymbols(graph, rel, diff);
  if (!picked.wholeFile && picked.symbols.length > 0) {
    return { basis: "diff", symbols: picked.symbols };
  }
  return {
    basis: "whole_file",
    symbols: picked.wholeFile ? picked.symbols : allSymbolsOf(graph, rel),
  };
}

/**
 * The name lane alone, for an apply_patch body that has no usable line
 * numbers. A body that names no known symbol is NOT read as "nothing changed"
 * — that is the confident empty answer `affected.ts` refuses to give — so it
 * takes the whole file, like an unplaceable hunk does there.
 */
function fromNames(graph: LoadedGraph, rel: string, body: string): Selection {
  const own = allSymbolsOf(graph, rel);
  const hit = own.filter(
    (s) => s.kind !== "file" && s.name.length > 2 && mentions(body, s.name),
  );
  return hit.length > 0
    ? { basis: "diff", symbols: hit }
    : { basis: "whole_file", symbols: own };
}

/** Largest number of selections held per graph. Beyond this the cache resets. */
const MAX_CACHED_SELECTIONS = 256;

const selectionCache = new WeakMap<LoadedGraph, Map<string, Selection>>();

function cached(
  graph: LoadedGraph,
  rel: string,
  content: string,
  build: () => Selection,
): Selection {
  let perGraph = selectionCache.get(graph);
  if (perGraph === undefined) {
    perGraph = new Map();
    selectionCache.set(graph, perGraph);
  }
  const key = `${rel}\0${sha(content)}`;
  const hit = perGraph.get(key);
  if (hit !== undefined) return hit;
  const built = build();
  // A flat reset rather than an LRU: the entries are cheap, the bound exists
  // so a long session cannot grow one unboundedly, and nothing here depends on
  // an entry surviving.
  if (perGraph.size >= MAX_CACHED_SELECTIONS) perGraph.clear();
  perGraph.set(key, built);
  return built;
}

function sha(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/**
 * What makes two deliveries the same delivery: the graph generation, the
 * basis, and the symbol set. Sorted, so the order the diff happened to select
 * them in does not defeat the dedupe.
 */
function signatureOf(graph: LoadedGraph, selection: Selection): string {
  const names = [...new Set(selection.symbols.map((s) => s.name))].sort();
  return sha(`${graph.mtimeMs}|${selection.basis}|${names.join(",")}`).slice(0, 12);
}

// ─── Freshness ───────────────────────────────────────────────────

/**
 * Whether the graph predates the file about to be edited, or never finished
 * building. `isStale` treats "unknown" as stale on purpose (#574).
 */
export async function isGraphStale(repoRoot: string, filePath: string): Promise<boolean> {
  const manifest = await readManifest(graphDirOf(repoRoot));
  let newestMtimeMs = 0;
  try {
    newestMtimeMs = (await stat(filePath)).mtimeMs;
  } catch {
    // A file that does not exist yet cannot be newer than the build.
  }
  return isStale(manifest, newestMtimeMs);
}

// ─── The block ───────────────────────────────────────────────────

/** One rule for what counts as a test, shared by the ordering and the count. */
function isTestFile(f: string): boolean {
  return f.includes("__tests__") || /\.(test|spec)\./.test(f);
}

/**
 * The hits the block names, production first.
 *
 * `affectedResult` has already reduced this to one line per file and sorted it
 * by how much the line says — one hop before two, a real call site before a
 * package-level import. That order is kept inside each group; only the test
 * files move, for #577's measured reason: 40.7 % of this repository's dependent
 * edges point at test files, and a file's own tests are the part an agent can
 * already assume.
 */
export function displayOrder(hits: readonly AffectedHit[]): AffectedHit[] {
  const prod = hits.filter((h) => !isTestFile(h.file));
  const tests = hits.filter((h) => isTestFile(h.file));
  return [...prod, ...tests].slice(0, MAX_IMPACT_FILES);
}

export interface ImpactBlockInput {
  /** Repo-relative file the answer is about. */
  file: string;
  basis: AffectedBasis;
  /** The symbols the answer follows. */
  changed: readonly string[];
  /** Already display-ordered and capped — `displayOrder`. */
  hits: readonly AffectedHit[];
  /** Candidate files before the display cap. */
  total: number;
  stale: boolean;
  /** The first line: why this block is here, in the delivering lane's words. */
  lead: string;
}

/**
 * The block. Statements only: what changed, what the graph says may break, how
 * sharp the answer is, and that it is a candidate list. No verb the agent is
 * meant to obey — the counter-review's standing objection to Graphify's hook
 * text is that it issues orders for something it merely knows.
 *
 * Shared by both delivering lanes (#606) so the two cannot drift into
 * describing the same answer differently; only the lead line is theirs.
 */
export function renderImpactBlock(input: ImpactBlockInput): string {
  const lines: string[] = [input.lead];
  if (input.changed.length > 0 && input.basis !== "whole_file") {
    const named = input.changed.slice(0, MAX_SYMBOLS);
    const more = input.changed.length - named.length;
    lines.push(`Changed: ${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`);
  }
  lines.push(`May break (${input.total} candidate file${input.total === 1 ? "" : "s"}):`);
  for (const h of input.hits) {
    lines.push(`- ${h.location} — ${h.relation} ${h.via}`);
  }
  const rest = input.total - input.hits.length;
  if (rest > 0) lines.push(`- … and ${rest} more (find_affected_files lists them)`);
  if (input.stale) {
    lines.push(
      "This graph was built before the current state of this file, or its build " +
        "did not finish; the list can be out of date.",
    );
  }
  lines.push(
    "A listed file may survive the change, and a call site reached through " +
      "reflection or a string-keyed table is not listed at all — grep the names " +
      "to confirm.",
  );

  const body = clip(stripFenceMarkers(lines.join("\n")));
  const attrs =
    `file="${escapeAttr(input.file)}" basis="${input.basis}" files="${input.total}"` +
    (input.stale ? ` stale="true"` : "");
  return `<code-impact ${attrs}>\n${body}\n</code-impact>`;
}

/** Last line of defence for the token cap — a symbol name may be 512 bytes. */
function clip(body: string): string {
  return body.length <= MAX_BLOCK_CHARS ? body : `${body.slice(0, MAX_BLOCK_CHARS - 1)}…`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
