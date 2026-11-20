/**
 * Shared transport for the thin hook clients (#343/#344/#15).
 *
 * Every migrated hook CLI is the same ~100 lines: read stdin, POST the
 * payload to its daemon lane, write the response body to stdout VERBATIM,
 * fail open to `{}` on every path. This module is that block, once; the wire
 * part itself lives in `hook-transport.ts`, which `hook.ts` and the compiled
 * stub use directly (#1508). What this layer adds is the node clients' own:
 * payload decoration and the task authorization header.
 *
 * Deliberately dependency-free beyond node stdlib + env.js — a thin client's
 * entire value is its process-start cost (#305).
 */
import { taskClientHeaders } from "./task-client-auth.js";
import { decorateHookPayload } from "./hook-surface.js";
import { resolveDaemonEndpoint } from "./daemon-endpoint.js";
import { postHookBody } from "./hook-transport.js";

export { DEFAULT_DAEMON_PORT as DEFAULT_PORT } from "./daemon-endpoint.js";
export { readStdin, classifyTransportError } from "./hook-transport.js";

export function daemonBaseUrl(): string {
  // #531 — THE endpoint. BASTRA_DAEMON_URL, which the installer writes into
  // client registrations, was invisible here until this call replaced a local
  // copy of the resolution.
  return resolveDaemonEndpoint().baseUrl;
}

/** POST `body`; resolve with the response body VERBATIM (the daemon returns
 *  the exact stdout document). Rejects on HTTP >= 400 / transport errors.
 *  `async`, so a throw while preparing the body or reading the credential
 *  still arrives as a rejection, as it did when this ran inside the executor. */
export async function postLane(baseUrl: string, path: string, body: unknown, timeoutMs: number): Promise<string> {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const wireBody = record && "payload" in record ? { ...record, payload: decorateHookPayload(record.payload) } : body;
  // The deadline runs from here, as it did when the timer was armed before
  // the credential read: a slow read leaves only what remains of it. A
  // monotonic clock, like that timer: a system clock set back cannot extend it.
  const started = performance.now();
  const headers = taskClientHeaders();
  return postHookBody(baseUrl, path, wireBody, Math.max(0, timeoutMs - (performance.now() - started)), headers);
}
