/** Synthetic loopback fixture. Never imports settings, vaults, or daemon startup. */
import { createServer } from "node:http";
import { gateApiRequest, isLoopback, isLoopbackHost, resolveCorsOrigin } from "../../../packages/daemon/src/http-auth.js";
import { sendCors, sendJson } from "../../../packages/daemon/src/http-util.js";

const rawOrigin = process.argv[2];
let origin: string;
try {
  const parsed = new URL(rawOrigin);
  if (parsed.protocol !== "https:" || parsed.origin !== rawOrigin) throw new Error();
  origin = parsed.origin;
} catch {
  console.error("Usage: node --import tsx tools/probes/browser-bridge/server.ts https://your.production.origin");
  process.exit(2);
}

// Public dummy value, deliberately unrelated to bastra token/settings/env.
const token = "bastra-browser-probe-dummy-not-a-secret";
const servers = [
  { port: 16723, allow: [origin], label: "allowed" },
  { port: 16724, allow: [] as string[], label: "denied" },
].map(({ port, allow, label }) => {
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!isLoopback(req) || !isLoopbackHost(req.headers.host, [])) {
      req.resume();
      sendJson(res, 403, { synthetic: true, error: "loopback only" });
      return;
    }
    if (req.url !== "/api/v1/probe") {
      req.resume();
      sendJson(res, 404, { synthetic: true, error: "probe route only" });
      return;
    }
    // Mirrors production preflight in src/http.ts:246-259 and CORS-before-gate
    // in src/http-api-surface.ts:64 (both under packages/daemon).
    const allowedOrigin = resolveCorsOrigin(req.headers.origin, allow);
    const preflight = req.method === "OPTIONS";
    sendCors(res, allowedOrigin, {
      allowPrivateNetwork: preflight && allowedOrigin !== null &&
        req.headers["access-control-request-private-network"] === "true",
    });
    const gateStatus = preflight ? 204 : gateApiRequest({
      reqOrigin: req.headers.origin,
      allowedOrigin,
      isLoopback: isLoopback(req),
      isLoopbackHost: isLoopbackHost(req.headers.host, []),
      authHeader: req.headers.authorization ?? "",
      apiToken: token,
      loopbackSkip: false,
    });
    const methodAllowed = req.method === "GET" || req.method === "POST";
    const status = preflight || methodAllowed ? gateStatus : 405;
    // Only protocol diagnostics; do not log Authorization, payloads, or cookies.
    console.log(JSON.stringify({ fixture: label, method: req.method,
      origin: req.headers.origin ?? null, status, cors: allowedOrigin !== null,
      requestedMethod: req.headers["access-control-request-method"] ?? null,
      privateNetwork: req.headers["access-control-request-private-network"] === "true" }));
    req.resume(); // discard every body; no vault or persistence exists
    if (preflight) { res.writeHead(status); res.end(); return; }
    if (!methodAllowed) {
      sendJson(res, 405, { synthetic: true, error: "GET/POST only" });
      return;
    }
    sendJson(res, status, { synthetic: true, fixture: label, ok: status === 200 });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on("error", (error) => {
    console.error(`Fixture ${port} failed: ${error.message}. Existing listeners are never stopped.`);
    for (const active of servers) active.close();
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`${label}: http://127.0.0.1:${port}/api/v1/probe; HTTPS origin ${origin}`);
  });
  return server;
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { for (const server of servers) server.close(); });
}
