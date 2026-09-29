/**
 * /hook/recall — the optional content recall on the tool input excerpt
 * (BASTRA_HOOK_CONTENT_RECALL), merged into the prompt recall's hits only when
 * both lists live in the same score space (split out of http-hook-routes.ts,
 * #680).
 */
import type { RecallHit, RecallStage, SearchIndex } from "@bastra-recall/core";
import { envBool } from "./env.js";
import { mergeHookRecallHits } from "./hook-recall-merge.js";

const CONTENT_RECALL_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export interface ContentRecallInput {
  body: Record<string, unknown>;
  search: SearchIndex;
  hookToolName: string | null;
  query: string;
  hits: RecallHit[];
  k: number;
  scope: string | undefined;
  type: string | undefined;
  expand_hops: 0 | 1;
  skipDense: boolean;
  vectorDeadlineMs: number;
  embeddingDegradedAtRecall: boolean;
  promptFused: boolean;
}

/** Runs the content recall when enabled and returns the (possibly merged) hits
 *  plus the `content_recall` telemetry summary (undefined when it did not run). */
export async function runContentRecall(input: ContentRecallInput) {
  const {
    body, search, hookToolName, query, k, scope, type, expand_hops, skipDense,
    vectorDeadlineMs, embeddingDegradedAtRecall, promptFused,
  } = input;
  let hits = input.hits;
  const contentQuery = typeof body.tool_input_excerpt === "string"
    ? body.tool_input_excerpt.trim().slice(0, 4096)
    : "";
  let contentRecall:
    | {
        hit_count: number;
        added_count: number;
        rescored_count: number;
        latency_ms: number;
        failed?: boolean;
        skipped_score_space?: true;
      }
    | undefined;
  if (
    envBool("BASTRA_HOOK_CONTENT_RECALL", false)
    && CONTENT_RECALL_TOOLS.has(hookToolName ?? "")
    && contentQuery
    && contentQuery !== query
  ) {
    const contentRecallStarted = Date.now();
    try {
      // Codex-Gegenreview: Der Content-Recall ist ein EIGENER Recall und
      // degradiert unabhängig — sein Vektor-Arm kann in die Deadline laufen,
      // während der Prompt-Recall fusioniert hat. Sein Degradations-Grund
      // ging bisher verloren (kein onStage), und der Score-Modus wurde nur
      // aus dem ERSTEN Recall abgeleitet. Ergebnis: rohe BM25-Werte, in eine
      // RRF-Liste einsortiert und als „rrf" gemeldet.
      let contentDegradedReason: string | undefined;
      const collectContentStage = (st: RecallStage): void => {
        if (st.name === "done" && typeof st.meta?.degraded === "string") {
          contentDegradedReason = st.meta.degraded;
        }
      };
      // #494: Derselbe Verzicht wie oben. Ein Content-Recall mit dichtem
      // Arm neben einem Prompt-Recall ohne wäre genau die Last, die
      // `lexical_only` vermeiden soll — und das Merge-Gate darunter würde
      // ihn wegen des Skalenbruchs ohnehin verwerfen.
      const contentHits = search.hasEmbeddings() && !skipDense
        ? await search.recallHybrid(contentQuery, {
            k,
            scope,
            type,
            expand_hops,
            onStage: collectContentStage,
            // Same deadline, not a remaining-budget split: by the time this
            // runs the query recall above has either warmed the model (so
            // this costs ~120ms) or is still loading it (so this expires
            // too and degrades the same way). Both are the right outcome.
            vector_deadline_ms: vectorDeadlineMs,
          })
        : search.recall(contentQuery, {
            k,
            scope,
            type,
            expand_hops,
          });
      const contentFused =
        search.hasEmbeddings() && !embeddingDegradedAtRecall && contentDegradedReason === undefined;
      if (contentFused !== promptFused) {
        // Fail-closed: Die beiden Listen liegen in verschiedenen Räumen, und
        // „der höhere Score gewinnt" heißt dann nur „die Skala ohne
        // Obergrenze gewinnt". Der Content-Arm fällt weg, statt die
        // fusionierte Liste zu verunreinigen — die servierten Zahlen kommen
        // dann alle aus dem Prompt-Recall und `score_kind` beschreibt sie.
        contentRecall = {
          hit_count: contentHits.length,
          added_count: 0,
          rescored_count: 0,
          latency_ms: Date.now() - contentRecallStarted,
          skipped_score_space: true,
        };
      } else {
        const queryHitsById = new Map(hits.map((hit) => [hit.id, hit]));
        const contentHitsById = new Map(contentHits.map((hit) => [hit.id, hit]));
        const mergedHits = mergeHookRecallHits(hits, contentHits, k);
        contentRecall = {
          hit_count: contentHits.length,
          added_count: mergedHits.filter((hit) => !queryHitsById.has(hit.id)).length,
          rescored_count: mergedHits.filter((hit) => {
            const queryHit = queryHitsById.get(hit.id);
            const contentHit = contentHitsById.get(hit.id);
            return queryHit !== undefined
              && contentHit !== undefined
              && contentHit.score > queryHit.score;
          }).length,
          latency_ms: Date.now() - contentRecallStarted,
        };
        hits = mergedHits;
      }
    } catch {
      contentRecall = {
        hit_count: 0,
        added_count: 0,
        rescored_count: 0,
        latency_ms: Date.now() - contentRecallStarted,
        failed: true,
      };
    }
  }
  return { hits, contentRecall };
}
