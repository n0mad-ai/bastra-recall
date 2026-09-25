/**
 * One telemetry row per `find_code` / `find_affected_files` call (#579).
 *
 * WHY THIS WAS MISSING AND WHY IT MATTERS. The dependents block that the
 * Write/Edit lane injects has been counted since #579 (`log-stats-code.ts`),
 * but the two TOOLS an agent calls on purpose wrote nothing at all. So the one
 * question the feature exists to answer — does anyone call it, and does it
 * answer — had no number in either readout, and "code awareness is quiet"
 * could not be told from "code awareness is never asked".
 *
 * WHAT IS NOT IN THE ROW. Not the query, not the file, not the symbol names,
 * not the repository path: a query is what the user is working on, and the
 * shapes here are meant to be countable, not readable. `repo` is the last two
 * path segments, the same short form the agent-facing notes already print —
 * enough to tell two repositories apart, not enough to reconstruct a tree.
 *
 * Lives beside the tools rather than inside them: `find-code.ts` and
 * `find-affected-files.ts` answer the call, and both call sites (MCP and the
 * /api/v1 dispatcher) need the identical row.
 */

import { isAbsolute, resolve } from "node:path";
import type { CodeGraphCache } from "./cache.js";
import type { FindCodeInput, FindCodeResult } from "./find-code.js";
import type { FindAffectedFilesInput, FindAffectedFilesResult } from "./find-affected-files.js";
import { repoRootSync } from "./git-paths.js";
import { shortRepo } from "./unavailable-note.js";
import { unavailableReason } from "./unavailable-reason.js";
import type { CodeToolCallEvent } from "../telemetry-events.js";

/** The surface the call arrived on — the MCP server, or the HTTP dispatcher. */
export type CodeToolSurface = "mcp" | "http";

export type CodeToolCallPayload = Omit<CodeToolCallEvent, "kind" | "ts" | "session_id">;

/**
 * The repository the tool resolved the call to — the SAME walk the tools do, so
 * the row names the checkout root the graph is keyed by and not the
 * subdirectory the caller happened to sit in (#586).
 */
function repoOf(given: string | undefined): string {
  const abs = isAbsolute(given ?? "") ? (given as string) : resolve(given ?? process.cwd());
  return repoRootSync(abs) ?? abs;
}

export function findCodeEvent(
  cache: CodeGraphCache,
  args: FindCodeInput,
  result: FindCodeResult,
  ctx: { surface: CodeToolSurface; callerSession?: string | null },
): CodeToolCallPayload {
  const repo = repoOf(args.repo);
  return {
    tool: "find_code",
    status: result.status,
    mode: result.mode,
    ...(result.lane !== undefined ? { lane: result.lane } : {}),
    ...(result.status === "unavailable"
      ? { unavailable_reason: unavailableReason(cache, repo) }
      : {}),
    hits: result.hits.length,
    files: result.files?.length ?? 0,
    truncated: result.truncated,
    took_ms: result.took_ms,
    repo: shortRepo(repo),
    surface: ctx.surface,
    caller_session: ctx.callerSession ?? null,
  };
}

export function findAffectedFilesEvent(
  cache: CodeGraphCache,
  args: FindAffectedFilesInput,
  result: FindAffectedFilesResult,
  ctx: { surface: CodeToolSurface; callerSession?: string | null },
): CodeToolCallPayload {
  const repo = repoOf(args.repo);
  return {
    tool: "find_affected_files",
    status: result.status,
    ...(result.basis !== undefined ? { basis: result.basis } : {}),
    ...(result.status === "unavailable"
      ? { unavailable_reason: unavailableReason(cache, repo) }
      : {}),
    hits: result.hits.length,
    files: result.files.length,
    truncated: result.truncated,
    took_ms: result.took_ms,
    repo: shortRepo(repo),
    surface: ctx.surface,
    caller_session: ctx.callerSession ?? null,
  };
}
