/**
 * The dependents block in the PreToolUse Write/Edit lane (#577, part of #572).
 *
 * WHY THIS EXISTS. Before an agent edits a file it does not know what else in
 * the repository leans on it. The information is already in the graph
 * (#575); it just never reaches the moment where it would change a decision.
 * So the lane that already hands the agent the file's line count
 * (`file-size-check.ts`) also hands it the one-hop blast radius. Same lane,
 * same deterministic character, no new hook: #577 explicitly rules out hooks
 * on Read, Grep or Glob — Recall does not nag before a lookup, unlike
 * Graphify's `hook-guard`.
 *
 * WHY IT IS SILENT WHEN COLD. Measured in #575 on this repo's graph: a first
 * access costs read 5.89 ms + parse 15.24 ms + index 5.23 ms = 26.35 ms
 * (11.1 MB) or 20.72 ms (9.7 MB). The block's budget is ~10 ms on the warm
 * path, so a cold start does not fit and is not spent in the lane.
 * `CodeGraphCache.get()` therefore answers `null` immediately and loads in the
 * background, and this module returns `null` with it — no warning, no error,
 * no "graph is loading" line. A loading graph is a normal state, and a hint
 * that the agent cannot act on is pure context cost (§16.3). The next edit in
 * the same session has it. The warm lookup itself measured p50 0.003 ms /
 * p90 0.005 ms over 200 iterations, so the budget is not the lookup — it is
 * the two small IO calls the staleness check makes, and those run only after
 * the dedupe check has already decided the block will be emitted. Measured
 * end to end on this repo's real 10.2 MB graph, 200 iterations of the whole
 * function including the staleness IO: p50 0.044 ms, p90 0.101 ms, worst
 * (first, cold page cache) 6.40 ms — against a 10 ms ceiling that is checked
 * rather than assumed.
 *
 * WHY THE WORDING IS FLAT. The counter-review's standing objection to
 * Graphify's hook text is that it issues orders ("MANDATORY", "You MUST") for
 * something it merely knows. A dependency list is information; what to do with
 * it is the agent's call. Nothing here is phrased as an instruction, and a
 * code hop never marks a memory `required` (§13.1, §24) — this block is
 * separate text from `<recall-hints>` and carries no band.
 *
 * WHY IT DEDUPES LIKE A MEMORY HINT. §16.2: the same content repeated on every
 * edit of the same file is cost without a marginal chance of being acted on.
 * The block therefore rides the existing per-session file bus
 * (`session-state.ts`), under a namespaced key, so the size-check note and the
 * memory hints keep their own bookkeeping untouched. Token cost is booked
 * where the other deterministic notes are booked: the lane counts the finished
 * string into `hint_tokens_est` (§16.3).
 *
 * WHY THE REPO ROOT IS JUST THE LANE'S `cwd`. Resolving a checkout root from
 * an arbitrary path belongs to the git helpers built alongside this (#581);
 * duplicating a walk-up here would cost a stat chain on every single write in
 * every repository that has no graph at all. A repository without a graph is
 * answered from the cache's degraded state after the first miss, which is the
 * "no extra latency" acceptance of #577.
 */

import { stat } from "node:fs/promises";
import { relative, isAbsolute, sep } from "node:path";
import { stripFenceMarkers } from "@bastra-recall/core/scrub";
import { CodeGraphCache } from "./cache.js";
import { dependentFilesOf, symbolsOfFile, graphDirOf, type CodeSymbol } from "./reader.js";
import { isStale, readManifest } from "./manifest.js";
import { MAX_SHOW, type ReadonlySessionState } from "../session-state.js";

/** Dependent files listed by name before the rest becomes a count. */
const MAX_DEPENDENTS = 12;
/** Symbols of the edited file listed before the rest becomes a count. */
const MAX_SYMBOLS = 8;
/**
 * Hard ceiling on the emitted block, in characters. ~4 chars per token is the
 * estimator the lane already uses for `hint_tokens_est`, so this is a cap of
 * roughly 300 tokens — a number, not "reasonable", because an unbounded block
 * is exactly what the per-item caps above cannot rule out on a wide fan-in.
 */
const MAX_BLOCK_CHARS = 1200;
/**
 * The warm-path budget from #577. The lookup measures 0.003 ms, so this is
 * headroom against the staleness IO rather than against the graph — but a
 * budget that is never checked is a budget nobody can hold, so the finished
 * block is dropped rather than emitted late.
 */
const BUDGET_MS = 10;

/** Prefix that keeps the block's dedupe key out of the memory-id namespace. */
const DEDUPE_PREFIX = "code:";

/**
 * The process-wide cache. Exported so the preloader and `bastra doctor` use
 * the same instance — two caches would mean two copies of every graph on the
 * heap, and the LRU budget in `cache.ts` is daemon-wide by design.
 */
let shared: CodeGraphCache | null = null;
export function codeGraphCache(): CodeGraphCache {
  shared ??= new CodeGraphCache();
  return shared;
}

export interface DependentsNoteOptions {
  /** The file the tool call is about to write, as the hook reported it. */
  filePath: string;
  /** The lane's project anchor — `payload.cwd`. */
  repoRoot: string;
  /** The lane's session snapshot; an empty one disables the dedupe. */
  session?: ReadonlySessionState;
  /** Injectable for tests; defaults to the shared cache. */
  cache?: CodeGraphCache;
  /**
   * Wall-clock ceiling for the whole call, in ms. Injectable because a test
   * that asserts the block's CONTENT must not also be racing this budget: on
   * a loaded machine the two staleness `stat` calls can outlast 10 ms, the
   * block is correctly dropped, and the content assertion fails for a reason
   * that has nothing to do with what it is testing. That flake was measured
   * at two runs in four under parallel load. Production never passes this.
   */
  budgetMs?: number;
}

export interface DependentsNote {
  /** The finished block, ready to join the other deterministic notes. */
  note: string;
  /** Key to book under `shown` once the block has actually gone out. */
  dedupeKey: string;
}

/** The session key for one file's block. Exported for the lane's delta. */
export function codeDedupeKey(repoRelFile: string): string {
  return `${DEDUPE_PREFIX}${repoRelFile}`;
}

/**
 * The dependents block for a pending write, or `null`.
 *
 * `null` covers every state in which #577 asks for silence: the kill switch,
 * a path outside the anchor, a cold graph (load triggered, nothing emitted), a
 * repository with no graph, a file the graph does not know, a file nothing
 * depends on, a block already shown this session, and an overrun budget.
 * Never throws — code awareness must not be able to degrade the lane (§23).
 */
export async function dependentsNote(opts: DependentsNoteOptions): Promise<DependentsNote | null> {
  if ((process.env.BASTRA_CODE_AWARENESS ?? "").toLowerCase() === "off") return null;
  const startedAt = Date.now();

  const rel = repoRelative(opts.repoRoot, opts.filePath);
  if (rel === null) return null;

  // Cold or unknown repository: this returns null AND schedules the load, so
  // the next edit in the session is warm. Deliberately before the dedupe
  // check — a deduped file must still keep the graph coming.
  const graph = (opts.cache ?? codeGraphCache()).get(opts.repoRoot);
  if (graph === null) return null;

  const dedupeKey = codeDedupeKey(rel);
  const shownCount = opts.session?.shown?.[dedupeKey]?.count ?? 0;
  if (shownCount >= MAX_SHOW) return null;

  const dependents = productionFirst(dependentFilesOf(graph, rel));
  if (dependents.length === 0) return null;
  const symbols = symbolsOfFile(graph, rel).filter((s) => s.kind !== "file");

  // Only now, with an emit decided, does this touch the disk.
  const stale = await isGraphStale(opts.repoRoot, opts.filePath);

  const note = format(rel, symbols, dependents, stale);
  if (Date.now() - startedAt > (opts.budgetMs ?? BUDGET_MS)) return null;
  return { note, dedupeKey };
}

/**
 * Whether the graph predates the file about to be edited, or never finished
 * building. `isStale` treats "unknown" as stale on purpose (#574): a wrong
 * "current" costs an agent acting on a dependency list that no longer holds,
 * a wrong "stale" costs one line of wording.
 */
async function isGraphStale(repoRoot: string, filePath: string): Promise<boolean> {
  const manifest = await readManifest(graphDirOf(repoRoot));
  let newestMtimeMs = 0;
  try {
    newestMtimeMs = (await stat(filePath)).mtimeMs;
  } catch {
    // A file that does not exist yet cannot be newer than the build.
  }
  return isStale(manifest, newestMtimeMs);
}

/**
 * Production files before test files, each group alphabetical.
 *
 * Measured against this repo's real graph: `packages/core/src/save.ts` has 26
 * dependents, and plain alphabetical order filled all twelve listed slots with
 * `packages/core/__tests__/…`, pushing `audit-save.ts` — the one dependent the
 * issue names — into "and 14 more". A test that exercises a file is true blast
 * radius, but it is the part the agent can rediscover by running the suite;
 * the production caller is the part that decides whether the edit is safe.
 */
/** One rule for what counts as a test, shared by the ordering and the count. */
function isTestFile(f: string): boolean {
  return f.includes("__tests__") || /\.(test|spec)\./.test(f);
}

function productionFirst(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const t = Number(isTestFile(a)) - Number(isTestFile(b));
    return t !== 0 ? t : a.localeCompare(b);
  });
}

/**
 * The repo-relative POSIX path the graph uses, or null when the file is not
 * below the anchor. Rejected, not repaired — the same rule the graph reader
 * applies to paths it is handed (validate.ts).
 */
export function repoRelative(repoRoot: string, filePath: string): string | null {
  if (!isAbsolute(filePath) || repoRoot.length === 0) return null;
  const rel = relative(repoRoot, filePath);
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/**
 * The block. Statements only: what the graph holds, how it was derived, and
 * whether it is current. No verb the agent is meant to obey.
 */
function format(rel: string, symbols: CodeSymbol[], dependents: string[], stale: boolean): string {
  const lines: string[] = [];
  lines.push(
    "Code graph, one hop over extracted import/call edges. " +
      "Context for this edit, not an instruction — the graph can be incomplete.",
  );
  // Graphify emits a node for the file itself (kind "file", labelled with the
  // basename at L1). It is not one of the file's symbols, and listing it would
  // spend budget repeating the name that is already in the attribute.
  if (symbols.length > 0) {
    const shown = [...symbols]
      .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
      .slice(0, MAX_SYMBOLS)
      // `name`, not `label`: Graphify labels callables `saveMemory()`, and the
      // parentheses are its notation, not part of what the agent is reading.
      .map((s) => (s.line === null ? s.name : `${s.name} (L${s.line})`));
    const more = symbols.length - shown.length;
    lines.push(`Defined here: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`);
  }
  lines.push(`Imported or called from ${dependents.length} file${dependents.length === 1 ? "" : "s"}:`);
  // Test files are COUNTED, not listed. Measured against the no-graph control
  // arm (#579, packages/eval/code-roi): 40.7 % of the dependent edges in this
  // repository point at test files, and naming them one by one made the median
  // block 156 tokens against 112 for the grep an agent would otherwise run —
  // i.e. the block cost more than the search it was meant to save. That a
  // file's tests exercise that file is the part an agent can already assume;
  // spending a third of the budget on it crowds out the part it cannot.
  const prod = dependents.filter((d) => !isTestFile(d));
  const tests = dependents.length - prod.length;
  for (const d of prod.slice(0, MAX_DEPENDENTS)) lines.push(`- ${d}`);
  const restFiles = prod.length - Math.min(prod.length, MAX_DEPENDENTS);
  if (restFiles > 0) lines.push(`- … and ${restFiles} more`);
  if (tests > 0) {
    lines.push(`- plus ${tests} test file${tests === 1 ? "" : "s"}`);
  }
  if (stale) {
    lines.push(
      "This graph was built before the current state of this file, or its build did not finish; " +
        "the list can be out of date.",
    );
  }

  const body = clip(stripFenceMarkers(lines.join("\n")));
  const attrs =
    `file="${escapeAttr(rel)}" dependents="${dependents.length}"` + (stale ? ` stale="true"` : "");
  return `<code-dependents ${attrs}>\n${body}\n</code-dependents>`;
}

/** Last line of defence for the token cap — the per-item caps bound the list,
 *  this bounds the strings inside it (a symbol name may be 512 bytes). */
function clip(body: string): string {
  return body.length <= MAX_BLOCK_CHARS ? body : `${body.slice(0, MAX_BLOCK_CHARS - 1)}…`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
