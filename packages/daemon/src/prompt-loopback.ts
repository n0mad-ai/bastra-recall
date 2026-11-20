/**
 * The daemon lanes' loopback self-calls to this same server: the prompt
 * lane's /hook/recall and /hook/reflex (split out of prompt-lane.ts, #680; why
 * it stays a loopback call is documented at the top of prompt-lane.ts), and
 * since #1508 the session lane's and Stop lane's calls, which each carried
 * their own copy of this block — and the CLI's panel, update hint and replay,
 * which did too. The hinted ping keeps its own request (hook-hinted.ts): it
 * drains an answer it never reads.
 */
import { request } from "node:http";
import { unbracketHostname } from "./hook-transport.js";

// ─── loopback self-call ─────────────────────────────────────────────────────

export function postJson<T>(baseUrl: string, path: string, body: unknown, timeoutMs: number): Promise<T> {
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
        // node:http throws ERR_INVALID_PROTOCOL for any other scheme before a
        // socket opens: an https:// endpoint is refused, never spoken to in
        // plain HTTP (#1508 review). Without it the scheme was ignored.
        protocol: url.protocol,
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
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error("invalid JSON response from daemon"));
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** GET `path` (a query string included); resolve with the parsed body on
 *  HTTP 200, `null` on anything else — non-200, unparsable body, timeout,
 *  connection error. Rejects only for a scheme other than http: (an https://
 *  endpoint, ERR_INVALID_PROTOCOL), as the CLI's own GETs did before #1508. */
export function getJson<T>(baseUrl: string, path: string, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(path, baseUrl);
    } catch {
      resolve(null);
      return;
    }
    const req = request(
      {
        method: "GET",
        // Refuses an https:// endpoint before a socket opens — see postJson.
        protocol: url.protocol,
        // The CLI's GETs (panel, update hint) take a configured endpoint,
        // which may be an IPv6 literal (#1508; see hook-transport.ts).
        hostname: unbracketHostname(url.hostname),
        port: url.port || 80,
        path: url.pathname + url.search,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
            if ((res.statusCode ?? 500) === 200) {
              resolve(data);
              return;
            }
          } catch {
            /* fallthrough */
          }
          resolve(null);
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}
