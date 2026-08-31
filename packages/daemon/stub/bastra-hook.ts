/**
 * bastra-hook — the compiled thin-client stub (#344).
 *
 * One binary, every hook entry point as a subcommand: `bastra-hook prompt`
 * (UserPromptSubmit) and `bastra-hook write` (PreToolUse Write/Edit). New
 * lanes join as new subcommands and inherit the fast start for free — which
 * is what #369 did for `stop`, `session` and `todo`: those three were still
 * spawning a full node interpreter (~75-78ms measured, against ~25ms here)
 * because they had no daemon-side lane to POST to. Stop fires at the end of
 * EVERY answer, so it was paying that per turn.
 *
 * The statusline rides along the same way (#347 stage 2): `bastra-hook
 * statusline` lazily imports the built statusline bundle — not a lane, just
 * an entry point that inherits the compiled start.
 *
 * This is the deliberate difference to the rejected "compile everything"
 * path: the LOGIC lives in the daemon (#343) and stays hot-swappable with a
 * daemon restart; what gets compiled is the ~200 lines that must run in the
 * hook process — stdin → POST → stdout verbatim, the pure-stdlib skip gate,
 * the client-side telemetry for calls the daemon cannot see. A logic change
 * never needs a stub rebuild; only a change to THIS contract does.
 *
 * Why the start matters: the hook budget is 200ms (#305). Measured on the
 * reference host, the node thin client pays 86–89ms of interpreter start
 * before its first syscall; the compiled stub pays ~15–25ms. That difference
 * is the whole point of #344.
 *
 * Built with `deno compile` (deno task in package.json — the toolchain that
 * is actually present on the dev host; bun would do equally). The stub uses
 * node:-specifier stdlib + the two dependency-free daemon modules only, so
 * both runtimes and plain node can run this file unchanged — which is also
 * the fallback: `node stub/bastra-hook.ts` behaves identically, just slower.
 */
import { request } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { envFirst, envInt } from "../src/env.js";
import { shouldSkipPath } from "../src/hook-skip.js";
import { decorateHookPayload } from "../src/hook-surface.js";
import { normalizeWritePayload } from "../src/hook-write-input.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 600, "NEXUS_HOOK_TIMEOUT_MS");
const DEFAULT_PORT = 6723;
const STUB_VERSION = "0.6.0-stub"; // 0.6.0 = Codex payload adaptation (#15)

type Lane = "prompt" | "write" | "bash-pre" | "bash-fail" | "stop" | "session" | "todo";
const LANES = new Set<Lane>([
  "prompt", "write", "bash-pre", "bash-fail", "stop", "session", "todo",
]);
const SUPPORTED_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);
/** The lanes whose failure the CLIENT logs. The three lanes added in #369 have
 *  their own event kinds (save_eval_call / session_hook_call / todo_hook_call)
 *  that describe a pipeline which did not run at all when the daemon is
 *  unreachable — writing a `hook_call` row for them would pollute a series
 *  that measures something else. Their node clients stay silent too. */
const CLIENT_TELEMETRY_LANES = new Set<Lane>(["prompt", "write", "bash-pre", "bash-fail"]);

/**
 * Per-lane wall-clock budget. Two lanes do not fit the 600ms recall budget:
 *
 *  · `stop` scans a transcript, and its node client has always used its own
 *    1000ms (BASTRA_STOP_HOOK_TIMEOUT_MS). Its answer is `{}` either way, so
 *    an early client timeout would only orphan work the daemon then finishes.
 *  · `session` mirrors what the fat session hook allowed itself: the lane
 *    budget plus 100ms, which is where its kill switch used to fire.
 */
function laneBudgetMs(lane: string): number {
  if (lane === "stop") return envInt("BASTRA_STOP_HOOK_TIMEOUT_MS", 1000);
  if (lane === "session") return envInt("BASTRA_HOOK_TIMEOUT_MS", 500, "NEXUS_HOOK_TIMEOUT_MS") + 100;
  return HOOK_TIMEOUT_MS;
}

interface HookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
  user_message?: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

let stdoutEmitted = false;
function emitOnce(payload: string): void {
  if (stdoutEmitted) return;
  stdoutEmitted = true;
  process.stdout.write(payload);
}

function postLane(baseUrl: string, path: string, body: unknown, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(path, baseUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": payload.byteLength.toString(),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const data = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          resolve(data);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** Same event kinds and field shapes as the daemon-side lanes — one series. */
async function writeClientTelemetry(
  lane: Lane,
  fields: Record<string, unknown>,
  startedAt: number,
): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir =
      envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? join(homedir(), ".bastra", "logs");
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const base =
      lane === "prompt"
        ? { kind: "prompt_hook_call", detected_mode: "none", prompt_chars: 0, hint_count: 0, top_score: null }
        : {
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
          };
    const event = {
      ts,
      session_id: randomUUID(),
      hook_version: STUB_VERSION,
      // #352: null = never asked (skip-gate) — false is reserved for a path
      // that actually POSTed and got no response.
      daemon_reachable: fields.status === "skipped" ? null : false,
      latency_ms_total: Date.now() - startedAt,
      error: null,
      ...base,
      ...fields,
    };
    await appendFile(join(logDir, `events-${ts.slice(0, 10)}.jsonl`), JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the hook.
  }
}

function classifyError(e: NodeJS.ErrnoException): "daemon-unreachable" | "timeout" | "error" {
  if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "EHOSTUNREACH")
    return "daemon-unreachable";
  return e.message === "timeout" ? "timeout" : "error";
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const lane = (process.argv[2] ?? "") as Lane;
  if (!LANES.has(lane)) {
    // Unknown subcommand: fail open like every other path — a misregistered
    // hook must not break the turn, and the mistake shows up in telemetry.
    emitOnce("{}");
    return;
  }

  const raw = await readStdin();
  let payload: HookPayload;
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    return emitOnce("{}");
  }
  payload = decorateHookPayload(payload);

  const httpURL = envFirst("BASTRA_HTTP_URL", "NEXUS_HTTP_URL");
  const httpPort = envFirst("BASTRA_HTTP_PORT", "NEXUS_HTTP_PORT") ?? String(DEFAULT_PORT);
  const url = httpURL ?? `http://127.0.0.1:${httpPort}`;

  // Lane-specific client-side gates — everything that must not cost a round trip.
  let path: string;
  let body: unknown;
  if (lane === "write") {
    if (payload.hook_event_name !== "PreToolUse") return emitOnce("{}");
    const normalized = normalizeWritePayload(payload);
    if (!normalized) return emitOnce("{}");
    payload = normalized;
    const toolName = payload.tool_name ?? "";
    if (!SUPPORTED_TOOLS.has(toolName)) return emitOnce("{}");
    const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;
    const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : null;
    if (!filePath) return emitOnce("{}");
    // toolInput feeds the #297 memory-shape exception (lazy, .md branch only).
    if (shouldSkipPath(filePath, payload.cwd, toolInput)) {
      emitOnce("{}");
      await writeClientTelemetry(
        "write",
        { tool_name: toolName, file_path: filePath, daemon_url: "", status: "skipped" },
        startedAt,
      );
      return;
    }
    path = "/hook/write";
    body = { payload };
  } else if (lane === "prompt") {
    path = "/hook/prompt";
    body = { payload, client_ppid: process.ppid };
  } else {
    // bash-pre / bash-fail / stop / session / todo: no client-side content
    // gates. The pattern tables, invokesOwnBinary, the Stop heuristics'
    // event/stop_hook_active gates and the TodoWrite confidence threshold are
    // hot-swappable lane logic (#344) — and for the three #369 lanes the
    // registration already guarantees the event, so a gate here would only
    // duplicate a check the lane makes in microseconds.
    path = `/hook/${lane}`;
    body = { payload };
  }

  const remainingMs = Math.max(50, laneBudgetMs(lane) - (Date.now() - startedAt));
  try {
    const out = await postLane(url, path, body, remainingMs);
    emitOnce(out);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    emitOnce("{}");
    if (!CLIENT_TELEMETRY_LANES.has(lane)) return;
    const status = classifyError(e);
    await writeClientTelemetry(
      lane,
      {
        daemon_url: url,
        status,
        error: status === "error" ? (e.message ?? String(err)) : null,
        ...(lane === "write"
          ? { tool_name: payload.tool_name ?? "", file_path: (payload.tool_input as { file_path?: string } | undefined)?.file_path ?? null }
          : {}),
      },
      startedAt,
    );
  }
}

if (process.argv[2] === "statusline") {
  // #347 stage 2: the statusline joins the stub for the compiled start. Not a
  // lane — no kill switch, no "{}" fail-open: its stdout is a rendered line
  // for the status bar, not hook JSON, so a failure must print nothing. The
  // bundle (self-contained, built by tsdown) is imported lazily; hook lanes
  // never pay for its load. The import specifier is a static string so
  // `deno compile` embeds the module in the binary.
  import("../../statusline/dist/index.mjs").catch(() => process.exit(0));
} else {
  const killSwitch = setTimeout(() => {
    emitOnce("{}");
    process.exit(0);
  }, laneBudgetMs(process.argv[2] ?? "") + 50);
  killSwitch.unref?.();

  main()
    .then(() => process.exit(0))
    .catch(() => {
      emitOnce("{}");
      process.exit(0);
    });
}
