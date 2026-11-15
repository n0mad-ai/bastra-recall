/**
 * The token-gated REST surface: everything under /api/v1/*. Owns the CORS
 * header + auth gate for that prefix, the handful of GET reads (health,
 * floors, graph, semantic layout, node) and the POST hand-off to the tool
 * dispatcher. Returns true when the request was handled.
 *
 * Separate from the loopback surface (http-local-routes.ts) because the trust
 * model differs: these routes are reachable through a tunnel and therefore
 * carry Origin/Token checks, while /hook/* and /health rely on being
 * loopback-only. The CORS preflight for this prefix stays in http.ts with the
 * rebinding host gate — it is front-door policy, answered before any routing.
 *
 * Split out of http.ts (file-size convention); route order preserved. The
 * per-tool POST logic lives in http-api-routes.ts, unchanged.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Vault } from "@bastra-recall/core";
import type { ToolDeps } from "./tool-handlers.js";
import type { HttpServerContext } from "./http-context.js";
import { handleGraphRead, isGraphReadPath } from "./http-graph-reads.js";
import { listFloors } from "./floors.js";
import { liveIntent, readActs } from "./floor-acts.js";
import { MAX_BODY_BYTES, readJsonBody, sendCors, sendJson } from "./http-util.js";
import { isLoopback, isLoopbackHost, hasForwardingHeaders, resolveCorsOrigin, gateApiRequest } from "./http-auth.js";
import { dispatchTaskHttp, defaultTaskContext } from "./task-transport.js";
import { dispatchApi } from "./http-api-routes.js";
import { handleMcpHttp } from "./http-mcp.js";
import { dispatchOAuthApi, mcpChallenge, verifyMcpBearer, MCP_PATH } from "./oauth-server.js";

export interface ApiSurfaceCtx {
  vault: Vault;
  toolDeps: ToolDeps;
  documentWriteEnabled: boolean;
  /** Live vector snapshot für die semantic map (#207). Getter, weil der
   *  Index erst nach dem Boot attacht. null = embeddings off / not ready. */
  embeddingVectors?: () => ReadonlyMap<string, Float32Array> | null;
  /** Boot context — token, CORS allowlist, health payload, and the semantic
   *  layout cache this dispatcher writes back into. */
  server: HttpServerContext;
}

export function dispatchApiSurface(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: string,
  ctx: ApiSurfaceCtx
): boolean {
  if (!url.startsWith("/api/v1/")) return false;
  const { toolDeps, documentWriteEnabled, server } = ctx;

  const reqOrigin = req.headers.origin;
  const allowedOrigin = resolveCorsOrigin(reqOrigin, server.corsAllow);
  sendCors(res, allowedOrigin); // before the gate, so a 401/403 still carries CORS

  if (url.startsWith("/api/v1/tasks") || url.startsWith("/api/v1/task_")) {
    const sameOrigin =
      reqOrigin === `http://${req.headers.host}` && isLoopback(req) && isLoopbackHost(req.headers.host, []);
    if (sameOrigin && reqOrigin) sendCors(res, reqOrigin);
    if (reqOrigin && !allowedOrigin && !sameOrigin) {
      sendJson(res, 403, { error: "origin not allowed" });
      return true;
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    return dispatchTaskHttp(req, res, method, url, defaultTaskContext(toolDeps, true));
  }

  // #1279: register/authorize/token are how a remote client gets a token, so
  // they answer before the bearer gate; each checks its own credentials.
  if (dispatchOAuthApi(req, res, method, url, { apiToken: server.apiToken, state: server.oauth })) return true;

  const gate = gateApiRequest({
    reqOrigin,
    allowedOrigin,
    isLoopback: isLoopback(req),
    hasForwardingHeaders: hasForwardingHeaders(req),
    // #526: no `allowedHosts` escape hatch here — a host that a tunnel
    // operator exposes must still carry the token. Only a genuinely
    // loopback Host proves this is a direct local client.
    isLoopbackHost: isLoopbackHost(req.headers.host, []),
    authHeader: req.headers.authorization ?? "",
    apiToken: server.apiToken,
    loopbackSkip: server.loopbackSkip,
  });
  if (gate === 403) {
    sendJson(res, 403, { error: "origin not allowed" });
    return true;
  }
  const isMcp = url.split("?", 1)[0] === MCP_PATH;
  if (gate === 401 && !isMcp) {
    sendJson(res, 401, { error: "unauthorized" });
    return true;
  }

  // #1279: MCP over Streamable HTTP, behind the same gate as the REST tools.
  // This route alone also takes an OAuth access token bound to it — that
  // token opens nothing else under /api/v1/. A 401 here names the protected
  // resource metadata, which is how an OAuth client finds the login.
  if (isMcp) {
    const mcpCtx = { toolDeps, documentWriteEnabled, ccSessionId: null };
    if (gate === 200) {
      handleMcpHttp(req, res, method, mcpCtx);
      return true;
    }
    verifyMcpBearer(req)
      .then((ok) => {
        if (ok) return handleMcpHttp(req, res, method, mcpCtx);
        const challenge = mcpChallenge(req, Boolean(req.headers.authorization));
        if (challenge) res.setHeader("WWW-Authenticate", challenge);
        sendJson(res, 401, { error: "unauthorized" });
      })
      .catch((err: Error) => sendJson(res, 500, { error: err.message }));
    return true;
  }

  // #141/#142: GET /api/v1/floors — der eine Read-Endpoint der REST-
  // Surface (rohe Registry-Einträge, token-auth wie die anderen /api/v1-
  // Tools; die loopback-Join-Variante fürs Hook-CLI ist /hook/floors).
  if (method === "GET") {
    const u = new URL(url, "http://127.0.0.1");
    // Reachability for a BROWSER. Same answer as /health, which a browser
    // cannot read (no CORS on token-free routes). Exists so a bridge never
    // has to spend a real recall — embedding, vector search and a "read"
    // notice — on the question "are you there".
    if (u.pathname === "/api/v1/health") {
      sendJson(res, 200, server.healthPayload());
      return true;
    }
    if (u.pathname === "/api/v1/floors") {
      const scope = u.searchParams.get("scope") ?? undefined;
      // #198: the act log is the truth, the registry row is its cache.
      // Every entry carries `live_intent` so a governance surface never has
      // to decide which of two answers to believe. The raw `last_affirmed`
      // /`affirmed_by`/`why` stay on the wire as that cache.
      Promise.all([listFloors(scope), readActs()])
        .then(([entries, acts]) =>
          sendJson(res, 200, {
            floors: entries.map((e) => ({
              ...e,
              live_intent: liveIntent(e.memory_id, e.floored_at, acts, e),
            })),
          })
        )
        .catch((err: Error) => sendJson(res, 500, { error: err.message }));
      return true;
    }
    if (isGraphReadPath(u.pathname, "/api/v1/graph")) {
      void handleGraphRead(res, url, ctx, false).catch((err: Error) => sendJson(res, 500, { error: err.message }));
      return true;
    }
  }

  if (method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  const tool = url.slice("/api/v1/".length);

  // #74: Session/Turn-Header des Forwarders — machen MCP-Loads dem
  // echten CC-Turn zuordenbar (statt latestTurn-Raterei bei parallelen
  // Sessions). Fehlen die Header (alte Forwarder, Direkt-Caller), bleibt
  // alles beim inferred-Verhalten.
  const ccSessionHeader = req.headers["x-bastra-cc-session"];
  const ccTurnHeader = req.headers["x-bastra-cc-turn"];
  const ccSessionId = typeof ccSessionHeader === "string" && ccSessionHeader ? ccSessionHeader : null;
  const actorHeader = req.headers["x-bastra-agent-id"];
  const agentId =
    typeof actorHeader === "string" && actorHeader ? (actorHeader === "main" ? null : actorHeader) : undefined;
  const ccTurnKey = typeof ccTurnHeader === "string" ? Number(ccTurnHeader) : null;
  const projectHeader = req.headers["x-bastra-project"];
  let callerProject: string | null = null;
  if (typeof projectHeader === "string") {
    try {
      callerProject = decodeURIComponent(projectHeader);
    } catch {
      /* unknown caller scope */
    }
  }

  readJsonBody(req, MAX_BODY_BYTES)
    .then(async (body) => {
      try {
        toolDeps.telemetry.ensureTurn(ccSessionId, ccTurnKey);
        const result = await dispatchApi(tool, body, {
          toolDeps,
          documentWriteEnabled,
          ccSessionId,
          agentId,
          project: callerProject,
        });
        if (result === undefined) {
          sendJson(res, 404, { error: `unknown tool: ${tool}` });
          return;
        }
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
    })
    .catch((err: Error) => {
      sendJson(res, 400, { error: err.message });
    });
  return true;
}
