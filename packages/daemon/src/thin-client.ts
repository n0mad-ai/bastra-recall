/**
 * Shared transport for the thin hook clients (#343/#344/#15).
 *
 * Every migrated hook CLI is the same ~100 lines: read stdin, POST the
 * payload to its daemon lane, write the response body to stdout VERBATIM,
 * fail open to `{}` on every path. This module is that block, once.
 *
 * Deliberately dependency-free beyond node stdlib + env.js — a thin client's
 * entire value is its process-start cost (#305), and this module is part of
 * what #344 compiles into the stub.
 *
 * NOT used by prompt-hook.ts / hook.ts yet: those two landed before this
 * module existed and are committed + tested as-is. Folding them onto this
 * helper is a follow-up cleanup, not worth churning a shipped client for.
 */
import { request } from "node:http";
import { envFirst } from "./env.js";
import { decorateHookPayload } from "./hook-surface.js";

export const DEFAULT_PORT = 6723;

export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

export function daemonBaseUrl(): string {
  const httpURL = envFirst("BASTRA_HTTP_URL", "NEXUS_HTTP_URL");
  const httpPort = envFirst("BASTRA_HTTP_PORT", "NEXUS_HTTP_PORT") ?? String(DEFAULT_PORT);
  return httpURL ?? `http://127.0.0.1:${httpPort}`;
}

/** POST `body`; resolve with the response body VERBATIM (the daemon returns
 *  the exact stdout document). Rejects on HTTP >= 400 / transport errors. */
export function postLane(
  baseUrl: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(path, baseUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const record = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
    const wireBody = record && "payload" in record
      ? { ...record, payload: decorateHookPayload(record.payload) }
      : body;
    const payload = Buffer.from(JSON.stringify(wireBody), "utf8");
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

export function classifyTransportError(e: NodeJS.ErrnoException): "daemon-unreachable" | "timeout" | "error" {
  if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "EHOSTUNREACH")
    return "daemon-unreachable";
  return e.message === "timeout" ? "timeout" : "error";
}
