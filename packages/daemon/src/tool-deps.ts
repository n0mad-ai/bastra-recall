/**
 * `ToolDeps` — everything a tool handler needs, injected rather than imported.
 *
 * Lives in its own module so `save-quality.ts` and `tool-handlers.ts` can both
 * depend on the shape without depending on each other. Re-exported from
 * tool-handlers.ts, which is where every existing caller imports it from.
 */
import type { Vault, SearchIndex } from "@bastra-recall/core";
import type { Telemetry } from "./telemetry.js";
import type { BridgePool } from "./learned-recall/bridges.js";
import type { SupportedLanguage } from "./learned-recall/language.js";
import type { Prewarmer } from "./embedding-prewarm.js";

export interface ToolDeps {
  vault: Vault;
  search: SearchIndex;
  telemetry: Telemetry;
  vaultPath: string;
  /** Read-only Bastra-Commons-Index (BM25-only), wenn `bastra commons enable`
   *  aktiv ist. Hits tragen scope "commons" aus ihrem Frontmatter — kein
   *  eigenes source-Feld nötig. */
  commonsSearch?: SearchIndex | null;
  /** works/fails-Zählung aus den Verification-Records pro Rezept-ID — die
   *  Evidenz, die das Fusion-Ranking hebt oder senkt (verify-Loop). */
  commonsVerifications?: Map<string, { works: number; fails: number }> | null;
  /** Read-only, language-partitioned learned-recall bridge pool (#120), present
   *  only when `bastra bridges enable` is active. Used to widen the recall query;
   *  null/absent = feature off, query untouched (local-first guarantee). */
  learnedBridges?: BridgePool | null;
  /** Optional query-language override for the bridge pool (sharedRecall.language);
   *  null/absent = auto-detect the query language per recall. */
  sharedRecallLang?: SupportedLanguage | null;
  /** #165: true while the embedding circuit breaker is open — hybrid recall
   *  is silently served BM25-only (no embed attempt). Recall telemetry flags
   *  those events as embedding_degraded. Absent = no breaker (embeddings off). */
  embeddingDegraded?: () => boolean;
  /** #264: Ist der Evidenzentscheid scharf? Beim Boot aufgelöst, Default aus.
   *  Aus heißt: Der Entscheid läuft und wird geloggt, wirkt aber auf nichts. */
  evidenceGateEnabled?: () => boolean;
  /** #361: fires the turn-start embedding prewarm and reports what it did.
   *  Injected by index.ts where the provider lives; the prompt lane calls it
   *  and never awaits the embed behind it. Absent = no embedding provider. */
  prewarmEmbedding?: Prewarmer;
  /** #231 (language-first recall): the user's primary authoring language
   *  (settings `language.primary`), resolved once at daemon startup like
   *  `sharedRecallLang`. When set and ≠ "en", scoreSaveQuality advises when a
   *  save's recall_when reads as English — author triggers in the user's
   *  language, keep English tech terms as anchors. Absent = no language signal
   *  (the check never fires). */
  primaryLanguage?: string;
}
