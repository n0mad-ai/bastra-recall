/**
 * UserPromptSubmit lane — the search stage and the hint selection (#1511,
 * split out of `runPromptLaneInner`). In the order the lane runs them:
 *
 *   1. classify the prompt and start the reflex self-call;
 *   2. read the session snapshot and start the change-impact answer;
 *   3. decide whether the recall can contribute at all (#371) and run it;
 *   4. pick, from what came back, the hits this prompt may inject: score
 *      floors per mode, session dedup of reflex and recall hits, scope filter.
 *
 * The order of the awaits is the lane's timing contract and stays exactly as
 * it was in the single function: the reflex call and the impact answer overlap
 * the recall, and the session snapshot is read before the recall.
 */
import { applyLaneScopeFilter, projectForFilter, projectForLane, type LaneScopeFilterResult } from "./scope-filter.js";
import { envFirst, envInt } from "./env.js";
import { PROMPT_ASSERTION_BUDGET_MS, RECALL_BUDGET_MS } from "./hook-budgets.js";
import { hookCaller } from "./hook-surface.js";
import { governContext } from "./context-governor.js";
import { deliverPromptImpact, NO_PROMPT_IMPACT, type DeliveredPromptImpact } from "./code-graph/prompt-impact.js";
import { getLoadedMarkerMtime, loadSessionState, shouldDropHit, type ReadonlySessionState } from "./session-state.js";
import {
  MUST_LOAD_SCORE,
  SCORE_FLOOR,
  classifyPromptMode,
  detectPreviousConvention,
  effectiveScoreFloor,
  type ClaudeHookPayload,
  type DetectedMode,
} from "./prompt-classify.js";
import type { PromptReflexHit, RecallHit } from "./prompt-format.js";
import { postJson } from "./prompt-loopback.js";

// Per trigger class since #305 — see hook-budgets.ts for the measurement.
// 600ms for the quiet classes, 1000ms for assertion: that lane sits at the
// start of a turn, pays a cold embedding model by construction, and was being
// cut off on 23.4% of its calls against the flat 600ms. `BASTRA_HOOK_TIMEOUT_MS`
// still overrides, for the classes that had it.
const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", RECALL_BUDGET_MS, "NEXUS_HOOK_TIMEOUT_MS");
export function laneBudgetMs(mode: DetectedMode): number {
  return mode === "assertion" ? PROMPT_ASSERTION_BUDGET_MS : HOOK_TIMEOUT_MS;
}

/**
 * "all" (default since #677) — every non-trivial prompt recalls, and what a
 * prompt the lookup/assertion cues do not recognise may inject is gated by
 * score (MUST_LOAD_SCORE), not by the language it is written in. Those cues
 * cover a few languages (lexicon.ts): a contributor's month had 0 of 1,039
 * prompts recognised as a lookup (#671), so under the old default a user
 * writing any other language got a silent lane. "retrieval-only" keeps the
 * pre-#677 behaviour (cue-gated recall) as an explicit opt-out.
 */
type PromptHookMode = "retrieval-only" | "all";
const hookMode = (): PromptHookMode =>
  envFirst("BASTRA_PROMPT_HOOK_MODE") === "retrieval-only" ? "retrieval-only" : "all";

export interface RecallResponse {
  hits: RecallHit[];
  /** 20.08.: reflex-wired memories from the deeper candidate pool that the
   *  top-k cut left out — same lean shape, filtered by the same floors. */
  reflex_hits?: RecallHit[];
  vault_size: number;
  latency_ms: number;
  recall_id: string;
  /** #249: no returned hit lexically anchors — the top score is rank-1-of-
   *  nothing. Absent means "not weak". */
  weak_result?: boolean;
  /** #230: stricter subset of weak_result — the fact has no home in this vault. */
  no_home?: boolean;
  /**
   * #302/P0: RRF lief NICHT — der Vector-Arm fehlte, lief in seine Deadline
   * oder fiel aus, und `score` trägt rohe MiniSearch-Werte statt der fusionierten
   * Skala. Die sind nach oben offen (sechsstellig auf einem echten Vault), also
   * beschreiben die Floors 50/100 dort gar nichts.
   *
   * Die Lane las das Feld bisher nicht und maß rohe Werte trotzdem an
   * MUST_LOAD_SCORE: alles wurde REQUIRED, umging den Backoff und wurde als
   * „beide Suchpfade waren sich einig" angekündigt, während nur einer lief.
   */
  unfused?: boolean;
  /** Codex-Gegenreview: Kennt der VAULT den mitgeschickten Projektnamen als
   *  Scope (oder Familienmitglied)? Nur der Daemon kann das beantworten — die
   *  Lane sieht den Vault nicht. `false` heißt: nicht filtern. */
  project_known?: boolean;
  /** #342: warum die Fusion ausfiel — `vector-arm-timeout` | `vector-arm-error`
   *  | `vector-arm-empty`. Trennt „diese Maschine degradiert gerade" von
   *  „Embeddings sind hier aus". */
  degraded?: string;
  /** #702: ids of the learned bridges whose trigger matched the query. */
  bridges_fired?: string[];
}

interface ReflexResponse {
  hits: PromptReflexHit[];
  recall_id: string | null;
}

export type RecallStatus = "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error";
export type RecallSkipped = "reflex-pool-empty" | "reflex-all-suppressed";

/** What the search stage hands to the rest of the lane. */
export interface PromptSearch {
  detectedMode: DetectedMode;
  forcedRetrieval: boolean;
  cwd: string;
  project: string | null;
  filterProject: string | null;
  state: ReadonlySessionState;
  impactPromise: Promise<DeliveredPromptImpact>;
  recallSkipped: RecallSkipped | undefined;
  resp: RecallResponse | null;
  status: RecallStatus;
  errMsg: string | null;
  reflexResp: ReflexResponse | null;
}

export interface PromptSearchInput {
  payload: ClaudeHookPayload;
  prompt: string;
  selfBaseUrl: string;
  clientEvidence: string;
  replay: boolean;
  startedAt: number;
  reflexPool?: () => string[];
}

/** Stages 1–3: classify, start the side calls, recall (or skip it, #371). */
export async function runPromptSearch(input: PromptSearchInput): Promise<PromptSearch> {
  const { payload, prompt, selfBaseUrl } = input;
  const detectedMode = classifyPromptMode(prompt, hookMode());
  const forcedRetrieval = detectPreviousConvention(prompt);

  const cwd = payload.cwd ?? process.cwd();
  // §20.5: geratene Erkennung = kein Projekt (projectForLane) — sonst fragt
  // die Lane Kandidaten für ein erfundenes Projekt ab und schreibt dessen
  // Namen als `project=` in den Block.
  const project = projectForLane(cwd);
  // §20.5: geratenes Projekt filtert nicht — siehe projectForFilter.
  const filterProject = projectForFilter(cwd);
  const remainingMs = Math.max(50, laneBudgetMs(detectedMode) - (Date.now() - input.startedAt));

  // #217 Reflex-Lane: feuert unabhängig vom Retrieval-Gate — auch bei
  // detectedMode "none". Parallel zum bedingten Recall, sonst sprengt die
  // Serialisierung das Budget. Fehler → still keine Reflex-Hits.
  const reflexPromise: Promise<ReflexResponse | null> = postJson<ReflexResponse>(
    selfBaseUrl,
    "/hook/reflex",
    { context: prompt, project, session_id: payload.session_id ?? null, client: input.clientEvidence },
    remainingMs
  ).catch(() => null);

  const state = await loadSessionState(payload.session_id ?? "");

  // #606: a change-impact question gets the graph's answer delivered before
  // the first search runs. Started here so it overlaps the recall; gated twice
  // (phrasing, then resolution against the graph) inside, so an ordinary
  // prompt costs one regex pass and nothing else.
  const impactPromise = input.replay
    ? Promise.resolve(NO_PROMPT_IMPACT)
    : deliverPromptImpact({
        prompt,
        cwd,
        sessionId: payload.session_id ?? null,
        session: state,
      });

  const recallSkipped = await recallSkipReason(detectedMode, input.reflexPool, state);
  // Mode "none" no longer skips the recall (19.08. incident): a reflex-wired
  // convention ("Nachrichtenkonvention", salience 0.9) never surfaced while a
  // message was being drafted — the hard token-AND of the reflex lane cannot
  // survive German inflection ("entwirfst" vs "entwerfen"), and the hybrid
  // recall that DOES understand it never ran on ordinary work prompts. Now it
  // runs on every non-trivial prompt; what may inject in mode "none" is
  // filtered below to user-wired reflex memories at REQUIRED strength.
  // #371 narrowed "every non-trivial prompt" to "every non-trivial prompt on
  // which a wired memory could actually be injected" — see recallSkipReason.
  //
  // A skipped recall reports the same outcome the filter would have produced,
  // without the search: no hits, and the status the telemetry series already
  // carries for this case (`resp` stays null, so the later `no-hits` rule
  // cannot fire).
  const recall =
    recallSkipped !== undefined
      ? { resp: null, status: "no-hits" as const, errMsg: null }
      : await callRecall(payload, prompt, project, detectedMode, selfBaseUrl, remainingMs);
  const reflexResp = await reflexPromise;
  return {
    detectedMode,
    forcedRetrieval,
    cwd,
    project,
    filterProject,
    state,
    impactPromise,
    recallSkipped,
    ...recall,
    reflexResp,
  };
}

/**
 * #371: in mode "none" the recall can only ever contribute a memory that
 * the user wired as `recall_mode: reflex` (the filter below) and that this
 * session has not already shown inside the 4h window (the dedup further
 * down). Both questions are independent of the query and answerable in
 * microseconds — the vault index and the session-state file are already in
 * hand. Asked BEFORE the recall they turn ~210ms of full-vault hybrid search
 * into nothing on exactly the prompts whose result was going to be thrown
 * away. Measured on the 19.–24.08. log: 91% of prompts run in mode "none",
 * 83.5% of those inject nothing, and 10.9% ran inside a window in which
 * every wired memory was already suppressed.
 *
 * What this deliberately is NOT: a restriction of the recall's CANDIDATE
 * SPACE to the wired pool. The floor of 50 in mode "none" means "top 4 of an
 * arm over the WHOLE vault" — RRF_SCALE/(RRF_K + rank) ≥ 50 ⇔ rank ≤ 4 —
 * and ranked against a two-document pool every wired memory scores 70–164 by
 * construction, so the gate would stop gating and both conventions would
 * inject on the first prompt of every 4h window instead of on the prompt
 * they belong to (#371). The recall that still runs here is byte-identical
 * to the one that ran before; only whether it runs at all is new.
 *
 * #1306: during a correspondence task the existing recall can identify a
 * new topic outside the conventions in force. A recall miss alone keeps
 * the task active; no second search is added for task tracking.
 */
async function recallSkipReason(
  detectedMode: DetectedMode,
  reflexPool: (() => string[]) | undefined,
  state: ReadonlySessionState
): Promise<RecallSkipped | undefined> {
  const taskInProgress = (state.activeTask?.kind ?? "none") !== "none";
  if (detectedMode !== "none" || !reflexPool || taskInProgress) return undefined;
  const wired = reflexPool();
  if (wired.length === 0) return "reflex-pool-empty";
  for (const id of wired) {
    if (!shouldDropHit(state.shown[id], await getLoadedMarkerMtime(id))) return undefined;
  }
  return "reflex-all-suppressed";
}

/** The loopback recall; transport failures map onto the telemetry vocabulary. */
async function callRecall(
  payload: ClaudeHookPayload,
  prompt: string,
  project: string | null,
  detectedMode: DetectedMode,
  selfBaseUrl: string,
  remainingMs: number
): Promise<{ resp: RecallResponse | null; status: RecallStatus; errMsg: string | null }> {
  try {
    const resp = await postJson<RecallResponse>(
      selfBaseUrl,
      "/hook/recall",
      {
        query: prompt,
        project,
        // For "generic" mode we only show top-tier hits, so request fewer (k=3).
        k: detectedMode === "generic" ? 3 : 5,
        tool_name: "UserPromptSubmit",
        // #445: die Lane weist sich aus — wie bash-pre/bash-fail seit #263.
        // Ohne die Felder liest der Empfänger `unknown/unknown`.
        ...hookCaller(payload),
        hook_source: "prompt",
      },
      remainingMs
    );
    return { resp, status: "ok", errMsg: null };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // Self-call on the own server: connection-class errors cannot really
    // mean "daemon down" anymore, but the status vocabulary stays — the
    // telemetry series must remain comparable across the migration.
    if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "EHOSTUNREACH") {
      return { resp: null, status: "daemon-unreachable", errMsg: null };
    }
    if (e.message === "timeout") return { resp: null, status: "timeout", errMsg: null };
    return { resp: null, status: "error", errMsg: e.message ?? String(err) };
  }
}

/** Stage 4's result: the hits this prompt may inject, and what was held back. */
export interface PromptHintSelection {
  recallHits: RecallHit[];
  rawReflexHits: PromptReflexHit[];
  reflexKept: PromptReflexHit[];
  /** #565: reflex hits the session dedup held back. */
  reflexDeduped: string[];
  scopeFilter: LaneScopeFilterResult<RecallHit>;
  status: RecallStatus;
}

/** Stage 4: score floors, session dedup of reflex and recall hits, scope filter. */
export async function selectPromptHints(search: PromptSearch): Promise<PromptHintSelection> {
  const { resp, state } = search;
  const filtered = resp && Array.isArray(resp.hits) ? filterByFloor(resp, search.detectedMode) : [];

  // #217: Session-Dedup für Reflex-Hits (max 1×/4h pro Memory, wie hook.ts).
  // Danach id-Dedup gegen die Recall-Liste — Reflex ist das vom User
  // verdrahtete, stärkere Signal und behält den Hit.
  const rawReflexHits: PromptReflexHit[] = Array.isArray(search.reflexResp?.hits) ? search.reflexResp.hits : [];
  // #266: dieselbe Entscheidung wie in der Bash-Lane, über denselben Governor.
  // Was „bereits gezeigt" heißt, bleibt bei `shouldDropHit` (4h-Fenster,
  // MAX_SHOW, Load-Marker); ohne Budget aufgerufen, weil diese Lane heute
  // keines hat — Mechanik vereinheitlichen, nicht verschärfen.
  const reflexKeptIds = await keptBySessionDedup(rawReflexHits, state);
  const reflexKept: PromptReflexHit[] = rawReflexHits.filter((h) => reflexKeptIds.has(h.id));
  // #565: der eine Reflex-Miss, den die hook_reflex-Zeile nicht sehen kann —
  // der Trigger hat gefeuert, der Session-Dedup hat den Hit einbehalten.
  const reflexDeduped = rawReflexHits.filter((h) => !reflexKeptIds.has(h.id)).map((h) => h.id);
  const reflexIds = new Set(reflexKept.map((h) => h.id));
  let recallHits = filtered.filter((h) => !reflexIds.has(h.id));
  // Per-memory session dedup for ordinary recall hits, in EVERY detected mode
  // (#541). It started as the semantic-reflex guard of mode "none" (zzalli's
  // context-contamination report, 19.08.): the same wired convention must not
  // re-inject on every drafting prompt of a session. The other hint modes were
  // left "backoff-governed as before" — but the backoff governs the source's
  // cadence, not the repetition of one memory, and REQUIRED-band hits bypass it
  // entirely. Measured over 2026-09-04→09-12: in `assertion` mode 811 first
  // injections against 832 re-injections of text still standing in the same
  // transcript, ~86k est. tokens, 10.4% of the whole context tax. Write lane
  // and bash-pre lane apply this pair unconditionally and show 8.5% / 1.6%.
  // #354's principle: a hint already in the transcript buys nothing by being
  // repeated. Reset stays by signal — the load marker, and `clearShown` on
  // compact/clear (#509: not resume) — never by timer.
  const keptIds = await keptBySessionDedup(recallHits, state);
  recallHits = recallHits.filter((h) => keptIds.has(h.id));

  // §20.5: Diese Lane filterte nie nach Projekt-Scope — fremde Treffer kamen
  // durch, während Write-Lane und SessionStart seit #110 hart filtern. Der
  // Filter läuft hier zuerst im SHADOW-Modus: er misst, was er verwerfen
  // würde, und verwirft nichts. Die Anker-Ausnahme bleibt (ein hand-
  // geschriebener Trigger aus einem anderen Projekt IST eine Absicht),
  // Reflex-Treffer sind ausgenommen, und ohne Fusion ist die Ausnahme zu.
  const scopeFilter = applyLaneScopeFilter(recallHits, search.filterProject, {
    allowAnchoredCrossScope: true,
    mustLoadScore: MUST_LOAD_SCORE,
    unfused: resp?.unfused === true,
    exemptReflex: true,
    projectKnown: resp?.project_known,
  });
  recallHits = scopeFilter.hits;
  // `no-hits` once nothing survived the floors — and again after the scope
  // filter (Codex-Gegenreview): if it removes everything in enforce mode, the
  // telemetry must not keep reporting "ok" for zero injected hits, or the
  // series could not tell the filter from a silent recall, which is exactly
  // what the shadow mode is there to show. The floor result is a superset of
  // what survives the filter, so one check after it covers both.
  const status = resp && recallHits.length === 0 ? "no-hits" : search.status;
  return { recallHits, rawReflexHits, reflexKept, reflexDeduped, scopeFilter, status };
}

/** The ids `governContext` keeps once already-shown hits are dropped. */
async function keptBySessionDedup(
  hits: Array<{ id: string; summary?: string }>,
  state: ReadonlySessionState
): Promise<Set<string>> {
  const governed = governContext(
    await Promise.all(
      hits.map(async (h, i) => ({
        id: h.id,
        priority: i,
        text: h.summary ?? "",
        alreadyShown: shouldDropHit(state.shown[h.id], await getLoadedMarkerMtime(h.id)),
      }))
    ),
    {}
  );
  return new Set(governed.kept.map((g) => g.id));
}

/** The score floors per detected mode; reflex hits from below the top-k cut ride along. */
function filterByFloor(resp: RecallResponse, detectedMode: DetectedMode): RecallHit[] {
  const effectiveFloor = effectiveScoreFloor(detectedMode);
  const unfused = resp.unfused === true;
  // Wired reflex memories ride along from below the top-k cut (20.08.: the
  // convention sat at pool rank 6 behind k=5). They pass the same floor.
  const candidates = [...resp.hits, ...(Array.isArray(resp.reflex_hits) ? resp.reflex_hits : [])];
  return candidates.filter((h) => {
    const wired = h.recall_mode === "reflex";
    // #677: "generic" replaced "none" as the default for unrecognised
    // prompts, so it must not lose what "none" delivered — a user-wired
    // reflex memory keeps the normal floor there (the 19.08. prompt ranked
    // the convention at 84, see below).
    const floor = detectedMode === "generic" && wired ? SCORE_FLOOR : effectiveFloor;
    if (h.score < floor) return false;
    // #677: the generic gate IS the score — on the unfused scale (raw BM25,
    // open-ended) MUST_LOAD_SCORE says nothing, and passing everything
    // would inject the top k on every prompt exactly while the vector arm
    // is down. Without fusion only wired memories inject, as in "none".
    if (detectedMode === "generic" && unfused && !wired) return false;
    // Without fusion the floor reads a raw BM25 number, and short function
    // words shared with a wired memory's body ("la", "de", "los") push it
    // over — in the languages whose articles are long enough to count. A
    // wired memory outside an explicit question then needs its own
    // triggers anchored by the prompt (two content words or a rare
    // identifier, search.ts anchorStrength): evidence, not a raw score.
    if (unfused && wired && detectedMode !== "retrieval" && h.anchor_strength !== "strong") return false;
    // Semantic reflex: in mode "none" only memories the USER wired as
    // reflex may inject — the semantic arm gives them hearing beyond
    // literal token matches. Deliberately at the normal floor, not
    // MUST_LOAD_SCORE: the 19.08. real prompt ranked the wired convention
    // at 84 (a long convoluted prompt dilutes the rank), and the pool is
    // tiny and explicitly authorized — the wiring is the noise gate, the
    // backoff still dampens sub-REQUIRED repeats.
    return detectedMode !== "none" || wired;
  });
}
