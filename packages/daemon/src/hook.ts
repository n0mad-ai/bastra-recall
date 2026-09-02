#!/usr/bin/env node
/**
 * bastra-recall hook CLI — THIN CLIENT (#343/#15, stage A of #305 direction 2).
 *
 * The PreToolUse pipeline this file used to run (topics, recall, scope filter,
 * dedup, backoff, formatting, telemetry — 600 lines) lives daemon-side in
 * `write-lane.ts` now, behind POST /hook/write. What stays here is what must
 * run in the hook process:
 *
 *   stdin (JSON Claude-Code hook payload)
 *     → filter to PreToolUse on Write/Edit/MultiEdit/NotebookEdit
 *     → SKIP-GATE (#20/#28): pure-stdlib extension/basename filter. Kept
 *       CLIENT-side deliberately — it fires on the majority of calls, and a
 *       skipped call should cost a process start and nothing else: no HTTP,
 *       no daemon dependency.
 *     → POST /hook/write { payload } and write the response body to stdout
 *       VERBATIM — the daemon returns the exact document Claude Code expects.
 *
 * Discipline (unchanged): hard wall-clock budget, every failure path emits
 * `{}` and exits 0. stdlib + the dependency-free hook-skip/env modules only —
 * every import is process-start cost on every tool call (#305), and this file
 * is what #344 will compile.
 *
 * The client writes its own telemetry for what the daemon cannot see: skipped
 * calls (they never leave this process) and connection failures (they never
 * arrive). That unreachable-rate is what #346's local fallback will be judged
 * against.
 */
import { request } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { envFirst, envInt } from "./env.js";
import { shouldSkipPath } from "./hook-skip.js";
import { decorateHookPayload } from "./hook-surface.js";
import { normalizeWritePayload } from "./hook-write-input.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 600, "NEXUS_HOOK_TIMEOUT_MS");
const DEFAULT_PORT = 6723;
const HOOK_VERSION = "0.4.0-thin";

const SUPPORTED_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);

interface ClaudeHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// Ein-Emit-Kontrakt: Claude Code parst stdout als EIN JSON-Dokument.
let stdoutEmitted = false;
function emitOnce(payload: string): void {
  if (stdoutEmitted) return;
  stdoutEmitted = true;
  process.stdout.write(payload);
}

function emitEmpty(): void {
  emitOnce("{}");
}

/** POST the raw payload; resolve with the response body VERBATIM. */
function postWriteLane(baseUrl: string, body: unknown, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL("/hook/write", baseUrl);
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

/** Client-side telemetry for the calls the daemon cannot log: skips (never
 *  leave this process) and connection failures (never arrive). Same event
 *  kind and field shape as the daemon-side lane — one series. */
async function writeClientTelemetry(fields: {
  session_id: string | null;
  tool_name: string;
  file_path: string | null;
  daemon_url: string;
  status: "skipped" | "daemon-unreachable" | "timeout" | "error";
  error: string | null;
  startedAt: number;
}): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir =
      envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? join(homedir(), ".bastra", "logs");
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const event = {
      kind: "hook_call",
      ts,
      session_id: fields.session_id ?? randomUUID(),
      hook_version: HOOK_VERSION,
      tool_name: fields.tool_name,
      file_path: fields.file_path,
      topics: [],
      query_chars: 0,
      daemon_url: fields.daemon_url,
      // #352: null = never asked (skip-gate) — false is reserved for a path
      // that actually POSTed and got no response.
      daemon_reachable: fields.status === "skipped" ? null : false,
      hint_count: 0,
      required_count: 0,
      top_score: null,
      latency_ms_total: Date.now() - fields.startedAt,
      dropped_dedup_count: 0,
      dropped_scope_count: 0,
      hint_tokens_est: 0,
      hinted_ids: [],
      hinted_types: [],
      backoff_streak: 0,
      suppressed: false,
      suppressed_tokens_est: 0,
      status: fields.status,
      error: fields.error,
    };
    await appendFile(join(logDir, `events-${ts.slice(0, 10)}.jsonl`), JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the hook.
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  const raw = await readStdin();
  let payload: ClaudeHookPayload;
  try {
    payload = JSON.parse(raw) as ClaudeHookPayload;
  } catch {
    return emitEmpty();
  }

  if (payload.hook_event_name !== "PreToolUse") return emitEmpty();
  const decorated = decorateHookPayload(payload);
  const normalized = normalizeWritePayload(decorated);
  if (!normalized) return emitEmpty();
  payload = normalized;
  const toolName = payload.tool_name ?? "";
  if (!SUPPORTED_TOOLS.has(toolName)) return emitEmpty();

  const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;
  const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : null;
  if (!filePath) return emitEmpty();

  const httpURL = envFirst("BASTRA_HTTP_URL", "NEXUS_HTTP_URL");
  const httpPort = envFirst("BASTRA_HTTP_PORT", "NEXUS_HTTP_PORT") ?? String(DEFAULT_PORT);
  const url = httpURL ?? `http://127.0.0.1:${httpPort}`;

  // SKIP-GATE (#20/#28): the cheap path ends here, without any HTTP.
  // toolInput feeds the #297 memory-shape exception (lazy, .md branch only).
  if (shouldSkipPath(filePath, payload.cwd, toolInput)) {
    emitEmpty();
    await writeClientTelemetry({
      session_id: payload.session_id ?? null,
      tool_name: toolName,
      file_path: filePath,
      daemon_url: "",
      status: "skipped",
      error: null,
      startedAt,
    });
    return;
  }

  const remainingMs = Math.max(50, HOOK_TIMEOUT_MS - (Date.now() - startedAt));
  try {
    const body = await postWriteLane(url, { payload }, remainingMs);
    emitOnce(body);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    emitOnce("{}");
    const status =
      e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "EHOSTUNREACH"
        ? "daemon-unreachable"
        : e.message === "timeout"
          ? "timeout"
          : "error";
    await writeClientTelemetry({
      session_id: payload.session_id ?? null,
      tool_name: toolName,
      file_path: filePath,
      daemon_url: url,
      status,
      error: status === "error" ? (e.message ?? String(err)) : null,
      startedAt,
    });
  }
}

// Same guard bash-fail-hook.ts carries, and for the reason written down there:
// on module top level the kill-switch and the exit fire for IMPORTERS too.
// Exact basename, not endsWith: this file is plain "hook.js", and every
// sibling entrypoint (session-hook.js, prompt-hook.js, bash-fail-hook.js, …)
// ends with that string.
const isMain = (() => {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string") return false;
  const base = argv1.split(/[\\/]/).pop() ?? "";
  return base === "hook.js" || base === "hook.ts" || base === "bastra-recall-hook";
})();

if (isMain) {
  const killSwitch = setTimeout(() => {
    emitEmpty();
    process.exit(0);
  }, HOOK_TIMEOUT_MS + 50);
  killSwitch.unref();

  main()
    .then(() => process.exit(0))
    .catch(() => {
      emitEmpty();
      process.exit(0);
    });
}
