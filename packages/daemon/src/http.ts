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
 *   - Loopback-Aufrufe (127.0.0.1) werden per Default ohne Token
 *     akzeptiert (BASTRA_AUTH_LOOPBACK_SKIP=0 erzwingt Token auch lokal).
 *   - Ohne gesetzten Token läuft alles offen — dev/local mode.
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
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildGraph, buildSemanticLayout, type SemanticLayout } from "@bastra-recall/core";
import type {
  Vault,
  SearchIndex,
  EmbeddingRuntimeHealth,
} from "@bastra-recall/core";
import type { EmbeddingBreakerSnapshot } from "./embedding-breaker.js";
import { type Telemetry } from "./telemetry.js";
import { handleHookReflex, reflexPoolIds } from "./reflex.js";
import { runPromptLane, type ClaudeHookPayload } from "./prompt-lane.js";
import { runWriteLane, type WriteHookPayload } from "./write-lane.js";
import { runBashPreLane, type BashHookPayload } from "./bash-pre-lane.js";
import { runBashFailLane, type BashFailPayload } from "./bash-fail-lane.js";
import { dispatchLaneRoutes } from "./http-lane-routes.js";
import { computeHeat, computeReach, readUsage } from "./usage-sidecar.js";
import { buildHealthPayload } from "./http-health.js";
import { createStalenessMonitor, defaultStalenessIo } from "./code-staleness.js";
import { type ToolDeps } from "./tool-handlers.js";
import { getUpdateState } from "./update-check.js";
import { handleHookCare } from "./webui.js";
import { type ChatFn } from "./webui-chat.js";
import { listSkills } from "./skills-registry.js";
import { createLiveUpdates } from "./live-updates.js";
import { listConventions, detectTaxonomyDrift } from "./taxonomy.js";
import { listFloors } from "./floors.js";
import { liveIntent, readActs } from "./floor-acts.js";
import { handleCuratorRun, handleCuratorState, type CuratorRunDeps } from "./curator-run.js";
import {
  getApiToken,
  getCorsOrigins,
  getDocsLanguage,
  getDocsMode,
  setDocsLanguage,
  setDocsMode,
  isDocsMode,
  isDocsLanguage,
  DOCS_MODES,
} from "./settings.js";
import { ALL_TOOL_DEFS } from "./tool-defs.js";
import type { EmbeddingStatus } from "./embedding-status.js";
import { MAX_BODY_BYTES, readJsonBody, sendCors, sendJson } from "./http-util.js";
import {
  isLoopback,
  isLoopbackHost,
  corsAllowlistFromEnv,
  resolveCorsAllowlist,
  resolveCorsOrigin,
  gateApiRequest,
} from "./http-auth.js";
import { handleHookAct, handleHookRecall } from "./http-hook-routes.js";
import { dispatchApi } from "./http-api-routes.js";
import { dispatchUiRoutes } from "./http-ui-routes.js";

// File-size split: the auth/CORS policy, the hook handlers, the /api/v1
// dispatcher and the shared helpers moved into http-auth.ts,
// http-hook-routes.ts, http-ui-routes.ts, http-api-routes.ts and
// http-util.ts. External importers (unit tests) keep their import path.
export {
  safeEqual,
  isLoopbackHost,
  corsAllowlistFromEnv,
  resolveCorsAllowlist,
  resolveCorsOrigin,
  gateApiRequest,
} from "./http-auth.js";
export { mergeHookRecallHits } from "./http-hook-routes.js";

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
}

export async function startHttpServer(opts: HttpOptions): Promise<HttpHandle> {
  const { port, vault, telemetry, version, toolDeps, documentWriteEnabled, onActivity } = opts;
  const { search } = toolDeps;
  // #207: the semantic layout is the one genuinely heavy read (PCA + kNN over
  // every vector) — cache it per server, refreshed at most once a minute.
  let semanticCache: { at: number; body: SemanticLayout } | null = null;
  // #216: fresh-memory buffer for the map's live mode (supernova + card)
  const liveUpdates = createLiveUpdates(vault);
  // "read"-Notices (#216): jeder load_memory landet als Live-Ereignis in der Map
  telemetry.onMemoryLoaded = (id) => liveUpdates.notifyRead(id);
  // "surfaced"-Notices (#221): recall/hook_recall lassen ihre servierten
  // Treffer aufleuchten — nicht nur das seltene load_memory. Was serviert
  // gilt, entscheidet das Band (`surfacedHits` in telemetry.ts), nicht ein
  // hier gesetztes Top-N; der REANNOUNCE-Cooldown in live-updates deckelt
  // dann die Frequenz pro id.
  telemetry.onRecalled = (hits) => {
    for (const h of hits) liveUpdates.notifyRead(h.id, h.band);
  };

  // env wins (ops override); else the token minted by `bastra token` in
  // cli-settings.json. Empty = no token issued → browser clients are rejected.
  const apiToken = process.env.BASTRA_API_TOKEN || (await getApiToken()) || "";
  const loopbackSkip = (process.env.BASTRA_AUTH_LOOPBACK_SKIP ?? "1") !== "0";
  // CORS-Allowlist (Komma-Liste). Default seit #95: LEER — Browser-Origins
  // müssen explizit freigeschaltet werden (BASTRA_CORS_ORIGIN=https://your.host).
  // "*" bleibt als explizites Opt-in für Tunnel/Dev. Bei einer echten Liste
  // wird die Request-Origin nur zurückgespiegelt, wenn sie erlaubt ist — sonst
  // kein ACAO-Header und der Browser blockt die Response selbst. Browser-
  // Requests (Origin gesetzt) müssen zusätzlich das Token tragen (siehe Gate).
  // Quelle wie beim Token: env gewinnt als Ops-Override; sonst die von
  // `bastra token --origin` in cli-settings.json freigeschaltete Liste.
  const fromEnv = corsAllowlistFromEnv(process.env.BASTRA_CORS_ORIGIN);
  const corsAllow = resolveCorsAllowlist(fromEnv, await getCorsOrigins());
  if (corsAllow.includes("*") && apiToken) {
    console.error(
      "[bastra-recall] WARNING: BASTRA_CORS_ORIGIN=* with a minted API token — ANY website that obtains the token can call /api/v1/* from the browser. Set an explicit allowlist: BASTRA_CORS_ORIGIN=https://your.host",
    );
  }
  // Zusätzliche Hosts für das Rebinding-Gate (Tunnel-Setups, die auch die
  // loopback-only Endpoints exposen wollen). /api/v1/* braucht das nicht —
  // dort schützt das Token.
  const allowedHosts = (process.env.BASTRA_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  // Stamped when the server is wired up, not at module load: the value that
  // matters is "how long has this daemon been answering", and the two differ
  // by whatever the vault took to index.
  const startedAtMs = Date.now();

  // #329 — the disk can be replaced under a running process, and until this
  // existed nothing noticed. Probed lazily from the health path (throttled)
  // rather than on a timer: no extra clock, and the answer is at most one
  // throttle window old on the door where it is actually read.
  const staleness = createStalenessMonitor(version, defaultStalenessIo());

  /** Reachability + vault size, shared by /health and /api/v1/health. */
  const healthPayload = (): Record<string, unknown> =>
    buildHealthPayload({
      vaultSize: () => vault.size(),
      version,
      embedding: opts.embedding,
      embeddingHealth: opts.embeddingHealth,
      embeddingBreaker: opts.embeddingBreaker,
      updateState: getUpdateState,
      startedAtMs,
      codeStale: () => staleness.check(),
    });

  /** Liveness probes, on both doors — they must not count as activity. */
  const isHealthProbe = (url: string): boolean => url === "/health" || url === "/api/v1/health";

  const server = createServer((req, res) => {
    const t0 = Date.now();
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // Activity signal for idle self-shutdown — count real work, not the cheap
    // liveness pings (else a monitor, or bastra.io's admin bridge probing every
    // 60s, would keep us alive forever).
    if (!isHealthProbe(url)) onActivity?.();

    // DNS-Rebinding-Gate für alles außer /api/v1/* (dort schützt das Token):
    // die offenen Endpoints sind loopback-only by design — ein nicht-loopback
    // Host-Header heißt, ein Browser wurde auf 127.0.0.1 umgebogen.
    if (!url.startsWith("/api/v1/") && !isLoopbackHost(req.headers.host, allowedHosts)) {
      sendJson(res, 403, { error: "host not allowed" });
      return;
    }

    // CORS preflight for /api/v1/*
    if (method === "OPTIONS" && url.startsWith("/api/v1/")) {
      const allowedOrigin = resolveCorsOrigin(req.headers.origin, corsAllow);
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

    if (method === "GET" && url === "/health") {
      sendJson(res, 200, healthPayload());
      return;
    }

    // The daemon's own tool definitions (#132): the stdio forwarder fetches
    // these so the schema a client is told always matches what THIS daemon
    // validates — no skew when a forwarder build is newer than the daemon code
    // in RAM. Loopback-only + token-free like /health (the Host-gate above
    // covers it; this is non-/api/v1).
    if (method === "GET" && url === "/tools") {
      sendJson(res, 200, { tools: ALL_TOOL_DEFS });
      return;
    }

    if (method === "GET" && url === "/vault/count") {
      // Reconcile the index against disk before answering — the fs watcher
      // misses external writes/deletes on cloud-storage mounts, so a plain
      // vault.size() can be stale. This is the fresh count the `bastra` status
      // panel reads. Falls back to the in-memory size if reconcile throws.
      vault
        .reconcile()
        .then((count) => sendJson(res, 200, { count }))
        .catch(() => sendJson(res, 200, { count: vault.size() }));
      return;
    }

    if (method === "POST" && url === "/hook/recall") {
      handleHookRecall(req, res, t0, vault, search, telemetry, toolDeps.learnedBridges, toolDeps.sharedRecallLang, toolDeps.embeddingDegraded, toolDeps.evidenceGateEnabled);
      return;
    }

    // #217 Reflex-Lane: hartes recall_when-Matching ohne aktive Query, nur
    // über reflex-markierte Memories. Loopback-only wie /hook/recall.
    if (method === "POST" && url === "/hook/reflex") {
      handleHookReflex(req, res, t0, vault, telemetry);
      return;
    }

    // #343 (stage A of #305 direction 2): the full UserPromptSubmit pipeline,
    // server-side. The thin client POSTs {payload, client_ppid} and writes the
    // response body to stdout verbatim, so this endpoint returns the exact
    // document Claude Code expects — `{}` or the hookSpecificOutput envelope —
    // and fails open to `{}` with 200: the client must never see an error it
    // would only translate back into `{}` anyway. Loopback-only like
    // /hook/recall. Logic lives in prompt-lane.ts; this stays a route.
    if (method === "POST" && url === "/hook/prompt") {
      readJsonBody(req, MAX_BODY_BYTES)
        .then(async (body) => {
          const payload = (body.payload ?? {}) as ClaudeHookPayload;
          const ppid = typeof body.client_ppid === "number" ? body.client_ppid : null;
          const self = `http://127.0.0.1:${req.socket.localPort ?? 6723}`;
          // #361: the prewarmer rides in from toolDeps — the lane fires it at
          // turn start and never awaits the embed behind it.
          // #371: the wired reflex pool rides in from the vault index. Mode
          // "none" — 91% of prompts — can inject nothing else, so the lane
          // uses it to decide whether the full-vault recall is worth paying
          // for at all.
          const out = await runPromptLane(payload, ppid, self, toolDeps.prewarmEmbedding, () =>
            reflexPoolIds(vault),
          );
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(out);
        })
        .catch(() => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end("{}");
        });
      return;
    }

    // #343 second half: same contract as /hook/prompt, for the PreToolUse
    // Write/Edit lane. The skip gate stays in the thin client (pure stdlib,
    // fires on the majority of calls), so everything arriving here already
    // survived it. No client_ppid — this lane touches no statusline feed.
    if (method === "POST" && url === "/hook/write") {
      readJsonBody(req, MAX_BODY_BYTES)
        .then(async (body) => {
          const payload = (body.payload ?? {}) as WriteHookPayload;
          const self = `http://127.0.0.1:${req.socket.localPort ?? 6723}`;
          const out = await runWriteLane(payload, self, toolDeps.vaultPath);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(out);
        })
        .catch(() => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end("{}");
        });
      return;
    }

    // #343 pattern, bash lanes: same contract as /hook/prompt and /hook/write.
    // No client-side content gates — the pattern tables and invokesOwnBinary
    // are gate logic that must stay hot-swappable, so they live in the lanes.
    if (method === "POST" && url === "/hook/bash-pre") {
      readJsonBody(req, MAX_BODY_BYTES)
        .then(async (body) => {
          const out = await runBashPreLane(
            (body.payload ?? {}) as BashHookPayload,
            `http://127.0.0.1:${req.socket.localPort ?? 6723}`,
          );
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(out);
        })
        .catch(() => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end("{}");
        });
      return;
    }
    if (method === "POST" && url === "/hook/bash-fail") {
      readJsonBody(req, MAX_BODY_BYTES)
        .then(async (body) => {
          const out = await runBashFailLane(
            (body.payload ?? {}) as BashFailPayload,
            `http://127.0.0.1:${req.socket.localPort ?? 6723}`,
          );
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(out);
        })
        .catch(() => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end("{}");
        });
      return;
    }

    // #369, same pattern, three more lanes: /hook/stop, /hook/session,
    // /hook/todo. Their routes live in http-lane-routes.ts (file-size
    // convention) — the contract is identical to the four above.
    if (dispatchLaneRoutes(req, res, method, url)) return;

    // #144: lightweight act-signal (PostToolUse:Bash). No recall, no injection —
    // only matches the excerpt against open loadedMemories episodes so
    // shell-driven applications of a memory can close them. Loopback-only
    // (Host-Gate above), no auth — same trust level as /hook/recall.
    if (method === "POST" && url === "/hook/act") {
      handleHookAct(req, res, telemetry);
      return;
    }

    // Surfaced-Feedback (#154): die Hook-CLI meldet die ids, die sie nach
    // ihrem client-seitigen Filtern WIRKLICH injiziert hat — nur die zählen
    // als "surfaced" im Usage-Sidecar. Loopback-only wie /hook/act.
    if (method === "POST" && url === "/hook/hinted") {
      readJsonBody(req, MAX_BODY_BYTES)
        .then((body) => {
          const ids = Array.isArray((body as { ids?: unknown })?.ids)
            ? ((body as { ids: unknown[] }).ids.filter((x) => typeof x === "string") as string[])
            : [];
          telemetry.recordSurfacedUsage(ids);
          sendJson(res, 200, { ok: true, counted: ids.length });
        })
        .catch(() => sendJson(res, 400, { error: "invalid body" }));
      return;
    }

    // Curator (#155/#156): Loopback-only wie /hook/* (Host-Gate oben).
    // GET = State lesen; POST = manueller Lauf, default dry-run (Review-
    // Anfrage, kein Demote-Consent) — Handler leben in curator-run.ts.
    if (opts.curator && method === "GET" && url === "/curator/state") {
      handleCuratorState(req, res, opts.curator);
      return;
    }
    if (opts.curator && method === "POST" && url === "/curator/run") {
      handleCuratorRun(req, res, opts.curator);
      return;
    }

    // Selbstlernende Taxonomie (#64): Konventions-Liste für die Session-Hook-
    // Injection (#66) und Drift-Analyse für den Stop-Hook (#67). Beides
    // loopback-only (Host-Gate oben), read-only, kein Auth — wie /hook/recall.
    if (method === "GET" && url === "/hook/taxonomy") {
      sendJson(res, 200, { conventions: listConventions(vault) });
      return;
    }
    if (method === "GET" && url === "/hook/drift") {
      sendJson(res, 200, { clusters: detectTaxonomyDrift(vault) });
      return;
    }

    // Vault-care count für die Session-Hook-Injection (#207): loopback-only,
    // read-only, kein Auth — wie /hook/taxonomy.
    if (method === "GET" && url === "/hook/care") {
      handleHookCare(res, toolDeps.vaultPath).catch(() => sendJson(res, 200, { open: 0 }));
      return;
    }

    // Floor-Registry (#141/#142): Einträge für die Session-Hook-Injection.
    // Loopback-only (Host-Gate oben), read-only, kein Auth — wie /hook/taxonomy.
    // Der Join id→title/summary passiert HIER via vault.get, damit die Hook-CLI
    // dumm bleibt (ein GET, keine per-Eintrag-Roundtrips). Ein nicht auflösbarer
    // Eintrag kommt ohne title zurück — sichtbar statt still (stale floor).
    if (method === "GET" && (url === "/hook/floors" || url.startsWith("/hook/floors?"))) {
      const u = new URL(url, "http://127.0.0.1");
      const scope = u.searchParams.get("scope") ?? undefined;
      listFloors(scope)
        .then((entries) => {
          const floors = entries.map((e) => {
            const mem = vault.get(e.memory_id);
            return {
              ...e,
              ...(mem ? { title: mem.fm.title, summary: mem.fm.summary } : {}),
            };
          });
          sendJson(res, 200, { floors });
        })
        .catch(() => sendJson(res, 200, { floors: [] }));
      return;
    }

    // Produkt-Doku-Settings für die Mac-App-Options-Pane: GET liest, POST
    // schreibt nach ~/.bastra/cli-settings.json (das OSS-owned Settings-File —
    // die App fasst es so nie direkt an). Loopback-only wie /hook/* (Host-Gate
    // oben); kein Token, weil dieselbe Maschine + derselbe User.
    if (url === "/settings/docs") {
      if (method === "GET") {
        Promise.all([getDocsMode(), getDocsLanguage()])
          .then(([mode, language]) => sendJson(res, 200, { mode, language }))
          .catch((err: Error) => sendJson(res, 500, { error: err.message }));
        return;
      }
      if (method === "POST") {
        readJsonBody(req, MAX_BODY_BYTES)
          .then(async (body) => {
            const mode = body.mode;
            const language = body.language;
            if (mode !== undefined && !isDocsMode(mode)) {
              sendJson(res, 400, { error: `mode must be one of: ${DOCS_MODES.join(" | ")}` });
              return;
            }
            if (language !== undefined && !isDocsLanguage(language)) {
              sendJson(res, 400, { error: "language must be a short tag like 'en', 'de', 'pt-br'" });
              return;
            }
            if (isDocsMode(mode)) await setDocsMode(mode);
            if (isDocsLanguage(language)) await setDocsLanguage(language);
            sendJson(res, 200, { mode: await getDocsMode(), language: await getDocsLanguage() });
          })
          .catch((err: Error) => sendJson(res, 400, { error: err.message }));
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    // Vault-map web UI surface (#207/#208/#215/#216) + its hook-side
    // companions (/hook/import, /hook/onboarding, /hook/session-context) —
    // route order preserved inside http-ui-routes.ts.
    if (dispatchUiRoutes(req, res, method, url, {
      vault,
      search,
      toolDeps,
      liveUpdates,
      uiChat: opts.uiChat,
    })) {
      return;
    }

    // ─── REST-API /api/v1/* ──────────────────────────────────────
    if (url.startsWith("/api/v1/")) {
      const reqOrigin = req.headers.origin;
      const allowedOrigin = resolveCorsOrigin(reqOrigin, corsAllow);
      sendCors(res, allowedOrigin); // before the gate, so a 401/403 still carries CORS

      const gate = gateApiRequest({
        reqOrigin,
        allowedOrigin,
        isLoopback: isLoopback(req),
        authHeader: req.headers.authorization ?? "",
        apiToken,
        loopbackSkip,
      });
      if (gate === 403) {
        sendJson(res, 403, { error: "origin not allowed" });
        return;
      }
      if (gate === 401) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
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
          sendJson(res, 200, healthPayload());
          return;
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
          return;
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
          return;
        }
        // #207: the semantic layer — PCA positions by meaning + the
        // connections you never wrote (close in embedding space, no explicit
        // edge). 503 until the embedding index has vectors.
        if (u.pathname === "/api/v1/graph/semantic") {
          const vecs = opts.embeddingVectors?.() ?? null;
          if (!vecs || vecs.size === 0) {
            sendJson(res, 503, { error: "embeddings not ready" });
            return;
          }
          (async () => {
            if (!semanticCache || Date.now() - semanticCache.at > 60_000) {
              const skills = await listSkills();
              semanticCache = { at: Date.now(), body: buildSemanticLayout(buildGraph(vault, skills), vecs) };
            }
            sendJson(res, 200, semanticCache.body);
          })().catch((err: Error) => sendJson(res, 500, { error: err.message }));
          return;
        }
        // #207: full body of one node for the map inspector. Same sensitivity
        // default as the other externally reachable read paths (no private).
        if (u.pathname === "/api/v1/graph/node") {
          const id = u.searchParams.get("id") ?? "";
          const mem = vault.get(id);
          if (!mem || mem.fm.sensitivity === "private") {
            sendJson(res, 404, { error: `unknown node: ${id}` });
            return;
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
          return;
        }
      }

      if (method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
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
      return;
    }

    sendJson(res, 404, { error: `not found: ${method} ${url}` });
  });

  return new Promise<HttpHandle>((resolve) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `[bastra-recall] http: port ${port} already in use — assuming another bastra-recall daemon owns it. Hooks will reach that one.`,
        );
        server.removeAllListeners("error");
        server.removeAllListeners("listening");
        resolve({
          port: null,
          close: async () => undefined,
        });
        return;
      }
      console.error(`[bastra-recall] http: failed to bind: ${err.message}`);
      resolve({
        port: null,
        close: async () => undefined,
      });
    };

    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const addr = server.address() as AddressInfo;
      console.error(`[bastra-recall] http: listening on http://127.0.0.1:${addr.port}`);
      resolve({
        port: addr.port,
        close: () => closeServer(server),
      });
    });
  });
}

// ─── helpers ─────────────────────────────────────────────────────

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

