/**
 * The row a hook CLIENT writes for a call the daemon never saw (#543).
 *
 * Two client shapes run the same lanes — the compiled stub (`stub/bastra-hook.ts`)
 * and the node thin clients (`*-hook.ts`) — and both must leave a row behind
 * when their POST fails, or the release gate counts a lane that lost calls as
 * a lane that had none. This module is that row, once, for every lane.
 *
 * **Why every lane writes one now.** Until #543 only prompt, write and the two
 * Bash lanes did, and the three lanes added in #369 (stop, session, plan) were
 * silent on purpose: their event kinds — `save_eval_call`, `session_hook_call`,
 * `todo_hook_call` — describe a pipeline that did not run at all when the
 * daemon is unreachable, and a generic `hook_call` row for them would have
 * polluted a series measuring something else. That reasoning was correct and
 * is kept: nothing here writes a foreign lane's kind. What changed is that
 * #305 gave all six lanes a threshold (`log-stats-thresholds.ts`). A lane that
 * writes nothing when the transport fails then has both a too-small
 * denominator and no failure row — it can report PASS while calls are being
 * lost, and a gate that is green for lack of data is worse than no gate.
 *
 * The way out is not a generic row: each lane writes its OWN kind, with the
 * daemon-side field shape, so the client row folds into that lane's series
 * (`log-stats-phases.ts`) and nowhere else. The fields the client cannot know
 * — a matched pattern, an exit code, a suggestion count — are stamped at their
 * empty value, exactly as the four older lanes already did.
 *
 * Two invariants every row here must hold, both of which were broken before:
 *
 *  · **the lane** — the row's `kind` must be the one the gate maps to this
 *    lane (`GATE_LANE_BY_KIND`). `bash-pre`/`bash-fail` once wrote
 *    `hook_call` and filed every client-side Bash failure under Write/Edit
 *    (#305, `2b7d285`). A kind appears at most once in this table, and a test
 *    reads the table to check it.
 *  · **the session** — `session_id` must be the one from the hook payload.
 *    It is the ONLY thing that ties this row to the daemon row for the same
 *    call; a fresh UUID made every client row unmatchable (#356/#305,
 *    `ea95691`). The synthetic id stays the fallback for a payload that
 *    carried none.
 *
 * Dependency-free beyond node stdlib + `env.js`: this module is loaded inside
 * the hook process and is compiled into the stub by `deno compile`.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { envFirst } from "./env.js";

/** Every lane a client can run. One entry per hook registration. */
export type ClientLane = "prompt" | "write" | "bash-pre" | "bash-fail" | "stop" | "session" | "todo";

/** What the node thin clients stamp so their rows are recognizable as client
 *  rows (`-thin`) and can be folded. `prompt-hook.ts` and `hook.ts` carry their
 *  own older versions; the five lanes that gained a row in #543 share this one. */
export const THIN_CLIENT_VERSION = "0.1.0-thin";

/**
 * The row shape each lane's CLIENT writes — same event kind and fields as that
 * lane's daemon-side row, so the two form one series.
 *
 * One table instead of a per-file conditional, because that conditional was
 * wrong for two of four lanes once already (#305) and silent for three more
 * (#543).
 */
export const CLIENT_ROW_BASE: Record<ClientLane, Record<string, unknown>> = {
  // #305: "unknown", not "none". The trigger class is decided daemon-side
  // and this row exists precisely because no answer came back, so the
  // client cannot know it. Claiming "none" filed every client-side prompt
  // failure under the silent lane — which is how the readout came to show
  // `none` timing out at 15% behind a 69ms median, an impossible shape,
  // with the assertion lane's failures wearing another lane's name.
  prompt: { kind: "prompt_hook_call", detected_mode: "unknown", prompt_chars: 0, hint_count: 0, top_score: null },
  write: {
    kind: "hook_call",
    topics: [],
    query_chars: 0,
    hint_count: 0,
    required_count: 0,
    top_score: null,
    dropped_dedup_count: 0,
    dropped_scope_count: 0,
    hint_tokens_est: 0,
    hinted_ids: [],
    backoff_streak: 0,
    suppressed: false,
    suppressed_tokens_est: 0,
  },
  // The two Bash lanes: `matched_pattern` / `exit_code` are what the daemon
  // row carries and the client cannot know — it never got an answer.
  "bash-pre": {
    kind: "bash_hook_call",
    matched_pattern: null,
    severity: null,
    hint_count: 0,
    dropped_dedup_count: 0,
    top_score: null,
    hint_tokens_est: 0,
    backoff_streak: 0,
    suppressed: false,
    suppressed_tokens_est: 0,
  },
  "bash-fail": {
    kind: "bash_fail_hook_call",
    exit_code: null,
    command_head: null,
    hit_count: 0,
    top_score: null,
    hint_tokens_est: 0,
    backoff_streak: 0,
    suppressed: false,
    suppressed_tokens_est: 0,
  },
  // The three #369 lanes (#543). Their pipelines did not run — heuristics,
  // recall arms and suggestions are stamped empty, which is the truth of the
  // call: nothing was evaluated, nothing was returned.
  stop: {
    kind: "save_eval_call",
    heuristic: null,
    suggested_count: 0,
    drift_clusters: 0,
    drift_keys: [],
    turn_count: 0,
  },
  session: {
    kind: "session_hook_call",
    source: null,
    project: null,
    queries: 0,
    hint_count: 0,
    convention_count: 0,
    pinned_count: 0,
    top_score: null,
    hint_tokens_est: 0,
    hinted_ids: [],
  },
  todo: {
    kind: "todo_hook_call",
    topic: null,
    todo_count: 0,
    query_chars: 0,
    hit_count: 0,
    top_score: null,
    backoff_streak: 0,
  },
};

/** The hook payload's session id, or null when it carried none. */
export function sessionIdOf(payload: unknown): string | null {
  const p = payload as { session_id?: unknown } | null | undefined;
  return typeof p?.session_id === "string" && p.session_id.length > 0 ? p.session_id : null;
}

/** Same event kinds and field shapes as the daemon-side lanes — one series. */
export async function writeClientTelemetry(
  lane: ClientLane,
  fields: Record<string, unknown>,
  startedAt: number,
  sessionId: string | null,
  hookVersion: string,
): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir =
      envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? join(homedir(), ".bastra", "logs");
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const event = {
      ts,
      // #356/#305: the payload's session_id is real session state, and it is
      // the ONLY thing that ties this row to the daemon row for the same call
      // — `bastra logs --stats` folds the two on it. Stamping a fresh UUID
      // here made every client row unmatchable and left the readout pairing
      // rows by timestamp alone, across sessions.
      session_id: sessionId ?? randomUUID(),
      hook_version: hookVersion,
      // #352: null = never asked (skip-gate) — false is reserved for a path
      // that actually POSTed and got no response.
      daemon_reachable: fields.status === "skipped" ? null : false,
      latency_ms_total: Date.now() - startedAt,
      error: null,
      ...CLIENT_ROW_BASE[lane],
      ...fields,
    };
    await appendFile(join(logDir, `events-${ts.slice(0, 10)}.jsonl`), JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the hook.
  }
}
