/**
 * @bastra-recall/core — public API.
 *
 * Reusable building blocks shared by the daemon (MCP server) and the
 * Mac-app surface. No transport coupling lives here.
 */

export { Vault } from "./vault.js";
export type { VaultEvent, VaultListener } from "./vault.js";

export { SearchIndex, salienceRankCap } from "./search.js";
export type { RecallHit, RecallOptions, CueIndexOptions } from "./search.js";

export {
  normalizeQuery,
  tokenizeWithIdentifiers,
  capAtWordBoundary,
  QUERY_MAX_CHARS,
} from "./query-normalize.js";
export { PHRASE_STOPWORDS, MIN_SIGNIFICANT_TOKEN_LEN } from "./stopwords.js";
export {
  capBm25Query,
  BM25_QUERY_MAX_CHARS,
  BM25_QUERY_MAX_TERMS,
} from "./bm25-query-cap.js";
export type { DocFreqFn, Bm25QueryCap } from "./bm25-query-cap.js";
export { rareTermFuzzy, BM25_FUZZY_RARE_DF_MAX, BM25_FUZZY } from "./bm25-expansion.js";
export { groupQueryTerms, groupedTokenize, type GroupedQuery } from "./bm25-grouping.js";
export {
  estimateBm25Ms,
  lexicalFitsBudget,
  BM25_COST_BASE_MS,
  BM25_COST_PER_UNIQUE_TERM_MS,
} from "./query-cost.js";
export {
  routeRetrieval,
  type RetrievalMode,
  type RouteInput,
  type RouteDecision,
} from "./retrieval-mode.js";

export type { RecallStage, StageListener } from "./recall-stages.js";
export { RECALL_STAGE_ORDER, progressIndexFor } from "./recall-stages.js";

export { pickPhrase, pickToolPhrase, banterModeFromEnv } from "./recall-banter.js";
export type { BanterMode, BanterLang } from "./recall-banter.js";

export { saveMemory, deleteMemoryFile } from "./save.js";
export type { DeleteMemoryResult } from "./save.js";
export { SaveMemoryInput, MemoryWriteConflictError, MEMORY_WRITE_CONFLICT } from "./save-schema.js";
export type { SaveMemoryResult, SaveMemoryCommitOptions } from "./save-schema.js";
export {
  slugify,
  canonicalMemoryId,
  extractWikilinks,
  stripAutoRelatedSection,
  stripCodeSpans,
  AUTO_RELATED_START,
  AUTO_RELATED_END,
} from "./save-text.js";
export { resolveMemoryTarget } from "./save-target.js";
export type { MemoryTarget, MemoryTargetInput } from "./save-target.js";

export {
  MemoryTypeEnum,
  FrontmatterSchema,
  parseMemory,
  parseMemoryWith,
  NotAMemoryFile,
  isPathSafeComponent,
} from "./schema.js";
export type { Memory, MemoryType, Frontmatter } from "./schema.js";

export { truncateSummaryTo, clampSummary, SUMMARY_MAX } from "./summary.js";

export { buildGraph, clusterKeyFor, groupKeyFor, subKeyFor } from "./graph.js";
export type { SkillRef } from "./graph.js";
export type { VaultGraph, GraphNode, GraphEdge, GraphCluster } from "./graph.js";
export { buildSemanticLayout } from "./graph-semantic.js";
export type { SemanticLayout } from "./graph-semantic.js";

export { scrubInjectedBlocks, containsInjectedBlock, INJECTED_BLOCK_TAGS } from "./scrub.js";
export type { ScrubResult, InjectedBlockTag } from "./scrub.js";

export { detectTopics, detectProject, detectProjectDetailed, extractContentExcerpt, hookQueryVocabulary } from "./topics.js";
export type { ToolIntent, TopicResult, DetectedProject, HookQueryVocabulary } from "./topics.js";

export { isMarkdownFile } from "./markdown-file.js";
export { mutateMemoryFile } from "./memory-mutate.js";
export type { MutateOutcome, MemoryMutation } from "./memory-mutate.js";
export { readOccupant, occupantOfRaw, scanVaultForId, scanVaultForIdAsync, snapshotLocator, vaultRelative } from "./memory-locator.js";
export { withIdClaim, diskAuthority, onIdScan } from "./id-transaction.js";
export { onMutationIncident, newOperationId, reportMutationIncident } from "./mutation-incident.js";
export type { MutationIncident, MutationStatus } from "./mutation-incident.js";
export { isWeakResult, isNoHome, hitTitleMatches } from "./weak-result.js";
// #265: der Session-Assembler braucht dieselbe Abbruch-Semantik wie die Arme
// des Recalls — abandon, nicht cancel (siehe deadline.ts).
export { abandonAfter } from "./deadline.js";
// #264: der deterministische Evidenzentscheid. In core, damit BEIDE
// Recall-Pipelines und die Eval-Harness dieselbe Entscheidung treffen — §16.2
// verlangt eine zentrale Implementierung, nicht eine pro Oberfläche.
export { decideHit, decideHits, collectEvidence, MIN_TRIGGER_COVERAGE } from "./evidence-decision.js";
export type {
  RecallDecision,
  RecallDecisionHit,
  RecallEvidence,
  AbstainReason,
  DecisionInput,
} from "./evidence-decision.js";
export {
  cueSidecarPath,
  cueSourceFingerprint,
  parseCueRecord,
  projectCues,
  loadCueProjection,
  describeCueProjection,
} from "./cue-sidecar.js";
export {
  buildCuePrompt,
  parseCueCandidates,
  confidenceFromRank,
  generateCuesFor,
  generateCueBatch,
  cueToJsonl,
  CUE_PROMPT_VERSION,
  CUE_GENERATOR_VERSION,
} from "./cue-generate.js";
export type { CueBatchOptions, CueBatchReport, CueSelfTest } from "./cue-generate.js";
export type {
  CueFamily,
  DerivedCue,
  CueProjection,
  CueRejection,
  CueRejectionReason,
  CueStale,
  CueTargetSource,
} from "./cue-sidecar.js";
export {
  areaKeyForPath,
  assertAreaWritable,
  clearAreaMark,
  markAreaDeleted,
  markAreaRenamed,
  readAreaMark,
  withAreaExclusive,
  withAreaShared,
} from "./area-claim.js";
export type { AreaMark } from "./area-claim.js";
export type { IdAuthority, IdClaim, IdClaimOptions, IdScanObservation } from "./id-transaction.js";
export type { IdScanStats } from "./memory-locator.js";
export type { Occupant, Located, MemoryLocator } from "./memory-locator.js";
export { sameFile, assertInsideVault, assertInsideDir, assertOwnSubdir, realpathOfNearestExisting } from "./file-identity.js";
export { normalizeScopeKey, scopeEquals, isScopeCompatible, GLOBAL_SCOPES } from "./scope.js";

export {
  AuditLog,
  trashPathFor,
  latestTrashPathFor,
  // Codex-Gegenreview (P0): Hier standen `moveToTrash` und `restoreFromTrash`
  // als nackte Primitiven. Zwei parallele direkte `moveToTrash()`-Aufrufe mit
  // derselben id meldeten beide Erfolg, und im Trash lag nur eine der beiden
  // Fassungen — erreichbar über die öffentliche Core-API, ohne jede
  // Transaktion. Nach außen geht deshalb nur noch die claim-bewusste Fassung:
  // Wer sie ruft, muss einen `IdClaim` in der Hand haben.
  moveToTrashUnderClaim,
} from "./audit-log.js";
export type { AuditEntry, AuditOperation, AuditActor } from "./audit-log.js";
export {
  CONFLICT_START,
  CONFLICT_END,
  hasUnresolvedConflict,
  renderConflictBlock,
  type ConflictClaim,
} from "./conflict.js";

export {
  AuditContext,
  auditedSave,
  auditedSoftDelete,
  auditedRestore,
} from "./audit-save.js";

export { assertLocalOrOptIn } from "./ollama-egress.js";

export {
  EmbeddingIndex,
  OpenAIEmbeddingProvider,
  OllamaEmbeddingProvider,
  fuseRRF,
  RRF_K,
  RRF_SCALE,
} from "./embeddings.js";
export type { EmbeddingProvider, EmbeddingHit, EmbedListener, EmbeddingRuntimeHealth } from "./embeddings.js";

export { EmbedCache, hashEmbedContent } from "./embed-cache.js";
export type { EmbedCacheEntry, EmbedCacheFile } from "./embed-cache.js";

export { RelatedEnricher } from "./related-enrich.js";
export type { RelatedEnricherOptions } from "./related-enrich.js";

export { TriggerExpander, buildExpandPrompt, parseExpansions, sourceHash } from "./trigger-expand.js";
export {
  scanForInjection,
  injectionCategories,
  formatInjectionAdvisory,
  MAX_FINDINGS as INJECTION_MAX_FINDINGS,
  type InjectionCategory,
  type InjectionFinding,
} from "./injection-scan.js";
export type { TriggerExpanderOptions, ChatFn, SelfTestFn } from "./trigger-expand.js";
