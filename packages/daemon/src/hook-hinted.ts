/**
 * Surfaced-usage feedback ping (#154, review find 2026-07-03).
 *
 * The daemon's /hook/recall returns raw top-k hits; every hook CLI then
 * filters client-side (score floors, #110/#148 scope filter, per-session
 * dedup) before injecting. Only the hook knows what the model actually saw —
 * so the hook reports exactly that id list back, and ONLY those count as
 * "surfaced" in the usage sidecar. Without this, phantom demand (hits nobody
 * saw) would qualify memories for curator demotion.
 *
 * Best-effort by contract: hard timeout, never throws, resolves always.
 * Loopback POST like the bash hooks' act-signal.
 */
import { request } from "node:http";

export function reportHinted(
  baseUrl: string,
  ids: string[],
  /** #478 Part 2: the hook is the only place that knows which session saw
   *  these ids. Without it the act-detection window opens on an `inferred`
   *  turn, where a command from a PARALLEL session can close it — the count
   *  would then be about the wrong session. Lanes that have no session id
   *  report the ids for the usage sidecar as before, but open no window. */
  sessionId: string | null = null,
  timeoutMs = 120,
): Promise<void> {
  return new Promise((resolve) => {
    if (!Array.isArray(ids) || ids.length === 0) {
      resolve();
      return;
    }
    let url: URL;
    try {
      url = new URL("/hook/hinted", baseUrl);
    } catch {
      resolve();
      return;
    }
    const payload = Buffer.from(JSON.stringify({ ids, session_id: sessionId }), "utf8");
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
        res.resume();
        res.on("end", () => resolve());
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.on("error", () => resolve());
    req.end(payload);
  });
}
