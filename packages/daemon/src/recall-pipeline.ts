/**
 * #421: Die Auswahlschritte, die BEIDE Recall-Pipelines teilen.
 *
 * Bis hierher gab es zwei Pipelines mit verschiedener Trefferauswahl: Die
 * Hook-Pipeline (`runHookRecall`) lieferte Reflex-Hits aus dem tieferen
 * Kandidatenpool, und die Prompt-Lane wandte danach den Projekt-Scope-Filter
 * an (#110/#148). Der MCP-Weg bekam beides nicht — der Forwarder warf die
 * `reflex_hits` in seiner Projektion weg und schickte kein Projekt, und der
 * `recallHandler` kannte weder Pool-Reflexe noch Scope-Filter. Ein Client ohne
 * Hooks sah auf derselben Frage eine andere Auswahl als ein Hook-Nutzer.
 *
 * Hier stehen die beiden Schritte EINMAL. Beide Pipelines rufen sie; was sich
 * unterscheidet, sind Parameter (Floor, ob ein Aufrufer-Projekt vorliegt) —
 * nicht der Code.
 */
import type { RecallHit, Vault } from "@bastra-recall/core";
import { truncateSummary } from "./recall-handler.js";
import { applyLaneScopeFilter, laneScopeFilterMode, vaultKnowsProject, type ScopeFilterMode } from "./scope-filter.js";
import { MUST_LOAD_SCORE } from "./prompt-lane.js";

/** Ein Reflex-Treffer aus dem Kandidatenpool, in der Form, die
 *  `/hook/recall` seit 20.08. als `reflex_hits` liefert. */
export interface PoolReflexHit {
  id: string;
  title: string;
  type: string;
  scope: string;
  summary: string;
  score: number;
  matched_recall_when: false;
  recall_mode: "reflex";
}

/**
 * Vom Nutzer als `recall_mode: reflex` verdrahtete Memories aus dem tieferen
 * Kandidatenpool, die der top-k-Schnitt ausgelassen hat (20.08.: die
 * verdrahtete Konvention stand auf Poolrang 6 hinter k=5).
 *
 * `minScore` ist der Floor des Aufrufers: Der Hook-Weg reicht 0 (die Lanes
 * wenden ihren eigenen Floor an, unverändert seit 20.08.), der MCP-Weg seinen
 * `min_score` — ein Reflex-Treffer passiert denselben Floor wie die
 * gerankten Treffer derselben Antwort.
 */
export function collectPoolReflexHits(
  candidatePool: ReadonlyArray<{ id: string; score: number }>,
  servedIds: ReadonlySet<string>,
  vault: Pick<Vault, "get">,
  minScore = 0,
): PoolReflexHit[] {
  return candidatePool.flatMap((c) => {
    if (servedIds.has(c.id) || c.score < minScore) return [];
    const mem = vault.get(c.id);
    if (mem?.fm.recall_mode !== "reflex") return [];
    return [{
      id: c.id,
      title: mem.fm.title,
      type: mem.fm.type,
      scope: mem.fm.scope,
      summary: truncateSummary(mem.fm.summary),
      score: c.score,
      matched_recall_when: false as const,
      recall_mode: "reflex" as const,
    }];
  });
}

/** Warum der Scope-Filter für einen Aufruf nicht lief. `explicit-scope`: Der
 *  Aufrufer hat selbst einen Scope verlangt — die Suche ist dann bereits auf
 *  ihn beschränkt, und ein Projektfilter würde genau das Verlangte verwerfen. */
export type CallerScopeFilterSkip = "no-project" | "no-scope-evidence" | "explicit-scope";

/** Die Telemetriefelder des Filters — dieselben Namen wie in der
 *  `prompt_hook_call`-Zeile der Prompt-Lane, damit eine Auswertung beide
 *  Oberflächen nebeneinander lesen kann. */
export interface CallerScopeFilterTelemetry {
  scope_filter_mode: ScopeFilterMode;
  dropped_scope_count: number;
  dropped_scopes?: string[];
  filter_project: string | null;
  scope_filter_skipped?: CallerScopeFilterSkip;
}

/**
 * Der Projekt-Scope-Filter der Prompt-Lane, angewandt auf die Treffer eines
 * Aufrufers, der sein Projekt mitbringt (#421).
 *
 * Dieselben Parameter wie die Prompt-Lane (`prompt-lane.ts`, §20.5): die
 * Anker-Ausnahme bleibt offen (ein hand-geschriebener Trigger aus einem
 * anderen Projekt ist eine Absicht), Reflex-Treffer sind ausgenommen, ohne
 * Fusion ist die Ausnahme zu, und `project_known` kommt aus dem Vault.
 * Derselbe Schalter auch: `BASTRA_SCOPE_FILTER_LANES` — `shadow` (Default)
 * misst, was verworfen würde, und verwirft nichts; `enforce` verwirft. Ein
 * MCP-Client bekommt also genau die Filterstufe, die ein Hook-Nutzer bekommt,
 * und scharf wird sie für beide mit derselben Entscheidung.
 *
 * Arbeitet auf den ROHEN Treffern, vor der Projektion: Der Filter braucht
 * `matched_recall_when` und `anchor_strength`, die die schlanke MCP-Form nicht
 * trägt, und `recall_mode` aus dem Vault.
 */
export function applyCallerScopeFilter<H extends Pick<RecallHit, "id" | "scope" | "score" | "matched_recall_when" | "anchor_strength">>(
  hits: H[],
  opts: {
    /** Das Projekt des Aufrufers, bereits durch das Konfidenz-Gate
     *  (`projectForFilter`) — `null` heißt: kein belastbares Projekt. */
    project: string | null;
    /** Hat der Aufrufer selbst einen `scope` verlangt? */
    explicitScope: boolean;
    unfused: boolean;
    vault: Pick<Vault, "get" | "list">;
    mode?: ScopeFilterMode;
  },
): { hits: H[]; telemetry: CallerScopeFilterTelemetry } {
  const mode = opts.mode ?? laneScopeFilterMode();
  if (opts.explicitScope) {
    return {
      hits,
      telemetry: {
        scope_filter_mode: mode,
        dropped_scope_count: 0,
        filter_project: null,
        scope_filter_skipped: "explicit-scope",
      },
    };
  }
  const tagged = hits.map((hit) => ({
    hit,
    scope: hit.scope,
    score: hit.score,
    matched_recall_when: hit.matched_recall_when,
    anchor_strength: hit.anchor_strength,
    recall_mode: opts.vault.get(hit.id)?.fm.recall_mode,
  }));
  const result = applyLaneScopeFilter(
    tagged,
    opts.project,
    {
      allowAnchoredCrossScope: true,
      mustLoadScore: MUST_LOAD_SCORE,
      unfused: opts.unfused,
      exemptReflex: true,
      projectKnown: opts.project ? vaultKnowsProject(opts.vault, opts.project) : undefined,
    },
    mode,
  );
  return {
    hits: result.hits.map((t) => t.hit),
    telemetry: {
      scope_filter_mode: result.mode,
      dropped_scope_count: result.droppedCount,
      ...(result.droppedScopes.length > 0 ? { dropped_scopes: result.droppedScopes } : {}),
      filter_project: result.filterProject,
      ...(result.skipped ? { scope_filter_skipped: result.skipped } : {}),
    },
  };
}
