/**
 * Code-awareness telemetry shapes (#579) — the rows the code graph writes.
 *
 * Their own module for the same reason the embedding events got one: types
 * only, and `telemetry-events.ts` is long past the file-size ceiling.
 * `telemetry.ts` re-exports everything, so importers keep their path.
 */
import type { BaseEvent } from "./telemetry-events.js";
import type { CodeUnavailableReason } from "./code-graph/unavailable-reason.js";

export type { CodeUnavailableReason };

/**
 * The lane a DELIVERED block went out on (#606) — the UserPromptSubmit gate,
 * the PreToolUse Write/Edit lane, or, since #572, the task-boundary block the
 * prompt lane hands over on behalf of the Stop that computed it.
 *
 * Its own field rather than `lane`: that one already means "which lane of
 * `find_code` produced the hits", and the readouts fold `lane ?? basis` into
 * one column. Reusing it would make a delivered block's basis disappear behind
 * the name of the hook that sent it.
 */
export type CodeDeliveredLane = "prompt" | "write" | "boundary";

/**
 * One `find_code` / `find_affected_files` call — or, since #606, one DELIVERED
 * change-impact block, which is the same answer reaching the agent without
 * being asked for (`surface: "delivered"`).
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
  /** Where the answer came from: a tool call, or a block Recall delivered. */
  surface: "mcp" | "http" | "delivered";
  caller_session?: string | null;
  /** `delivered` only — which hook lane sent it. */
  delivered_lane?: CodeDeliveredLane;
  /** `delivered` only — ~4 chars per token of the injected block. The cost
   *  side: a delivered answer is paid for whether or not it was needed. */
  tokens_est?: number;
  /** `delivered` only — this answer had already gone out in this session, so
   *  nothing was injected. Counted, because a dedupe that works and a feature
   *  that never fires are otherwise the same silence. */
  dedupe_hit?: boolean;
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
