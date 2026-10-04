/**
 * Start-up phase 6 (#1039): the REST gateway (`startHttpServer`, http.ts) with
 * the health getters it reads from the earlier phases. `BASTRA_HTTP=off` gets
 * the inert handle it always got.
 *
 * Moved verbatim out of `main()` in `index.ts`. The post-listen #483 exit check
 * stays in `main()`, next to the early probe it backs up.
 */
import type { Vault, SearchIndex, EmbeddingIndex } from "@bastra-recall/core";
import type { Telemetry } from "./telemetry.js";
import { startHttpServer } from "./http.js";
import type { EmbeddingStatus } from "./embedding-status.js";
import { resolveGenerationModel } from "./settings.js";
import type { PowerMonitor } from "./power-source.js";
import { configFingerprint, daemonOrigin } from "./daemon-spawn-env.js";
import { ollamaChat } from "./learned-recall/reranker.js";
import type { ToolDeps } from "./tool-handlers.js";
import { DAEMON_VERSION } from "./version.js";
import type { EmbeddingBreaker } from "./embedding-breaker.js";
import type { OllamaInfo } from "./boot-embeddings.js";

export async function startHttp(opts: {
  httpDisabled: boolean;
  httpPort: number;
  vaultPath: string;
  vault: Vault;
  search: SearchIndex;
  telemetry: Telemetry;
  toolDeps: ToolDeps;
  documentWriteEnabled: boolean;
  markActivity: () => void;
  embeddingStatus: EmbeddingStatus;
  embIdxForHealth: EmbeddingIndex | null;
  embeddingBreaker: EmbeddingBreaker | null;
  triggerExpandModel: () => string | null;
  power: PowerMonitor;
  ollama: OllamaInfo | undefined;
}) {
  const {
    httpDisabled,
    httpPort,
    vaultPath,
    vault,
    search,
    telemetry,
    toolDeps,
    documentWriteEnabled,
    markActivity,
    embeddingStatus,
    embIdxForHealth,
    embeddingBreaker,
    triggerExpandModel,
    power,
    ollama,
  } = opts;

  const httpHandle =
    httpDisabled
      ? { port: null, close: async () => undefined }
      : await startHttpServer({
          port: httpPort,
          vault,
          search,
          telemetry,
          version: DAEMON_VERSION,
          toolDeps,
          documentWriteEnabled,
          onActivity: markActivity,
          embedding: embeddingStatus,
          embeddingHealth: () => embIdxForHealth?.runtimeHealth() ?? null,
          embeddingBreaker: () => embeddingBreaker?.snapshot(Date.now()) ?? null,
          triggerExpand: () => {
            const model = triggerExpandModel();
            return model ? { model } : null;
          },
          power: () => power.snapshot(),
          origin: { ...daemonOrigin(), configFingerprint: configFingerprint(process.env) },
          embeddingVectors: () => embIdxForHealth?.snapshot() ?? null,
          // Such-Copilot (#207): gleiche lokale Gen-Model-Auflösung wie
          // doc2query; ohne Ollama bleibt /ui/chat aus (503).
          uiChat: ollama
            // 8192 statt des 4096-Defaults (#366): die Lane feuert zwei
            // getrennte Calls. buildQueryPrompt nimmt history.slice(-4) ×
            // MAX_MESSAGE 2000 Zeichen + die Frage (webui-chat.ts:34,42) ≈ 10k
            // Zeichen ≈ 3k Tokens; buildAnswerPrompt läuft ohne History, dafür
            // mit HITS_TOTAL 8 × 600 Zeichen Body (:38,69) ≈ 1,5k Tokens. Der
            // Query-Prompt passt knapp in 4096 — 8192 ist der Headroom.
            ? ollamaChat({ baseURL: ollama.baseURL, model: await resolveGenerationModel(), timeoutMs: 45_000, numCtx: 8192 })
            : null,
          curator: { vaultRoot: vaultPath, vault, setDemotions: (ids) => search.setDemotions(ids) },
        });

  return { httpHandle };
}
