/**
 * #520: the ONE place in the daemon that may build a CLOUD embedding provider.
 *
 * Everything else about embeddings is local by construction — Ollama talks to
 * loopback and core refuses a non-loopback endpoint (ollama-egress.ts). The
 * OpenAI provider is the single code path that puts recall queries and vault
 * memory text on the wire to a third party, so it gets one gate instead of the
 * near-identical copy index.ts and bridge.ts each carried.
 *
 * The gate is deliberately narrow: an EXPLICIT Bastra choice (env
 * BASTRA_EMBEDDING_PROVIDER=openai or embedding.provider=openai in
 * cli-settings.json) that resolveEmbeddingChoice already turned into
 * `provider: "openai"`. A bare OPENAI_API_KEY never reaches this function with
 * that provider, because the resolver now stops at "none" (#520) — which is
 * what the negative-egress test pins.
 */
import { OpenAIEmbeddingProvider } from "@bastra-recall/core";
import type { EmbeddingChoice } from "./settings.js";

/**
 * The OpenAI provider for an explicitly chosen cloud setup, or `null`.
 *
 * `null` means "no cloud embedding call will ever be made from this boot" —
 * either the effective choice is not openai, or the key that the choice
 * depends on is not readable here (a plist that sets the provider but not the
 * key; the daemon then logs OFF instead of throwing).
 */
export function cloudEmbeddingProvider(
  choice: EmbeddingChoice,
  env: Record<string, string | undefined> = process.env,
): OpenAIEmbeddingProvider | null {
  if (choice.provider !== "openai") return null;
  const apiKey = env.OPENAI_API_KEY ?? env.BASTRA_EMBEDDING_KEY;
  return apiKey ? new OpenAIEmbeddingProvider({ apiKey }) : null;
}
