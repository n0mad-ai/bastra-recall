/**
 * Bash post-run lane, daemon-side (#343/#15 pattern, shared by Claude and Codex).
 *
 * The pipeline from `bash-fail-hook.ts`: fire the #144 act-signal for EVERY
 * completed Bash command, and on real failures (non-zero exit, not Ctrl-C)
 * recall lessons describing similar failure modes. Moved verbatim behind
 * POST /hook/bash-fail; the hook file is a thin client.
 *
 * Everything content-shaped stayed server-side on purpose, including
 * `invokesOwnBinary`: its precision matters (the earlier substring test
 * swallowed ~75% of commands in the dogfood repo), and gate logic that can
 * be wrong is gate logic that must be hot-swappable — not baked into a
 * compiled stub (#344's contract).
 *
 * The act-signal is now an in-daemon hop: this lane and /hook/act live on
 * the same server, so the loopback POST costs ~1ms and keeps the telemetry
 * event exactly where it always was.
 */
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HINT_FRAME_NOTE, stripFenceMarkers } from "@bastra-recall/core/scrub";
import { envFirst, envInt } from "./env.js";
import { defaultLogDir } from "./telemetry.js";
import { recordBudgetShadow } from "./session-budget.js";
import { reportHinted } from "./hook-hinted.js";
import { postLane } from "./thin-client.js";
import { isUnfused, type HookRecallHit, type HookRecallResponse } from "./hook-recall-response.js";
import { unfusedHeadline } from "./band-wording.js";
import { hookClient } from "./hook-surface.js";
import {
  decideBackoff,
  loadSessionState,
  recordSourceEmit,
  recordSourceSuppressed,
  saveSessionState,
  wasEmitConsumed,
} from "./session-state.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 500, "NEXUS_HOOK_TIMEOUT_MS");
const HOOK_VERSION = "0.2.0"; // 0.2.0 = daemon-side lane (#343)
const SCORE_FLOOR = 50;
// #161: hits at/above this are REQUIRED-band — they bypass backoff suppression.
const MUST_LOAD_SCORE = 100;
const THROTTLE_WINDOW_MS = 30_000;
const THROTTLE_DIR = join(tmpdir(), "bastra-hook");
// #161: backoff source key — fail-hints back off independently.
const BACKOFF_SOURCE = "bash-fail";

export interface BashFailPayload {
  bastra_client?: "claude-code" | "codex";
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: unknown;
  tool_response?: unknown;
  /** Claude Code PostToolUseFailure carries failure details at top level. */
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
}

// P0: EIN gemeinsamer Response-Typ für alle Lanes. Die lokale Kopie hier
// kannte `score_kind`/`unfused` nicht — das Feld fiel beim Parsen still weg,
// und diese Lane bandete danach rohe BM25-Werte mit einem Cut, den nur die
// fusionierte Skala trägt.
type RecallHit = HookRecallHit;
type RecallResponse = HookRecallResponse;

/**
 * Run the post-Bash pipeline; return the exact stdout document for the thin
 * client. Never throws — every failure degrades to `{}` plus telemetry.
 */
export async function runBashFailLane(payload: BashFailPayload, selfBaseUrl: string): Promise<string> {
  const startedAt = Date.now();
  const client = hookClient(payload);

  const hookEventName = payload.hook_event_name;
  if (hookEventName !== "PostToolUse" && hookEventName !== "PostToolUseFailure") return "{}";
  if (payload.tool_name !== "Bash") return "{}";
  const failureEvent = hookEventName === "PostToolUseFailure";

  // Schema is in flux across Claude-Code versions: `tool_result` and
  // `tool_response` have both been observed. PostToolUseFailure instead puts
  // `error` and `is_interrupt` at the top level (official Claude Code schema).
  const result = normalizeToolResponse(payload.tool_result ?? payload.tool_response);
  if (failureEvent && typeof payload.error === "string" && !("error" in result)) {
    result.error = payload.error;
  }
  const exitCode = readExitCode(result);
  // Aktuelle Claude-Code-Payloads tragen z.T. GAR KEIN Exit-Code-Feld mehr —
  // readExitCode() liefert dann null. Das act-Signal muss trotzdem feuern
  // (PostToolUse = Command lief); nur der Fail-Hint unten braucht einen
  // echten non-zero Code. Ein frühes `exitCode === null → return` war ein
  // Kill-Switch: 3-Tage-Audit 2026-07-10 fand 15 von ~7200 erwarteten
  // act-Signalen (0,2 %).
  if (payload.is_interrupt === true) return "{}"; // PostToolUseFailure Ctrl-C
  if (exitCode === 130) return "{}"; // SIGINT — user Ctrl-C
  if (result.interrupted === true) return "{}"; // Schema-Äquivalent von 130

  const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;
  const command = typeof toolInput.command === "string" ? toolInput.command : "";
  if (!command.trim()) return "{}";

  // No loop on our own binaries — matcht das AUFGERUFENE Programm (Basename
  // pro Pipeline-/Subshell-Segment), nicht einen Substring: der frühere
  // Substring-Test traf auch jeden Pfad, der den Repo-Namen enthält und
  // schluckte im Dogfood-Repo ~75 % der Commands.
  if (invokesOwnBinary(command)) return "{}";

  // #144: act-signal for EVERY completed Bash command (success AND failure).
  // Telemetry-only — best-effort loopback hop; failures are swallowed.
  await postAct(
    selfBaseUrl,
    {
      tool_name: "Bash",
      tool_input_excerpt: command.slice(0, 1000),
      exit_code: exitCode,
      session_id: typeof payload.session_id === "string" ? payload.session_id : null,
      client,
      hook_source: "bash-fail",
    },
    Math.min(120, Math.max(50, HOOK_TIMEOUT_MS - (Date.now() - startedAt))),
  );

  // Success path ends here — the act-signal was the only job.
  if (!failureEvent && (exitCode === null || exitCode === 0)) return "{}";

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "default";
  if (await isThrottled(sessionId)) return "{}";

  const errorContext = extractErrorContext(result);
  const commandHead = extractCommandHead(command);
  const errKeywords = extractErrorKeywords(errorContext);
  const query = `${commandHead} ${errKeywords}`.trim().slice(0, 300);

  const remainingMs = Math.max(50, HOOK_TIMEOUT_MS - (Date.now() - startedAt));

  let resp: RecallResponse | null = null;
  let status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error" = "ok";
  let errMsg: string | null = null;
  try {
    resp = JSON.parse(
      await postLane(
        selfBaseUrl,
        "/hook/recall",
        {
          query,
          topics: ["bash", "failure"],
          project: null,
          tool_name: "Bash",
          k: 3,
          // #445: die Session-id fehlte als einzige — ohne sie stempelt der
          // Sink seine Boot-UUID und nichts lässt sich nach Session gruppieren.
          session_id: typeof payload.session_id === "string" ? payload.session_id : null,
          // #263: die Lane weist sich aus, sonst ist ihr Ereignis von dem des
          // MCP-Forwarders nicht zu unterscheiden — beide gehen hier durch.
          client,
          hook_source: "bash-fail",
        },
        remainingMs,
      ),
    ) as RecallResponse;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "EHOSTUNREACH") {
      status = "daemon-unreachable";
    } else if (e.message === "timeout") {
      status = "timeout";
    } else {
      status = "error";
      errMsg = e.message ?? String(err);
    }
  }

  // P0: Ohne Fusion sind die Scores rohe BM25-Werte auf offener Skala — der
  // Floor 50 markiert dort keinen Punkt (gemessen: sechsstellige Top-Scores),
  // also wird nicht geflooert, sondern die vom Daemon gelieferte Rangfolge
  // (k=3) unverändert übernommen.
  const unfused = isUnfused(resp);
  const hits: RecallHit[] = [];
  if (resp && Array.isArray(resp.hits)) {
    for (const h of resp.hits) {
      if (unfused || h.score >= SCORE_FLOOR) hits.push(h);
    }
  }
  if (resp && hits.length === 0) status = "no-hits";

  // No hits above floor → no value in interrupting Claude.
  let backoffStreak = 0;
  let suppressed = false;
  let suppressedTokensEst = 0;
  // #457: Tokens des TATSÄCHLICH injizierten Blocks — die Lane stand bisher
  // in keiner Kontextrechnung.
  let hintTokensEst = 0;
  let stdout = "{}";
  if (hits.length > 0) {
    // #161 empty-streak backoff: unconsumed injection streaks widen the
    // cadence. REQUIRED-band hits bypass suppression.
    const state = await loadSessionState(sessionId);
    const entry = state.sources?.[BACKOFF_SOURCE];
    const consumed = await wasEmitConsumed(entry);
    // P0: Die Backoff-Umgehung ist eine Band-Aussage. Auf der unfused Skala
    // reißt praktisch jeder Hit die 100 — die Umgehung feuerte also immer und
    // der Backoff war faktisch abgeschaltet. Fail-closed: kein Band, keine
    // Umgehung.
    const hasRequired = !unfused && hits.some((h) => h.score >= MUST_LOAD_SCORE);
    const decision = decideBackoff(entry, consumed, hasRequired);
    backoffStreak = decision.streak;
    suppressed = decision.suppress;
    const block = formatHintBlock(hits, unfused, client);
    if (suppressed) {
      // Suppressed emits {} like the no-hits path; the throttle stays
      // unmarked (nothing was emitted), the saved tokens go to telemetry.
      suppressedTokensEst = Math.ceil(block.length / 4);
      recordSourceSuppressed(state, BACKOFF_SOURCE);
      await saveSessionState(sessionId, state);
    } else {
      // Mark throttle only when we actually emit — otherwise quiet calls
      // would burn the budget.
      await markThrottle(sessionId);
      hintTokensEst = Math.ceil(block.length / 4);
      // Usage sidecar (#154): only what was ACTUALLY injected counts as surfaced.
      await reportHinted(selfBaseUrl, hits.map((h) => h.id));
      recordSourceEmit(state, BACKOFF_SOURCE, hits.map((h) => h.id), consumed);
      await saveSessionState(sessionId, state);
      stdout = JSON.stringify({
        hookSpecificOutput: {
          hookEventName,
          additionalContext: block,
        },
      });
    }
  }

  // #458 (shadow): den fertigen Block ans Sitzungsbudget anrechnen und den
  // Governor-Entscheid loggen — nichts wird gekürzt.
  recordBudgetShadow(typeof payload.session_id === "string" ? payload.session_id : null, "bash_fail_hook_call", hintTokensEst);
  await writeTelemetry({
    session_id: typeof payload.session_id === "string" ? payload.session_id : null,
    exit_code: exitCode,
    command_head: commandHead,
    daemon_url: selfBaseUrl,
    daemon_reachable: resp !== null,
    hit_count: suppressed ? 0 : hits.length,
    top_score: resp?.hits?.[0]?.score ?? null,
    latency_ms_total: Date.now() - startedAt,
    backoff_streak: backoffStreak,
    suppressed,
    suppressed_tokens_est: suppressedTokensEst,
    hint_tokens_est: hintTokensEst,
    status: suppressed ? "suppressed" : status,
    error: errMsg,
  });

  return stdout;
}

/** True, wenn ein Pipeline-/Subshell-Segment tatsächlich eines unserer
 *  Binaries aufruft (`bastra-recall`, `bastra-recall-*`) — geprüft am
 *  Basename des aufgerufenen Programms, damit Pfade, die den Repo-Namen nur
 *  ENTHALTEN, nicht matchen. `npx`/`node`-Wrapper, Flags und env-Prefixe
 *  werden übersprungen. */
export function invokesOwnBinary(command: string): boolean {
  for (const segment of command.split(/[|;&]+|\$\(|`/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let program = "";
    for (const w of words) {
      if (w === "npx" || w === "node" || w.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
      program = w;
      break;
    }
    const base = program.split("/").pop() ?? "";
    if (/^bastra-recall(?:-[a-z-]+)?$/.test(base)) return true;
  }
  return false;
}

export function readExitCode(result: Record<string, unknown>): number | null {
  for (const key of ["exit_code", "exitCode", "returncode", "return_code", "status"]) {
    const v = result[key];
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n)) return n;
    }
  }
  const text = ["stderr", "error", "output", "stdout", "content"]
    .map((key) => result[key])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const match = /(?:exit(?:ed)?(?:\s+with)?(?:\s+(?:non-zero\s+)?status)?(?:\s+code)?|status\s+code|exit_code)\D{0,8}(-?\d+)/i.exec(text);
  if (match) {
    const parsed = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Codex permits any JSON value in tool_response, including plain text. */
export function normalizeToolResponse(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Plain output is still useful for exit-code and error-context extraction.
  }
  return { output: value };
}

export function extractErrorContext(result: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["stderr", "error", "output", "stdout", "content"]) {
    const v = result[key];
    if (typeof v === "string") parts.push(v);
  }
  const joined = parts.join("\n");
  if (!joined) return "";
  // Last 500 chars first — that's where the real failure usually is.
  const tail = joined.slice(-500);
  // Pluck "interesting" lines if any.
  const interesting = tail
    .split(/\r?\n/)
    .filter((line) => /\b(?:Error|error|Failed|FAILED|failed|fatal|FATAL)\b/.test(line))
    .slice(-5)
    .join("\n");
  return interesting || tail;
}

/** First non-pipeline token of the command — usually the binary. */
export function extractCommandHead(command: string): string {
  const firstClause = command.split(/[\n;&|]/)[0] ?? "";
  const tokens = firstClause.trim().split(/\s+/).slice(0, 3);
  return tokens.join(" ").slice(0, 80);
}

/** Pull a few alpha-tokens from the error context to seed the recall query. */
export function extractErrorKeywords(ctx: string): string {
  if (!ctx) return "";
  const tokens = ctx.match(/[A-Za-z][A-Za-z_.-]{3,}/g) ?? [];
  // Dedup, keep order, cap.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 12) break;
  }
  return out.join(" ");
}

function formatHintLine(h: RecallHit, hideScore = false): string {
  const summary = h.summary.length > 220 ? h.summary.slice(0, 217) + "…" : h.summary;
  // P0: die unfused Zahl ist weder mit den Bändern noch zwischen zwei
  // Aufrufen vergleichbar — gleiche Wahl wie in prompt-lane.ts.
  return hideScore
    ? `- ${h.id} (${h.type}): ${summary}`
    : `- ${h.id} (${h.type}, score ${Math.round(h.score)}): ${summary}`;
}

export function formatHintBlock(hits: RecallHit[], unfused = false, surface = "claude-code"): string {
  const head = `<recall-hints surface="${surface}" trigger="bash-fail">`;
  const tail = `</recall-hints>`;
  const lines: string[] = [];
  lines.push(
    `The Bash command above failed. These memories describe similar failure modes — check before re-running or trying alternatives.`,
  );
  // P0: ohne Fusion sagen, woran das Modell die Treffer stattdessen misst.
  if (unfused) lines.push(unfusedHeadline("this failure"));
  for (const h of hits) lines.push(formatHintLine(h, unfused));
  return [head, HINT_FRAME_NOTE, stripFenceMarkers(lines.join("\n")), tail].join("\n");
}

export function throttleFile(sessionId: string): string {
  // sanitize sessionId — keep alnum + dash, fall back if empty
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "default";
  return join(THROTTLE_DIR, `fail-throttle-${safe}.ts`);
}

export async function isThrottled(sessionId: string): Promise<boolean> {
  try {
    const s = await stat(throttleFile(sessionId));
    return Date.now() - s.mtimeMs < THROTTLE_WINDOW_MS;
  } catch {
    return false;
  }
}

export async function markThrottle(sessionId: string): Promise<void> {
  try {
    // mode 0700/0600: os.tmpdir() is world-writable on Linux — keep the
    // throttle dir/files owner-only to block symlink/TOCTOU races.
    await mkdir(THROTTLE_DIR, { recursive: true, mode: 0o700 });
    await writeFile(throttleFile(sessionId), String(Date.now()), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Best-effort; missing throttle is acceptable.
  }
}

/** #144: fire the act-signal at /hook/act. Best-effort — resolves on any
 *  outcome; the act-signal must never break or delay the lane's main job. */
async function postAct(
  baseUrl: string,
  body: {
    tool_name: string;
    tool_input_excerpt: string;
    exit_code: number | null;
    session_id: string | null;
    client: ReturnType<typeof hookClient>;
    hook_source: "bash-fail";
  },
  timeoutMs: number,
): Promise<void> {
  try {
    await postLane(baseUrl, "/hook/act", body, timeoutMs);
  } catch {
    // swallowed by contract
  }
}

interface BashFailHookTelemetry {
  /** #356: the Claude Code session this call belongs to — the payload's
   *  session_id, so per-session aggregation (context tax, #354) is possible.
   *  A synthetic UUID is the fallback only when the payload carried none. */
  session_id?: string | null;
  exit_code: number | null;
  command_head: string;
  daemon_url: string;
  daemon_reachable: boolean;
  hit_count: number;
  top_score: number | null;
  latency_ms_total: number;
  /** #161: aufgelöster Streak der Backoff-Entscheidung dieses Events. */
  backoff_streak: number;
  /** #161: true, wenn der Backoff die Injektion unterdrückt hat. */
  suppressed: boolean;
  /** #161: Tokens des NICHT injizierten Blocks — die Sparseite der ROI. */
  suppressed_tokens_est: number;
  /** #457: est. tokens of the injected block; 0 when nothing was emitted. */
  hint_tokens_est: number;
  status: "ok" | "no-hits" | "suppressed" | "daemon-unreachable" | "timeout" | "error";
  error: string | null;
}

async function writeTelemetry(payload: BashFailHookTelemetry): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    // #356: the payload's session_id is real session state — synthetic UUID
    // only when the payload carried none.
    const { session_id: payloadSessionId, ...rest } = payload;
    const event = {
      kind: "bash_fail_hook_call",
      ts,
      session_id: payloadSessionId ?? randomUUID(),
      hook_version: HOOK_VERSION,
      ...rest,
    };
    const file = join(logDir, `events-${ts.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the lane.
  }
}
