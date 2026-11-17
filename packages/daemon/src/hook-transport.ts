/**
 * The hook clients' wire transport, once (#1508): read stdin, POST a body to a
 * daemon lane, hand back the response body VERBATIM, classify a failure.
 *
 * Every hook client uses it — the node clients through `thin-client.ts`
 * (`postLane`, which adds payload decoration and the task authorization
 * header), `hook.ts` and the compiled stub directly, because neither sends
 * that header and the stub must not compile the credential reader in.
 *
 * Stdlib-only: the compiled stub imports it (#344), and every import here is
 * process-start cost on every hook call (#305).
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (data += chunk));
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
function unbracketHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

/** POST `body` as JSON with `headers` added; resolve with the response body
 *  VERBATIM (the daemon returns the exact stdout document). Rejects on
 *  HTTP >= 400 / transport errors / the deadline. */
export function postHookBody(
  baseUrl: string,
  path: string,
  body: unknown,
  timeoutMs: number,
  headers: Record<string, string> = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(path, baseUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
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
          ...headers,
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
      }
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
  if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "EHOSTUNREACH") return "daemon-unreachable";
  return e.message === "timeout" ? "timeout" : "error";
}
