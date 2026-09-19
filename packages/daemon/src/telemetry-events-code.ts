/**
 * Code-awareness telemetry shapes (#589) — the rows the code graph writes.
 *
 * Their own module for the same reason the embedding events got one: types
 * only, and `telemetry-events.ts` is long past the file-size ceiling.
 * `telemetry.ts` re-exports everything, so importers keep their path.
 */
import type { BaseEvent } from "./telemetry-events.js";
import type { CodeUnavailableReason } from "./code-graph/unavailable-reason.js";

export type { CodeUnavailableReason };

/**
 * One `find_code` / `find_affected_files` call.
 *
 * Shapes, never content: no query, no symbol, no file path, and `repo` only as
 * the last two path segments. What the user is looking for is theirs; how often
 * the tool was asked and whether it could answer is the measurement.
 */
export interface CodeToolCallEvent extends BaseEvent {
  kind: "code_tool_call";
  tool: "find_code" | "find_affected_files";
  status: "ok" | "no_answer" | "unavailable";
  /** find_code only — which question was asked. */
  mode?: "find" | "affected";
  /** find_code only — which lane produced the hits. */
  lane?: "symbol" | "path" | "lexical";
  /** find_affected_files only — where the changed-symbol list came from. */
  basis?: "symbols" | "diff" | "whole_file";
  /** Only on `unavailable`: which of the four worlds this was. */
  unavailable_reason?: CodeUnavailableReason;
  hits: number;
  files: number;
  truncated: boolean;
  took_ms: number;
  /** Last two path segments of the checkout root. */
  repo: string;
  surface: "mcp" | "http";
  caller_session?: string | null;
}

/** What a refresh run did — `started` first, then exactly one terminal outcome. */
export type CodeGraphRefreshOutcome =
  | "started"
  | "ok"
  | "locked"
  | "failed"
  | "given-up"
  | "skipped";

/**
 * One refresh of one repository's graph.
 *
 * `duration_ms` is the wall clock from `started` to the terminal row, measured
 * by the observer rather than the builder: it is the time the repository was
 * behind, which is the number the freshness question asks about.
 */
export interface CodeGraphRefreshEvent extends BaseEvent {
  kind: "code_graph_refresh";
  repo: string;
  /** watcher | git | stop-hook | startup | manual. */
  reason: string;
  outcome: CodeGraphRefreshOutcome;
  duration_ms?: number;
  /** Short failure/skip reason — never a path or a command line. */
  detail?: string;
  /** External nodes in the rebuilt graph, and how many resolved (#582). */
  external_total?: number;
  external_resolved?: number;
}
