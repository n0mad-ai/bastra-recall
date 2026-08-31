#!/usr/bin/env node
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
import { request } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { envFirst, envInt } from "./env.js";
import { decorateHookPayload } from "./hook-surface.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 600, "NEXUS_HOOK_TIMEOUT_MS");
const DEFAULT_PORT = 6723;
const HOOK_VERSION = "0.3.0-thin";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// Ein-Emit-Kontrakt: Claude Code parst stdout als EIN JSON-Dokument. Der
// unref'te Kill-Switch kann feuern, während main() noch am Request hängt —
// ohne Guard schriebe er ein zweites "{}" hinter die Antwort.
let stdoutEmitted = false;
function emitOnce(payload: string): void {
  if (stdoutEmitted) return;
  stdoutEmitted = true;
  process.stdout.write(payload);
}

/** POST the raw payload; resolve with the response body VERBATIM. */
function postPromptLane(baseUrl: string, body: unknown, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL("/hook/prompt", baseUrl);
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

/** Minimal client-side telemetry for the calls the daemon never saw. Same
 *  event kind and field shape as the daemon-side lane, so the stats series
 *  stays one series. */
async function writeClientTelemetry(
  daemonUrl: string,
  status: "daemon-unreachable" | "timeout" | "error",
  error: string | null,
  startedAt: number,
  sessionId: string | null,
): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir =
      envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? join(homedir(), ".bastra", "logs");
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const event = {
      kind: "prompt_hook_call",
      ts,
      // The session_id from the Claude payload is real session state — fall
      // back to a synthetic UUID only if no payload session was given (#356).
      session_id: sessionId ?? randomUUID(),
      hook_version: HOOK_VERSION,
      detected_mode: "none",
      prompt_chars: 0,
      daemon_url: daemonUrl,
      daemon_reachable: false,
      hint_count: 0,
      top_score: null,
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

  const raw = await readStdin();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return emitOnce("{}");
  }

  const httpURL = envFirst("BASTRA_HTTP_URL", "NEXUS_HTTP_URL");
  const httpPort = envFirst("BASTRA_HTTP_PORT", "NEXUS_HTTP_PORT") ?? String(DEFAULT_PORT);
  const url = httpURL ?? `http://127.0.0.1:${httpPort}`;
  const remainingMs = Math.max(50, HOOK_TIMEOUT_MS - (Date.now() - startedAt));

  try {
    const body = await postPromptLane(
      url,
      { payload: decorateHookPayload(payload), client_ppid: process.ppid },
      remainingMs,
    );
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
    const p = payload as { session_id?: unknown } | null;
    const hookSessionId = typeof p?.session_id === "string" ? p.session_id : null;
    await writeClientTelemetry(
      url,
      status,
      status === "error" ? (e.message ?? String(err)) : null,
      startedAt,
      hookSessionId,
    );
  }
}

// Only run the CLI when invoked directly (filename match), not when imported by tests.
const argv1 = process.argv[1] ?? "";
const isCliEntry = argv1.endsWith("prompt-hook.js") || argv1.endsWith("prompt-hook.ts");

if (isCliEntry) {
  const killSwitch = setTimeout(() => {
    emitOnce("{}");
    process.exit(0);
  }, HOOK_TIMEOUT_MS + 50);
  killSwitch.unref();

  main()
    .then(() => process.exit(0))
    .catch(() => {
      emitOnce("{}");
      process.exit(0);
    });
}
