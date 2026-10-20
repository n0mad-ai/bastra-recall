/**
 * The CLI's side of the daemon's `/code/refresh` door (#1148).
 *
 * Both calls are best effort by design. No daemon means no automatic refresh
 * and therefore nothing to report or to resume — `bastra code` and `bastra
 * doctor` then say what the manifest says, exactly as before. The calls are
 * loopback-only and token-free, like `/health`, and they time out quickly so a
 * status command never hangs on a daemon that is busy starting.
 */

import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
import { parseRefreshStatusRows } from "../code-graph/refresh-status.js";
import type { RepoStatus } from "../code-graph/refresh.js";

const TIMEOUT_MS = 1_500;

/** Per repository, or null when no daemon answered. */
export async function fetchRefreshStatus(
  baseUrl: string = resolveDaemonEndpoint().baseUrl,
): Promise<Map<string, RepoStatus> | null> {
  try {
    const res = await fetch(`${baseUrl}/code/refresh`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return new Map(parseRefreshStatusRows(await res.json()).map((s) => [s.repoRoot, s]));
  } catch {
    return null;
  }
}

/**
 * Ask the running daemon for a `manual` refresh: it clears a pause or a stop
 * and builds at once. True when the daemon took the request.
 */
export async function requestManualRefresh(
  repoRoot: string,
  baseUrl: string = resolveDaemonEndpoint().baseUrl,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/code/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: repoRoot }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
