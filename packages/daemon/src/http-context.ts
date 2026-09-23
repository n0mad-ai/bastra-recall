/**
 * Boot wiring for the HTTP surface: everything `startHttpServer` resolves ONCE
 * before the first request — the API token, the CORS allowlist, the rebinding
 * host list, the live-update buffer, the vault/telemetry bindings and the
 * shared /health payload.
 *
 * Separate from http.ts because this is per-server STATE, not routing: the
 * request handler and the route dispatchers read it, and none of them may
 * re-resolve it per request (token and allowlist come off disk, the uptime
 * stamp would reset, the semantic layout cache would never hit). Split out of
 * http.ts (file-size convention).
 *
 * The step order below is the order it ran in http.ts and stays load-bearing:
 * the vault binding and the telemetry notices are attached before the server
 * answers anything.
 */
import { missingVaultReason } from "./vault-presence.js";
import type { SemanticLayout } from "@bastra-recall/core";
import { bindAppliesToVault } from "./code-graph/applies-to.js";
import { buildHealthPayload } from "./http-health.js";
import { ownBuildStamp } from "./build-stamp.js";
import { createStalenessMonitor, defaultStalenessIo } from "./code-staleness.js";
import { getUpdateState } from "./update-check.js";
import { createLiveUpdates } from "./live-updates.js";
import { getApiToken, getCorsOrigins } from "./settings.js";
import { corsAllowlistFromEnv, resolveCorsAllowlist } from "./http-auth.js";
import type { HttpOptions } from "./http.js";

export interface HttpServerContext {
  apiToken: string;
  loopbackSkip: boolean;
  corsAllow: string[];
  /** Extra hosts accepted by the DNS-rebinding gate — NOT by /api/v1/* (#526). */
  allowedHosts: string[];
  /** #216: fresh-memory buffer for the map's live mode (supernova + card) */
  liveUpdates: ReturnType<typeof createLiveUpdates>;
  /** Reachability + vault size, shared by /health and /api/v1/health. */
  healthPayload: () => Record<string, unknown>;
  /** Liveness probes, on both doors — they must not count as activity. */
  isHealthProbe: (url: string) => boolean;
  /** #207: the semantic layout is the one genuinely heavy read (PCA + kNN over
   *  every vector) — cached per server, refreshed at most once a minute.
   *  Mutable: /api/v1/graph/semantic writes it back. */
  semanticCache: { at: number; body: SemanticLayout } | null;
}

export async function createHttpServerContext(opts: HttpOptions): Promise<HttpServerContext> {
  const { vault, telemetry, version } = opts;
  // #216: fresh-memory buffer for the map's live mode (supernova + card)
  const liveUpdates = createLiveUpdates(vault);
  // #578: the applies_to index reads THIS vault and is invalidated by its own
  // add/change/remove events. Without this binding the Write/Edit lane simply
  // emits no applies_to block — feature-less, never stale (applies-to.ts).
  bindAppliesToVault(vault);
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
  // loopback-only Endpoints exposen wollen). Für /api/v1/* gilt die Liste
  // NICHT (#526): dort darf ein fremder Host nur mit Token durch.
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

  // #528 — read once: the build this process runs from cannot change while it
  // runs, and /health is polled about once a second by the statusline.
  const buildRevision = ownBuildStamp()?.revision ?? null;

  return {
    apiToken,
    loopbackSkip,
    corsAllow,
    allowedHosts,
    liveUpdates,
    healthPayload: () =>
      buildHealthPayload({
        vaultSize: () => vault.size(),
        vaultMissing: () => missingVaultReason(vault.root),
        version,
        embedding: opts.embedding,
        embeddingHealth: opts.embeddingHealth,
        embeddingBreaker: opts.embeddingBreaker,
        triggerExpand: opts.triggerExpand,
        updateState: getUpdateState,
        startedAtMs,
        codeStale: () => staleness.check(),
        buildRevision,
      }),
    isHealthProbe: (url: string): boolean => url === "/health" || url === "/api/v1/health",
    semanticCache: null,
  };
}
