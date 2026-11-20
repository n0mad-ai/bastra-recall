#!/usr/bin/env node
import { bastraDataDir } from "./platform-paths.js";
/**
 * bastra-recall prompt hook — THIN CLIENT (#343/#15, stage A of #305 direction 2).
 *
 * The UserPromptSubmit pipeline this file used to run (mode detection, gates,
 * recall, dedup/backoff, formatting, telemetry — 700 lines) lives daemon-side
 * in `prompt-lane.ts` now, behind POST /hook/prompt. What remains here is the
 * part that MUST run in the hook process because it is the hook process:
 *
 *   stdin (JSON Claude-Code hook payload)
 *     → POST 127.0.0.1:BASTRA_HTTP_PORT/hook/prompt
 *         { payload, client_ppid: process.ppid }
 *     → write the response body to stdout VERBATIM — the daemon returns the
 *       exact `{}` / hookSpecificOutput document Claude Code expects.
 *
 * `client_ppid` is the one fact only this process owns: the daemon is not in
 * the Claude session's process tree, so it cannot resolve which session this
 * hook belongs to (statusline feed namespacing, #74/#51) without a starting
 * point. Shipping the ppid replaces the `ps` walk the old hook paid on every
 * call.
 *
 * Discipline (unchanged from the fat version):
 *   - Hard wall-clock budget HOOK_TIMEOUT_MS; every failure path emits `{}`
 *     and exits 0 — a hook must never block or break the turn.
 *   - stdlib only. No @bastra-recall/core, no daemon modules beyond the
 *     dependency-free env helper. Every import here is process-start cost on
 *     every single user prompt (#305: the barrel import alone was 45ms), and
 *     this file is what #344 will compile — keep it stub-shaped.
 *   - On connection failure the client writes the minimal telemetry event
 *     itself (status daemon-unreachable/timeout): the daemon obviously cannot
 *     log the calls that never reached it, and that rate is exactly what
 *     #346's fallback will be judged against.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst, envOff, envInt, testRunLogDir } from "./env.js";
import { resolveDaemonEndpoint } from "./daemon-endpoint.js";
import { PROMPT_ASSERTION_BUDGET_MS } from "./hook-budgets.js";
import { decorateHookPayload } from "./hook-surface.js";
import { emitStdout, exitAfterStdout } from "./hook-stdout.js";
// #1508: the shared transport — postLane decorates the payload and adds the
// task authorization header, which is what this client always sent.
import { classifyTransportError, postLane, readStdin } from "./thin-client.js";

// #305: the trigger class is decided daemon-side, AFTER this POST, so the
// client cannot know whether it is serving the 600ms quiet path or the 1000ms
// assertion path — it has to outlast the slowest one it can be handed. This is
// not added waiting: the daemon cuts each class at its own budget, so the extra
// room only matters when the daemon itself hangs. Before this, a client socket
// at 600ms cut off assertion calls the daemon would have finished — 73 of 74
// such client rows in the measured week had a daemon row for the same call.
const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", PROMPT_ASSERTION_BUDGET_MS, "NEXUS_HOOK_TIMEOUT_MS");
const HOOK_VERSION = "0.3.0-thin";

// Ein-Emit-Kontrakt: Claude Code parst stdout als EIN JSON-Dokument. Der
// unref'te Kill-Switch kann feuern, während main() noch am Request hängt —
// ohne Guard schriebe er ein zweites "{}" hinter die Antwort.
let stdoutEmitted = false;
function emitOnce(payload: string): void {
  if (stdoutEmitted) return;
  stdoutEmitted = true;
  emitStdout(payload);
}

/** Minimal client-side telemetry for the calls the daemon never saw. Same
 *  event kind and field shape as the daemon-side lane, so the stats series
 *  stays one series. */
async function writeClientTelemetry(
  daemonUrl: string,
  status: "daemon-unreachable" | "timeout" | "error",
  error: string | null,
  startedAt: number,
  sessionId: string | null
): Promise<void> {
  if (envOff("BASTRA_TELEMETRY", "NEXUS_TELEMETRY")) return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? testRunLogDir() ?? join(bastraDataDir(), "logs");
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const event = {
      kind: "prompt_hook_call",
      ts,
      // The session_id from the Claude payload is real session state — fall
      // back to a synthetic UUID only if no payload session was given (#356).
      session_id: sessionId ?? randomUUID(),
      hook_version: HOOK_VERSION,
      // #545: "unknown", not "none" — the same word the stub writes
      // (`hook-client-telemetry.ts`). The trigger class is decided daemon-side
      // and this row exists precisely because no answer came back, so this
      // process never learned it. Stamping "none" filed every client-side
      // prompt failure under the silent lane, where an assertion or retrieval
      // loss wears another lane's name and is judged against another lane's
      // ceiling. `unknown` has no trigger-class threshold on purpose; it is
      // judged by the prompt-total reliability lane, where it counts as a
      // failure (`log-stats-thresholds.ts`).
      detected_mode: "unknown",
      prompt_chars: 0,
      daemon_url: daemonUrl,
      daemon_reachable: false,
      hint_count: 0,
      top_score: null,
      // #508: nothing was injected — a known zero, not an unknown size.
      hint_tokens_est: 0,
      latency_ms_total: Date.now() - startedAt,
      status,
      error,
    };
    await appendFile(join(logDir, `events-${ts.slice(0, 10)}.jsonl`), JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the hook.
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  // #1674: the budget's remainder runs on a monotonic clock; startedAt stays the telemetry stamp.
  const startedMono = performance.now();

  const raw = await readStdin();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return emitOnce("{}");
  }
  const decorated = decorateHookPayload(payload);
  const chatClient = (decorated as { bastra_client?: string } | null)?.bastra_client ?? process.env.BASTRA_HOOK_CLIENT;
  if (chatClient && chatClient !== "claude-code") {
    const { registerChatHook } = await import("./task-chat-registry.js");
    await registerChatHook(decorated).catch(() => {});
  }

  // #531 — one resolver for the endpoint, shared with the CLI, the daemon and
  // the forwarder. This block used to ignore BASTRA_DAEMON_URL, which is the
  // variable the installer writes into a client registration.
  const url = resolveDaemonEndpoint().baseUrl;
  const remainingMs = Math.max(50, HOOK_TIMEOUT_MS - (performance.now() - startedMono));

  try {
    const body = await postLane(url, "/hook/prompt", { payload, client_ppid: process.ppid }, remainingMs);
    emitOnce(body);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const status = classifyTransportError(e);
    const p = payload as { session_id?: unknown } | null;
    const hookSessionId = typeof p?.session_id === "string" ? p.session_id : null;
    // #1473: an unreachable daemon is said once per session, not answered
    // silently empty. Lazy: only a failure pays for the import (#305).
    if (status === "daemon-unreachable")
      emitOnce(
        await import("./hook-unreachable-notice.js")
          .then((m) => m.unreachableAnswer("prompt", hookSessionId))
          .catch(() => "{}")
      );
    emitOnce("{}");
    await writeClientTelemetry(
      url,
      status,
      status === "error" ? (e.message ?? String(err)) : null,
      startedAt,
      hookSessionId
    );
  }
}

// Only run the CLI when invoked directly (filename match), not when imported by tests.
const argv1 = process.argv[1] ?? "";
const isCliEntry = argv1.endsWith("prompt-hook.js") || argv1.endsWith("prompt-hook.ts");

if (isCliEntry) {
  const killSwitch = setTimeout(() => {
    emitOnce("{}");
    void exitAfterStdout();
  }, HOOK_TIMEOUT_MS + 50);
  killSwitch.unref();

  main()
    .then(() => exitAfterStdout())
    .catch(() => {
      emitOnce("{}");
      void exitAfterStdout();
    });
}
