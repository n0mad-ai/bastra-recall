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
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { decorateHookPayload } from "./hook-surface.js";
import { resolveDaemonEndpoint } from "./daemon-endpoint.js";

export { DEFAULT_DAEMON_PORT as DEFAULT_PORT } from "./daemon-endpoint.js";

export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/**
 * `URL#hostname` keeps the brackets for an IPv6 literal (`"[::1]"`),
 * but `net.isIP()` — the check node:http/net use to skip DNS entirely for a
 * literal address — does not recognize a bracketed string as one. Passing the
 * bracketed form through as `hostname` sent "[::1]" itself to the resolver,
 * which is not a hostname, and failed with EAI_AGAIN instead of connecting.
 */
export function unbracketHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

export function daemonBaseUrl(): string {
  // #531 — THE endpoint. BASTRA_DAEMON_URL, which the installer writes into
  // client registrations, was invisible here until this call replaced a local
  // copy of the resolution.
  return resolveDaemonEndpoint().baseUrl;
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
    // A BASTRA_DAEMON_URL of https:// must use TLS, not fall through to a
    // plain-HTTP socket because `request` was always the node:http one
    // regardless of url.protocol.
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? httpsRequest : httpRequest;
    const defaultPort = isHttps ? 443 : 80;
    let settled = false;
    // `timeout` on the options object is Node's socket-IDLE timeout — a
    // response dripping one byte every few hundred ms never goes idle and
    // never trips it, so a caller's real deadline was not enforced. A plain
    // setTimeout that destroys the request regardless of activity is.
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error("timeout"));
    }, timeoutMs);
    const req = transport(
      {
        method: "POST",
        hostname: unbracketHostname(url.hostname),
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

export function classifyTransportError(e: NodeJS.ErrnoException): "daemon-unreachable" | "timeout" | "error" {
  if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "EHOSTUNREACH")
    return "daemon-unreachable";
  return e.message === "timeout" ? "timeout" : "error";
}
