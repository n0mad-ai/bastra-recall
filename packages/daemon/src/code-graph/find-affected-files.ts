/**
 * `find_affected_files` — the change-impact question, asked of the graph
 * first (#582).
 *
 * WHY A SECOND TOOL AND NOT A MODE OF `find_code`. The v3 measurement
 * (`packages/eval/code-roi/v2/BEFUND.md`) recorded the finding that matters
 * here: in 44 of 44 runs the agent was offered `find_code`, and in 44 of 44
 * it used grep instead. `find_code` is named and described as a LOCATOR — "a
 * symbol or file in the indexed code graph" — and an agent asking "what
 * breaks if I change this?" does not read that as its tool. A mode flag on a
 * locator is found by an agent that already decided to call the locator,
 * which is exactly the agent that does not exist here.
 *
 * So this is its own tool, named after the question, and its description says
 * when to reach for it rather than what it indexes.
 *
 * WHAT IT DOES DIFFERENTLY. `find_code(mode: "affected")` answers for a whole
 * FILE: every symbol in it, every importer of any of them. Measured against
 * the type errors the real historical changes produced, that is 87.4 % recall
 * at 43.5 % precision. This tool narrows to the symbols the DIFF touches
 * first, and crosses the workspace package boundary the graph itself does not
 * carry (`external-refs.ts`): 91.3 % recall at 52.4 % precision on the same
 * sample. `find_code` is unchanged and stays the locator.
 *
 * CANDIDATES, NOT PROOF, and the answer says so. Extracted import and call
 * edges carry no types: nothing here knows whether a caller passes the
 * argument that changed, and a caller reached through reflection or a
 * string-keyed table has no edge at all. The note tells the agent to grep the
 * symbol names before it acts.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import {
  affectedHits,
  affectedResult,
  changedSymbolsOf,
  narrowPackageHits,
  symbolsNamed,
  allSymbolsOf,
  MAX_AFFECTED_DEPTH,
  type AffectedHit,
} from "./affected.js";
import type { CodeGraphCache } from "./cache.js";
import { codeAwarenessDisabledByEnv } from "./enabled-repos.js";
import { repoRootSync, workingDiff } from "./git-paths.js";
import type { CodeSymbol } from "./reader.js";

// ─── Arguments ───────────────────────────────────────────────────

export const FindAffectedFilesArgs = z.object({
  file: z.string().min(1),
  symbols: z.array(z.string().min(1)).optional(),
  /** Absolute path of the repository root. Defaults to the daemon's cwd. */
  repo: z.string().min(1).optional(),
  depth: z.number().int().min(1).max(MAX_AFFECTED_DEPTH).optional(),
});

export type FindAffectedFilesInput = z.infer<typeof FindAffectedFilesArgs>;

// ─── Result shape ────────────────────────────────────────────────

/** Where the changed-symbol list came from — the agent's signal for how sharp the answer is. */
export type AffectedBasis = "symbols" | "diff" | "whole_file";

export interface FindAffectedFilesResult {
  status: "ok" | "no_answer" | "unavailable";
  /** Absent when nothing was answered. */
  basis?: AffectedBasis;
  /** The symbols the answer is about. */
  changed_symbols?: string[];
  /** Names passed in `symbols` that the graph does not know in this file. */
  unknown_symbols?: string[];
  /** The distinct files — the answer. */
  files: string[];
  /** Why each file is in the list: `location`, `via` symbol, `relation`. */
  hits: AffectedHit[];
  truncated: boolean;
  /** One sentence for the agent. Always present. */
  note: string;
  took_ms: number;
}

// ─── The tool definition ─────────────────────────────────────────

export const affectedTools = [
  {
    name: "find_affected_files",
    annotations: { readOnlyHint: true, destructiveHint: false },
    description:
      "GRAPH-FIRST change impact: given a file you are about to change or have " +
      "just changed, list the files that may break, from the repository's code " +
      "graph. Call it BEFORE editing an exported symbol and AFTER changing one " +
      "— whenever the question is 'what breaks if I change this?', 'who uses " +
      "this?', 'did I miss a call site?'\n" +
      "\n" +
      "Ask it first, then grep. It reads import and call edges across the " +
      "whole repository in one call, including imports that go through a " +
      "workspace package (`@scope/pkg`), which a grep for the symbol name in " +
      "the changed package will not find.\n" +
      "\n" +
      "Pass `file` alone and it derives the changed symbols from the working- " +
      "tree diff of that file (staged changes included); with no diff it " +
      "answers for the whole file and says so in `basis`. Pass `symbols` to " +
      "ask about specific ones — that is the sharpest answer, and the one to " +
      "use before the change exists.\n" +
      "\n" +
      "Returns `files` (the answer) and `hits` (one line of evidence each: " +
      "`location` file:line of the depending site, `via` the changed symbol, " +
      "`relation` the edge). These are CANDIDATES, not proof: the graph has no " +
      "types, so a listed file may survive the change, and a caller reached " +
      "through reflection or a string-keyed table is not listed at all. Grep " +
      "the symbol names to confirm before acting.\n" +
      "\n" +
      "`status: \"unavailable\"` means the graph is not in memory for this " +
      "repository (loading, not indexed, or code awareness is off). It is not " +
      "an error and says nothing about what depends on the file — use Grep " +
      "for this turn.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description:
            "The changed file: repo-relative ('packages/core/src/save.ts') or absolute.",
        },
        symbols: {
          type: "array",
          items: { type: "string" },
          description:
            "The symbols that change ('saveMemory', 'SaveMemoryInput'). Omit to " +
            "derive them from the file's working-tree diff.",
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
            "1 (default) or 2 hops. Two hops finds more and is markedly " +
            "noisier — use it when the first hop came back nearly empty.",
        },
      },
      required: ["file"],
    },
  },
];

// ─── The tool ────────────────────────────────────────────────────

/**
 * Answer one `find_affected_files` call.
 *
 * Asynchronous only because of the diff: every graph lane reads an index that
 * is already in memory, and a cold graph answers `unavailable` without
 * waiting, exactly like `find_code`.
 */
export async function findAffectedFiles(
  cache: CodeGraphCache,
  args: FindAffectedFilesInput,
): Promise<FindAffectedFilesResult> {
  const startedAt = performance.now();
  const given = isAbsolute(args.repo ?? "")
    ? (args.repo as string)
    : resolve(args.repo ?? process.cwd());
  const repo = repoRootSync(given) ?? given;
  const done = (r: Omit<FindAffectedFilesResult, "took_ms">): FindAffectedFilesResult => ({
    ...r,
    took_ms: Number((performance.now() - startedAt).toFixed(3)),
  });
  const empty = { files: [] as string[], hits: [] as AffectedHit[], truncated: false };

  if (codeAwarenessDisabledByEnv() || !cache.allows(repo)) {
    return done({
      ...empty,
      status: "unavailable",
      note:
        `Code awareness is switched off for ${shortRepo(repo)}. ` +
        `This says nothing about what depends on the file — use Grep.`,
    });
  }
  const graph = cache.get(repo);
  if (graph === null) {
    return done({
      ...empty,
      status: "unavailable",
      note:
        `The code graph for ${shortRepo(repo)} is not in memory yet (it loads in ` +
        `the background; this call did not wait for it). Use Grep for this turn.`,
    });
  }

  const file = repoRelative(repo, args.file);
  if (file === null || !graph.symbolsByFile.has(file)) {
    return done({
      ...empty,
      status: "no_answer",
      note:
        `The code graph of ${shortRepo(repo)} does not index "${args.file}". ` +
        `Pass the path repo-relative; a file added since the last index, or one ` +
        `the indexer does not read, will not be in it — use Grep for those.`,
    });
  }

  let basis: AffectedBasis;
  let symbols: CodeSymbol[];
  let unknown: string[] = [];
  if (args.symbols !== undefined && args.symbols.length > 0) {
    basis = "symbols";
    const named = symbolsNamed(graph, file, args.symbols);
    symbols = named.found;
    unknown = named.unknown;
  } else {
    const diff = await workingDiff(repo, file);
    const fromDiff = diff === null ? [] : changedSymbolsOf(graph, file, diff);
    if (fromDiff.length > 0) {
      basis = "diff";
      symbols = fromDiff;
    } else {
      basis = "whole_file";
      symbols = allSymbolsOf(graph, file);
    }
  }

  if (symbols.length === 0) {
    return done({
      ...empty,
      status: "no_answer",
      ...(unknown.length > 0 ? { unknown_symbols: unknown } : {}),
      note:
        unknown.length > 0
          ? `None of ${unknown.join(", ")} is a symbol the graph knows in ${file}. ` +
            `Check the spelling, or call it again without \`symbols\` to ask about ` +
            `the whole file.`
          : `The graph indexes ${file} but places no symbol in it, so there is ` +
            `nothing to follow. Use Grep.`,
    });
  }

  const hits = await narrowPackageHits(
    repo,
    affectedHits(graph, file, symbols, args.depth ?? 1),
    symbols.filter((s) => s.kind !== "file").map((s) => s.name),
  );
  const result = affectedResult(symbols, hits);
  return done({
    status: "ok",
    basis,
    changed_symbols: result.changedSymbols,
    ...(unknown.length > 0 ? { unknown_symbols: unknown } : {}),
    files: result.files,
    hits: result.hits,
    truncated: result.truncated,
    note: noteFor(basis, result.files.length, result.truncated),
  });
}

/**
 * The one sentence the agent reads. It always carries the same two facts —
 * what the answer is about, and that grep is still the verification — because
 * an impact list that reads as authoritative is the expensive failure here.
 */
function noteFor(basis: AffectedBasis, files: number, truncated: boolean): string {
  const scope =
    basis === "symbols"
      ? `Candidates for the symbols you named`
      : basis === "diff"
        ? `Candidates for the symbols your working-tree diff touches`
        : `No diff for this file, so this is the whole file's blast radius — ` +
          `pass \`symbols\` for a sharper answer. Candidates`;
  return (
    `${scope}: ${files} file${files === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}. ` +
    `The graph has no type information, so grep the symbol names in these files ` +
    `before acting, and remember a call site reached through reflection or a ` +
    `string-keyed table has no edge here at all.`
  );
}

/**
 * The path as the graph spells it: repo-relative, POSIX, no `..` escape.
 * An absolute path outside the repository is refused rather than rewritten —
 * the same rule `validate.ts` applies to the graph's own paths.
 */
function repoRelative(repo: string, given: string): string | null {
  const raw = given.replace(/\\/g, "/").replace(/^\.\//, "");
  const rel = isAbsolute(raw) ? relative(repo, raw).replace(/\\/g, "/") : raw;
  if (rel.length === 0 || isAbsolute(rel) || rel.split("/").includes("..")) return null;
  return rel;
}

/** The last two path segments: enough to recognise the repo, short in context. */
function shortRepo(repo: string): string {
  const parts = repo.split("/").filter((p) => p.length > 0);
  return parts.slice(-2).join("/") || repo;
}
