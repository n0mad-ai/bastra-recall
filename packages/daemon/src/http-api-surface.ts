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
import { buildGraph, buildSemanticLayout } from "@bastra-recall/core";
import type { ToolDeps } from "./tool-handlers.js";
import type { HttpServerContext } from "./http-context.js";
import { listSkills } from "./skills-registry.js";
import { listFloors } from "./floors.js";
import { liveIntent, readActs } from "./floor-acts.js";
import { computeHeat, computeReach, readUsage } from "./usage-sidecar.js";
import { MAX_BODY_BYTES, readJsonBody, sendCors, sendJson } from "./http-util.js";
import { isLoopback, isLoopbackHost, resolveCorsOrigin, gateApiRequest } from "./http-auth.js";
import { dispatchApi } from "./http-api-routes.js";

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
  ctx: ApiSurfaceCtx,
): boolean {
  if (!url.startsWith("/api/v1/")) return false;
  const { vault, toolDeps, documentWriteEnabled, server } = ctx;

  const reqOrigin = req.headers.origin;
  const allowedOrigin = resolveCorsOrigin(reqOrigin, server.corsAllow);
  sendCors(res, allowedOrigin); // before the gate, so a 401/403 still carries CORS

  const gate = gateApiRequest({
    reqOrigin,
    allowedOrigin,
    isLoopback: isLoopback(req),
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
  if (gate === 401) {
    sendJson(res, 401, { error: "unauthorized" });
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
          }),
        )
        .catch((err: Error) => sendJson(res, 500, { error: err.message }));
      return true;
    }
    // #207: the open graph projection — nodes/edges/clusters/ghosts.
    // The viewer contract: the web UI, the Mac app, and external tools
    // all render from this same JSON (#140: no privileged viewer).
    if (u.pathname === "/api/v1/graph") {
      // Declared skills (#215) classify ghost targets into the skills
      // ring — one small JSON read, same viewer contract for everyone.
      // #217: plus Usage-Heat-Join aus dem #154-Sidecar (Daemon-Substrat;
      // buildGraph bleibt reine Vault-Projektion).
      (async () => {
        const skills = await listSkills();
        const graph = buildGraph(vault, skills);
        const usage = await readUsage(toolDeps.vaultPath);
        const heat = computeHeat(usage);
        // #227: die rohen Zähler neben die normalisierte Zahl. heat ist ein
        // Rang INNERHALB dieses Vaults — auf einem kalten Vault trägt der
        // eine berührte Knoten 1.0. Wer das unterscheiden will, braucht die
        // Zahlen dahinter, nicht nur den Anteil.
        const reach = computeReach(usage);
        // heat IMMER stampfen (0 statt Key-weglassen). zzallirog
        // (2026-07-18): `if (h) n.heat = h` machte kalten Node und Build-
        // ohne-Heat byte-identisch — ein frisch importierter Vault las sich
        // als „Feature fehlt". Eine API, die bei Null verstummt, lehrt
        // Consumer den falschen Schluss. Jetzt trägt jeder Node `heat`.
        for (const n of graph.nodes) {
          n.heat = heat[n.id] ?? 0;
          // Immer stampfen, auch bei Null — dieselbe Begründung wie oben
          // bei heat: eine API, die bei Null verstummt, lehrt Consumer den
          // falschen Schluss ("Feature fehlt" statt "noch nichts passiert").
          n.reach = reach[n.id] ?? { loaded: 0, acted_on: 0, weight: 0, last_at: null };
        }
        sendJson(res, 200, graph);
      })().catch((err: Error) => sendJson(res, 500, { error: err.message }));
      return true;
    }
    // #207: the semantic layer — PCA positions by meaning + the
    // connections you never wrote (close in embedding space, no explicit
    // edge). 503 until the embedding index has vectors.
    if (u.pathname === "/api/v1/graph/semantic") {
      const vecs = ctx.embeddingVectors?.() ?? null;
      if (!vecs || vecs.size === 0) {
        sendJson(res, 503, { error: "embeddings not ready" });
        return true;
      }
      (async () => {
        if (!server.semanticCache || Date.now() - server.semanticCache.at > 60_000) {
          const skills = await listSkills();
          server.semanticCache = { at: Date.now(), body: buildSemanticLayout(buildGraph(vault, skills), vecs) };
        }
        sendJson(res, 200, server.semanticCache.body);
      })().catch((err: Error) => sendJson(res, 500, { error: err.message }));
      return true;
    }
    // #207: full body of one node for the map inspector. Same sensitivity
    // default as the other externally reachable read paths (no private).
    if (u.pathname === "/api/v1/graph/node") {
      const id = u.searchParams.get("id") ?? "";
      const mem = vault.get(id);
      if (!mem || mem.fm.sensitivity === "private") {
        sendJson(res, 404, { error: `unknown node: ${id}` });
        return true;
      }
      const { fm } = mem;
      sendJson(res, 200, {
        id: fm.id,
        title: fm.title,
        type: fm.type,
        scope: fm.scope,
        topic_path: fm.topic_path,
        tags: fm.tags,
        summary: fm.summary,
        related: fm.related,
        source: fm.source ?? null,
        created: fm.created,
        updated: fm.updated,
        body: mem.body,
      });
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
  const ccTurnKey = typeof ccTurnHeader === "string" ? Number(ccTurnHeader) : null;

  readJsonBody(req, MAX_BODY_BYTES)
    .then(async (body) => {
      try {
        toolDeps.telemetry.ensureTurn(ccSessionId, ccTurnKey);
        const result = await dispatchApi(tool, body, {
          toolDeps,
          documentWriteEnabled,
          ccSessionId,
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
