/**
 * The embedding provider for this process, built once for the daemon
 * (boot-embeddings.ts) and the app bridge (bridge.ts) (#1520 D7).
 *
 * The PRECEDENCE (env > cli-settings > none) lives in resolveEmbeddingChoice
 * (settings.ts, also used by the CLI, #79); the cloud provider comes from the
 * one gate in embedding-cloud.ts (#520). This module only turns the resolved
 * name into a provider instance and its /health status. Logging and lifecycle
 * stay with each caller.
 */
import { OllamaEmbeddingProvider, type EmbeddingProvider } from "@bastra-recall/core";
import { cloudEmbeddingProvider } from "./embedding-cloud.js";
import type { EmbeddingStatus, EmbeddingSource } from "./embedding-status.js";
import { resolveEmbeddingChoice } from "./settings.js";

export interface OllamaInfo {
  baseURL: string;
  model: string;
  keepAlive: string | number;
}

export interface ResolvedEmbedding {
  provider: EmbeddingProvider | null;
  status: EmbeddingStatus;
  /** Set for Ollama when the caller keeps the model warm (the daemon). */
  ollama?: OllamaInfo;
}

export async function resolveEmbedding(opts: {
  /** Called with the raw value when BASTRA_EMBEDDING_PROVIDER is set but invalid. */
  onInvalidEnv: (raw: string) => void;
  /** Send Ollama keep_alive with every embed request (#78 power plan; the daemon does, the bridge does not). */
  keepAlive: boolean;
  env?: Record<string, string | undefined>;
  /** cli-settings.json; tests only. */
  path?: string;
}): Promise<ResolvedEmbedding> {
  const env = opts.env ?? process.env;
  const choice = await resolveEmbeddingChoice({ env, path: opts.path, onInvalidEnv: opts.onInvalidEnv });
  if (choice.provider === "ollama") return ollamaEmbedding(choice.source, env, opts.keepAlive);
  const cloud = cloudEmbeddingProvider(choice, env);
  if (cloud) return { provider: cloud, status: { on: true, providerId: cloud.id, source: choice.source } };
  return { provider: null, status: { on: false, providerId: null, source: choice.source } };
}

function ollamaEmbedding(
  source: EmbeddingSource,
  env: Record<string, string | undefined>,
  warm: boolean
): ResolvedEmbedding {
  const baseURL = env.BASTRA_OLLAMA_URL ?? "http://localhost:11434";
  const model = env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma";
  // Optional dim override for non-default models (e.g. bge-m3 at 1024 dim).
  // Number.isFinite guard: `NaN ?? default` keeps NaN, which would poison the
  // index dim. A non-numeric env value falls back to the provider default.
  const dimEnv = env.BASTRA_EMBEDDING_DIM;
  const parsed = dimEnv ? Number.parseInt(dimEnv, 10) : undefined;
  const dim = parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
  if (!warm) {
    const provider = new OllamaEmbeddingProvider({ baseURL, model, dim });
    return { provider, status: { on: true, providerId: provider.id, source } };
  }
  // keep_alive per embed request keeps the model warm during active work
  // without pinning it in memory for good.
  const keepAlive = env.BASTRA_OLLAMA_KEEP_ALIVE ?? "10m";
  const provider = new OllamaEmbeddingProvider({ baseURL, model, dim, keepAlive });
  return { provider, status: { on: true, providerId: provider.id, source }, ollama: { baseURL, model, keepAlive } };
}
