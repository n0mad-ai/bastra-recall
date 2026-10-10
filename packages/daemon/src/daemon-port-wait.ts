/** Before storage boot: only bind/health probes, no vault or state writes. */
import { probeDaemonPort } from "./http.js";

export const SERVICE_PORT_RETRY_MS = 1000;
export const SERVICE_PORT_RETRY_MAX_MS = 30_000;
const OWNER_PROBE_MS = 750;

async function forwarderOwnsPort(port: number): Promise<boolean> {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), OWNER_PROBE_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal, redirect: "error" });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: boolean; started_by?: string };
    return body.ok === true && body.started_by === "forwarder";
  } catch { return false; }
  finally { clearTimeout(timer); }
}

/** Wait indefinitely while a forwarder owns the port. Only the interval is
 * capped: a total deadline would strand a systemd service with Restart=on-failure
 * after a long active client session. Referenced timers keep the waiter alive;
 * before shutdown handlers/storage exist, Node's default SIGTERM exits at once.
 * Test-only intervals never become user settings. */
export async function waitForForwarderPort(
  port: number,
  opts: { retryMs?: number; maxRetryMs?: number; onWaiting?: () => void } = {},
): Promise<boolean> {
  if (!await forwarderOwnsPort(port)) return false;
  opts.onWaiting?.();
  let interval = opts.retryMs ?? SERVICE_PORT_RETRY_MS;
  const cap = opts.maxRetryMs ?? SERVICE_PORT_RETRY_MAX_MS;
  for (;;) {
    await new Promise<void>(resolve => setTimeout(resolve, interval));
    if (await probeDaemonPort(port) === "free") return true;
    if (!await forwarderOwnsPort(port)) return false;
    interval = Math.min(interval * 2, cap);
  }
}
