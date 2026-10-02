/**
 * UserPromptSubmit lane, daemon-side (#343/#15 — stage A of #305 direction 2).
 *
 * This is the pipeline that lived in `prompt-hook.ts` (#33/#252/#217/#151),
 * moved server-side verbatim: mode detection, trivial gate, recall + reflex
 * self-calls, session dedup/backoff, formatting, telemetry. The hook file is
 * now a thin client — stdin → POST /hook/prompt → stdout — so the per-prompt
 * cost on the client side is process start alone (#305 measured ~120ms of
 * node spawn against the fast lanes' 200ms p90 target; the logic itself was
 * never the problem). Budgets are per lane since #305 — see hook-budgets.ts.
 *
 * Two deliberate non-changes, so stage A stays "require-path rewiring, not a
 * rewrite":
 *  - Recall and reflex remain LOOPBACK SELF-CALLS to /hook/recall and
 *    /hook/reflex on this same server (~1-3ms). Collapsing them into direct
 *    function calls would change what the hook_call telemetry series measures
 *    mid-migration; that optimisation can land once the lane is stable.
 *  - Session state stays on the FILE BUS (session-state.ts), exactly as
 *    tool-handlers.ts already uses it from the daemon. Single-writer collapse
 *    is explicitly out of scope for stage A (see #343).
 *
 * The one thing that could not move verbatim: `claudeSessionPid()` walks the
 * process tree FROM THE HOOK — the daemon is not in that tree. The thin
 * client ships its own `client_ppid`, and the walk runs here, once per ppid,
 * cached (a ppid's ancestor chain never changes while it lives). This also
 * deletes a hidden per-call cost: the old hook paid one `ps` exec on every
 * single prompt.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { applyLaneScopeFilter, projectConfidence, projectForFilter, projectForLane } from "./scope-filter.js";

import { envFirst, envInt } from "./env.js";
import { PROMPT_ASSERTION_BUDGET_MS, RECALL_BUDGET_MS } from "./hook-budgets.js";
import { recordBudgetShadow } from "./session-budget.js";
import { claudeSessionPidFrom, sessionFeedPath, STATUSLINE_DIR } from "./statusline-session.js";
import { idleStatuslineState } from "./statusline-feed.js";
import { reportHinted } from "./hook-hinted.js";
import { hookCaller, hookClient, hookAgent, hookClientEvidence } from "./hook-surface.js";
import { ownerPromptText } from "./system-turn.js";
import { governContext } from "./context-governor.js";
import { deliverPromptImpact } from "./code-graph/prompt-impact.js";
import { getPromptImpactEnabled } from "./code-graph/prompt-impact-settings.js";
import { repoRootSync } from "./code-graph/git-paths.js";
import { logDeliveredBlock } from "./code-delivered-telemetry.js";
import type { Prewarmer, PrewarmOutcome } from "./embedding-prewarm.js";
import {
  bumpShown,
  decideBackoff,
  getLoadedMarkerMtime,
  loadSessionState,
  recordSourceEmit,
  recordSourceSuppressed,
  mutateSessionState,
  shouldDropHit,
  takeBoundary,
  takeParkedBoundary,
  wasEmitConsumed,
  type TakenBoundary,
} from "./session-state.js";
import {
  MUST_LOAD_SCORE,
  SCORE_FLOOR,
  detectAssertion,
  detectRetrieval,
  effectiveScoreFloor,
  extractPrompt,
  isTrivialPrompt,
  type ClaudeHookPayload,
  type DetectedMode,
} from "./prompt-classify.js";
import { formatHintBlock, formatReflexBlock, type PromptReflexHit, type RecallHit } from "./prompt-format.js";
import { writeTelemetry } from "./prompt-lane-telemetry.js";
import { postJson } from "./prompt-loopback.js";

// #680: classification, formatting, telemetry and the loopback call live in
// their own modules; the lane's public surface is re-exported unchanged.
export { MUST_LOAD_SCORE, detectAssertion, detectRetrieval, effectiveScoreFloor, extractPrompt, isTrivialPrompt } from "./prompt-classify.js";
export type { ClaudeHookPayload, DetectedMode } from "./prompt-classify.js";
export { formatHintBlock, formatReflexBlock } from "./prompt-format.js";
export type { PromptReflexHit, RecallHit } from "./prompt-format.js";

// Per trigger class since #305 — see hook-budgets.ts for the measurement.
// 600ms for the quiet classes, 1000ms for assertion: that lane sits at the
// start of a turn, pays a cold embedding model by construction, and was being
// cut off on 23.4% of its calls against the flat 600ms. `BASTRA_HOOK_TIMEOUT_MS`
// still overrides, for the classes that had it.
const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", RECALL_BUDGET_MS, "NEXUS_HOOK_TIMEOUT_MS");
function laneBudgetMs(mode: DetectedMode): number {
  return mode === "assertion" ? PROMPT_ASSERTION_BUDGET_MS : HOOK_TIMEOUT_MS;
}
// #161: backoff source key — prompt-lookup hints back off independently.
const BACKOFF_SOURCE = "prompt-lookup";

/**
 * "all" (default since #677) — every non-trivial prompt recalls, and what a
 * prompt the lookup/assertion regexes do not recognise may inject is gated by
 * score (MUST_LOAD_SCORE), not by the language it is written in. Those regexes
 * are German/English only: a contributor's month had 0 of 1,039 prompts
 * recognised as a lookup (#671), so under the old default a user writing any
 * other language got a silent lane. "retrieval-only" keeps the pre-#677
 * behaviour (regex-gated recall) as an explicit opt-out.
 */
type PromptHookMode = "retrieval-only" | "all";
const hookMode = (): PromptHookMode =>
  envFirst("BASTRA_PROMPT_HOOK_MODE") === "retrieval-only" ? "retrieval-only" : "all";

interface RecallResponse {
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
}

interface ReflexResponse {
  hits: PromptReflexHit[];
  recall_id: string | null;
}

// ─── session-pid resolution (#343) ──────────────────────────────────────────

/** ppid → resolved claude session pid. A live ppid's ancestor chain never
 *  changes, so the first request of a session pays the `ps` walk and the rest
 *  hit the map. Entries for dead ppids are harmless (map stays tiny). */
const sessionPidCache = new Map<number, number>();

function resolveSessionPid(clientPpid: number | null): number | null {
  if (clientPpid === null || !Number.isInteger(clientPpid) || clientPpid <= 1) return null;
  const cached = sessionPidCache.get(clientPpid);
  if (cached !== undefined) return cached;
  const pid = claudeSessionPidFrom(clientPpid);
  sessionPidCache.set(clientPpid, pid);
  return pid;
}

/**
 * Reset the statusline feed to idle at the start of each user turn. Stamps a
 * fresh `turn_id` (Date.now()) so the forwarder adopts the new turn exactly
 * once (Issue #51, see statusline-feed.ts). Preserves the previous
 * vault_size; the forwarder refreshes it on the next recall-done.
 */
function resetStatuslineFeed(sessionPid: number, ccSessionId: string | null): void {
  const feedPath = sessionFeedPath(sessionPid);
  try {
    let vaultSize = 0;
    try {
      const prev = JSON.parse(readFileSync(feedPath, "utf8")) as { vault_size?: number };
      vaultSize = prev.vault_size ?? 0;
    } catch {
      // no prior file — vault_size stays 0 until first recall populates it
    }
    // cc_session_id (#74): der Hook ist die einzige Stelle, die die echte
    // Claude-Code session_id kennt — über den Feed erreicht sie den Forwarder.
    const state = idleStatuslineState(Date.now(), vaultSize, ccSessionId);
    mkdirSync(STATUSLINE_DIR, { recursive: true });
    const tmp = `${feedPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, feedPath);
  } catch {
    // statusline reset is non-essential — never break the prompt lane
  }
}

// ─── the lane ───────────────────────────────────────────────────────────────

/**
 * Run the full UserPromptSubmit pipeline and return the exact JSON string the
 * thin client must write to stdout — either `{}` or the hookSpecificOutput
 * envelope. Never throws; every failure path degrades to `{}` plus telemetry,
 * matching the CLI's fail-open contract.
 */
export async function runPromptLane(
  payload: ClaudeHookPayload,
  clientPpid: number | null,
  selfBaseUrl: string,
  /** #361: turn-start embedding prewarm, injected by the route. Fire-and-
   *  forget by contract — this lane never awaits it (see below). Absent =
   *  no embedding provider wired at all. */
  prewarm?: Prewarmer,
  /** #371: the ids of the memories the user wired as `recall_mode: reflex`,
   *  read straight off the vault index by the route (in-memory, no I/O). Mode
   *  "none" can inject nothing else, so this list is what decides whether the
   *  recall below is worth paying for. Absent = no accessor wired (an older
   *  caller, a unit test): the lane then recalls exactly as it did before. */
  reflexPool?: () => string[],
): Promise<string> {
  const startedAt = Date.now();
  const client = hookClient(payload);
  // #507 Nachbesserung: nur für die Telemetrie-Dimension — `client` oben bleibt
  // der surface-Default fürs Hint-Block-Attribut und den Recall-Loopback.
  const clientEvidence = hookClientEvidence(payload);
  const agent = hookAgent(payload);

  if (payload.hook_event_name !== "UserPromptSubmit") return "{}";

  // #361: the turn has started — warm the embedding model NOW, so the first
  // assertion call of this turn (seconds from here, PreToolUse) finds it
  // resident instead of paying the cold dense arm and losing it to the 150ms
  // deadline (#342). Runs before the trivial gate on purpose: an "ok" or a
  // slash command starts a turn full of tool calls just as much as a question
  // does, and the debounce is what keeps the warm cheap, not the gate.
  // Synchronous by construction — the call inside is never awaited here.
  const prewarmOutcome: PrewarmOutcome | undefined = prewarm?.();

  // New user turn → reset statusline counters to idle. Needs the client's
  // process-tree position; without a resolvable ppid the reset is skipped
  // (statusline is cosmetic, the lane is not).
  const sessionPid = resolveSessionPid(clientPpid);
  if (sessionPid !== null) resetStatuslineFeed(sessionPid, payload.session_id ?? null);

  const submitted = extractPrompt(payload);
  if (!submitted) return "{}";

  // #703: a task notification or agent mail arrives as a user turn nobody
  // typed — the same turns the Stop lane classifies as system-injected. No
  // recall, so no hook_recall row carries the injected text as an owner query;
  // `origin: "system"` marks the event so reach and prompt counts can drop it
  // (#704). A task-boundary block parked for the owner's next prompt stays
  // parked: this turn is not that prompt.
  // #769: an expanded slash command is the owner's turn (trivial gate below),
  // and text typed after a leading <system-reminder> block is the prompt.
  const prompt = ownerPromptText(submitted);
  if (prompt === null) {
    await writeTelemetry({
      session_id: payload.session_id ?? null,
      client: clientEvidence,
      agent,
      detected_mode: "none",
      gated: true,
      gated_reason: "system-injected",
      origin: "system",
      prompt_chars: submitted.length,
      daemon_url: selfBaseUrl,
      daemon_reachable: true,
      hint_count: 0,
      hint_tokens_est: 0,
      top_score: null,
      latency_ms_total: Date.now() - startedAt,
      status: "gated",
      error: null,
      prewarm: prewarmOutcome,
    });
    return "{}";
  }

  // #151: gate before any recall work — the saved tokens surface in stats
  // via status:"gated" + gated:true.
  if (isTrivialPrompt(prompt)) {
    await writeTelemetry({
      session_id: payload.session_id ?? null,
      client: clientEvidence,
      agent,
      detected_mode: "none",
      gated: true,
      prompt_chars: prompt.length,
      daemon_url: selfBaseUrl,
      daemon_reachable: true,
      hint_count: 0,
      hint_tokens_est: 0,
      top_score: null,
      latency_ms_total: Date.now() - startedAt,
      status: "gated",
      error: null,
      prewarm: prewarmOutcome,
    });
    // #572: a trivial prompt skips the RECALL, not the task-boundary block. "ok"
    // and "go on" after a finished task are exactly the turn it was parked
    // for, and handing it over costs one state read when nothing is parked.
    // #607: behind the prompt lane's opt-in, like every other delivery of this
    // lane. The gate is asked only once a block is actually parked, so a
    // trivial prompt still costs the one state read it always did.
    const parkedForTrivial = await takeParkedBoundary(
      payload.session_id ?? "",
      getPromptImpactEnabled,
    );
    if (parkedForTrivial !== null) {
      logBoundaryDelivery(payload.session_id ?? null, payload.cwd ?? process.cwd(), parkedForTrivial);
    }
    if (parkedForTrivial?.note != null) {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: parkedForTrivial.note,
        },
      });
    }
    return "{}";
  }

  const isRetrieval = detectRetrieval(prompt);
  let detectedMode: DetectedMode;
  if (isRetrieval) {
    detectedMode = "retrieval";
  } else if (detectAssertion(prompt)) {
    // #252 — recalls where the retrieval-only mode stays silent.
    detectedMode = "assertion";
  } else if (hookMode() === "all") {
    detectedMode = "generic";
  } else {
    detectedMode = "none";
  }

  const cwd = payload.cwd ?? process.cwd();
  // §20.5: geratene Erkennung = kein Projekt (projectForLane) — sonst fragt
  // die Lane Kandidaten für ein erfundenes Projekt ab und schreibt dessen
  // Namen als `project=` in den Block.
  const project = projectForLane(cwd);
  // §20.5: geratenes Projekt filtert nicht — siehe projectForFilter.
  const filterProject = projectForFilter(cwd);
  const remainingMs = Math.max(50, laneBudgetMs(detectedMode) - (Date.now() - startedAt));

  // #217 Reflex-Lane: feuert unabhängig vom Retrieval-Gate — auch bei
  // detectedMode "none". Parallel zum bedingten Recall, sonst sprengt die
  // Serialisierung das Budget. Fehler → still keine Reflex-Hits.
  const reflexPromise: Promise<ReflexResponse | null> = postJson<ReflexResponse>(
    selfBaseUrl,
    "/hook/reflex",
    { context: prompt, project, session_id: payload.session_id ?? null },
    remainingMs,
  ).catch(() => null);

  // For "generic" mode we only show top-tier hits, so request fewer (k=3).
  const k = detectedMode === "generic" ? 3 : 5;
  const effectiveFloor = effectiveScoreFloor(detectedMode);

  const sessionId = payload.session_id ?? "";
  const state = await loadSessionState(sessionId);

  // #606: a change-impact question gets the graph's answer delivered before
  // the first search runs. Started here so it overlaps the recall; gated twice
  // (phrasing, then resolution against the graph) inside, so an ordinary
  // prompt costs one regex pass and nothing else.
  const impactPromise = deliverPromptImpact({
    prompt,
    cwd,
    sessionId: payload.session_id ?? null,
    session: state,
  });

  // #371: in mode "none" the recall can only ever contribute a memory that
  // the user wired as `recall_mode: reflex` (the filter below) and that this
  // session has not already shown inside the 4h window (the dedup further
  // down). Both questions are independent of the query and answerable in
  // microseconds — the vault index and the session-state file are already in
  // hand. Asked BEFORE the recall they turn ~210ms of full-vault hybrid search
  // into nothing on exactly the prompts whose result was going to be thrown
  // away. Measured on the 19.–24.08. log: 91% of prompts run in mode "none",
  // 83.5% of those inject nothing, and 10.9% ran inside a window in which
  // every wired memory was already suppressed.
  //
  // What this deliberately is NOT: a restriction of the recall's CANDIDATE
  // SPACE to the wired pool. The floor of 50 in mode "none" means "top 4 of an
  // arm over the WHOLE vault" — RRF_SCALE/(RRF_K + rank) ≥ 50 ⇔ rank ≤ 4 —
  // and ranked against a two-document pool every wired memory scores 70–164 by
  // construction, so the gate would stop gating and both conventions would
  // inject on the first prompt of every 4h window instead of on the prompt
  // they belong to (#371). The recall that still runs here is byte-identical
  // to the one that ran before; only whether it runs at all is new.
  let recallSkipped: "reflex-pool-empty" | "reflex-all-suppressed" | undefined;
  if (detectedMode === "none" && reflexPool) {
    const wired = reflexPool();
    if (wired.length === 0) {
      recallSkipped = "reflex-pool-empty";
    } else {
      let anyEligible = false;
      for (const id of wired) {
        if (!shouldDropHit(state.shown[id], await getLoadedMarkerMtime(id))) {
          anyEligible = true;
          break;
        }
      }
      if (!anyEligible) recallSkipped = "reflex-all-suppressed";
    }
  }

  let resp: RecallResponse | null = null;
  let status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error" = "ok";
  let errMsg: string | null = null;
  // Mode "none" no longer skips the recall (19.08. incident): a reflex-wired
  // convention ("Nachrichtenkonvention", salience 0.9) never surfaced while a
  // message was being drafted — the hard token-AND of the reflex lane cannot
  // survive German inflection ("entwirfst" vs "entwerfen"), and the hybrid
  // recall that DOES understand it never ran on ordinary work prompts. Now it
  // runs on every non-trivial prompt; what may inject in mode "none" is
  // filtered below to user-wired reflex memories at REQUIRED strength.
  // #371 narrowed "every non-trivial prompt" to "every non-trivial prompt on
  // which a wired memory could actually be injected" — see the gate above.
  if (recallSkipped !== undefined) {
    // The same outcome the filter below would have produced, without the
    // search: no hits, and the status the telemetry series already carries for
    // this case (`resp` stays null, so the `no-hits` line below cannot fire).
    status = "no-hits";
  } else {
    try {
      resp = await postJson<RecallResponse>(
        selfBaseUrl,
        "/hook/recall",
        {
          query: prompt,
          project,
          k,
          tool_name: "UserPromptSubmit",
          // #445: die Lane weist sich aus — wie bash-pre/bash-fail seit #263.
          // Ohne die Felder liest der Empfänger `unknown/unknown`.
          ...hookCaller(payload),
          hook_source: "prompt",
        },
        remainingMs,
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Self-call on the own server: connection-class errors cannot really
      // mean "daemon down" anymore, but the status vocabulary stays — the
      // telemetry series must remain comparable across the migration.
      if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "EHOSTUNREACH") {
        status = "daemon-unreachable";
      } else if (e.message === "timeout") {
        status = "timeout";
      } else {
        status = "error";
        errMsg = e.message ?? String(err);
      }
    }
  }
  const reflexResp = await reflexPromise;

  const filtered: RecallHit[] = [];
  if (resp && Array.isArray(resp.hits)) {
    // Wired reflex memories ride along from below the top-k cut (20.08.: the
    // convention sat at pool rank 6 behind k=5). They pass the same floor.
    const candidates = [...resp.hits, ...(Array.isArray(resp.reflex_hits) ? resp.reflex_hits : [])];
    for (const h of candidates) {
      const wired = h.recall_mode === "reflex";
      // #677: "generic" replaced "none" as the default for unrecognised
      // prompts, so it must not lose what "none" delivered — a user-wired
      // reflex memory keeps the normal floor there (the 19.08. prompt ranked
      // the convention at 84, see below).
      const floor = detectedMode === "generic" && wired ? SCORE_FLOOR : effectiveFloor;
      if (h.score < floor) continue;
      // #677: the generic gate IS the score — on the unfused scale (raw BM25,
      // open-ended) MUST_LOAD_SCORE says nothing, and passing everything
      // would inject the top k on every prompt exactly while the vector arm
      // is down. Without fusion only wired memories inject, as in "none".
      if (detectedMode === "generic" && resp.unfused === true && !wired) continue;
      // Semantic reflex: in mode "none" only memories the USER wired as
      // reflex may inject — the semantic arm gives them hearing beyond
      // literal token matches. Deliberately at the normal floor, not
      // MUST_LOAD_SCORE: the 19.08. real prompt ranked the wired convention
      // at 84 (a long convoluted prompt dilutes the rank), and the pool is
      // tiny and explicitly authorized — the wiring is the noise gate, the
      // backoff still dampens sub-REQUIRED repeats.
      if (detectedMode === "none" && !wired) continue;
      filtered.push(h);
    }
  }
  if (resp && filtered.length === 0) status = "no-hits";

  // #217: Session-Dedup für Reflex-Hits (max 1×/4h pro Memory, wie hook.ts).
  // Danach id-Dedup gegen die Recall-Liste — Reflex ist das vom User
  // verdrahtete, stärkere Signal und behält den Hit.
  const rawReflexHits: PromptReflexHit[] = Array.isArray(reflexResp?.hits) ? reflexResp.hits : [];
  // #266: dieselbe Entscheidung wie in der Bash-Lane, über denselben Governor.
  // Was „bereits gezeigt" heißt, bleibt bei `shouldDropHit` (4h-Fenster,
  // MAX_SHOW, Load-Marker); ohne Budget aufgerufen, weil diese Lane heute
  // keines hat — Mechanik vereinheitlichen, nicht verschärfen.
  const reflexGoverned = governContext(
    await Promise.all(
      rawReflexHits.map(async (h, i) => ({
        id: h.id,
        priority: i,
        text: h.summary ?? "",
        alreadyShown: shouldDropHit(state.shown[h.id], await getLoadedMarkerMtime(h.id)),
      })),
    ),
    {},
  );
  const reflexKeptIds = new Set(reflexGoverned.kept.map((g) => g.id));
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
  {
    const governed = governContext(
      await Promise.all(
        recallHits.map(async (h, i) => ({
          id: h.id,
          priority: i,
          text: h.summary ?? "",
          alreadyShown: shouldDropHit(state.shown[h.id], await getLoadedMarkerMtime(h.id)),
        })),
      ),
      {},
    );
    const keptIds = new Set(governed.kept.map((g) => g.id));
    recallHits = recallHits.filter((h) => keptIds.has(h.id));
  }

  // §20.5: Diese Lane filterte nie nach Projekt-Scope — fremde Treffer kamen
  // durch, während Write-Lane und SessionStart seit #110 hart filtern. Der
  // Filter läuft hier zuerst im SHADOW-Modus: er misst, was er verwerfen
  // würde, und verwirft nichts. Die Anker-Ausnahme bleibt (ein hand-
  // geschriebener Trigger aus einem anderen Projekt IST eine Absicht),
  // Reflex-Treffer sind ausgenommen, und ohne Fusion ist die Ausnahme zu.
  const scopeFilter = applyLaneScopeFilter(
    recallHits,
    filterProject,
    {
      allowAnchoredCrossScope: true,
      mustLoadScore: MUST_LOAD_SCORE,
      unfused: resp?.unfused === true,
      exemptReflex: true,
      projectKnown: resp?.project_known,
    },
  );
  recallHits = scopeFilter.hits;
  // Codex-Gegenreview: `no-hits` wurde oben bestimmt, VOR diesem Filter. Trägt
  // er im enforce-Modus alles ab, meldete die Telemetrie weiter "ok" bei null
  // injizierten Treffern — die Serie hätte den Filter nicht von einem stillen
  // Recall unterscheiden können, also genau das nicht gezeigt, wofür der
  // Shadow-Modus da ist.
  if (resp && recallHits.length === 0) status = "no-hits";

  let backoffStreak = 0;
  let suppressed = false;
  let suppressedTokensEst = 0;
  let consumedForEmit = false;
  let recallBlock: string | null = null;
  if (recallHits.length > 0) {
    // #161 empty-streak backoff (see session-state.ts): unconsumed injection
    // streaks widen the cadence; any load of an emitted candidate resets.
    // REQUIRED-band hits bypass suppression (decideBackoff hasRequired), and
    // retrieval mode is exempt entirely — the user explicitly asked for a
    // lookup, answering it is never noise. Streak bookkeeping stays regular
    // either way; only consumption resets the streak. Reflex-Hits laufen
    // an diesem Backoff komplett vorbei (#217): vom User verdrahtet = nie Noise.
    const entry = state.sources?.[BACKOFF_SOURCE];
    consumedForEmit = await wasEmitConsumed(entry);
    // P0: Auf der unfused Skala ist `>= MUST_LOAD_SCORE` keine Aussage — rohe
    // BM25-Werte reißen die 100 fast immer. Ein Bypass daraus hieße: Der
    // Backoff hört genau dann auf zu greifen, wenn der Recall am wenigsten
    // weiß. Ohne Fusion gibt es deshalb kein REQUIRED und keinen Bypass.
    const hasRequired =
      resp?.unfused !== true && recallHits.some((h) => h.score >= MUST_LOAD_SCORE);
    const decision = decideBackoff(entry, consumedForEmit, hasRequired);
    backoffStreak = decision.streak;
    suppressed = detectedMode === "retrieval" ? false : decision.suppress;
    const block = formatHintBlock(
      recallHits,
      project,
      detectedMode,
      resp?.weak_result === true,
      resp?.unfused === true,
      client,
      resp?.degraded,
      resp?.recall_id,
    );
    if (suppressed) {
      // Suppressed drops only the recall block (#161); reflex still emits.
      suppressedTokensEst = Math.ceil(block.length / 4);
      // The `skipped` delta is booked below, inside mutateSessionState —
      // mutating `state` here would write into the early snapshot, which
      // #539 no longer saves.
    } else {
      recallBlock = block;
    }
  }

  const reflexBlock = reflexKept.length > 0 ? formatReflexBlock(reflexKept, project, client) : null;
  const impact = await impactPromise;

  // #572: the task-boundary block the last Stop parked for THIS session.
  // #607: behind the prompt lane's own opt-in (b3a6f80) — same lane, same
  // delivery nobody has measured yet, so the same switch and the same default
  // (off).
  //
  // Taken inside the save below rather than through `takeParkedBoundary`: that
  // would open the session state a SECOND time on a path with a 200 ms ceiling
  // (#305), next to the snapshot above and the mutation below. The snapshot
  // only decides whether there is anything to take; the take, the dedupe check
  // and the marking still happen in one locked mutation, so a crash between
  // them can neither duplicate nor lose the block. A Stop that parks between
  // the snapshot and the lock keeps its block for the next prompt, which is
  // where it was headed anyway.
  const takeBoundaryNow = state.boundary !== undefined && (await getPromptImpactEnabled());
  let boundary: TakenBoundary | null = null;

  // State-Bookkeeping in einem Save: Backoff-Streak nur für die
  // prompt-lookup-Lane, Reflex bucht nur die Session-Dedup.
  //
  // #539: the deltas run against the state as it is on disk when the lock is
  // taken, not against the snapshot read before the recall — the other four
  // lanes write the same file in the meantime.
  if (recallHits.length > 0 || reflexKept.length > 0 || impact.dedupeKey !== null || takeBoundaryNow) {
    const recallIds = recallHits.map((h) => h.id);
    const impactKey = impact.dedupeKey;
    await mutateSessionState(sessionId, (s) => {
      if (takeBoundaryNow) boundary = takeBoundary(s);
      // #606: booked only when the block actually reached the transcript, so a
      // suppressed turn does not silence the next one.
      if (impactKey !== null) bumpShown(s, impactKey);
      if (recallBlock) {
        recordSourceEmit(s, BACKOFF_SOURCE, recallIds, consumedForEmit);
      } else if (suppressed) {
        // #539: without this the backoff window never fills, so the lane
        // suppresses forever instead of probing again after `streak` skips.
        recordSourceSuppressed(s, BACKOFF_SOURCE);
      }
      for (const h of reflexKept) bumpShown(s, h.id);
      // Every injected recall hit books the shown-state, in every mode (#541)
      // — without this the dedup above has nothing to count and the block
      // repeats on every qualifying prompt. Only what actually reached the
      // transcript is booked: a suppressed emit leaves `recallBlock` null.
      if (recallBlock) {
        for (const h of recallHits) bumpShown(s, h.id);
      }
    });
  }
  // The assignment happens inside the mutation callback, which TypeScript's
  // control flow does not follow — without the cast it narrows `boundary` to
  // the `null` it was declared with.
  const takenBoundary = boundary as TakenBoundary | null;
  if (takenBoundary !== null) logBoundaryDelivery(payload.session_id ?? null, cwd, takenBoundary);

  // The impact block goes FIRST: it is the answer to what the user just asked,
  // and it is there to be read before the first search, not after the memory
  // hints. It never rides the recall backoff — it is not recall noise, it is a
  // deterministic answer to an explicit question (same reasoning as the size
  // note in the write lane).
  // #572: the boundary block rides ahead of it for the same reason: it is about
  // what the agent just did, and it is worth reading before the next thing is
  // done on top of it.
  const blocks = [takenBoundary?.note ?? null, impact.block, reflexBlock, recallBlock].filter(
    (b): b is string => b !== null,
  );
  const stdout =
    blocks.length === 0
      ? "{}"
      : JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: blocks.join("\n"),
          },
        });

  // Usage sidecar (#154): only what was ACTUALLY injected counts as surfaced.
  const injectedIds = [
    ...(reflexBlock ? reflexKept.map((h) => h.id) : []),
    ...(recallBlock ? recallHits.map((h) => h.id) : []),
  ];
  if (injectedIds.length > 0) {
    await reportHinted(selfBaseUrl, injectedIds, payload.session_id ?? null);
  }

  // #458 (shadow): den fertigen Block ans Sitzungsbudget anrechnen und den
  // Governor-Entscheid loggen — nichts wird gekürzt.
  recordBudgetShadow(payload.session_id ?? null, "prompt_hook_call", blocks.length === 0 ? 0 : Math.ceil(blocks.join("\n").length / 4));
  await writeTelemetry({
    session_id: payload.session_id ?? null,
    client: clientEvidence,
    agent,
    detected_mode: detectedMode,
    prompt_chars: prompt.length,
    daemon_url: selfBaseUrl,
    // A skipped recall (#371) is not an unreachable daemon: the lane IS the
    // daemon and the vault answered the question locally.
    daemon_reachable: resp !== null || reflexResp !== null || recallSkipped !== undefined,
    hint_count: suppressed ? 0 : recallHits.length,
    reflex_hint_count: reflexKept.length,
    ...(reflexDeduped.length > 0 ? { reflex_deduped_ids: reflexDeduped } : {}),
    // #354: which memories this lane actually injected, and of what type.
    // The prompt lane was the one hint source the context-tax evaluation could
    // not see per memory — it reported only counts. Suppressed emits stay
    // empty: nothing reached the transcript, so nothing was taxed.
    hinted_ids: suppressed ? [] : [...recallHits, ...reflexKept].map((h) => h.id),
    hinted_types: suppressed ? [] : [...recallHits, ...reflexKept].map((h) => h.type),
    hint_tokens_est: blocks.length === 0 ? 0 : Math.ceil(blocks.join("\n").length / 4),
    // #606: the code block's own cost and reach, separate from the memory
    // hints — the ROI question is what the CODE context costs, and
    // `hint_tokens_est` counts the whole injected document.
    ...(impact.block !== null
      ? {
          code_block_tokens_est: impact.tokensEst,
          code_basis: impact.basis === null ? [] : [impact.basis],
        }
      : {}),
    top_score: resp?.hits?.[0]?.score ?? null,
    latency_ms_total: Date.now() - startedAt,
    backoff_streak: backoffStreak,
    // §20.5 Shadow-Messung: was ein Scope-Filter hier verwerfen WÜRDE, plus
    // der Kontext, in dem die Entscheidung fällt — Modus (shadow/enforce),
    // Projekt-Scope, Retrieval-Modus (steht schon als detected_mode oben) und
    // `unfused`. Die Scope-Namen kommen mit, damit sich auswerten lässt, ob
    // dieselben zwei Fremdprojekte alles ausmachen oder ob es breit streut.
    scope_filter_mode: scopeFilter.mode,
    dropped_scope_count: scopeFilter.droppedCount,
    project_confidence: projectConfidence(cwd),
    filter_project: scopeFilter.filterProject,
    ...(scopeFilter.skipped ? { scope_filter_skipped: scopeFilter.skipped } : {}),
    ...(scopeFilter.droppedScopes.length > 0
      ? { dropped_scopes: scopeFilter.droppedScopes }
      : {}),
    ...(resp?.unfused === true ? { unfused: true } : {}),
    ...(resp?.degraded ? { degraded: resp.degraded } : {}),
    suppressed,
    suppressed_tokens_est: suppressedTokensEst,
    status: suppressed ? "suppressed" : status,
    error: errMsg,
    prewarm: prewarmOutcome,
    recall_skipped: recallSkipped,
  });

  return stdout;
}

/**
 * #572/#579: one `code_tool_call` row per task-boundary block that reached the
 * transcript — the same shape and the same call the write lane
 * (`write-lane.ts`) and `prompt-impact.ts` use, so all three deliveries group
 * by `delivered_lane` in one readout instead of joining two event kinds.
 *
 * A block the session-dedupe held back is booked as a dedupe hit, the same
 * "which kind of nothing" the other two lanes tell apart. Fire-and-forget: the
 * row is the measurement, never part of the answer.
 */
function logBoundaryDelivery(sessionId: string | null, cwd: string, taken: TakenBoundary): void {
  void logDeliveredBlock({
    sessionId,
    lane: "boundary",
    repo: repoRootSync(cwd) ?? cwd,
    dedupeHit: taken.note === null,
    // No `basis`: a boundary block has one per dependent (edit-time or
    // whole-file-now), not one for the answer, and inventing a single value
    // would put a number in that column that describes nothing.
    ...(taken.note !== null ? { files: taken.files, tokensEst: Math.ceil(taken.note.length / 4) } : {}),
  });
}
