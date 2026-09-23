/**
 * Local HTTP endpoint for Claude Code hooks (PreToolUse / SessionStart / …)
 * UND REST-API für externe Caller (ChatGPT Custom GPT Actions via Cloudflare
 * Tunnel, weitere MCP-Forwarder-Sessions, andere AI-Agents).
 *
 * Lives alongside the stdio MCP transport in the same daemon process so the
 * in-memory BM25 index, der Embedding-Index und der RelatedEnricher EIN MAL
 * gehalten werden — egal wie viele Sessions/Clients gerade angedockt sind.
 *
 * Bind policy: 127.0.0.1 only. Wenn ein anderer bastra-recall daemon den
 * Port hält, geben wir auf und überlassen ihm die Endpoints (Vault-Pfad ist
 * by convention identisch). Für public exposure: Cloudflare-Tunnel / ngrok
 * davor und BASTRA_API_TOKEN setzen.
 *
 * Endpoints:
 *   GET  /health                         → { ok, vault_size, version }
 *   GET  /api/v1/health                  → dasselbe für den Browser (Token+
 *                                          CORS; /health trägt keine CORS-
 *                                          Header, siehe http-health.ts)
 *   POST /hook/recall                    → hook-spezifisch (Telemetry-Pfad,
 *                                          loopback-only, kein Auth)
 *
 *   REST-API (alle POST, JSON-Body, JSON-Antwort, mit Auth+CORS):
 *   POST /api/v1/recall                  → wie MCP-Tool recall
 *   POST /api/v1/load_memory             → wie MCP-Tool load_memory
 *   POST /api/v1/save_memory             → wie MCP-Tool save_memory
 *   POST /api/v1/find_code               → wie MCP-Tool find_code
 *   POST /api/v1/find_document           → wie MCP-Tool find_document
 *   POST /api/v1/read_document           → wie MCP-Tool read_document
 *   POST /api/v1/open_document           → wie MCP-Tool open_document
 *   POST /api/v1/save_document           → Pro-gated
 *   POST /api/v1/recategorize_document   → Pro-gated
 *   POST /api/v1/move_document           → Pro-gated
 *
 *   Floor-Registry (#141/#142, Auth wie die anderen /api/v1-Tools):
 *   POST /api/v1/floors                  → Floor hinzufügen/rewriten
 *   POST /api/v1/floors/release          → alle Einträge einer condition lösen
 *   POST /api/v1/floors/affirm           → last_affirmed stampen (braucht why)
 *   GET  /api/v1/floors[?scope=…]        → rohe Registry-Einträge
 *   GET  /hook/floors[?scope=…]          → Einträge + title/summary-Join
 *                                          (loopback-only, kein Auth)
 *
 * Auth (für /api/v1/* — /hook/recall und /health bleiben offen, sind
 * loopback-only):
 *   - Wenn BASTRA_API_TOKEN gesetzt: Authorization: Bearer <token>
 *     erforderlich.
 *   - Token-frei per Default nur, wenn BEIDES loopback ist: der Peer-Socket
 *     (127.0.0.1) UND ein vorhandener Host-Header (#526 — sonst erben DNS-
 *     Rebinding und lokale Tunnel die Ausnahme vom Socket; ein roher Port-
 *     Forwarder ergänzt gar keinen Host). BASTRA_AUTH_LOOPBACK_SKIP=0
 *     erzwingt das Token auch lokal.
 *   - Ohne gesetzten Token läuft NUR dieser direkte lokale Weg offen —
 *     dev/local mode. Alles andere (fremder Host, fehlender Host, Browser-
 *     Origin) bekommt 401: ohne konfiguriertes Token kann niemand sonst
 *     hinein (#526 reopened — vorher hat ein leeres Token die Prüfung
 *     komplett übersprungen und ein fremder Host kam durch).
 *
 * CORS (für /api/v1/*):
 *   - BASTRA_CORS_ORIGIN (default LEER = deny-all, #95) — Komma-Liste erlaubter
 *     Browser-Origins; nur gelistete werden zurückgespiegelt. "*" bleibt als
 *     explizites Tunnel/Dev-Opt-in. Für die Prod-Admin-App gehört ihre HTTPS-
 *     Origin (z.B. https://bastra.io) in die Liste.
 *   - Private Network Access: ein Preflight von öffentlicher HTTPS-Origin auf
 *     den localhost-Daemon wird automatisch mit
 *     `Access-Control-Allow-Private-Network: true` beantwortet (nur wenn die
 *     Origin erlaubt ist).
 */
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import type {
  Vault,
  SearchIndex,
  EmbeddingRuntimeHealth,
} from "@bastra-recall/core";
import type { EmbeddingBreakerSnapshot } from "./embedding-breaker.js";
import { type Telemetry } from "./telemetry.js";
import { type ToolDeps } from "./tool-handlers.js";
import { type ChatFn } from "./webui-chat.js";
import { type CuratorRunDeps } from "./curator-run.js";
import type { EmbeddingStatus } from "./embedding-status.js";
import { sendCors, sendJson } from "./http-util.js";
import { isLoopbackHost, resolveCorsOrigin } from "./http-auth.js";
import { dispatchUiRoutes } from "./http-ui-routes.js";
import { dispatchLocalRoutes } from "./http-local-routes.js";
import { dispatchApiSurface } from "./http-api-surface.js";
import { createHttpServerContext } from "./http-context.js";
import { listenHttp } from "./http-listen.js";

// File-size split: the auth/CORS policy, the hook handlers, the /api/v1
// dispatcher and the shared helpers moved into http-auth.ts,
// http-hook-routes.ts, http-ui-routes.ts, http-api-routes.ts and
// http-util.ts. The boot wiring, the loopback routes, the /api/v1 surface and
// the listen/close lifecycle followed into http-context.ts,
// http-local-routes.ts, http-api-surface.ts and http-listen.ts — what stays
// here is the front door: host gate, CORS preflight, dispatcher order.
// External importers (unit tests) keep their import path.
export {
  safeEqual,
  isLoopbackHost,
  corsAllowlistFromEnv,
  resolveCorsAllowlist,
  resolveCorsOrigin,
  gateApiRequest,
} from "./http-auth.js";
export { mergeHookRecallHits } from "./hook-recall-merge.js";

export interface HttpOptions {
  port: number;
  vault: Vault;
  search: SearchIndex;
  telemetry: Telemetry;
  version: string;
  toolDeps: ToolDeps;
  documentWriteEnabled: boolean;
  /** Called on every real request (everything except the liveness probes
   *  GET /health and GET /api/v1/health). Lets the
   *  daemon track activity for idle self-shutdown. */
  onActivity?: () => void;
  /** Resolved embedding mode — surfaced on /health so `bastra status` can show
   *  it (the daemon's own stderr is discarded when the forwarder spawns it). */
  embedding: EmbeddingStatus;
  /** Runtime-Health des Embedding-Providers (#92). Getter, weil sich der
   *  Zustand nach Boot ändert (Modell gelöscht, Ollama down → degraded;
   *  nächster Erfolg → wieder ok). null = kein Index aktiv. */
  embeddingHealth?: () => EmbeddingRuntimeHealth | null;
  /** Circuit-Breaker-Zustand (#165) für /health. null = kein Breaker aktiv
   *  (embeddings off). */
  embeddingBreaker?: () => EmbeddingBreakerSnapshot | null;
  /** The running doc2query paraphraser's model, or null (see http-health.ts). */
  triggerExpand?: () => { model: string } | null;
  /** Live vector snapshot für die semantic map (#207). Getter, weil der
   *  Index erst nach dem Boot attacht. null = embeddings off / not ready. */
  embeddingVectors?: () => ReadonlyMap<string, Float32Array> | null;
  /** Lokaler Chat-Client für den Such-Copiloten (#207). null = kein lokales
   *  Generierungsmodell verfügbar → /ui/chat antwortet 503. */
  uiChat?: ChatFn | null;
  /** Curator-Deps (#155/#156) für die /curator/*-Loopback-Endpoints. */
  curator?: CuratorRunDeps;
}

export interface HttpHandle {
  port: number | null;
  close: () => Promise<void>;
  /** #483: true when the port was already taken. The caller is then NOT the
   *  daemon and must not keep running background work — see index.ts. */
  addressInUse?: boolean;
}

/**
 * #483 review find: may this process give up when the port is taken?
 *
 * Only when nothing else depends on it staying alive. `dist/index.js` is two
 * surfaces in one file (`packages/daemon/README.md:21`): the shared daemon the
 * forwarder spawns, AND the standalone stdio MCP server a single client starts
 * for itself. The second one talks over stdin, not over 6723 — exiting there
 * would take a working MCP session down over a port it never needed.
 *
 * The two are distinguishable at fd 0. The forwarder spawns the shared daemon
 * with `stdio: "ignore"` (`forwarder-daemon-client.ts:52-56`) and launchd hands
 * it /dev/null — a character device either way. A stdio MCP client connects a
 * pipe, and a human running it in a terminal gets a TTY. Both mean: someone is
 * attached, keep running.
 */
export function mayExitOnBusyPort(stdin: { isTTY?: boolean; isPipe: boolean }): boolean {
  if (stdin.isTTY) return false;
  return !stdin.isPipe;
}

/**
 * #483: is the daemon port free? Asked BEFORE the vault, the embedding index
 * and the Ollama prewarm come up, so the loser of a start race exits before it
 * duplicates any of them. A plain TCP bind is enough — we only need to know
 * whether someone holds the port, not who.
 *
 * The probe closes immediately, so a race window of milliseconds remains until
 * the real listen(); `startHttpServer` reports EADDRINUSE via `addressInUse`
 * for that case.
 */
export async function probeDaemonPort(port: number): Promise<"free" | "in-use"> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE" ? "in-use" : "free");
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve("free"));
    });
  });
}

export async function startHttpServer(opts: HttpOptions): Promise<HttpHandle> {
  const { port, vault, telemetry, toolDeps, documentWriteEnabled, onActivity } = opts;
  const { search } = toolDeps;
  // Boot wiring — token, CORS allowlist, host list, live updates, vault and
  // telemetry bindings, /health payload. Resolved once, before the first
  // request (http-context.ts).
  const ctx = await createHttpServerContext(opts);

  const server = createServer((req, res) => {
    const t0 = Date.now();
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // Activity signal for idle self-shutdown — count real work, not the cheap
    // liveness pings (else a monitor, or bastra.io's admin bridge probing every
    // 60s, would keep us alive forever).
    if (!ctx.isHealthProbe(url)) onActivity?.();

    // DNS-Rebinding-Gate für alles außer /api/v1/* (dort schützt das Token):
    // die offenen Endpoints sind loopback-only by design — ein nicht-loopback
    // Host-Header heißt, ein Browser wurde auf 127.0.0.1 umgebogen.
    if (!url.startsWith("/api/v1/") && !isLoopbackHost(req.headers.host, ctx.allowedHosts)) {
      sendJson(res, 403, { error: "host not allowed" });
      return;
    }

    // CORS preflight for /api/v1/*
    if (method === "OPTIONS" && url.startsWith("/api/v1/")) {
      const allowedOrigin = resolveCorsOrigin(req.headers.origin, ctx.corsAllow);
      // Private Network Access (Chrome): ein Preflight von öffentlicher HTTPS-
      // Origin auf die localhost-Ressource (Prod-Admin-App https://bastra.io →
      // 127.0.0.1-Daemon) trägt diesen Request-Header und wird sonst geblockt.
      // Nur beim Preflight beantworten, nur wenn die Origin erlaubt ist.
      const allowPrivateNetwork =
        allowedOrigin !== null &&
        req.headers["access-control-request-private-network"] === "true";
      sendCors(res, allowedOrigin, { allowPrivateNetwork });
      res.writeHead(204);
      res.end();
      return;
    }

    // Loopback surface: /health, /tools, /vault/count, /hook/*, /curator/*,
    // /settings/docs — all token-free behind the host gate above
    // (http-local-routes.ts, route order preserved).
    if (dispatchLocalRoutes(req, res, method, url, t0, {
      vault,
      telemetry,
      toolDeps,
      healthPayload: ctx.healthPayload,
      curator: opts.curator,
    })) {
      return;
    }

    // Vault-map web UI surface (#207/#208/#215/#216) + its hook-side
    // companions (/hook/import, /hook/onboarding, /hook/session-context) —
    // route order preserved inside http-ui-routes.ts.
    if (dispatchUiRoutes(req, res, method, url, {
      vault,
      search,
      toolDeps,
      liveUpdates: ctx.liveUpdates,
      uiChat: opts.uiChat,
    })) {
      return;
    }

    // ─── REST-API /api/v1/* ──────────────────────────────────────
    if (dispatchApiSurface(req, res, method, url, {
      vault,
      toolDeps,
      documentWriteEnabled,
      embeddingVectors: opts.embeddingVectors,
      server: ctx,
    })) {
      return;
    }

    sendJson(res, 404, { error: `not found: ${method} ${url}` });
  });

  return listenHttp(server, port);
}
