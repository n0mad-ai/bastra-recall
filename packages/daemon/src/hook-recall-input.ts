/**
 * /hook/recall — reading the request fields of one hook recall (split out of
 * http-hook-routes.ts, #680). Pure: parses and clamps, decides nothing.
 */
import { envInt } from "./env.js";
import { clampInt } from "./http-util.js";

/**
 * #342: deadline for the dense arm on the HOOK path only — the surface with a
 * hard client-side budget (per lane since #305: 600ms for the recall lanes,
 * 1000ms for the assertion class — see hook-budgets.ts). Offline callers (bridge
 * harvest, doc2query self-test, the WebUI) keep waiting indefinitely; they have
 * no budget and want the better result.
 *
 * The number comes from the per-stage split measured on a real host, and it is
 * a bound on THIS STAGE, not on the call:
 *
 *   warm   bm25 15-24ms   vector  87-96ms   →  total 106-113ms
 *   cold   bm25 24ms      vector 668ms      →  total 694ms
 *
 * So 150ms clears every warm dense arm with ~55ms to spare, and caps the cold
 * one at 150 + ~25ms of BM25 ≈ 180ms. That keeps BOTH cases under the 200ms
 * p90 target #305 sets for the FAST lanes (it is no longer a single ceiling
 * across all of them) — the warm path untouched at ~110ms, the cold path degraded
 * to BM25-only but arriving, instead of the whole call expiring silently and
 * the turn continuing as if there had been nothing to say.
 *
 * 0 disables the deadline (kill switch, pre-#342 behaviour). Every expiry is
 * visible as `degraded: "vector-arm-timeout"` on the recall telemetry, so a
 * machine where the warm arm genuinely needs longer shows up as a rate rather
 * than as quietly worse recall.
 *
 * Read per call, not once at module load, like BASTRA_HOOK_CONTENT_RECALL
 * below: a latency kill switch that needs a daemon restart to take effect is
 * not much of a kill switch.
 */
const hookVectorDeadlineMs = (): number => envInt("BASTRA_VECTOR_DEADLINE_MS", 150);

/** #305/#362: Zielbudget der Hook-Lane in ms — die Zahl, gegen die der
 *  Schatten-Router seine Kostenschätzung hält. Das Milestone-Ziel ist 200. */
const hookBudgetMs = (): number => envInt("BASTRA_HOOK_BUDGET_MS", 200);

/** The per-call request fields of a hook recall, clamped to their ranges. */
export function readHookRecallInput(body: Record<string, unknown>) {
  const k = clampInt(body.k, 1, 10, 3);
  const hookSessionId = typeof body.session_id === "string" ? body.session_id : null;
  const hookToolName = typeof body.tool_name === "string" ? body.tool_name : null;
  const hookProject = typeof body.project === "string" ? body.project : null;
  const scope = typeof body.scope === "string" ? body.scope : undefined;
  const type = typeof body.type === "string" ? body.type : undefined;
  // expand_hops: Hooks profitieren vom Multi-Hop-Recall sobald
  // related_via befüllt ist (über RelatedEnricher). Default 1 — der
  // Caller kann explizit 0 schicken um es zu deaktivieren.
  const expand_hops = body.expand_hops === 0 ? 0 : 1;
  // 20.08.: the caller may widen the dense arm's deadline. The 150ms
  // default is sized for the 600ms hook budget; the MCP forwarder reuses
  // this route with a waiting model behind it and was paying the hook's
  // deadline for nothing — 15 of 19 MCP recalls on 20.08. came back
  // BM25-only because a 3-query batch (#351) serialises on one Ollama.
  const vectorDeadlineMs = clampInt(body.vector_deadline_ms, 50, 10_000, hookVectorDeadlineMs());
  /**
   * #494: Der Aufrufer verzichtet auf den dichten Arm — GAR KEIN Embed,
   * nicht bloß eine kurze Frist.
   *
   * #490 wollte genau das und konnte es nicht bauen (`search.ts` lag
   * damals bei #489), also bekam der kalte SessionStart 50 ms statt eines
   * Verzichts. Als EINZIGER aufgegebener Embed, der das Modell nebenbei
   * wärmt, wäre das vertretbar gewesen; neben einem eigenen Warmup und
   * drei parallelen Session-Recalls ist es redundante Last, aufgebracht
   * genau dann, wenn die Maschine am langsamsten ist.
   *
   * Die Antwort ist ehrlich einarmig (`score_kind: "bm25"`, `unfused`) —
   * aber ohne `degraded`: Es ist kein Arm ausgefallen, es war keiner
   * vorgesehen. Wer den Verzicht ausgelöst hat, sagt der Aufrufer in
   * seinem eigenen Block (die SessionStart-Lane: „not in memory").
   */
  const lexicalOnly = body.lexical_only === true;
  // #487: Das Kontextbudget des Aufrufs in geschätzten Token. `0` (der
  // Default, also auch „nicht geschickt") heißt unbegrenzt und ändert an
  // dieser Antwort nichts. Der MCP-Forwarder reicht das Feld durch — für
  // ein Modell, das sein Restfenster kennt, ist das die Größe, in der es
  // rechnet, und `k` ist es nicht.
  const maxTokens = clampInt(body.max_tokens, 0, 1_000_000, 0);
  // Dieselbe Regel wie bei der Deadline eine Zeile darüber: Das Budget, gegen
  // das der Schatten-Router rechnet, gehört zum AUFRUF, nicht zum Endpunkt.
  // Die 200 sind die Wanduhr der Prompt-Lane; die SessionStart-Lane hat ihre
  // eigene (`HOOK_TIMEOUT_MS`, 500) und schickt sie mit. Ohne das würde der
  // Schatten für sie eine Grenze prüfen, unter der sie gar nicht läuft.
  // `0` heißt weiterhin „kein Budget" (siehe `lexicalFitsBudget`).
  const budgetMs = clampInt(body.hook_budget_ms, 0, 10_000, hookBudgetMs());
  // #493: WOHER diese Zahl kommt. Sie stand bisher ohne Herkunft in der
  // Telemetrie, und genau daran ist die MCP-Lane verunglückt: Der
  // Forwarder schickte nichts, also galt für ihn die 200 der Prompt-Lane,
  // und die Zeilen lasen live `deadline_ms 1500, lane_budget_ms 200,
  // cap_reason floor` — ein gesunder 400-ms-Arm gemessen an einer
  // Wanduhr, die es für ihn nie gab. Der Forwarder schickt seitdem sein
  // eigenes Budget; die Spalte sagt, ob ein Aufrufer das getan hat.
  const budgetSource: "caller" | "endpoint-default" =
    typeof body.hook_budget_ms === "number" && Number.isFinite(body.hook_budget_ms)
      ? "caller"
      : "endpoint-default";
  // #493: Die Klammer um die (bis zu drei) Recalls EINES Sitzungsstarts.
  // Ohne sie ist ein Sitzungsstart mit drei kalten Armen von drei
  // Sitzungsstarts nicht zu unterscheiden — siehe HookRecallEvent.
  const sessionStartCallId =
    typeof body.session_start_call_id === "string" ? body.session_start_call_id : null;
  return {
    k,
    hookSessionId,
    hookToolName,
    hookProject,
    scope,
    type,
    expand_hops,
    vectorDeadlineMs,
    lexicalOnly,
    maxTokens,
    budgetMs,
    budgetSource,
    sessionStartCallId,
  } as const;
}
