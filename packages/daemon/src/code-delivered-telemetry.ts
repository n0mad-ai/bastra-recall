/**
 * One `code_tool_call` row per DELIVERED change-impact block (#606).
 *
 * WHY THE SAME EVENT AS THE TOOL. A delivered block and a `find_affected_files`
 * call are the same answer from the same code, and the whole question #606
 * exists to settle is which of the two ways of getting it in front of an agent
 * actually works. Two event kinds would make that comparison a join; one kind
 * with `surface: "delivered"` makes it a group-by. The readouts keep the two
 * apart deliberately — a delivered block is not a call and must not inflate
 * "does anyone call this tool" (`code-awareness-stats.ts`).
 *
 * WHY IT IS WRITTEN HERE AND NOT THROUGH `Telemetry.logCodeToolCall`. The hook
 * lanes have no `Telemetry` instance; they append their own rows to the same
 * JSONL, and this follows them rather than threading an instance through two
 * lanes for one row. Same directory, same daily file, same fail-open rule:
 * telemetry must never break a lane.
 *
 * Shapes, never content — no file, no symbol, no prompt. `repo` is the last two
 * path segments, the short form every other code-awareness row already carries.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst } from "./env.js";
import { defaultLogDir } from "./telemetry.js";
import { shortRepo } from "./code-graph/unavailable-note.js";
import type { AffectedBasis } from "./code-graph/find-affected-files.js";
import type { CodeDeliveredLane } from "./telemetry-events-code.js";

export interface DeliveredBlockRow {
  sessionId: string | null;
  lane: CodeDeliveredLane;
  /** Checkout root — shortened before it is written. */
  repo: string;
  /** Absent on a dedupe hit: nothing was built, so there is nothing to describe. */
  basis?: AffectedBasis;
  files?: number;
  truncated?: boolean;
  tokensEst?: number;
  tookMs?: number;
  /** The answer had already gone out this session; nothing was injected. */
  dedupeHit: boolean;
}

/** Append one row. Never throws, never awaits anything a lane depends on. */
export async function logDeliveredBlock(row: DeliveredBlockRow): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const event = {
      kind: "code_tool_call",
      ts,
      session_id: row.sessionId ?? randomUUID(),
      tool: "find_affected_files",
      // A dedupe hit answered nothing this turn — `no_answer` is the honest
      // status for it, and `dedupe_hit` says which kind of nothing it was.
      status: row.dedupeHit ? "no_answer" : "ok",
      ...(row.basis !== undefined ? { basis: row.basis } : {}),
      hits: row.files ?? 0,
      files: row.files ?? 0,
      truncated: row.truncated ?? false,
      took_ms: row.tookMs ?? 0,
      repo: shortRepo(row.repo),
      surface: "delivered",
      delivered_lane: row.lane,
      ...(row.tokensEst !== undefined ? { tokens_est: row.tokensEst } : {}),
      ...(row.dedupeHit ? { dedupe_hit: true } : {}),
    };
    await appendFile(
      join(logDir, `events-${ts.slice(0, 10)}.jsonl`),
      JSON.stringify(event) + "\n",
      "utf8",
    );
  } catch {
    // Telemetry must never break the lane.
  }
}
