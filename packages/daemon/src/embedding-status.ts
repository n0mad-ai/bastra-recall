/**
 * Single source of truth for the user-facing "semantic recall: ON/OFF" line.
 *
 * Shared by index.ts (OSS daemon) and bridge.ts (Pro bridge) so the wording
 * never drifts between the two — the repo previously carried three near-copies
 * of the embedding-provider logic with divergent log strings. Importing one
 * helper makes "identical wording" compiler-enforced instead of a code-review
 * promise. (#79: the silent-success path is what hid disabled embeddings.)
 */
export type EmbeddingSource = "env" | "cli-settings" | "api-key" | "none";

export interface EmbeddingStatus {
  on: boolean;
  /** provider.id, e.g. "ollama-embeddinggemma" or "openai"; null when off. */
  providerId: string | null;
  source: EmbeddingSource;
}

/**
 * The line every embedding path logs — including success, so an enabled OR a
 * silently-disabled provider is always visible. `prefix` lets the bridge keep
 * its "[bastra-recall.bridge]" tag while the message stays identical.
 */
export function embeddingStatusLine(s: EmbeddingStatus, prefix = "[bastra-recall]"): string {
  if (s.on && s.providerId) {
    return `${prefix} semantic recall: ON via ${s.providerId} (source: ${s.source})`;
  }
  return `${prefix} semantic recall: OFF — BM25 keyword search only. Enable it: bastra embeddings on`;
}

/**
 * #520: the migration line for an installation that used to ride the old
 * "OPENAI_API_KEY present → cloud embeddings" fallback.
 *
 * That fallback is gone: a generic credential another tool exported is not a
 * decision to send this vault's queries and memory text to OpenAI. Someone who
 * WANTED the cloud provider must not just silently degrade to BM25, so every
 * boot in this state says what changed and how to opt in on purpose.
 *
 * `null` = nothing to report (no key, or an explicit choice is in effect).
 */
export function cloudConsentNotice(s: EmbeddingStatus, prefix = "[bastra-recall]"): string | null {
  if (s.source !== "api-key") return null;
  return (
    `${prefix} OPENAI_API_KEY is set but no Bastra embedding provider was chosen — ` +
    `cloud embeddings stay OFF (#520: a generic key is not consent to send vault text to OpenAI). ` +
    `Local semantic recall: bastra embeddings on — OpenAI on purpose (query + memory text leaves your machine): ` +
    `bastra config set embedding.provider openai`
  );
}
