import { SESSION_START_BUDGET_MS } from "./hook-budgets.js";
import { resetRulebookContext } from "./rulebook-check.js";
import { capSessionContext } from "./session-context-cap.js";
import { buildSoulBlock, readSoulPreference } from "./soul.js";
/**
 * SessionStart lane, daemon-side (#369/#15 — the #343/#344 pattern, applied to the
 * lane that greets every new session).
 *
 * Preloads the most relevant memorys for a fresh Claude Code session as
 * `additionalContext` so the model knows who the user is, what project they're
 * in, and what cross-project rules apply, before the first user prompt
 * arrives. The pipeline moved here verbatim from `session-hook.ts`, which is a
 * thin client now — stdin -> POST /hook/session -> stdout.
 *
 * Pipeline:
 *   payload (Claude-Code SessionStart)
 *     → projectForLane(cwd)  (geraten = kein Projekt, §20.5)
 *     → 3 scope-filtered self-calls to /hook/recall
 *         · scope=user-preference  k=3   query="session-start preferences"
 *         · scope=<project>        k=3   query="<project> active context"
 *         · scope=all-projects     k=2   query="cross-project working rules"
 *     → merge by score, drop dups, format as <session-context>…</session-context>
 *     → /hook/floors (#141/#142): floored memories as a <pinned-memories>
 *       block BEFORE the score-gated hints — push-by-state, never relevance-
 *       gated, never dropped by any dedup
 *     → returns: {"hookSpecificOutput": { hookEventName, additionalContext }}
 *
 * Why the move pays twice here: the client stopped paying ~78ms of node start
 * (#305/#369), and the up-to-seven sequential loopback round trips below now
 * run from inside the server that answers them. They stay HTTP self-calls on
 * purpose — same reason as prompt-lane.ts: collapsing them into direct calls
 * would change what the existing telemetry series measures mid-migration.
 *
 * Discipline unchanged: hard wall-clock budget, fail-silent on every error
 * path, telemetry best-effort.
 */
import type { DraftReviewDelivery } from "./draft-review.js";
import { appendLaneDrafts } from "./draft-search.js";
// #305: subpath leafs, never the core barrel — measured +40ms of process
// start against +0.8ms for the three leafs, on a fresh spawn per event.
import { detectProjectDetailed } from "@bastra-recall/core/topics";
import { projectForLane } from "./scope-filter.js";
import { isUnfused } from "./hook-recall-response.js";
import { randomUUID } from "node:crypto";
import { envInt } from "./env.js";
import { buildOnboardingBlock } from "./session-onboarding-block.js";
import { recordBudgetShadow, resetBudgetOnSource } from "./session-budget.js";
import { pendingModelNotice, type ModelOffer } from "./model-recommendation.js";
import { appendModelSessionNotice } from "./model-session-notice.js";
import {
  careBlockFor,
  dokuBlockFor,
  importBlockFor,
  languageBlock,
  patchBlock,
  pendingRelayBlocks,
  updateBlockFor,
} from "./session-lane-blocks.js";
import {
  bookPendingMustLoad,
  bumpShown,
  bumpTaskGeneration,
  clearShown,
  loadSessionState,
  mutateSessionState,
  takeConstantCadence,
  type ActiveConvention,
} from "./session-state.js";
import { renderRuleKernel, type RenderedKernel } from "./rule-kernel.js";
import { isGatedHint } from "./hook-recall-response.js";
import { rememberSessionStartKernel } from "./rule-kernel-seen.js";
import { getPrimaryLanguage } from "./settings.js";
import { formatPinnedBlock, dropPinnedFromRanked, type PinnedFloorLean } from "./pinned-block.js";
import { reportHinted } from "./hook-hinted.js";
import { hookGateAvailable, hookCaller, hookClient, hookAgent, hookClientEvidence } from "./hook-surface.js";
import type { Residency, WarmupCoordinator } from "./embedding-warmup.js";
// #493: die datensparsame Kennung dieses Hosts — Tor 5 aus #492.
import { hostProfileId } from "./host-profile.js";
import {
  postSessionContext,
  probeHealth,
  type ConventionLean,
  type HealthResponse,
  type RecallResponse,
  type SessionContextResponse,
} from "./session-hook-http.js";
import { SCORE_FLOOR, formatBlock, formatTaxonomyBlock, mergeSessionHits } from "./session-format.js";
import {
  tokensByPart,
  writeTelemetry,
  type SessionContextPart,
  type SessionHookTelemetry,
} from "./session-lane-telemetry.js";

// #680: merging/formatting and the telemetry row live in their own modules;
// the lane's public surface is re-exported unchanged.
export { formatBlock, mergeSessionHits } from "./session-format.js";
export { SESSION_CONTEXT_PARTS, tokensByPart, type SessionContextPart } from "./session-lane-telemetry.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", SESSION_START_BUDGET_MS, "NEXUS_HOOK_TIMEOUT_MS");

/**
 * Deadline des dichten Arms für DIESE Lane, in ms (Daniel, 07.09.2026).
 *
 * Der hookweite Default liegt bei 150 ms (`http-hook-routes.ts`,
 * `BASTRA_VECTOR_DEADLINE_MS`) und ist auf die Prompt-Lane zugeschnitten, die
 * einen Prewarmer vor sich hat. Der SessionStart hat keinen: der erste Embed
 * läuft auf kaltem Modell und braucht gemessene ~160-180 ms, weshalb 46 % der
 * Session-Recalls (55 von 119, Logs 06.-07.09.2026) einarmig als rohes BM25
 * zurückkamen.
 *
 * Die Zahl ist 350 und nicht 300, weil 300 den schlimmsten gemessenen Fall
 * noch verfehlt: Nach einem vollständigen `ollama stop embeddinggemma` — das
 * Modell also nicht bloß unbenutzt, sondern aus dem Speicher geworfen —
 * brauchte der erste Embed am 07.09.2026 gemessene 313 und 327 ms
 * (`vector_search_ms` zweier Recalls desselben SessionStarts). 350 deckt auch
 * diesen Fall und bleibt im Lane-Timeout für Sitzungsstarts (`HOOK_TIMEOUT_MS`), das
 * hier die tatsächliche Wanduhr ist.
 *
 * Ausdrücklich nur hier gesetzt und nicht am Endpunkt-Default: die
 * Prompt-Lane, der Bash-Pfad und der hooklose GET-Weg behalten ihre 150 ms.
 *
 * Und ausdrücklich OHNE Env-Schalter (Veras Gegenreview): Die Zahl ist eine
 * getroffene Entscheidung, kein Vorschlag. Als `envInt(...)` hätte eine
 * geerbte Dienstkonfiguration sie still auf 150 zurückgedreht — jeder
 * SessionStart hätte wieder die alte Deadline geschickt, und keine Zeile in
 * der Telemetrie hätte gesagt, dass die Entscheidung gar nicht wirkt. Wer sie
 * ändern will, ändert diese Zahl.
 */
const SESSION_VECTOR_DEADLINE_MS = 350;

/**
 * Das Budget, gegen das der Schatten-Router für DIESE Lane rechnet, in ms
 * (Daniel, 07.09.2026, unter der Auflage „macht nichts langsamer").
 *
 * `BASTRA_HOOK_BUDGET_MS` (200, `http-hook-routes.ts`) ist die Wanduhr der
 * Prompt-Lane. Diese Lane hat eine andere: ein eigenes Budget für die Wiederherstellung. Mit 350 ms
 * Reserve für den dichten Arm rechnet `lexicalFitsBudget` gegen die 200 immer
 * falsch (`max(lexikalisch, 350) + 7 > 200`) — die Schattenspalte stünde ab
 * sofort konstant auf `dense-primary` und würde für diese Lane nichts mehr
 * messen. Gegen 500 misst sie wieder die Termkosten, die sie messen soll.
 *
 * Der Wert ist rein diagnostisch: Er erreicht `routeRetrieval` und von dort
 * ausschließlich das `shadow_route`-Feld der Telemetrie. Kein Timeout, kein
 * Abbruch, keine Trefferauswahl hängt daran (#362 Phase 2 ist Schatten,
 * gegengeprüft von Vera am 07.09.2026).
 *
 * Fest verdrahtet wie die 350 darüber, aus demselben Grund.
 */
const SESSION_HOOK_BUDGET_MS = HOOK_TIMEOUT_MS;

/**
 * Was diese Lane tut, wenn das Modell NICHT im Speicher liegt: GAR KEINEN
 * dichten Arm starten (#494).
 *
 * Die 350 ms oben sind für ein WARMES Modell bemessen (33-54 ms gemessen am
 * 08.09.2026). Ein kaltes braucht 585 ms und reißt sie sicher; sie warm-blind
 * trotzdem zu verwarten hieße, 350 ms der 500-ms-Wanduhr zu verbrennen und am
 * Ende dasselbe einarmige Ergebnis zu liefern.
 *
 * #490 zog daraus die halbe Konsequenz — 50 ms statt 350 — und konnte nicht
 * mehr: `search.ts` lag damals bei #489, also gab es keinen Weg, den Arm
 * abzuwählen. Als EINZIGER aufgegebener Embed wäre das sogar nützlich gewesen,
 * denn `abandonAfter` bricht nicht ab (deadline.ts): Der aufgegebene Call lädt
 * das Modell zu Ende. Nur ist er hier nicht einzeln — dieser Sitzungsstart
 * feuert bis zu DREI Recalls parallel, und der Koordinator startet daneben
 * ohnehin den Warmup, der genau dasselbe Modell lädt. Vier Embeds für einen
 * Ladevorgang.
 *
 * Also: `lexical_only`. Der Warmup lädt (einmal, singleflight, #494), die Lane
 * antwortet sofort lexikalisch und sagt im Block ehrlich, warum
 * (`unfusedHeadline(..., "cold-model")`). Ab dem zweiten Recall derselben
 * Sitzung ist fusioniert — unverändert die Zusage aus #490.
 */
const TOTAL_HINTS_CAP = 7;

export interface SessionPayload {
  bastra_client?: string;
  bastra_codex_version?: string;
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  /** #1303: `fork` — a new session id started from a copied transcript;
   *  handled like `startup` (nothing to release, the new id has no state). */
  source?: "startup" | "resume" | "clear" | "compact" | "fork";
}

type LaneStatus = "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error";
type SessionHit = ReturnType<typeof mergeSessionHits>[number];
type ScopedRecall = { scope: string; resp: RecallResponse | null };

/**
 * Run the SessionStart pipeline and return the exact JSON string the thin
 * client writes to stdout. Never throws; every failure degrades to `{}` plus
 * telemetry, matching the CLI's fail-open contract.
 */
export async function runSessionLane(
  payload: SessionPayload,
  selfBaseUrl: string,
  /** #490: der gemeinsame Warmup. Fehlt er (keine Embeddings, Tests), verhält
   *  sich die Lane exakt wie vor #490 — volle 350 ms für den dichten Arm. */
  warmup?: WarmupCoordinator,
  /** Tests inject an open model recommendation; the shipped one is the default. */
  modelNotice: () => Promise<ModelOffer | null> = pendingModelNotice,
  draftReview?: () => Promise<DraftReviewDelivery>
): Promise<string> {
  const startedAt = Date.now();
  // #1674: the budget's remainder runs on a monotonic clock; startedAt stays the telemetry stamp.
  const startedMono = performance.now();
  if (payload.hook_event_name !== "SessionStart") return "{}";
  const start = openSessionStart(payload, selfBaseUrl, startedAt, warmup);
  const kernelActive = await resetForLifecycle(payload);

  // §20.5: Eine geratene Erkennung ist kein Projekt. `detectProject()` machte
  // aus einem cwd ohne `.git` und ohne Container-Segment — `~/.buzz` — das
  // Projekt ".buzz" und die Lane fragte Kandidaten dafür ab und schrieb es als
  // `project=` in den Block. `projectForLane` liefert dort null: keine
  // Projekt-Query, kein Projekt-Attribut.
  const cwd = payload.cwd ?? process.cwd();
  const project = projectForLane(cwd);
  // #511: doku is per-project docs — inject only for a REAL repo (git-root),
  // not the `root-match` container dirs (`~/Projekte`) that projectForLane
  // still admits for scoping. Confidence is read here for the doku gate.
  const projectConfidence = detectProjectDetailed(cwd).confidence;

  const fetched = await fetchSessionContext(payload, start.url, startedMono, project, {
    denseCold: start.denseCold,
    sessionStartCallId: start.sessionStartCallId,
    kernelActive,
  });
  const ranked = rankSessionHits(fetched.responses, fetched.sideData, project);
  const standing = await collectStandingBlocks(payload, fetched, project, projectConfidence, draftReview);
  const kernel = renderKernel(
    fetched.sideData,
    payload.source,
    start.denseCold,
    await getPrimaryLanguage().catch(() => undefined)
  );
  const soulBlock = buildSoulBlock(await readSoulPreference());

  // #1303/#1304: only deny-capable registrations book must-load hints.
  const gated = new Set(hookGateAvailable(payload) ? ranked.top.filter(isGatedHint).map((h) => h.id) : []);
  const assembled = assembleSessionContext(
    { payload, client: start.client, denseCold: start.denseCold, project, responses: fetched.responses },
    ranked,
    standing,
    kernel,
    soulBlock,
    gated
  );
  const { out, injected } = await finishSessionOutput(start, fetched, ranked, standing, assembled, {
    modelNotice,
    protectedParts: [kernel.text, standing.language, soulBlock],
  });
  const retained = (part: string) => (part.trim() && injected.includes(part.trim()) ? part : "");
  await rememberSessionStartKernel(payload, kernel.text, injected).catch(() => {});
  const deliveredTop = retained(assembled.recallBlock) ? ranked.top : [];

  // #458 (shadow): den fertigen Block ans Sitzungsbudget anrechnen und den
  // Governor-Entscheid loggen — nichts wird gekürzt.
  recordBudgetShadow(payload.session_id ?? null, "session_hook_call", Math.ceil(injected.length / 4), {
    source: payload.source ?? null,
  });
  await writeTelemetry(
    sessionTelemetryRow(start, { project, fetched, ranked, standing, kernel, assembled, injected, deliveredTop })
  );
  // Usage sidecar (#154): only what was ACTUALLY injected counts as surfaced.
  await reportHinted(
    start.url,
    deliveredTop.map((h) => h.id),
    payload.session_id ?? null
  );
  await bookDelivered(payload.session_id, deliveredTop, gated, startedAt);
  return out;
}

/** Who is calling and how warm the embedding model is, fixed at the start. */
interface SessionStart {
  payload: SessionPayload;
  /** The self-call target is passed in by the route (this server's own
   *  address), not read from the environment: the lane IS the daemon. */
  url: string;
  startedAt: number;
  client: ReturnType<typeof hookClient>;
  /** #507 Nachbesserung: nur für die Telemetrie-Dimension — `client` bleibt
   *  der surface-Default fürs Hint-Block-Attribut und den Recall-Loopback. */
  clientEvidence: ReturnType<typeof hookClientEvidence>;
  agent: ReturnType<typeof hookAgent>;
  sessionStartCallId: string;
  residency: Residency | null;
  residencyReading: ReturnType<WarmupCoordinator["residencyDetail"]> | null;
  denseCold: boolean;
}

function openSessionStart(
  payload: SessionPayload,
  url: string,
  startedAt: number,
  warmup: WarmupCoordinator | undefined
): SessionStart {
  // #493: Die Klammer um die (bis zu drei) Recalls DIESES Sitzungsstarts. Ein
  // Start feuert mehrere korrelierte Recalls; ohne die Klammer ist „20
  // Kaltstarts" nicht von „7 Kaltstarts × 3 Recalls" zu unterscheiden. Die
  // `session_id` leistet das nicht: Sie überlebt compact/clear/resume und
  // damit beliebig viele Starts.
  //
  // #495: Steht VOR dem Sitzungskontakt, weil der Warmup sie mitbekommt —
  // seit #494 verschluckt genau er den Kaltstart, den der dichte Arm nicht
  // mehr bezahlt, und sein Settle muss dem Start zuzuordnen sein, der ihn
  // ausgelöst hat.
  const sessionStartCallId = randomUUID();
  // #490: DER erste Sitzungskontakt. Ein Aufruf, zwei Wirkungen: Er sagt, ob
  // das Modell im Speicher liegt, und startet — wenn nicht — den gemeinsamen
  // Ladevorgang NEBEN diesem Recall statt darin. Mehrere gleichzeitig
  // startende Sitzungen teilen sich dabei EINEN Warmup (Koordinator hält das
  // In-Flight-Flag), sonst bekäme eine kalte Maschine einen Embed-Sturm genau
  // dann, wenn sie am langsamsten ist. Kein Await: Die Lane wartet nie auf ein
  // Modell-Laden (#490, ausdrücklich abgelehnt).
  const residency: Residency | null = warmup?.onSessionContact(sessionStartCallId) ?? null;
  return {
    payload,
    url,
    startedAt,
    client: hookClient(payload),
    clientEvidence: hookClientEvidence(payload),
    agent: hookAgent(payload),
    sessionStartCallId,
    residency,
    // #493: Woher diese Antwort stammt und ob sie geschätzt ist. Tor 3 aus #492
    // zählt echte Kaltstarts und darf auf geschätzten Zeilen nicht zählen.
    residencyReading: warmup?.residencyDetail() ?? null,
    // „Unbekannt" zählt wie kalt: Ohne einen einzigen erfolgreichen Embed in
    // diesem Prozess ist die einzige sichere Annahme die teure.
    denseCold: residency === "cold" || residency === "unknown",
  };
}

/**
 * The model notice, the drafts and the context cap, in that order. The model
 * notice has its own user-wide day marker; it is claimed only after the
 * response is assembled, with an immediate, silent try-lock. The cap defers
 * only whole optional sections, keeps the kernel/language complete and names
 * every deferred protocol section in the suffix.
 */
async function finishSessionOutput(
  start: SessionStart,
  fetched: FetchedContext,
  ranked: RankedHits,
  standing: StandingBlocks,
  assembled: AssembledContext,
  opts: { modelNotice: () => Promise<ModelOffer | null>; protectedParts: string[] }
): Promise<{ out: string; injected: string }> {
  let { out, injected } = assembled;
  const modelNoticeOutput = await appendModelSessionNotice(out, opts.modelNotice);
  if (modelNoticeOutput.block) {
    out = modelNoticeOutput.stdout;
    injected = String(JSON.parse(out).hookSpecificOutput.additionalContext);
    standing.update += modelNoticeOutput.block;
  }
  out = await appendLaneDrafts(
    out,
    "SessionStart",
    fetched.queries.map((q) => q.query),
    start.payload.session_id,
    ranked.top,
    2,
    false,
    undefined,
    start.startedAt + HOOK_TIMEOUT_MS
  );
  if (out === "{}") return { out, injected };
  const parsed = JSON.parse(out);
  const context = parsed.hookSpecificOutput?.additionalContext;
  if (typeof context !== "string") return { out, injected };
  const capped = capSessionContext(context, opts.protectedParts);
  parsed.hookSpecificOutput.additionalContext = capped.text;
  return { out: JSON.stringify(parsed), injected: capped.text };
}

/** The `session_hook_call` row: what was asked, what came back, what reached the context. */
function sessionTelemetryRow(
  start: SessionStart,
  r: {
    project: string | null;
    fetched: FetchedContext;
    ranked: RankedHits;
    standing: StandingBlocks;
    kernel: RenderedKernel;
    assembled: AssembledContext;
    injected: string;
    deliveredTop: SessionHit[];
  }
): SessionHookTelemetry {
  const { payload } = start;
  const { fetched, ranked, standing, kernel, injected, deliveredTop } = r;
  const retained = (part: string) => (part.trim() && injected.includes(part.trim()) ? part : "");
  return {
    session_id: payload.session_id ?? null,
    client: start.clientEvidence,
    agent: start.agent,
    source: payload.source ?? null,
    project: r.project,
    queries: fetched.queries.length,
    daemon_url: start.url,
    daemon_reachable: fetched.responses.some((x) => x.resp !== null),
    hint_count: deliveredTop.length,
    convention_count: retained(standing.taxonomy) ? standing.conventions.length : 0,
    pinned_count: retained(ranked.pinnedBlock) ? ranked.pinned.length : 0,
    top_score: ranked.top[0]?.score ?? null,
    latency_ms_total: Date.now() - start.startedAt,
    degraded_reason: ranked.degradedReason,
    score_unfused: ranked.unfused,
    ...residencyFields(start),
    session_start_call_id: start.sessionStartCallId,
    host_profile_id: hostProfileId(),
    hint_tokens_est: Math.ceil(injected.length / 4),
    // #462: dieselbe Schätzung je Teil. Nichts injiziert = alle Teile 0.
    hint_tokens_by_part: tokensByPart(
      injected === "" ? {} : retainedParts(retained, kernel, ranked, r.assembled.recallBlock, standing)
    ),
    hinted_ids: deliveredTop.map((h) => h.id),
    hinted_types: deliveredTop.map((h) => h.type),
    pending_lanes: standing.pendingLanes,
    ...(standing.pendingHarvest > 0 ? { pending_harvest: standing.pendingHarvest } : {}),
    constants_skipped: standing.constantsSkipped,
    kernel: kernelTelemetry(kernel, fetched.sideData),
    status: r.assembled.emptyAnswer && fetched.status === "ok" ? "no-hits" : fetched.status,
    error: fetched.errMsg,
  };
}

/** #490/#493: how warm the model was, and whether that reading is an estimate. */
function residencyFields(start: SessionStart) {
  return {
    embedding_residency: start.residency,
    embedding_residency_source: start.residencyReading?.source ?? null,
    embedding_residency_estimated: start.residencyReading?.estimated ?? null,
  };
}

/** #1305: which rules the kernel delivered in full, degraded or left out. */
function kernelTelemetry(kernel: RenderedKernel, sideData: SessionContextResponse["data"]) {
  return {
    full_ids: kernel.full,
    degraded_ids: kernel.degraded,
    omitted: kernel.omitted,
    paged_index: kernel.paged_index,
    unconfirmed_legacy: sideData?.kernel?.unconfirmed_legacy,
    chars: kernel.text.length,
  };
}

/**
 * #354: compact/clear keep the session id but rebuild the context,
 * so every hint the per-session dedup was holding back is gone from the
 * context. Verified over all Aug/Sep session starts: ids like 01a05b6f carry
 * `startup,compact,compact`. Releasing the counters here is what lets the 4h
 * window go — it was the only thing covering this case, and it paid for that
 * coverage with a re-injection into every session that merely ran long.
 * "startup" is a fresh id and needs nothing; best-effort, never blocking.
 * #509: the two halves below used to disagree — the budget reset only on
 * `clear`, the dedup was released on compact, clear AND resume. Settled on
 * Claude Code's documented behaviour: `/compact` replaces the history with a
 * summary (anything given only in conversation, hook context included, is
 * gone), `/clear` empties it, `resume` restores the transcript intact. So
 * compact and clear release both; resume releases neither.
 * Rulebook A+B is delivered on every lifecycle entry, including startup
 * and resume. Active membership is read before compact/clear/fork reset it,
 * and returned for the rule kernel.
 */
async function resetForLifecycle(payload: SessionPayload): Promise<ActiveConvention[]> {
  let kernelActive: ActiveConvention[] = [];
  if (payload.session_id) {
    try {
      kernelActive = [...((await loadSessionState(payload.session_id)).activeConventions ?? [])];
    } catch {
      /* no state, no active conventions — floors, reflex and user rules still come */
    }
    // #1306: a new generation of the task state — the task and its conventions
    // carry over, pending correspondence context does not.
    if (payload.source === "compact" || payload.source === "clear" || payload.source === "fork") {
      await resetRulebookContext(payload.session_id);
      await bumpTaskGeneration(payload.session_id);
    }
  }
  resetBudgetOnSource(payload.session_id, payload.source);
  if (payload.source === "compact" || payload.source === "clear") {
    try {
      await clearShown(payload.session_id ?? "");
    } catch {
      /* dedup is best-effort by construction — a stale counter costs tokens, not correctness */
    }
  }
  return kernelActive;
}

interface FetchedContext {
  queries: Array<{ scope: string; query: string; k: number }>;
  /** In query order — the priority `mergeSessionHits` ranks by. */
  responses: ScopedRecall[];
  sideData: SessionContextResponse["data"];
  status: LaneStatus;
  errMsg: string | null;
  /** Started beside the assembler call; awaited only once the daemon answered. */
  healthPromise: Promise<HealthResponse | null>;
}

/**
 * #265/§26.1: EIN Aufruf gegen den projektbewussten Assembler statt sechs
 * einzelner Loopback-Requests. Der Assembler erhebt Recalls, Floors,
 * Taxonomie, Care, Import und Onboarding serverseitig und nebenläufig — und
 * fährt dabei DIESELBE Recall-Pipeline wie `/hook/recall` (Scope-Filter
 * #110/#148, Reflex-Hits, Router-Schatten #362), weshalb die Trefferauswahl
 * dieselbe bleibt.
 *
 * Was der Assembler nicht abdeckt, bleibt in der Lane: der Health-Probe für
 * den Update-Block, Doku, Pending, Patch — und das gesamte Rendern. Die Lane
 * bandet und formuliert selbst; sie holt Daten, keine fertigen Zeilen.
 */
async function fetchSessionContext(
  payload: SessionPayload,
  url: string,
  /** `performance.now()` at the lane's start (#1674). */
  startedMono: number,
  project: string | null,
  call: { denseCold: boolean; sessionStartCallId: string; kernelActive: ActiveConvention[] }
): Promise<FetchedContext> {
  const queries: FetchedContext["queries"] = [
    { scope: "user-preference", query: "session-start preferences active context", k: 3 },
    { scope: "all-projects", query: "cross-project working rules", k: 2 },
  ];
  if (project) {
    queries.push({ scope: project, query: `${project} active context project-facts decisions`, k: 3 });
  }
  let status: LaneStatus = "ok";
  let errMsg: string | null = null;
  const recallByScope = new Map<string, RecallResponse | null>();
  let sideData: SessionContextResponse["data"] = undefined;
  // Der Health-Probe gehört zum Update-Block, den der Assembler nicht abdeckt —
  // er hängt aber an keiner seiner Ausgaben. Also läuft er NEBEN dem
  // Assembler-Aufruf und nicht danach; sonst hätte der Umbau die Nebenläufigkeit
  // aus Teilpaket 1 gegen einen zweiten Round Trip eingetauscht.
  const probeBudget = Math.min(200, Math.max(80, HOOK_TIMEOUT_MS - (performance.now() - startedMono)));
  const healthPromise = probeHealth(url, probeBudget).catch(() => null);
  const remainingMs = Math.max(60, HOOK_TIMEOUT_MS - (performance.now() - startedMono));
  try {
    const resp = await postSessionContext(
      url,
      {
        project,
        source: payload.source ?? null,
        ...hookCaller(payload),
        // Nur die Lane fragt die Cross-Project-Regeln.
        cross_project: true,
        // Die Mengen dieses Dokuments, ausdrücklich gesetzt: Der Endpunkt hat
        // eigene Vorgaben (4 Konventionen, 5 Floors), und ein Umzug ohne
        // diese Zeilen wäre eine stille Produktänderung. `0` = ungekappt.
        caps: { conventions: 6, pinned: 0 },
        // Siehe SESSION_VECTOR_DEADLINE_MS: die Lane kauft ihrem dichten Arm
        // mehr Zeit als der Hook-Default, und zwar nur für sich. #494: aber
        // nur, wenn das Modell im Speicher liegt — sonst läuft gar kein
        // dichter Arm und es gibt keine Frist zu setzen (`lexical_only`).
        ...(call.denseCold ? { lexical_only: true } : { vector_deadline_ms: SESSION_VECTOR_DEADLINE_MS }),
        // Siehe SESSION_HOOK_BUDGET_MS: der Schatten-Router soll gegen die
        // Wanduhr DIESER Lane rechnen, nicht gegen die der Prompt-Lane.
        hook_budget_ms: SESSION_HOOK_BUDGET_MS,
        // #493: siehe `sessionStartCallId` in runSessionLane.
        session_start_call_id: call.sessionStartCallId,
        kernel: { active: call.kernelActive },
        budget: { time_ms: remainingMs },
      },
      remainingMs
    );
    sideData = resp.data;
    for (const r of resp.data?.recalls ?? []) {
      recallByScope.set(r.scope, r.resp ?? null);
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "EHOSTUNREACH") {
      status = "daemon-unreachable";
    } else if (e.message === "timeout") {
      status = "timeout";
    } else {
      status = "error";
      errMsg = e.message ?? String(err);
    }
  }
  // Die Reihenfolge ist Priorität für `mergeSessionHits` — sie kommt aus
  // `queries` und nicht aus der Antwort, deren Reihenfolge den Assembler
  // beschreibt, nicht diese Lane.
  const responses = queries.map((q) => ({ scope: q.scope, resp: recallByScope.get(q.scope) ?? null }));
  return { queries, responses, sideData, status, errMsg, healthPromise };
}

interface RankedHits {
  unfused: boolean;
  degradedReason: string | null;
  pinned: PinnedFloorLean[];
  pinnedBlock: string;
  /** The score-gated hints after the pinned overlap, capped at TOTAL_HINTS_CAP. */
  top: SessionHit[];
}

/** Merge the scoped recalls, render the pinned block and keep the ranked rest. */
function rankSessionHits(
  responses: ScopedRecall[],
  sideData: SessionContextResponse["data"],
  project: string | null
): RankedHits {
  // P0: Der Score-Modus gilt für den GANZEN Block, und zwar fail-closed —
  // sobald EINE der (bis zu drei) Antworten unfusioniert ist, sind die Zahlen
  // untereinander nicht mehr vergleichbar. Nachgestellt: bei einem rohen
  // BM25-Score von 405585 behauptete diese Lane „Both search paths agreed …
  // score ≥100", obwohl genau ein Pfad lief.
  const unfused = responses.some((r) => r.resp !== null && isUnfused(r.resp));
  const merged = mergeSessionHits(responses, unfused, SCORE_FLOOR);

  // Deep-Dive 07.09.2026: Ein einarmiger SessionStart stand in der Telemetrie
  // als schlichtes `ok`. Das war nicht falsch, es beschrieb nur etwas anderes:
  // `status` sagt, ob die ANTWORT ankam, nicht ob sie vollständig war. Deshalb
  // bleibt `status` unverändert — jede bestehende Auswertung zählt weiter
  // dasselbe — und daneben stehen die zwei Felder, die die Antwort selbst
  // beschreiben: WARUM ein Arm fehlte und OB die Zahlen auf der fusionierten
  // Skala liegen. Die zweite Frage ist nicht aus der ersten ableitbar: ohne
  // Embeddings läuft die Suche einarmig, ohne dass ein Arm ausgefallen wäre,
  // und dann gibt es keinen `degraded`-Grund zu melden.
  //
  // Bis zu drei Recalls stehen hier nebeneinander; gemeldet wird der erste
  // Grund, den einer von ihnen nennt. Der Block wird als Ganzes injiziert und
  // `unfused` gilt ohnehin fail-closed für den ganzen Block.
  const degradedReason = responses.find((r) => typeof r.resp?.degraded === "string")?.resp?.degraded ?? null;

  // Floor-Registry (#141/#142): gepinnte Memories — push-by-state, bewusst
  // NICHT score-gated (gleiches Muster wie der Taxonomie-Block: dedizierter
  // Listen-Endpoint statt Recall-Suche; ein Constraint darf nicht am Floor
  // sterben, dessen Job es ist, präsent zu sein, wenn der Turn ihn nicht für
  // relevant hält). Dedup-Verifikation: der Session-Hook wendet KEINEN
  // session-state-Dedup an (shouldDropHit lebt ausschließlich im PreToolUse-
  // Hook, hook.ts) — gepinnte Einträge können hier also nie weggededupt
  // werden. Der einzige Dedup läuft in die GEGENrichtung: dropPinnedFromRanked
  // entfernt ranked-Duplikate, damit die Hint-Liste kein Budget doppelt auf
  // bereits garantierte Einträge ausgibt.
  // #265: Floors kamen mit derselben Antwort wie die Recalls.
  let pinned: PinnedFloorLean[] = sideData?.floors ?? [];
  // Ohne erkanntes Projekt injizieren nur globale (unscoped) Floors —
  // fremd-gescopte Einträge wären in einer projektlosen Session Rauschen.
  if (!project) pinned = pinned.filter((e) => !e.scope);
  // dropPinnedFromRanked only sees entries the block actually SHOWED
  // (`.included`) — an entry the 1200-char budget truncated out of the
  // pinned block must stay eligible for a ranked hint slot, or it vanishes
  // from both surfaces at once instead of falling back to the other one.
  const { text: pinnedBlock, included: pinnedIncluded } = formatPinnedBlock(pinned);
  const top = dropPinnedFromRanked(merged, pinnedIncluded).slice(0, TOTAL_HINTS_CAP);
  return { unfused, degradedReason, pinned, pinnedBlock, top };
}

/** The blocks around the hints, in the order they join the context. */
interface StandingBlocks {
  conventions: ConventionLean[];
  taxonomy: string;
  language: string;
  care: string;
  import: string;
  onboarding: string;
  /** Mutable: the model notice joins it after assembly (#462 per-part tokens). */
  update: string;
  patch: string;
  review: string;
  pending: string;
  doku: string;
  pendingLanes: SessionHookTelemetry["pending_lanes"];
  pendingHarvest: number;
  constantsSkipped: string[];
}

/**
 * #265: Floors, Taxonomie, Care, Import und Onboarding kamen mit derselben
 * Antwort wie die Recalls — kein eigener Abruf mehr. Jeder Teil hat seinen
 * eigenen Fallback statt eines gemeinsamen try/catch: Ein fehlender Teil darf
 * die anderen nicht mitreißen. Der Health-Probe bleibt: Er gehört zum
 * Update-Block, den der Assembler nicht abdeckt, und wird nur abgewartet,
 * wenn der Daemon überhaupt antwortete.
 */
async function collectStandingBlocks(
  payload: SessionPayload,
  fetched: FetchedContext,
  project: string | null,
  projectConfidence: Parameters<typeof dokuBlockFor>[1],
  draftReview?: () => Promise<DraftReviewDelivery>
): Promise<StandingBlocks> {
  const { sideData } = fetched;
  const reachable = fetched.responses.some((r) => r.resp !== null);
  const health = reachable ? await fetched.healthPromise : null;
  // Taxonomie-Konventionen (#66): bindende, selbst-gelernte Struktur-Regeln
  // des Vaults. Dedizierter Listen-Endpoint statt Recall-Suche — Konventionen
  // konkurrieren nicht über Scores und dürfen nicht am Floor sterben.
  const conventions: ConventionLean[] = sideData?.conventions ?? [];
  const update = await updateBlockFor(health, payload.source);
  const patch = patchBlock();
  const relay = await pendingRelayBlocks(payload.session_id, payload.source, payload.cwd, draftReview);
  const blocks: StandingBlocks = {
    conventions,
    taxonomy: formatTaxonomyBlock(conventions),
    language: "",
    care: careBlockFor((sideData?.care ?? { open: 0, queued: 0 }).open),
    import: importBlockFor(sideData?.imports ?? { open: 0, queued: 0 }),
    // Onboarding interview: a fresh vault (few memories, no marker) gets to
    // seed itself — the session model interviews adaptively, which no form
    // can. #308: the instruction text, and why it is an instruction rather
    // than an offer, lives in session-onboarding-block.ts.
    onboarding: buildOnboardingBlock(sideData?.onboarding ?? false, sideData?.onboarding_line ?? false),
    update,
    patch,
    review: relay.reviewBlock,
    pending: relay.pendingBlock,
    doku: await dokuBlockFor(project, projectConfidence),
    pendingLanes: relay.pendingLanes,
    pendingHarvest: relay.pendingHarvest,
    constantsSkipped: [],
  };
  blocks.language = await languageBlock();
  blocks.constantsSkipped = await applyConstantCadence(payload.session_id ?? "", blocks);
  return blocks;
}

/**
 * #509: the #462 cadence — taxonomy, doku and language go out "on change
 * only". They are near-constants (two, four and one distinct values over 141
 * starts); a start whose context still carries the identical text (a resume,
 * or a repeated startup under the same id) leaves them out. compact/clear
 * emptied the record in resetForLifecycle, so they are sent again there.
 */
async function applyConstantCadence(sessionId: string, blocks: StandingBlocks): Promise<string[]> {
  try {
    const skip = await takeConstantCadence(sessionId, {
      taxonomy: blocks.taxonomy,
      doku: blocks.doku,
      language: blocks.language,
    });
    if (skip.has("taxonomy")) blocks.taxonomy = "";
    if (skip.has("doku")) blocks.doku = "";
    if (skip.has("language")) blocks.language = "";
    return [...skip].sort();
  } catch {
    /* cadence is best-effort — a failed read re-sends, it never drops */
    return [];
  }
}

/**
 * #1305: the rule kernel heads the block. Rendered here from the daemon's
 * candidates; a cold dense arm says so, the kernel itself never needs one.
 */
function renderKernel(
  sideData: SessionContextResponse["data"],
  source: SessionPayload["source"],
  denseCold: boolean,
  language: string | undefined
): RenderedKernel {
  if (sideData?.kernel) {
    return renderRuleKernel(sideData.kernel, {
      trigger: `after ${source ?? "startup"}`,
      lexicalOnly: denseCold,
      language,
    });
  }
  return {
    text: "Rulebook unavailable at session start; the complete catalog remains available through list_rules().\n",
    full: [],
    degraded: [],
    omitted: 0,
  };
}

/** The assembled answer before the model notice, the drafts and the cap. */
interface AssembledContext {
  out: string;
  injected: string;
  /** #462: der Recall-Block einmal gebaut, damit er als eigener Posten messbar ist. */
  recallBlock: string;
  /** Nothing at all to inject — the lane answers `{}`. */
  emptyAnswer: boolean;
}

function assembleSessionContext(
  call: {
    payload: SessionPayload;
    client: ReturnType<typeof hookClient>;
    denseCold: boolean;
    project: string | null;
    responses: ScopedRecall[];
  },
  ranked: RankedHits,
  standing: StandingBlocks,
  kernel: RenderedKernel,
  soulBlock: string,
  gated: Set<string>
): AssembledContext {
  const kernelHead = kernel.text === "" ? "" : kernel.text + "\n";
  const extras =
    standing.taxonomy +
    standing.language +
    soulBlock +
    standing.care +
    standing.import +
    standing.onboarding +
    standing.update +
    standing.patch +
    standing.review +
    standing.pending +
    standing.doku;
  const { top, pinnedBlock } = ranked;
  if (top.length === 0 && pinnedBlock === "" && extras === "" && kernel.text === "") {
    return { out: "{}", injected: "", recallBlock: "", emptyAnswer: true };
  }
  if (top.length === 0) {
    // Only pinned entries, conventions and/or an update banner, no recall hits.
    const injected = (kernelHead + pinnedBlock + extras).trimStart();
    return { out: sessionOutput(injected), injected, recallBlock: "", emptyAnswer: false };
  }
  // #249: three scope-filtered recalls feed this block. Weak only when EVERY
  // answered one is weak — a single lexically anchored scope means there is
  // real signal here, and framing the whole block as noise would hide it.
  const answered = call.responses.filter((r) => r.resp !== null);
  const allWeak = answered.length > 0 && answered.every((r) => r.resp!.weak_result === true);
  const recallBlock = formatBlock(
    top,
    call.project,
    call.payload.source ?? null,
    allWeak,
    ranked.unfused,
    call.client,
    // #490: Ehrlichkeit im Block. Einarmig UND das Modell war kalt → sag
    // genau das, statt „semantic search is off" zu behaupten.
    call.denseCold ? "cold-model" : "off",
    gated
  );
  // #141/#142: der Pinned-Block steht VOR den score-gated Hints — die
  // garantierten Einträge zuerst, die relevanz-gerankte Liste dahinter.
  const pinnedHead = pinnedBlock === "" ? "" : pinnedBlock + "\n";
  const injected = kernelHead + pinnedHead + recallBlock + extras;
  return { out: sessionOutput(injected), injected, recallBlock, emptyAnswer: false };
}

function sessionOutput(injected: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: injected,
    },
  });
}

/** #462: each part as far as it survived into the injected text. */
function retainedParts(
  retained: (part: string) => string,
  kernel: RenderedKernel,
  ranked: RankedHits,
  recallBlock: string,
  standing: StandingBlocks
): Partial<Record<SessionContextPart, string>> {
  return {
    kernel: retained(kernel.text),
    pinned: retained(ranked.pinnedBlock),
    recalls: retained(recallBlock),
    taxonomy: retained(standing.taxonomy),
    language: retained(standing.language),
    care: retained(standing.care),
    import: retained(standing.import),
    onboarding: retained(standing.onboarding),
    update: retained(standing.update),
    patch: retained(standing.patch),
    pending: retained(standing.pending),
    doku: retained(standing.doku),
  };
}

/**
 * #621: what this start put into the context counts as delivered for the
 * PreToolUse and prompt dedup as well — the #354 rule the other lanes follow.
 */
async function bookDelivered(
  sessionId: string | undefined,
  deliveredTop: SessionHit[],
  gated: Set<string>,
  startedAt: number
): Promise<void> {
  if (!sessionId || deliveredTop.length === 0) return;
  try {
    await mutateSessionState(sessionId, (s) => {
      for (const h of deliveredTop) bumpShown(s, h.id);
      // #1303: beside the shown-state, the must-load the gate will claim.
      bookPendingMustLoad(
        s,
        [...gated],
        `session:${startedAt.toString(36)}`,
        Date.now(),
        new Map(deliveredTop.map((h) => [h.id, h.revision ?? null]))
      );
    });
  } catch {
    // State is an optional dedup cache. Never discard the context that was
    // already assembled when its directory is unavailable.
  }
}
