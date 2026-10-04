/**
 * Start-up phase 5 (#1039): the shared dependency bag both tool surfaces (MCP
 * stdio and the HTTP routes) consume, with the turn-start prewarmer and the
 * #491 deadline shadow it carries.
 *
 * Moved verbatim out of `main()` in `index.ts`.
 */
import type { Vault, SearchIndex, EmbeddingProvider } from "@bastra-recall/core";
import type { Telemetry } from "./telemetry.js";
import { getPrimaryLanguage } from "./settings.js";
import type { BridgePool } from "./learned-recall/bridges.js";
import type { SupportedLanguage } from "./learned-recall/language.js";
import type { ToolDeps } from "./tool-handlers.js";
import type { EmbeddingBreaker } from "./embedding-breaker.js";
import { createEmbeddingPrewarmer } from "./embedding-prewarm.js";
import type { WarmupCoordinator } from "./embedding-warmup.js";
import type { DeadlineShadow, LatencyProfile } from "./latency-profile.js";
import { hostProfileId } from "./host-profile.js";
import type { OllamaInfo } from "./boot-embeddings.js";

export async function buildToolDeps(opts: {
  vaultPath: string;
  vault: Vault;
  search: SearchIndex;
  telemetry: Telemetry;
  commonsSearch: SearchIndex | null;
  commonsVerifications: Map<string, { works: number; fails: number }> | null;
  learnedBridges: BridgePool | null;
  sharedRecallLang: SupportedLanguage | null;
  evidenceGateOn: boolean;
  rawProvider: EmbeddingProvider | null;
  ollama: OllamaInfo | undefined;
  embeddingBreaker: EmbeddingBreaker | null;
  warmupEmbedding: WarmupCoordinator;
  latencyProfile: LatencyProfile;
}): Promise<{ toolDeps: ToolDeps }> {
  const {
    vaultPath,
    vault,
    search,
    telemetry,
    commonsSearch,
    commonsVerifications,
    learnedBridges,
    sharedRecallLang,
    evidenceGateOn,
    rawProvider,
    ollama,
    embeddingBreaker,
    warmupEmbedding,
    latencyProfile,
  } = opts;

  // Shared dependency-bag — wird sowohl vom MCP-stdio-Handler als auch von den
  // HTTP-REST-Routes konsumiert. Damit teilen beide Pfade Tool-Logik und
  // Telemetry; kein Drift.
  // #231 (language-first recall): the user's primary authoring language,
  // resolved once here like sharedRecallLang (boot-recall-options.ts);
  // scoreSaveQuality uses it for the save-time language-mismatch advisory.
  // Absent = feature dormant.
  const primaryLanguage = await getPrimaryLanguage();

  // #361: one small embed at each turn start, so the first assertion call of
  // the turn meets a warm model instead of losing the dense arm to the 150ms
  // deadline (#342). It goes through the BREAKER-GUARDED provider on purpose:
  // the warm call is a real embed, so a failing one is real evidence the
  // provider is down (it counts toward the breaker, and may serve as its single
  // half-open probe) — the same boundary every other embed crosses. And
  // availability is asked exactly as the recall path asks it: an attached
  // embedding index, and a breaker that is not open (half-open passes).
  // Der Koordinator dazu steht seit #494 in boot-embeddings.ts, vor dem
  // Embedding-Block.

  // #491: das gelernte Latenzprofil des dichten Arms, im SCHATTEN. Es rechnet
  // neben jedem Recall die Frist aus, die es gesetzt HÄTTE, und protokolliert
  // sie neben der, die tatsächlich galt — die festen 150/350/1500 ms bleiben
  // unangetastet, bis das Zeit-Tor aus #492 geöffnet ist.
  //
  // Geschlüsselt auf `rawProvider.id` (`ollama-embeddinggemma`,
  // `openai-text-embedding-3-small`) — dieselbe Kennung, an der schon
  // Vektor-Persistenz und Embed-Cache invalidieren. Ein Modellwechsel findet
  // seinen Schlüssel leer vor und erbt nichts.
  const deadlineShadow: DeadlineShadow = {
    key: () => rawProvider?.id ?? null,
    // Die Residenz kommt aus dem Warmup-Koordinator (#490) und nirgendwo
    // sonst — eine zweite Quelle dafür wäre eine zweite Wahrheit. #493: mit
    // ihrer Herkunft, damit die Auswertung Grundwahrheit von Schätzung trennen
    // kann.
    residency: () => warmupEmbedding.residencyDetail(),
    // #493: Der Provider hat für einen Call geladen (Ollama `load_duration`) —
    // die einzige Grundwahrheit über die Residenz, die dieser Pfad hat. Sie
    // geht in denselben Lifecycle-Zustand wie Warmups und Unloads.
    observeLoad: (loadMs) => warmupEmbedding.noteLoaded(loadMs),
    // #493: Tor 5 aus #492 fragt nach einer zweiten Maschine. Gesalzener Hash,
    // Salt bleibt lokal — kein Hostname, kein Nutzername (`host-profile.ts`).
    hostProfileId,
    profile: latencyProfile,
  };

  const prewarmEmbedding = createEmbeddingPrewarmer({
    // `ollama` is set exactly when the resolved provider is an Ollama one —
    // the only case with a model that goes cold and that our per-request
    // keep_alive (#78) governs. A hosted API keeps no model of ours resident,
    // so warming it is one egress request per minute of work for nothing.
    hostedProvider: () => rawProvider !== null && ollama === undefined,
    denseArmAvailable: () => search.hasEmbeddings() && embeddingBreaker?.state(Date.now()) !== "open",
    // #490: through the coordinator, not straight at the provider. The turn
    // start stays the trigger and its telemetry keeps meaning "the turn fired
    // the warm-up path"; whether that path then embeds is the coordinator's
    // call — it now KNOWS the model is resident where the 60s debounce could
    // only assume it, and it will not start a second load while one is
    // already in flight for another session.
    warm: async () => {
      warmupEmbedding.ensureWarm("turn");
    },
    onError: () => {
      // Silent by design: the prewarm is an optimisation, and a provider that
      // is genuinely down surfaces through the breaker and /health — not
      // through one log line per turn.
    },
  });

  const toolDeps: ToolDeps = {
    vault,
    search,
    telemetry,
    vaultPath: vaultPath,
    commonsSearch,
    commonsVerifications,
    learnedBridges,
    sharedRecallLang,
    primaryLanguage,
    // #165: Recall-Telemetrie flaggt Events als embedding_degraded, wenn der
    // Breaker gerade offen ist (Vector-Leg geskippt, BM25-only serviert).
    embeddingDegraded: embeddingBreaker
      ? () => embeddingBreaker.state(Date.now()) === "open"
      : undefined,
    // #264: Der Evidenzentscheid, scharf oder nicht. Beim Boot aufgelöst wie
    // die übrigen Schalter; Default aus. Aus heißt NICHT „läuft nicht" — er
    // läuft und wird geloggt, er wirkt nur auf nichts (§21.1: erst shadow).
    evidenceGateEnabled: () => evidenceGateOn,
    // #361: the prompt lane fires this at turn start (fire-and-forget).
    prewarmEmbedding,
    // #490: the session lane asks this for residency and lets it start the
    // load beside the session-start recall.
    warmupEmbedding,
    // #491: shadow only — computed and logged next to the fixed deadline, and
    // it decides nothing until #492's time gate opens.
    deadlineShadow,
  };

  return { toolDeps };
}
