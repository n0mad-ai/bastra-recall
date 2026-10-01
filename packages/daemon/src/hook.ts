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
 * against. The row shape itself lives in `hook-client-telemetry.ts` (#543) —
 * one table for every lane and both client shapes, because a per-file copy is
 * how two lanes once came to write a third lane's event kind.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { envInt } from "./env.js";
import { writeClientTelemetry } from "./hook-client-telemetry.js";
import { resolveDaemonEndpoint } from "./daemon-endpoint.js";
import { shouldSkipPath } from "./hook-skip.js";
import { decorateHookPayload } from "./hook-surface.js";
import { normalizeWritePayload } from "./hook-write-input.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 600, "NEXUS_HOOK_TIMEOUT_MS");
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
    // An https:// daemon URL must use TLS, not fall through to plain
    // HTTP because `request` was always the node:http one regardless of
    // url.protocol; and `net.isIP()` (which node:http/net use to skip DNS for
    // a literal address) does not recognize URL's bracketed IPv6 hostname
    // ("[::1]"), so passing it through as-is sent that literal string to the
    // resolver and failed with EAI_AGAIN instead of connecting.
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? httpsRequest : httpRequest;
    const defaultPort = isHttps ? 443 : 80;
    let settled = false;
    // `timeout` on the options object is Node's socket-IDLE timeout — a
    // response dripping data never goes idle and never trips it. A plain
    // setTimeout that destroys the request regardless of activity is a real
    // deadline.
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error("timeout"));
    }, timeoutMs);
    const req = transport(
      {
        method: "POST",
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || defaultPort,
        path: url.pathname,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": payload.byteLength.toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (settled) return;
          clearTimeout(deadline);
          settled = true;
          const data = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          resolve(data);
        });
      },
    );
    req.on("error", (err) => {
      if (settled) return;
      clearTimeout(deadline);
      settled = true;
      reject(err);
    });
    req.write(payload);
    req.end();
  });
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

  // #531 — one resolver for the endpoint, shared with the CLI, the daemon and
  // the forwarder. This block used to ignore BASTRA_DAEMON_URL, which is the
  // variable the installer writes into a client registration.
  const url = resolveDaemonEndpoint().baseUrl;

  // SKIP-GATE (#20/#28): the cheap path ends here, without any HTTP.
  // toolInput feeds the #297 memory-shape exception (lazy, .md branch only).
  if (shouldSkipPath(filePath, payload.cwd, toolInput)) {
    emitEmpty();
    await writeClientTelemetry(
      "write",
      { tool_name: toolName, file_path: filePath, daemon_url: "", status: "skipped" },
      startedAt,
      payload.session_id ?? null,
      HOOK_VERSION,
    );
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
    await writeClientTelemetry(
      "write",
      {
        tool_name: toolName,
        file_path: filePath,
        daemon_url: url,
        status,
        error: status === "error" ? (e.message ?? String(err)) : null,
      },
      startedAt,
      payload.session_id ?? null,
      HOOK_VERSION,
    );
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
