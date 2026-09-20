/**
 * The change-impact block the UserPromptSubmit lane DELIVERS (#606).
 *
 * WHY A SECOND DELIVERY POINT. The Write/Edit block reaches an agent that has
 * already decided what to change. The expensive miss is one step earlier: the
 * user asks "what breaks if I rename this?" and the agent answers it with a
 * grep, because nothing put the graph in front of it. Server instructions
 * reach a session once on connect and tool descriptions are advisory — v3
 * measured 0 tool calls in 44 of 44 runs. So the prompt that IS the question
 * gets the answer injected before the first search runs.
 *
 * WHY THE GATE IS TWO GATES. `impact-intent.ts` reads the phrasing; this file
 * resolves what the prompt named against the graph, and injects nothing when
 * nothing resolves. That second half is what makes false triggers cheap
 * instead of merely rare: a prompt that reads like a change-impact question but
 * names no indexed file and no known symbol produces no block at all.
 *
 * WHY THERE IS NO GIT DIFF HERE. `find_affected_files` falls back to the
 * working-tree diff when no symbol is named, and that costs a `git diff`
 * process — up to the 5 s timeout `git-paths.ts` allows. The prompt lane runs
 * before the user's turn and its whole budget is smaller than that bound, so
 * this lane does not spawn git: a prompt that names a symbol gets the
 * `symbols` answer, a prompt that names only a file gets the whole-file answer
 * and the block says `basis="whole_file"`. The sharper answer is one
 * `find_affected_files` call away and the note names the tool.
 *
 * NEVER BLOCKS ANYTHING. This is a UserPromptSubmit additionalContext block
 * like the recall hints beside it; it cannot stop a Grep, and #577's rule that
 * Recall does not hook Read/Grep/Glob is untouched.
 *
 * EXPERIMENTAL, OFF BY DEFAULT (#607). `deliverPromptImpact()` below — the
 * lane's own entry point — is gated behind `promptImpact.enabled` /
 * `BASTRA_PROMPT_IMPACT`; see prompt-impact-settings.ts for why. This module's
 * lower-level `promptImpactNote()` stays ungated on purpose (see its own
 * doc comment) so the code-roi measurement harness keeps working.
 */

import { join } from "node:path";
import {
  affectedHits,
  affectedResult,
  allSymbolsOf,
  narrowPackageHits,
} from "./affected.js";
import type { CodeGraphCache } from "./cache.js";
import { codeGraphCache } from "./dependents-block.js";
import { codeAwarenessDisabledByEnv } from "./enabled-repos.js";
import type { AffectedBasis } from "./find-affected-files.js";
import { repoRootSync } from "./git-paths.js";
import { changeImpactIntent } from "./impact-intent.js";
import { displayOrder, isGraphStale, renderImpactBlock } from "./impact-block.js";
import { bareLabel, type CodeSymbol, type LoadedGraph } from "./reader.js";
import { logDeliveredBlock } from "../code-delivered-telemetry.js";
import { MAX_SHOW, type ReadonlySessionState } from "../session-state.js";
import { getPromptImpactEnabled } from "./prompt-impact-settings.js";

/** Prefix that keeps the block's dedupe key out of the memory-id namespace. */
const DEDUPE_PREFIX = "code-prompt:";

/**
 * Wall-clock ceiling. The prompt lane's own budget is the recall budget; this
 * block runs beside that recall, not after it, so it is bounded well below.
 */
const BUDGET_MS = 120;

export interface PromptImpactOptions {
  /** The user's prompt, verbatim. */
  prompt: string;
  /** The session's working directory — the repository anchor. */
  cwd: string;
  /** The lane's session snapshot; an empty one disables the dedupe. */
  session?: ReadonlySessionState;
  cache?: CodeGraphCache;
  budgetMs?: number;
}

export interface PromptImpactNote {
  note: string;
  dedupeKey: string;
  basis: AffectedBasis;
  /** Repo-relative file the answer is about. */
  file: string;
  changedSymbols: string[];
  files: number;
  truncated: boolean;
  tokensEst: number;
  tookMs: number;
}

/** Same split as the write lane's (`impact-block.ts`): silence, or a counted dedupe. */
export interface PromptImpactResult {
  note: PromptImpactNote | null;
  dedupeHit: boolean;
}

const SILENT: PromptImpactResult = { note: null, dedupeHit: false };

/**
 * The block for a change-impact prompt, or silence.
 *
 * Silence is the answer for every ordinary prompt and for every state the
 * Write/Edit block is silent in: the kill switch, a cold or missing graph, a
 * prompt whose targets the graph does not know, an empty answer, a block
 * already delivered this session, an overrun budget. Never throws.
 *
 * DELIBERATELY NOT gated behind `promptImpact.enabled` (#607): this is the
 * function `packages/eval/code-roi/v2/delivered-block.mjs` imports and calls
 * directly, bypassing the lane, to render arm D from the exact product path
 * regardless of the lane's opt-in default. `deliverPromptImpact()` below is
 * where the live prompt lane's gate lives.
 */
export async function promptImpactNote(
  opts: PromptImpactOptions,
): Promise<PromptImpactResult> {
  if (codeAwarenessDisabledByEnv()) return SILENT;
  const startedAt = Date.now();
  const budgetMs = opts.budgetMs ?? BUDGET_MS;

  const intent = changeImpactIntent(opts.prompt);
  if (!intent.asked) return SILENT;
  if (intent.paths.length === 0 && intent.symbols.length === 0) return SILENT;

  const repo = repoRootSync(opts.cwd) ?? opts.cwd;
  const graph = (opts.cache ?? codeGraphCache()).get(repo);
  if (graph === null) return SILENT;

  const target = resolveTarget(graph, intent.paths, intent.symbols);
  if (target === null) return SILENT;

  const names = [...new Set(target.symbols.filter((s) => s.kind !== "file").map((s) => s.name))];
  const dedupeKey = `${DEDUPE_PREFIX}${target.file}#${graph.mtimeMs}:${target.basis}:${names.sort().join(",")}`;
  if ((opts.session?.shown?.[dedupeKey]?.count ?? 0) >= MAX_SHOW) {
    return { note: null, dedupeHit: true };
  }
  if (Date.now() - startedAt > budgetMs) return SILENT;

  const hits = await narrowPackageHits(
    repo,
    affectedHits(graph, target.file, target.symbols, 1),
    names,
  );
  const result = affectedResult(target.symbols, hits);
  if (result.files.length === 0) return SILENT;

  const shown = displayOrder(result.hits);
  const stale = await isGraphStale(repo, join(repo, target.file));
  const note = renderImpactBlock({
    file: target.file,
    basis: target.basis,
    changed: result.changedSymbols,
    hits: shown,
    total: result.hits.length,
    // The target's current mtime is enough to detect that the loaded graph
    // predates the code the user is asking about. It cannot predict the future
    // edit, but it must not present an already-stale answer as current.
    stale,
    lead:
      target.basis === "symbols"
        ? "You asked what a change here would affect. Code graph, one hop from the " +
          "symbols you named — candidates, not proof, the graph carries no type " +
          "information."
        : "You asked what a change here would affect. Code graph, one hop from " +
          "EVERY symbol in this file, because the question named no symbol — " +
          "candidates, not proof. `find_affected_files` with `symbols` is sharper.",
  });
  if (Date.now() - startedAt > budgetMs) return SILENT;

  return {
    dedupeHit: false,
    note: {
      note,
      dedupeKey,
      basis: target.basis,
      file: target.file,
      changedSymbols: result.changedSymbols,
      files: result.files.length,
      truncated: result.truncated,
      tokensEst: Math.ceil(note.length / 4),
      tookMs: Date.now() - startedAt,
    },
  };
}

// ─── The lane's whole side of it ─────────────────────────────────

/** What the prompt lane needs back, and nothing it has to reason about. */
export interface DeliveredPromptImpact {
  /** The block to inject, or null. */
  block: string | null;
  /** Key to book under `shown` once the block has gone out, or null. */
  dedupeKey: string | null;
  tokensEst: number;
  basis: AffectedBasis | null;
}

const NOTHING: DeliveredPromptImpact = {
  block: null,
  dedupeKey: null,
  tokensEst: 0,
  basis: null,
};

/**
 * Gate, block and telemetry row in one call.
 *
 * `prompt-lane.ts` is past the file-size ceiling, and this is a coherent unit
 * — one question, one gate, one row — so it lives here rather than adding a
 * fourth concern to that file. The lane gets a block or nothing, and never has
 * to know that a dedupe hit is worth a telemetry row of its own.
 *
 * Never throws: a failure in here degrades to "no block", exactly like every
 * other code-awareness path (§23).
 *
 * #607: gated behind `promptImpact.enabled` / `BASTRA_PROMPT_IMPACT`, default
 * OFF (see prompt-impact-settings.ts for why). This is the ONLY gate for the
 * opt-in — `promptImpactNote()` itself stays ungated so the code-roi
 * measurement harness, which calls it directly, keeps rendering the block
 * regardless of this default.
 */
export async function deliverPromptImpact(opts: {
  prompt: string;
  cwd: string;
  sessionId: string | null;
  session?: ReadonlySessionState;
  cache?: CodeGraphCache;
  budgetMs?: number;
}): Promise<DeliveredPromptImpact> {
  if (!(await getPromptImpactEnabled())) return NOTHING;
  let result: PromptImpactResult;
  try {
    result = await promptImpactNote(opts);
  } catch {
    return NOTHING;
  }
  if (result.note === null && !result.dedupeHit) return NOTHING;

  const repo = repoRootSync(opts.cwd) ?? opts.cwd;
  void logDeliveredBlock({
    sessionId: opts.sessionId,
    lane: "prompt",
    repo,
    dedupeHit: result.dedupeHit,
    ...(result.note !== null
      ? {
          basis: result.note.basis,
          files: result.note.files,
          truncated: result.note.truncated,
          tokensEst: result.note.tokensEst,
          tookMs: result.note.tookMs,
        }
      : {}),
  });
  if (result.note === null) return NOTHING;
  return {
    block: result.note.note,
    dedupeKey: result.note.dedupeKey,
    tokensEst: result.note.tokensEst,
    basis: result.note.basis,
  };
}

// ─── Resolution ──────────────────────────────────────────────────

interface Target {
  file: string;
  basis: AffectedBasis;
  symbols: CodeSymbol[];
}

/**
 * The file and symbols a prompt's candidates resolve to, or null.
 *
 * A named FILE decides which file the answer is about; symbols then narrow
 * inside it. With no file, the first symbol the graph knows brings its own
 * file with it. A symbol that resolves in several files at once is NOT spread
 * across them — one prompt, one answer, and the ambiguous case is exactly where
 * an injected guess would be wrong.
 */
function resolveTarget(
  graph: LoadedGraph,
  paths: readonly string[],
  symbols: readonly string[],
): Target | null {
  const file = paths.map((p) => resolveFile(graph, p)).find((f) => f !== null) ?? null;
  const named = resolveSymbols(graph, symbols, file);

  if (file !== null) {
    const inFile = named.filter((s) => s.file === file);
    return inFile.length > 0
      ? { file, basis: "symbols", symbols: inFile }
      : { file, basis: "whole_file", symbols: allSymbolsOf(graph, file) };
  }
  if (named.length === 0) return null;
  const homes = new Set(named.map((s) => s.file));
  if (homes.size !== 1) return null;
  const home = named[0].file;
  const together = named.filter((s) => s.file === home);
  return { file: home, basis: "symbols", symbols: together };
}

/**
 * A path candidate as the graph spells it: an exact repo-relative hit, or a
 * unique file whose path ends in what the prompt wrote (`save.ts`). Ambiguous
 * suffixes resolve to nothing — two files called `index.ts` are the normal
 * case, and picking one of them would be a coin flip.
 */
function resolveFile(graph: LoadedGraph, candidate: string): string | null {
  const wanted = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
  if (graph.symbolsByFile.has(wanted)) return wanted;
  const suffix = `/${wanted}`;
  let found: string | null = null;
  for (const known of graph.symbolsByFile.keys()) {
    if (!known.endsWith(suffix)) continue;
    if (found !== null) return null;
    found = known;
  }
  return found;
}

/**
 * The symbols the graph knows under the names the prompt used, restricted to
 * `file` when the prompt named one.
 *
 * `idsByLabel` is keyed on the bare, lowercased name, which is what a user
 * types; Graphify's `()` notation is stripped by `bareLabel` on both sides.
 */
function resolveSymbols(
  graph: LoadedGraph,
  names: readonly string[],
  file: string | null,
): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const ids = graph.idsByLabel.get(bareLabel(raw).toLowerCase());
    if (ids === undefined) continue;
    for (const id of ids) {
      if (seen.has(id)) continue;
      const node = graph.nodes.get(id);
      if (node === undefined) continue;
      if (file !== null && node.file !== file) continue;
      const symbol = allSymbolsOf(graph, node.file).find((s) => s.id === id);
      if (symbol === undefined || symbol.kind === "file") continue;
      seen.add(id);
      out.push(symbol);
    }
  }
  return out;
}
