import { beginRulebookRound, catalogFor, type CatalogProvider, type RulebookPayload } from "./rulebook-check.js";
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
import { appendLaneDrafts } from "./draft-search.js";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";

import { recordBudgetShadow } from "./session-budget.js";
import { claudeSessionPidFrom, sessionFeedPath, STATUSLINE_DIR } from "./statusline-session.js";
import { idleStatuslineState } from "./statusline-feed.js";
import { reportHinted } from "./hook-hinted.js";
import { hookGateAvailable, hookClient, hookAgent, hookClientEvidence } from "./hook-surface.js";
import { ownerPromptText } from "./system-turn.js";
import type { DeliveredPromptImpact } from "./code-graph/prompt-impact.js";
import { getPromptImpactEnabled } from "./code-graph/prompt-impact-settings.js";
import type { Prewarmer, PrewarmOutcome } from "./embedding-prewarm.js";
import {
  bumpShown,
  decideBackoff,
  loadSessionState,
  recordSourceEmit,
  recordSourceSuppressed,
  mutateSessionState,
  takeBoundary,
  takeParkedBoundary,
  wasEmitConsumed,
  bookPendingMustLoad,
  resetToolCalls,
  type ReadonlySessionState,
  type TakenBoundary,
} from "./session-state.js";
import { isGatedHint } from "./hook-recall-response.js";
import { MUST_LOAD_SCORE, extractPrompt, isTrivialPrompt, type ClaudeHookPayload } from "./prompt-classify.js";
import { formatHintBlock, formatReflexBlock, type PromptReflexHit, type RecallHit } from "./prompt-format.js";
import {
  emitTelemetry,
  gatedRow,
  recallTurnRow,
  logBoundaryDelivery,
  type PromptHookTelemetry,
} from "./prompt-lane-telemetry.js";
import {
  laneBudgetMs,
  runPromptSearch,
  selectPromptHints,
  type PromptHintSelection,
  type PromptSearch,
} from "./prompt-lane-search.js";
import type { ConventionSource } from "./convention-source.js";
import { runTaskStep } from "./prompt-task.js";

// #680: classification, formatting, telemetry and the loopback call live in
// their own modules; the lane's public surface is re-exported unchanged.
export {
  MUST_LOAD_SCORE,
  detectAssertion,
  detectRetrieval,
  effectiveScoreFloor,
  extractPrompt,
  isTrivialPrompt,
} from "./prompt-classify.js";
export type { ClaudeHookPayload, DetectedMode } from "./prompt-classify.js";
export { formatHintBlock, formatReflexBlock } from "./prompt-format.js";
export type { PromptReflexHit, RecallHit } from "./prompt-format.js";

// #161: backoff source key — prompt-lookup hints back off independently.
const BACKOFF_SOURCE = "prompt-lookup";

/**
 * #702: what a caller may hang on the lane besides the payload. Today one
 * hook: the replay route (`bastra doctor --replay`) takes the telemetry row
 * the lane wrote, so the CLI builds its report from the same numbers the log
 * holds instead of parsing the lane's stdout.
 */
export interface PromptLaneOptions {
  kernel?: CatalogProvider;
  /** Internal shared output budget; includes the rulebook round notice. */
  roundNotice?: string;
  onTelemetry?: (row: PromptHookTelemetry) => void;
  /** #1306: the file revision (`memoryRevision`) of a memory id, read from the
   *  daemon's vault index. Absent = the active-conventions block says
   *  `revision=unknown` and cannot notice a revision change. */
  revisionOf?: (id: string) => Promise<string | null>;
  conventionOf?: (id: string) => Promise<ConventionSource>;
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
  prewarm?: Prewarmer,
  reflexPool?: () => string[],
  opts: PromptLaneOptions = {}
): Promise<string> {
  let notice = "";
  if (
    opts.kernel &&
    payload.hook_event_name === "UserPromptSubmit" &&
    hookClientEvidence(payload) !== "replay" &&
    (!payload.prompt?.trim() || ownerPromptText(payload.prompt) !== null)
  ) {
    try {
      notice = await beginRulebookRound(payload, await catalogFor(payload, opts.kernel));
    } catch {
      // Even a catalog outage must expire the previous round's receipt.
      notice = await beginRulebookRound(payload, { entries: [], omitted: 0 }, { unavailable: true }).catch(() => "");
    }
  }
  const budgetNotice =
    notice.length <= 9000
      ? notice
      : notice.slice(0, 8800) + "\n[Rulebook notice overflow; remaining exception IDs are in the rulebook event log.]";
  const out = await runPromptLaneInner(payload, clientPpid, selfBaseUrl, prewarm, reflexPool, {
    ...opts,
    roundNotice: budgetNotice,
  });
  if (!budgetNotice) return out;
  const parsed = JSON.parse(out);
  parsed.hookSpecificOutput = {
    ...parsed.hookSpecificOutput,
    hookEventName: "UserPromptSubmit",
    additionalContext: [budgetNotice, parsed.hookSpecificOutput?.additionalContext].filter(Boolean).join("\n"),
  };
  return JSON.stringify(parsed);
}

/**
 * #1363 cap for everything this lane adds to the transcript; #1460: the draft
 * quote counts in it. Blocks are fitted in the order the lane builds them.
 */
class ContextBudget {
  remaining: number;
  constructor(readonly total: number) {
    this.remaining = total;
  }
  /** The block if it still fits (and books its length), otherwise null. */
  fit(block: string | null): string | null {
    if (!block || block.length + 1 > this.remaining) return null;
    this.remaining -= block.length + 1;
    return block;
  }
}

/** What every stage of one prompt turn needs to know about the call. */
interface PromptTurn {
  payload: ClaudeHookPayload;
  selfBaseUrl: string;
  opts: PromptLaneOptions;
  startedAt: number;
  /** `payload.session_id`, or "" — the session-state key. */
  sessionKey: string;
  budget: ContextBudget;
  client: ReturnType<typeof hookClient>;
  /** #507 Nachbesserung: nur für die Telemetrie-Dimension — `client` bleibt
   *  der surface-Default fürs Hint-Block-Attribut und den Recall-Loopback. */
  clientEvidence: ReturnType<typeof hookClientEvidence>;
  agent: ReturnType<typeof hookAgent>;
  /**
   * #702: a replayed prompt runs the whole lane — classification, recall,
   * reflex, dedup, backoff, scope filter — and leaves no trace outside its own
   * `replay-` session state and the replay telemetry file: no statusline feed,
   * no code-graph block, no usage sidecar, no budget ledger, no draft claims.
   * What the user sees in the report is what the hook would have injected.
   */
  replay: boolean;
  prewarmOutcome: PrewarmOutcome | undefined;
}

function openTurn(payload: ClaudeHookPayload, selfBaseUrl: string, opts: PromptLaneOptions): PromptTurn {
  const clientEvidence = hookClientEvidence(payload);
  return {
    payload,
    selfBaseUrl,
    opts,
    startedAt: Date.now(),
    sessionKey: payload.session_id ?? "",
    budget: new ContextBudget(10000 - (opts.roundNotice?.length ?? 0) - 1),
    client: hookClient(payload),
    clientEvidence,
    agent: hookAgent(payload),
    replay: clientEvidence === "replay",
    prewarmOutcome: undefined,
  };
}

/** The lane's stdout for the blocks that made it into the budget. */
function promptOutput(blocks: string[]): string {
  return blocks.length === 0
    ? "{}"
    : JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: blocks.join("\n"),
        },
      });
}

/** Explicitly reported active conventions, refreshed and rendered (#1306). */
function taskBlockFor(turn: PromptTurn, snapshot: ReadonlySessionState): Promise<string | null> {
  return runTaskStep({
    sessionId: turn.sessionKey,
    snapshot,
    revisionOf: turn.opts.revisionOf,
    conventionOf: turn.opts.conventionOf,
    surface: turn.client,
    maxChars: turn.budget.remaining,
    actorKey:
      (turn.payload as RulebookPayload).agent_id ?? (hookAgent(turn.payload) === "main" ? "main" : "unattributed"),
  });
}

async function runPromptLaneInner(
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
  opts: PromptLaneOptions = {}
): Promise<string> {
  const turn = openTurn(payload, selfBaseUrl, opts);
  if (payload.hook_event_name !== "UserPromptSubmit") return "{}";

  // #361: the turn has started — warm the embedding model NOW, so the first
  // assertion call of this turn (seconds from here, PreToolUse) finds it
  // resident instead of paying the cold dense arm and losing it to the 150ms
  // deadline (#342). Runs before the trivial gate on purpose: an "ok" or a
  // slash command starts a turn full of tool calls just as much as a question
  // does, and the debounce is what keeps the warm cheap, not the gate.
  // Synchronous by construction — the call inside is never awaited here.
  turn.prewarmOutcome = prewarm?.();

  // New user turn → reset statusline counters to idle. Needs the client's
  // process-tree position; without a resolvable ppid the reset is skipped
  // (statusline is cosmetic, the lane is not).
  const sessionPid = turn.replay ? null : resolveSessionPid(clientPpid);
  if (sessionPid !== null) resetStatuslineFeed(sessionPid, payload.session_id ?? null);

  // #1305: every prompt starts a new count for the gate lane's rule-kernel
  // re-delivery ("N tool calls without a prompt"). One state read when
  // nothing is counted; a replay leaves the real session alone.
  if (!turn.replay) await resetToolCalls(turn.sessionKey);

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
    await emitTelemetry(turn, gatedRow(turn, submitted.length, { gated_reason: "system-injected", origin: "system" }));
    return "{}";
  }

  // #151: gate before any recall work — the saved tokens surface in stats
  // via status:"gated" + gated:true.
  if (isTrivialPrompt(prompt)) return deliverTrivialTurn(turn, prompt);
  return runRecallTurn(turn, prompt, reflexPool);
}

/**
 * #572: a trivial prompt skips the RECALL, not the task-boundary block. "ok"
 * and "go on" after a finished task are exactly the turn it was parked for,
 * and handing it over costs one state read when nothing is parked.
 * #607: behind the prompt lane's opt-in, like every other delivery of this
 * lane. The gate is asked only once a block is actually parked, so a trivial
 * prompt still costs the one state read it always did.
 */
async function deliverTrivialTurn(turn: PromptTurn, prompt: string): Promise<string> {
  await emitTelemetry(turn, gatedRow(turn, prompt.length, {}));
  const trivialSnapshot = await loadSessionState(turn.sessionKey);
  const parkedForTrivial =
    trivialSnapshot.boundary && trivialSnapshot.boundary.note.length + 1 > turn.budget.remaining
      ? null
      : await takeParkedBoundary(turn.sessionKey, getPromptImpactEnabled);
  if (parkedForTrivial !== null) {
    logBoundaryDelivery(turn.payload.session_id ?? null, turn.payload.cwd ?? process.cwd(), parkedForTrivial);
  }
  // Explicit task state stays visible even when the prompt skips recall.
  // Prompt words never approve copy; rulebook_check reports that decision.
  const taskBlock = await taskBlockFor(turn, await loadSessionState(turn.sessionKey));
  const trivialBlocks = [parkedForTrivial?.note ?? null, taskBlock]
    .map((b) => turn.budget.fit(b))
    .filter((b): b is string => b !== null);
  if (trivialBlocks.length === 0) return "{}";
  if (taskBlock !== null && !turn.replay)
    recordBudgetShadow(turn.payload.session_id ?? null, "prompt_hook_call", Math.ceil(taskBlock.length / 4));
  return promptOutput(trivialBlocks);
}

/**
 * What the recall contributes to this turn after the backoff, and what was
 * dropped again for want of room. The hit lists and gate sets shrink in place
 * when their block does not fit — booking and telemetry read them afterwards.
 */
interface RecallEmit {
  recallHits: RecallHit[];
  reflexKept: PromptReflexHit[];
  gatedRecall: Set<string>;
  gatedReflex: Set<string>;
  recallBlock: string | null;
  reflexBlock: string | null;
  suppressed: boolean;
  suppressedTokensEst: number;
  backoffStreak: number;
  consumedForEmit: boolean;
}

/** The full turn: search, select, back off, fit, book, emit. */
async function runRecallTurn(turn: PromptTurn, prompt: string, reflexPool?: () => string[]): Promise<string> {
  const search = await runPromptSearch({
    payload: turn.payload,
    prompt,
    selfBaseUrl: turn.selfBaseUrl,
    clientEvidence: turn.clientEvidence,
    replay: turn.replay,
    startedAt: turn.startedAt,
    reflexPool,
  });
  const selection = await selectPromptHints(search);
  const emit = await decideRecallBlock(turn, search, selection);
  fitHintBlocks(turn, search, emit);
  const rawImpact = await search.impactPromise;
  const impact = { ...rawImpact, block: turn.budget.fit(rawImpact.block) };
  const takenBoundary = await bookPromptTurn(turn, search, emit, impact);
  if (takenBoundary !== null) {
    turn.budget.fit(takenBoundary.note);
    logBoundaryDelivery(turn.payload.session_id ?? null, search.cwd, takenBoundary);
  }

  // Refresh and render explicitly reported active conventions. Recall hits
  // are hints; they no longer decide task membership.
  const taskBlock = await taskBlockFor(turn, search.state);

  // The impact block goes FIRST: it is the answer to what the user just asked,
  // and it is there to be read before the first search, not after the memory
  // hints. It never rides the recall backoff — it is not recall noise, it is a
  // deterministic answer to an explicit question (same reasoning as the size
  // note in the write lane).
  // #572: the boundary block rides ahead of it for the same reason: it is about
  // what the agent just did, and it is worth reading before the next thing is
  // done on top of it.
  const blocks = [
    takenBoundary?.note ?? null,
    impact.block,
    emit.reflexBlock,
    emit.recallBlock,
    turn.budget.fit(taskBlock),
  ].filter((b): b is string => b !== null);
  const stdout = promptOutput(blocks);

  if (!turn.replay) await recordDelivery(turn, emit, blocks);
  await emitTelemetry(turn, recallTurnRow(turn, prompt, search, selection, emit, blocks, impact));

  if (turn.replay) return stdout;
  return appendLaneDrafts(
    stdout,
    "UserPromptSubmit",
    prompt,
    turn.payload.session_id,
    [...(search.resp?.hits ?? []), ...emit.reflexKept],
    1,
    false,
    undefined,
    turn.startedAt + laneBudgetMs(search.detectedMode),
    turn.budget.total
  );
}

/** What reached the transcript, booked outside the session state. A replay books nothing. */
async function recordDelivery(turn: PromptTurn, emit: RecallEmit, blocks: string[]): Promise<void> {
  // Usage sidecar (#154): only what was ACTUALLY injected counts as surfaced.
  const injectedIds = [
    ...(emit.reflexBlock ? emit.reflexKept.map((h) => h.id) : []),
    ...(emit.recallBlock ? emit.recallHits.map((h) => h.id) : []),
  ];
  if (injectedIds.length > 0) {
    await reportHinted(turn.selfBaseUrl, injectedIds, turn.payload.session_id ?? null);
  }
  // #458 (shadow): den fertigen Block ans Sitzungsbudget anrechnen und den
  // Governor-Entscheid loggen — nichts wird gekürzt.
  recordBudgetShadow(
    turn.payload.session_id ?? null,
    "prompt_hook_call",
    Math.ceil(((turn.opts.roundNotice?.length ?? 0) + blocks.join("\n").length) / 4)
  );
}

/**
 * #1307: a previous-convention cue forced a lookup, the recall answered, and
 * nothing that came back — reflex or recall — is a stored rule for it.
 */
function reportsMissingRule(search: PromptSearch, rawReflexHits: PromptReflexHit[]): boolean {
  const resp = search.resp;
  if (!search.forcedRetrieval || resp === null || !Array.isArray(resp.hits) || rawReflexHits.length > 0) return false;
  return ![...resp.hits, ...(Array.isArray(resp.reflex_hits) ? resp.reflex_hits : [])].some(
    (h) => h.matched_recall_when
  );
}

/** Must-load booking (#1303/#1304), the #161 backoff and the recall block. */
async function decideRecallBlock(
  turn: PromptTurn,
  search: PromptSearch,
  selection: PromptHintSelection
): Promise<RecallEmit> {
  const { resp, detectedMode } = search;
  const { recallHits, reflexKept } = selection;
  // #1303/#1304: only deny-capable registrations book must-load hints;
  // legacy Codex and shadow replays keep context-only guidance.
  const gateActive = hookGateAvailable(turn.payload) && !turn.replay;
  const emit: RecallEmit = {
    recallHits,
    reflexKept,
    gatedRecall: new Set(gateActive ? recallHits.filter(isGatedHint).map((h) => h.id) : []),
    // A reflex hit is user-wired by definition; only its type decides.
    gatedReflex: new Set(
      gateActive ? reflexKept.filter((h) => isGatedHint({ ...h, recall_mode: "reflex" })).map((h) => h.id) : []
    ),
    recallBlock: null,
    reflexBlock: null,
    suppressed: false,
    suppressedTokensEst: 0,
    backoffStreak: 0,
    consumedForEmit: false,
  };
  const noStoredRule = reportsMissingRule(search, selection.rawReflexHits);
  if (recallHits.length === 0 && !noStoredRule) return emit;
  // #161 empty-streak backoff (see session-state.ts): unconsumed injection
  // streaks widen the cadence; any load of an emitted candidate resets.
  // REQUIRED-band hits bypass suppression (decideBackoff hasRequired), and
  // retrieval mode is exempt entirely — the user explicitly asked for a
  // lookup, answering it is never noise. Streak bookkeeping stays regular
  // either way; only consumption resets the streak. Reflex-Hits laufen
  // an diesem Backoff komplett vorbei (#217): vom User verdrahtet = nie Noise.
  const entry = search.state.sources?.[BACKOFF_SOURCE];
  emit.consumedForEmit = await wasEmitConsumed(entry);
  // P0: Auf der unfused Skala ist `>= MUST_LOAD_SCORE` keine Aussage — rohe
  // BM25-Werte reißen die 100 fast immer. Ein Bypass daraus hieße: Der
  // Backoff hört genau dann auf zu greifen, wenn der Recall am wenigsten
  // weiß. Ohne Fusion gibt es deshalb kein REQUIRED und keinen Bypass.
  const hasRequired = resp?.unfused !== true && recallHits.some((h) => h.score >= MUST_LOAD_SCORE);
  const decision = decideBackoff(entry, emit.consumedForEmit, hasRequired);
  emit.backoffStreak = decision.streak;
  emit.suppressed = detectedMode === "retrieval" ? false : decision.suppress;
  const block = formatHintBlock(
    recallHits,
    search.project,
    detectedMode,
    resp?.weak_result === true,
    resp?.unfused === true,
    turn.client,
    resp?.degraded,
    resp?.recall_id,
    emit.gatedRecall,
    noStoredRule
  );
  // Suppressed drops only the recall block (#161); reflex still emits. The
  // `skipped` delta is booked inside mutateSessionState — mutating the
  // snapshot here would write into state #539 no longer saves.
  if (emit.suppressed) emit.suppressedTokensEst = Math.ceil(block.length / 4);
  else emit.recallBlock = block;
  return emit;
}

/** Reflex block first, then the recall block; what does not fit is not shown. */
function fitHintBlocks(turn: PromptTurn, search: PromptSearch, emit: RecallEmit): void {
  emit.reflexBlock = turn.budget.fit(
    emit.reflexKept.length > 0
      ? formatReflexBlock(emit.reflexKept, search.project, turn.client, emit.gatedReflex)
      : null
  );
  if (!emit.reflexBlock) {
    emit.reflexKept.length = 0;
    emit.gatedReflex.clear();
  }
  const unbudgetedRecallBlock = emit.recallBlock;
  emit.recallBlock = turn.budget.fit(emit.recallBlock);
  if (unbudgetedRecallBlock && !emit.recallBlock) {
    emit.recallHits = [];
    emit.gatedRecall.clear();
  }
}

/**
 * State-Bookkeeping in einem Save: Backoff-Streak nur für die
 * prompt-lookup-Lane, Reflex bucht nur die Session-Dedup.
 *
 * #539: the deltas run against the state as it is on disk when the lock is
 * taken, not against the snapshot read before the recall — the other four
 * lanes write the same file in the meantime.
 *
 * #572: the task-boundary block the last Stop parked for THIS session.
 * #607: behind the prompt lane's own opt-in (b3a6f80) — same lane, same
 * delivery nobody has measured yet, so the same switch and the same default
 * (off). Taken inside this save rather than through `takeParkedBoundary`: that
 * would open the session state a SECOND time on a path with a 200 ms ceiling
 * (#305), next to the snapshot and this mutation. The snapshot only decides
 * whether there is anything to take; the take, the dedupe check and the
 * marking still happen in one locked mutation, so a crash between them can
 * neither duplicate nor lose the block. A Stop that parks between the
 * snapshot and the lock keeps its block for the next prompt, which is where
 * it was headed anyway.
 */
async function bookPromptTurn(
  turn: PromptTurn,
  search: PromptSearch,
  emit: RecallEmit,
  impact: DeliveredPromptImpact
): Promise<TakenBoundary | null> {
  const state = search.state;
  const takeBoundaryNow =
    state.boundary !== undefined &&
    state.boundary.note.length + 1 <= turn.budget.remaining &&
    (await getPromptImpactEnabled());
  if (emit.recallHits.length === 0 && emit.reflexKept.length === 0 && impact.dedupeKey === null && !takeBoundaryNow) {
    return null;
  }
  let boundary: TakenBoundary | null = null;
  const gateBlockId = `prompt:${turn.startedAt.toString(36)}`;
  const recallIds = emit.recallHits.map((h) => h.id);
  const impactKey = impact.dedupeKey;
  const { recallBlock, recallHits, reflexKept } = emit;
  await mutateSessionState(turn.sessionKey, (s) => {
    if (takeBoundaryNow) boundary = takeBoundary(s);
    // #606: booked only when the block actually reached the transcript, so a
    // suppressed turn does not silence the next one.
    if (impactKey !== null) bumpShown(s, impactKey);
    if (recallBlock) {
      recordSourceEmit(s, BACKOFF_SOURCE, recallIds, emit.consumedForEmit);
    } else if (emit.suppressed) {
      // #539: without this the backoff window never fills, so the lane
      // suppresses forever instead of probing again after `streak` skips.
      recordSourceSuppressed(s, BACKOFF_SOURCE);
    }
    for (const h of reflexKept) bumpShown(s, h.id);
    // Every injected recall hit books the shown-state, in every mode (#541)
    // — without this the dedup has nothing to count and the block repeats on
    // every qualifying prompt. Only what actually reached the transcript is
    // booked: a suppressed emit leaves `recallBlock` null.
    if (recallBlock) {
      for (const h of recallHits) bumpShown(s, h.id);
    }
    // #1303: beside the shown-state, the must-load the gate will claim —
    // again only for what reached the transcript.
    bookPendingMustLoad(
      s,
      [...emit.gatedReflex, ...(recallBlock ? emit.gatedRecall : [])],
      gateBlockId,
      Date.now(),
      new Map([...recallHits, ...reflexKept].map((h) => [h.id, h.revision ?? null]))
    );
  });
  // The assignment happens inside the mutation callback, which TypeScript's
  // control flow does not follow — without the cast it narrows `boundary` to
  // the `null` it was declared with.
  return boundary as TakenBoundary | null;
}
