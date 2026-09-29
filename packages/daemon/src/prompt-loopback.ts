/**
 * UserPromptSubmit lane — the loopback self-call to /hook/recall and
 * /hook/reflex on this same server (split out of prompt-lane.ts, #680; why it
 * stays a loopback call is documented at the top of prompt-lane.ts).
 */
import { request } from "node:http";

// ─── loopback self-call ─────────────────────────────────────────────────────

export function postJson<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
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
